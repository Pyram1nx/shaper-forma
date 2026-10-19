// Which faces of the stock block need cutting, and how deep, for multi-sided carving.
//
// The model is analysed one axis pair at a time (top/bottom, front/back, left/right). Each face
// of the pair is rotated to face up and rasterised into a z-buffer height map: h(x, y) is the
// first model surface a straight bit would meet coming down from that face. The waste column
// above the first surface is that face's work; a column is CLAIMED by the face that reaches it
// more shallowly (ties go to the first face of the pair), so every column is carved from exactly
// one side and opposite faces never duplicate each other's work.
//
// A column that is open all the way through (outside the model's footprint on that face) ties
// with its mirror, so it lands on a stable face; deep cavities that only open towards one face
// are claimed by that face — this is what routes the inside of a glass to the top and its
// conical outside to the side faces.
import type { PlacedModel } from './loadModel'

export type SideId = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

/** Canonical processing order: the flip sequence a user would follow around the block. */
export const SIDE_ORDER: SideId[] = ['top', 'bottom', 'front', 'back', 'left', 'right']

export const SIDE_LABEL: Record<SideId, string> = {
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
}

/** Which grid axis mirrors between the two frames of an opposite pair (frames are xy-centred). */
const PAIRS: { a: SideId; b: SideId; mirror: 'x' | 'y' }[] = [
  { a: 'top', b: 'bottom', mirror: 'y' },
  { a: 'front', b: 'back', mirror: 'y' },
  { a: 'left', b: 'right', mirror: 'x' },
]

/** Row-major 3x3 rotations taking the model space to a frame where the side faces +Z. */
const SIDE_ROT: Record<SideId, number[]> = {
  top: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  bottom: [1, 0, 0, 0, -1, 0, 0, 0, -1],
  front: [1, 0, 0, 0, 0, 1, 0, -1, 0], // -Y up
  back: [1, 0, 0, 0, 0, -1, 0, 1, 0], // +Y up
  left: [0, 0, 1, 0, 1, 0, -1, 0, 0], // -X up
  right: [0, 0, -1, 0, 1, 0, 1, 0, 0], // +X up
}

/**
 * The model rotated so `side` faces up: mm, Z up, min Z = 0, XY centred — the same placement
 * convention as `placeModel`, so plan and preview code works on it unchanged.
 */
export function rotateToSide(placed: PlacedModel, side: SideId): PlacedModel {
  const m = SIDE_ROT[side]
  const src = placed.positions
  const p = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]
    const y = src[i + 1]
    const z = src[i + 2]
    p[i] = m[0] * x + m[1] * y + m[2] * z
    p[i + 1] = m[3] * x + m[4] * y + m[5] * z
    p[i + 2] = m[6] * x + m[7] * y + m[8] * z
  }
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minY) minY = p[i + 1]
    if (p[i + 1] > maxY) maxY = p[i + 1]
    if (p[i + 2] < minZ) minZ = p[i + 2]
    if (p[i + 2] > maxZ) maxZ = p[i + 2]
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= cx
    p[i + 1] -= cy
    p[i + 2] -= minZ
  }
  return {
    positions: p,
    bbox: { min: { x: minX - cx, y: minY - cy, z: 0 }, max: { x: maxX - cx, y: maxY - cy, z: maxZ - minZ } },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
  }
}

// ---- height maps ---------------------------------------------------------------------------

/** Z-buffer of the model surface over a regular grid in a rotated frame (world mm, Z up). */
export interface HeightMap {
  nx: number
  ny: number
  /** World position of sample (0, 0), mm. */
  x0: number
  y0: number
  dx: number
  dy: number
  /**
   * h[j * nx + i] = highest ('max') or lowest ('min') surface z in the cell, ±Infinity where no
   * triangle covers the cell (an open column on that face).
   */
  h: Float64Array
}

/**
 * Rasterise every triangle's XY footprint into the grid and keep the extreme surface z per cell.
 * Cell-centre sampling; a triangle thinner than the cell can be missed, which only skews the
 * statistics by a cell, never the plan itself (the plan slices the real mesh).
 */
