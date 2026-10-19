// Web worker for the multi-side planner. Slicing, clipper booleans and the analysis are all
// pure JS on typed arrays, so they run happily off the UI thread; the page never blocks.
// One analyze message and one plan message per run; ids let the client drop stale replies.
import type { PlacedModel } from './loadModel'
import { buildMultiSidePlan, type MultiSidePlan, type MultiSideSettings } from './multiSide'
import { analyzeSides, type SideAnalysis, type SideId } from './sideAnalysis'

type Req =
  | { type: 'analyze'; id: number; placed: PlacedModel }
  | { type: 'plan'; id: number; placed: PlacedModel; settings: MultiSideSettings }

type Res =
  | { type: 'analysis'; id: number; analysis: Record<SideId, SideAnalysis> }
  | { type: 'progress'; id: number; f: number }
  | { type: 'plan'; id: number; plan: MultiSidePlan }
  | { type: 'error'; id: number; message: string }

// `self` typing without pulling the WebWorker lib into the app's tsconfig.
const ctx = self as unknown as {
  postMessage: (m: Res) => void
  onmessage: ((e: MessageEvent<Req>) => void) | null
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))

ctx.onmessage = (e) => {
  const msg = e.data
  try {
    if (msg.type === 'analyze') {
      ctx.postMessage({ type: 'analysis', id: msg.id, analysis: analyzeSides(msg.placed) })
      return
    }
    // The plan run re-analyses first, so the face chips stay current even when the dialog
    // only asked for a plan.
    ctx.postMessage({ type: 'analysis', id: msg.id, analysis: analyzeSides(msg.placed) })
    buildMultiSidePlan(msg.placed, msg.settings, (f) => ctx.postMessage({ type: 'progress', id: msg.id, f }))
      .then((plan) => ctx.postMessage({ type: 'plan', id: msg.id, plan }))
      .catch((err: unknown) => ctx.postMessage({ type: 'error', id: msg.id, message: text(err) }))
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: text(err) })
  }
}
