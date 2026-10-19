// Dimension guides for the 3D preview: width (x), length (y) and height (z) of the model's
// bounding box, drawn as offset measurement lines like a CAD drawing.
//
// Placement follows the camera (seen from above, the model centred on the origin):
//  - width runs along the bottom edge nearest the camera on the y side (y = sy·…),
//  - length runs along the bottom edge nearest the camera on the x side (x = sx·…),
//  - height stands on a back vertical edge: on the face opposite the one we mostly look at,
//    at the corner on the side we look from, so it sits on the silhouette and meets the
//    floor guide on that side in an L.
// The floor guides are pushed out past the stock so they never cross the wood.
import type { Vec3 } from './loadModel'

export type DimAxis = 'x' | 'y' | 'z'

export interface DimGuide {
  axis: DimAxis
  /** Guide line ends, world mm. */
  a: Vec3
  b: Vec3
  /** Extension lines (from the model edge out past the guide), pairs of points. */
  ext: [Vec3, Vec3][]
  /** Where the value label goes, world mm. */
  label: Vec3
}

export interface DimLayout {
  /** Changes only when the guides move to other edges or the sizes change (rebuild key). */
  key: string
  guides: DimGuide[]
  /** Arrowhead length, mm (scaled to the model). */
  arrow: number
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

/**
 * @param size model size (x/y centred on the origin, z from 0 up)
 * @param stock stock footprint size (same centre); the floor guides sit outside it
 * @param cam camera position relative to the model centre (only x and y matter)
 */
export function dimLayout(size: Vec3, stock: { x: number; y: number }, cam: { x: number; y: number }): DimLayout {
  const hx = size.x / 2
  const hy = size.y / 2
  const H = size.z
  const maxD = Math.max(size.x, size.y, size.z, 1)
  const gap = Math.max(3, 0.08 * maxD)
  const inner = 0.6 * gap // extension lines start this far inside the guide
  const outer = 0.35 * gap // …and run this far past it
  const sx = cam.x >= 0 ? 1 : -1
  const sy = cam.y >= 0 ? 1 : -1
  const alongY = Math.abs(cam.y) >= Math.abs(cam.x) // looking mostly at the ±y face

  // Distance from the model centre to the floor guides: past the stock, plus the gap.
  const gx = Math.max(hx, stock.x / 2) + gap // x of the length guide
  const gy = Math.max(hy, stock.y / 2) + gap // y of the width guide

  const width: DimGuide = {
    axis: 'x',
    a: v(-hx, sy * gy, 0),
    b: v(hx, sy * gy, 0),
    ext: [-hx, hx].map((x) => [v(x, sy * (gy - inner), 0), v(x, sy * (gy + outer), 0)] as [Vec3, Vec3]),
    label: v(0, sy * (gy + 0.9 * gap), 0),
  }
  const length: DimGuide = {
    axis: 'y',
    a: v(sx * gx, -hy, 0),
    b: v(sx * gx, hy, 0),
    ext: [-hy, hy].map((y) => [v(sx * (gx - inner), y, 0), v(sx * (gx + outer), y, 0)] as [Vec3, Vec3]),
    label: v(sx * (gx + 0.9 * gap), 0, 0),
  }
  // Height on the back face's corner on our side, offset sideways onto the floor guide's line.
  let height: DimGuide
  if (alongY) {
    const y = -sy * hy
    height = {
      axis: 'z',
      a: v(sx * gx, y, 0),
      b: v(sx * gx, y, H),
      ext: [0, H].map((z) => [v(sx * (gx - inner), y, z), v(sx * (gx + outer), y, z)] as [Vec3, Vec3]),
      label: v(sx * (gx + 0.9 * gap), y, H / 2),
    }
  } else {
    const x = -sx * hx
    height = {
      axis: 'z',
      a: v(x, sy * gy, 0),
      b: v(x, sy * gy, H),
      ext: [0, H].map((z) => [v(x, sy * (gy - inner), z), v(x, sy * (gy + outer), z)] as [Vec3, Vec3]),
      label: v(x, sy * (gy + 0.9 * gap), H / 2),
    }
  }

  const key = [sx, sy, alongY ? 'y' : 'x', size.x, size.y, size.z, stock.x, stock.y].map((n) => (typeof n === 'number' ? n.toFixed(3) : n)).join('|')
  return { key, guides: [width, length, height], arrow: Math.min(0.5 * gap, 0.15 * maxD) }
}
