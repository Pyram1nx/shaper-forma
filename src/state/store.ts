import { create } from 'zustand'
import type { Contour, CutSettings, Group, ImportPayload, Mode, OriginRef, Pt, Shape, StudioDoc, Units } from '../model/types'
import { uid } from '../model/ids'
import type { DocHandle } from '../io/projectFile'
import { bake, bboxCenter, bboxH, bboxValid, bboxW, shapesBBox, type BBox } from '../geometry/transform'

export type Tool = 'select' | 'draw'
export type Dialog = null | 'text' | 'carve3d' | 'trace' | 'offset' | 'shortcuts' | 'account'
export type Popover = null | 'shapes' | 'settings'

export interface View {
  /** screen px per mm */
  zoom: number
  panX: number
  panY: number
}

const UNITS_KEY = 'shaperstudio:units'

/** Units the user last picked; new designs start in them. */
export function lastUnits(): Units {
  try {
    const u = localStorage.getItem(UNITS_KEY)
    if (u === 'mm' || u === 'in') return u
  } catch {
    /* no storage */
  }
  return 'in'
}

function rememberUnits(u: Units) {
  try {
    localStorage.setItem(UNITS_KEY, u)
  } catch {
    /* no storage */
  }
}

export function newDoc(name = 'Untitled-1'): StudioDoc {
  const now = new Date().toISOString()
  return {
    app: 'ShaperStudio',
    version: 1,
    id: uid('d'),
    name,
    units: lastUnits(),
    shapes: [],
    groups: [],
    settings: { smartAlignment: true, showPosition: false, originAnchor: false, cutPathDisplay: false },
    createdAt: now,
    updatedAt: now,
  }
}

/** Ids from `ids` that exist in the document and are not locked. Locked shapes are never edited. */
/** Drop groups that no shape refers to any more (e.g. after their last member was deleted). */
export function pruneGroups(doc: StudioDoc): StudioDoc {
  const used = new Set<string>()
  for (const s of doc.shapes) if (s.groupId) used.add(s.groupId)
  const groups = doc.groups.filter((g) => used.has(g.id))
  return groups.length === doc.groups.length ? doc : { ...doc, groups }
}

export function editableIds(ids: readonly string[], doc: StudioDoc = useStore.getState().doc): string[] {
  const want = new Set(ids)
  return doc.shapes.filter((s) => want.has(s.id) && !s.locked && !s.hidden).map((s) => s.id)
}

interface State {
  doc: StudioDoc
  mode: Mode
  tool: Tool
  /** Shape Anchor mode: the canvas shows the selection's nine anchor points until one is picked. */
  anchorPicking: boolean
  selection: string[]
  view: View
  viewport: { w: number; h: number }
  past: StudioDoc[]
  future: StudioDoc[]
  /** Timestamp of the last arrow-key nudge; consecutive nudges share one undo step. */
  lastNudge: number
  dialog: Dialog
  popover: Popover
  /** Ids of the shapes being edited in ShapeShifter (null = mode is off). */
  shifter: string[] | null
  menuOpen: boolean
  /** Text shape being edited (null = new text). */
  editingTextId: string | null
  dirty: boolean
  fileHandle: DocHandle | null
  toast: string | null

  // history
  checkpoint: () => void
  undo: () => void
  redo: () => void

  // document
  setDoc: (doc: StudioDoc, handle?: DocHandle | null) => void
  rename: (name: string) => void
  setUnits: (u: Units) => void
  setSetting: (k: keyof StudioDoc['settings'], v: boolean) => void
  setOriginPoint: (p: OriginRef) => void
  setCustomAnchor: (p: Pt) => void
  /** Remove the custom anchor marker; a free origin that came from it falls back to the centre. */
  clearCustomAnchor: () => void
  addShapes: (shapes: Shape[], select?: boolean) => void
  importPayload: (p: ImportPayload) => void
  /** Mutate shapes without a checkpoint (call checkpoint() first for undo). */
  patchShapes: (ids: string[], fn: (s: Shape) => Shape) => void
  /** checkpoint + patch */
  updateShapes: (ids: string[], fn: (s: Shape) => Shape) => void
  setCut: (ids: string[], cut: Partial<CutSettings>) => void
  deleteSelected: () => void
  duplicateSelected: (inPlace?: boolean) => void
  mirrorSelected: (axis: 'h' | 'v') => void
  replaceShapes: (removeIds: string[], add: Shape[]) => void
  bringToFront: () => void
  sendToBack: () => void
  /** Clear the locked flag on every shape (checkpointed). */
  unlockAll: () => void

