// Animated carving: the bit follows the tool route, removes material from the height map with its
// real profile, and throws sawdust. Headless by design (no renderer calls): the caller owns the
// render loop and calls update(dt) once per frame.
import * as THREE from 'three'
import { COLORS } from '../../ui/colors'
import { radiusAtHeight, type Bit } from './bits'
import type { CarvePlan } from './carvePlan'
import {
  bitProfile,
  cloneHeightfield,
  createHeightfieldGeometry,
  stampBit,
  syncHeightfieldGeometry,
  type BitProfile,
  type Heightfield,
} from './heightfield'
import { buildRoute, type RoutePoint } from './toolRoute'

/** Cutting feed at speed 1, mm/s. Rapids run RAPID_RATIO times faster. */
const FEED = 150
const RAPID_RATIO = 3
/** Visual spin of the bit while it cuts, rad/s. */
const SPIN = 40
/** Wall-clock budget for stamping in one frame; past it the bit simply moves slower. */
const FRAME_BUDGET_MS = 8
/** Largest time step the simulation takes, s (a tab switch must not teleport the bit). */
const MAX_DT = 0.05

const PARTICLES = 5000
const SAWDUST_PER_MM3 = 3
const MAX_SPAWN_PER_FRAME = 400
const GRAVITY = 3000
/** Dead particles are parked here, far outside any view. */
const PARK = 1e6
/** Helical pitch of the flute stripes, mm. */
const FLUTE_PITCH = 12

const FLUTE_SILVER = 0xc9ced6
const FLUTE_STRIPE = 0x3c424c
const SHANK_GREY = 0x9aa1ab

const WOOD = new THREE.Color(COLORS.wood)

/**
 * Lathe model of the bit, tip at local z = 0, shank along +Z. Vertex colours give the flutes a
 * silver body with two dark helical stripes, so the spin reads on screen.
 */
function buildBitMesh(bit: Bit): THREE.Mesh {
  const flute = bit.fluteLength
  const shankR = (bit.shankDiameter ?? bit.diameter) / 2
  const top = Math.max(bit.overallLength ?? flute + 30, flute + 1)
  const points: THREE.Vector2[] = [new THREE.Vector2(0, 0)]
  const N = 32
  for (let k = 0; k <= N; k++) {
    const h = (flute * k) / N
    points.push(new THREE.Vector2(Math.max(0, radiusAtHeight(bit, h)), h))
  }
  points.push(new THREE.Vector2(shankR, flute), new THREE.Vector2(shankR, top), new THREE.Vector2(0, top))

  const geo = new THREE.LatheGeometry(points, 40)
  // Lathe axis is Y; rotating +90° about X maps it onto +Z with the tip at z = 0.
  geo.rotateX(Math.PI / 2)

  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z > flute + 1e-6) {
      c.setHex(SHANK_GREY)
    } else {
      const turn = (Math.atan2(pos.getY(i), pos.getX(i)) / (2 * Math.PI)) * 2 - z / FLUTE_PITCH
      const f = turn - Math.floor(turn)
      c.setHex(f < 0.25 ? FLUTE_STRIPE : FLUTE_SILVER)
    }
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.35 }) // no env map, so keep metalness low or it renders black
  return new THREE.Mesh(geo, mat)
}

export interface CarveAnimationOptions {
  parent: THREE.Group
  plan: CarvePlan
  bit: Bit
  /** Uncut height map. The animation owns it and mutates its heights. */
  hf: Heightfield
  /** [top + skirt, bottom] materials. Not disposed here: the caller owns them. */
  solidMaterials: THREE.Material[]
}

export class CarveAnimation {
  /** Fraction of the route done, 0..1. */
  onProgress?: (f: number) => void
  onComplete?: () => void

