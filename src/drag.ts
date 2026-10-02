import { useEffect, type RefObject } from 'react'

/**
 * Desplazamiento con el raton: mantener pulsado y arrastrar mueve el contenido (como en tactil), con inercia.
 * Un clic normal (sin arrastre) llega intacto a los botones de dentro. `axis: 'x'` ademas convierte la rueda vertical en horizontal.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>, axis: 'x' | 'y', deps: unknown[] = []) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let down = false
    let moved = false
    let sx = 0
    let sy = 0
    let start = 0
    let last = 0
    let lastT = 0
    let vel = 0
    let raf = 0

    const pos = () => (axis === 'x' ? el.scrollLeft : el.scrollTop)
    const set = (v: number) => (axis === 'x' ? (el.scrollLeft = v) : (el.scrollTop = v))

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return // en tactil ya hay desplazamiento nativo
      cancelAnimationFrame(raf)
      down = true
      moved = false
      sx = e.clientX
      sy = e.clientY
      start = pos()
      last = axis === 'x' ? e.clientX : e.clientY
      lastT = performance.now()
      vel = 0
    }
    const onMove = (e: PointerEvent) => {
      if (!down) return
      const cur = axis === 'x' ? e.clientX : e.clientY
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 5) {
        moved = true
        el.classList.add('is-dragging')
        el.setPointerCapture(e.pointerId)
      }
      if (!moved) return
      set(start - (cur - (axis === 'x' ? sx : sy)))
      const now = performance.now()
      vel = (last - cur) / Math.max(1, now - lastT)
      last = cur
      lastT = now
    }
    const onUp = () => {
      if (!down) return
      down = false
      el.classList.remove('is-dragging')
      if (!moved) return
      // inercia
      let v = vel * 16
      const step = () => {
        if (Math.abs(v) < 0.3) return
        set(pos() + v)
        v *= 0.93
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    // tras arrastrar, el clic que sigue al soltar no debe activar un boton
    const onClick = (e: MouseEvent) => {
      if (moved) {
        e.stopPropagation()
        e.preventDefault()
        moved = false
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (axis !== 'x' || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClick, true)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('wheel', onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, axis, ...deps])
}
