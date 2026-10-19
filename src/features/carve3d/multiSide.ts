// Multi-sided carving: the planner that flips the block.
//
// A model inside a stock block is carved from several of the block's six faces; between setups
// the block is flipped, and through-cut bridges keep the part sitting in the block at the same
// position the whole time. Which faces need work comes from analyzeSides (column claiming, see
// sideAnalysis.ts). Each face is then carved in PROCESS STAGES: a roughing bit with a large
// step-down clears the bulk, a finer bit takes the finishing pass to the final surface, and an
// engraving V-bit adds the finest detail near the bottom. Every stage is a CarvePlan over its
// own depth range (carvePlan.startDepth), so the shape outputs stay per-layer and can be
// previewed and animated exactly like a single-sided plan.
import type { Shape, Units } from '../../model/types'
import { coneHeight, BITS, type Bit } from './bits'
import {
  buildCarvePlan,
  CarveCancelled,
  depthGrid,
  samplesPerLayer,
  type CarvePlan,
  type PlanContext,
  type TabSettings,
} from './carvePlan'
import type { PlacedModel } from './loadModel'
import { analyzeSides, SIDE_LABEL, SIDE_ORDER, rotateToSide, type SideAnalysis, type SideId } from './sideAnalysis'
import { createMeshSlicer, yieldFrame, type SliceResult } from './slicer'

export { SIDE_LABEL, SIDE_ORDER }
export type { SideId }

export type StageRole = 'rough' | 'detail' | 'engrave'

export const STAGE_LABEL: Record<StageRole, string> = { rough: 'Rough', detail: 'Detail', engrave: 'Engrave' }

/** Bit ids per stage role; null = stage off. */
export interface StageBits {
  rough: string | null
  detail: string | null
  engrave: string | null
}

/** Sensible defaults from the catalogue: biggest flat bit clears, a mid flat finishes, sharpest V engraves. */
export function autoStageBits(): StageBits {
  const carvable = BITS.filter((b) => b.carvable)
  const flats = carvable.filter((b) => b.type === 'flat').sort((a, b) => b.diameter - a.diameter)
  const rough = flats[0] ?? null
  // The finishing flat: mid-sized, clearly finer than the roughing bit.
  const detail =
    flats.find((b) => b !== rough && b.diameter <= (rough?.diameter ?? 0) / 2) ??
    flats[flats.length > 1 ? 1 : 0] ??
    null
  const engrave =
    carvable
      .filter((b) => b.type === 'vbit')
      .sort((a, b) => (b.angle ?? 90) - (a.angle ?? 90))[0] ?? null
  return { rough: rough?.id ?? null, detail: detail?.id ?? null, engrave: engrave?.id ?? null }
}

export interface SideStage {
  role: StageRole
  bit: Bit
  /** Depth range from the model's own face in this side's frame, mm (0 = the face itself). */
  depthFrom: number
  depthTo: number
  stepDown: number
}

/** A stage shallower than this is not worth switching bits for (mm). */
const MIN_STAGE = 0.2

/**
 * Split a face's carve depth [0, faceDepth] into stages. Rough stops `finishAllowance` short,
 * detail takes the finishing pass to the bottom, engrave re-cuts the last `engraveDepth` with
 * the V-bit's fine tip. The final stage always reaches the face depth.
 */
export function buildStages(
  faceDepth: number,
  sel: StageBits,
  opts: { finishAllowance: number; engraveDepth: number; stepDown: number },
): SideStage[] {
  const bit = (id: string | null): Bit | null => (id ? BITS.find((b) => b.id === id && b.carvable) ?? null : null)
  const out: SideStage[] = []
  let cursor = 0

  const rough = bit(sel.rough)
  if (rough && faceDepth - opts.finishAllowance > MIN_STAGE) {
    const to = faceDepth - opts.finishAllowance
    // Roughing takes a coarse step-down: the bit's own scale, never beyond its flutes.
    const step = Math.min(rough.fluteLength, Math.max(opts.stepDown, rough.diameter / 2))
    out.push({ role: 'rough', bit: rough, depthFrom: 0, depthTo: to, stepDown: step })
    cursor = to
  }

  const detail = bit(sel.detail)
  if (detail && faceDepth - cursor > MIN_STAGE) {
    out.push({ role: 'detail', bit: detail, depthFrom: cursor, depthTo: faceDepth, stepDown: opts.stepDown })
    cursor = faceDepth
  }

  const engrave = bit(sel.engrave)
  if (engrave && engrave.type === 'vbit' && faceDepth > 1) {
    // Keep the V-bit inside its cone, where it is actually finer than the detail bit.
    const d = Math.min(opts.engraveDepth, coneHeight(engrave), faceDepth - 1e-6)
    if (d > MIN_STAGE) out.push({ role: 'engrave', bit: engrave, depthFrom: Math.max(0, faceDepth - d), depthTo: faceDepth, stepDown: Math.max(MIN_STAGE, Math.min(opts.stepDown, d)) })
  }

  if (out.length && out[out.length - 1].depthTo < faceDepth - 1e-6) out[out.length - 1].depthTo = faceDepth
  return out
}