  private readonly parent: THREE.Group
  private readonly hf: Heightfield
  private readonly pristine: Heightfield
  private readonly route: RoutePoint[]
  /** Length of segment i (route[i] → route[i+1]), mm. */
  private readonly segLen: Float64Array
  /** Distance from the route start to point i, mm. */
  private readonly cum: Float64Array
  private readonly total: number
  private readonly prof: BitProfile
  private readonly R: number
  /** Stamp spacing along a cut, mm. Half a sample keeps the bit's edge smooth. */
  private readonly stepLen: number

  private readonly geometry: THREE.BufferGeometry
  private readonly mesh: THREE.Mesh
  private readonly bitGroup: THREE.Group
  private readonly bitMesh: THREE.Mesh
  private readonly bitMat: THREE.Material
  private readonly dust: THREE.Points
  private readonly dustMat: THREE.PointsMaterial
  private readonly dustPos: Float32Array
  private readonly dustVel: Float32Array
  private readonly dustCol: Float32Array
  /** Remaining life per particle, s. 0 = dead. */
  private readonly dustLife: Float32Array
  private cursor = 0
  private dustDirty = false
  /** Sawdust credit: removed mm³ × SAWDUST_PER_MM3, not yet emitted. */
  private credit = 0
  /** Removed volume since the last sawdust emit, mm³. */
  private pending = 0

  private seg = 0
  /** Distance travelled along the current segment, mm. */
  private t = 0
  /** Current tip position, world mm. */
  private cx = 0
  private cy = 0
  private cz = 0
  private speed = 1
  private running = false
  private finished = false
  private spinning = false
  private disposed = false
  /** Rows touched by stamps this frame. */
  private jMin = Infinity
  private jMax = -Infinity

