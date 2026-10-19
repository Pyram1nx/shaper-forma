// Automatic paper detection. The pipeline is deliberately redundant so one bad
// assumption never sinks the result:
//
//   1. Score image: brightness with a saturation penalty (paper is bright AND
//      low-chroma; wooden or coloured desks, shadows and stains are not).
//   2. Candidate quads: several thresholds around Otsu x several closing radii,
//      each -> largest bright blob -> convex hull -> four extreme corners, kept
//      only when the quad passes geometric validation. Best score wins, so a
//      shadow that splits the sheet at one threshold is rescued at another.
//   3. Subpixel refinement: each quad edge is re-localised from the strongest
//      image gradients along it, the four edge lines are re-fitted by least
//      squares, and their intersections become the final corners. This is what
//      makes the framing land on the paper edge instead of near it.
//
// Everything works on plain typed arrays, so the same code runs in the browser
// and in the Node test harness.
import type { Pt } from '../../model/types'
import { labelComponents } from './ink'
import { integralImage, rectSum } from './integral'

/** Long side of the working copy used for detection. */
const WORK_MAX = 1000

/** Otsu's method: threshold that maximises between-class variance. */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]
  let wB = 0
  let sumB = 0
  let best = -1
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      thr = t
    }
  }
  return thr
}

/**
 * Paper score from RGBA: luma minus a penalty for saturation. Penalties start
 * above sat 20 so the slight tint of white paper is free, while wood, cloth and
 * coloured desks lose 20..60 levels — enough to keep them below paper even
 * when a bright lamp patch makes them as bright as the sheet.
 */
export function paperScore(rgba: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j]
    const g = rgba[j + 1]
    const b = rgba[j + 2]
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const luma = (r * 77 + g * 150 + b * 29) >> 8
    const sat = mx - mn
    const v = luma - Math.max(0, sat - 20)
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

/** Convex hull (Andrew's monotone chain). Returns counter-clockwise points. */
export function convexHull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop()
    lower.push(pt)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop()
    upper.push(pt)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * Order four corners as TL, TR, BR, BL (clockwise on screen, y down).
 * Sorts by angle around the centroid, then starts at the point with min x+y.
 */
export function orderQuad(pts: Pt[]): Pt[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = pts
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let start = 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  }
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4])
}

/** Shoelace area of a polygon (absolute value). */
export function polygonArea(q: Pt[]): number {
  let a = 0
  for (let i = 0; i < q.length; i++) {
    const p = q[i]
    const r = q[(i + 1) % q.length]
    a += p.x * r.y - r.x * p.y
  }
  return Math.abs(a) / 2
}

/** Fallback quad: image corners inset by 5%. */
export function insetQuad(w: number, h: number): Pt[] {
  const mx = w * 0.05
  const my = h * 0.05
  return [
    { x: mx, y: my },
    { x: w - mx, y: my },
    { x: w - mx, y: h - my },
    { x: mx, y: h - my },
  ]
}

/** Mean of the two opposite edge pairs: returns the sheet's long/short ratio (>= 1). */
export function quadAspect(q: Pt[]): number {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  const top = d(q[0], q[1])
  const bottom = d(q[3], q[2])
  const left = d(q[0], q[3])
  const right = d(q[1], q[2])
  const wAvg = (top + bottom) / 2
  const hAvg = (left + right) / 2
  if (wAvg <= 0 || hAvg <= 0) return 1
  return Math.max(wAvg, hAvg) / Math.min(wAvg, hAvg)
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/** True when the closed quad does not cross itself (edges 0-1 / 2-3 and 1-2 / 3-0 do not intersect). */
export function isSimpleQuad(q: Pt[]): boolean {
  if (q.length !== 4) return false
  const segX = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    const d1 = cross(a, b, c)
    const d2 = cross(a, b, d)
    const d3 = cross(c, d, a)
    const d4 = cross(c, d, b)
    return d1 * d2 < 0 && d3 * d4 < 0
  }
  return !segX(q[0], q[1], q[2], q[3]) && !segX(q[1], q[2], q[3], q[0])
}

/**
 * Sanity checks for a detected quad (work or photo coordinates, same space as w x h).
 * Returns null when the quad is plausible, otherwise the reason it was rejected.
 */
