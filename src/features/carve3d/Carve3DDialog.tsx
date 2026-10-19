// Full-screen "3D Carve" dialog: load a model, pick a bit, preview layers, add toolpaths to the design.
// Multi-side mode (the flip): the block is carved from several of its six faces, each in process
// stages (rough → detail → engrave), with bridges holding the part in the block between flips.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Group, ImportPayload, Units } from '../../model/types'
import { fmtLen, fromUnits, toUnits } from '../../model/factory'
import { IconCube, IconClose, IconLink, IconUnlink, IconPause, IconPlay, IconRestart } from '../../ui/icons'
import { NumField } from '../../editor/Panels'
import BitGallery from './BitGallery'
import { BITS, coneHeight, defaultBit, type Bit } from './bits'
import { buildCarvePlan, carveDepth, CarveCancelled, layerCount, type CarvePlan, type TabSettings } from './carvePlan'
import { MODEL_ACCEPT, defaultsFor, orientedSize, placeModel, readModelFile, type ModelUnit, type UpAxis, type Vec3 } from './loadModel'
import { carvedSurface, type CarvedSurface } from './finishedSurface'
import { Field, NumInput } from './fields'
import MultiSidePanel from './MultiSidePanel'
import { autoStageBits, STAGE_LABEL, type MultiSidePlan, type StageBits } from './multiSide'
import { createMultiSideClient, type AnalysisMap, type MultiSideClient } from './multiSideClient'
import { SIDE_ORDER, type SideId } from './sideAnalysis'
import Viewer3D, { type AnimState, type CarveView, type LayerOutline } from './Viewer3D'
import './carve3d.css'

export interface Carve3DDialogProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

