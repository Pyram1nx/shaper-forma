// Parametric shape templates (Shaper Studio "Templates"). Lengths in mm, every build()
// returns closed contours centred on (0,0). Holes are separate contours inside the
// outer one (even-odd fill).
import type { Contour, Pt } from '../model/types'
import { fitTo, rect, star } from './primitives'
import { boolean } from './offset'

export interface TemplateParam {
  key: string
  label: string
  kind: 'length' | 'count' | 'angle' | 'ratio'
  default: number
  min?: number
  max?: number
}

export interface Template {
  id: string
  name: string
  params: TemplateParam[]
  build: (p: Record<string, number>) => Contour[]
}

type Getter = (key: string) => number

const TAU = Math.PI * 2

function prm(key: string, label: string, kind: TemplateParam['kind'], def: number, min?: number, max?: number): TemplateParam {
  const q: TemplateParam = { key, label, kind, default: def }
  if (min !== undefined) q.min = min
  if (max !== undefined) q.max = max
  return q
}

/** Wraps a builder so missing params fall back to their defaults. */
function tpl(id: string, name: string, params: TemplateParam[], fn: (g: Getter) => Contour[]): Template {
  const defaults: Record<string, number> = {}
  for (const q of params) defaults[q.key] = q.default
  return {
    id,
    name,
    params,
    build: (p) => fn((key) => p[key] ?? defaults[key] ?? 0),
  }
}

function circle(cx: number, cy: number, r: number): Contour {
  const n = Math.max(48, Math.min(720, Math.ceil(r * 8)))
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { pts, closed: true }
}

function move(cs: Contour[], dx: number, dy: number): Contour[] {
  return cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) }))
}

function spin(cs: Contour[], deg: number): Contour[] {
  const a = (deg * Math.PI) / 180
  const co = Math.cos(a)
  const si = Math.sin(a)
  return cs.map((c) => ({
    closed: c.closed,
    pts: c.pts.map((p) => ({ x: p.x * co - p.y * si, y: p.x * si + p.y * co })),
  }))
}

function unite(...sets: Contour[][]): Contour[] {
  return sets.reduce((acc, s) => boolean('union', acc, s))
}

/** Translate so the bounding box centre sits on (0,0). */
function centre(cs: Contour[]): Contour[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cs)
    for (const p of c.pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  if (!isFinite(minX)) return cs
  return move(cs, -(minX + maxX) / 2, -(minY + maxY) / 2)
}

/** Drop consecutive duplicate points (including a closing duplicate). */
function clean(pts: Pt[]): Pt[] {
  const eq = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || !eq(q, p)) out.push(p)
  }
  while (out.length > 1 && eq(out[0], out[out.length - 1])) out.pop()
  return out
}

/** Points along a circular arc from angle a0 to a1 (radians), inclusive. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/**
 * Box-joint board edge with fingers along the top edge. Tabs (even slots) reach the
 * outer edge, notches (odd slots) stop `depth` short of it. Returns the outline and the
 * inside notch corners where dogbone relief is needed.
 */
function boxJoint(L: number, H: number, fingers: number, depth: number): { outline: Contour; corners: Pt[] } {
  const N = Math.max(1, Math.round(fingers))
  const w = L / N
  const yt = -H / 2
  const yn = -H / 2 + depth
  const yb = H / 2
  const pts: Pt[] = [{ x: -L / 2, y: yb }]
  const corners: Pt[] = []
  for (let i = 0; i < N; i++) {
    const x0 = -L / 2 + i * w
    const x1 = x0 + w
    const tab = i % 2 === 0
    const y = tab ? yt : yn
    pts.push({ x: x0, y }, { x: x1, y })
    if (!tab) {
      corners.push({ x: x0, y: yn })
      if (i < N - 1) corners.push({ x: x1, y: yn })
    }
  }
  pts.push({ x: L / 2, y: yb })
  return { outline: { pts: clean(pts), closed: true }, corners }
}

/** Heart: two lobe arcs meeting in a top notch, tangent lines down to a bottom point. */
function heartPts(): Pt[] {
  const R = 1
  const a = 0.5
  const yb = 2
  const d = Math.hypot(a, yb)
  const phi = Math.atan2(yb, -a)
  const th = Math.acos(R / d)
  const angT = phi - th // right lobe tangent point, measured from right centre
  const nY = -Math.sqrt(R * R - a * a) // top notch
  const angNR = Math.atan2(nY, -a) // notch seen from right centre
  const angNL = Math.atan2(nY, a) // notch seen from left centre
  const angTL = Math.PI - angT - TAU // left tangent point, swept clockwise from notch
  const n = 64
  const pts: Pt[] = [{ x: 0, y: yb }]
  pts.push(...arc(a, 0, R, angT, angNR, n))
  pts.push(...arc(-a, 0, R, angNL, angTL, n).slice(1))
  // The heart is 3 wide and 3 tall, so fitting to a unit box keeps its proportions.
  return fitTo(clean(pts), 1, 1)
}