export function validateQuad(q: Pt[], w: number, h: number): string | null {
  if (q.length !== 4) return 'not four corners'
  // Convex: every turn has the same sign and none is flat.
  let pos = 0
  let neg = 0
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])
    if (c > 0) pos++
    else if (c < 0) neg++
  }
  if (pos + neg < 4 || (pos !== 0 && neg !== 0)) return 'not a convex shape'
  if (!isSimpleQuad(q)) return 'self-intersecting'
  // Interior angles between 50 and 130 degrees: a photographed sheet is never
  // near-degenerate, and this rejects wedges that hug one image border.
  for (let i = 0; i < 4; i++) {
    const p = q[i]
    const a = q[(i + 3) % 4]
    const b = q[(i + 1) % 4]
    const ux = a.x - p.x, uy = a.y - p.y
    const vx = b.x - p.x, vy = b.y - p.y
    const cosA = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1)
    const deg = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI
    if (deg < 50 || deg > 130) return 'corner angles are off'
  }
  const area = polygonArea(q)
  if (area < w * h * 0.02) return 'too small'
  if (area > w * h * 0.985) return 'covers almost the whole photo'
  const xs = q.map((p) => p.x)
  const ys = q.map((p) => p.y)
  const tol = 0.004
  const touchL = Math.min(...xs) <= w * tol
  const touchR = Math.max(...xs) >= w * (1 - tol)
  const touchT = Math.min(...ys) <= h * tol
  const touchB = Math.max(...ys) >= h * (1 - tol)
  if (touchL && touchR && touchT && touchB) return 'runs off all four edges'
  return null
}

/** Binary closing with a square structuring element of radius r (exact, via integral images). */
function closeMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const S = integralImage(mask, w, h)
  const side = 2 * r + 1
  const full = side * side
  // Dilation: any foreground in the window (outside pixels count as background).
  const dil = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1)
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1)
      dil[y * w + x] = rectSum(S, w, x0, y0, x1, y1) > 0 ? 1 : 0
    }
  }
  // Erosion of the dilated mask: outside pixels count as foreground, so the
  // image border does not erode the sheet.
  const S2 = integralImage(dil, w, h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1)
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1)
      const inside = rectSum(S2, w, x0, y0, x1, y1)
      const outside = full - (x1 - x0) * (y1 - y0)
      out[y * w + x] = inside + outside === full ? 1 : 0
    }
  }
  return out
}

export interface QuadResult {
  /** Four corners, TL TR BR BL, in the coordinates of the input grid. Null when rejected. */
  quad: Pt[] | null
  /** Why detection failed (only when quad is null). */
  reason: string
}

/**
 * The brightest, biggest plausible sheet for one (threshold, closing radius)
 * pair, or null. `score` is the paper-score image.
 */
export /** v such that a fraction `q` of the pixels are below it (8-bit histogram). */
function percentile(v: Uint8Array, q: number): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < v.length; i++) hist[v[i]]++
  const target = v.length * q
  let acc = 0
  for (let t = 0; t < 256; t++) {
    acc += hist[t]
    if (acc >= target) return t
  }
  return 255
}

/**
 * The sheet candidate for one closing radius: largest bright component of the
 * lighting-normalised mask -> convex hull -> four extreme corners. Returns null
 * when nothing plausible is found at this radius.
 */
function quadFromMask(
  bright: Uint8Array,
  score: Uint8Array,
  w: number,
  h: number,
  closeR: number,
): { quad: Pt[]; area: number; insideMean: number } | null {
  const closed = closeMask(bright, w, h, closeR)
  const { labels, sizes } = labelComponents(closed, w, h, false)
  let bestLabel = 0
  for (let l = 1; l < sizes.length; l++) {
    if (bestLabel === 0 || sizes[l] > sizes[bestLabel]) bestLabel = l
  }
  if (bestLabel === 0 || sizes[bestLabel] < w * h * 0.02) return null

  const boundary: Pt[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (labels[i] !== bestLabel) continue
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        labels[i - 1] !== bestLabel || labels[i + 1] !== bestLabel ||
        labels[i - w] !== bestLabel || labels[i + w] !== bestLabel
      if (edge) boundary.push({ x, y })
    }
  }
  const hull = convexHull(boundary)
  if (hull.length < 4) return null
  const pick = (get: (p: Pt) => number, maximise: boolean): Pt => {
    let best = hull[0]
    for (const p of hull) {
      const s = get(p)
      if (maximise ? s > get(best) : s < get(best)) best = p
    }
    return best
  }
  const quad = orderQuad([
    pick((p) => p.x + p.y, false),
    pick((p) => p.x - p.y, true),
    pick((p) => p.x + p.y, true),
    pick((p) => p.x - p.y, false),
  ])
  if (new Set(quad.map((p) => `${p.x},${p.y}`)).size !== 4) return null
  if (validateQuad(quad, w, h)) return null
  // Mean score on an interior grid, used to rank candidates.
  let sum = 0
  let cnt = 0
  for (let gy = 1; gy < 12; gy++) {
    for (let gx = 1; gx < 12; gx++) {
      const u = gx / 12
      const v = gy / 12
      const x = quad[0].x + (quad[1].x - quad[0].x) * u + (quad[3].x - quad[0].x) * v + (quad[2].x - quad[1].x - quad[3].x + quad[0].x) * u * v
      const y = quad[0].y + (quad[1].y - quad[0].y) * u + (quad[3].y - quad[0].y) * v + (quad[2].y - quad[1].y - quad[3].y + quad[0].y) * u * v
      const xi = Math.max(0, Math.min(w - 1, Math.round(x)))
      const yi = Math.max(0, Math.min(h - 1, Math.round(y)))
      sum += score[yi * w + xi]
      cnt++
    }
  }
  return { quad, area: polygonArea(quad), insideMean: sum / Math.max(1, cnt) }
}

