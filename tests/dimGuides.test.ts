import { describe, expect, it } from 'vitest'
import { dimLayout } from '../src/features/carve3d/dimGuides'

const size = { x: 60, y: 40, z: 30 }
const stock = { x: 70, y: 50 }
const byAxis = (cam: { x: number; y: number }) => Object.fromEntries(dimLayout(size, stock, cam).guides.map((g) => [g.axis, g]))

describe('dimension guides', () => {
  it('width and length sit on the two bottom edges nearest the camera, outside the stock', () => {
    const g = byAxis({ x: 50, y: -120 })
    expect(g.x.a.y).toBeLessThan(-stock.y / 2) // front edge (camera at −y)
    expect(g.x.a.z).toBe(0)
    expect(Math.abs(g.x.b.x - g.x.a.x)).toBeCloseTo(60)
    expect(g.y.a.x).toBeGreaterThan(stock.x / 2) // right edge (camera at +x)
    expect(Math.abs(g.y.b.y - g.y.a.y)).toBeCloseTo(40)
  })

  it('height stands on the back face, at the corner on the side we look from', () => {
    // Looking mostly along +y from −y, slightly from the right: back face y = +20, right corner.
    const g = byAxis({ x: 50, y: -120 })
    expect(g.z.a.y).toBeCloseTo(20)
    expect(g.z.a.x).toBeGreaterThan(30)
    expect(g.z.b.z - g.z.a.z).toBeCloseTo(30)
    // Same height guide shares the length guide's line, so the two meet in an L.
    expect(g.z.a.x).toBeCloseTo(g.y.a.x)
  })

  it('switches faces when the camera swings round to look mostly along x', () => {
    // From +x, slightly −y: back face x = −30, on the −y side.
    const g = byAxis({ x: 120, y: -50 })
    expect(g.z.a.x).toBeCloseTo(-30)
    expect(g.z.a.y).toBeLessThan(-stock.y / 2)
    expect(g.z.a.y).toBeCloseTo(g.x.a.y)
  })

  it('the rebuild key only changes when the guides change edges', () => {
    expect(dimLayout(size, stock, { x: 50, y: -120 }).key).toBe(dimLayout(size, stock, { x: 60, y: -130 }).key)
    expect(dimLayout(size, stock, { x: 50, y: -120 }).key).not.toBe(dimLayout(size, stock, { x: -50, y: -120 }).key)
  })
})
