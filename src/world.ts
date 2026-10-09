import * as THREE from 'three'
import { addLights, addSky, ellipse, glow, makePlanet, warpTarget, type Ctx, type Live, type WarpDest } from './scene'
import type { IconName } from './ui'
import { fx, reduced } from './warp'

// Un solo mundo 3D para toda la app: Home, Clientes y Proyectos son vistas del MISMO canvas y la MISMA escena.
// Viajar a una pantalla es mover el planeta elegido de su orbita a su sitio en esa pantalla (y al reves); nada se desmonta ni se recarga.

const TEXTURES = [1, 2, 3, 4].map((n) => `/planets/planeta${n}.png`)
/** 'marketing' es una pantalla plana (sin viaje 3D): su planeta se ve en el Home y abre el planeta Marketing. */
export type PlanetKey = 'clientes' | 'marketing' | 'proyectos' | 'tareas' | 'finanzas'
/** Lo que se puede resaltar con el cursor en el Home: un planeta o el núcleo HAYAI (que abre el Hub). */
export type HotKey = PlanetKey | 'hub'
export const CORE_R = 2.07
const CLIENTS_R = 3.15 // radio del planeta en la pantalla Clientes: los anillos extra se dibujan con esa proporcion

// pos = mundo (x,y) tomado de la maqueta; tex = indice en TEXTURES; amp/w/ph = deriva orbital lenta (rad, rad/s, fase)
export const PLANETS: {
  key: PlanetKey
  tex: number
  tint: number
  gain: number
  pos: [number, number]
  r: number
  spin: number
  tilt: number
  side: 'left' | 'right'
  icon: IconName
  iconBg: string
  dy: number
  amp: number
  w: number
  ph: number
}[] = [
  { key: 'clientes', tex: 2, tint: 0xffffff, gain: 1.05, pos: [-4.39, 2.28], r: 1.12, spin: 0.16, tilt: 0.35, side: 'left', icon: 'users', iconBg: '#b4702a', dy: -0.15, amp: 0.1, w: 0.07, ph: 0 },
  { key: 'marketing', tex: 0, tint: 0xffffff, gain: 1.5, pos: [4.19, 2.24], r: 0.97, spin: 0.22, tilt: -0.3, side: 'right', icon: 'globe', iconBg: '#8a3414', dy: 0, amp: 0.1, w: 0.06, ph: 2 },
  { key: 'proyectos', tex: 1, tint: 0xffffff, gain: 1.25, pos: [-5.13, -1.73], r: 1.14, spin: 0.12, tilt: 0.2, side: 'left', icon: 'folder', iconBg: '#2a2018', dy: 0.1, amp: 0.09, w: 0.08, ph: 4 },
  { key: 'finanzas', tex: 2, tint: 0xff9a3c, gain: 1.05, pos: [-0.09, -3.59], r: 1.12, spin: 0.2, tilt: -0.25, side: 'right', icon: 'chart', iconBg: '#a24d16', dy: 0.3, amp: 0.1, w: 0.065, ph: 1 },
  { key: 'tareas', tex: 3, tint: 0xc9d0d4, gain: 1.3, pos: [5.47, -1.82], r: 1.0, spin: 0.14, tilt: 0.3, side: 'right', icon: 'check', iconBg: '#5b4a40', dy: 0.05, amp: 0.09, w: 0.075, ph: 3 },
]

export interface Item {
  p: (typeof PLANETS)[number]
  anchor: THREE.Group
  pivot: THREE.Group
  body: THREE.Mesh
  ringA: THREE.LineLoop
  dot: THREE.Mesh
  air: THREE.Sprite
  rim: THREE.Sprite | null
  extra: { line: THREE.LineLoop; base: number }[]
  ph: number
  hot: number
  dotA: number
  rate: number
}

export interface World {
  ctx: Ctx | null
  items: Item[]
  /** planeta resaltado (hover) en el Home */
  hot: HotKey | null
  /** pantalla destino (null = Home) */
  key: WarpDest | null
  /** 1 = viajando hacia la pantalla, 0 = hacia el Home */
  target: 0 | 1
  /** progreso del viaje: 0 = Home, 1 = en la pantalla */
  wp: number
  dur: number
  /** pantalla en la que arranca la app (si se abre directo en #clientes) */
  initial: WarpDest | null
  onArrive?: (at: 'home' | WarpDest) => void
  /** otras capas que quieren enterarse de la llegada (la vista Feed espera a que el nucleo quede anclado antes de mostrarse) */
  arriveSubs: Set<(at: 'home' | WarpDest) => void>
  /** HTML de cada pantalla: se registran al montarse sus capas (no tocan WebGL) */
  homeSync: ((dt: number) => void) | null
  homeResize: (() => void) | null
  screenHook: ((dt: number, t: number) => void) | null
  screenResize: (() => void) | null
  /** velocidad de giro que pide la pantalla activa (rad/s); null = la del planeta */
  screenRate: number | null
  stageClick: (() => void) | null
  /** puntero sobre el planeta/escena en las pantallas (arrastrar para girarlo) */
  stagePointer: ((type: 'down' | 'move' | 'up', e: { clientX: number; clientY: number; pointerId: number }) => void) | null
  pick: (cx: number, cy: number) => HotKey | null
  zoomBy: (f: number) => void
  go: (key: WarpDest | null) => void
  /** vuelve al Home de golpe, sin viaje (cuando la pantalla que lo tapaba se va sin pasar por el Home) */
  snapHome: () => void
  busy: () => boolean
  item: (key: PlanetKey) => Item | undefined
}