/* ------------------------------------------------------------------ */
/* Subpixel edge refinement                                            */
/* ------------------------------------------------------------------ */

/** 3x3 box blur, one channel, in place semantics (returns a new buffer). */
function blur3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1)
    const y1 = Math.min(h - 1, y + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1)
      const x1 = Math.min(w - 1, x + 1)
      let s = 0
      for (let yy = y0; yy <= y1; yy++) {
        const b = yy * w
        s += src[b + x0] + src[b + x] + src[b + x1]
      }
      out[y * w + x] = s / 9
    }
  }
  return out
}

/** Strongest |gradient| position (subpixel) along a 1-D profile, or null. */
function peakGradient(profile: number[]): { pos: number; mag: number } | null {
  let best = -1
  let mag = 0
  for (let i = 1; i < profile.length; i++) {
    const g = Math.abs(profile[i] - profile[i - 1])
    if (g > mag) {
      mag = g
      best = i
    }
  }
  if (best < 1) return null
  // Parabolic interpolation between the two samples spanning the step.
  const l = Math.abs(profile[best] - profile[best - 1])
  const r = best + 1 < profile.length ? Math.abs(profile[best + 1] - profile[best]) : l
  const frac = l + r > 0 ? (l / (l + r) - 0.5) * 0.5 : 0
  return { pos: best - 1 + frac + 0.5, mag }
}

/**
 * Re-fit the four edges of `quad` from image gradients and return the corners
 * where the fitted lines intersect. Points with weak gradients (shadow edges,
 * rounded corners, clutter) drop out; if an edge loses most of its samples the
 * original corner is kept for the sides that touch it.
 */