  // selection / ui
  select: (ids: string[]) => void
  /** Select every unlocked shape of a group. Locked shapes are skipped. */
  selectGroup: (groupId: string) => void
  setMode: (m: Mode) => void
  setTool: (t: Tool) => void
  setAnchorPicking: (on: boolean) => void
  setView: (v: Partial<View>) => void
  setViewport: (w: number, h: number) => void
  zoomToFit: (bbox?: BBox) => void
  zoomBy: (factor: number, cx?: number, cy?: number) => void
  zoomIn: () => void
  zoomOut: () => void
  openDialog: (d: Dialog) => void
  setPopover: (p: Popover) => void
  /** Enter ShapeShifter with the unlocked selection. */
  enterShapeShifter: () => void
  exitShapeShifter: () => void
  setMenuOpen: (o: boolean) => void
  setEditingText: (id: string | null) => void
  setFileHandle: (h: DocHandle | null) => void
  /**
   * Mark the design as saved. Pass the document object that was written: if the
   * user has edited since, the design stays dirty.
   */
  markSaved: (savedDoc?: StudioDoc) => void
  showToast: (msg: string) => void
}

const HISTORY_LIMIT = 100
let toastTimer: ReturnType<typeof setTimeout> | undefined

let suppressCheckpoints = 0

/**
 * Run store mutations without adding undo entries, e.g. repeated arrow-key steps in
 * a field that belong to the same undo step as the first one.
 */
export function withoutCheckpoint(fn: () => void) {
  suppressCheckpoints++
  try {
    fn()
  } finally {
    suppressCheckpoints--
  }
}

