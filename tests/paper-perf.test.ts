import { describe, expect, it } from 'vitest'
import { vectorise } from '../src/features/paper/trace'

// Deterministic PRNG so the stroke layout is the same on every run.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function strokeMask(w: number, h: number, count: number, seed: number, thick: number): Uint8Array {
  const m = new Uint8Array(w * h)
  const rand = rng(seed)
  const r = thick / 2
  for (let k = 0; k < count; k++) {
    const x0 = rand() * w, y0 = rand() * h
    const len = 40 + rand() * 160
    const a = rand() * Math.PI * 2
    const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r)), maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r))
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r))
    const dx = x1 - x0, dy = y1 - y0
    const L2 = dx * dx + dy * dy || 1
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2))
        const ex = x0 + t * dx - x, ey = y0 + t * dy - y
        if (ex * ex + ey * ey <= r * r) m[y * w + x] = 1
      }
    }
  }
  return m
}

describe('paper performance', () => {
  it('400 random strokes on a 1500 x 1500 mask vectorise in under 2 s', async () => {
    const W = 1500, H = 1500
    const m = strokeMask(W, H, 400, 7, 4)
    const t0 = performance.now()
    const r = await vectorise(m, W, H, 10, 'centerline')
    const ms = performance.now() - t0
    expect(r.groups.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(2000)
  }, 20000)
})