export default function Carve3DDialog({ units, onClose, onImport }: Carve3DDialogProps) {
  // ---- model -------------------------------------------------------------
  const [file, setFile] = useState<File | null>(null)
  const [modelRev, setModelRev] = useState(0)
  const [raw, setRaw] = useState<Float32Array | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [modelUnit, setModelUnit] = useState<ModelUnit>('mm')
  const [up, setUp] = useState<UpAxis>('z')
  /** Target model size in mm (W = x, L = y, H = z). null = the file's natural size. */
  const [sizeMm, setSizeMm] = useState<Vec3 | null>(null)
  const [lockRatio, setLockRatio] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Only the newest load may update state (a slow earlier load must not overwrite a newer one). */
  const loadSeq = useRef(0)

  // ---- bit & carve settings (stored in mm) -------------------------------
  const [bitId, setBitId] = useState(() => defaultBit().id)
  const [stepOverride, setStepOverride] = useState<number | null>(null)
  const [stockOverride, setStockOverride] = useState<number | null>(null)
  const [marginMm, setMarginMm] = useState(5)
  const [throughCut, setThroughCut] = useState(true)
  const [outputs, setOutputs] = useState({ contour: true, toolpath: true, pocket: true })
  const [tabs, setTabs] = useState<TabSettings>({ count: 0, width: 5, height: 1 })

  // ---- results -----------------------------------------------------------
  const [plan, setPlan] = useState<CarvePlan | null>(null)
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [planError, setPlanError] = useState<string | null>(null)
  const [surface, setSurface] = useState<CarvedSurface | null>(null)
  const [show, setShow] = useState<CarveView>({ carved: true, model: false, layers: false, dims: true })
  const [anim, setAnim] = useState<AnimState>({ on: false, playing: false, speed: 10, run: 0 })
  const [animProgress, setAnimProgress] = useState(0)

  // ---- multi-side (the flip) ----------------------------------------------
  const [mode, setMode] = useState<'top' | 'multi'>('top')
  const [msSides, setMsSides] = useState<SideId[]>([])
  const [msBits, setMsBits] = useState<StageBits>(() => autoStageBits())
  const [msAllowance, setMsAllowance] = useState(1)
  const [msEngraveDepth, setMsEngraveDepth] = useState(1.5)
  const [msBridges, setMsBridges] = useState<TabSettings>({ count: 2, width: 5, height: 1 })
  const [msPlan, setMsPlan] = useState<MultiSidePlan | null>(null)
  /** Which side + stage the 3D preview shows. */
  const [msSel, setMsSel] = useState<{ side: SideId | null; stage: number }>({ side: null, stage: 0 })

  const bit: Bit = BITS.find((b) => b.id === bitId) ?? defaultBit()
  const toU = (mm: number) => toUnits(mm, units)
  const fromU = (v: number) => fromUnits(v, units)
  const L = (mm: number) => fmtLen(mm, units)
  const dec = units === 'in' ? 3 : 2

  const natural = useMemo(() => (raw ? orientedSize(raw, modelUnit, up) : null), [raw, modelUnit, up])
  const placed = useMemo(() => (raw ? placeModel(raw, modelUnit, up, sizeMm) : null), [raw, modelUnit, up, sizeMm])

  /** Layer count drives the step-down: the carve depth split into n equal layers. */
  function setLayers(v: number) {
    const n = Math.max(1, Math.min(500, Math.round(v)))
    if (depth > 0) setStepOverride(depth / n)
  }

  /** Set one extent. With the aspect lock on, the other two scale by the same factor. */
  function setDim(axis: keyof Vec3, v: number) {
    const cur = sizeMm ?? natural
    if (!cur || !(v > 0)) return
    const target = Math.max(v, 0.01)
    if (lockRatio && cur[axis] > 0) {
      const k = target / cur[axis]
      setSizeMm({ x: cur.x * k, y: cur.y * k, z: cur.z * k })
    } else {
      setSizeMm({ ...cur, [axis]: target })
    }
  }
  const H = placed?.size.z ?? 0
  const stepMm = stepOverride ?? Math.min(bit.fluteLength, 2)
  const stockMm = stockOverride ?? H
  const depth = carveDepth(H, stockMm) // what is actually cut
  const layerN = layerCount(depth, stepMm)
  const reachMm = Math.max(bit.diameter / 2, (bit.shankDiameter ?? bit.diameter) / 2)
  /** The margin the plan really uses (raised to the bit's reach + 1 mm). */
  const effMargin = Math.max(marginMm, reachMm + 1)
  const stockSize = useMemo(
    () => (placed ? { x: placed.size.x + 2 * effMargin, y: placed.size.y + 2 * effMargin, z: Math.max(stockMm, 0.01) } : null),
    [placed, effMargin, stockMm],
  )

  // ---- multi-side analysis & planning -------------------------------------
  // The planner (grid analysis, mesh slicing, clipper booleans) runs in a worker so the page
  // never blocks; see multiSideClient. One run at a time — a new run cancels the old one.

  /** Which faces of the block have claimed work, from the last analysis. */
  const [analysis, setAnalysis] = useState<AnalysisMap | null>(null)

  const msKey = [
    file?.name ?? '',
    modelRev,
    modelUnit,
    up,
    sizeMm ? `${sizeMm.x.toFixed(6)}:${sizeMm.y.toFixed(6)}:${sizeMm.z.toFixed(6)}` : 'natural',
    msSides.join(','),
    msBits.rough ?? '',
    msBits.detail ?? '',
    msBits.engrave ?? '',
    msAllowance.toFixed(6),
    msEngraveDepth.toFixed(6),
    stepMm.toFixed(6),
    marginMm.toFixed(6),
    stockMm.toFixed(6),
    msBridges.count,
    msBridges.width.toFixed(6),
    msBridges.height.toFixed(6),
    outputs.contour ? 1 : 0,
    outputs.toolpath ? 1 : 0,
    outputs.pocket ? 1 : 0,
    units,
  ].join('|')
  const msCurrent = !!msPlan && msPlan.key === msKey

  // Build the multi-sided plan (all enabled sides × all stages) whenever its inputs change,
  // off the main thread. Chip auto-selection runs once per placed model so user toggles stick.
  const clientRef = useRef<MultiSideClient | null>(null)
  const placedRef = useRef(placed)
  useEffect(() => {
    placedRef.current = placed
  })
  const chipDefaultsFor = useRef<Float32Array | null>(null)
  const getClient = () => {
    if (!clientRef.current) {
      clientRef.current = createMultiSideClient({
        onAnalysis: (a) => {
          setAnalysis(a)
          const pos = placedRef.current?.positions ?? null
          if (pos && chipDefaultsFor.current !== pos) {
            chipDefaultsFor.current = pos
            setMsSides(SIDE_ORDER.filter((s) => a[s].needed))
          }
        },
        onPlan: (p) => {
          setMsPlan(p)
          setComputing(false)
        },
        onProgress: (f) => setProgress(f),
        onError: (message) => {
          setMsPlan(null)
          setPlanError(message)
          setComputing(false)
        },
      })
    }
    return clientRef.current
  }
  useEffect(
    () => () => {
      clientRef.current?.dispose()
      clientRef.current = null
    },
    [],
  )

  useEffect(() => {
    if (mode !== 'multi' || !placed) {
      clientRef.current?.cancel()
      return
    }
    if (!msSides.length) {
      // Every face switched off: still analyse, so the chips light up for a new model.
      setMsPlan(null)
      setComputing(false)
      getClient().run(placed, null)
      return
    }
    setComputing(true)
    setProgress(0)
    setPlanError(null)
    // Debounce so a burst of settings edits plans once.
    const timer = window.setTimeout(() => {
      getClient().run(placed, {
        sides: msSides,
        bits: msBits,
        finishAllowance: msAllowance,
        engraveDepth: msEngraveDepth,
        stepDown: stepMm,
        margin: marginMm,
        stockThickness: stockMm,
        bridges: msBridges,
        outputs,
        units,
        key: msKey,
      })
    }, 250)
    return () => window.clearTimeout(timer)
    // The key captures every input; the closure reads the current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, msKey, mode])

  // Keep the preview selection inside the plan.
  useEffect(() => {
    if (!msPlan) return
    const cur = msPlan.sides.find((s) => s.side === msSel.side)
    if (!cur || msSel.stage >= cur.plans.length) setMsSel({ side: msPlan.sides[0]?.side ?? null, stage: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msPlan])

  /** Everything the plan depends on. A plan is only valid while its key matches this string. */
  const settingsKey = [
    file?.name ?? '',
    modelRev,
    modelUnit,
    up,
    sizeMm ? `${sizeMm.x.toFixed(6)}:${sizeMm.y.toFixed(6)}:${sizeMm.z.toFixed(6)}` : 'natural',
    bit.id,
    stepMm.toFixed(6),
    stockMm.toFixed(6),
    marginMm.toFixed(6),
    throughCut ? 1 : 0,
    outputs.contour ? 1 : 0,
    outputs.toolpath ? 1 : 0,
    outputs.pocket ? 1 : 0,
    tabs.count,
    tabs.width.toFixed(6),
    tabs.height.toFixed(6),
  ].join('|')
  const planCurrent = !!plan && plan.key === settingsKey

  /** What the viewer shows: the selected side's stage plan in multi mode, the plan otherwise. */
  const selSide = mode === 'multi' && msPlan ? msPlan.sides.find((s) => s.side === msSel.side) ?? msPlan.sides[0] ?? null : null
  const selStage = selSide ? Math.min(Math.max(0, msSel.stage), selSide.plans.length - 1) : 0
  const activePlan = mode === 'multi' ? (selSide?.plans[selStage] ?? null) : planCurrent ? plan : null
  const activePlaced = mode === 'multi' && selSide ? selSide.placed : placed
  const activeStockSize = useMemo(() => {
    if (!activePlaced) return null
    if (mode === 'multi' && selSide) {
      const vertical = selSide.side === 'top' || selSide.side === 'bottom'
      return {
        x: selSide.placed.size.x + 2 * effMargin,
        y: selSide.placed.size.y + 2 * effMargin,
        z: vertical ? Math.max(stockMm, 0.01) : selSide.placed.size.z + 2 * effMargin,
      }
    }
    return stockSize
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlaced, mode, selSide, effMargin, stockMm, stockSize])

  // Re-run the (slow) carve plan after any relevant change, debounced. Each change aborts the
  // previous run; a settings change that leaves nothing to cut clears the plan and the spinner.
  useEffect(() => {
    if (mode !== 'top' || !placed || !(stepMm > 0) || !(depth > 0)) {
      if (mode !== 'top') return
      setPlan(null)
      setComputing(false)
      setPlanError(null)
      return
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      setComputing(true)
      setProgress(0)
      setPlanError(null)
      buildCarvePlan(
        placed.positions,
        placed.size.z,
        {
          bit,
          stepDown: stepMm,
          stockThickness: stockMm,
          margin: marginMm,
          throughCut,
          tabs,
          outputs,
          units,
          key: settingsKey,
        },
        (f) => {
          if (!ctrl.signal.aborted) setProgress(f)
        },
        ctrl.signal,
      )
        .then((p) => {
          if (ctrl.signal.aborted) return
          setPlan(p)
          setComputing(false)
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted || e instanceof CarveCancelled) return
          setPlan(null)
          setPlanError(e instanceof Error ? e.message : String(e))
          setComputing(false)
        })
    }, 250)
    return () => {
      ctrl.abort()
      window.clearTimeout(timer)
    }
    // The settings key captures every input of the plan; the closure reads the current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, settingsKey, depth, mode])

  // The finished surface follows the plan the viewer shows. It is the slow part of the preview
  // after the plan itself, so it runs async and a newer plan aborts it; the old surface stays up.
  const [carving, setCarving] = useState(false)
  useEffect(() => {
    if (!activePlan) {
      setSurface(null)
      return
    }
    const ctrl = new AbortController()
    setCarving(true)
    carvedSurface(activePlan, activePlan.bit, ctrl.signal)
      .then((s) => {
        if (ctrl.signal.aborted) return
        setSurface(s)
        setCarving(false)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || e instanceof CarveCancelled) return
        setSurface(null)
        setCarving(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlan])

  // Escape closes the dialog, but not while a text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const outlines: LayerOutline[] = useMemo(
    () => (activePlan && activePlaced ? activePlan.layers.map((l) => ({ z: activePlaced.size.z - l.depth, guide: l.guide, toolpath: l.toolpath })) : []),
    [activePlan, activePlaced],
  )

  async function loadFile(f: File) {
    const seq = ++loadSeq.current
    setError(null)
    setLoading(true)
    try {
      const positions = await readModelFile(f)
      if (seq !== loadSeq.current) return
      const d = defaultsFor(f.name)
      setRaw(positions)
      setFile(f)
      setModelUnit(d.unit)
      setUp(d.up)
      setStockOverride(null)
      setSizeMm(null)
      setPlan(null)
      setModelRev((r) => r + 1)
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  function resetModel() {
    loadSeq.current++
    setRaw(null)
    setFile(null)
    setPlan(null)
    setPlanError(null)
    setError(null)
    setLoading(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) void loadFile(f)
  }

  function add() {
    const baseName = file ? file.name.replace(/\.[^.]+$/, '') : ''
    if (mode === 'multi') {
      if (!msPlan || !file || !msCurrent || msPlan.shapes.length === 0) return
      const n = msPlan.sides.length
      const group: Omit<Group, 'id'> = {
        name: `3D Carve – ${baseName} – ${n} side${n === 1 ? '' : 's'}`,
        source: '3d',
        info: msPlan.info,
      }
      onImport({ group, shapes: msPlan.shapes })
      onClose()
      return
    }
    if (!plan || !file || !planCurrent || plan.shapes.length === 0) return
    const group: Omit<Group, 'id'> = { name: `3D Carve – ${baseName}`, source: '3d', info: plan.info }
    onImport({ group, shapes: plan.shapes })
    onClose()
  }

  const baseName = file ? file.name.replace(/\.[^.]+$/, '') : ''
  const warnStep = stepMm > bit.fluteLength
  const warnDepth = depth > bit.fluteLength
  const coneH = coneHeight(bit)
  const N = plan ? plan.layers.length : layerN
  const N2 = String(Math.max(N, 1)).length
  const cutOrder = N > 0 ? `Cut layers in order 1 → ${N} (shallow first)` : ''

  return (
    <div className="ss-dialog c3d-dialog" role="dialog" aria-label="3D Carve">
      <div className="ss-dialog__header">
        <IconCube />
        3D Carve
      </div>

      <div className="ss-dialog__body">
        <div className="ss-dialog__main">
          {activePlaced && activeStockSize ? (
            <>
              <Viewer3D
                positions={activePlaced.positions}
                modelSize={activePlaced.size}
                stockSize={activeStockSize}
                outlines={outlines}
                surface={surface}
                show={show}
                plan={activePlan}
                anim={anim}
                onAnimProgress={setAnimProgress}
                onAnimComplete={() => setAnim((a) => ({ ...a, playing: false }))}
                dimLabels={{ x: `W ${L(activePlaced.size.x)}`, y: `L ${L(activePlaced.size.y)}`, z: `H ${L(activePlaced.size.z)}` }}
              />
              <div className="c3d-overlay">
                <span className="ss-badge">{baseName}</span>
                <span className="ss-muted">
                  {L(activePlaced.size.x)} × {L(activePlaced.size.y)} × {L(activePlaced.size.z)}
                </span>
                {mode === 'multi' && selSide && (
                  <span className="ss-badge">
                    {selSide.label} · {STAGE_LABEL[selSide.stages[selStage]?.role ?? 'detail']}
                    {selSide.freeing ? ' · bridges' : ''}
                  </span>
                )}
                <div className="ss-seg c3d-viewtoggle" role="group" aria-label="3D view">
                  {(
                    [
                      ['carved', 'Carved'],
                      ['model', 'Model'],
                      ['layers', 'Layers'],
                      ['dims', 'Dims'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={show[key]}
                      onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(computing || carving) && show.carved && surface && <span className="ss-muted c3d-updating">updating…</span>}
              </div>
              <div className="c3d-animbar">
                {anim.on ? (
                  <>
                    <button
                      type="button"
                      className="ss-btn-round c3d-animbar__btn"
                      aria-label={anim.playing ? 'Pause' : 'Play'}
                      onClick={() => {
                        // Play after the end starts a fresh run.
                        if (!anim.playing && animProgress >= 1) setAnimProgress(0)
                        setAnim((a) => ({ ...a, playing: !a.playing, run: !a.playing && animProgress >= 1 ? a.run + 1 : a.run }))
                      }}
                    >
                      {anim.playing ? <IconPause size={16} /> : <IconPlay size={16} />}
                    </button>
                    <button
                      type="button"
                      className="ss-btn-round c3d-animbar__btn"
                      aria-label="Restart"
                      onClick={() => {
                        setAnimProgress(0)
                        setAnim((a) => ({ ...a, playing: true, run: a.run + 1 }))
                      }}
                    >
                      <IconRestart size={16} />
                    </button>
                    <div className="c3d-animbar__track" aria-label="cut progress">
                      <span style={{ width: `${Math.round(animProgress * 100)}%` }} />
                    </div>
                    <div className="ss-seg" role="group" aria-label="animation speed">
                      {[1, 10, 50, 200].map((x) => (
                        <button key={x} type="button" aria-pressed={anim.speed === x} onClick={() => setAnim((a) => ({ ...a, speed: x }))}>
                          {x}×
                        </button>
                      ))}
                    </div>
                    <button type="button" className="ss-btn ss-btn--sm" onClick={() => setAnim((a) => ({ ...a, on: false, playing: false }))}>
                      Done
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ss-btn ss-btn--sm"
                    disabled={!activePlan || activePlan.layers.length === 0}
                    onClick={() => {
                      setAnimProgress(0)
                      setAnim((a) => ({ ...a, on: true, playing: true, run: a.run + 1 }))
                    }}
                  >
                    <IconPlay size={14} /> Animate cut
                  </button>
                )}
              </div>
            </>
          ) : (
            <div
              className={`ss-dropzone c3d-drop${dragOver ? ' is-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={MODEL_ACCEPT}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void loadFile(f)
                  e.target.value = ''
                }}
              />
              <strong>{loading ? 'Loading model…' : 'Drop a 3D model here'}</strong>
              <span className="ss-muted">STL (binary or ASCII), OBJ, GLB or GLTF. Click to choose a file.</span>
              {error && <span className="c3d-error">{error}</span>}
            </div>
          )}
        </div>

        <aside className="ss-dialog__side c3d-side">
          {placed && (
            <div className="c3d-section">
              <div className="ss-section-title">model</div>
              <Field label="model units">
                <select className="ss-select" value={modelUnit} onChange={(e) => {
                    setModelUnit(e.target.value as ModelUnit)
                    setSizeMm(null)
                  }}>
                  <option value="mm">millimetres (mm)</option>
                  <option value="cm">centimetres (cm)</option>
                  <option value="in">inches (in)</option>
                  <option value="m">metres (m)</option>
                </select>
              </Field>
              <Field label="up axis">
                <select className="ss-select" value={up} onChange={(e) => {
                    setUp(e.target.value as UpAxis)
                    setSizeMm(null)
                  }}>
                  <option value="z">Z up</option>
                  <option value="y">Y up</option>
                  <option value="-y">-Y up</option>
                  <option value="x">X up</option>
                </select>
              </Field>
              <Field label="size">
                <div className="size-fields">
                  <div className="size-fields__inputs">
                    <NumField label="Width" adorn="W" value={placed.size.x} units={units} onCommit={(v) => setDim('x', v)} />
                    <NumField label="Length" adorn="L" value={placed.size.y} units={units} onCommit={(v) => setDim('y', v)} />
                    <NumField label="Height" adorn="H" value={placed.size.z} units={units} onCommit={(v) => setDim('z', v)} />
                  </div>
                  <button
                    type="button"
                    className={'lock-ratio' + (lockRatio ? ' is-active' : '')}
                    aria-pressed={lockRatio}
                    aria-label="Lock aspect ratio"
                    title="Lock aspect ratio"
                    onClick={() => setLockRatio(!lockRatio)}
                  >
                    {lockRatio ? <IconLink size={18} /> : <IconUnlink size={18} />}
                  </button>
                </div>
              </Field>
              <div className="c3d-row c3d-row--between">
                {sizeMm ? (
                  <button type="button" className="ss-btn ss-btn--sm" onClick={() => setSizeMm(null)}>
                    Original Size
                  </button>
                ) : (
                  <span className="ss-muted">original size</span>
                )}
                <button type="button" className="ss-btn ss-btn--sm" onClick={resetModel}>
                  Other File
                </button>
              </div>
              {error && <span className="c3d-error">{error}</span>}
            </div>
          )}

          {placed && (
            <div className="c3d-section">
              <div className="ss-section-title">strategy</div>
              <div className="ss-seg" role="group" aria-label="carving strategy">
                <button type="button" aria-pressed={mode === 'top'} onClick={() => setMode('top')}>
                  Top only
                </button>
                <button type="button" aria-pressed={mode === 'multi'} onClick={() => setMode('multi')}>
                  Multi-side (flip)
                </button>
              </div>
              {mode === 'multi' && (
                <span className="ss-muted">Carve the block from several of its faces and flip it between sides. Bridges keep the part seated in the block.</span>
              )}
            </div>
          )}

          {mode === 'top' && <BitGallery selectedId={bit.id} onSelect={setBitId} stepDown={stepMm} units={units} />}

          {mode === 'top' && placed && (
            <div className="c3d-section">
              <div className="ss-section-title">carving</div>
              <Field label="stock thickness">
                <NumInput value={toU(stockMm)} onChange={(v) => setStockOverride(fromU(v))} decimals={dec} suffix={units} ariaLabel="stock thickness" />
              </Field>
              <div className="c3d-two">
                <Field label="step-down">
                  <NumInput
                    value={toU(stepMm)}
                    onChange={(v) => v > 0 && setStepOverride(fromU(v))}
                    decimals={dec}
                    suffix={units}
                    ariaLabel="step-down"
                  />
                </Field>
                <Field label="layers">
                  <div className="stepper">
                    <button type="button" aria-label="Fewer layers" disabled={layerN <= 1} onClick={() => setLayers(layerN - 1)}>
                      −
                    </button>
                    <NumField
                      label="Layers"
                      kind="count"
                      suffix=""
                      value={layerN}
                      units={units}
                      onCommit={(v) => setLayers(v)}
                      className="stepper__input"
                    />
                    <button type="button" aria-label="More layers" onClick={() => setLayers(layerN + 1)}>
                      +
                    </button>
                  </div>
                </Field>
              </div>
              <Field label="margin">
                <NumInput value={toU(marginMm)} onChange={(v) => setMarginMm(fromU(v))} decimals={dec} suffix={units} ariaLabel="margin" />
              </Field>
              {warnStep && (
                <div className="c3d-warn">
                  Step-down {L(stepMm)} is deeper than the flute length ({L(bit.fluteLength)}).
                </div>
              )}
              {warnDepth && (
                <div className="c3d-warn">
                  Cut depth {L(depth)} is deeper than the flute length ({L(bit.fluteLength)}).
                </div>
              )}
              {bit.type === 'vbit' && depth > coneH && (
                <div className="c3d-warn">
                  Below {L(coneH)} this V-bit is at full Ø and cuts a flat-bottomed groove.
                </div>
              )}

              <label className="ss-check">
                <input type="checkbox" checked={throughCut} onChange={(e) => setThroughCut(e.target.checked)} />
                include through-cut outline
              </label>
              {throughCut && (
                <div className="c3d-three">
                  <Field label="tabs">
                    <NumInput
                      value={tabs.count}
                      decimals={0}
                      onChange={(v) => setTabs({ ...tabs, count: Math.max(0, Math.round(v)) })}
                      ariaLabel="tab count"
                    />
                  </Field>
                  <Field label="tab width">
                    <NumInput
                      value={toU(tabs.width)}
                      decimals={dec}
                      suffix={units}
                      onChange={(v) => setTabs({ ...tabs, width: fromU(v) })}
                      ariaLabel="tab width"
                    />
                  </Field>
                  <Field label="tab height">
                    <NumInput
                      value={toU(tabs.height)}
                      decimals={dec}
                      suffix={units}
                      onChange={(v) => setTabs({ ...tabs, height: fromU(v) })}
                      ariaLabel="tab height"
                    />
                  </Field>
                </div>
              )}

            </div>
          )}

          {mode === 'multi' && placed && (
            <MultiSidePanel
              units={units}
              analysis={analysis}
              enabled={msSides}
              onToggleSide={(s) => setMsSides((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
              bits={msBits}
              onBits={setMsBits}
              allowance={msAllowance}
              engraveDepth={msEngraveDepth}
              stepDown={stepMm}
              marginMm={marginMm}
              onMargin={setMarginMm}
              onAllowance={setMsAllowance}
              onEngraveDepth={setMsEngraveDepth}
              bridges={msBridges}
              onBridges={setMsBridges}
              plan={msPlan}
              planCurrent={msCurrent}
              computing={computing}
              progress={progress}
              selected={{ side: selSide?.side ?? null, stage: selStage }}
              onSelect={(side, stage) => setMsSel({ side, stage })}
              L={L}
              toU={toU}
              fromU={fromU}
              dec={dec}
            />
          )}

          <div className="c3d-section">
            <div className="ss-section-title">outputs</div>
              <label className="ss-check">
                <input type="checkbox" checked={outputs.contour} onChange={(e) => setOutputs({ ...outputs, contour: e.target.checked })} />
                model contours (guide)
              </label>
              <label className="ss-check">
                <input type="checkbox" checked={outputs.toolpath} onChange={(e) => setOutputs({ ...outputs, toolpath: e.target.checked })} />
                compensated toolpaths (on line)
              </label>
              <label className="ss-check">
                <input type="checkbox" checked={outputs.pocket} onChange={(e) => setOutputs({ ...outputs, pocket: e.target.checked })} />
                pocket regions (pocket)
              </label>

              {computing && (
                <div className="c3d-progress" aria-label="computing">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {planError && <div className="c3d-error">{planError}</div>}
              {(mode === 'top' ? plan?.warnings : msPlan?.warnings)?.map((w, i) => (
                <div key={i} className="c3d-warn">
                  {w}
                </div>
              ))}

              {mode === 'top' && plan && plan.layers.length > 0 && (
                <>
                  <div className="ss-section-title">layers</div>
                  <span className="c3d-order">{cutOrder}</span>
                  <table className="c3d-table">
                    <thead>
                      <tr>
                        <th>layer</th>
                        <th>depth</th>
                        <th>side</th>
                        <th>contours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.layers.map((l) => {
                        const cls = l.openLoops ? 'is-open' : l.contours ? undefined : 'is-empty'
                        return (
                          <tr key={l.index} className={cls}>
                            <td>{String(l.index).padStart(N2, '0')}</td>
                            <td>{L(l.depth)}</td>
                            <td>{L(l.sideOffset)}</td>
                            <td>
                              {l.openLoops
                                ? `open loop${l.openLoops > 1 ? 's' : ''} × ${l.openLoops}`
                                : l.contours
                                  ? l.contours
                                  : 'empty'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <span className="ss-muted">
                    {plan.shapes.length} shapes will be added
                    {planCurrent ? '' : ' (settings changed, recalculating)'}
                  </span>
                </>
              )}
          </div>
        </aside>
      </div>

      <div className="ss-dialog__footer">
        <button
          type="button"
          className="ss-btn ss-btn--primary"
          disabled={
            computing ||
            (mode === 'multi' ? !msCurrent || !msPlan || msPlan.shapes.length === 0 : !planCurrent || !plan || plan.shapes.length === 0)
          }
          onClick={add}
        >
          Add to Design
        </button>
        <button type="button" className="ss-btn-round" onClick={onClose} aria-label="Cancel">
          <IconClose />
        </button>
      </div>
    </div>
  )
}
