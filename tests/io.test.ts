import { describe, expect, it, vi } from 'vitest'
import { hrefIsSafe, isBannedTag, lenMM, mmPerUserUnit, sanitizeCss, userLength } from '../src/io/svgImport'
import { exportSVG } from '../src/io/svgExport'
import { createAutosaver, parseDoc } from '../src/io/projectFile'
import { newDoc } from '../src/state/store'
import { shapeFromWorld } from '../src/model/factory'
import { rect } from '../src/geometry/primitives'
import type { StudioDoc } from '../src/model/types'

describe('svg import units', () => {
  it('unitless attributes are user units, not mm', () => {
    // 210 mm wide file with viewBox 210: one user unit is one mm.
    const mpu = mmPerUserUnit('210mm', '210mm', { width: 210, height: 210 })
    expect(mpu).toBeCloseTo(1)
    // A 100-unit rect must come out as 100 mm, not 26.46 mm.
    expect(userLength('100', mpu) * mpu).toBeCloseTo(100)
  })
  it('absolute attribute units are converted to user units', () => {
    const mpu = mmPerUserUnit('210mm', '210mm', { width: 210, height: 210 })
    expect(userLength('10mm', mpu) * mpu).toBeCloseTo(10)
    const mpu2 = mmPerUserUnit('100mm', null, { width: 1000, height: 1000 })
    expect(mpu2).toBeCloseTo(0.1)
    expect(userLength('10mm', mpu2)).toBeCloseTo(100)
    expect(userLength('1in', mpu2) * mpu2).toBeCloseTo(25.4)
  })
  it('without a viewBox a user unit is one CSS px', () => {
    const mpu = mmPerUserUnit('96px', '96px', null)
    expect(mpu).toBeCloseTo(25.4 / 96)
    expect(userLength('96', mpu) * mpu).toBeCloseTo(25.4)
  })
  it('percentages and garbage give 0 and null', () => {
    expect(userLength('50%', 1)).toBe(0)
    expect(userLength('abc', 1)).toBe(0)
    expect(lenMM(null)).toBeNull()
  })
})

describe('svg import safety', () => {
  it('only local fragments and inline raster data are safe hrefs', () => {
    expect(hrefIsSafe('#shape1')).toBe(true)
    expect(hrefIsSafe('data:image/png;base64,AAAA')).toBe(true)
    expect(hrefIsSafe('javascript:alert(1)')).toBe(false)
    expect(hrefIsSafe('https://example.com/x.svg#a')).toBe(false)
    expect(hrefIsSafe('other.svg#a')).toBe(false)
  })
  it('strips external url() from styles but keeps local ones', () => {
    const out = sanitizeCss('rect{fill:url(https://evil.example/x.svg)} p{fill:url(#grad)}')
    expect(out).not.toContain('evil')
    expect(out).toContain('url(#grad)')
    expect(sanitizeCss('@import url(https://evil.example/a.css); g{fill:red}')).not.toContain('evil')
  })
  it('bans active elements', () => {
    for (const t of ['script', 'foreignObject', 'iframe', 'svg:script', 'animate']) expect(isBannedTag(t)).toBe(true)
    expect(isBannedTag('g')).toBe(false)
    expect(isBannedTag('path')).toBe(false)
  })
})

describe('svg export offsets', () => {
  const sq = (offset: number, type: 'outside' | 'inside' | 'pocket' | 'online' | 'guide' = 'outside') =>
    shapeFromWorld('path', 'sq', rect(25.4, 25.4), { cut: { type, depth: 3, offset, bitDia: 3.175 } })
  const doc = (shapes: ReturnType<typeof sq>[]): StudioDoc => ({ ...newDoc('t'), shapes, groups: [] })

  it('bakes an outside offset into the geometry and drops shaper:cutOffset', () => {
    const svg = exportSVG(doc([sq(2)]))
    expect(svg).toContain('width="29.4mm"')
    expect(svg).toContain('height="29.4mm"')
    expect(svg).not.toContain('shaper:cutOffset')
    expect(svg).toContain('shaper:cutDepth="3mm"')
  })
  it('inside offset shrinks the exported path', () => {
    expect(exportSVG(doc([sq(2, 'inside')]))).toContain('width="21.4mm"')
  })
  it('pocket keeps evenodd and shrinks', () => {
    const svg = exportSVG(doc([sq(1, 'pocket')]))
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg).toContain('shaper:cutType="pocket"')
    expect(svg).toContain('width="23.4mm"')
  })
  it('guides are exported as blue strokes', () => {
    expect(exportSVG(doc([sq(0, 'guide')]))).toContain('stroke="#0068FF"')
  })
  it('zero offset leaves the geometry at the design size', () => {
    expect(exportSVG(doc([sq(0)]))).toContain('width="25.4mm"')
  })
})

