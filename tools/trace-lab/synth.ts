// Synthetic "photos" for the trace lab: a sheet of paper on a desk, drawn
// strokes, perspective, shadows, vignetting and sensor noise — generated
// procedurally so every hard case is reproducible without a camera.
import { computeHomography, applyHomography } from '../../src/features/paper/homography'
import type { RgbaImage } from './bmp'

interface Case {
  name: string
  img: RgbaImage
  /** Paper corners (TL TR BR BL) in scene pixels, projected. */
  truth: { x: number; y: number }[]
  expectedLines: number
}

/** Scene size. */
const W = 1000
const H = 1400

interface Settings {
  desk: [number, number, number]
  paperLevel: number
  /** Perspective: how far the sheet corners drift from a plain rectangle (px). */
  skew: number
  /** Scene-space shadow blobs [x, y, radius, darkness 0..1]. */
  shadows: [number, number, number, number][]
  /** Sensor noise sigma (8-bit levels). */
  noise: number
  /** Final blur radius (px, box blur applied twice = soft triangle). */
  blur: number
  /** Vignette strength 0..1 at the corners. */
  vignette: number
}

const BASE: Settings = {
  desk: [150, 148, 132],
  paperLevel: 246,
  skew: 22,
  shadows: [],
  noise: 2,
  blur: 1,
  vignette: 0.12,
}

/** The drawing on the sheet (paper mm): a circle and a rectangle, like the user's photo. */
function inkAt(xMm: number, yMm: number): boolean {
  const dCircle = Math.abs(Math.hypot(xMm - 62, yMm - 118) - 17)
  const inRectOutline =
    xMm > 105 && xMm < 165 && yMm > 52 && yMm < 130 &&
    (Math.abs(xMm - 105) < 1.3 || Math.abs(xMm - 165) < 1.3 || Math.abs(yMm - 52) < 1.3 || Math.abs(yMm - 130) < 1.3)
  return dCircle < 1.3 || inRectOutline
}

/** Wobbly hand-drawn stroke width (mm) so the vectoriser sees natural variation. */
function strokeHalfWidth(xMm: number, yMm: number): number {
  return 1.25 + 0.35 * Math.sin(xMm * 0.9) * Math.cos(yMm * 0.7)
}

export function synthPhoto(name: string, over: Partial<Settings> = {}): Case {
  const s = { ...BASE, ...over }
  // Paper rect in paper mm (A4), placed inside the scene with perspective drift.
  const pw = 700
  const ph = 990
  const px0 = (W - pw) / 2
  const py0 = (H - ph) / 2
  const k = pw / 210 // scene px per paper mm
  const truth = [
    { x: px0 - s.skew, y: py0 + s.skew * 0.6 },
    { x: px0 + pw + s.skew * 0.5, y: py0 - s.skew * 0.4 },
    { x: px0 + pw - s.skew * 0.3, y: py0 + ph + s.skew },
    { x: px0 + s.skew * 0.2, y: py0 + ph - s.skew * 0.5 },
  ]
  // Homography paper(mm) -> scene(px), then invert per output pixel.
  const paperPts = [
    { x: 0, y: 0 },
    { x: 210, y: 0 },
    { x: 210, y: 297 },
    { x: 0, y: 297 },
  ]
  const Hfwd = computeHomography(paperPts, truth)
  // For pull-sampling we need scene -> paper: solve with swapped args.
  const Hinv = computeHomography(truth, paperPts)

  const img: RgbaImage = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H }
  const raw = new Float32Array(W * H * 3)

  const shadowAt = (x: number, y: number): number => {
    let dark = 0
    for (const [sx, sy, r, d] of s.shadows) {
      const dist = Math.hypot(x - sx, y - sy) / r
      if (dist < 1) dark = Math.max(dark, d * (1 - dist * dist) ** 2)
    }
    return dark
  }
  const vignetteAt = (x: number, y: number): number => {
    const nx = (x / W - 0.5) * 2
    const ny = (y / H - 0.5) * 2
    return 1 - s.vignette * Math.min(1, (nx * nx + ny * ny) / 2)
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyHomography(Hinv, x + 0.5, y + 0.5)
      const inPaper = p.x >= 0 && p.x <= 210 && p.y >= 0 && p.y <= 297
      const light = vignetteAt(x, y) * (1 - shadowAt(x, y))
      let r: number
      let g: number
      let b: number
      if (inPaper) {
        let v = s.paperLevel * light
        const hw = strokeHalfWidth(p.x, p.y)
        // Sample the ink test at 3 offsets for a soft-edged stroke.
        let inkScore = 0
        for (let t = -1; t <= 1; t++) {
          const px = p.x + t * 0.12
          const py = p.y
          if (inkAt(px, py)) inkScore++
        }
        if (inkScore === 1) v = v * 0.45 + 30 * 0.55 * light
        else if (inkScore >= 2) v = 26 * light + s.paperLevel * light * 0.06
        // Paper texture: gentle low-frequency mottle.
        v += 3 * Math.sin(p.x * 0.8 + p.y * 0.35) * Math.cos(p.y * 0.6)
        r = g = b = v
      } else {
        const deskNoise = 6 * Math.sin(x * 0.11 + y * 0.07) + 4 * Math.sin(x * 0.03 - y * 0.05)
        r = s.desk[0] * light + deskNoise
        g = s.desk[1] * light + deskNoise
        b = s.desk[2] * light + deskNoise * 0.7
      }
      const i = (y * W + x) * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }

  // Box blur (twice for a softer kernel).
  const half = (a: Float32Array, w: number, h: number, r: number) => {
    const tmp = new Float32Array(a.length)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0
        let n = 0
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          acc += a[(y * w + xx) * 3]
          n++
        }
        tmp[(y * w + x) * 3] = acc / n
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0
        let n = 0
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy))
          acc += tmp[(yy * w + x) * 3]
          n++
        }
        a[(y * w + x) * 3] = acc / n
      }
  }
  if (s.blur > 0) {
    half(raw, W, H, s.blur)
    half(raw, W, H, Math.max(1, s.blur - 1))
  }

  // Sensor noise + pack to RGBA.
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = 0; i < W * H; i++) {
    const n = s.noise * ((rnd() + rnd() + rnd()) * 2 - 3)
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = raw[i * 3 + c] + n
    img.data[i * 4 + 3] = 255
  }
  return { name, img, truth, expectedLines: 2 }
}

// Helper so the lab can iterate cases without importing internals.
synthPhoto.allCases = (): Case[] => [
  synthPhoto('synth-plain', { skew: 10 }),
  synthPhoto('synth-shadow', {
    desk: [96, 96, 88],
    shadows: [
      [300, 500, 420, 0.4],
      [760, 980, 380, 0.3],
    ],
  }),
  synthPhoto('synth-noisy', {
    desk: [166, 120, 74],
    noise: 9,
    blur: 2,
    shadows: [[700, 350, 300, 0.25]],
  }),
  synthPhoto('synth-dark', {
    desk: [84, 66, 50],
    paperLevel: 225,
    vignette: 0.28,
    skew: 30,
    shadows: [[500, 1200, 500, 0.35]],
  }),
]
