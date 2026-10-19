import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildCarvePlan, type CarvePlan } from '../src/features/carve3d/carvePlan'
import { defaultBit, type Bit } from '../src/features/carve3d/bits'
import { CarveAnimation } from '../src/features/carve3d/carveAnimation'
import { buildRoute, routeLength } from '../src/features/carve3d/toolRoute'
import { createHeightfield, worldRect } from '../src/features/carve3d/heightfield'
import type { Contour } from '../src/model/types'

/** Hemisphere of radius R on z=0 (closed with a base disc). */
function dome(R = 20, nu = 72, nv = 24): Float32Array {
  const t: number[] = []
  const P = (u: number, v: number) => {
    const th = (u / nu) * 2 * Math.PI
    const ph = (v / nv) * (Math.PI / 2)
    return [R * Math.cos(ph) * Math.cos(th), R * Math.cos(ph) * Math.sin(th), R * Math.sin(ph)]
  }
  for (let u = 0; u < nu; u++)
    for (let v = 0; v < nv; v++) {
      const a = P(u, v), b = P(u + 1, v), c = P(u + 1, v + 1), d = P(u, v + 1)
      t.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
  for (let u = 0; u < nu; u++) t.push(0, 0, 0, ...P(u + 1, 0), ...P(u, 0))
  return new Float32Array(t)
}

async function makePlan(): Promise<{ plan: CarvePlan; bit: Bit }> {
  const bit = defaultBit()
  const plan = await buildCarvePlan(dome(10, 48, 12), 10, {
    bit, stepDown: 2, stockThickness: 10, margin: 5, throughCut: false,
    outputs: { contour: false, toolpath: true, pocket: false }, units: 'mm',
  })
  return { plan, bit }
}

/** Even-odd point-in-polygon over a set of closed design-space contours. */
function inside(x: number, y: number, cs: Contour[]): boolean {
  let hit = false
  for (const c of cs) {
    if (!c.closed) continue
    const p = c.pts
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      if (p[a].y > y !== p[b].y > y && x < ((p[b].x - p[a].x) * (y - p[a].y)) / (p[b].y - p[a].y) + p[a].x) hit = !hit
    }
  }
  return hit
}

/** Distance from a point to the nearest edge of any contour. */
function edgeDistance(x: number, y: number, cs: Contour[]): number {
  let best = Infinity
  for (const c of cs) {
    const p = c.pts
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      const ex = p[a].x - p[b].x
      const ey = p[a].y - p[b].y
      const len2 = ex * ex + ey * ey || 1
      const u = Math.max(0, Math.min(1, ((x - p[b].x) * ex + (y - p[b].y) * ey) / len2))
      best = Math.min(best, Math.hypot(p[b].x + u * ex - x, p[b].y + u * ey - y))
    }
  }
  return best
}

describe('tool route', () => {
  it('reaches every layer depth, keeps the bit centre out of each layer region, and only travels above the model between contours', async () => {
    const { plan, bit } = await makePlan()
    const route = buildRoute(plan, bit)
    expect(route.length).toBeGreaterThan(0)

    for (const layer of plan.layers) {
      const tip = plan.modelH - layer.depth
      expect(route.some((p) => !p.rapid && Math.abs(p.z - tip) < 1e-9)).toBe(true)
    }

    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]
      const b = route[i]
      const horizontal = Math.hypot(b.x - a.x, b.y - a.y) > 1e-9
      if (b.rapid && horizontal) expect(b.z).toBeGreaterThanOrEqual(plan.modelH - 1e-9)
    }

    // Cutting points sit at one layer's tip height; check each against that layer's toolpath.
    let violations = 0
    for (const layer of plan.layers) {
      const tip = plan.modelH - layer.depth
      for (const p of route) {
        if (p.rapid || Math.abs(p.z - tip) > 1e-9) continue
        // Design space is y-down, the route is world (y up).
        const x = p.x
        const y = -p.y
        if (inside(x, y, layer.toolpath) && edgeDistance(x, y, layer.toolpath) > 0.05) violations++
      }
    }
    expect(violations).toBe(0)
    expect(routeLength(route)).toBeGreaterThan(0)
  })

  it('a route with no cuts is empty', () => {
    const empty = { layers: [], throughCut: false, modelH: 10, carveDepth: 0, stock: [], outline: [] } as unknown as CarvePlan
    expect(buildRoute(empty, defaultBit())).toEqual([])
  })
})

describe('carve animation', () => {
  it('carves to the deepest tip, keeps the model top, fires onComplete, and disposes cleanly', async () => {
    const { plan, bit } = await makePlan()
    const hf = createHeightfield(worldRect(plan.stock), plan.modelH, plan.modelH - plan.stockThickness, 20000)
    const parent = new THREE.Group()
    const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]
    const anim = new CarveAnimation({ parent, plan, bit, hf, solidMaterials: mats })
    let completed = 0
    anim.onComplete = () => completed++
    anim.setSpeed(50)
    anim.play()
    expect(anim.playing).toBe(true)

    for (let i = 0; i < 5000 && completed === 0; i++) anim.update(0.05)
    expect(completed).toBe(1)
    expect(anim.progress).toBe(1)
    expect(anim.playing).toBe(false)

    // Deepest tip is modelH − carveDepth (= 0 here); the stock outside the model reaches it.
    let minH = Infinity
    for (let k = 0; k < hf.h.length; k++) minH = Math.min(minH, hf.h[k])
    // Within one layer (stepDown = 2 mm) of the deepest tip.
    expect(Math.abs(minH - (plan.modelH - plan.carveDepth))).toBeLessThanOrEqual(2)

    // The model's apex was never cut.
    const i0 = Math.round((0 - hf.x0) / hf.dx)
    const j0 = Math.round((0 - hf.y0) / hf.dy)
    expect(Math.abs(hf.h[j0 * hf.nx + i0] - plan.modelH)).toBeLessThan(0.5)

    anim.dispose()
    expect(parent.children.length).toBe(0)
  })
})