export function refineQuad(quad: Pt[], score: Uint8Array, w: number, h: number): Pt[] {
  const img = blur3(score, w, h)
  const grad = (x: number, y: number) => {
    const x0 = Math.max(0, Math.min(w - 1, Math.round(x)))
    const y0 = Math.max(0, Math.min(h - 1, Math.round(y)))
    return img[y0 * w + x0]
  }

  // Fit a total-least-squares line to the points on one edge; returns point + unit direction.
  const fitLine = (pts: Pt[]): { p: Pt; d: Pt } | null => {
    if (pts.length < 6) return null
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const p of pts) {
      sxx += (p.x - mx) ** 2
      sxy += (p.x - mx) * (p.y - my)
      syy += (p.y - my) ** 2
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    // Direction of largest variance.
    const d = { x: Math.cos(theta), y: Math.sin(theta) }
    return { p: { x: mx, y: my }, d }
  }

  const lines: ({ p: Pt; d: Pt } | null)[] = []
  // Ray samples per edge, kept for an adaptive strength cut: sheets on dim or
  // strongly shadowed desks have weak edges, so the threshold comes from the
  // edges themselves (half the median peak) instead of a fixed constant.
  const perEdge: { pt: Pt; mag: number }[][] = []
  const mags: number[] = []
  for (let e = 0; e < 4; e++) {
    const a = quad[e]
    const b = quad[(e + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    // Outward normal = the normal pointing away from the quad centroid.
    const cx = quad.reduce((s, p) => s + p.x, 0) / 4
    const cy = quad.reduce((s, p) => s + p.y, 0) / 4
    let nx = -uy
    let ny = ux
    const midx = (a.x + b.x) / 2 - cx
    const midy = (a.y + b.y) / 2 - cy
    if (nx * midx + ny * midy < 0) {
      nx = -nx
      ny = -ny
    }
    const reach = Math.max(6, Math.min(14, len * 0.04))
    const R = Math.ceil(reach)
    const pts: { pt: Pt; mag: number }[] = []
    const K = 40
    for (let k = 0; k < K; k++) {
      const t = 0.14 + (0.72 * k) / (K - 1) // skip the rounded corners
      const px = a.x + (b.x - a.x) * t
      const py = a.y + (b.y - a.y) * t
      const profile: number[] = []
      for (let s = -R; s <= R; s++) profile.push(grad(px + nx * s, py + ny * s))
      const peak = peakGradient(profile)
      if (!peak) continue
      const s = peak.pos - R - 0.5
      // Only trust peaks near the current edge (three quarters of the reach).
      if (Math.abs(s) > reach * 0.75) continue
      const pt = { x: px + nx * s, y: py + ny * s }
      pts.push({ pt, mag: peak.mag })
      mags.push(peak.mag)
    }
    perEdge.push(pts)
  }
  mags.sort((x, y) => x - y)
  const medianMag = mags.length ? mags[mags.length >> 1] : 0
  const magCut = Math.max(3.5, 0.45 * medianMag)

  for (let e = 0; e < 4; e++) {
    const inliers = perEdge[e].filter((p) => p.mag >= magCut).map((p) => p.pt)
    let line = fitLine(inliers)
    // One robustness pass: drop points far from the first fit, then refit.
    if (line && inliers.length >= 8) {
      const resid = inliers.map((p) => Math.abs((p.x - line!.p.x) * line!.d.y - (p.y - line!.p.y) * line!.d.x))
      const sorted = resid.slice().sort((x, y) => x - y)
      const cut = Math.max(1.5, 2.5 * sorted[sorted.length >> 1])
      line = fitLine(inliers.filter((_, i) => resid[i] <= cut))
    }
    lines.push(line)
  }

  const intersect = (
    l1: { p: Pt; d: Pt } | null,
    l2: { p: Pt; d: Pt } | null,
    fallback: Pt,
  ): Pt => {
    if (!l1 || !l2) return fallback
    const det = l1.d.x * l2.d.y - l1.d.y * l2.d.x
    if (Math.abs(det) < 1e-6) return fallback
    const dx = l2.p.x - l1.p.x
    const dy = l2.p.y - l1.p.y
    const t = (dx * l2.d.y - dy * l2.d.x) / det
    const out = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t }
    // Reject wild refinements: a corner may move at most 4% of the image diagonal.
    if (Math.hypot(out.x - fallback.x, out.y - fallback.y) > Math.hypot(w, h) * 0.04) return fallback
    return out
  }

  const refined = orderQuad([
    intersect(lines[3], lines[0], quad[0]),
    intersect(lines[0], lines[1], quad[1]),
    intersect(lines[1], lines[2], quad[2]),
    intersect(lines[2], lines[3], quad[3]),
  ])
  const area = polygonArea(quad)
  const area2 = polygonArea(refined)
  // A refinement that changed the sheet's size by a third is not a refinement.
  if (!Number.isFinite(area2) || area2 < area * 0.66 || area2 > area * 1.5) return quad
  if (validateQuad(refined, w, h)) return quad
  return refined
}

/**
 * Find the sheet in a paper-score image (w x h). Tries several thresholds and
 * closing radii, keeps the largest valid quad, then refines its edges.
 */
/** Paper and desk levels from the smoothed score histogram: the paper is the
 * brightest well-attended mode, the desk the biggest mode well below it. */
export function paperAndDeskLevels(score: Uint8Array): { paper: number; desk: number } {
  const hist = new Float64Array(256)
  for (let i = 0; i < score.length; i++) hist[score[i]]++
  const sm = new Float64Array(256)
  const ker = [1, 4, 6, 4, 1]
  for (let v = 0; v < 256; v++) {
    let acc = 0
    for (let k = -2; k <= 2; k++) acc += hist[Math.max(0, Math.min(255, v + k))] * ker[k + 2]
    sm[v] = acc
  }
  let paper = 255
  let best = 0
  for (let v = 128; v < 256; v++) {
    if (sm[v] > best) {
      best = sm[v]
      paper = v
    }
  }
  let desk = Math.max(0, paper - 80)
  best = 0
  for (let v = 0; v < paper - 25; v++) {
    if (sm[v] > best) {
      best = sm[v]
      desk = v
    }
  }
  return { paper, desk }
}

export function findPaperQuad(score: Uint8Array, w: number, h: number, diag?: { log: string[] }): QuadResult {
  const D = (t: string) => diag?.log.push(t)
  // Two independent candidate sources, because neither wins everywhere:
  //   - the bright-blob path is precise when the sheet contrasts with the desk;
  //   - the Hough path survives shadows, dark desks and low contrast, because
  //     the sheet boundary is a long straight edge even when the step is small.
  // Both are scored by the same edge-support measure and the winner is refined.
  const baseR = Math.max(2, Math.round(0.008 * Math.max(w, h)))
  const candidates: Pt[][] = []
  const bright = new Uint8Array(w * h)
  const { paper, desk } = paperAndDeskLevels(score)
  const thr = Math.round(desk + (paper - desk) * 0.5)
  for (let i = 0; i < bright.length; i++) bright[i] = score[i] >= thr ? 1 : 0
  for (const r of [baseR, baseR * 2]) {
    const c = quadFromMask(bright, score, w, h, r)
    D(`blob r=${r}: ` + (c ? JSON.stringify(c.quad.map((p) => [p.x | 0, p.y | 0])) : 'null'))
    if (c) candidates.push(c.quad)
  }
  const hq = houghQuad(score, w, h)
  D('hough: ' + (hq ? JSON.stringify(hq.map((p) => [p.x | 0, p.y | 0])) : 'null'))
  if (hq) candidates.push(hq)
  if (diag) {
    for (const q of candidates) {
      D(`cand ${JSON.stringify(q.map((p) => [p.x | 0, p.y | 0]))}: sup=${segmentSupportDbg(q, score, w, h).toFixed(3)} area=${(polygonArea(q) / (w * h)).toFixed(3)}`)
    }
  }

  let best: Pt[] | null = null
  let bestScore = -1
  for (const q of candidates) {
    // The sheet is the biggest quadrilateral whose sides sit on real image
    // edges: area-biased segment support. Hybrids that borrow a pen stroke for
    // one side cover only a small area, dim quads off the paper are unsupported.
    const sup = segmentSupportDbg(q, score, w, h)
    if (sup < 0.55) continue
    const s = sup * Math.pow(polygonArea(q) / (w * h), 0.3)
    if (s > bestScore) {
      bestScore = s
      best = q
    }
  }
  if (!best) return { quad: null, reason: 'no bright sheet found' }
  const refined = refineQuad(best, score, w, h)
  const bad = validateQuad(refined, w, h)
  if (bad) return { quad: null, reason: bad }
  return { quad: refined, reason: '' }
}

/* ------------------------------------------------------------------ */
/* Edge-based candidate (Hough)                                        */
/* ------------------------------------------------------------------ */

/** A line as point + unit direction. */
interface Line {
  px: number
  py: number
  dx: number
  dy: number
  votes: number
}

/** Fraction of each quad edge that is a real step edge (gap-tolerant). */
function segmentSupport(quad: Pt[], score: Uint8Array, w: number, h: number): number {
  const at = (x: number, y: number): number => {
    const xi = Math.max(0, Math.min(w - 1, Math.round(x)))
    const yi = Math.max(0, Math.min(h - 1, Math.round(y)))
    return score[yi * w + xi]
  }
  let worst = 1
  for (let e = 0; e < 4; e++) {
    const a = quad[e]
    const b = quad[(e + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 8) return 0
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const nx = -uy
    const ny = ux
    let supported = 0
    let total = 0
    for (let t = 0; t <= len; t += 2) {
      const x = a.x + ux * t
      const y = a.y + uy * t
      if (x < 5 || y < 5 || x >= w - 5 || y >= h - 5) continue
      total++
      // Step height across the edge: mean of the two sides at 2..4 px out.
      const pos = (at(x + nx * 2, y + ny * 2) + at(x + nx * 3, y + ny * 3) + at(x + nx * 4, y + ny * 4)) / 3
      const neg = (at(x - nx * 2, y - ny * 2) + at(x - nx * 3, y - ny * 3) + at(x - nx * 4, y - ny * 4)) / 3
      if (Math.abs(pos - neg) >= 6) supported++
    }
    if (total < 4) return 0
    worst = Math.min(worst, supported / total)
  }
  return worst
}

/** Test helper for the lab. */
export function segmentSupportDbg(quad: Pt[], score: Uint8Array, w: number, h: number): number {
  return segmentSupport(quad, score, w, h)
}

/**
 * Re-fit a candidate line from the edge pixels it explains: gradient-weighted
 * total least squares over pixels within 4 px that share the line's orientation.
 * This snaps a coarse Hough bin onto the true edge, which matters because a
 * tilt of one degree over a 600 px edge is ten pixels of drift.
 */
function refitLine(l: Line, mag: Float32Array, dir: Float32Array, w: number, h: number, cut: number): Line {
  let sw = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  const step = 3
  for (let t = -Math.hypot(w, h); t <= Math.hypot(w, h); t += step) {
    const cx = Math.round(l.px + l.dx * t)
    const cy = Math.round(l.py + l.dy * t)
    for (let oy = -4; oy <= 4; oy++) {
      for (let ox = -4; ox <= 4; ox++) {
        const x = cx + ox
        const y = cy + oy
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue
        const i = y * w + x
        if (mag[i] < cut) continue
        // Orientation must match the line's direction (wrapped to [0, PI)).
        let a = dir[i]
        if (a < 0) a += Math.PI
        const ld = Math.atan2(l.dy, l.dx)
        let diff = Math.abs(a - ld)
        if (diff > Math.PI / 2) diff = Math.PI - diff
        if (diff > 0.17) continue
        const d = Math.abs((x - l.px) * l.dy - (y - l.py) * l.dx)
        if (d > 4) continue
        const wgt = mag[i]
        sw += wgt
        sx += x * wgt
        sy += y * wgt
        sxx += x * x * wgt
        sxy += x * y * wgt
        syy += y * y * wgt
      }
    }
  }
  if (sw < cut * 20) return l
  const mx = sx / sw
  const my = sy / sw
  const cxx = sxx / sw - mx * mx
  const cyy = syy / sw - my * my
  const cxy = sxy / sw - mx * my
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta), votes: l.votes }
}

