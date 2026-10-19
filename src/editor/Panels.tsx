import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { selectedShapes, useStore, withoutCheckpoint, editableIds } from '../state/store'
import type { CutType, Group, Shape, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { fmtNum } from '../model/factory'
import * as Ic from '../ui/icons'
import { anchorPoint, parseLength, resizeSelection, rotateSelection, selectionBBox, type Anchor, type AnchorRef } from './ops'
import { buildFromParams } from './shapeFactory'
import { TEMPLATES } from '../geometry/templates'
import { BITS } from '../features/carve3d/bits'

/** Display a length in doc units (number only). */
export const fmtLenValue = (mm: number, units: Units) => fmtNum(mm, units)

/** Run fn; when coalesced, it adds no new undo step. */
const mut = (coalesced: boolean, fn: () => void) => (coalesced ? withoutCheckpoint(fn) : fn())

const UNDO_BURST_MS = 600

// ---------- Number field ----------
export interface NumFieldProps {
  adorn?: ReactNode
  suffix?: string
  value: number | null
  /** 'length' values are mm internally and shown in doc units. */
  kind?: 'length' | 'angle' | 'count'
  units: Units
  placeholder?: string
  /** Accessible name, e.g. "Width". */
  label: string
  /** coalesced = true for an arrow-key step that follows another step within 600 ms (no new undo entry). */
  onCommit: (v: number, coalesced: boolean) => void
  className?: string
  /** Step for arrow keys (defaults to the same step as the depth +/- buttons). */
  step?: number
}

export function NumField({ adorn, suffix, value, kind = 'length', units, placeholder, label, onCommit, className, step }: NumFieldProps) {
  const fmt = (v: number | null) => {
    if (v == null || !Number.isFinite(v)) return ''
    if (kind === 'length') return fmtLenValue(v, units)
    if (kind === 'angle') return String(+v.toFixed(2))
    return String(Math.round(v))
  }
  const [text, setText] = useState(fmt(value))
  const edited = useRef(false)
  const cancel = useRef(false)
  const lastStep = useRef(0)
  useEffect(() => {
    if (!edited.current) setText(fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units])

  const finish = () => {
    const commitIt = edited.current && !cancel.current
    edited.current = false
    cancel.current = false
    if (!commitIt) return setText(fmt(value))
    if (text.trim() === fmt(value)) return // unchanged text: never commit (avoids rounding drift and empty undo steps)
    const t = text.replace(/(\d),(\d)/g, '$1.$2') // accept comma decimals
    const v = kind === 'length' ? parseLength(t, units) : parseFloat(t)
    if (v != null && Number.isFinite(v) && (value == null || Math.abs(v - value) > 1e-9)) onCommit(v, false)
    else setText(fmt(value))
  }

  const baseStep = step ?? (kind === 'length' ? (units === 'in' ? MM_PER_IN / 16 : 0.5) : 1)

  return (
    <div className={'ss-input ' + (className ?? '')}>
      {adorn != null && <span className="ss-input__adorn">{adorn}</span>}
      <input
        aria-label={label}
        inputMode={kind === 'count' ? 'numeric' : 'decimal'}
        value={text}
        placeholder={placeholder}
        onFocus={(e) => e.target.select()}
        onBlur={finish}
        onChange={(e) => {
          edited.current = true
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            cancel.current = true
            ;(e.target as HTMLInputElement).blur()
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value != null) {
            e.preventDefault()
            const now = performance.now()
            const coalesced = now - lastStep.current < UNDO_BURST_MS
            lastStep.current = now
            edited.current = false
            onCommit(value + (e.key === 'ArrowUp' ? 1 : -1) * baseStep * (e.shiftKey ? 10 : 1), coalesced)
          }
          e.stopPropagation()
        }}
      />
      <span className="ss-input__adorn">{suffix ?? (kind === 'length' ? units : kind === 'angle' ? 'º' : '')}</span>
    </div>
  )
}

function Field({ label, tab, children }: { label: string; tab?: string; children: ReactNode }) {
  return (
    <div className="ss-field" role="group" aria-label={label} data-tab={tab}>
      <span className="ss-label">{label}</span>
      {children}
    </div>
  )
}

/**
 * A floating panel positioned from an anchor element and rendered in <body>, so the
 * right dock's transform and overflow clipping don't cut it off. Closes on outside
 * pointer-down and on Escape (captured, so the global Escape handler doesn't also run).
 */
export function Floating({
  anchor,
  side,
  className,
  onDismiss,
  children,
}: {
  anchor: HTMLElement
  side: 'left' | 'above'
  className: string
  onDismiss: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const m = 15
    let left = side === 'left' ? r.left - 30 - w : r.left
    let top = side === 'left' ? r.top - 18 : r.top - h - 8
    left = Math.max(m, Math.min(left, window.innerWidth - w - m))
    top = Math.max(m, Math.min(top, window.innerHeight - h - m))
    setPos({ top, left })
  }, [anchor, side])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onDismiss()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onDismiss()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onDismiss])
  return createPortal(
    <div ref={ref} className={className} style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  )
}

