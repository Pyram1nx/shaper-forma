// Trace: photograph a sheet of paper with pen or pencil drawings, frame the
// sheet, and the drawing is vectorised into real-millimetre geometry.
//
// One screen, three phases — no step timeline:
//   pick     choose a photo (file or camera)
//   frame    the sheet's corners are auto-detected and can be corrected
//   working  the flattened sheet shows as pure black & white while a line
//            sweeps across ("converting to vectors"), then sweeps again to
//            reveal the vectors, and the controls fade in
//   result   Outline / Centerline display, Edit Scan (reframe), Modify (pick
//            the vector groups to keep) and Confirm (add to the design)
//
// Ink extraction is fully automatic: lighting is normalised, shadows are
// divided out, and hysteresis keeps sensor noise and paper texture out of the
// mask (see ink.ts). Reuses the shared full-screen mode layout (modeview).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, JSX, ReactNode } from 'react'
import { DEFAULT_CUT, MM_PER_IN, type Contour, type ImportPayload, type Pt, type Shape, type Units } from '../../model/types'
import { fmtLen, fromUnits, shapeFromWorld } from '../../model/factory'
import { COLORS } from '../../ui/colors'
import * as Ic from '../../ui/icons'
import { detectPaper, insetQuad, isSimpleQuad, type DetectResult } from './detect'
import { computeHomography, warpPerspective } from './homography'
import { grayFromImageData } from './ink'
import { CancelledError, cancelPaperJobs, runInk, runVector } from './pipeline'
import type { VectorMode, VectorResult } from './trace'
import './trace.css'

export interface TraceModeProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

interface PaperPreset {
  id: string
  label: string
  /** Portrait size in mm (w <= h). Custom uses the user's inputs. */
  w: number
  h: number
}

const PRESETS: PaperPreset[] = [
  { id: 'a3', label: 'A3', w: 297, h: 420 },
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'a5', label: 'A5', w: 148, h: 210 },
  { id: 'letter', label: 'US Letter', w: 215.9, h: 279.4 },
  { id: 'legal', label: 'US Legal', w: 215.9, h: 355.6 },
  { id: 'tabloid', label: 'Tabloid', w: 279.4, h: 431.8 },
  { id: 'custom', label: 'Custom', w: 0, h: 0 },
]

/** Longest side of the photo kept in memory (px). */
const MAX_PHOTO_SIDE = 3000

/** Corner handles move at this fraction of the cursor in Edit Scan, for precision. */
const EDIT_DRAG_GAIN = 0.4

/** Default edge margin (mm): ink this close to the sheet edge is ignored. */
const MARGIN_MM = 3

/** Sweep animation duration (ms) for both the pixel sweep and the vector reveal. */
const SWEEP_MS = 1300

/** The flattened paper plus the scale it was made at. */
interface ScanImage {
  img: ImageData
  ppmX: number
  ppmY: number
  wMm: number
  hMm: number
  label: string
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Copy a (possibly downscaled) image source into a new canvas (long side <= MAX_PHOTO_SIDE). */
function canvasFromSource(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * k))
  c.height = Math.max(1, Math.round(sh * k))
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, c.width, c.height)
  }
  return c

}

/** Natural size of an image file as the browser decodes it (EXIF orientation applied). */
function imageFileSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/** Shape objects in ImportPayload carry no id. */
function withoutId(s: Shape): Omit<Shape, 'id'> {
  const out: Partial<Shape> = { ...s }
  delete out.id
  return out as Omit<Shape, 'id'>
}

function cutFor(type: 'online' | 'outside' | 'guide') {
  return { ...DEFAULT_CUT, type }
}

/** Preset size in the document units: inches to 2 decimals (A4 8.27 in), mm to 1 decimal (A4 210 mm). */
function fmtPaperSize(mm: number, units: Units): string {
  if (units === 'in') return (mm / MM_PER_IN).toFixed(2)
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1)
}

/** Custom paper defaults: US Letter in inches, A4 in millimetres. */
const CUSTOM_DEFAULT: Record<Units, { w: number; h: number }> = {
  in: { w: 8.5, h: 11 },
  mm: { w: 210, h: 297 },
}

