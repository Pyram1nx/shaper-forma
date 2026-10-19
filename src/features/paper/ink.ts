// Ink extraction from a flattened (already perspective-corrected) paper image.
// Pipeline: grayscale -> remove uneven lighting (divide by a heavy blurred
// background) -> adaptive mean threshold -> clear margin -> remove specks ->
// optional 1px closing. Everything is plain TypeScript on typed arrays.
import { integralImage, boxMean } from './integral'

/** Reused integral-image buffer (avoids a multi-MB allocation per slider tick). */
let integralBuf: Uint32Array | null = null

export interface InkOptions {
  /** Pixels per mm of the flattened image. */
  ppm: number
  /** 0..100. Higher = more pixels count as ink. */
  sensitivity: number
  /** Fine offset added to the threshold constant C (gray levels, can be negative). */
  cOffset: number
  /** Ignore ink this close to the paper edge (mm). */
  marginMm: number
  /** Remove connected ink smaller than this (mm²). */
  minBlobMm2: number
  /** Apply a 3x3 closing to join tiny gaps. */
  closeGaps: boolean
}

/** Luma (BT.601-ish integer weights) of an RGBA image. */
export function grayFromImageData(img: ImageData): Uint8Array {
  const n = img.width * img.height
  const d = img.data
  const g = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8
  }
  return g
}

/**
 * Divide out the slowly varying background (paper shading, camera vignetting,
 * soft shadows). The background is a big box blur, so thin pen lines barely
 * affect it — but only after pixels that are dark *relative to their own
 * neighbourhood* (real ink) are replaced by that neighbourhood's level. A broad
 * shadow is not darker than its neighbourhood, so it survives to be divided
 * out; a solid fill is handled separately in buildInkMask via the raw levels.
 */
export function normaliseLighting(gray: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  integralBuf = integralImage(gray, w, h, integralBuf ?? undefined)
  const S0 = integralBuf
  const bgSrc = new Uint8Array(gray.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const local = boxMean(S0, w, h, x, y, Math.max(2, radius >> 2))
      bgSrc[i] = gray[i] < local - 30 ? local : gray[i]
    }
  }
  integralBuf = integralImage(bgSrc, w, h, integralBuf ?? undefined)
  const S = integralBuf
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bg = boxMean(S, w, h, x, y, radius)
      const v = Math.round((gray[y * w + x] * 255) / Math.max(bg, 1))
      out[y * w + x] = v > 255 ? 255 : v
    }
  }
  return out
}

/**
 * Ink test on the lighting-normalised image. A pixel is ink when it is darker than
 * its local window mean by more than C gray levels (adaptive term, keeps faint
 * pen lines), OR darker than 255 - G (global term, so solid fills whose interior
 * matches their own local mean are still inked).
 */
export function adaptiveMask(norm: Uint8Array, w: number, h: number, radius: number, C: number, G: number): Uint8Array {
  integralBuf = integralImage(norm, w, h, integralBuf ?? undefined)
  const S = integralBuf
  const mask = new Uint8Array(w * h)
  const globalLimit = 255 - G
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = norm[i]
      if (v < globalLimit) {
        mask[i] = 1
        continue
      }
      const mean = boxMean(S, w, h, x, y, radius)
      mask[i] = v < mean - C ? 1 : 0
    }
  }
  return mask
}

/** Clear everything within `px` pixels of the image edge. */
export function clearBorder(mask: Uint8Array, w: number, h: number, px: number): void {
  if (px <= 0) return
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < px || y < px || x >= w - px || y >= h - px) mask[y * w + x] = 0
    }
  }
}

/**
 * Connected-component labelling (iterative flood fill, no recursion so large
 * images cannot overflow the stack). Label 0 = background, labels start at 1.
 * `sizes[label]` is the pixel count of that component.
 */
export function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  eight: boolean,
): { labels: Int32Array; sizes: number[] } {
  const N = w * h
  const labels = new Int32Array(N)
  const sizes: number[] = [0]
  const stack = new Int32Array(N)
  let next = 1
  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s]) continue
    let sp = 0
    stack[sp++] = s
    labels[s] = next
    let count = 0
    while (sp > 0) {
      const p = stack[--sp]
      count++
      const x = p % w
      const y = (p - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (!eight && dx !== 0 && dy !== 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (mask[q] && !labels[q]) {
            labels[q] = next
            stack[sp++] = q
          }
        }
      }
    }
    sizes.push(count)
    next++
  }
  return { labels, sizes }
}

/** Remove connected ink components with fewer than `minPx` pixels. */
export function removeSpecks(mask: Uint8Array, w: number, h: number, minPx: number): void {
  if (minPx <= 1) return
  const { labels, sizes } = labelComponents(mask, w, h, true)
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i]
    if (l && sizes[l] < minPx) mask[i] = 0
  }
}

