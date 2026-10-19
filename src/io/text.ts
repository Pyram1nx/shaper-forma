// Text → outline contours using opentype.js. IBM Plex Sans is bundled; users can
// also load their own TTF/OTF/WOFF font.
import type opentype from 'opentype.js'
import type { Contour } from '../model/types'
import { parsePathD } from '../geometry/svgPath'

export const DEFAULT_FONT = 'IBM Plex Sans'
const cache = new Map<string, Promise<opentype.Font>>()
// opentype.js is only needed for text, so it's loaded on demand.
const ot = () => import('opentype.js').then((m) => m.default)
const custom = new Map<string, ArrayBuffer>()

export function fontNames(): string[] {
  return [DEFAULT_FONT, ...custom.keys()]
}

export async function addCustomFont(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const font = (await ot()).parse(buf)
  const name = font.names.fullName?.en || file.name.replace(/\.[^.]+$/, '')
  custom.set(name, buf)
  cache.set(name, Promise.resolve(font))
  return name
}

/** Whether `name` can be rendered: the bundled font, or a custom font loaded this session. */
export function hasFont(name: string): boolean {
  return name === DEFAULT_FONT || cache.has(name)
}

export function loadFont(name: string = DEFAULT_FONT): Promise<opentype.Font> {
  let p = cache.get(name)
  // A custom font that isn't cached (e.g. after a reload) must never fall back silently.
  if (!p && name !== DEFAULT_FONT) return Promise.reject(new Error(missingFontMessage(name)))
  if (!p) {
    p = fetch(import.meta.env.BASE_URL + 'fonts/IBMPlexSans-Regular.woff')
      .then((r) => r.arrayBuffer())
      .then(async (b) => (await ot()).parse(b))
    cache.set(name, p)
  }
  return p
}

export const missingFontMessage = (name: string) => `Font "${name}" isn't loaded — re-upload it`

/**
 * Convert text to contours. `height` is the cap height in mm. Lines are split
 * on newlines. Returns contours with the text block centred on (0,0).
 */
export async function textToContours(text: string, fontName: string, height: number): Promise<Contour[]> {
  if (!hasFont(fontName)) throw new Error(missingFontMessage(fontName))
  const font = await loadFont(fontName)
  const capH = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm
  const size = height / capH
  const lineH = size * 1.2
  const out: Contour[] = []
  text.split('\n').forEach((line, i) => {
    if (!line) return
    const path = font.getPath(line, 0, i * lineH, size)
    out.push(...parsePathD(path.toPathData(3), 0.02))
  })
  if (!out.length) return out
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of out)
    for (const p of c.pts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return out.map((c) => ({ closed: true, pts: c.pts.map((p) => ({ x: p.x - cx, y: p.y - cy })) }))
}