export interface MultiSideSettings {
  sides: SideId[]
  bits: StageBits
  /** Material the rough stage leaves for the detail stage, mm. */
  finishAllowance: number
  /** How deep the engraving stage works into the final surface, mm. */
  engraveDepth: number
  stepDown: number
  margin: number
  stockThickness: number
  /** Bridges left on every side whose carve would free the part. */
  bridges: TabSettings
  outputs: { contour: boolean; toolpath: boolean; pocket: boolean }
  units: Units
  /** Identifies the inputs this plan was made from. */
  key?: string
}

export interface SideResult {
  side: SideId
  label: string
  /** The model in this side's frame (rotate to face up). */
  placed: PlacedModel
  /** Deepest claimed column from the model face, mm. */
  cutDepth: number
  /** Total carve depth from the stock face, mm (includes the block margin on side faces). */
  faceDepth: number
  /** True when this side's carve cuts through the stock and needs bridges. */
  freeing: boolean
  stages: SideStage[]
  plans: CarvePlan[]
  warnings: string[]
}

export interface MultiSidePlan {
  key: string
  sides: SideResult[]
  /** Every side's shapes, laid out side by side (one "sheet" per side). */
  shapes: Omit<Shape, 'id'>[]
  warnings: string[]
  info: Record<string, number | string>
}

/** Per-side setup facts shared by stage building and planning. */
interface SideSetup {
  side: SideId
  placed: PlacedModel
  analysis: SideAnalysis
  /** Stock face → model face distance in this side's frame (mm; the block margin on side faces). */
  marginZ: number
  /** Stock extent along this side's axis, from the stock face to the opposite face (mm). */
  faceExtent: number
  stages: SideStage[]
}

/**
 * Union of every stage's depth grid for one side, ascending — the slice pass below runs once
 * over this, and each stage plan then finds its depths already in the shared cache.
 */
function sideGrid(setup: SideSetup, cap: number): number[] {
  const keys = new Set<number>()
  for (const stage of setup.stages) {
    const T = Math.min(setup.placed.size.z, setup.marginZ + stage.depthTo)
    const n = samplesPerLayer(stage.bit, stage.stepDown, cap)
    for (const d of depthGrid(T, stage.stepDown, n)) keys.add(Math.round(d * 1e6))
  }
  return [...keys].sort((a, b) => a - b)
}

function setupSide(placed: PlacedModel, side: SideId, analysis: Record<SideId, SideAnalysis>, st: MultiSideSettings): SideSetup | null {
  const a = analysis[side]
  if (!a.needed) return null
  const S = rotateToSide(placed, side)
  const vertical = side === 'top' || side === 'bottom'
  // Vertical faces sit on the model face; the four side faces keep the block margin above it.
  const marginZ = vertical ? 0 : st.margin
  const stages = buildStages(a.cutDepth, st.bits, {
    finishAllowance: st.finishAllowance,
    engraveDepth: st.engraveDepth,
    stepDown: st.stepDown,
  })
  if (!stages.length) return null
  return {
    side,
    placed: S,
    analysis: a,
    marginZ,
    faceExtent: vertical ? Math.max(st.stockThickness, S.size.z) : S.size.z + 2 * st.margin,
    stages,
  }
}

/**
 * Build the full multi-sided plan: analyse the faces, then carve each enabled face in stages.
 * Yields between stages and throws CarveCancelled when `signal` aborts.
 */
