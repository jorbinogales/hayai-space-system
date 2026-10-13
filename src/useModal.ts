// Foco atrapado, Esc y foco devuelto para los modales (Cobro, Guión del Feed…).
import { useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'
export function useModal(ref: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  const esc = useRef(onEscape)
  esc.current = onEscape
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    el?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        e.stopPropagation() // no cierra también la factura o el cajón que hay debajo
        e.preventDefault()
        esc.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement)
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === el)) (e.preventDefault(), last.focus())
      else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus())
      else if (!el.contains(at)) (e.preventDefault(), first.focus())
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      prev?.focus?.()
    }
  }, [ref])
}
