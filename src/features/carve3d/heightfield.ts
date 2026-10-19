// Height map of the stock's top surface, shared by the finished-piece preview and the cutting
// animation. Samples sit on a regular grid in world space (mm, x right, y up, Z up); h holds
// the surface height at each sample. Cutting lowers h to the bit's profile, so ball, V and
// tapered bits leave their own shape in the wood.
//
// Rendering: one BufferGeometry with the top surface, a bottom face and a skirt around the
// stock edge. Material that is cut all the way through sits at `bottom`; the solid's materials
// clip everything just above `bottom` away (see floorClip), so through-cuts open up without
// rebuilding the index buffer.
import * as THREE from 'three'
import type { Contour } from '../../model/types'
import { radiusAtHeight, type Bit } from './bits'

export interface Heightfield {
  /** Samples along x and y. */
  nx: number
  ny: number
  /** World position of sample (0, 0), mm. */
  x0: number
  y0: number
  /** Sample spacing, mm. */
  dx: number
  dy: number
  /** Uncut stock top and bottom, world z (mm). */
  top: number
  bottom: number
  /** Surface height per sample, row-major: h[j * nx + i] at (x0 + i·dx, y0 + j·dy). */
  h: Float32Array
}

/** World-space rectangle (y up). */
export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Design-space contours (y down) bounding box, in world space (y up). */
export function worldRect(contours: Contour[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours)
    for (const p of c.pts) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (-p.y < minY) minY = -p.y
      if (-p.y > maxY) maxY = -p.y
    }
  return { minX, minY, maxX, maxY }
}

/** Uncut block over `rect`, at most ~`maxSamples` samples, never finer than `minCell` mm. */
export function createHeightfield(rect: Rect, top: number, bottom: number, maxSamples = 250_000, minCell = 0.2): Heightfield {
  const w = Math.max(rect.maxX - rect.minX, 1e-3)
  const d = Math.max(rect.maxY - rect.minY, 1e-3)
  const cell = Math.max(minCell, Math.sqrt((w * d) / maxSamples))
  const nx = Math.max(2, Math.ceil(w / cell) + 1)
  const ny = Math.max(2, Math.ceil(d / cell) + 1)
  return { nx, ny, x0: rect.minX, y0: rect.minY, dx: w / (nx - 1), dy: d / (ny - 1), top, bottom, h: new Float32Array(nx * ny).fill(top) }
}

/** Copy of a height map (same grid, own heights). */
export function cloneHeightfield(hf: Heightfield): Heightfield {
  return { ...hf, h: hf.h.slice() }
}

// ---- bit profile ---------------------------------------------------------------------------

export interface BitProfile {
  /** Widest cutting radius, mm. */
  radius: number
  /** Height above the tip where the cutter is r wide (0 for a flat bit); Infinity beyond `radius`. */
  heightAt: (r: number) => number
}

const PROFILE_STEPS = 256

/**
 * Inverse of the bit's radius-vs-height curve, tabulated. radiusAtHeight is non-decreasing for
 * every carvable profile, so a bisection per table entry is enough.
 */
export function bitProfile(bit: Bit): BitProfile {
  const R = bit.diameter / 2
  // Height at which the cutter reaches full diameter (search well past the flutes).
  let hMax = 0
  const limit = Math.max(bit.fluteLength, R * 20, 1)
  if (radiusAtHeight(bit, 0) < R - 1e-9) {
    let lo = 0
    let hi = limit
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      if (radiusAtHeight(bit, mid) >= R - 1e-9) hi = mid
      else lo = mid
    }
    hMax = hi
  }
  const table = new Float32Array(PROFILE_STEPS + 1)
  for (let k = 0; k <= PROFILE_STEPS; k++) {
    const r = (R * k) / PROFILE_STEPS
    if (radiusAtHeight(bit, 0) >= r) {
      table[k] = 0
      continue
    }
    let lo = 0
    let hi = hMax
    for (let n = 0; n < 40; n++) {
      const mid = (lo + hi) / 2
      if (radiusAtHeight(bit, mid) >= r) hi = mid
      else lo = mid
    }
    table[k] = hi
  }
  const heightAt = (r: number) => {
    if (r > R + 1e-9) return Infinity
    const f = (Math.max(0, r) / R) * PROFILE_STEPS
    const k = Math.min(PROFILE_STEPS - 1, Math.floor(f))
    const t = f - k
    return table[k] + (table[k + 1] - table[k]) * t
  }
  return { radius: R, heightAt }
}

/**
 * Plunge the bit with its tip at world (cx, cy, tipZ): every sample under the cutter drops to the
 * cutter surface (never below `bottom`). Returns the removed volume in mm³ (drives the sawdust).
 */