export async function buildMultiSidePlan(
  placed: PlacedModel,
  st: MultiSideSettings,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<MultiSidePlan> {
  const analysis = analyzeSides(placed)
  const warnings: string[] = []
  const skipped: string[] = []

  const setups: SideSetup[] = []
  for (const side of SIDE_ORDER) {
    if (!st.sides.includes(side)) continue
    const s = setupSide(placed, side, analysis, st)
    if (s) setups.push(s)
    else if (analysis[side].needed) warnings.push(`${SIDE_LABEL[side]} face has work but no stage bit fits — pick a bit for it`)
    else skipped.push(SIDE_LABEL[side])
  }
  const total = setups.reduce((n, s) => n + s.stages.length, 0)
  if (!total) {
    return {
      key: st.key ?? '',
      sides: [],
      shapes: [],
      warnings: ['Nothing to carve: every enabled face is flush with the model.'],
      info: { sides: 0, stages: 0, layers: 0 },
    }
  }

  const sides: SideResult[] = []
  const shapes: Omit<Shape, 'id'>[] = []
  const info: Record<string, number | string> = { sides: setups.length, stages: total }
  let layers = 0
  let sheet = 0
  const pitch = SHEET_PITCH

  // V-bit stages sample their depth densely; capping the per-layer samples keeps the shared
  // grid light at a fraction-of-a-millimetre cost in forbidden-region accuracy.
  const SAMPLE_CAP = 12

  // Work units for progress: one per shared slice, one per stage plan.
  const perSide = setups.map((setup) => {
    const slicer = createMeshSlicer(setup.placed.positions)
    const grid = sideGrid(setup, SAMPLE_CAP)
    return { setup, slicer, grid }
  })
  const totalUnits = perSide.reduce((n, s) => n + s.grid.length + s.setup.stages.length, 0)
  let done = 0

  for (const { setup, slicer, grid } of perSide) {
    if (signal?.aborted) throw new CarveCancelled()
    const label = SIDE_LABEL[setup.side]
    // A side whose carve reaches the opposite stock face frees the part: it gets a through-cut
    // outline with bridges on its final stage, so the block still holds the piece when flipped.
    const freeing = setup.analysis.cutDepth + setup.marginZ >= setup.faceExtent - 0.05
    const warnings2: string[] = []
    const plans: CarvePlan[] = []

    // One slice pass over this side's whole depth grid, shared by every stage: the dominant
    // cost of planning, done once instead of once per bit.
    const shared: Map<number, SliceResult> = new Map()
    for (const key of grid) {
      if (signal?.aborted) throw new CarveCancelled()
      await yieldFrame()
      shared.set(key, slicer.slice(setup.placed.size.z - Math.max(key / 1e6, 1e-4)))
      onProgress?.(++done / totalUnits)
    }
    const ctx: PlanContext = { slices: shared, sampleCap: SAMPLE_CAP }

    for (let k = 0; k < setup.stages.length; k++) {
      const stage = setup.stages[k]
      const last = k === setup.stages.length - 1
      // The stock face of a side pair sits `marginZ` above the model face; depths from the
      // stock face therefore shift every layer boundary by that much.
      const plan = await buildCarvePlan(
        setup.placed.positions,
        setup.placed.size.z,
        {
          bit: stage.bit,
          stepDown: stage.stepDown,
          stockThickness: setup.marginZ + stage.depthTo,
          startDepth: setup.marginZ + stage.depthFrom,
          margin: st.margin,
          throughCut: freeing && last,
          tabs: st.bridges,
          outputs: st.outputs,
          units: st.units,
          labelPrefix: `${label} · ${STAGE_LABEL[stage.role]}`,
          key: `${st.key ?? ''}|${setup.side}|${k}`,
        },
        (f) => onProgress?.((done + f) / totalUnits),
        signal,
        ctx,
      )
      plans.push(plan)
      layers += plan.layers.length
      warnings2.push(...plan.warnings.map((w) => `${label} · ${STAGE_LABEL[stage.role]}: ${w}`))
      done++
      if (k === setup.stages.length - 1) shared.clear()
    }
    if (freeing) {
      const bridges = st.bridges.count
      warnings2.push(
        `${label} face cuts through the stock — leave the ${bridges} bridge${bridges === 1 ? '' : 's'} (${st.bridges.width} mm) so the part stays seated in the block for the next flip.`,
      )
    }
    sides.push({
      side: setup.side,
      label,
      placed: setup.placed,
      cutDepth: setup.analysis.cutDepth,
      faceDepth: setup.marginZ + setup.analysis.cutDepth,
      freeing,
      stages: setup.stages,
      plans,
      warnings: warnings2,
    })

    // Each side becomes its own sheet on the canvas, so the setups read like a job packet.
    const xoff = sheet * pitch
    for (const p of plans) for (const s of p.shapes) shapes.push({ ...s, x: s.x + xoff })
    sheet++
  }

  warnings.push(...sides.flatMap((s) => s.warnings))
  if (skipped.length) warnings.push(`Faces with nothing to carve: ${skipped.join(', ')}`)
  info.layers = layers
  info.bridges = sides.filter((s) => s.freeing).reduce((n) => n + st.bridges.count, 0)
  onProgress?.(1)
  return { key: st.key ?? '', sides, shapes, warnings, info }
}

/** Canvas sheet pitch between two sides' shape groups (mm). */
export const SHEET_PITCH = 400
