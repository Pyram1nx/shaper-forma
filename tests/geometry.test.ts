import { describe, expect, it } from 'vitest'
import { offsetContours, boolean, simplify, signedArea } from '../src/geometry/offset'
import { parsePathD, contoursToD } from '../src/geometry/svgPath'
import { rect, ellipse } from '../src/geometry/primitives'
import { bboxOfContours, worldContours, bake } from '../src/geometry/transform'
import type { Shape } from '../src/model/types'
import { DEFAULT_CUT } from '../src/model/types'

const w = (cs: ReturnType<typeof rect>) => {
  const b = bboxOfContours(cs)
  return [b.maxX - b.minX, b.maxY - b.minY]
}

describe('offset', () => {
  it('grows and shrinks a square by the offset distance', () => {
    const sq = rect(10, 10)
    const [gw, gh] = w(offsetContours(sq, 2))
    expect(gw).toBeCloseTo(14, 2)
    expect(gh).toBeCloseTo(14, 2)
    const [sw] = w(offsetContours(sq, -2))
    expect(sw).toBeCloseTo(6, 2)
  })
  it('keeps holes as holes (even-odd)', () => {
    const ring = [...rect(20, 20), ...rect(10, 10)]
    const out = offsetContours(ring, 1)
    expect(out.length).toBe(2)
    const areas = out.map((c) => Math.abs(signedArea(c.pts))).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(64, 0) // hole shrinks to 8x8
  })
  it('round joins give a rounded outside corner', () => {
    const out = offsetContours(rect(10, 10), 2, 'round')
    const area = Math.abs(signedArea(out[0].pts))
    // 14x14 minus the 4 corner squares plus a full circle of r=2
    expect(area).toBeCloseTo(196 - 16 + Math.PI * 4, 0)
  })
  it('boolean difference cuts a hole', () => {
    const out = boolean('difference', rect(20, 20), rect(10, 10))
    expect(out.length).toBe(2)
  })
  it('simplify drops collinear points', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0 }))
    expect(simplify(pts, 0.01).length).toBe(2)
  })
})

describe('svg path', () => {
  it('flattens a full circle made of two arcs', () => {
    const cs = parsePathD('M-10 0A10 10 0 0 1 10 0A10 10 0 0 1 -10 0Z')
    expect(cs.length).toBe(1)
    expect(cs[0].closed).toBe(true)
    for (const p of cs[0].pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 1)
  })
  it('handles relative commands and implicit lineto', () => {
    const cs = parsePathD('m10 10 10 0 0 10 -10 0z')
    expect(cs[0].pts).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ])
  })
  it('round-trips through contoursToD', () => {
    const cs = ellipse(20, 10)
    const back = parsePathD(contoursToD(cs))
    expect(back[0].pts.length).toBe(cs[0].pts.length)
  })
})

describe('transform', () => {
  it('bake keeps the world geometry of a rotated, scaled shape', () => {
    const s: Shape = { id: 'a', name: 'r', kind: 'path', contours: rect(10, 4), x: 5, y: 7, rotation: 30, sx: 2, sy: 1, cut: { ...DEFAULT_CUT } }
    const before = bboxOfContours(worldContours(s))
    const after = bboxOfContours(worldContours(bake(s)))
    expect(after.minX).toBeCloseTo(before.minX, 6)
    expect(after.maxY).toBeCloseTo(before.maxY, 6)
  })
})

describe('svg path robustness', () => {
  it('parses compact arc flags written as one character each', () => {
    const cs = parsePathD('M0 0 a5 5 0 011 5')
    expect(cs.length).toBe(1)
    const last = cs[0].pts[cs[0].pts.length - 1]
    expect(last.x).toBeCloseTo(1, 6)
    expect(last.y).toBeCloseTo(5, 6)
  })
  it('implicit lineto after Z starts from the subpath start', () => {
    const cs = parsePathD('M10 10 L20 10 L20 20 Z H5')
    expect(cs.length).toBe(2)
    expect(cs[1].pts[0]).toEqual({ x: 10, y: 10 })
    expect(cs[1].pts[1]).toEqual({ x: 5, y: 10 })
  })
  it('a malformed token stops parsing without throwing', () => {
    expect(() => parsePathD('M0 0 L10 ! 20 20')).not.toThrow()
  })
})

describe('offset edge cases', () => {
  it('inward offset of an open line is a stroke of radius |delta|', () => {
    const line = [{ closed: false, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }]
    const out = offsetContours(line, -2)
    expect(out.length).toBeGreaterThan(0)
    const b = bboxOfContours(out)
    expect(b.maxY - b.minY).toBeCloseTo(4, 1)
  })
  it('degenerate input never throws', () => {
    expect(offsetContours([], 2)).toEqual([])
    expect(offsetContours([{ closed: true, pts: [] }], 2)).toEqual([])
    expect(offsetContours([{ closed: true, pts: [{ x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] }], 2)).toEqual([])
    expect(offsetContours(rect(10, 10), NaN)).toEqual([])
  })
})

describe('bake', () => {
  it('turns parametric kinds into paths and keeps text params', () => {
    const r: Shape = { id: 'a', name: 'r', kind: 'rect', contours: rect(10, 4), params: { w: 10, h: 4 }, x: 0, y: 0, rotation: 30, sx: 1, sy: 1, cut: { ...DEFAULT_CUT } }
    expect(bake(r).kind).toBe('path')
    expect(bake(r).params).toBeUndefined()
    const t: Shape = { ...r, kind: 'text', params: { text: 'hi' } }
    expect(bake(t).kind).toBe('text')
    expect(bake(t).params).toEqual({ text: 'hi' })
  })
})