const CELL_NAME: Record<Anchor, string> = {
  tl: 'top left',
  tc: 'top centre',
  tr: 'top right',
  ml: 'middle left',
  mc: 'centre',
  mr: 'middle right',
  bl: 'bottom left',
  bc: 'bottom centre',
  br: 'bottom right',
}

/** Shows the current anchor; clicking it enters Shape Anchor mode so the point is picked on the canvas. */
function AnchorButton({ value }: { value: AnchorRef }) {
  const cells: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
  const free = typeof value !== 'string'
  return (
    <div className="anchor-row">
      <button
        className="anchor-btn"
        onClick={() => useStore.getState().setAnchorPicking(true)}
        aria-label={`Anchor: ${free ? 'free point' : CELL_NAME[value]}. Choose on canvas`}
        title="Choose anchor on canvas"
      >
        {free ? (
          <span className="anchor-btn__free" />
        ) : (
          cells.map((c) => <span key={c} className={'anchor-btn__dot' + (c === value ? ' is-active' : '')} />)
        )}
      </button>
      <span className="ss-label" style={{ padding: 0 }}>
        anchor
      </span>
    </div>
  )
}

const mIco = (children: ReactNode) => (
  <svg className="icon" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)
const MIcoSize = () => mIco(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />)
const MIcoHash = () => mIco(<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />)
const MIcoCorner = () => mIco(<path d="M5 20v-6a9 9 0 0 1 9-9h6" />)
const MIcoRotate = () => mIco(<><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 4v5h-5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>)

const kindLabel = (s: Shape) => {
  if (s.kind === 'template') return s.name
  if (s.kind === 'rect') return s.params?.r ? 'rounded rectangle' : 'rectangle'
  if (s.kind === 'slice') return '3d slice'
  if (s.kind === 'sketch') return 'sketch'
  return s.kind
}

