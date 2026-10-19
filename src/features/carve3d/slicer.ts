// Horizontal cross-sections of a triangle soup.
//
// Pipeline per plane: triangle/plane intersections -> directed segments (oriented by the
// triangle normal so material is always on the same side) -> endpoints welded within
// WELD mm -> chains -> loops oriented by majority evidence -> NonZero union (so overlapping
// shells add up instead of cancelling) -> RDP simplification.
import ClipperLib from 'clipper-lib'
import type { Contour, Pt } from '../../model/types'
import { simplify } from '../../geometry/offset'

const SCALE = 1000
/** Endpoints closer than this are the same vertex (mm). */
export const WELD = 0.05
/** RDP tolerance for the output contours (mm). */
const SIMPLIFY_TOL = 0.005

export interface SliceResult {
  contours: Contour[]
  /** Chains that never closed. Non-zero means the mesh is not watertight at this height. */
  openChains: number
}

/** Let the event loop run (keeps the UI responsive between slow steps). */
export const yieldFrame = () => new Promise<void>((r) => setTimeout(r))

type IntPath = { X: number; Y: number }[]

/** NonZero union of closed loops. Loops carry their own orientation, so overlapping shells add. */
export function nonZeroUnion(loops: Contour[]): Contour[] {
  const paths: IntPath[] = loops
    .filter((c) => c.closed && c.pts.length >= 3)
    .map((c) => c.pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })))
  if (!paths.length) return []
  const clip = new ClipperLib.Clipper()
  clip.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const out: IntPath[] = []
  clip.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return out
    .filter((p) => p.length >= 3)
    .map((p) => ({ closed: true, pts: p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })) }))
}

/**
 * Cross-section of a flat xyz triangle array (mm, Z up) at height z.
 * Returns closed regions with holes, XY in design space (y down, so Y is negated).
 * `tris` limits the work to the given triangle indices (see createMeshSlicer).
 */
export function sliceAt(positions: Float32Array, z: number): Contour[] {
  return sliceDetailed(positions, z).contours
}