export function stampBit(hf: Heightfield, prof: BitProfile, cx: number, cy: number, tipZ: number): number {
  const R = prof.radius
  const i0 = Math.max(0, Math.ceil((cx - R - hf.x0) / hf.dx))
  const i1 = Math.min(hf.nx - 1, Math.floor((cx + R - hf.x0) / hf.dx))
  const j0 = Math.max(0, Math.ceil((cy - R - hf.y0) / hf.dy))
  const j1 = Math.min(hf.ny - 1, Math.floor((cy + R - hf.y0) / hf.dy))
  if (tipZ >= hf.top) return 0
  let removed = 0
  const cellA = hf.dx * hf.dy
  for (let j = j0; j <= j1; j++) {
    const y = hf.y0 + j * hf.dy - cy
    const row = j * hf.nx
    for (let i = i0; i <= i1; i++) {
      const x = hf.x0 + i * hf.dx - cx
      const r = Math.sqrt(x * x + y * y)
      if (r > R) continue
      const z = Math.max(hf.bottom, tipZ + prof.heightAt(r))
      const k = row + i
      if (z < hf.h[k]) {
        removed += (hf.h[k] - z) * cellA
        hf.h[k] = z
      }
    }
  }
  return removed
}

// ---- rasterising ---------------------------------------------------------------------------

/**
 * Even-odd fill of design-space contours (y down) at the grid samples: mask[k] = 1 inside.
 * Scanline per sample row, so it is O(rows × edges + samples).
 */
export function rasterize(hf: Pick<Heightfield, 'nx' | 'ny' | 'x0' | 'y0' | 'dx' | 'dy'>, contours: Contour[]): Uint8Array {
  const mask = new Uint8Array(hf.nx * hf.ny)
  const xs: number[] = []
  for (let j = 0; j < hf.ny; j++) {
    const yd = -(hf.y0 + j * hf.dy) // design-space y of this row
    xs.length = 0
    for (const c of contours) {
      if (!c.closed) continue
      const pts = c.pts
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const p = pts[a]
        const q = pts[b]
        if (p.y > yd !== q.y > yd) xs.push(p.x + ((yd - p.y) * (q.x - p.x)) / (q.y - p.y))
      }
    }
    if (xs.length < 2) continue
    xs.sort((u, v) => u - v)
    const row = j * hf.nx
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - hf.x0) / hf.dx))
      const i1 = Math.min(hf.nx - 1, Math.floor((xs[k + 1] - hf.x0) / hf.dx))
      for (let i = i0; i <= i1; i++) mask[row + i] = 1
    }
  }
  return mask
}

// ---- mesh ----------------------------------------------------------------------------------

/** Perimeter sample indices, counter-clockwise seen from above (bottom, right, top, left edge). */
function perimeter(hf: Heightfield): number[] {
  const { nx, ny } = hf
  const out: number[] = []
  for (let i = 0; i < nx - 1; i++) out.push(i)
  for (let j = 0; j < ny - 1; j++) out.push(j * nx + nx - 1)
  for (let i = nx - 1; i > 0; i--) out.push((ny - 1) * nx + i)
  for (let j = ny - 1; j > 0; j--) out.push(j * nx)
  return out
}

/**
 * Geometry for a height map. Vertex layout: [top grid][bottom grid][skirt top][skirt bottom].
 * Groups: 0 = top surface + skirt (cut faces), 1 = bottom face. UVs are in mm, like
 * ExtrudeGeometry's, so the same wood texture (repeat 1/120) fits. Call syncHeightfieldGeometry
 * after changing heights.
 */
export function createHeightfieldGeometry(hf: Heightfield): THREE.BufferGeometry {
  const { nx, ny } = hf
  const N = nx * ny
  const per = perimeter(hf)
  const P = per.length
  const V = 2 * N + 2 * P
  const pos = new Float32Array(V * 3)
  const nor = new Float32Array(V * 3)
  const uv = new Float32Array(V * 2)

  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const x = hf.x0 + i * hf.dx
      const y = hf.y0 + j * hf.dy
      pos.set([x, y, hf.h[k]], k * 3)
      pos.set([x, y, hf.bottom], (N + k) * 3)
      nor.set([0, 0, 1], k * 3)
      nor.set([0, 0, -1], (N + k) * 3)
      uv.set([x, y], k * 2)
      uv.set([x, y], (N + k) * 2)
    }
  // Skirt: own vertices so its normals stay horizontal. u runs along the perimeter.
  let along = 0
  for (let s = 0; s < P; s++) {
    const k = per[s]
    const next = per[(s + 1) % P]
    const x = pos[k * 3]
    const y = pos[k * 3 + 1]
    const ex = pos[next * 3] - x
    const ey = pos[next * 3 + 1] - y
    const len = Math.hypot(ex, ey) || 1
    // Outward normal: right of the CCW travel direction.
    const n = [ey / len, -ex / len, 0]
    const t = 2 * N + s
    const b = 2 * N + P + s
    pos.set([x, y, hf.h[k]], t * 3)
    pos.set([x, y, hf.bottom], b * 3)
    nor.set(n, t * 3)
    nor.set(n, b * 3)
    uv.set([along, hf.h[k]], t * 2)
    uv.set([along, hf.bottom], b * 2)
    along += len
  }

  const idx: number[] = []
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx + 1
      const d = a + nx
      idx.push(a, b, c, a, c, d)
    }
  for (let s = 0; s < P; s++) {
    const p = 2 * N + s
    const q = 2 * N + ((s + 1) % P)
    const pb = p + P
    const qb = q + P
    idx.push(pb, qb, q, pb, q, p)
  }
  const topCount = idx.length
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = N + j * nx + i
      const b = a + 1
      const c = a + nx + 1
      const d = a + nx
      idx.push(a, c, b, a, d, c)
    }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(V > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  geo.addGroup(0, topCount, 0)
  geo.addGroup(topCount, idx.length - topCount, 1)
  geo.userData.perimeter = per
  syncHeightfieldGeometry(geo, hf)
  return geo
}

