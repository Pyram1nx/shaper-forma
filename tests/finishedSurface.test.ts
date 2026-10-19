import { describe, expect, it } from 'vitest'
import { buildCarvePlan } from '../src/features/carve3d/carvePlan'
import { carvedSurface, distanceSquared } from '../src/features/carve3d/finishedSurface'
import { bitProfile, createHeightfield, stampBit, type Heightfield } from '../src/features/carve3d/heightfield'
import type { Bit } from '../src/features/carve3d/bits'

/** Axis-aligned box as 12 outward triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const out: number[] = []
  for (const [a, b, c, d] of quads) for (const tri of [[a, b, c], [a, c, d]]) for (const i of tri) out.push(...p[i])
  return new Float32Array(out)
}

const flat = { id: 't-flat', name: 'flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Bit
const ball = { id: 't-ball', name: 'ball', type: 'ball', diameter: 6.35, fluteLength: 30 } as Bit
const vbit = { id: 't-v', name: 'v', type: 'vbit', diameter: 6.35, fluteLength: 30, angle: 60, tipDiameter: 0 } as Bit

/** Surface height at world (x, y), nearest sample. */
const at = (hf: Heightfield, x: number, y: number) => hf.h[Math.round((y - hf.y0) / hf.dy) * hf.nx + Math.round((x - hf.x0) / hf.dx)]

async function carve(bit: Bit, throughCut = false) {
  const plan = await buildCarvePlan(box(-10, -10, 0, 10, 10, 10), 10, {
    bit, stepDown: 5, stockThickness: 10, margin: 8, throughCut,
    outputs: { contour: false, toolpath: true, pocket: false }, units: 'mm',
  })
  return carvedSurface(plan, bit, undefined, 120_000)
}

describe('distance transform', () => {
  it('matches brute force on a random mask with anisotropic spacing', () => {
    const nx = 23, ny = 17, dx = 0.7, dy = 0.45
    const src = new Uint8Array(nx * ny)
    let seed = 7
    for (let k = 0; k < src.length; k++) src[k] = (seed = (seed * 16807) % 2147483647) % 13 === 0 ? 1 : 0
    const D = distanceSquared(src, nx, ny, dx, dy)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let best = Infinity
        for (let b = 0; b < ny; b++) for (let a = 0; a < nx; a++) if (src[b * nx + a]) best = Math.min(best, ((a - i) * dx) ** 2 + ((b - j) * dy) ** 2)
        expect(D[j * nx + i]).toBeCloseTo(best, 6)
      }
  })
})

describe('bit profile', () => {
  it('ball nose: height at r is R − √(R² − r²)', () => {
    const p = bitProfile(ball)
    const R = 3.175
    expect(p.heightAt(0)).toBeCloseTo(0, 3)
    expect(p.heightAt(2)).toBeCloseTo(R - Math.sqrt(R * R - 4), 2)
    expect(p.heightAt(R + 0.1)).toBe(Infinity)
  })
  it('stamping a ball leaves a spherical dimple', () => {
    const hf = createHeightfield({ minX: -5, minY: -5, maxX: 5, maxY: 5 }, 10, 0, 40_000)
    const removed = stampBit(hf, bitProfile(ball), 0, 0, 8)
    expect(at(hf, 0, 0)).toBeCloseTo(8, 1)
    expect(at(hf, 2, 0)).toBeCloseTo(8 + 3.175 - Math.sqrt(3.175 ** 2 - 4), 1)
    expect(at(hf, 4, 0)).toBe(10)
    expect(removed).toBeGreaterThan(0)
  })
})

describe('finished surface', () => {
  it('flat bit: top untouched, square floor right against the wall', async () => {
    const { hf, cutLines } = await carve(flat)
    expect(at(hf, 0, 0)).toBeCloseTo(10, 3)
    expect(at(hf, 10.5, 0)).toBeLessThan(0.3) // 0.5 mm from the wall, on the floor
    expect(at(hf, 15, 0)).toBeCloseTo(0, 3)
    expect(cutLines.length).toBeGreaterThan(0)
  })

  it('ball nose leaves a fillet at the foot of the wall', async () => {
    const { hf } = await carve(ball)
    const R = 3.175
    const r = R - 0.5 // distance from the allowed centres, 0.5 mm off the wall
    expect(at(hf, 10.5, 0)).toBeCloseTo(R - Math.sqrt(R * R - r * r), 0)
    expect(at(hf, 10 + R + 1, 0)).toBeCloseTo(0, 2)
  })

  it('60° V-bit leaves a sloped wall', async () => {
    const { hf } = await carve(vbit)
    // 0.5 mm off the wall the cone (slope 1/tan 30°) is 2.675 mm from its axis.
    expect(at(hf, 10.5, 0)).toBeCloseTo(2.675 / Math.tan(Math.PI / 6), 0)
    expect(at(hf, 10.5, 0)).toBeGreaterThan(at(hf, 12, 0))
  })

  it('through-cut removes everything outside the outline', async () => {
    const { hf } = await carve(flat, true)
    expect(at(hf, 15, 0)).toBe(hf.bottom)
    expect(at(hf, 0, 0)).toBeCloseTo(10, 3)
  })
})
