import * as THREE from 'three'

export interface Ctx {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  w: number
  h: number
  /** 1 normal, 0.1 con prefers-reduced-motion. Multiplica toda velocidad. */
  motion: number
  /** fraccion de pantalla donde cae el origen del mundo (la fija setView). */
  originY: number
  /** viewH = alto del mundo visible (unidades) a zoom 1; originY = fraccion de pantalla donde cae el origen. */
  setView(viewH: number, originY: number): void
}
export interface Live {
  update(dt: number, t: number): void
  resize?(): void
}
export interface Mounted {
  zoomBy(factor: number): void
  dispose(): void
}

const FOV = 30
const TAN = Math.tan((FOV / 2) * (Math.PI / 180))

/** PNG de disco 2D -> textura equirectangular: recorte cuadrado inscrito + espejo (2:1, costura continua). */
const texCache = new Map<string, Promise<THREE.CanvasTexture>>()
function loadPlanetTexture(url: string): Promise<THREE.CanvasTexture> {
  // cacheada de por vida: al viajar Home -> Clientes el planeta aparece sin esperar a decodificar el PNG
  let p = texCache.get(url)
  if (!p) texCache.set(url, (p = decodePlanet(url)))
  return p
}
async function decodePlanet(url: string): Promise<THREE.CanvasTexture> {
  const img = new Image()
  img.src = url
  await img.decode() // decodifica el PNG fuera del hilo principal
  const c = document.createElement('canvas')
  c.width = 2048
  c.height = 1024
  const g = c.getContext('2d')!
  const s = img.width * 0.58
  const sx = (img.width - s) / 2
  const sy = (img.height - s) / 2
  g.drawImage(img, sx, sy, s, s, 0, 0, 1024, 1024)
  g.translate(2048, 0)
  g.scale(-1, 1)
  g.drawImage(img, sx, sy, s, s, 0, 0, 1024, 1024)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Prepara las texturas de planetas en segundo plano (durante la pantalla de acceso) para que las pantallas abran sin tirones. */
export function preloadPlanets() {
  ;[1, 2, 3, 4].forEach((n) => void loadPlanetTexture(`/planets/planeta${n}.png`).catch(() => {}))
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

// Pool de renderers: crear un contexto WebGL y compilar shaders cuesta decenas de ms (el "tiron" al entrar a una pantalla).
// Se crean y calientan una vez, durante la pantalla de acceso, y las pantallas los reutilizan (pueden solaparse dos: la que sale y la que entra).
const pool: THREE.WebGLRenderer[] = []
function makeRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  r.domElement.className = 'gl'
  return r
}
const takeRenderer = () => pool.pop() ?? makeRenderer()

async function warm(r: THREE.WebGLRenderer) {
  const s = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  cam.position.z = 5
  const tex = new THREE.CanvasTexture(document.createElement('canvas'))
  s.add(new THREE.AmbientLight(), new THREE.DirectionalLight())
  s.add(new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial({ map: tex, transparent: true })))
  s.add(new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ transparent: true })))
  s.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })))
  s.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)), new THREE.PointsMaterial({ transparent: true, sizeAttenuation: false })))
  s.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineBasicMaterial({ transparent: true })))
  try {
    await r.compileAsync(s, cam)
  } catch {
    /* se compilara al primer uso */
  }
}

/** Crea y calienta los renderers (llamar al arrancar la app). */
export function warmRenderers() {
  if (pool.length >= 2) return
  const a = makeRenderer()
  const b = makeRenderer()
  pool.push(a, b)
  void warm(a).then(() => warm(b))
}