export function heightMap(placed: PlacedModel, cell: number, mode: 'max' | 'min'): HeightMap {
  const b = placed.bbox
  const nx = Math.max(2, Math.ceil((b.max.x - b.min.x) / cell - 1e-9) + 1)
  const ny = Math.max(2, Math.ceil((b.max.y - b.min.y) / cell - 1e-9) + 1)
  const w = Math.max(b.max.x - b.min.x, 1e-6)
  const d = Math.max(b.max.y - b.min.y, 1e-6)
  const map: HeightMap = { nx, ny, x0: b.min.x, y0: b.min.y, dx: w / (nx - 1), dy: d / (ny - 1), h: new Float64Array(nx * ny) }
  map.h.fill(-Infinity)

  const p = placed.positions
  const sign = mode === 'max' ? 1 : -1 // work in flipped z so both modes are a running max
  for (let t = 0; t < p.length; t += 9) {
    // Vertices in grid coordinates, z flipped for the running max.
    const gx = [(p[t] - map.x0) / map.dx, (p[t + 3] - map.x0) / map.dx, (p[t + 6] - map.x0) / map.dx]
    const gy = [(p[t + 1] - map.y0) / map.dy, (p[t + 4] - map.y0) / map.dy, (p[t + 7] - map.y0) / map.dy]
    const gz = [sign * p[t + 2], sign * p[t + 5], sign * p[t + 8]]
    const area = (gx[1] - gx[0]) * (gy[2] - gy[0]) - (gx[2] - gx[0]) * (gy[1] - gy[0])
    if (Math.abs(area) < 1e-12) continue
    const i0 = Math.max(0, Math.floor(Math.min(gx[0], gx[1], gx[2])))
    const i1 = Math.min(nx - 1, Math.ceil(Math.max(gx[0], gx[1], gx[2])))
    const j0 = Math.max(0, Math.floor(Math.min(gy[0], gy[1], gy[2])))
    const j1 = Math.min(ny - 1, Math.ceil(Math.max(gy[0], gy[1], gy[2])))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        // Barycentric weights at the grid sample itself, so the footprint boundary columns are
        // covered too (a centre-offset sample would fall outside the last triangle row).
        const px = i
        const py = j
        const w0 = ((gx[1] - px) * (gy[2] - py) - (gx[2] - px) * (gy[1] - py)) / area
        const w1 = ((gx[2] - px) * (gy[0] - py) - (gx[0] - px) * (gy[2] - py)) / area
        const w2 = 1 - w0 - w1
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue
        const z = w0 * gz[0] + w1 * gz[1] + w2 * gz[2]
        const k = j * nx + i
        if (z > map.h[k]) map.h[k] = z
      }
  }
  if (mode === 'min')
    // Covered cells hold the flipped max of −z, so flip back; a cell with no surface at all is
    // an open column: from below there is nothing to cut, so it reads as h = 0 and the depth
    // comparison hands the column to the opposite face.
    for (let k = 0; k < map.h.length; k++) map.h[k] = map.h[k] === -Infinity ? 0 : -map.h[k]
  return map
}

// ---- per-side analysis ---------------------------------------------------------------------

/** A column shallower than this leaves nothing for a router (mm). */
export const CUT_MIN_DEPTH = 0.2
/** A face claimed over less area than this is not worth a flip (mm²). */
export const CUT_MIN_AREA = 2
/**
 * Claim tolerance: a column goes to the shallower face unless the other is deeper by more than
 * this. Keeps mirrored/float-noise columns from duplicating work on both faces of a pair; the
 * couple hundredths of overlap are harmless.
 */
const CLAIM_EPS = 0.05

export interface SideAnalysis {
  side: SideId
  /** True when this face has claimed work worth a setup. */
  needed: boolean
  /** Depth of the deepest claimed column, measured from the model's own face (mm). */
  cutDepth: number
  /** Total claimed area with depth over CUT_MIN_DEPTH (mm²). */
  area: number
}

/**
 * Analyse all six faces of the placed model. Only the model's own extent is considered: the
 * stock face of the top/bottom pair sits on the model face, and the four side pairs keep the
 * block margin above them (the caller adds that margin where it matters).
 */
export function analyzeSides(placed: PlacedModel, cell = 1): Record<SideId, SideAnalysis> {
  const out = {} as Record<SideId, SideAnalysis>
  for (const s of SIDE_ORDER) out[s] = { side: s, needed: false, cutDepth: 0, area: 0 }

  for (const { a, b, mirror } of PAIRS) {
    const A = rotateToSide(placed, a)
    const B = rotateToSide(placed, b)
    const hA = heightMap(A, cell, 'max')
    const hB = heightMap(B, cell, 'max')
    // An open column (no surface on this face) reads as the full model depth: the waste above
    // it runs down to the opposite face of the model.
    const depthAt = (m: HeightMap, size: number, i: number, j: number) => {
      const h = m.h[j * m.nx + i]
      return h === -Infinity ? size : size - h
    }
    for (let j = 0; j < hA.ny; j++)
      for (let i = 0; i < hA.nx; i++) {
        const ii = mirror === 'x' ? hB.nx - 1 - i : i
        const jj = mirror === 'y' ? hB.ny - 1 - j : j
        const dA = depthAt(hA, A.size.z, i, j)
        const dB =
          ii >= 0 && ii < hB.nx && jj >= 0 && jj < hB.ny ? depthAt(hB, B.size.z, ii, jj) : Infinity
        // Ties (a column open from both faces, or symmetric surfaces) go to `a` — stable, and
        // the pair's work is split without overlap either way.
        const first = dA <= dB + CLAIM_EPS
        const d = first ? dA : dB
        const s: SideId = first ? a : b
        if (d > CUT_MIN_DEPTH) {
          const rec = out[s]
          rec.area += cell * cell
          if (d > rec.cutDepth) rec.cutDepth = d
        }
      }
  }
  for (const s of SIDE_ORDER) out[s].needed = out[s].area >= CUT_MIN_AREA
  return out
}
