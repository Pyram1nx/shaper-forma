// Core document model. All geometry is stored in millimetres, y axis pointing down
// (SVG convention). Curves are flattened to polylines at creation time so that
// offsetting, booleans, hit testing and export all work on the same representation.

export interface Pt {
  x: number
  y: number
}

export interface Contour {
  pts: Pt[]
  closed: boolean
}

export type CutType = 'online' | 'outside' | 'inside' | 'pocket' | 'guide'

export interface CutSettings {
  type: CutType
  /** Cut depth in mm. null = unset (Origin asks at cut time). */
  depth: number | null
  /** Extra offset in mm (positive = away from the material that stays). */
  offset: number
  /** Bit diameter in mm used for planning previews. */
  bitDia: number
}

export type ShapeKind =
  | 'circle'
  | 'ellipse'
  | 'rect'
  | 'polygon'
  | 'triangle'
  | 'template'
  | 'path'
  | 'text'
  | 'import'
  | 'slice'
  | 'sketch'

export interface ShapeMeta {
  /** Which feature produced this shape. */
  source?: '3d' | 'paper' | 'svg' | 'offset'
  /** Layer index for 3D slices (0 = top). */
  layer?: number
  /** Role of a generated shape. */
  role?: 'contour' | 'toolpath' | 'pocket' | 'outline' | 'paper'
  /** Bit used to generate this shape (see features/carve3d/bits.ts). */
  bitId?: string
  /** Free-form note shown in the panel. */
  note?: string
}

export interface Shape {
  id: string
  name: string
  kind: ShapeKind
  /** Geometry in local mm coordinates, centred around (0,0) where practical. */
  contours: Contour[]
  /** World translation in mm. */
  x: number
  y: number
  /** Rotation in degrees, clockwise (screen). */
  rotation: number
  sx: number
  sy: number
  /** Parametric data used to regenerate contours (e.g. rect w/h/r, text string). */
  params?: Record<string, number | string | boolean>
  cut: CutSettings
  hidden?: boolean
  locked?: boolean
  groupId?: string
  meta?: ShapeMeta
}

export interface Group {
  id: string
  name: string
  source?: '3d' | 'paper' | 'svg'
  /** Optional metadata, e.g. bit summary for a 3D slice set. */
  info?: Record<string, string | number>
}

export type Units = 'in' | 'mm'

/** Point of the selection bounding box used as the origin when Origin Anchor is on (3x3 grid, centre by default). */
export type OriginPoint = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'
/** A free origin picked on the canvas: fractions of the selection bounds (0..1 inside, outside allowed), so it moves with the shapes. */
export type FreeOrigin = { fx: number; fy: number }
/** The origin: one of the nine bounds points (snapped) or a free point. */
export type OriginRef = OriginPoint | FreeOrigin

export interface DocSettings {
  smartAlignment: boolean
  showPosition: boolean
  originAnchor: boolean
  /** Optional so documents saved before the picker existed load with the centre. */
  originPoint?: OriginRef
  /** A free point picked on the canvas, kept as a marker until cleared (Studio's custom anchor). */
  customAnchor?: Pt
  /** Plan mode: show tool band + cut path for every shape, not only the selection. */
  cutPathDisplay: boolean
}

export interface StudioDoc {
  app: 'ShaperStudio'
  version: 1
  id: string
  name: string
  units: Units
  shapes: Shape[]
  groups: Group[]
  settings: DocSettings
  createdAt: string
  updatedAt: string
}

export type Mode = 'design' | 'plan' | 'review'

export const MM_PER_IN = 25.4

export const DEFAULT_CUT: CutSettings = {
  type: 'outside',
  depth: null,
  offset: 0,
  bitDia: 3.175,
}

/**
 * Payload a feature dialog (3D carve, paper scan, SVG import) hands back to the
 * editor. Shapes are placed as-is (world coordinates in mm); the editor assigns
 * the group id and selects them.
 */
export interface ImportPayload {
  group: Omit<Group, 'id'>
  shapes: Omit<Shape, 'id'>[]
  /** Non-fatal problems to show the user (unsupported content, skipped elements). */
  warnings?: string[]
}