/** 3x3 dilation or erosion. Out-of-image pixels count as background. */
function morph3(src: Uint8Array, w: number, h: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          const s = nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : src[ny * w + nx]
          if (dilate) v |= s
          else v &= s
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

/** Morphological closing (dilate then erode) to bridge 1px gaps. */
export function closeGaps(mask: Uint8Array, w: number, h: number): Uint8Array {
  return morph3(morph3(mask, w, h, true), w, h, false)
}

/**
 * Robust paper level and noise estimate of a lighting-normalised image. The
 * paper level is the 80th percentile (the sheet fills most of the frame and is
 * the brightest thing in it); the noise sigma is a median-absolute-deviation
 * over the brighter half, which shadows and ink barely influence.
 */
export function paperLevelAndNoise(norm: Uint8Array): { paper: number; sigma: number } {
  const hist = new Uint32Array(256)
  for (let i = 0; i < norm.length; i++) hist[norm[i]]++
  let acc = 0
  let paper = 255
  const target = norm.length * 0.8
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) {
      paper = Math.max(v, 1)
      break
    }
  }
  // MAD of pixels within 60 levels of the paper level.
  const devs = new Uint8Array(norm.length)
  let cnt = 0
  for (let i = 0; i < norm.length; i++) {
    const d = paper - norm[i]
    if (d < 0 || d > 60) continue
    devs[cnt++] = d
  }
  const med = () => {
    if (!cnt) return 0
    const bucket = new Uint32Array(61)
    for (let i = 0; i < cnt; i++) bucket[devs[i]]++
    let a = 0
    for (let v = 0; v < 61; v++) {
      a += bucket[v]
      if (a >= cnt / 2) return v
    }
    return 0
  }
  const medDev = med()
  // Second pass around the median for a true MAD sigma.
  let a2 = 0
  let sigma = medDev
  if (cnt) {
    const bucket = new Uint32Array(122)
    for (let i = 0; i < cnt; i++) bucket[Math.min(121, Math.abs(devs[i] - medDev))]++
    for (let v = 0; v < 122; v++) {
      a2 += bucket[v]
      if (a2 >= cnt / 2) {
        sigma = v
        break
      }
    }
  }
  return { paper, sigma: Math.max(1.4826 * sigma, 1) }
}

/**
 * Hysteresis: strong pixels are certain ink; weak pixels only survive when they
 * connect to a strong region. Isolated weak blobs are camera noise and paper
 * texture — exactly what used to litter the result.
 */
function hysteresis(strong: Uint8Array, weak: Uint8Array, w: number, h: number): Uint8Array {
  const { labels, sizes } = labelComponents(weak, w, h, true)
  const keep = new Uint8Array(sizes.length)
  for (let i = 0; i < strong.length; i++) if (strong[i]) keep[labels[i]] = 1
  keep[0] = 0
  const out = new Uint8Array(strong.length)
  for (let i = 0; i < out.length; i++) out[i] = keep[labels[i]] ? 1 : 0
  return out
}

/** Full ink mask (1 = ink) for a flattened grayscale image. */
export function buildInkMask(gray: Uint8Array, w: number, h: number, o: InkOptions): Uint8Array {
  const ppm = o.ppm
  // Heavy background blur (about 12 mm) for lighting correction.
  const bgRadius = Math.max(4, Math.round(12 * ppm))
  const norm = normaliseLighting(gray, w, h, bgRadius)
  // Adaptive window about 15 mm wide.
  const winRadius = Math.max(2, Math.round(7.5 * ppm))
  // Sensitivity 100 -> C = 0 (very eager), 0 -> C = 36 (only very dark marks).
  // The offset can push C below zero; clamp so the adaptive term never inverts.
  const C = Math.max(0, 36 * (1 - o.sensitivity / 100) + o.cOffset)
  // Global term: anything darker than 255 - G is ink, so the interior of a
  // solid fill (whose local mean matches its own value) still counts.
  const G = 45 + 0.9 * o.sensitivity

  const strong = adaptiveMask(norm, w, h, winRadius, C, G)
  // Weak test: half the adaptive demand, a softer global term. Noise pixels
  // pass this test one at a time; hysteresis then deletes any not anchored to
  // real ink. Shadow gradients are broad, so their local contrast stays below
  // even the weak adaptive term and they never enter the mask at all.
  const weak = C > 0 ? adaptiveMask(norm, w, h, winRadius, Math.max(2, C * 0.5), G * 0.6) : strong
  let strongCount = 0
  for (let i = 0; i < strong.length; i++) strongCount += strong[i]
  // A pure-pencil photo has no strong anchors: fall back to the weak mask so
  // faint work is not thrown away wholesale.
  let mask = strongCount > gray.length * 0.001 ? hysteresis(strong, weak, w, h) : weak.slice()

  // Solid fills: pixels far darker than the paper's typical raw level are
  // always ink, even where normalisation (which cannot distinguish a broad
  // fill from a broad shadow in its blur window) would call them paper.
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let acc = 0
  let paperRaw = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= gray.length * 0.85) {
      paperRaw = Math.max(v, 1)
      break
    }
  }
  const darkCut = paperRaw * 0.5
  for (let i = 0; i < mask.length; i++) if (gray[i] < darkCut) mask[i] = 1

  clearBorder(mask, w, h, Math.round(o.marginMm * ppm))
  removeSpecks(mask, w, h, o.minBlobMm2 * ppm * ppm)
  if (o.closeGaps) mask = closeGaps(mask, w, h)
  return mask
}

/** Flattened paper with ink pixels tinted blue (for the preview). */
export function inkPreviewImage(flat: ImageData, mask: Uint8Array): ImageData {
  const out = new ImageData(flat.width, flat.height)
  out.data.set(flat.data)
  const d = out.data
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const j = i * 4
    // Blend 85% toward the brand blue #2c65ff.
    d[j] = d[j] * 0.15 + 44 * 0.85
    d[j + 1] = d[j + 1] * 0.15 + 101 * 0.85
    d[j + 2] = d[j + 2] * 0.15 + 255 * 0.85
  }
  return out
}