/**
 * Four dominant straight edges as a quad. Sobel gradients vote in a
 * (orientation, distance) Hough grid; peaks become lines; the best valid
 * 4-line combination (by total edge support) wins. Returns null when the
 * image has no convincing quadrilateral.
 */
export function houghQuad(score: Uint8Array, w: number, h: number, diag?: { peaks: Line[]; bestScore: number; valid: number }): Pt[] | null {
  // Sobel gradient magnitude.
  const mag = new Float32Array(w * h)
  const dir = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = score[i - w - 1], tc = score[i - w], tr = score[i - w + 1]
      const ml = score[i - 1], mr = score[i + 1]
      const bl = score[i + w - 1], bc = score[i + w], br = score[i + w + 1]
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      mag[i] = Math.hypot(gx, gy)
      if (mag[i] > 0) dir[i] = Math.atan2(gy, gx)
    }
  }
  // Edge pixels: a low fixed cut. The sheet boundary can be a small step
  // (a few gray levels) when shadow crosses it, so anything stronger than
  // faint sensor noise votes; the Hough integration does the filtering.
  const cut = 8
  const diagLen = Math.ceil(Math.hypot(w, h))
  const PHI = 240 // 0.75-degree bins, so tilted sheet edges stay in one bin
  const RHO = 1
  const NR = Math.ceil((2 * diagLen) / RHO)
  const votes = new Float32Array(PHI * NR)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (mag[i] < cut) continue
      // phi = orientation of the line's normal, wrapped to [0, PI).
      let phi = dir[i]
      if (phi < 0) phi += Math.PI
      const pb = Math.min(PHI - 1, Math.floor((phi / Math.PI) * PHI))
      const rho = (x + 0.5) * Math.cos(phi) + (y + 0.5) * Math.sin(phi) + diagLen
      const rb = Math.max(0, Math.min(NR - 1, Math.round(rho / RHO)))
      votes[pb * NR + rb] += Math.min(30, mag[i])
    }
  }
  // Peak pick with non-maximum suppression.
  const peaks: Line[] = []
  const used = new Uint8Array(PHI * NR)
  const order = Array.from(votes.keys()).sort((a, b) => votes[b] - votes[a])
  for (const idx of order) {
    if (votes[idx] <= 0 || used[idx]) continue
    const pb = Math.floor(idx / NR)
    const rb = idx % NR
    // Suppress the neighbourhood so one edge yields one line.
    for (let dp = -3; dp <= 3; dp++) {
      for (let dr = -4; dr <= 4; dr++) {
        const pp = (pb + dp + PHI) % PHI
        const rr = rb + dr
        if (rr < 0 || rr >= NR) continue
        used[pp * NR + rr] = 1
      }
    }
    const phi = ((pb + 0.5) / PHI) * Math.PI
    const rho = (rb + 0.5) * RHO - diagLen
    peaks.push(refitLine({ px: rho * Math.cos(phi), py: rho * Math.sin(phi), dx: -Math.sin(phi), dy: Math.cos(phi), votes: votes[idx] }, mag, dir, w, h, cut))
    if (peaks.length >= 24) break
  }
  // A soft or tilted edge smears across neighbouring bins: the same physical
  // edge can appear as several peaks. Merge lines that are near-parallel and
  // pass close to each other, keeping the best refit.
  const merged: Line[] = []
  for (const l of peaks) {
    const twin = merged.find((m) => {
      // Unsigned angle: u and -u are the same direction for a line.
      const angle = Math.atan2(Math.abs(m.dx * l.dy - m.dy * l.dx), Math.abs(m.dx * l.dx + m.dy * l.dy))
      if (angle > 0.07) return false
      const d1 = Math.abs((l.px - m.px) * m.dy - (l.py - m.py) * m.dx)
      const d2 = Math.abs((m.px - l.px) * l.dy - (m.py - l.py) * l.dx)
      return Math.max(d1, d2) < 12
    })
    if (twin) {
      if (l.votes > twin.votes) Object.assign(twin, l)
    } else merged.push(l)
  }
  if (diag) diag.peaks = merged
  if (merged.length < 4) return null

  const intersect = (l1: Line, l2: Line): Pt | null => {
    const det = l1.dx * l2.dy - l1.dy * l2.dx
    if (Math.abs(det) < 1e-9) return null
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det
    return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t }
  }

  // Longest contiguous stretch of real edge along each candidate line. Sheet
  // edges run most of the frame; a pen stroke that happens to be straight
  // supports its line for only its own short length, which is what keeps
  // drawings from being mistaken for the sheet.
  const cut2 = cut / 2
  const supportLen = (l: Line): number => {
    // Clip the parameter range so q(t) stays near the image.
    const tMin = -diagLen
    const tMax = diagLen
    let run = 0
    let best = 0
    let gap = 0
    for (let t = tMin; t <= tMax; t += 2) {
      const x = l.px + l.dx * t
      const y = l.py + l.dy * t
      if (x < 1 || y < 1 || x >= w - 2 || y >= h - 2) {
        best = Math.max(best, run)
        run = 0
        continue
      }
      let m = 0
      for (let s = -2; s <= 2; s++) {
        const xi = Math.round(x - l.dy * s)
        const yi = Math.round(y + l.dx * s)
        if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue
        m = Math.max(m, mag[yi * w + xi])
      }
      if (m >= cut2) {
        run += 2
        gap = 0
      } else if (++gap > 6) {
        best = Math.max(best, run)
        run = 0
      }
    }
    return Math.max(best, run)
  }
  for (const p of peaks) p.votes = supportLen(p)

  // Sort by unoriented line angle. Doubling the angle removes the 0/pi seam:
  // lines then live on a true circle, and consecutive lines in this cyclic
  // order always intersect into a convex polygon.
  const canon = (l: Line) => {
    const a = Math.atan2(l.dy, l.dx)
    return 2 * (a < 0 ? a + Math.PI : a)
  }
  const byAngle = peaks
    .map((l) => ({ l, a: canon(l) }))
    .sort((a, b) => a.a - b.a)
    .map((e) => e.l)

  let bestQuad: Pt[] | null = null
  let bestScore = 0
  const n = byAngle.length
  const idx: number[] = [0, 1, 2, 3]
  const tryCombo = () => {
    attempts++
    const L = idx.map((k) => byAngle[k])
    // The weakest edge bounds the quad: all four edges must be long.
    const weak = Math.min(...L.map((l) => l.votes))
    if (weak < Math.max(w, h) * 0.3) {
      weakFail++
      return
    }
    // Which lines pair up as opposite sides is not known in advance (a sheet
    // is often near-rectangular: its two long edges are parallel). The three
    // distinct cyclic orders of four lines cover every opposite-pair choice;
    // geometry validation picks the right one.
    for (const order of [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3]]) {
      const verts: Pt[] = []
      let ok = true
      for (let e = 0; e < 4; e++) {
        const p = intersect(L[order[e]], L[order[(e + 1) % 4]])
        if (!p) {
          ok = false
          break
        }
        verts.push(p)
      }
      if (!ok) {
        detFail++
        continue
      }
      const quad = orderQuad(verts)
      const bad = validateQuad(quad, w, h)
      if (bad) {
        valFail++
        lastBad = bad
        continue
      }
      // Score on the quad's own segments: a winning sheet quad is edged along
      // its full sides, while hybrids (a drawing edge standing in for a sheet
      // edge) leave most of one side unsupported.
      const seg = segmentSupport(quad, score, w, h)
      if (diag) diag.valid++
      if (seg > bestScore) {
        bestScore = seg
        bestQuad = quad
      }
    }
  }
  let attempts = 0
  let weakFail = 0
  let detFail = 0
  let valFail = 0
  let lastBad = ''
  const combos = (start: number, depth: number) => {
    if (depth === 4) return tryCombo()
    for (let k = start; k <= n - (4 - depth); k++) {
      idx[depth] = k
      combos(k + 1, depth + 1)
    }
  }
  combos(0, 0)
  if (diag) {
    diag.bestScore = bestScore
    ;(diag as unknown as Record<string, number | string>).attempts = attempts
    ;(diag as unknown as Record<string, number | string>).weakFail = weakFail
    ;(diag as unknown as Record<string, number | string>).detFail = detFail
    ;(diag as unknown as Record<string, number | string>).valFail = valFail
    ;(diag as unknown as Record<string, number | string>).lastBad = lastBad
  }
  // A candidate must actually sit on image edges.
  return bestQuad
}

