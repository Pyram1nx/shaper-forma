// Model import (STL / OBJ / GLB / GLTF) and placement (units, up axis, sizing, centring).
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type ModelUnit = 'mm' | 'cm' | 'in' | 'm'
export type UpAxis = 'z' | 'y' | '-y' | 'x'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Bbox3 {
  min: Vec3
  max: Vec3
}

export interface PlacedModel {
  /** Flat xyz triangle list, mm, Z up, min Z = 0, XY centred on origin. */
  positions: Float32Array
  bbox: Bbox3
  size: Vec3
}

export const MODEL_ACCEPT = '.stl,.obj,.glb,.gltf'

export const UNIT_MM: Record<ModelUnit, number> = { mm: 1, cm: 10, in: 25.4, m: 1000 }

/** Row-major 3x3 rotations taking a model's up direction to +Z. */
const ORIENT: Record<UpAxis, number[]> = {
  z: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  y: [1, 0, 0, 0, 0, -1, 0, 1, 0], // +Y is up
  '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0], // -Y is up
  x: [0, 1, 0, 0, 0, 1, 1, 0, 0], // +X is up
}

/** Collect every mesh in `root` as a non-indexed triangle list in world space (preallocated). */
function collectTriangles(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true)
  const meshes: { pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; index: THREE.BufferAttribute | null; matrix: THREE.Matrix4; count: number }[] = []
  let total = 0
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return
    const index = mesh.geometry.getIndex()
    const count = index ? index.count : pos.count
    meshes.push({ pos, index, matrix: mesh.matrixWorld.clone(), count })
    total += count
  })
  const out = new Float32Array(total * 3)
  const v = new THREE.Vector3()
  let w = 0
  for (const m of meshes) {
    for (let i = 0; i < m.count; i++) {
      const k = m.index ? m.index.getX(i) : i
      v.fromBufferAttribute(m.pos, k).applyMatrix4(m.matrix)
      out[w++] = v.x
      out[w++] = v.y
      out[w++] = v.z
    }
  }
  return out
}

/** Default placement for a file type: GLB/GLTF are metres and Y-up by specification. */
export function defaultsFor(name: string): { unit: ModelUnit; up: UpAxis } {
  const n = name.toLowerCase()
  return n.endsWith('.glb') || n.endsWith('.gltf') ? { unit: 'm', up: 'y' } : { unit: 'mm', up: 'z' }
}

/**
 * Parse a model file. Returns merged world-space positions in the file's own units
 * (STL/OBJ/GLB have no unit metadata; the caller decides the unit).
 */
export async function readModelFile(file: File): Promise<Float32Array> {
  const name = file.name.toLowerCase()
  let root: THREE.Object3D
  if (name.endsWith('.stl')) {
    // STLLoader detects binary vs ASCII itself.
    root = new THREE.Mesh(new STLLoader().parse(await file.arrayBuffer()))
  } else if (name.endsWith('.obj')) {
    root = new OBJLoader().parse(await file.text())
  } else if (name.endsWith('.glb')) {
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')
    root = gltf.scene
  } else if (name.endsWith('.gltf')) {
    const gltf = await new GLTFLoader().parseAsync(await file.text(), '')
    root = gltf.scene
  } else {
    throw new Error('Unsupported file. Use STL, OBJ, GLB or GLTF.')
  }
  const positions = collectTriangles(root)
  if (positions.length < 9) throw new Error('The file contains no triangles.')
  return positions
}

function bboxOf(p: Float32Array): Bbox3 {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]
    const y = p[i + 1]
    const z = p[i + 2]
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z
  }
  return { min, max }
}

/** Scale to mm and orient so `up` points to +Z (no fitting, no centring). */
function orient(raw: Float32Array, unit: ModelUnit, up: UpAxis): Float32Array {
  const s = UNIT_MM[unit]
  const m = ORIENT[up]
  const p = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i]
    const y = raw[i + 1]
    const z = raw[i + 2]
    p[i] = s * (m[0] * x + m[1] * y + m[2] * z)
    p[i + 1] = s * (m[3] * x + m[4] * y + m[5] * z)
    p[i + 2] = s * (m[6] * x + m[7] * y + m[8] * z)
  }
  return p
}

/** Extents in mm after unit scaling and orientation: the model's natural size. */
export function orientedSize(raw: Float32Array, unit: ModelUnit, up: UpAxis): Vec3 {
  const b = bboxOf(orient(raw, unit, up))
  return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z }
}

/**
 * Scale to mm, orient so `up` points to +Z, optionally scale each axis so the extents equal
 * `size` (mm; an axis with no extent is left alone), then translate so min Z = 0 and XY is centred.
 */
export function placeModel(raw: Float32Array, unit: ModelUnit, up: UpAxis, size: Vec3 | null): PlacedModel {
  if (raw.length < 9) throw new Error('The file contains no triangles.')
  const p = orient(raw, unit, up)

  let b = bboxOf(p)
  if (size) {
    const k = (target: number, lo: number, hi: number) => (hi - lo > 1e-9 && target > 0 ? target / (hi - lo) : 1)
    const kx = k(size.x, b.min.x, b.max.x)
    const ky = k(size.y, b.min.y, b.max.y)
    const kz = k(size.z, b.min.z, b.max.z)
    for (let i = 0; i < p.length; i += 3) {
      p[i] *= kx
      p[i + 1] *= ky
      p[i + 2] *= kz
    }
    b = bboxOf(p)
  }

  const cx = (b.min.x + b.max.x) / 2
  const cy = (b.min.y + b.max.y) / 2
  const minZ = b.min.z
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= cx
    p[i + 1] -= cy
    p[i + 2] -= minZ
  }
  b = bboxOf(p)
  return {
    positions: p,
    bbox: b,
    size: { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z },
  }
}
