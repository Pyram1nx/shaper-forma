// Export to an SVG that Shaper Origin understands.
// - Real-world size: width/height in mm, viewBox in mm.
// - Cut type is encoded twice: Shaper's fill/stroke colour convention and the
//   shaper:cutType attribute. Depth goes in shaper:cutDepth.
// - The cut offset is baked into the geometry (the SVG can't carry it), so the
//   exported path is the path the bit edge follows. No shaper:cutOffset is written.
import type { CutType, Contour, Shape, StudioDoc } from '../model/types'
import { contoursToD } from '../geometry/svgPath'
import { offsetContours } from '../geometry/offset'
import { bboxOfContours, bboxValid, emptyBBox, worldContours } from '../geometry/transform'

export const SHAPER_NS = 'http://www.shapertools.com/namespaces/shaper'

const STYLE: Record<CutType, { fill: string; stroke: string }> = {
  outside: { fill: '#000000', stroke: '#000000' },
  inside: { fill: '#FFFFFF', stroke: '#000000' },
  online: { fill: 'none', stroke: '#000000' },
  pocket: { fill: '#7F7F7F', stroke: 'none' },
  guide: { fill: 'none', stroke: '#0068FF' },
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => +v.toFixed(4)

/**
 * World-space contours as they should be cut. A non-zero cut offset is applied:
 * outside grows the closed shapes, inside and pocket shrink them, and on-line
 * moves closed paths outward. Open paths have no inside or outside, so they are
 * left alone except for on-line (where they're exported unchanged too).
 * Guides are never offset.
 */
export function exportContours(s: Shape, type: CutType): Contour[] {
  const w = worldContours(s)
  const off = s.cut.offset
  if (!off || type === 'guide') return w
  const closed = w.filter((c) => c.closed)
  const open = w.filter((c) => !c.closed)
  switch (type) {
    case 'outside':
    case 'online':
      return [...offsetContours(closed, off), ...open]
    case 'inside':
    case 'pocket':
      return [...offsetContours(closed, -off), ...open]
  }
}

export function exportSVG(doc: StudioDoc, only?: Shape[]): string {
  const shapes = (only ?? doc.shapes).filter((s) => !s.hidden)

  // Each shape's effective type and exported geometry, computed once.
  const items = shapes.map((s) => {
    const allOpen = worldContours(s).every((c) => !c.closed)
    // Open paths can only be cut on-line or used as guides.
    const type: CutType = allOpen && s.cut.type !== 'guide' ? 'online' : s.cut.type
    return { s, type, allOpen, cs: exportContours(s, type) }
  })

  // Bounding box of what is actually exported (offsets can grow past the design).
  const b = emptyBBox()
  for (const it of items) bboxOfContours(it.cs, b)
  const valid = bboxValid(b)
  const minX = valid ? b.minX : 0
  const minY = valid ? b.minY : 0
  const w = valid ? b.maxX - b.minX : 10
  const h = valid ? b.maxY - b.minY : 10

  const groups = new Map<string, typeof items>()
  const loose: typeof items = []
  for (const it of items) {
    if (it.s.groupId) {
      if (!groups.has(it.s.groupId)) groups.set(it.s.groupId, [])
      groups.get(it.s.groupId)!.push(it)
    } else loose.push(it)
  }

  const pathEl = ({ s, type, allOpen, cs }: (typeof items)[number]) => {
    const local = cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x - minX, y: p.y - minY })) }))
    const st = STYLE[type]
    const attrs = [
      `id="${esc(s.id)}"`,
      `d="${contoursToD(local)}"`,
      `fill="${st.fill}"`,
      `stroke="${st.stroke}"`,
      `stroke-width="0.1"`,
      // Pocket holes and any other inner contours stay holes.
      `fill-rule="evenodd"`,
      `vector-effect="non-scaling-stroke"`,
      `shaper:cutType="${type}"`,
    ]
    // Guides are not cut, so they carry no depth or tool attributes.
    if (type !== 'guide') {
      if (s.cut.depth != null) attrs.push(`shaper:cutDepth="${n(s.cut.depth)}mm"`)
      if (s.cut.bitDia) attrs.push(`shaper:toolDia="${n(s.cut.bitDia)}mm"`)
    }
    attrs.push(`shaper:pathType="${allOpen ? 'open' : 'closed'}"`)
    return `    <path ${attrs.join(' ')}><title>${esc(s.name)}</title></path>`
  }

  const body: string[] = []
  for (const it of loose) body.push(pathEl(it))
  for (const [gid, list] of groups) {
    const g = doc.groups.find((x) => x.id === gid)
    body.push(`  <g id="${esc(gid)}"${g ? ` inkscape:label="${esc(g.name)}"` : ''}>`)
    for (const it of list) body.push(pathEl(it))
    body.push('  </g>')
  }

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:shaper="${SHAPER_NS}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`,
    `     width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}" version="1.1">`,
    `  <!-- Created with Shaper forma: ${esc(doc.name)} -->`,
    ...body,
    `</svg>`,
  ].join('\n')
}