export function createWorld(initial: WarpDest | null): World {
  const w: World = {
    ctx: null,
    items: [],
    hot: null,
    key: initial,
    target: initial ? 1 : 0,
    wp: initial ? 1 : 0,
    dur: 1.2,
    initial,
    arriveSubs: new Set(),
    homeSync: null,
    homeResize: null,
    screenHook: null,
    screenResize: null,
    screenRate: null,
    stageClick: null,
    stagePointer: null,
    pick: () => null,
    zoomBy: () => {},
    go(key) {
      if (key) {
        w.key = key
        w.target = 1
        w.dur = reduced() ? 0.4 : 1.2
      } else {
        w.target = 0
        w.dur = reduced() ? 0.4 : 1.4
      }
    },
    snapHome() {
      w.key = null
      w.target = 0
      w.wp = 0
    },
    busy: () => (w.target === 1 && w.wp < 1) || (w.target === 0 && w.wp > 0),
    item: (key) => w.items.find((i) => i.p.key === key),
  }
  return w
}

export const WORLD_TEXTURES = TEXTURES

const smooth = (x: number) => x * x * (3 - 2 * x)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export function buildWorld(ctx: Ctx, tex: THREE.CanvasTexture[], world: World): Live {
  const { scene, camera } = ctx
  world.ctx = ctx
  addLights(scene, [-4, 5, 7], 2.0, 2.2)
  const amb = scene.children.find((o) => o instanceof THREE.AmbientLight) as THREE.AmbientLight
  const sun = scene.children.find((o) => o instanceof THREE.DirectionalLight) as THREE.DirectionalLight

  // nucleo HAYAI: esfera oscura + halo ambar
  const core = makePlanet(tex[1], CORE_R, 0.18, 0x8a7d70)
  scene.add(core.pivot)
  const halo = glow(CORE_R * 1.9, 1 / 1.9, '255,166,48', 0.95)
  halo.position.z = -0.6
  scene.add(halo)

  // orbitas finas del sistema
  const orbits: [number, number, number, number, number][] = [
    [2.5, 2.5, 0xd08a2e, 0.5, 0],
    [2.75, 2.75, 0xd08a2e, 0.3, 0],
    [3.1, 3.0, 0x7a5530, 0.28, 0.1],
    [4.9, 3.5, 0xc9873a, 0.3, 0.15],
    [6.6, 4.4, 0x7a5530, 0.26, -0.1],
    [8.4, 5.2, 0xc9873a, 0.24, 0.06],
    [9.6, 5.6, 0x7a5530, 0.18, -0.12],
  ]
  // todo lo "del Home" que se desvanece al viajar: nucleo, halo y orbitas
  const common: { m: THREE.Material; o: number; obj: THREE.Object3D }[] = []
  orbits.forEach(([a, b, c, o, r]) => {
    const l = ellipse(a, b, c, o, r, -0.5)
    scene.add(l)
    common.push({ m: l.material as THREE.Material, o, obj: l })
  })
  const haloBase = halo.scale.clone()
  let coreHot = 0
  const coreAir = core.pivot.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite
  const coreMat = core.body.material as THREE.Material
  const haloPos = halo.position.clone()

  const sky = addSky(scene)

  // planetas del menu
  const items: Item[] = PLANETS.map((p) => {
    const anchor = new THREE.Group()
    const { pivot, body } = makePlanet(tex[p.tex], p.r, p.tilt, new THREE.Color(p.tint).multiplyScalar(p.gain))
    anchor.add(pivot)
    const air = pivot.children.find((c) => c instanceof THREE.Sprite) as THREE.Sprite
    const ringG = new THREE.Group()
    ringG.rotation.set(1.05, 0, 0.5 + p.tilt)
    const ringA = ellipse(p.r * 1.3, p.r * 1.3, 0x3a2a1a, 0.55)
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }))
    ringG.add(ringA, dot)
    anchor.add(ringG)

    // extras que solo se ven cuando el planeta es el protagonista de su pantalla
    let rim: THREE.Sprite | null = null
    const extra: Item['extra'] = []
    if (p.key === 'clientes' || p.key === 'proyectos' || p.key === 'marketing' || p.key === 'finanzas' || p.key === 'tareas') {
      rim = glow(p.r * 1.3, 1 / 1.3, '239,157,37', 0.32)
      rim.position.z = -0.4
      rim.material.opacity = 0
      rim.visible = false
      anchor.add(rim)
    }
    if (p.key === 'clientes') {
      const g = new THREE.Group()
      g.scale.setScalar(p.r / CLIENTS_R)
      ;(
        [
          [5.0, 4.95, 0xc9873a, 0.3, 0],
          [6.3, 5.4, 0xc9873a, 0.22, 0.5],
          [8.0, 6.0, 0x7a5530, 0.2, -0.35],
          [10.2, 7.2, 0xc9873a, 0.16, 0.2],
        ] as const
      ).forEach(([a, b, c, o, r]) => {
        const l = ellipse(a, b, c, 0, r, -1.5)
        g.add(l)
        extra.push({ line: l, base: o })
        l.visible = false
      })
      anchor.add(g)
    }
    scene.add(anchor)
    return { p, anchor, pivot, body, ringA, dot, air, rim, extra, ph: p.ph, hot: 0, dotA: Math.random() * 6.28, rate: p.spin }
  })
  world.items = items

  const bodies: THREE.Object3D[] = [...items.map((i) => i.body), core.body] // el último es el núcleo HAYAI
  const ray = new THREE.Raycaster()
  world.pick = (cx, cy) => {
    const rect = ctx.renderer.domElement.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1), camera)
    const hit = ray.intersectObjects(bodies, false)[0]
    if (!hit) return null
    const i = bodies.indexOf(hit.object)
    return i < items.length ? items[i].p.key : 'hub'
  }

  let lastNow = performance.now()
  let at: 'home' | WarpDest | 'moving' = world.initial ?? 'home'
  let settleUntil = 0

  return {
    resize() {
      world.homeResize?.()
      world.screenResize?.()
    },
    update(dt, t) {
      const now = performance.now()
      const real = Math.min(0.1, (now - lastNow) / 1000) // el viaje sigue el reloj, no los frames
      lastNow = now
      const m = ctx.motion

      // progreso del viaje
      if (world.wp !== world.target) world.wp = clamp01(world.wp + (world.target ? 1 : -1) * (real / world.dur))
      const wp = world.wp
      const key = world.key
      const fwd = world.target === 1
      const moving = wp !== world.target
      const split = fwd ? 0.3 : 0.5 // ida: primero se van los demas; vuelta: primero se acomoda el planeta y luego regresan los demas
      const f = clamp01(wp / split)
      const fo = 1 - smooth(f)
      const e = smooth(clamp01((wp - split) / (1 - split)))

      const upp = (2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / (ctx.h * camera.zoom)
      // el núcleo reacciona al cursor como los planetas: crece un poco, gira más vivo y su halo se avivia
      coreHot += ((world.hot === 'hub' && !key ? 1 : 0) - coreHot) * (1 - Math.exp(-dt * 12))
      core.body.rotation.y += (0.05 + coreHot * 0.3) * dt * m
      core.body.scale.setScalar(1 + coreHot * 0.05)
      halo.scale.set(haloBase.x * (1 + coreHot * 0.1), haloBase.y * (1 + coreHot * 0.1), haloBase.z)

      for (const it of items) {
        const { p } = it
        const isKey = key === p.key
        it.ph += p.w * dt * m
        const da = p.amp * Math.sin(it.ph)
        const c = Math.cos(da)
        const s = Math.sin(da)
        it.anchor.position.set(p.pos[0] * c - p.pos[1] * s, p.pos[0] * s + p.pos[1] * c, 0)
        it.dotA += 0.35 * dt * m
        it.dot.position.set(Math.cos(it.dotA) * p.r * 1.3, Math.sin(it.dotA) * p.r * 1.3, 0)
        it.hot += ((world.hot === p.key && !key ? 1 : 0) - it.hot) * (1 - Math.exp(-dt * 12))
        it.body.scale.setScalar(1 + it.hot * 0.07)

        // giro sobre su eje: acelera al viajar y frena al llegar (la pantalla puede pedir su propia velocidad)
        const desired = isKey ? (wp >= 1 ? (world.screenRate ?? p.spin) : p.spin * (1 + wp * 8)) : p.spin
        it.rate += (desired - it.rate) * (1 - Math.exp(-real * 6))
        it.body.rotation.y += it.rate * dt * m

        const vis = isKey ? 1 : fo
        ;(it.body.material as THREE.Material).opacity = vis
        it.air.material.opacity = vis
        ;(it.dot.material as THREE.Material).opacity = vis
        const ringOp = isKey ? 0.55 * (1 - clamp01(wp * 2)) : (0.55 + it.hot * 0.4) * fo
        ;(it.ringA.material as THREE.LineBasicMaterial).opacity = ringOp
        it.dot.scale.setScalar(isKey ? Math.max(0.001, 1 - clamp01(wp * 2)) : 1)
        it.anchor.visible = isKey || fo > 0.01

        if (it.rim) {
          const o = isKey ? e : 0
          it.rim.material.opacity = o
          it.rim.visible = o > 0.01
        }
        for (const x of it.extra) {
          const o = isKey ? x.base * e : 0
          ;(x.line.material as THREE.LineBasicMaterial).opacity = o
          x.line.visible = o > 0.005
        }

        if (isKey) {
          // el planeta viaja a su sitio en la pantalla, con su tamano, inclinacion y luz
          const dst = warpTarget(key, ctx.w, ctx.h)
          const destX = (dst.cx - ctx.w / 2) * upp
          const destY = (ctx.originY * ctx.h - dst.cy) * upp
          const sc = (dst.rpx * upp) / p.r
          it.anchor.position.x = it.anchor.position.x * (1 - e) + destX * e
          it.anchor.position.y = it.anchor.position.y * (1 - e) + destY * e
          it.anchor.scale.setScalar(1 + (sc - 1) * e)
          it.pivot.rotation.set(0.28 + (dst.rx - 0.28) * e, 0, p.tilt * (1 - e) + dst.rz * e)
        } else {
          it.anchor.scale.setScalar(1)
          it.pivot.rotation.set(0.28, 0, p.tilt)
        }
      }

      // orbitas del sistema: se apagan al viajar
      for (const x of common) {
        x.m.opacity = x.o * fo
        x.obj.visible = fo > 0.01
      }
      // nucleo y halo: se apagan igual, salvo cuando EL NUCLEO es el destino (vista Feed del Hub): ahi viaja a la izquierda y se ancla
      const coreKey = key === 'hub'
      const cv = coreKey ? 1 : fo
      coreMat.opacity = cv
      coreAir.material.opacity = cv
      halo.material.opacity = cv
      core.pivot.visible = halo.visible = cv > 0.01
      if (coreKey) {
        const dst = warpTarget('hub', ctx.w, ctx.h)
        const destX = (dst.cx - ctx.w / 2) * upp
        const destY = (ctx.originY * ctx.h - dst.cy) * upp
        const sc = 1 + ((dst.rpx * upp) / CORE_R - 1) * e
        core.pivot.position.set(destX * e, destY * e, 0)
        core.pivot.scale.setScalar(sc)
        core.pivot.rotation.set(0.28 + (dst.rx - 0.28) * e, 0, 0.18 * (1 - e) + dst.rz * e)
        halo.position.set(haloPos.x + destX * e, haloPos.y + destY * e, haloPos.z)
        halo.scale.set(halo.scale.x * sc, halo.scale.y * sc, halo.scale.z)
      } else {
        core.pivot.position.set(0, 0, 0)
        core.pivot.scale.setScalar(1)
        core.pivot.rotation.set(0.28, 0, 0.18)
        halo.position.copy(haloPos)
      }
      amb.intensity = 2.0 - 0.1 * e
      sun.intensity = 2.2 + 0.1 * e
      sun.position.set(-4 + 9 * e, 5 - 2 * e, 7 - e)

      // estelas de velocidad luz: salen del centro al ir y convergen al volver; al llegar se apagan solas
      const rd = reduced() ? 0.2 : 1
      if (moving) {
        fx.dir = fwd ? 1 : -1
        fx.k = wp ** 1.4 * (fwd ? 1 : Math.min(1, (1 - wp) * 8)) * rd
      } else if (now < settleUntil) fx.k *= Math.exp(-real * 5)
      if (at !== 'moving' && moving) at = 'moving'

      camera.updateMatrixWorld() // en el primer frame aun no se ha renderizado: sin esto toScreen da NaN
      for (const it of items) it.anchor.updateMatrixWorld(true)

      sky(t, m)
      world.homeSync?.(dt)
      if (key && wp >= 1) world.screenHook?.(dt, t)

      // llegada
      if (!moving) {
        const now2: 'home' | WarpDest = world.target === 1 ? key! : 'home'
        if (at !== now2) {
          at = now2
          settleUntil = now + 1000
          if (now2 === 'home') {
            world.key = null
            fx.dir = 1
          }
          world.onArrive?.(now2)
          world.arriveSubs.forEach((f) => f(now2))
        }
      }
    },
  }
}