/**
 * Mean normalised edge strength under the quad's four edges: 1.0 when a strong
 * gradient runs along every sample, 0 when the edges sit on flat image areas.
 */
export function edgeSupport2(quad: Pt[], score: Uint8Array, w: number, h: number): number {
  return edgeSupport(quad, score, w, h)
}

function edgeSupport(quad: Pt[], score: Uint8Array, w: number, h: number): number {
  const grad = (x: number, y: number): number => {
    const xi = Math.max(1, Math.min(w - 2, Math.round(x)))
    const yi = Math.max(1, Math.min(h - 2, Math.round(y)))
    const i = yi * w + xi
    const gx = score[i + 1] - score[i - 1]
    const gy = score[i + w] - score[i - w]
    return Math.hypot(gx, gy)
  }
  let sum = 0
  let cnt = 0
  for (let e = 0; e < 4; e++) {
    const a = quad[e]
    const b = quad[(e + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1) return 0
    const nx = (-(b.y - a.y) / len) * 2
    const ny = ((b.x - a.x) / len) * 2
    for (let k = 0; k < 20; k++) {
      const t = 0.1 + (0.8 * k) / 19
      const px = a.x + (b.x - a.x) * t
      const py = a.y + (b.y - a.y) * t
      let m = 0
      for (let s = -2; s <= 2; s++) m = Math.max(m, grad(px + nx * s, py + ny * s))
      sum += Math.min(1, m / 10)
      cnt++
    }
  }
  return cnt ? sum / cnt : 0
}

/** Work-copy RGBA of a canvas (long side <= WORK_MAX) and its size. */
/** Pure core: detect the sheet from raw RGBA pixels (used by the browser and the test harness). */
export function detectPaperRgba(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number): DetectResult {
  const k = Math.min(1, WORK_MAX / Math.max(W, H))
  const w = Math.max(2, Math.round(W * k))
  const h = Math.max(2, Math.round(H * k))
  // Box-downsample the source into the working grid.
  const score = new Uint8Array(w * h)
  const step = 1 / k
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * step)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * step))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * step)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * step))
      let r = 0
      let g = 0
      let b = 0
      let cnt = 0
      for (let sy = sy0; sy < sy1 && sy < H; sy++) {
        for (let sx = sx0; sx < sx1 && sx < W; sx++) {
          const j = (sy * W + sx) * 4
          r += rgba[j]
          g += rgba[j + 1]
          b += rgba[j + 2]
          cnt++
        }
      }
      if (!cnt) continue
      r /= cnt
      g /= cnt
      b /= cnt
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const v = ((r * 77 + g * 150 + b * 29) / 256) - Math.max(0, mx - mn - 20)
      score[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
  const r = findPaperQuad(score, w, h)
  if (!r.quad) return { quad: insetQuad(W, H), found: false, reason: r.reason }
  const quad = orderQuad(r.quad.map((p) => ({ x: (p.x + 0.5) / k, y: (p.y + 0.5) / k })))
  return { quad, found: true, reason: '' }
}

export interface DetectResult {
  /** Four corners TL TR BR BL in photo pixel coordinates (inset fallback when not found). */
  quad: Pt[]
  found: boolean
  reason: string
}

/**
 * Detect the paper quad in `photo` (pixel coordinates of the photo canvas).
 * Falls back to an inset quad, with found = false, when no plausible sheet is found.
 */
export function detectPaper(photo: HTMLCanvasElement): DetectResult {
  const ctx = photo.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { quad: insetQuad(photo.width, photo.height), found: false, reason: 'no bright sheet found' }
  const img = ctx.getImageData(0, 0, photo.width, photo.height)
  return detectPaperRgba(img.data, photo.width, photo.height)
}