// ---------- Design panel ----------
export function DesignPanel() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const tool = useStore((s) => s.tool)
  const dialog = useStore((s) => s.dialog)
  const [lock, setLock] = useState(false)
  // Mobile bottom sheet: active tab and collapsed state (CSS shows these only at <=700px).
  const [mtab, setMtab] = useState('size')
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => {
    const open = () => {
      if (useStore.getState().selection.length > 0) setSheetOpen(true)
    }
    window.addEventListener('ss:open-props-sheet', open)
    return () => window.removeEventListener('ss:open-props-sheet', open)
  }, [])
  const hasSel = selection.length > 0
  useEffect(() => {
    if (!hasSel) setSheetOpen(false)
  }, [hasSel])
  // The pivot for panel resize and rotate is the document's origin point (picked on the canvas).
  const anchor: AnchorRef = useStore((s) => s.doc.settings.originPoint ?? 'mc')
  const anchorPicking = useStore((s) => s.anchorPicking)
  const sel = selectedShapes({ doc, selection })
  // The Offset panel takes the right dock while it is open.
  if (mode !== 'design' || !sel.length || tool !== 'select' || dialog === 'offset' || anchorPicking) return null
  const units = doc.units
  const b = selectionBBox(sel)
  if (!b) return null
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const single = sel.length === 1 ? sel[0] : null
  const ids = sel.map((s) => s.id)
  const st = useStore.getState
  const allLocked = sel.every((s) => s.locked)

  const setW = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, Math.max(v, 0.01), lock ? (h * v) / (w || 1) : null, anchor))
  const setH = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, lock ? (w * v) / (h || 1) : null, Math.max(v, 0.01), anchor))

  const setParam = (key: string, v: number, c: boolean) => {
    if (!single || single.locked) return
    mut(c, () =>
      st().updateShapes([single.id], (s) => {
        const params = { ...s.params!, [key]: v }
        const contours = buildFromParams(s.kind, params)
        return contours ? { ...s, params, contours } : s
      }),
    )
  }

  const tpl = single?.kind === 'template' ? TEMPLATES.find((t) => t.id === single.params?.template) : undefined
  const group = single?.groupId ? doc.groups.find((g) => g.id === single.groupId) : undefined
  const pos = anchorPoint(b, anchor)
  const moveBy = (dx: number, dy: number, c: boolean) => mut(c, () => st().updateShapes(editableIds(ids), (s) => ({ ...s, x: s.x + dx, y: s.y + dy })))

  const tabs: { id: string; label: string; icon: ReactNode }[] = [{ id: 'size', label: 'Size', icon: <MIcoSize /> }]
  if (single?.kind === 'polygon') tabs.push({ id: 'sides', label: 'Sides', icon: <MIcoHash /> })
  if (single?.kind === 'rect') tabs.push({ id: 'radius', label: 'Radius', icon: <MIcoCorner /> })
  if (tpl) tabs.push({ id: 'params', label: 'Shape', icon: <MIcoHash /> })
  tabs.push({ id: 'rotation', label: 'Rotation', icon: <MIcoRotate /> })
  tabs.push({ id: 'more', label: 'Position and group', icon: <span className="sheet-tabs__dot" /> })
  const activeTab = tabs.some((t) => t.id === mtab) ? mtab : 'size'

  return (
    <div className={'right-dock' + (sheetOpen ? ' is-sheet-open' : '')}>
      <button
        className={'reference-btn' + (allLocked ? ' is-active' : '')}
        aria-pressed={allLocked}
        aria-label={allLocked ? 'Unlock reference path' : 'Lock as reference path'}
        title={allLocked ? 'Unlock' : 'Lock (reference path)'}
        onClick={() => {
          // Keep the selection so the button can flip back to Unlock.
          st().updateShapes(ids, (s) => ({ ...s, locked: !allLocked }))
        }}
      >
        {allLocked ? <Ic.IconLock size={20} /> : <Ic.IconUnlock size={20} />}
      </button>
      <div
        className="ss-panel design-panel"
        data-mtab={activeTab}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="ss-panel__header">
          <span>{single ? kindLabel(single) : `${sel.length} objects`}</span>
          <button className="sheet-collapse" aria-label="Collapse properties" onClick={() => setSheetOpen(false)}>
            <Ic.IconChevronDown size={16} />
          </button>
        </div>
        <div className="sheet-tabs" role="tablist" aria-label="Properties">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === activeTab} aria-label={t.label} className={'sheet-tabs__tab' + (t.id === activeTab ? ' is-active' : '')} onClick={() => setMtab(t.id)}>
              {t.icon}
              {t.id === 'size' && <span>SIZE</span>}
            </button>
          ))}
        </div>
        <Field label="size" tab="size">
          <div className="size-fields">
            <div className="size-fields__inputs">
              <NumField label="Width" adorn="W" value={w} units={units} onCommit={setW} />
              <NumField label="Height" adorn="H" value={h} units={units} onCommit={setH} />
            </div>
            <button
              className={'lock-ratio' + (lock ? ' is-active' : '')}
              aria-pressed={lock}
              aria-label="Lock aspect ratio"
              title="Lock aspect ratio"
              onClick={() => setLock(!lock)}
            >
              {lock ? <Ic.IconLink size={18} /> : <Ic.IconUnlink size={18} />}
            </button>
          </div>
        </Field>
        {single?.kind === 'rect' && <RadiusField key={single.id} shape={single} units={units} onCommit={(v, c) => setParam('r', Math.max(0, v), c)} />}
        {single?.kind === 'polygon' && (
          <Field label="sides" tab="sides">
            <NumField
              label="Sides"
              kind="count"
              adorn="N"
              suffix=""
              value={Number(single.params?.n ?? 6)}
              units={units}
              onCommit={(v, c) => setParam('n', Math.max(3, Math.min(64, Math.round(v))), c)}
            />
          </Field>
        )}
        {tpl &&
          tpl.params.map((p) => (
            <Field key={p.key} label={p.label} tab="params">
              <NumField
                label={p.label}
                kind={p.kind === 'length' ? 'length' : p.kind === 'angle' ? 'angle' : 'count'}
                suffix={p.kind === 'ratio' ? '×' : undefined}
                value={Number(single!.params?.[p.key] ?? p.default)}
                units={units}
                step={p.kind === 'ratio' ? 0.05 : undefined}
                onCommit={(v, c) => setParam(p.key, Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, p.kind === 'count' ? Math.round(v) : v)), c)}
              />
            </Field>
          ))}
        <Field label="rotation" tab="rotation">
          {/* Single: absolute angle. Multi: "—" placeholder and the typed value is applied as a delta. */}
          <NumField
            label="Rotation"
            kind="angle"
            adorn="A"
            value={single ? single.rotation : null}
            placeholder="—"
            units={units}
            step={1}
            onCommit={(v, c) => mut(c, () => rotateSelection(ids, v, anchor, !!single))}
          />
        </Field>
        {doc.settings.showPosition && (
          <Field label="position" tab="more">
            <div className="size-fields__inputs">
              <NumField label="Position X" adorn="X" value={pos.x} units={units} onCommit={(v, c) => moveBy(v - pos.x, 0, c)} />
              <NumField label="Position Y" adorn="Y" value={pos.y} units={units} onCommit={(v, c) => moveBy(0, v - pos.y, c)} />
            </div>
          </Field>
        )}
        <div data-tab="more" className="sheet-more">
          <AnchorButton value={anchor} />
        </div>
        {group && (
          <div className="group-info" data-tab="more">
            <div className="group-info__name">
              <Ic.IconLayers size={16} /> {group.name}
            </div>
            {single?.meta?.note && <div className="ss-muted">{single.meta.note}</div>}
            <button className="ss-btn ss-btn--sm ss-btn--block" onClick={() => st().selectGroup(group.id)}>
              Select Group
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RadiusField({ shape, units, onCommit }: { shape: Shape; units: Units; onCommit: (v: number, c: boolean) => void }) {
  const r = Number(shape.params?.r ?? 0)
  const [show, setShow] = useState(r > 0)
  if (!show)
    return (
      <button className="radius-add" data-tab="radius" onClick={() => setShow(true)} aria-label="Add radius">
        <span>radius</span>
        <Ic.IconPlus size={14} />
      </button>
    )
  return (
    <Field label="radius" tab="radius">
      <NumField label="Radius" adorn="R" value={r} units={units} onCommit={onCommit} />
    </Field>
  )
}

// ---------- Plan panel ----------
export const CUT_TYPES: { id: CutType; label: string; icon: ReactNode }[] = [
  { id: 'online', label: 'On Line', icon: <Ic.IconCutOnline size={18} /> },
  { id: 'guide', label: 'Guide', icon: <Ic.IconCutGuide size={18} /> },
  { id: 'inside', label: 'Inside', icon: <Ic.IconCutInside size={18} /> },
  { id: 'pocket', label: 'Pocket', icon: <Ic.IconCutPocket size={18} /> },
  { id: 'outside', label: 'Outside', icon: <Ic.IconCutOutside size={18} /> },
]

// Studio's preset glyphs: fractions for inch, the engraving bit for the 0.5 mm preset.
const BIT_PRESETS: Record<Units, { label: string; mm: number; icon?: ReactNode }[]> = {
  in: [
    { label: '0.02', mm: 0.508, icon: <Ic.IconBit size={20} /> },
    { label: '⅛', mm: 3.175, icon: <Ic.IconBitEighth size={20} /> },
    { label: '¼', mm: 6.35, icon: <Ic.IconBitQuarter size={20} /> },
    { label: '½', mm: 12.7, icon: <Ic.IconBitHalf size={20} /> },
  ],
  mm: [
    { label: '0.5', mm: 0.5, icon: <Ic.IconBitEngraveMm size={20} /> },
    { label: '3', mm: 3 },
    { label: '6', mm: 6 },
    { label: '8', mm: 8 },
  ],
}

export function PlanPanel() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const [open, setOpen] = useState(false)
  const [bitsOpen, setBitsOpen] = useState(false)
  const [typeBtn, setTypeBtn] = useState<HTMLButtonElement | null>(null)
  const dismissType = () => setOpen(false)
  const sel = selectedShapes({ doc, selection })
  if (mode !== 'plan' || !sel.length) return null
  const units = doc.units
  const ids = sel.map((s) => s.id)
  const st = useStore.getState
  const first = sel[0]
  const same = <K extends keyof Shape['cut']>(k: K) => (sel.every((s) => s.cut[k] === first.cut[k]) ? first.cut[k] : null)
  const type = same('type') as CutType | null
  const depth = same('depth') as number | null
  const offset = same('offset') as number | null
  const bit = same('bitDia') as number | null
  const allOpen = sel.every((s) => s.contours.every((c) => !c.closed))
  const types = allOpen ? CUT_TYPES.filter((t) => t.id === 'online' || t.id === 'guide') : CUT_TYPES
  const cur = CUT_TYPES.find((t) => t.id === type)
  const step = units === 'in' ? MM_PER_IN / 16 : 0.5
  const bitInfo = bit != null ? BITS.find((b) => Math.abs(b.diameter - bit) < 0.01) : undefined
  const tooDeep = depth != null && bitInfo != null && depth > bitInfo.fluteLength + 1e-6

  // Open paths cannot be inside/outside/pocket: those shapes fall back to on-line.
  const pickType = (t: CutType) => {
    st().updateShapes(ids, (s) => {
      const isOpen = s.contours.every((c) => !c.closed)
      const next = isOpen && t !== 'online' && t !== 'guide' ? 'online' : t
      return { ...s, cut: { ...s.cut, type: next } }
    })
    setOpen(false)
  }

  return (
    <div className="right-dock">
      <div className="ss-panel plan-panel" onPointerDown={(e) => e.stopPropagation()}>
        <Field label="cut type">
          <div className="cut-type-select">
            <button
              ref={setTypeBtn}
              className={'cut-type-select__btn' + (open ? ' is-open' : '')}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Cut type: ${cur?.label ?? 'mixed'}`}
              onClick={() => setOpen(!open)}
            >
              {cur?.icon ?? <Ic.IconCutMixed size={18} />}
              <span>{cur?.label ?? 'mixed'}</span>
              <Ic.IconChevronDown size={16} className={'icon cut-type-select__chev' + (open ? ' is-open' : '')} />
            </button>
            {open && typeBtn && (
              <Floating anchor={typeBtn} side="left" className="cut-type-menu" onDismiss={dismissType}>
                {types.map((t) => (
                  <button key={t.id} className={'cut-type-menu__item' + (t.id === type ? ' is-active' : '')} aria-current={t.id === type} onClick={() => pickType(t.id)}>
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                ))}
              </Floating>
            )}
          </div>
        </Field>
        {type !== 'guide' && (
          <>
            <Field label="depth">
              <div className="stepper">
                <button
                  aria-label="Decrease depth"
                  onClick={() =>
                    // Step each shape on its own, so a mixed selection keeps its differences; unset stays unset.
                    st().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, depth: s.cut.depth == null ? null : Math.max(0, s.cut.depth - step) || null } }))
                  }
                >
                  −
                </button>
                <NumField
                  label="Depth"
                  value={depth}
                  units={units}
                  step={step}
                  placeholder={sel.some((x) => x.cut.depth !== first.cut.depth) ? 'mixed' : 'unset'}
                  suffix=""
                  onCommit={(v, c) => mut(c, () => st().setCut(ids, { depth: v > 0 ? v : null }))}
                  className="stepper__input"
                />
                <button
                  aria-label="Increase depth"
                  onClick={() => st().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, depth: (s.cut.depth ?? 0) + step } }))}
                >
                  +
                </button>
              </div>
              {tooDeep && bitInfo && (
                <div className="plan-warn">
                  Deeper than the {bitInfo.name} flute ({fmtLenValue(bitInfo.fluteLength, units)} {units}).
                </div>
              )}
            </Field>
            <Field label="offset">
              <div className="offset-field">
                <button
                  className="offset-field__flip"
                  aria-label="Flip offset direction"
                  title="Flip offset direction"
                  disabled={!offset}
                  onClick={() => st().setCut(ids, { offset: -(offset ?? 0) })}
                >
                  <Ic.IconFlipOffset size={16} />
                </button>
                <NumField label="Offset" value={offset} units={units} onCommit={(v, c) => mut(c, () => st().setCut(ids, { offset: v }))} />
              </div>
            </Field>
            <Field label="bit diameter">
              <NumField label="Bit diameter" adorn="D" value={bit} units={units} onCommit={(v, c) => v > 0 && mut(c, () => st().setCut(ids, { bitDia: v }))} />
            </Field>
            <div className="bit-presets">
              <button className={'bit-presets__lib' + (bitsOpen ? ' is-active' : '')} aria-label="Bit library" aria-expanded={bitsOpen} title="Bit library" onClick={() => setBitsOpen(!bitsOpen)}>
                <Ic.IconBitLibrary size={20} />
              </button>
              {BIT_PRESETS[units].map((p) => (
                <button
                  key={p.label}
                  aria-label={`Bit diameter ${p.label}`}
                  aria-pressed={bit != null && Math.abs(bit - p.mm) < 0.01}
                  className={'bit-presets__btn' + (bit != null && Math.abs(bit - p.mm) < 0.01 ? ' is-active' : '')}
                  onClick={() => st().setCut(ids, { bitDia: p.mm })}
                >
                  {p.icon ?? p.label}
                </button>
              ))}
            </div>
            {bitsOpen && (
              <div className="bit-lib">
                {BITS.map((b) => (
                  <button
                    key={b.id}
                    className={'bit-lib__item' + (bit != null && Math.abs(bit - b.diameter) < 0.01 ? ' is-active' : '')}
                    onClick={() => {
                      st().setCut(ids, { bitDia: b.diameter })
                      setBitsOpen(false)
                    }}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {sel.length === 1 && first.meta?.note && <div className="plan-note">{first.meta.note}</div>}
      </div>
    </div>
  )
}

// ---------- Groups (imported 3D / paper / SVG sets) ----------
const ROLE_LABEL: Record<'contour' | 'toolpath' | 'pocket', string> = { contour: 'contours', toolpath: 'toolpaths', pocket: 'pockets' }

/** Lists doc.groups with a visibility eye per group, and per-role switches for 3D groups. */
export function GroupsPanel() {
  const doc = useStore((s) => s.doc)
  const mode = useStore((s) => s.mode)
  const dialog = useStore((s) => s.dialog)
  const [collapsed, setCollapsed] = useState(false)
  if ((mode !== 'design' && mode !== 'plan') || !doc.groups.length || dialog === 'carve3d' || dialog === 'trace') return null
  const st = useStore.getState
  return (
    <section className="groups-card" aria-label="Groups">
      <button className="groups-card__head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        <Ic.IconLayers size={16} />
        <span>groups</span>
        <span className="groups-card__count">{doc.groups.length}</span>
        <Ic.IconChevronDown size={16} className={'icon' + (collapsed ? ' is-collapsed' : '')} />
      </button>
      {!collapsed && (
        <div className="groups-card__list">
          {doc.groups.map((g: Group) => {
            const members = doc.shapes.filter((s) => s.groupId === g.id)
            const ids = members.map((s) => s.id)
            const hidden = members.length > 0 && members.every((s) => s.hidden)
            const roles = (['contour', 'toolpath', 'pocket'] as const).filter((r) => members.some((s) => s.meta?.role === r))
            const info = Object.entries(g.info ?? {}).slice(0, 4)
            return (
              <div key={g.id} className="groups-card__group">
                <div className="groups-card__row">
                  <span className="groups-card__name" title={g.name}>
                    {g.name}
                  </span>
                  <button
                    className="groups-card__eye"
                    aria-pressed={!hidden}
                    aria-label={`${hidden ? 'Show' : 'Hide'} group ${g.name}`}
                    title={hidden ? 'Show group' : 'Hide group'}
                    onClick={() => {
                      st().updateShapes(ids, (s) => ({ ...s, hidden: !hidden }))
                      // Hidden shapes leave the selection so nothing edits them invisibly.
                      if (!hidden) st().select(st().selection.filter((i) => !ids.includes(i)))
                    }}
                  >
                    {hidden ? <Ic.IconEyeOff size={18} /> : <Ic.IconEye size={18} />}
                  </button>
                </div>
                {g.source === '3d' &&
                  roles.map((r) => {
                    const rs = members.filter((s) => s.meta?.role === r).map((s) => s.id)
                    const on = members.some((s) => s.meta?.role === r && !s.hidden)
                    return (
                      <button
                        key={r}
                        role="switch"
                        aria-checked={on}
                        className="groups-card__role"
                        onClick={() => {
                          st().updateShapes(rs, (s) => ({ ...s, hidden: on }))
                          if (on) st().select(st().selection.filter((i) => !rs.includes(i)))
                        }}
                      >
                        <span>{ROLE_LABEL[r]}</span>
                        <span className={'ss-switch ss-switch--sm' + (on ? ' is-on' : '')} aria-hidden="true" />
                      </button>
                    )
                  })}
                {info.length > 0 && (
                  <dl className="groups-card__info">
                    {info.map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
