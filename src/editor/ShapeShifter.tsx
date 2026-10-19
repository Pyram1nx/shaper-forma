// ShapeShifter: overlapping shapes are cut into fragments; tapping fragments picks the
// pieces that Finish merges into one new shape.
import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { fragments } from '../geometry/offset'
import { contoursToD } from '../geometry/svgPath'
import { bboxOfContours } from '../geometry/transform'
import ModeCanvas from './ModeCanvas'
import { finishShapeShifter } from './ops'
import { world } from './geomCache'
import type { Contour } from '../model/types'

export default function ShapeShifter() {
  const ids = useStore((s) => s.shifter)
  if (!ids) return null
  return <ShifterView ids={ids} />
}

function ShifterView({ ids }: { ids: string[] }) {
  const shapes = useStore((s) => s.doc.shapes)
  const sources = useMemo(() => shapes.filter((s) => ids.includes(s.id)), [shapes, ids])
  const frags = useMemo<Contour[][]>(() => fragments(sources.map((s) => world(s))), [sources])
  const ds = useMemo(() => frags.map((f) => contoursToD(f)), [frags])
  const bounds = useMemo(() => bboxOfContours(frags.flat()), [frags])

  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [keep, setKeep] = useState(false)
  const exit = () => useStore.getState().exitShapeShifter()

  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p)
      if (!n.delete(i)) n.add(i)
      return n
    })

  const finish = () => {
    if (!picked.size) return
    finishShapeShifter(ids, [...picked].map((i) => frags[i]), keep)
    exit()
  }

  const selectedBounds = () => {
    const sel = [...picked].flatMap((i) => frags[i])
    return sel.length ? bboxOfContours(sel) : bounds
  }

  return (
    <div className="modeview" role="dialog" aria-label="ShapeShifter">
      <ModeCanvas bounds={bounds} zoomTarget={selectedBounds}>
        {(tapOk) =>
          ds.map((d, i) => (
            <path
              key={i}
              d={d}
              fillRule="evenodd"
              vectorEffect="non-scaling-stroke"
              className={'modeview__frag' + (picked.has(i) ? ' is-picked' : '')}
              data-testid={`fragment-${i}`}
              onClick={() => tapOk() && toggle(i)}
            />
          ))
        }
      </ModeCanvas>

      <aside className="modeview__panel">
        <button type="button" className="modeview__close" aria-label="Close ShapeShifter" onClick={exit}>
          <Ic.IconClose size={18} />
        </button>
        <div className="modeview__title">
          <Ic.IconShapeShifter size={18} />
          ShapeShifter
        </div>
        <p className="modeview__hint">Tap fragments to combine them into a new shape.</p>
        <div className="modeview__label">Select</div>
        <button type="button" className="modeview__pill" onClick={() => setPicked(new Set(frags.map((_, i) => i)))}>
          All
        </button>
        <button type="button" className={'modeview__pill' + (picked.size === 0 ? ' is-active' : '')} onClick={() => setPicked(new Set())}>
          None
        </button>
        <div className="modeview__spacer" />
        <label className="modeview__keep">
          Keep existing shapes
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        </label>
        <button type="button" className="modeview__finish" disabled={!picked.size} onClick={finish}>
          Finish
        </button>
      </aside>
    </div>
  )
}