export function mountScene(
  el: HTMLElement,
  textureUrls: string[],
  build: (ctx: Ctx, textures: THREE.CanvasTexture[]) => Live,
  onReady?: () => void,
): Mounted {
  const renderer = takeRenderer()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  let viewH = 10.7
  let originY = 0.5
  let live: Live | null = null
  let raf = 0
  let disposed = false
  let zoomTarget = 1

  const ctx: Ctx = {
    scene: new THREE.Scene(),
    camera,
    renderer,
    w: 1,
    h: 1,
    motion: mq.matches ? 0.1 : 1,
    originY: 0.5,
    setView(vh, oy) {
      viewH = vh
      originY = oy
      ctx.originY = oy
      applyView()
    },
  }

  function applyView() {
    camera.position.set(0, 0, viewH / 2 / TAN)
    camera.setViewOffset(ctx.w, ctx.h, 0, (0.5 - originY) * ctx.h, ctx.w, ctx.h)
    camera.updateProjectionMatrix()
  }

  function measure() {
    const r = el.getBoundingClientRect()
    ctx.w = Math.max(1, Math.round(r.width))
    ctx.h = Math.max(1, Math.round(r.height))
    renderer.setSize(ctx.w, ctx.h, false)
    camera.aspect = ctx.w / ctx.h
    applyView()
    live?.resize?.()
  }

  const onMotion = () => (ctx.motion = mq.matches ? 0.1 : 1)
  mq.addEventListener('change', onMotion)
  const ro = new ResizeObserver(measure)
  ro.observe(el)
  measure()

  Promise.all(textureUrls.map(loadPlanetTexture)).then(async (textures) => {
    if (disposed) return
    live = build(ctx, textures)
    measure()
    // subida de texturas y compilacion de shaders repartidas en frames, antes de mostrar la escena: sin tirones al entrar
    for (const t of textures) {
      renderer.initTexture(t)
      await nextFrame()
    }
    try {
      await renderer.compileAsync(ctx.scene, camera)
    } catch {
      /* se compilara en el primer render */
    }
    if (disposed) return
    renderer.domElement.classList.add('ready')
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const z = camera.zoom + (zoomTarget - camera.zoom) * (1 - Math.exp(-dt * 8))
      if (Math.abs(z - camera.zoom) > 0.0005) {
        camera.zoom = z
        camera.updateProjectionMatrix()
      }
      live!.update(dt, now / 1000)
      renderer.render(ctx.scene, camera)
    }
    raf = requestAnimationFrame(loop)
    // tras dos frames ya hay una imagen real del planeta pintada
    if (onReady) requestAnimationFrame(() => requestAnimationFrame(onReady))
  })

  return {
    zoomBy(f) {
      zoomTarget = Math.min(1.8, Math.max(0.7, zoomTarget * f))
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      mq.removeEventListener('change', onMotion)
      ctx.scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
        mats.forEach((mat) => {
          mat.dispose()
        })
      })
      // el renderer vuelve al pool (sin destruir el contexto); las texturas compartidas siguen subidas a su GPU
      renderer.clear()
      renderer.domElement.classList.remove('ready')
      renderer.domElement.remove()
      pool.push(renderer)
    },
  }
}

/** Esfera con textura de planeta dentro de un pivote inclinado (eje). El cuerpo gira en rotation.y. */
export function makePlanet(tex: THREE.Texture, radius: number, tilt: number, tint: THREE.ColorRepresentation = 0xffffff, atmo = '255,170,60') {
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 72, 54),
    new THREE.MeshStandardMaterial({ map: tex, color: tint, roughness: 1, metalness: 0, transparent: true }),
  )
  const pivot = new THREE.Group()
  pivot.rotation.set(0.28, 0, tilt)
  pivot.add(body)
  // atmosfera: halo calido pegado al limbo, detras del planeta
  const air = glow(radius * 1.42, 1 / 1.42, atmo, 0.7)
  air.position.z = -0.05
  pivot.add(air)
  return { pivot, body }
}

export function addLights(scene: THREE.Scene, dir: [number, number, number], ambient = 1.5, key = 2.6) {
  scene.add(new THREE.AmbientLight(0xfff4e6, ambient))
  const d = new THREE.DirectionalLight(0xffe6c4, key)
  d.position.set(...dir)
  scene.add(d)
}

export function ellipse(a: number, b: number, color: number, opacity: number, rotZ = 0, z = 0) {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < 180; i++) {
    const t = (i / 180) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(t) * a, Math.sin(t) * b, 0))
  }
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  )
  line.rotation.z = rotZ
  line.position.z = z
  return line
}

