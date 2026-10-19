import { DEFAULT_CUT, MM_PER_IN, type Contour, type CutSettings, type Shape, type ShapeKind, type Units } from './types'
import { uid } from './ids'
import { recenter } from '../geometry/transform'

/**
 * Build a shape from world-space contours (mm). The geometry is re-centred so
 * x/y is the bbox centre — this is what feature dialogs should use.
 */
export function shapeFromWorld(
  kind: ShapeKind,
  name: string,
  contours: Contour[],
  extra: Partial<Omit<Shape, 'id' | 'contours' | 'kind' | 'name'>> = {},
): Shape {
  const s: Shape = {
    id: uid(),
    name,
    kind,
    contours,
    x: 0,
    y: 0,
    rotation: 0,
    sx: 1,
    sy: 1,
    cut: { ...DEFAULT_CUT, ...(extra.cut ?? {}) } as CutSettings,
    ...extra,
  }
  return recenter(s)
}

export const toUnits = (mm: number, u: Units) => (u === 'in' ? mm / MM_PER_IN : mm)
export const fromUnits = (v: number, u: Units) => (u === 'in' ? v * MM_PER_IN : v)

/**
 * Number text for a length in mm, expressed in the document units (no unit suffix).
 * Millimetres show up to 3 decimals with trailing zeros trimmed (3.175, 25.4, 6).
 * Inches always show 3 decimals (0.125, 1.000).
 */
export function fmtNum(mm: number, u: Units): string {
  if (!Number.isFinite(mm)) return '–'
  if (u === 'in') return (mm / MM_PER_IN).toFixed(3)
  return String(Number(mm.toFixed(3)))
}

/** fmtNum plus the unit suffix. */
export const fmtLen = (mm: number, u: Units) => fmtNum(mm, u) + (u === 'in' ? ' in' : ' mm')