/** Paper size in mm for the current settings, oriented as requested. */
function paperDims(preset: PaperPreset, customW: number, customH: number, units: Units, landscape: boolean) {
  let w: number
  let h: number
  if (preset.id === 'custom') {
    w = Math.max(10, fromUnits(customW, units))
    h = Math.max(10, fromUnits(customH, units))
  } else {
    w = preset.w
    h = preset.h
  }
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  return landscape ? { w: long, h: short } : { w: short, h: long }
}

/** Shape size (px) that fits `aspect` inside the stage, with a fixed padding. */
function useFit(aspect: number, pad = 24) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !aspect) return
    const measure = () => {
      const W = Math.max(0, el.clientWidth - pad * 2)
      const H = Math.max(0, el.clientHeight - pad * 2)
      if (!W || !H) return
      const w = Math.min(W, H * aspect)
      setSize({ w: Math.floor(w), h: Math.floor(w / aspect) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect, pad])
  return { ref, size }
}

/**
 * The flattened page rendered as pure black and white: luma threshold on the
 * lighting-normalised pixels, so shadows and paper tone vanish entirely.
 */
function bwCanvas(img: ImageData): HTMLCanvasElement {
  const n = img.width * img.height
  const lum = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = (img.data[j] * 77 + img.data[j + 1] * 150 + img.data[j + 2] * 29) >> 8
    lum[i] = v
    hist[v]++
  }
  // Paper level = 85th percentile; anything clearly darker than the paper is
  // ink. Relative, so dim photos and bright photos both read as pure B/W.
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= n * 0.85) {
      paper = Math.max(v, 1)
      break
    }
  }
  const cut = paper * 0.62
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (ctx) {
    const out = ctx.createImageData(img.width, img.height)
    const d = out.data
    for (let i = 0, j = 0; j < d.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = lum[i] < cut ? 17 : 255
      d[j + 3] = 255
    }
    ctx.putImageData(out, 0, 0)
  }
  return c
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

type Size = { w: number; h: number }

/** Centred box with the image aspect ratio; children get its pixel size. */
function Stage({ aspect, children }: { aspect: number; children: (size: Size) => ReactNode }) {
  const { ref, size } = useFit(aspect)
  return (
    <div className="trace-stage" ref={ref}>
      <div className="trace-stage__inner" style={{ width: size.w, height: size.h }}>
        {size.w > 0 && children(size)}
      </div>
    </div>
  )
}

/** Paints a canvas (photo / preview) at its native resolution. */
function CanvasView({ src }: { src: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = src.width
    c.height = src.height
    c.getContext('2d')?.drawImage(src, 0, 0)
  }, [src])
  return <canvas ref={ref} />
}

/** Magnifier: zoomed view of the photo around the point being dragged. */
function Loupe({ src, at }: { src: HTMLCanvasElement; at: Pt }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const L = c.width
    const region = 40 // photo px shown across the loupe
    ctx.clearRect(0, 0, L, L)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, at.x - region / 2, at.y - region / 2, region, region, 0, 0, L, L)
    ctx.strokeStyle = COLORS.blue050
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(L / 2, L / 2 - 14)
    ctx.lineTo(L / 2, L / 2 + 14)
    ctx.moveTo(L / 2 - 14, L / 2)
    ctx.lineTo(L / 2 + 14, L / 2)
    ctx.stroke()
  }, [src, at])
  return <canvas ref={ref} className="trace-loupe" width={320} height={320} />
}

/**
 * Draggable quadrilateral over the photo, in photo pixel coordinates. In edit
 * mode handles follow the cursor at a fraction of its speed (`gain`), which
 * makes precise reframing easy; the loupe shows what is under the handle.
 */
