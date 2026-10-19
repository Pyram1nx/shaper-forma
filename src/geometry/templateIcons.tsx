import { useMemo } from 'react'
import type { JSX } from 'react'
import type { Contour } from '../model/types'
import { TEMPLATES } from './templates'

const built = new Map<string, Contour[]>()

/** Default-parameter geometry for a template, built once per id. */
function defaultContours(id: string): Contour[] {
  let cs = built.get(id)
  if (!cs) {
    const t = TEMPLATES.find((tp) => tp.id === id)
    cs = t ? t.build({}) : []
    built.set(id, cs)
  }
  return cs
}

const fmt = (v: number) => Math.round(v * 1000) / 1000

/** SVG path data for the contours, uniformly scaled into a size×size box with 3px padding. */
function fitPath(cs: Contour[], size: number): string {
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
  if (!isFinite(minX)) return ''
  const pad = 3
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const s = (size - 2 * pad) / span
  const ox = size / 2 - ((minX + maxX) / 2) * s
  const oy = size / 2 - ((minY + maxY) / 2) * s
  let d = ''
  for (const c of cs) {
    if (c.pts.length < 2) continue
    c.pts.forEach((p, i) => {
      d += `${i === 0 ? 'M' : 'L'}${fmt(p.x * s + ox)} ${fmt(p.y * s + oy)}`
    })
    if (c.closed) d += 'Z'
  }
  return d
}

const pathCache = new Map<string, string>()

/** Path data per template id and size, memoised. */
function iconPath(id: string, size: number): string {
  const key = `${id}@${size}`
  let d = pathCache.get(key)
  if (d === undefined) {
    d = fitPath(defaultContours(id), size)
    pathCache.set(key, d)
  }
  return d
}

export function TemplateIcon({ id, size = 32 }: { id: string; size?: number }): JSX.Element {
  const d = useMemo(() => iconPath(id, size), [id, size])
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <path
        d={d}
        fill="currentColor"
        fillRule="evenodd"
        fillOpacity={0.15}
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
