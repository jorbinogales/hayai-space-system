import { useEffect, useRef } from 'react'

/** Estado compartido del efecto velocidad luz entre pantallas. k = intensidad de las estelas (0..1), flash = destello de corte. */
/** dir: 1 las estelas salen del centro (acercarse); -1 convergen hacia el centro (alejarse). */
export const fx = { k: 0, flash: 0, dim: 0, dir: 1 }

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- estelas en los bordes ----
const N = 260
const streaks = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, p: Math.random(), v: 0.6 + Math.random() * 1.4, w: 0.5 + Math.random() }))

/** Canvas 2D a pantalla completa: vineta oscura + lineas radiales que salen del centro hacia los bordes. */
export function Warp() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current!
    const g = cv.getContext('2d')!
    let raf = 0
    let last = performance.now()
    let dirty = false

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const dpr = Math.min(devicePixelRatio, 1.5)
      const W = innerWidth
      const H = innerHeight
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
      }
      const { k, flash, dim } = fx
      if (k < 0.003 && flash < 0.003 && dim < 0.003) {
        if (dirty) g.clearRect(0, 0, cv.width, cv.height)
        dirty = false
        return
      }
      dirty = true
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const cx = W / 2
      const cy = H / 2
      const diag = Math.hypot(W, H) / 2

      const vg = g.createRadialGradient(cx, cy, diag * 0.22, cx, cy, diag)
      vg.addColorStop(0, 'rgba(22,17,11,0)')
      vg.addColorStop(1, `rgba(22,17,11,${0.92 * k})`)
      g.fillStyle = vg
      g.fillRect(0, 0, W, H)
      if (dim > 0.003) {
        g.fillStyle = `rgba(22,17,11,${dim})`
        g.fillRect(0, 0, W, H)
      }

      g.lineCap = 'round'
      for (const s of streaks) {
        s.p = ((s.p + fx.dir * dt * s.v * (0.3 + k * 1.7)) % 1 + 1) % 1
        const head = s.p ** 1.6
        const len = (0.04 + 0.35 * k) * s.p
        // dir 1: la cola queda atras (mas cerca del centro); dir -1: la cola queda detras (mas afuera) y todo se aleja
        const tail = fx.dir > 0 ? Math.max(0, head - len) : Math.min(1.3, head + len)
        const r0 = diag * (0.3 + 0.78 * Math.min(tail, head))
        const r1 = diag * (0.3 + 0.78 * Math.max(tail, head))
        const cos = Math.cos(s.a)
        const sin = Math.sin(s.a)
        g.strokeStyle = `rgba(${s.w > 1 ? '255,205,130' : '255,246,230'},${k * Math.min(1, head * 1.6) * 0.85})`
        g.lineWidth = s.w * (0.6 + head * 2.2)
        g.beginPath()
        g.moveTo(cx + cos * r0, cy + sin * r0)
        g.lineTo(cx + cos * r1, cy + sin * r1)
        g.stroke()
      }

      if (flash > 0.003) {
        g.fillStyle = `rgba(255,236,200,${flash})`
        g.fillRect(0, 0, W, H)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} className="warp" aria-hidden="true" />
}

/**
 * "Salto" al abrir un formulario: una rafaga de estelas que se apaga y el entorno queda oscuro mientras `active`; al cerrar, vuelve.
 * (Los pantallas ocultan sus objetos con la clase .deep.)
 */
export function useDive(active: boolean) {
  useEffect(() => {
    const d1 = active ? 0.86 : 0
    const peak = reduced() ? 0.2 : 0.9
    const t0 = performance.now()
    let raf = 0
    let last = t0
    const step = (now: number) => {
      const t = (now - t0) / 1000
      fx.k = active ? peak * (t < 0.45 ? (t / 0.45) ** 2 : Math.max(0, 1 - (t - 0.45) / 0.55)) : 0
      fx.dim += (d1 - fx.dim) * (1 - Math.exp(-Math.min(0.05, (now - last) / 1000) * 5))
      last = now
      if (active ? t < 1 || Math.abs(d1 - fx.dim) > 0.004 : fx.dim > 0.004) raf = requestAnimationFrame(step)
      else (fx.k = 0, fx.dim = d1)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [active])

  useEffect(() => () => void (fx.k = fx.dim = 0), [])
}