function QuadOverlay({
  quad,
  pw,
  ph,
  size,
  gain,
  onDrag,
}: {
  quad: Pt[]
  pw: number
  ph: number
  size: Size
  gain: number
  onDrag: (index: number, p: Pt | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef<{ index: number; cursor: Pt; start: Pt } | null>(null)
  const r = size.w > 0 ? (10 * pw) / size.w : 10

  const toPhoto = (clientX: number, clientY: number): Pt => {
    const box = svgRef.current!.getBoundingClientRect()
    return {
      x: clamp(((clientX - box.left) * pw) / box.width, 0, pw),
      y: clamp(((clientY - box.top) * ph) / box.height, 0, ph),
    }
  }

  const pts = quad.map((p) => `${p.x},${p.y}`).join(' ')
  const shade = `M0 0H${pw}V${ph}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(' L')} Z`

  return (
    <svg
      ref={svgRef}
      className="trace-overlay"
      viewBox={`0 0 ${pw} ${ph}`}
      onPointerMove={(e) => {
        const d = dragging.current
        if (!d) return
        const p = toPhoto(e.clientX, e.clientY)
        // Precision mode: the handle travels at `gain` times the cursor's move.
        const moved = { x: (p.x - d.cursor.x) * gain, y: (p.y - d.cursor.y) * gain }
        onDrag(d.index, {
          x: clamp(d.start.x + moved.x, 0, pw),
          y: clamp(d.start.y + moved.y, 0, ph),
        })
      }}
      onPointerUp={() => {
        dragging.current = null
        onDrag(-1, null)
      }}
      onPointerCancel={() => {
        dragging.current = null
        onDrag(-1, null)
      }}
    >
      <path d={shade} fillRule="evenodd" className="trace-overlay__shade" />
      <polygon points={pts} className="trace-overlay__quad" />
      {quad.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={r}
          className="trace-handle"
          onPointerDown={(e) => {
            dragging.current = { index: i, cursor: toPhoto(e.clientX, e.clientY), start: quad[i] }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
        />
      ))}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Trace editor                                                        */
/* ------------------------------------------------------------------ */

type Phase = 'pick' | 'frame' | 'working' | 'result'
type ResultMode = 'view' | 'edit' | 'modify'
/**
 * The two-stage sweep: the line crosses the black & white page ("converting to
 * vectors"), waits there if the vectors are not ready yet, then crosses again
 * and uncovers the vector lines behind it.
 */
type Sweep = 'pixel' | 'wait' | 'reveal' | 'reveal-run' | 'done'

export default function TraceMode({ units, onClose, onImport }: TraceModeProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick')
  const [error, setError] = useState<string | null>(null)

  // pick: photo and camera
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null)
  const [camera, setCamera] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const camReq = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  // frame: corners and paper size
  const [quad, setQuad] = useState<Pt[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  const [presetId, setPresetId] = useState('a4')
  const [customW, setCustomW] = useState(() => CUSTOM_DEFAULT[units].w)
  const [customH, setCustomH] = useState(() => CUSTOM_DEFAULT[units].h)
  const [landscape, setLandscape] = useState(false)
  const [ppm, setPpm] = useState(6)
  const [loupe, setLoupe] = useState<Pt | null>(null)

  // working / result
  const [scan, setScan] = useState<ScanImage | null>(null)
  const [bw, setBw] = useState<HTMLCanvasElement | null>(null)
  const [sweep, setSweep] = useState<Sweep>('pixel')
  const [vec, setVec] = useState<VectorResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<VectorMode>('centerline')
  const [resultMode, setResultMode] = useState<ResultMode>('view')
  const [keep, setKeep] = useState<Set<number>>(() => new Set())
  const job = useRef(0)

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1]
  const paper = useMemo(
    () => paperDims(preset, customW, customH, units, landscape),
    [preset, customW, customH, units, landscape],
  )

  /* ----- camera lifecycle ----- */

  const stopCamera = () => {
    camReq.current++
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCamera(false)
  }

  useEffect(
    () => () => {
      camReq.current++
      streamRef.current?.getTracks().forEach((t) => t.stop())
      cancelPaperJobs()
    },
    [],
  )

  useEffect(() => {
    if (camera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      void videoRef.current.play().catch(() => undefined)
    }
  }, [camera])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (resultMode !== 'view') setResultMode('view')
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, resultMode])

  async function startCamera() {
    setError(null)
    const req = ++camReq.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
      if (req !== camReq.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      setCamera(true)
    } catch {
      if (req === camReq.current) setError('Camera is not available. Choose an image instead.')
    }
  }

  function captureFrame() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    setPhoto(canvasFromSource(v, v.videoWidth, v.videoHeight))
    resetFromPhoto()
    stopCamera()
  }

  /* ----- photo loading ----- */

  function resetFromPhoto() {
    setQuad(null)
    setDetectNote(null)
    setScan(null)
    setBw(null)
    setVec(null)
    setLoupe(null)
    setSweep('pixel')
    setResultMode('view')
  }

  async function loadFile(file: File) {
    setError(null)
    try {
      let bmp: ImageBitmap
      try {
        const size = await imageFileSize(file)
        const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(size.w, size.h))
        bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: Math.max(1, Math.round(size.w * k)),
          resizeHeight: Math.max(1, Math.round(size.h * k)),
          resizeQuality: 'high',
        })
      } catch {
        bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      }
      const c = canvasFromSource(bmp, bmp.width, bmp.height)
      bmp.close()
      setPhoto(c)
      resetFromPhoto()
      void runDetect(c)
      setPhase('frame')
    } catch {
      setError('Could not read that file as an image.')
    }
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (f) void loadFile(f)
  }

  function onDropFile(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) void loadFile(f)
  }

  /* ----- corner detection ----- */

  async function runDetect(p: HTMLCanvasElement) {
    setDetecting(true)
    setDetectNote(null)
    await tick()
    let r: DetectResult
    try {
      r = detectPaper(p)
    } catch {
      r = { quad: insetQuad(p.width, p.height), found: false, reason: '' }
    }
    setQuad(r.quad)
    if (!r.found) setDetectNote("Couldn't find the paper edges — drag the corners onto the sheet")
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
    const q = r.quad
    const widthAvg = (d(q[0], q[1]) + d(q[3], q[2])) / 2
    const heightAvg = (d(q[0], q[3]) + d(q[1], q[2])) / 2
    setLandscape(widthAvg > heightAvg)
    setDetecting(false)
  }

  /* ----- flatten + vectorise with the sweep animation ----- */

  async function scanSheet() {
    if (!photo || !quad || !isSimpleQuad(quad)) return
    setError(null)
    setBusy('Flattening…')
    await tick()
    try {
      const outW = Math.max(1, Math.round(paper.w * ppm))
      const outH = Math.max(1, Math.round(paper.h * ppm))
      const src = photo.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, photo.width, photo.height)
      const Hinv = computeHomography(
        [
          { x: 0, y: 0 },
          { x: outW, y: 0 },
          { x: outW, y: outH },
          { x: 0, y: outH },
        ],
        quad,
      )
      const img = warpPerspective(src, Hinv, outW, outH)
      const s: ScanImage = { img, ppmX: outW / paper.w, ppmY: outH / paper.h, wMm: paper.w, hMm: paper.h, label: preset.label }
      setScan(s)
      setBw(bwCanvas(s.img))
      setVec(null)
      setSweep('pixel')
      setResultMode('view')
      setPhase('working')
      setBusy(null)
      void vectorise(s)
    } catch {
      setBusy(null)
      setError('Could not flatten the photo. Move the corners apart and try again.')
    }
  }

  async function vectorise(s: ScanImage) {
    const myJob = ++job.current
    setBusy('Converting to vectors…')
    try {
      // Raw grayscale: the ink pipeline does its own lighting normalisation.
      const gray = grayFromImageData(s.img)
      const m = await runInk(gray, s.img.width, s.img.height, {
        ppm: s.ppmX,
        sensitivity: 50,
        cOffset: 0,
        marginMm: MARGIN_MM,
        minBlobMm2: 3,
        closeGaps: false,
      })
      if (myJob !== job.current) return
      const r = await runVector(m, s.img.width, s.img.height, s.ppmX, mode, s.ppmY)
      if (myJob !== job.current) return
      setVec(r)
      setKeep(new Set(r.groups.map((_, i) => i)))
      setBusy(null)
    } catch (err) {
      if (myJob !== job.current || err instanceof CancelledError) return
      setBusy(null)
      setError('Could not trace the drawing. Try another photo.')
    }
  }

  // Re-vectorise when the display mode changes on the result screen.
  useEffect(() => {
    if (phase !== 'result' || !scan || !vec) return
    const myJob = ++job.current
    void (async () => {
      try {
        const gray = grayFromImageData(scan.img)
        const m = await runInk(gray, scan.img.width, scan.img.height, {
          ppm: scan.ppmX,
          sensitivity: 50,
          cOffset: 0,
          marginMm: MARGIN_MM,
          minBlobMm2: 3,
          closeGaps: false,
        })
        if (myJob !== job.current) return
        const r = await runVector(m, scan.img.width, scan.img.height, scan.ppmX, mode, scan.ppmY)
        if (myJob !== job.current) return
        setVec(r)
        setKeep(new Set(r.groups.map((_, i) => i)))
      } catch {
        /* keep the previous vectors */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  /* ----- sweep animation sequencing ----- */

  const onPixelSweepEnd = () => setSweep((sw) => (sw === 'pixel' ? 'wait' : sw))

  // Once the first sweep is parked and the vectors exist, run the reveal.
  useEffect(() => {
    if (sweep !== 'wait' || !vec) return
    setSweep('reveal')
  }, [vec, sweep])

  // Let the browser paint the reveal's initial (unrevealed) state before the
  // transition class lands, otherwise the reveal would jump to the end.
  useEffect(() => {
    if (sweep !== 'reveal') return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSweep('reveal-run')))
    return () => cancelAnimationFrame(id)
  }, [sweep])

  // Measurements and controls fade in only after the reveal has finished.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (phase !== 'result') {
      setRevealed(false)
      return
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)))
    return () => cancelAnimationFrame(id)
  }, [phase])

  /* ----- import ----- */

  function addToDesign() {
    if (!scan || !vec) return
    const W = scan.wMm
    const H = scan.hMm
    const shapes: Omit<Shape, 'id'>[] = []

    const outline: Contour = {
      pts: [
        { x: 0, y: 0 },
        { x: W, y: 0 },
        { x: W, y: H },
        { x: 0, y: H },
      ],
      closed: true,
    }
    shapes.push(
      withoutId(
        shapeFromWorld('rect', 'Trace outline', [outline], {
          cut: cutFor('guide'),
          params: { w: W, h: H },
          meta: { source: 'paper', role: 'paper' },
        }),
      ),
    )

    const keptGroups = vec.groups.filter((_, i) => keep.has(i))
    const cutType = vec.mode === 'centerline' ? 'online' : 'outside'
    const meta = { source: 'paper' as const, role: 'outline' as const }
    if (keptGroups.length) {
      if (vec.mode === 'centerline' && keptGroups.length > 200) {
        shapes.push(
          withoutId(shapeFromWorld('sketch', 'Sketch lines', keptGroups.flat(), { cut: cutFor(cutType), meta })),
        )
      } else {
        keptGroups.forEach((g, i) => {
          const name = vec.mode === 'centerline' ? `Line ${i + 1}` : `Outline ${i + 1}`
          shapes.push(withoutId(shapeFromWorld('sketch', name, g, { cut: cutFor(cutType), meta })))
        })
      }
    }

    onImport({
      group: {
        name: `Trace – ${scan.label}`,
        source: 'paper',
        info: {
          paper: `${scan.label} ${fmtLen(W, units)} × ${fmtLen(H, units)}`,
          strokeWidth: vec.strokeWidthMm,
          mode: vec.mode === 'centerline' ? 'Centerline' : 'Outline',
          detail: `${Math.round(scan.ppmX)} px/mm`,
        },
      },
      shapes,
    })
    onClose()
  }

  /* ----- render helpers ----- */

  const vectorD = useMemo(() => {
    if (!vec) return ''
    const parts: string[] = []
    vec.groups.forEach((g, gi) => {
      if (resultMode === 'modify' && !keep.has(gi)) return
      for (const c of g) {
        if (c.pts.length < 2) continue
        parts.push(
          'M' + c.pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + (c.closed ? 'Z' : ''),
        )
      }
    })
    return parts.join('')
  }, [vec, resultMode, keep])

  const groupDs = useMemo(
    () =>
      vec
        ? vec.groups.map((g) =>
            g
              .map((c) =>
                c.pts.length < 2
                  ? ''
                  : 'M' + c.pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + (c.closed ? 'Z' : ''),
              )
              .join(''),
          )
        : [],
    [vec],
  )

  const cornersCross = !!quad && !isSimpleQuad(quad)
  const scanDisabled = !quad || cornersCross || detecting || !!busy

  const toggleKeep = (i: number) =>
    setKeep((p) => {
      const n = new Set(p)
      if (!n.delete(i)) n.add(i)
      return n
    })

  /* ----- render ----- */

  return (
    <div
      className={
        'modeview trace' + (phase === 'pick' || phase === 'frame' || resultMode === 'edit' ? ' trace--frame' : '')
      }
      role="dialog"
      aria-label="Trace"
    >
      <div className="trace__title" aria-hidden="true">
        Trace
      </div>

      <div className="modeview__canvas trace__main">
        {phase === 'pick' && (
          <div className="trace-stage">
            {camera ? (
              <>
                <video ref={videoRef} className="trace-video" playsInline muted autoPlay />
                <button
                  type="button"
                  className="ss-btn-round ss-btn-round--dark trace-capture"
                  aria-label="Capture photo"
                  onClick={captureFrame}
                >
                  <Ic.IconCapture />
                </button>
              </>
            ) : (
              <div
                className={`ss-dropzone trace-drop${dragOver ? ' is-over' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDropFile}
                role="button"
                tabIndex={0}
              >
                <Ic.IconUploadArrow className="trace-drop__icon" size={48} />
                <div>
                  <strong>Drop a photo of your drawing here</strong>
                  <div className="ss-muted">Lay the sheet flat, in good light, with all four corners visible.</div>
                </div>
                <span className="ss-btn ss-btn--primary ss-btn--sm">Choose Image</span>
              </div>
            )}
          </div>
        )}

        {phase === 'frame' && photo && quad && (
          <Stage aspect={photo.width / photo.height}>
            {(size) => (
              <>
                <CanvasView src={photo} />
                <QuadOverlay quad={quad} pw={photo.width} ph={photo.height} size={size} gain={1} onDrag={onFrameDrag} />
              </>
            )}
          </Stage>
        )}

        {(phase === 'working' || (phase === 'result' && resultMode === 'view' && sweep !== 'done')) && scan && bw && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {(size) => (
              <div className="trace-revealbox" style={{ width: size.w, height: size.h }}>
                <CanvasView src={bw} />
                <div
                  className={'trace-reveal' + (sweep === 'reveal-run' ? ' trace-reveal--run' : '')}
                  style={{ width: size.w, height: size.h, ['--sweep-ms' as string]: `${SWEEP_MS}ms` }}
                >
                  {(sweep === 'reveal' || sweep === 'reveal-run') && vec && (
                    <svg
                      className="trace-vec"
                      viewBox={`0 0 ${scan.wMm} ${scan.hMm}`}
                      preserveAspectRatio="none"
                      style={{ width: size.w, height: size.h }}
                    >
                      <path d={vectorD} />
                    </svg>
                  )}
                  {(sweep === 'pixel' || sweep === 'wait' || sweep === 'reveal' || sweep === 'reveal-run') && (
                    <div
                      key={sweep === 'pixel' || sweep === 'wait' ? 'sweep1' : 'sweep2'}
                      className={
                        'trace-reveal__line' +
                        (sweep === 'pixel' || sweep === 'wait' ? ' trace-reveal__line--pixel' : '')
                      }
                      onAnimationEnd={sweep === 'pixel' ? onPixelSweepEnd : undefined}
                      onTransitionEnd={sweep === 'reveal-run' ? () => setPhase('result') : undefined}
                    />
                  )}
                </div>
              </div>
            )}
          </Stage>
        )}
        {(phase === 'working' || sweep === 'wait') && <div className="trace-converting">converting to vectors</div>}

        {phase === 'result' && resultMode === 'view' && sweep === 'done' && scan && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {() => (
              <svg className="trace-vec" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                <path d={vectorD} />
              </svg>
            )}
          </Stage>
        )}

        {phase === 'result' && resultMode === 'edit' && photo && quad && (
          <Stage aspect={photo.width / photo.height}>
            {(size) => (
              <>
                <CanvasView src={photo} />
                <QuadOverlay quad={quad} pw={photo.width} ph={photo.height} size={size} gain={EDIT_DRAG_GAIN} onDrag={onFrameDrag} />
              </>
            )}
          </Stage>
        )}

        {phase === 'result' && resultMode === 'modify' && scan && vec && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {() => (
              <svg className="trace-vec trace-vec--pick" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                {groupDs.map((d, i) =>
                  d ? (
                    <g key={i} data-testid={`trace-group-${i}`} onClick={() => toggleKeep(i)}>
                      {/* invisible wide stroke = forgiving tap target */}
                      <path d={d} className="trace-group-hit" />
                      <path d={d} className={'trace-group' + (keep.has(i) ? ' is-kept' : '')} pointerEvents="none" />
                    </g>
                  ) : null,
                )}
              </svg>
            )}
          </Stage>
        )}

        {loupe && photo && <Loupe src={photo} at={loupe} />}
        {detecting && phase === 'frame' && <div className="trace-busy">Finding the paper…</div>}
        {error && <div className="trace-error">{error}</div>}
      </div>

      <aside className="modeview__panel trace__side">
        <button type="button" className="modeview__close" aria-label="Close Trace" onClick={onClose}>
          <Ic.IconClose size={18} />
        </button>
        <div className="modeview__title">
          <Ic.IconTrace size={18} />
          Trace
        </div>

        {phase === 'pick' && (
          <>
            <p className="modeview__hint">Photograph a hand drawing and trace it into vectors.</p>
            <button type="button" className="modeview__pill" onClick={() => fileRef.current?.click()}>
              Choose Image
            </button>
            {camera ? (
              <button type="button" className="modeview__pill" onClick={stopCamera}>
                Stop Camera
              </button>
            ) : (
              <button type="button" className="modeview__pill" onClick={startCamera}>
                <Ic.IconCamera size={16} /> Use Camera
              </button>
            )}
            {photo && (
              <div className="modeview__hint">
                Loaded {photo.width} × {photo.height} px.
              </div>
            )}
            {detectNote && <div className="trace-warn">{detectNote}</div>}
          </>
        )}

        {(phase === 'frame' || (phase === 'result' && resultMode === 'edit')) && (
          <>
            <p className="modeview__hint">
              {resultMode === 'edit'
                ? 'Drag the corners to reframe the sheet — they move slowly for precision.'
                : 'Check the corners, pick the paper size, then Scan.'}
            </p>
            <div className="modeview__label">paper</div>
            <select className="ss-select trace-select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === 'custom' ? 'Custom' : `${p.label} (${fmtPaperSize(p.w, units)} × ${fmtPaperSize(p.h, units)} ${units})`}
                </option>
              ))}
            </select>
            {preset.id === 'custom' && (
              <div className="trace-row">
                <input
                  className="ss-select"
                  type="number"
                  min={0}
                  step="any"
                  value={customW}
                  onChange={(e) => setCustomW(Number(e.target.value) || 0)}
                  aria-label="Custom width"
                />
                <input
                  className="ss-select"
                  type="number"
                  min={0}
                  step="any"
                  value={customH}
                  onChange={(e) => setCustomH(Number(e.target.value) || 0)}
                  aria-label="Custom height"
                />
                <span className="modeview__label">{units}</span>
              </div>
            )}
            <div className="ss-seg trace-seg" role="group" aria-label="Orientation">
              <button type="button" className={!landscape ? 'is-active' : ''} onClick={() => setLandscape(false)}>
                Portrait
              </button>
              <button type="button" className={landscape ? 'is-active' : ''} onClick={() => setLandscape(true)}>
                Landscape
              </button>
            </div>
            <div className="modeview__hint">
              {fmtLen(paper.w, units)} × {fmtLen(paper.h, units)}
            </div>
            <div className="modeview__label">detail</div>
            <div className="ss-seg trace-seg" role="group" aria-label="Detail">
              {[4, 6, 10].map((v) => (
                <button key={v} type="button" className={ppm === v ? 'is-active' : ''} onClick={() => setPpm(v)}>
                  {v} px/mm
                </button>
              ))}
            </div>
            <div className="modeview__label" style={{ marginTop: 4 }}>
              corners
            </div>
            <button type="button" className="modeview__pill" onClick={() => photo && runDetect(photo)} disabled={!photo || detecting}>
              Auto-Detect
            </button>
            {detectNote && <div className="trace-warn">{detectNote}</div>}
            {cornersCross && <div className="trace-warn">The corners cross over each other. Drag them back into shape.</div>}
            <div className="modeview__spacer" />
            {resultMode === 'edit' ? (
              <button type="button" className="modeview__pill modeview__pill--back" onClick={() => setResultMode('view')}>
                Back
              </button>
            ) : null}
            <button type="button" className="modeview__finish" disabled={scanDisabled} onClick={() => { if (resultMode === 'edit') setResultMode('view'); void scanSheet() }}>
              {resultMode === 'edit' ? 'Rescan' : 'Scan'}
            </button>
          </>
        )}

        {phase === 'working' && (
          <>
            <p className="modeview__hint">Finding the ink and converting it to vectors.</p>
          </>
        )}

        {phase === 'result' && resultMode !== 'edit' && (
          <>
            <div className={'trace-stats' + (revealed ? ' is-in' : '')}>
              <div className="modeview__label">display</div>
              <div className="ss-seg trace-seg" role="group" aria-label="Display mode">
                <button type="button" className={mode === 'outline' ? 'is-active' : ''} onClick={() => setMode('outline')}>
                  Outline
                </button>
                <button type="button" className={mode === 'centerline' ? 'is-active' : ''} onClick={() => setMode('centerline')}>
                  Centerline
                </button>
              </div>
              <div className="trace-stat">
                <span>{mode === 'centerline' ? 'Lines' : 'Shapes'}</span>
                <strong>{vec ? vec.lineCount : '–'}</strong>
              </div>
              {mode === 'centerline' && (
                <div className="trace-stat">
                  <span>Stroke width</span>
                  <strong>{vec && vec.strokeWidthMm > 0 ? fmtLen(vec.strokeWidthMm, units) : '–'}</strong>
                </div>
              )}
              <div className="trace-stat">
                <span>Paper</span>
                <strong>{scan ? `${scan.label} · ${fmtLen(scan.wMm, units)} × ${fmtLen(scan.hMm, units)}` : '–'}</strong>
              </div>
            </div>
            {resultMode === 'modify' && (
              <>
                <button type="button" className="modeview__pill modeview__pill--back" onClick={() => { setResultMode('view'); setKeep(new Set(vec?.groups.map((_, i) => i) ?? [])) }}>
                  Back
                </button>
                <div className="modeview__label">select</div>
                <div className="trace-row">
                  <button type="button" className="modeview__pill" onClick={() => setKeep(new Set(vec?.groups.map((_, i) => i) ?? []))}>
                    All
                  </button>
                  <button type="button" className="modeview__pill" onClick={() => setKeep(new Set())}>
                    None
                  </button>
                </div>
                <p className="modeview__hint">Tap parts of the trace to keep or remove them.</p>
              </>
            )}
            <div className="modeview__spacer" />
            {resultMode === 'view' && (
              <button type="button" className="modeview__pill" disabled={!vec} onClick={() => setResultMode('edit')}>
                Edit Scan
              </button>
            )}
            {resultMode === 'view' && (
              <button type="button" className="modeview__pill" disabled={!vec} onClick={() => setResultMode('modify')}>
                Modify
              </button>
            )}
            <button
              type="button"
              className="trace-confirm"
              aria-label="Add to design"
              title="Add to design"
              disabled={!vec || !keep.size}
              onClick={addToDesign}
            >
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            </button>
          </>
        )}
      </aside>

      {/* Mobile control panel: display row, then Edit Scan / Confirm / Modify. */}
      {phase === 'result' && resultMode !== 'edit' && (
        <nav className={'trace-controls' + (revealed ? ' is-in' : '')} aria-label="Trace controls">
          <div className="trace-controls__row">
            <div className="ss-seg trace-seg" role="group" aria-label="Display mode">
              <button type="button" className={mode === 'outline' ? 'is-active' : ''} onClick={() => setMode('outline')}>
                Outline
              </button>
              <button type="button" className={mode === 'centerline' ? 'is-active' : ''} onClick={() => setMode('centerline')}>
                Centerline
              </button>
            </div>
          </div>
          <div className="trace-controls__row">
            <button type="button" className="trace-controls__text" disabled={!vec} onClick={() => setResultMode('edit')}>
              Edit Scan
            </button>
            <button
              type="button"
              className="trace-confirm"
              aria-label="Add to design"
              disabled={!vec || !keep.size}
              onClick={addToDesign}
            >
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            </button>
            <button type="button" className="trace-controls__text" disabled={!vec} onClick={() => setResultMode('modify')}>
              Modify
            </button>
          </div>
        </nav>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPickFile} />
    </div>
  )

  function onFrameDrag(index: number, p: Pt | null) {
    if (index < 0 || !p) {
      setLoupe(null)
      return
    }
    setDetectNote(null)
    setQuad((q) => (q ? q.map((c, i) => (i === index ? p : c)) : q))
    setLoupe(p)
  }

}