export function sliceDetailed(positions: Float32Array, z: number, tris?: Uint32Array): SliceResult {
  // A vertex lying exactly on the plane makes the edge test ambiguous; nudge the plane.
  let zq = z
  for (let i = 2; i < positions.length; i += 3) {
    if (Math.abs(positions[i] - z) < 1e-9) {
      zq = z + 1e-6
      break
    }
  }

  // 1. Welded vertices, bucketed on a WELD grid.
  const vx: number[] = []
  const vy: number[] = []
  const cells = new Map<string, number[]>()
  const vertex = (x: number, y: number): number => {
    const cx = Math.floor(x / WELD)
    const cy = Math.floor(y / WELD)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get(`${cx + dx},${cy + dy}`)
        if (!list) continue
        for (const id of list) {
          if (Math.hypot(vx[id] - x, vy[id] - y) <= WELD) return id
        }
      }
    const id = vx.length
    vx.push(x)
    vy.push(y)
    const k = `${cx},${cy}`
    const list = cells.get(k)
    if (list) list.push(id)
    else cells.set(k, [id])
    return id
  }

  // 2. Triangle / plane intersections -> directed segments.
  const segA: number[] = []
  const segB: number[] = []
  const segEx: number[] = []
  const segEy: number[] = []
  const queryCount = tris ? tris.length : positions.length / 9
  for (let q = 0; q < queryCount; q++) {
    const o = (tris ? tris[q] : q) * 9
    let hits = 0
    let hx0 = 0
    let hy0 = 0
    let hx1 = 0
    let hy1 = 0
    for (let e = 0; e < 3; e++) {
      const i = o + 3 * e
      const j = o + 3 * ((e + 1) % 3)
      const zi = positions[i + 2] - zq
      const zj = positions[j + 2] - zq
      if ((zi < 0) === (zj < 0)) continue
      const f = zi / (zi - zj)
      const x = positions[i] + f * (positions[j] - positions[i])
      const y = positions[i + 1] + f * (positions[j + 1] - positions[i + 1])
      if (hits === 0) {
        hx0 = x
        hy0 = y
      } else {
        hx1 = x
        hy1 = y
      }
      hits++
    }
    if (hits !== 2) continue
    const a = vertex(hx0, hy0)
    const b = vertex(hx1, hy1)
    if (a === b) continue // degenerate after welding
    // Triangle normal (xy part). The segment direction is parallel to ẑ × n, which points
    // along the outer boundary when the normal is outward, so every segment carries the
    // same "material on the left" convention.
    const ax = positions[o + 3] - positions[o]
    const ay = positions[o + 4] - positions[o + 1]
    const az = positions[o + 5] - positions[o + 2]
    const bx = positions[o + 6] - positions[o]
    const by = positions[o + 7] - positions[o + 1]
    const bz = positions[o + 8] - positions[o + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const len = Math.hypot(-ny, nx) || 1
    segA.push(a)
    segB.push(b)
    segEx.push(-ny / len)
    segEy.push(nx / len)
  }
  const m = segA.length
  if (!m) return { contours: [], openChains: 0 }

  // 3. Undirected chaining over welded vertices.
  const adj: number[][] = Array.from({ length: vx.length }, () => [])
  for (let s = 0; s < m; s++) {
    adj[segA[s]].push(s)
    adj[segB[s]].push(s)
  }
  const used = new Uint8Array(m)
  const loops: Contour[] = []
  let openChains = 0
  for (let s0 = 0; s0 < m; s0++) {
    if (used[s0]) continue
    used[s0] = 1
    const start = segA[s0]
    let cur = segB[s0]
    const verts: number[] = [start, cur]
    const segs: number[] = [s0]
    const fwd: boolean[] = [true]
    let closed = false
    for (;;) {
      if (cur === start) {
        closed = true
        break
      }
      let next = -1
      for (const j of adj[cur]) {
        if (!used[j]) {
          next = j
          break
        }
      }
      if (next < 0) break
      used[next] = 1
      const forward = segA[next] === cur
      cur = forward ? segB[next] : segA[next]
      verts.push(cur)
      segs.push(next)
      fwd.push(forward)
    }
    if (!closed || segs.length < 3) {
      openChains++
      continue
    }
    verts.pop() // last vertex repeats the start
    // Orientation: majority of the segments' normal evidence decides the loop direction.
    let evidence = 0
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]
      const sign = fwd[k] ? 1 : -1
      const dx = (vx[segB[s]] - vx[segA[s]]) * sign
      const dy = (vy[segB[s]] - vy[segA[s]]) * sign
      evidence += dx * segEx[s] + dy * segEy[s]
    }
    if (evidence < 0) verts.reverse()
    loops.push({ closed: true, pts: verts.map((v) => ({ x: vx[v], y: vy[v] })) })
  }

  // 4. NonZero union gives clean regions with holes; flip to design space (y down).
  const regions = nonZeroUnion(loops)
    .map((c) => ({ closed: true, pts: simplify(c.pts, SIMPLIFY_TOL, true).map((p: Pt) => ({ x: p.x, y: -p.y })) }))
    .filter((c) => c.pts.length >= 3)
  return { contours: regions, openChains }
}

// ---- repeated slicing of one mesh ----------------------------------------------------------

/**
 * Repeated plane queries over one mesh: triangles are bucketed by their z-extent once, so each
 * slice only visits triangles that actually straddle the plane instead of the whole mesh.
 * Multi-sided planning slices the same rotated mesh at every stage depth, so this is what keeps
 * the job light. A single plane query can be a few orders of magnitude cheaper than
 * sliceDetailed over all triangles on large models.
 */
export interface MeshSlicer {
  slice(z: number): SliceResult
}

export function createMeshSlicer(positions: Float32Array): MeshSlicer {
  const triCount = positions.length / 9
  const zmin = new Float32Array(triCount)
  const zmax = new Float32Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const a = positions[o + 2]
    const b = positions[o + 5]
    const c = positions[o + 8]
    zmin[t] = Math.min(a, b, c)
    zmax[t] = Math.max(a, b, c)
  }
  // Triangle indices sorted by their low z: a binary search finds every triangle that could
  // touch the plane; the zmax test drops the rest.
  const order = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i++) order[i] = i
  order.sort((x, y) => zmin[x] - zmin[y])
  const scratch = new Uint32Array(triCount)
  return {
    slice(z: number): SliceResult {
      let lo = 0
      let hi = triCount
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (zmin[order[mid]] <= z) lo = mid + 1
        else hi = mid
      }
      let n = 0
      for (let i = 0; i < lo; i++) {
        const t = order[i]
        if (zmax[t] >= z) scratch[n++] = t
      }
      return sliceDetailed(positions, z, n === triCount ? undefined : scratch.subarray(0, n))
    },
  }
}
