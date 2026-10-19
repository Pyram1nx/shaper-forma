// Summed-area table (integral image) helpers for O(1) box sums and means.
// Uint32 is exact for 8-bit input up to ~16.8 million pixels (255 * n < 2^32).

/**
 * Build a (w+1) x (h+1) summed-area table. S[y*(w+1)+x] is the sum of all
 * src pixels with column < x and row < y. Pass `out` to reuse a buffer.
 */
export function integralImage(src: ArrayLike<number>, w: number, h: number, out?: Uint32Array): Uint32Array {
  const W1 = w + 1
  const need = W1 * (h + 1)
  const S = out && out.length >= need ? out : new Uint32Array(need)
  // Row 0 is all zero.
  for (let x = 0; x < W1; x++) S[x] = 0
  for (let y = 1; y <= h; y++) {
    let rowSum = 0
    const base = y * W1
    S[base] = 0
    for (let x = 1; x <= w; x++) {
      rowSum += src[(y - 1) * w + (x - 1)]
      S[base + x] = S[base - W1 + x] + rowSum
    }
  }
  return S
}

/** Sum of the clipped rectangle [x0, x1) x [y0, y1). */
export function rectSum(S: Uint32Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const W1 = w + 1
  return S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0]
}

/** Mean of the (2r+1)² window centred on (x, y), clipped to the image. */
export function boxMean(S: Uint32Array, w: number, h: number, x: number, y: number, r: number): number {
  const x0 = Math.max(0, x - r)
  const y0 = Math.max(0, y - r)
  const x1 = Math.min(w, x + r + 1)
  const y1 = Math.min(h, y + r + 1)
  return rectSum(S, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0))
}