/**
 * Push the heights into the geometry: top z, skirt top z and top normals (central differences,
 * cheap enough to run every animation frame). `rows` limits the work to rows [j0, j1].
 */
export function syncHeightfieldGeometry(geo: THREE.BufferGeometry, hf: Heightfield, rows?: [number, number]) {
  const { nx, ny, h } = hf
  const N = nx * ny
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
  const norAttr = geo.getAttribute('normal') as THREE.BufferAttribute
  const pos = posAttr.array as Float32Array
  const nor = norAttr.array as Float32Array
  const j0 = Math.max(0, rows ? rows[0] : 0)
  const j1 = Math.min(ny - 1, rows ? rows[1] : ny - 1)
  for (let j = j0; j <= j1; j++) {
    const jm = Math.max(0, j - 1)
    const jp = Math.min(ny - 1, j + 1)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      pos[k * 3 + 2] = h[k]
      const im = Math.max(0, i - 1)
      const ip = Math.min(nx - 1, i + 1)
      const gx = (h[j * nx + ip] - h[j * nx + im]) / ((ip - im) * hf.dx)
      const gy = (h[jp * nx + i] - h[jm * nx + i]) / ((jp - jm) * hf.dy)
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1)
      nor[k * 3] = -gx * inv
      nor[k * 3 + 1] = -gy * inv
      nor[k * 3 + 2] = inv
    }
  }
  const per = geo.userData.perimeter as number[]
  for (let s = 0; s < per.length; s++) pos[(2 * N + s) * 3 + 2] = h[per[s]]
  posAttr.needsUpdate = true
  norAttr.needsUpdate = true
  geo.computeBoundingSphere()
}

/**
 * Clipping plane that hides surface cut down to the floor (through-cuts). Put it in the
 * clippingPlanes of the top/skirt material and enable renderer.localClippingEnabled.
 */
export function floorClip(hf: Heightfield): THREE.Plane {
  return new THREE.Plane(new THREE.Vector3(0, 0, 1), -(hf.bottom + 0.01))
}

/**
 * Iso-line of the surface at height z (marching squares), as line-segment pairs for
 * THREE.LineSegments: [x0, y0, z, x1, y1, z, ...] in world space.
 */
export function isoSegments(hf: Heightfield, z: number): Float32Array {
  const { nx, ny, h } = hf
  const out: number[] = []
  const lerp = (a: number, b: number) => (z - a) / (b - a)
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i
      const a = h[k] // (i, j)
      const b = h[k + 1] // (i+1, j)
      const c = h[k + nx + 1] // (i+1, j+1)
      const d = h[k + nx] // (i, j+1)
      const code = (a > z ? 1 : 0) | (b > z ? 2 : 0) | (c > z ? 4 : 0) | (d > z ? 8 : 0)
      if (code === 0 || code === 15) continue
      const x = hf.x0 + i * hf.dx
      const y = hf.y0 + j * hf.dy
      // Crossing points on the four cell edges.
      const e = [
        [x + lerp(a, b) * hf.dx, y], // bottom a-b
        [x + hf.dx, y + lerp(b, c) * hf.dy], // right b-c
        [x + lerp(d, c) * hf.dx, y + hf.dy], // top d-c
        [x, y + lerp(a, d) * hf.dy], // left a-d
      ]
      const seg = (p: number, q: number) => out.push(e[p][0], e[p][1], z, e[q][0], e[q][1], z)
      switch (code) {
        case 1: case 14: seg(3, 0); break
        case 2: case 13: seg(0, 1); break
        case 3: case 12: seg(3, 1); break
        case 4: case 11: seg(1, 2); break
        case 6: case 9: seg(0, 2); break
        case 7: case 8: seg(3, 2); break
        case 5: seg(3, 0); seg(1, 2); break
        case 10: seg(0, 1); seg(2, 3); break
      }
    }
  return new Float32Array(out)
}
