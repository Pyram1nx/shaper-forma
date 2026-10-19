// Offset mode: the selection is shown with a live preview of its offset outline.
// Distance is signed (negative shrinks), so there is no separate inside/outside switch.
import { useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { NumField } from './Panels'
import ModeCanvas from './ModeCanvas'
import { offsetResults, offsetSelection } from './ops'
import { world } from './geomCache'
import { contoursToD } from '../geometry/svgPath'
import { bboxOfContours } from '../geometry/transform'
import { MM_PER_IN } from '../model/types'
import type { JoinStyle } from '../geometry/offset'

const PRESETS_IN: [string, number][] = [
  ['1⁄16', 1 / 16],
  ['1⁄8', 1 / 8],
  ['1⁄4', 1 / 4],
  ['1⁄2', 1 / 2],
]
const PRESETS_MM: [string, number][] = [['1', 1], ['2', 2], ['5', 5], ['10', 10]]

/** A corner of the outline in each join style (the dashed line is the original edge). */
const CORNER_ICON: Record<JoinStyle, ReactNode> = {
  round: <path d="M5 19V13a8 8 0 0 1 8-8h6" />,
  miter: <path d="M5 19V5h14" />,
  square: <path d="M5 19V9l4-4h10" />,
}
const CORNER_LABEL: Record<JoinStyle, string> = { round: 'Round', miter: 'Sharp', square: 'Square' }

export default function OffsetMode() {
  const open = useStore((s) => s.dialog === 'offset')
  const count = useStore((s) => s.selection.length)
  if (!open || !count) return null
  return <OffsetView />
}

function OffsetView() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const units = doc.units
  const sel = useMemo(() => doc.shapes.filter((s) => selection.includes(s.id)), [doc.shapes, selection])
  const [distance, setDistance] = useState(units === 'in' ? MM_PER_IN / 8 : 3)
  const [join, setJoin] = useState<JoinStyle>('round')
  const [combine, setCombine] = useState(true)
  const close = () => useStore.getState().openDialog(null)

  const sources = useMemo(() => sel.map((s) => contoursToD(world(s))), [sel])
  const results = useMemo(() => offsetResults(sel, { distance, join, combine }), [sel, distance, join, combine])
  const resultDs = useMemo(() => results.map((r) => contoursToD(r.contours)), [results])
  const bounds = useMemo(() => {
    const b = bboxOfContours(sel.flatMap((s) => world(s)))
    const pad = MM_PER_IN / 2
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
  }, [sel])

  const apply = () => {
    offsetSelection({ distance, join, combine })
    close()
  }
  const presets = units === 'in' ? PRESETS_IN : PRESETS_MM
  const toMm = (v: number) => (units === 'in' ? v * MM_PER_IN : v)

  return (
    <div className="modeview" role="dialog" aria-label="Offset">
      <ModeCanvas bounds={bounds}>
        {() => (
          <>
            {sources.map((d, i) => (
              <path key={'s' + i} d={d} fillRule="evenodd" vectorEffect="non-scaling-stroke" className="modeview__shape" />
            ))}
            {resultDs.map((d, i) => (
              <path key={'r' + i} d={d} fillRule="evenodd" vectorEffect="non-scaling-stroke" className="modeview__result" />
            ))}
          </>
        )}
      </ModeCanvas>

      <aside className="modeview__panel">
        <button type="button" className="modeview__close" aria-label="Close Offset" onClick={close}>
          <Ic.IconClose size={18} />
        </button>
        <div className="modeview__title">
          <Ic.IconOffset size={18} />
          Offset
        </div>
        <p className="modeview__hint">Set the desired offset distance and corner style</p>
        <div className="modeview__label">Distance</div>
        <div className="modeview__dist">
          <NumField label="Offset distance" value={distance} units={units} onCommit={(v) => setDistance(v)} />
        </div>
        <div className="modeview__presets">
          {presets.map(([label, v]) => (
            <button key={label} type="button" className="modeview__preset" onClick={() => setDistance(toMm(v))}>
              {label}
            </button>
          ))}
        </div>
        <div className="modeview__label" style={{ marginTop: 12 }}>
          Corner Style
        </div>
        <div className="modeview__corners" role="group" aria-label="Corner style">
          {(['round', 'miter', 'square'] as JoinStyle[]).map((j) => (
            <button
              key={j}
              type="button"
              title={CORNER_LABEL[j]}
              aria-label={CORNER_LABEL[j]}
              aria-pressed={join === j}
              className={'modeview__corner' + (join === j ? ' is-active' : '')}
              onClick={() => setJoin(j)}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {CORNER_ICON[j]}
              </svg>
            </button>
          ))}
        </div>
        <div className="modeview__spacer" />
        {sel.length > 1 && (
          <label className={'modeview__keep' + (combine ? ' is-active' : '')}>
            Join shapes
            <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} />
          </label>
        )}
        <button type="button" className="modeview__finish" disabled={!results.length} onClick={apply}>
          Apply
        </button>
      </aside>
    </div>
  )
}