export const useStore = create<State>((set, get) => {
  const touch = (doc: StudioDoc): StudioDoc => ({ ...doc, updatedAt: new Date().toISOString() })
  const commitDoc = (doc: StudioDoc) => set({ doc: touch(doc), dirty: true })

  return {
    doc: newDoc(),
    mode: 'design',
    tool: 'select',
    anchorPicking: false,
    selection: [],
    view: { zoom: 4, panX: 0, panY: 0 },
    viewport: { w: 1200, h: 800 },
    past: [],
    future: [],
    lastNudge: 0,
    dialog: null,
    popover: null,
    shifter: null,
    menuOpen: false,
    editingTextId: null,
    dirty: false,
    fileHandle: null,
    toast: null,

    checkpoint: () => {
      if (suppressCheckpoints > 0) return
      const { doc, past } = get()
      set({ past: [...past.slice(-HISTORY_LIMIT + 1), doc], future: [], lastNudge: 0 })
    },
    undo: () => {
      const { past, doc, future, selection } = get()
      if (!past.length) return
      // Keep the current view preferences (units, settings) — they aren't part of history.
      const prev = { ...past[past.length - 1], units: doc.units, settings: doc.settings }
      const ids = new Set(prev.shapes.map((s) => s.id))
      set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], selection: selection.filter((i) => ids.has(i)), dirty: true, lastNudge: 0 })
    },
    redo: () => {
      const { past, doc, future, selection } = get()
      if (!future.length) return
      const next = { ...future[0], units: doc.units, settings: doc.settings }
      const ids = new Set(next.shapes.map((s) => s.id))
      set({ doc: next, past: [...past, doc], future: future.slice(1), selection: selection.filter((i) => ids.has(i)), dirty: true, lastNudge: 0 })
    },

    setDoc: (doc, handle = null) => {
      set({ doc, past: [], future: [], selection: [], shifter: null, fileHandle: handle, dirty: false, mode: 'design', tool: 'select', popover: null, lastNudge: 0 })
      setTimeout(() => get().zoomToFit(), 0)
    },
    rename: (name) => {
      get().checkpoint()
      commitDoc({ ...get().doc, name: name.trim() || 'Untitled' })
    },
    // Units and settings are view preferences, not undo steps (undo/redo keep the current ones).
    setUnits: (units) => {
      if (get().doc.units === units) return
      rememberUnits(units)
      commitDoc({ ...get().doc, units })
    },
    setSetting: (k, v) => {
      commitDoc({ ...get().doc, settings: { ...get().doc.settings, [k]: v } })
    },
    setOriginPoint: (p) => {
      if (get().doc.settings.originPoint === p) return
      commitDoc({ ...get().doc, settings: { ...get().doc.settings, originPoint: p } })
    },
    setCustomAnchor: (p) => commitDoc({ ...get().doc, settings: { ...get().doc.settings, customAnchor: p } }),
    clearCustomAnchor: () => {
      const { doc } = get()
      const freeOrigin = typeof doc.settings.originPoint === 'object'
      commitDoc({
        ...doc,
        settings: { ...doc.settings, customAnchor: undefined, ...(freeOrigin ? { originPoint: 'mc' as const } : {}) },
      })
    },

    addShapes: (shapes, selectThem = true) => {
      get().checkpoint()
      const doc = get().doc
      commitDoc({ ...doc, shapes: [...doc.shapes, ...shapes] })
      if (selectThem) set({ selection: shapes.map((s) => s.id) })
    },
    importPayload: (p) => {
      const g: Group = { ...p.group, id: uid('g') }
      const shapes: Shape[] = p.shapes.map((s) => ({ ...s, id: uid(), groupId: g.id }) as Shape)
      const warnings = p.warnings ?? []
      if (!shapes.length) {
        get().showToast(warnings[0] ?? 'Nothing to import')
        return
      }
      // Place the import to the right of existing content so it doesn't overlap.
      const doc = get().doc
      const existing = shapesBBox(doc.shapes.filter((s) => !s.hidden))
      if (bboxValid(existing)) {
        const b = shapesBBox(shapes)
        const dx = existing.maxX + 25 - b.minX
        const dy = existing.minY - b.minY
        for (const s of shapes) {
          s.x += dx
          s.y += dy
        }
      }
      get().checkpoint()
      commitDoc({ ...doc, shapes: [...doc.shapes, ...shapes], groups: [...doc.groups, g] })
      set({ selection: shapes.map((s) => s.id), popover: null })
      setTimeout(() => get().zoomToFit(shapesBBox(shapes)), 0)
      if (warnings.length) get().showToast(warnings.length > 1 ? `${warnings[0]} (+${warnings.length - 1} more)` : warnings[0])
    },
    patchShapes: (ids, fn) => {
      const set_ = new Set(ids)
      const doc = get().doc
      set({ doc: { ...doc, shapes: doc.shapes.map((s) => (set_.has(s.id) ? fn(s) : s)), updatedAt: new Date().toISOString() }, dirty: true })
    },
    updateShapes: (ids, fn) => {
      get().checkpoint()
      get().patchShapes(ids, fn)
    },
    setCut: (ids, cut) => get().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, ...cut } })),
    deleteSelected: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      const del = new Set(editableIds(selection, doc))
      if (!del.size) {
        get().showToast('Locked shapes can’t be deleted. Unlock them first.')
        return
      }
      get().checkpoint()
      commitDoc(pruneGroups({ ...doc, shapes: doc.shapes.filter((s) => !del.has(s.id)) }))
      set({ selection: [] })
    },
    duplicateSelected: (inPlace = false) => {
      const { selection, doc } = get()
      const sel = doc.shapes.filter((s) => selection.includes(s.id))
      if (!sel.length) return
      get().checkpoint()
      const off = inPlace ? 0 : doc.units === 'in' ? 6.35 : 5
      // Each source group gets its own fresh group, so copies never join the originals.
      const groupMap = new Map<string, string>()
      const newGroups: Group[] = []
      for (const s of sel) {
        if (!s.groupId || groupMap.has(s.groupId)) continue
        const src = doc.groups.find((g) => g.id === s.groupId)
        const gid = uid('g')
        groupMap.set(s.groupId, gid)
        const grp: Group = { id: gid, name: `${src?.name ?? 'Group'} copy` }
        if (src?.source) grp.source = src.source
        if (src?.info) grp.info = { ...src.info }
        newGroups.push(grp)
      }
      const copies = sel.map((s) => {
        const c = { ...structuredClone(s), id: uid(), x: s.x + off, y: s.y + off, locked: false }
        if (s.groupId) c.groupId = groupMap.get(s.groupId)
        return c
      })
      commitDoc({ ...doc, shapes: [...doc.shapes, ...copies], groups: [...doc.groups, ...newGroups] })
      set({ selection: copies.map((s) => s.id) })
    },
    mirrorSelected: (axis) => {
      const doc = get().doc
      const ids = editableIds(get().selection, doc)
      if (!ids.length) return
      const sel = doc.shapes.filter((s) => ids.includes(s.id))
      const c = bboxCenter(shapesBBox(sel))
      get().updateShapes(ids, (s0) => {
        const s = bake(s0)
        const flip = (cs: Contour[]) =>
          cs.map((ct) => ({ closed: ct.closed, pts: ct.pts.map((p) => (axis === 'h' ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y })) }))
        return {
          ...s,
          contours: flip(s.contours),
          x: axis === 'h' ? 2 * c.x - s.x : s.x,
          y: axis === 'v' ? 2 * c.y - s.y : s.y,
          // Text keeps its params (it can be re-typeset); every other kind becomes a plain path.
          kind: s.kind === 'text' ? 'text' : 'path',
          params: s.kind === 'text' ? s.params : undefined,
        }
      })
    },
    replaceShapes: (removeIds, add) => {
      get().checkpoint()
      const del = new Set(removeIds)
      const doc = get().doc
      commitDoc(pruneGroups({ ...doc, shapes: [...doc.shapes.filter((s) => !del.has(s.id)), ...add] }))
      set({ selection: add.map((s) => s.id) })
    },
    bringToFront: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      get().checkpoint()
      const sel = new Set(selection)
      commitDoc({ ...doc, shapes: [...doc.shapes.filter((s) => !sel.has(s.id)), ...doc.shapes.filter((s) => sel.has(s.id))] })
    },
    sendToBack: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      get().checkpoint()
      const sel = new Set(selection)
      commitDoc({ ...doc, shapes: [...doc.shapes.filter((s) => sel.has(s.id)), ...doc.shapes.filter((s) => !sel.has(s.id))] })
    },
    unlockAll: () => {
      const doc = get().doc
      if (!doc.shapes.some((s) => s.locked)) {
        get().showToast('Nothing is locked')
        return
      }
      get().checkpoint()
      commitDoc({ ...doc, shapes: doc.shapes.map((s) => (s.locked ? { ...s, locked: false } : s)) })
    },

    select: (ids) => set({ selection: ids }),
    selectGroup: (groupId) => set({ selection: get().doc.shapes.filter((s) => s.groupId === groupId && !s.locked).map((s) => s.id) }),
    setMode: (mode) => set({ mode, tool: 'select', popover: null, anchorPicking: false }),
    setTool: (tool) => set({ tool, popover: null }),
    setAnchorPicking: (anchorPicking) => set({ anchorPicking }),
    setView: (v) => set({ view: { ...get().view, ...v } }),
    setViewport: (w, h) => set({ viewport: { w, h } }),
    zoomToFit: (bbox) => {
      const { doc, viewport } = get()
      const b = bbox ?? shapesBBox(doc.shapes.filter((s) => !s.hidden))
      if (!bboxValid(b)) {
        // Empty design: show ~12 inches across, origin centred.
        const zoom = Math.max(0.05, viewport.w / 320)
        set({ view: { zoom, panX: viewport.w / 2, panY: viewport.h / 2 } })
        return
      }
      // Padding never eats the whole viewport, so zoom stays positive on tiny windows.
      const padX = Math.min(160, viewport.w * 0.2)
      const padY = Math.min(160, viewport.h * 0.2)
      const w = Math.max(bboxW(b), 1)
      const h = Math.max(bboxH(b), 1)
      const zoom = Math.max(0.05, Math.min((viewport.w - padX * 2) / w, (viewport.h - padY * 2) / h, 400))
      const c = bboxCenter(b)
      set({ view: { zoom, panX: viewport.w / 2 - c.x * zoom, panY: viewport.h / 2 - c.y * zoom } })
    },
    zoomBy: (factor, cx, cy) => {
      if (!Number.isFinite(factor) || factor <= 0) return
      const { view, viewport } = get()
      const x = cx ?? viewport.w / 2
      const y = cy ?? viewport.h / 2
      const zoom = Math.max(0.05, Math.min(2000, view.zoom * factor))
      const k = zoom / view.zoom
      set({ view: { zoom, panX: x - (x - view.panX) * k, panY: y - (y - view.panY) * k } })
    },
    zoomIn: () => get().zoomBy(1.25),
    zoomOut: () => get().zoomBy(0.8),
    openDialog: (dialog) => set({ dialog, popover: null, menuOpen: false }),
    setPopover: (popover) => set({ popover }),
    enterShapeShifter: () => {
      const ids = editableIds(get().selection)
      if (ids.length < 2) {
        get().showToast('Select two or more overlapping shapes')
        return
      }
      set({ shifter: ids, popover: null, menuOpen: false })
    },
    exitShapeShifter: () => set({ shifter: null }),
    setMenuOpen: (menuOpen) => set({ menuOpen, popover: null }),
    setEditingText: (editingTextId) => set({ editingTextId }),
    setFileHandle: (fileHandle) => set({ fileHandle }),
    markSaved: (savedDoc) => {
      if (!savedDoc || get().doc === savedDoc) set({ dirty: false })
    },
    showToast: (toast) => {
      clearTimeout(toastTimer)
      set({ toast })
      toastTimer = setTimeout(() => set({ toast: null }), 2600)
    },
  }
})

export const selectedShapes = (s: { doc: StudioDoc; selection: string[] }) => {
  const sel = new Set(s.selection)
  return s.doc.shapes.filter((x) => sel.has(x.id))
}
