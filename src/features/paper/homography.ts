// Planar homography helpers: solve a projective mapping from four point pairs
// (Direct Linear Transform) and warp an image through it.
import type { Pt } from '../../model/types'

/** 3x3 matrix, row-major, 9 numbers. H[8] is always 1. */
export type Homography = number[]

/**
 * Solve the 8 unknowns of H (with h33 = 1) so that dst[i] ~ H * src[i].
 * Each correspondence gives two linear equations:
 *   h0*x + h1*y + h2 - u*(h6*x + h7*y) = u
 *   h3*x + h4*y + h5 - v*(h6*x + h7*y) = v
 */
export function computeHomography(src: Pt[], dst: Pt[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error('computeHomography needs 4 point pairs')
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  const h = solveLinear(A)
  return [...h, 1]
}

/**
 * Gaussian elimination with partial pivoting. `A` is an n x (n+1) augmented
 * matrix (last column = right-hand side). It is modified in place.
 */
export function solveLinear(A: number[][]): number[] {
  const n = A.length
  for (let col = 0; col < n; col++) {
    // Pick the row with the largest magnitude in this column for stability.
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    }
    if (Math.abs(A[piv][col]) < 1e-12) throw new Error('Singular system (degenerate corners)')
    if (piv !== col) {
      const tmp = A[col]
      A[col] = A[piv]
      A[piv] = tmp
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c]
    }
  }
  // Back substitution.
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n]
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c]
    x[r] = s / A[r][r]
  }
  return x
}

/** Apply a homography to a point. */
export function applyHomography(H: Homography, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8]
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  }
}

/**
 * Warp `src` into a new outW x outH image.
 *
 * `Hinv` maps OUTPUT pixel coordinates to SOURCE pixel coordinates (it is the
 * inverse of the source->output mapping, so each output pixel can pull its
 * colour from the photo, which avoids holes). Pixel centres are at i + 0.5.
 * Samples are bilinearly interpolated and clamped at the image border.
 */
export function warpPerspective(src: ImageData, Hinv: Homography, outW: number, outH: number): ImageData {
  const out = new ImageData(outW, outH)
  const sw = src.width
  const sh = src.height
  const s = src.data
  const d = out.data
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const X = x + 0.5
      const Y = y + 0.5
      const wz = Hinv[6] * X + Hinv[7] * Y + Hinv[8]
      // Back to index space where pixel i has its centre at i (so subtract 0.5).
      const sx = (Hinv[0] * X + Hinv[1] * Y + Hinv[2]) / wz - 0.5
      const sy = (Hinv[3] * X + Hinv[4] * Y + Hinv[5]) / wz - 0.5

      const x0f = Math.floor(sx)
      const y0f = Math.floor(sy)
      const fx = sx - x0f
      const fy = sy - y0f
      const x0 = Math.min(sw - 1, Math.max(0, x0f))
      const x1 = Math.min(sw - 1, Math.max(0, x0f + 1))
      const y0 = Math.min(sh - 1, Math.max(0, y0f))
      const y1 = Math.min(sh - 1, Math.max(0, y0f + 1))

      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const o = (y * outW + x) * 4
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy
      for (let c = 0; c < 4; c++) {
        d[o + c] = s[i00 + c] * w00 + s[i10 + c] * w10 + s[i01 + c] * w01 + s[i11 + c] * w11
      }
    }
  }
  return out
}