  constructor(opts: CarveAnimationOptions) {
    const { parent, plan, bit, hf, solidMaterials } = opts
    this.parent = parent
    this.hf = hf
    this.pristine = cloneHeightfield(hf)
    this.route = buildRoute(plan, bit)
    const n = this.route.length
    this.segLen = new Float64Array(Math.max(0, n - 1))
    this.cum = new Float64Array(Math.max(1, n))
    for (let i = 0; i + 1 < n; i++) {
      const a = this.route[i]
      const b = this.route[i + 1]
      this.segLen[i] = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      this.cum[i + 1] = this.cum[i] + this.segLen[i]
    }
    this.total = n > 1 ? this.cum[n - 1] : 0
    this.prof = bitProfile(bit)
    this.R = bit.diameter / 2
    this.stepLen = 0.5 * Math.min(hf.dx, hf.dy)

    this.geometry = createHeightfieldGeometry(hf)
    this.mesh = new THREE.Mesh(this.geometry, solidMaterials)
    parent.add(this.mesh)

    this.bitMesh = buildBitMesh(bit)
    this.bitMat = this.bitMesh.material as THREE.Material
    this.bitGroup = new THREE.Group()
    this.bitGroup.add(this.bitMesh)
    parent.add(this.bitGroup)

    this.dustPos = new Float32Array(PARTICLES * 3).fill(PARK)
    this.dustVel = new Float32Array(PARTICLES * 3)
    this.dustCol = new Float32Array(PARTICLES * 3)
    this.dustLife = new Float32Array(PARTICLES)
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3).setUsage(THREE.DynamicDrawUsage))
    dustGeo.setAttribute('color', new THREE.BufferAttribute(this.dustCol, 3).setUsage(THREE.DynamicDrawUsage))
    this.dustMat = new THREE.PointsMaterial({ size: 1.1, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false })
    this.dust = new THREE.Points(dustGeo, this.dustMat)
    // The parked particles stretch the bounding sphere, so culling would never help anyway.
    this.dust.frustumCulled = false
    parent.add(this.dust)

    this.placeAt(0)
    this.bitGroup.position.set(this.cx, this.cy, this.cz)
  }

  get playing(): boolean {
    return this.running
  }

  /** Fraction of the route length covered, 0..1. An empty route is already complete. */
  get progress(): number {
    if (this.total <= 0 || this.seg >= this.route.length - 1) return 1
    return Math.min(1, (this.cum[this.seg] + this.t) / this.total)
  }

  play(): void {
    if (this.disposed) return
    if (this.finished) this.reset()
    this.running = true
  }

  pause(): void {
    this.running = false
    this.spinning = false
  }

  /** Multiplier on the base feed. Values <= 0 are ignored. */
  setSpeed(multiplier: number): void {
    if (Number.isFinite(multiplier) && multiplier > 0) this.speed = multiplier
  }

  /** Restore the uncut stock and rewind to the start. Leaves the animation paused. */
  reset(): void {
    if (this.disposed) return
    this.hf.h.set(this.pristine.h)
    syncHeightfieldGeometry(this.geometry, this.hf)
    this.seg = 0
    this.t = 0
    this.running = false
    this.finished = false
    this.spinning = false
    this.pending = 0
    this.credit = 0
    this.dustLife.fill(0)
    this.dustPos.fill(PARK)
    this.dustDirty = true
    this.placeAt(0)
    this.bitGroup.position.set(this.cx, this.cy, this.cz)
    this.onProgress?.(0)
  }

  /** Advance by dt seconds (clamped). Call once per rendered frame. */
  update(dt: number): void {
    if (this.disposed) return
    const step = Math.min(Math.max(dt, 0), MAX_DT)
    this.jMin = Infinity
    this.jMax = -Infinity
    this.spinning = false
    if (this.running) this.advance(step)
    if (this.jMax >= this.jMin) syncHeightfieldGeometry(this.geometry, this.hf, [this.jMin - 1, this.jMax + 1])

    this.spawnSawdust()
    this.stepSawdust(step)

    if (this.spinning) this.bitMesh.rotation.z = (this.bitMesh.rotation.z + SPIN * step) % (2 * Math.PI)
    this.bitGroup.position.set(this.cx, this.cy, this.cz)

    if (this.running) {
      this.onProgress?.(this.progress)
      if (this.seg >= this.route.length - 1) this.complete()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    this.parent.remove(this.mesh, this.bitGroup, this.dust)
    this.geometry.dispose()
    this.bitMesh.geometry.dispose()
    this.bitMat.dispose()
    this.dust.geometry.dispose()
    this.dustMat.dispose()
  }

  private complete(): void {
    this.running = false
    this.finished = true
    this.spinning = false
    this.onComplete?.()
  }

  /** Move the tip to a point along the route, `t` mm into the current segment. Sets cx/cy/cz. */
  private placeAt(t: number): void {
    const last = this.route.length - 1
    if (last < 0) return
    const a = this.route[Math.min(this.seg, last)]
    const b = this.route[Math.min(this.seg + 1, last)]
    const L = this.segLen[this.seg] ?? 0
    const f = L > 0 ? Math.min(1, Math.max(0, t / L)) : 0
    this.cx = a.x + (b.x - a.x) * f
    this.cy = a.y + (b.y - a.y) * f
    this.cz = a.z + (b.z - a.z) * f
  }

  /**
   * Spend `dt` seconds of feed along the route. Cuts are stamped at spacing stepLen. Stops early
   * if the frame budget runs out, so a heavy frame slows the bit rather than stalling the page.
   */
  private advance(dt: number): void {
    const route = this.route
    const last = route.length - 1
    const clock = performance.now()
    let timeLeft = dt
    while (timeLeft > 1e-9 && this.seg < last) {
      const next = route[this.seg + 1]
      const cutting = !next.rapid
      const rate = FEED * this.speed * (cutting ? 1 : RAPID_RATIO)
      const L = this.segLen[this.seg]
      const d = Math.min(L - this.t, rate * timeLeft)
      const n = cutting ? Math.max(1, Math.ceil(d / this.stepLen)) : 1
      const t0 = this.t
      timeLeft -= d / rate
      if (cutting) this.spinning = true

      let overBudget = false
      for (let k = 1; k <= n; k++) {
        this.t = t0 + (d * k) / n
        this.placeAt(this.t)
        if (cutting) this.stamp()
        if (performance.now() - clock > FRAME_BUDGET_MS) {
          overBudget = true
          break
        }
      }
      if (L - this.t <= 1e-9) {
        this.seg++
        this.t = 0
      }
      if (overBudget) return
    }
  }

  /** Lower the height map under the bit's current position and track the rows it touched. */
  private stamp(): void {
    const hf = this.hf
    const removed = stampBit(hf, this.prof, this.cx, this.cy, this.cz)
    if (removed <= 0) return
    this.pending += removed
    const j0 = Math.max(0, Math.ceil((this.cy - this.R - hf.y0) / hf.dy))
    const j1 = Math.min(hf.ny - 1, Math.floor((this.cy + this.R - hf.y0) / hf.dy))
    if (j0 < this.jMin) this.jMin = j0
    if (j1 > this.jMax) this.jMax = j1
  }

  /** Emit sawdust in proportion to the volume removed since the last frame. */
  private spawnSawdust(): void {
    this.credit += this.pending * SAWDUST_PER_MM3
    this.pending = 0
    const want = Math.min(MAX_SPAWN_PER_FRAME, Math.floor(this.credit))
    // A backlog beyond the cap is dropped rather than spat out for seconds after the cut.
    this.credit = this.credit > MAX_SPAWN_PER_FRAME ? 0 : this.credit - want
    if (want <= 0) return
    const R = this.R
    for (let n = 0; n < want; n++) {
      const i = this.cursor
      this.cursor = i + 1 === PARTICLES ? 0 : i + 1
      const a = Math.random() * 2 * Math.PI
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      // Radial throw plus the rim's tangential speed, which runs with the spin (+Z, counter-clockwise).
      const vr = 150 + 350 * Math.random()
      const vt = 150 + 350 * Math.random()
      const k = i * 3
      this.dustPos[k] = this.cx + R * ca
      this.dustPos[k + 1] = this.cy + R * sa
      this.dustPos[k + 2] = this.cz + 1.5 * Math.random()
      this.dustVel[k] = ca * vr - sa * vt
      this.dustVel[k + 1] = sa * vr + ca * vt
      this.dustVel[k + 2] = 100 + 300 * Math.random()
      this.dustLife[i] = 0.5 + 0.9 * Math.random()
      const b = 0.7 + 0.4 * Math.random()
      this.dustCol[k] = Math.min(1, WOOD.r * b)
      this.dustCol[k + 1] = Math.min(1, WOOD.g * b)
      this.dustCol[k + 2] = Math.min(1, WOOD.b * b)
    }
    this.dustDirty = true
  }

  /** Integrate the live particles; park those that expire or fall below the stock. */
  private stepSawdust(dt: number): void {
    const floor = this.hf.bottom - 2
    let alive = 0
    let died = false
    for (let i = 0; i < PARTICLES; i++) {
      const life = this.dustLife[i]
      if (life <= 0) continue
      const k = i * 3
      const vz = this.dustVel[k + 2] - GRAVITY * dt
      this.dustVel[k + 2] = vz
      this.dustPos[k] += this.dustVel[k] * dt
      this.dustPos[k + 1] += this.dustVel[k + 1] * dt
      this.dustPos[k + 2] += vz * dt
      const left = life - dt
      if (left <= 0 || this.dustPos[k + 2] < floor) {
        this.dustLife[i] = 0
        this.dustPos[k] = PARK
        this.dustPos[k + 1] = PARK
        this.dustPos[k + 2] = PARK
        died = true
      } else {
        this.dustLife[i] = left
        alive++
      }
    }
    if (alive === 0 && !this.dustDirty && !died) return
    this.dustDirty = false
    const geo = this.dust.geometry
    geo.getAttribute('position').needsUpdate = true
    geo.getAttribute('color').needsUpdate = true
  }
}