describe('project file parsing', () => {
  const base = (shapes: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ app: 'ShaperStudio', version: 1, id: 'd1', name: 'x', units: 'mm', shapes, groups: [], settings: {}, ...extra })

  it('rejects other files and newer versions', () => {
    expect(() => parseDoc('{"hello":1}')).toThrow()
    expect(() => parseDoc('not json')).toThrow()
    expect(() => parseDoc(base([], { version: 2 }))).toThrow(/newer version/)
  })
  it('drops shapes with broken geometry and repairs bad cut and transform fields', () => {
    const good = { id: 's1', name: 'a', kind: 'rect', contours: [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }], x: 1, y: 2, rotation: 0, sx: 1, sy: 1, cut: { type: 'outside', depth: null, offset: 0, bitDia: 3 } }
    const badContours = { ...good, id: 's2', contours: [{ closed: true, pts: [{ x: 'nope', y: 0 }] }] }
    const repaired = { ...good, id: 's3', kind: 'mystery', x: NaN, rotation: 'x', cut: { type: 'laser', offset: 'x', bitDia: -1 } }
    const d = parseDoc(base([good, badContours, repaired, null]))
    expect(d.shapes.map((s) => s.id)).toEqual(['s1', 's3'])
    const r = d.shapes[1]
    expect(r.kind).toBe('path')
    expect(r.x).toBe(0)
    expect(r.rotation).toBe(0)
    expect(r.cut.type).toBe('outside')
    expect(r.cut.bitDia).toBeGreaterThan(0)
  })
  it('keeps a valid design intact', () => {
    const d: StudioDoc = parseDoc(base([]))
    expect(d.units).toBe('mm')
    expect(d.app).toBe('ShaperStudio')
  })
})

describe('guide export', () => {
  it('guides carry no shaper:cutDepth or shaper:toolDia', () => {
    const g = shapeFromWorld('path', 'guide', rect(25.4, 25.4), { cut: { type: 'guide', depth: 3, offset: 0, bitDia: 3.175 } })
    const svg = exportSVG({ ...newDoc('t'), shapes: [g], groups: [] })
    expect(svg).toContain('shaper:cutType="guide"')
    expect(svg).not.toContain('shaper:cutDepth')
    expect(svg).not.toContain('shaper:toolDia')
  })
})

describe('autosave on document switch', () => {
  it('flushes the replaced document immediately and saves the new one after the delay', () => {
    vi.useFakeTimers()
    try {
      const a = { ...newDoc('a'), id: 'A' }
      const b = { ...newDoc('b'), id: 'B' }
      const saved: string[] = []
      let current: StudioDoc = a
      const saver = createAutosaver(() => current, (d) => void saved.push(d.id), 600)
      const a1 = { ...a, name: 'edit 1' }
      const a2 = { ...a1, name: 'edit 2' }
      current = a1
      saver.onChange(a1, a)
      current = a2
      saver.onChange(a2, a1)
      // Opening another design inside the debounce window must not lose the edits to A.
      current = b
      saver.onChange(b, a2)
      expect(saved).toEqual(['A'])
      vi.advanceTimersByTime(600)
      expect(saved).toEqual(['A', 'B'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces ordinary edits to one save', () => {
    vi.useFakeTimers()
    try {
      const a = { ...newDoc('a'), id: 'A' }
      const saved: string[] = []
      let current: StudioDoc = a
      const saver = createAutosaver(() => current, (d) => void saved.push(d.name), 600)
      for (let i = 1; i <= 3; i++) {
        const next = { ...current, name: 'n' + i }
        saver.onChange(next, current)
        current = next
      }
      expect(saved).toEqual([])
      vi.advanceTimersByTime(600)
      expect(saved).toEqual(['n3'])
    } finally {
      vi.useRealTimers()
    }
  })
})
