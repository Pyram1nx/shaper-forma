import { describe, expect, it } from 'vitest'
import { analyzeSides, heightMap, rotateToSide } from '../src/features/carve3d/sideAnalysis'
import { autoStageBits, buildMultiSidePlan, buildStages } from '../src/features/carve3d/multiSide'
import { buildCarvePlan, depthGrid, samplesPerLayer } from '../src/features/carve3d/carvePlan'
import { createMeshSlicer, sliceDetailed } from '../src/features/carve3d/slicer'
import { placeModel } from '../src/features/carve3d/loadModel'
import { BITS, coneHeight } from '../src/features/carve3d/bits'

/** Hemisphere of radius R on z=0 (closed with a base disc). */
function dome(R = 20, nu = 48, nv = 16): Float32Array {
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

/**
 * Closed solid of revolution around Z from a profile of (r, z) points (r >= 0), outward normals.
 */
function revolve(profile: [number, number][], nseg = 64): Float32Array {
  const tris: number[] = []
  const V = (r: number, z: number, j: number) => {
    const th = (j / nseg) * 2 * Math.PI
    return [r * Math.cos(th), r * Math.sin(th), z]
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i]
    const [r1, z1] = profile[i + 1]
    if (r0 === 0 && r1 === 0) continue
    for (let j = 0; j < nseg; j++) {
      const a = V(r0, z0, j), b = V(r1, z1, j), c = V(r1, z1, j + 1), d = V(r0, z0, j + 1)
      tris.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
  }
  let vol = 0
  for (let i = 0; i < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(i, i + 9)
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  if (vol < 0) {
    for (let i = 0; i < tris.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = tris[i + 3 + k]
        tris[i + 3 + k] = tris[i + 6 + k]
        tris[i + 6 + k] = t
      }
    }
  }
  return new Float32Array(tris)
}

/** Axis-aligned box as 12 outward triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ]
  const out: number[] = []
  for (const [a, b, c, d] of quads) for (const tri of [[a, b, c], [a, c, d]]) for (const i of tri) out.push(...p[i])
  return new Float32Array(out)
}

const placed = (raw: Float32Array) => placeModel(raw, 'mm', 'z', null)

describe('heightMap', () => {
  it('reads the top of a box everywhere under it', () => {
    const m = heightMap(placed(box(0, 0, 0, 10, 8, 4)), 1, 'max')
    expect(m.nx).toBeGreaterThan(1)
    let minH = Infinity
    for (let k = 0; k < m.h.length; k++) minH = Math.min(minH, m.h[k])
    expect(minH).toBeCloseTo(4, 5)
  })

  it('min mode reads the bottom of a sitting box as 0', () => {
    const m = heightMap(placed(box(0, 0, 0, 10, 8, 4)), 1, 'min')
    let maxH = -Infinity
    for (let k = 0; k < m.h.length; k++) maxH = Math.max(maxH, m.h[k])
    expect(maxH).toBeCloseTo(0, 5)
  })
})

describe('rotateToSide', () => {
  it('brings the chosen face up and re-normalises the placement', () => {
    const tall = placed(box(-1, -1.5, 0, 1, 1.5, 10)) // 2 × 3 × 10
    const right = rotateToSide(tall, 'right')
    expect(right.size.x).toBeCloseTo(10)
    expect(right.size.z).toBeCloseTo(2)
    expect(right.bbox.min.z).toBeCloseTo(0)
  })
})

describe('analyzeSides', () => {
  it('a dome: work on top and one face per axis pair, nothing on the bottom', () => {
    const a = analyzeSides(placed(dome()), 1)
    expect(a.top.needed).toBe(true)
    expect(a.top.cutDepth).toBeGreaterThan(19) // open columns outside the footprint
    expect(a.bottom.needed).toBe(false) // the dome sits on the stock bottom
    expect(a.left.needed).not.toBe(a.right.needed) // a symmetric silhouette: one face wins the pair
    expect(a.front.needed).not.toBe(a.back.needed)
    expect(a.left.cutDepth).toBeGreaterThan(19)
  })

  it('a conical glass: the cavity is claimed by the top, the cone by a side face', () => {
    // Outer cone widening upward (r 18 → 25 over z 0..10), cavity floor at z = 2.
    const glass = revolve([
      [0, 0], [18, 0], [25, 10], [14, 10], [0, 2],
    ])
    const a = analyzeSides(placed(glass), 1)
    expect(a.top.needed).toBe(true)
    expect(a.top.cutDepth).toBeGreaterThan(7.5) // down to the cavity floor
    // Open margin columns around the rim read as the full model depth — that waste is carved
    // through from the top, so the deepest claimed column is the full height, not just the cavity.
    expect(a.top.cutDepth).toBeLessThan(10.5)
    expect(a.bottom.needed).toBe(false)
    expect(a.left.needed || a.right.needed).toBe(true) // the conical outside
    expect(a.front.needed || a.back.needed).toBe(true)
  })
})

describe('buildStages', () => {
  const sel = { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: 'SE1-2500-V60E' }
  const opts = { finishAllowance: 1, engraveDepth: 1.5, stepDown: 2 }
  const v60 = BITS.find((b) => b.sku === 'SE1-2500-V60E')!

  it('splits the depth: rough short, detail to the bottom, engrave on top of the finish', () => {
    const stages = buildStages(10, sel, opts)
    expect(stages.map((s) => s.role)).toEqual(['rough', 'detail', 'engrave'])
    expect(stages[0].depthFrom).toBe(0)
    expect(stages[0].depthTo).toBeCloseTo(9)
    expect(stages[1].depthFrom).toBeCloseTo(9)
    expect(stages[1].depthTo).toBeCloseTo(10)
    expect(stages[2].depthFrom).toBeCloseTo(10 - Math.min(1.5, coneHeight(v60)))
    expect(stages[2].depthTo).toBeCloseTo(10)
    // Roughing takes the coarse step-down of its own bit.
    expect(stages[0].stepDown).toBeGreaterThan(stages[1].stepDown)
  })

  it('degrades gracefully: no bits, no stages; engrave-only still ends at the face depth', () => {
    expect(buildStages(10, { rough: null, detail: null, engrave: null }, opts)).toEqual([])
    const only = buildStages(10, { rough: null, detail: null, engrave: sel.engrave }, opts)
    expect(only).toHaveLength(1)
    expect(only[0].depthTo).toBeCloseTo(10)
  })

  it('shallow work skips pointless stages', () => {
    const stages = buildStages(0.8, sel, opts)
    expect(stages.every((s) => s.role !== 'rough')).toBe(true)
    expect(stages[stages.length - 1].depthTo).toBeCloseTo(0.8)
  })
})

describe('buildMultiSidePlan', () => {
  it('plans every enabled face in stages, with bridges where the carve frees the part', async () => {
    const plan = await buildMultiSidePlan(placed(dome()), {
      sides: ['top', 'bottom', 'left', 'right', 'front', 'back'],
      bits: { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: 'SE1-2500-V60E' },
      finishAllowance: 1,
      engraveDepth: 1.5,
      stepDown: 5,
      margin: 5,
      stockThickness: 20,
      bridges: { count: 2, width: 5, height: 1 },
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      key: 'test',
    })
    expect(plan.sides.length).toBeGreaterThanOrEqual(3) // top + one face per side axis
    expect(plan.sides[0].side).toBe('top')
    for (const s of plan.sides) {
      expect(s.stages.length).toBeGreaterThan(0)
      expect(s.plans.length).toBe(s.stages.length)
      for (const p of s.plans) expect(p.layers.length).toBeGreaterThan(0)
    }
    // Every shape name carries its side, so the job packet reads per setup.
    for (const s of plan.shapes) expect(plan.sides.some((side) => s.name.startsWith(`${side.label} · `))).toBe(true)
    // The top carve reaches the stock bottom face: it frees the part and leaves bridges.
    const top = plan.sides[0]
    expect(top.freeing).toBe(true)
    const last = top.plans[top.plans.length - 1]
    expect(last.throughCut).toBe(true)
    expect(last.tabs).not.toBeNull()
    expect(plan.shapes.length).toBeGreaterThan(0)
    expect(plan.info.sides).toBe(plan.sides.length)
  })

  it('skips faces that are flush with the model', async () => {
    const plan = await buildMultiSidePlan(placed(dome()), {
      sides: ['bottom'],
      bits: { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: null },
      finishAllowance: 1,
      engraveDepth: 1.5,
      stepDown: 5,
      margin: 5,
      stockThickness: 20,
      bridges: { count: 0, width: 5, height: 1 },
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      key: 'test2',
    })
    expect(plan.sides).toHaveLength(0)
    expect(plan.warnings.some((w) => w.includes('Nothing to carve'))).toBe(true)
  })
})

describe('carve plan startDepth', () => {
  const flat = { id: 't-flat', name: 'test flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Parameters<typeof buildCarvePlan>[2]['bit']
  it('only produces layers below the start depth, with the prefix on every name', async () => {
    const plan = await buildCarvePlan(dome(), 20, {
      bit: flat,
      stepDown: 4,
      stockThickness: 12,
      startDepth: 6,
      margin: 5,
      throughCut: false,
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      labelPrefix: 'Top · Rough',
    })
    expect(plan.layers.map((l) => l.depth)).toEqual([10, 12])
    expect(plan.layers.every((l) => l.depth > 6)).toBe(true)
    for (const s of plan.shapes) expect(s.name.startsWith('Top · Rough · ')).toBe(true)
  })
})

describe('autoStageBits', () => {
  it('picks a big rougher, a finer detail bit and a V-bit', () => {
    const sel = autoStageBits()
    expect(sel.rough).toBeTruthy()
    expect(sel.detail).toBeTruthy()
    expect(sel.engrave).toBeTruthy()
    expect(sel.rough).not.toBe(sel.detail)
  })
})

describe('createMeshSlicer', () => {
  it('candidate pruning gives the same sections as full slicing', () => {
    const mesh = dome()
    const slicer = createMeshSlicer(mesh)
    for (const z of [0.5, 3, 11.3, 19.5]) {
      const fast = slicer.slice(z)
      const full = sliceDetailed(mesh, z)
      expect(fast.contours.length).toBe(full.contours.length)
      expect(fast.openChains).toBe(full.openChains)
      for (let i = 0; i < fast.contours.length; i++)
        expect(fast.contours[i].pts.length).toBe(full.contours[i].pts.length)
    }
  })
})

describe('samplesPerLayer cap', () => {
  it('honours the cap for V-bits and stays at 1 for flat bits', () => {
    const v60 = BITS.find((b) => b.sku === 'SE1-2500-V60E')!
    const flat = BITS.find((b) => b.type === 'flat')!
    expect(samplesPerLayer(v60, 1.5)).toBeGreaterThan(12)
    expect(samplesPerLayer(v60, 1.5, 12)).toBe(12)
    expect(samplesPerLayer(flat, 5, 12)).toBe(1)
  })
})

describe('shared slice cache', () => {
  const flat = { id: 't-flat', name: 'test flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Parameters<typeof buildCarvePlan>[2]['bit']
  const settings = {
    bit: flat,
    stepDown: 4,
    stockThickness: 12,
    margin: 5,
    throughCut: false,
    outputs: { contour: false, toolpath: true, pocket: false },
    units: 'mm',
  } as const
  it('a plan built from a pre-populated cache matches a plan that slices itself', async () => {
    const mesh = dome()
    const solo = await buildCarvePlan(mesh, 20, { ...settings })
    // Pre-slice at exactly the depths the plan will need (as the multi-side planner does).
    const shared = new Map()
    for (const d of depthGrid(12, 4, 1)) shared.set(Math.round(d * 1e6), createMeshSlicer(mesh).slice(20 - Math.max(d, 1e-4)))
    const withCache = await buildCarvePlan(mesh, 20, { ...settings }, undefined, undefined, { slices: shared })
    expect(withCache.layers.map((l) => l.depth)).toEqual(solo.layers.map((l) => l.depth))
    expect(withCache.layers.map((l) => l.contours)).toEqual(solo.layers.map((l) => l.contours))
  })
})