/** Halo radial: transparente hasta `inner` (fraccion del radio del sprite), pico ambar en el borde y caida suave. */
const glowCache = new Map<string, THREE.CanvasTexture>()
export function glow(radius: number, inner: number, rgb = '239,157,37', peak = 0.85) {
  const key = `${rgb}|${inner.toFixed(3)}|${peak}`
  let tex = glowCache.get(key)
  if (!tex) glowCache.set(key, (tex = glowTexture(inner, rgb, peak)))
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  s.scale.setScalar(radius * 2)
  return s
}
function glowTexture(inner: number, rgb: string, peak: number) {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256)
  grad.addColorStop(0, `rgba(${rgb},0)`)
  grad.addColorStop(Math.max(0, inner - 0.02), `rgba(${rgb},0)`)
  grad.addColorStop(inner, `rgba(${rgb},${peak})`)
  grad.addColorStop(inner + (1 - inner) * 0.18, `rgba(${rgb},${peak * 0.38})`)
  grad.addColorStop(inner + (1 - inner) * 0.5, `rgba(${rgb},${peak * 0.1})`)
  grad.addColorStop(1, `rgba(${rgb},0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 512, 512)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function dust(n: number, spreadX: number, spreadY: number, color: number, size = 2) {
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    p[i * 3] = (Math.random() - 0.5) * 2 * spreadX
    p[i * 3 + 1] = (Math.random() - 0.5) * 2 * spreadY
    p[i * 3 + 2] = (Math.random() - 0.5) * 3
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3))
  return new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity: 0.7 }))
}

const tmp = new THREE.Vector3()
/** Mundo -> pixeles de pantalla. */
export function toScreen(v: THREE.Vector3, camera: THREE.Camera, w: number, h: number) {
  tmp.copy(v).project(camera)
  return { x: ((tmp.x + 1) / 2) * w, y: ((1 - tmp.y) / 2) * h }
}

let tailTex: THREE.CanvasTexture | null = null
/** Estela de cometa: transparente en la cola, ambar en la cabeza. */
function cometTail() {
  if (tailTex) return tailTex
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 32
  const g = c.getContext('2d')!
  const h = g.createLinearGradient(0, 0, 256, 0)
  h.addColorStop(0, 'rgba(70,40,15,0)')
  h.addColorStop(0.55, 'rgba(90,50,15,0.35)')
  h.addColorStop(1, 'rgba(239,157,37,0.95)')
  g.fillStyle = h
  g.fillRect(0, 0, 256, 32)
  g.globalCompositeOperation = 'destination-in'
  const v = g.createLinearGradient(0, 0, 0, 32)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(0.5, 'rgba(0,0,0,1)')
  v.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = v
  g.fillRect(0, 0, 256, 32)
  tailTex = new THREE.CanvasTexture(c)
  tailTex.colorSpace = THREE.SRGBColorSpace
  return tailTex
}

/**
 * Cielo vivo: estrellas (puntos negros, algunas titilan), nubes galacticas de colores oscuros que derivan
 * y cometas que cruzan cada pocos segundos. Devuelve update(t, motion).
 */
export function addSky(scene: THREE.Scene, spreadX = 13, spreadY = 7.5) {
  scene.add(dust(4200, spreadX, spreadY, 0x16110b, 1.3))
  scene.add(dust(900, spreadX, spreadY, 0x16110b, 2))
  const big = dust(170, spreadX, spreadY, 0x16110b, 3.2)
  scene.add(big)

  // nubes: bandas alargadas + manchas grandes
  const cols = ['40,22,80', '20,60,70', '90,25,45', '25,35,85', '15,70,55', '70,35,20', '55,20,70', '20,45,75']
  const bands = cols.map((rgb, i) => {
    const wide = i < 5
    const s = glow(1, 0.01, rgb, wide ? 0.5 : 0.4)
    wide ? s.scale.set(rand(9, 15), rand(1.8, 3), 1) : s.scale.set(rand(6, 11), rand(5, 9), 1)
    s.material.rotation = rand(-0.6, 0.6)
    s.position.set(rand(-spreadX, spreadX) * 0.75, rand(-spreadY, spreadY) * 0.85, -3)
    scene.add(s)
    return { s, x: s.position.x, y: s.position.y, ph: i * 1.7, base: rand(0.6, 1) }
  })

  // cometas
  const comets = Array.from({ length: 3 }, (_, i) => {
    const tail = new THREE.Sprite(new THREE.SpriteMaterial({ map: cometTail(), transparent: true, depthWrite: false }))
    const head = glow(0.38, 0.01, '255,196,110', 0.95)
    head.material.depthWrite = false
    tail.visible = head.visible = false
    tail.position.z = head.position.z = -2
    scene.add(tail, head)
    return { tail, head, on: false, wait: 1.5 + i * 2.5 + Math.random() * 3, x: 0, y: 0, dx: 0, dy: 0, len: 4 }
  })
  const spawn = (c: (typeof comets)[number]) => {
    const fromLeft = Math.random() < 0.5
    const sp = rand(7, 11)
    const ang = rand(0.1, 0.45) * (Math.random() < 0.7 ? -1 : 1)
    c.x = (fromLeft ? -1 : 1) * (spreadX + 3)
    c.y = rand(-spreadY * 0.6, spreadY)
    c.dx = (fromLeft ? 1 : -1) * Math.cos(ang) * sp
    c.dy = Math.sin(ang) * sp * (fromLeft ? 1 : -1)
    c.len = rand(3.5, 6)
    const th = Math.atan2(c.dy, c.dx)
    c.tail.material.rotation = th
    c.tail.scale.set(c.len, 0.26, 1)
    c.on = c.tail.visible = c.head.visible = true
  }

  let prev = -1
  return (t: number, m: number) => {
    const dt = prev < 0 ? 0 : Math.min(0.1, t - prev)
    prev = t
    for (const b of bands) {
      const k = t * 0.05 * m + b.ph
      b.s.position.set(b.x + Math.sin(k) * 1.2, b.y + Math.cos(k * 0.7) * 0.5, -3)
      b.s.material.opacity = b.base * (0.65 + 0.35 * Math.sin(k * 1.3))
    }
    big.material.opacity = 0.7 + 0.25 * Math.sin(t * 1.7)
    for (const c of comets) {
      if (!c.on) {
        if ((c.wait -= dt * m) <= 0) spawn(c)
        continue
      }
      c.x += c.dx * dt * m
      c.y += c.dy * dt * m
      const mag = Math.hypot(c.dx, c.dy)
      c.head.position.set(c.x, c.y, -2)
      c.tail.position.set(c.x - (c.dx / mag) * c.len * 0.5, c.y - (c.dy / mag) * c.len * 0.5, -2)
      if (Math.abs(c.x) > spreadX + 5 + c.len) {
        c.on = c.tail.visible = c.head.visible = false
        c.wait = rand(4, 9)
      }
    }
  }
}
function rand(a: number, b: number) {
  return a + Math.random() * (b - a)
}

// ---- continuidad Home -> Clientes ----
export const CLIENTS_R = 3.15
/** Altura (px) del timeline de Clientes; la actualiza Clients al medirla. */
export const clientsBar = { px: 209 }
/** Rotacion del planeta al terminar el viaje, para que Clientes siga desde ahi. */
export const handoff: { rotY: number | null } = { rotY: null }
/** Encuadre del planeta en Clientes (misma formula que usa su resize). */
export function clientsLayout(w: number, h: number, bar: number) {
  const avail = Math.max(240, h - (bar + 30) - (w < 600 ? 120 : 0))
  return {
    avail,
    viewH: Math.max((CLIENTS_R * 2 * 1.28 * h) / avail, (CLIENTS_R * 2 * 1.3 * h) / w),
    originY: (avail / 2 + 0.04 * h) / h,
  }
}

export const PROJECTS_R = 3.15
/** Encuadre de la pantalla Proyectos: planeta grande a la izquierda, medio escondido fuera de pantalla. */
export function projectsLayout(w: number, h: number) {
  const phone = w < 700
  const rpx = phone ? w * 0.5 : Math.min(h * 0.46, w * 0.3)
  const cx = phone ? w * 0.1 : rpx * 0.12
  const cy = phone ? h * 0.2 : h * 0.6
  return { rpx, cx, cy, viewH: (PROJECTS_R * h) / rpx, originY: cy / h }
}

export type WarpDest = 'clientes' | 'proyectos' | 'finanzas' | 'tareas'
/** Donde (px) y como (inclinacion) termina el planeta destino del viaje, para que la pantalla siguiente continue sin salto. */
export function warpTarget(key: WarpDest, w: number, h: number) {
  if (key === 'proyectos' || key === 'finanzas' || key === 'tareas') {
    const l = projectsLayout(w, h)
    return { cx: l.cx, cy: l.cy, rpx: l.rpx, rx: 0.2, rz: 0.08 }
  }
  const l = clientsLayout(w, h, clientsBar.px)
  return { cx: w / 2, cy: l.originY * h, rpx: (CLIENTS_R * h) / l.viewH, rx: 0.16, rz: 0.12 }
}