export const TEMPLATES: Template[] = [
  tpl(
    'barbell',
    'Barbell',
    [
      prm('length', 'Length', 'length', 50.8, 0),
      prm('endDiameter', 'End diameter', 'length', 19.05, 0),
      prm('barWidth', 'Bar width', 'length', 6.35, 0),
    ],
    (g) => {
      const L = g('length')
      const d = g('endDiameter')
      const bw = g('barWidth')
      return unite([circle(-L / 2, 0, d / 2)], [circle(L / 2, 0, d / 2)], rect(L, bw))
    },
  ),

  tpl(
    'bowtie',
    'Bow tie',
    [
      prm('length', 'Length', 'length', 50.8, 0),
      prm('width', 'Width', 'length', 25.4, 0),
      prm('waist', 'Waist', 'length', 12.7, 0),
    ],
    (g) => {
      const L = g('length')
      const W = g('width')
      const wa = g('waist')
      return [
        {
          closed: true,
          pts: [
            { x: -L / 2, y: -W / 2 },
            { x: -L / 2, y: W / 2 },
            { x: 0, y: wa / 2 },
            { x: L / 2, y: W / 2 },
            { x: L / 2, y: -W / 2 },
            { x: 0, y: -wa / 2 },
          ],
        },
      ]
    },
  ),

  tpl(
    'boxJointBasic',
    'Box joint',
    [
      prm('length', 'Length', 'length', 101.6, 0),
      prm('height', 'Height', 'length', 25.4, 0),
      prm('fingers', 'Fingers', 'count', 5, 1, 99),
      prm('fingerDepth', 'Finger depth', 'length', 6.35, 0),
    ],
    (g) => {
      const { outline } = boxJoint(g('length'), g('height'), g('fingers'), g('fingerDepth'))
      return [outline]
    },
  ),

  tpl(
    'boxJointPro',
    'Box joint (dogbone)',
    [
      prm('length', 'Length', 'length', 101.6, 0),
      prm('height', 'Height', 'length', 25.4, 0),
      prm('fingers', 'Fingers', 'count', 5, 1, 99),
      prm('fingerDepth', 'Finger depth', 'length', 6.35, 0),
      prm('bitDiameter', 'Bit diameter', 'length', 6.35, 0),
    ],
    (g) => {
      const { outline, corners } = boxJoint(g('length'), g('height'), g('fingers'), g('fingerDepth'))
      const r = g('bitDiameter') / 2
      const relief = corners.map((p) => circle(p.x, p.y, r))
      return boolean('difference', [outline], relief)
    },
  ),

  tpl(
    'compass',
    'Compass',
    [
      prm('points', 'Points', 'count', 4, 2, 16),
      prm('size', 'Size', 'length', 50.8, 0),
      prm('inner', 'Inner radius', 'ratio', 0.25, 0.01, 1),
      prm('holeDiameter', 'Centre hole', 'length', 6.35, 0),
    ],
    (g) => {
      const body = star(Math.max(2, Math.round(g('points'))), g('size'), g('size'), g('inner'))
      return boolean('difference', body, [circle(0, 0, g('holeDiameter') / 2)])
    },
  ),

  tpl(
    'cornerRound',
    'Corner round',
    [
      prm('size', 'Size', 'length', 25.4, 0),
      prm('radius', 'Radius', 'length', 12.7, 0),
    ],
    (g) => {
      const s = g('size')
      const h = s / 2
      const r = Math.min(Math.max(g('radius'), 0), s)
      const pts: Pt[] = [{ x: -h, y: -h }]
      if (r < 1e-6) {
        pts.push({ x: h, y: -h })
      } else {
        // Rounded top-right corner: arc centre (h - r, -h + r).
        const cx = h - r
        const cy = -h + r
        pts.push(...arc(cx, cy, r, -Math.PI / 2, 0, Math.max(12, Math.ceil(r * 4))))
      }
      pts.push({ x: h, y: h }, { x: -h, y: h })
      return [{ pts: clean(pts), closed: true }]
    },
  ),

  tpl(
    'dogboneRectangle',
    'Dogbone rectangle',
    [
      prm('width', 'Width', 'length', 50.8, 0),
      prm('height', 'Height', 'length', 25.4, 0),
      prm('bitDiameter', 'Bit diameter', 'length', 6.35, 0),
    ],
    (g) => {
      const w = g('width')
      const h = g('height')
      const r = g('bitDiameter') / 2
      const hw = w / 2
      const hh = h / 2
      // Circle centre sits r/√2 inside each corner on both axes, so its edge passes through the corner.
      const off = r / Math.SQRT2
      const corners = [
        [hw, hh],
        [-hw, hh],
        [-hw, -hh],
        [hw, -hh],
      ]
      const relief = corners.map(([x, y]) => circle(x - Math.sign(x) * off, y - Math.sign(y) * off, r))
      return boolean('union', rect(w, h), relief)
    },
  ),

  tpl('heart', 'Heart', [prm('size', 'Size', 'length', 50.8, 0)], (g) => {
    const s = g('size')
    const pts = heartPts().map((p) => ({ x: p.x * s, y: p.y * s }))
    return [{ pts, closed: true }]
  }),

  tpl(
    'keyhole',
    'Keyhole',
    [
      prm('headDiameter', 'Head diameter', 'length', 9.5, 0),
      prm('slotWidth', 'Slot width', 'length', 4.8, 0),
      prm('slotLength', 'Slot length', 'length', 12.7, 0),
    ],
    (g) => {
      const rr = g('headDiameter') / 2
      const rs = g('slotWidth') / 2
      // Slot runs down from the head centre; its bottom semicircle is centred at yEnd.
      const yEnd = Math.max(0, g('slotLength') - rs)
      const slot = unite(move(rect(rs * 2, yEnd), 0, yEnd / 2), [circle(0, yEnd, rs)])
      return centre(unite([circle(0, 0, rr)], slot))
    },
  ),

  tpl(
    'linearHoles',
    'Linear holes',
    [
      prm('count', 'Count', 'count', 5, 1, 99),
      prm('diameter', 'Diameter', 'length', 6.35, 0),
      prm('spacing', 'Spacing', 'length', 19.05, 0),
    ],
    (g) => {
      const n = Math.max(1, Math.round(g('count')))
      const d = g('diameter')
      const sp = g('spacing')
      const out: Contour[] = []
      for (let i = 0; i < n; i++) out.push(circle((i - (n - 1) / 2) * sp, 0, d / 2))
      return out
    },
  ),

  tpl(
    'linearRectangles',
    'Linear rectangles',
    [
      prm('count', 'Count', 'count', 4, 1, 99),
      prm('width', 'Width', 'length', 12.7, 0),
      prm('height', 'Height', 'length', 25.4, 0),
      prm('spacing', 'Spacing', 'length', 19.05, 0),
      prm('radius', 'Corner radius', 'length', 0, 0),
    ],
    (g) => {
      const n = Math.max(1, Math.round(g('count')))
      const w = g('width')
      const h = g('height')
      const sp = g('spacing')
      const r = g('radius')
      const out: Contour[] = []
      for (let i = 0; i < n; i++) out.push(...move(rect(w, h, r), (i - (n - 1) / 2) * sp, 0))
      return out
    },
  ),

  tpl(
    'radialHoles',
    'Radial holes',
    [
      prm('count', 'Count', 'count', 6, 1, 99),
      prm('boltDiameter', 'Bolt circle diameter', 'length', 50.8, 0),
      prm('holeDiameter', 'Hole diameter', 'length', 6.35, 0),
    ],
    (g) => {
      const n = Math.max(1, Math.round(g('count')))
      const R = g('boltDiameter') / 2
      const hr = g('holeDiameter') / 2
      const out: Contour[] = []
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * TAU
        out.push(circle(R * Math.cos(a), R * Math.sin(a), hr))
      }
      return out
    },
  ),

  tpl(
    'snowflake',
    'Snowflake',
    [
      prm('size', 'Size', 'length', 50.8, 0),
      prm('armWidth', 'Arm width', 'length', 3.2, 0),
    ],
    (g) => {
      const R = g('size') / 2
      const aw = g('armWidth')
      const bl = 0.3 * R // branch length
      const bw = aw * 0.8 // branch width
      // One arm pointing up (-y), with four side branches at ±45°.
      let arm: Contour[] = move(rect(aw, R), 0, -R / 2)
      for (const f of [0.45, 0.75]) {
        for (const s of [-1, 1]) {
          const br = move(spin(move(rect(bw, bl), 0, -bl / 2), s * 45), 0, -f * R)
          arm = unite(arm, br)
        }
      }
      // Six copies, 60° apart.
      let out: Contour[] = arm
      for (let k = 1; k < 6; k++) out = unite(out, spin(arm, k * 60))
      return centre(out)
    },
  ),

  tpl(
    'star',
    'Star',
    [
      prm('points', 'Points', 'count', 5, 2, 16),
      prm('size', 'Size', 'length', 50.8, 0),
      prm('inner', 'Inner radius', 'ratio', 0.45, 0.01, 1),
    ],
    (g) => star(Math.max(2, Math.round(g('points'))), g('size'), g('size'), g('inner')),
  ),
]
