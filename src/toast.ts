// Aviso flotante «Listo ✓» con «Deshacer» opcional: vive fuera de las tarjetas (la tarjeta puede desmontarse al convertir) y expira solo.
import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  text: string
  /** segunda línea (qué quedó creado) */
  detail?: string
  tone: 'ok' | 'info'
  /** si viene, aparece el botón «Deshacer»; lanza el error con el mensaje que ve el socio */
  undo?: () => Promise<void>
  /** cuánto dura en pantalla, en ms */
  ms: number
}
let list: Toast[] = []
let seq = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** Cuánto dura el «Deshacer» a la vista (el servidor lo admite 2 minutos; en pantalla bastan unos segundos). */
export const UNDO_MS = 8000
export function pushToast(t: Omit<Toast, 'id' | 'ms' | 'tone'> & { ms?: number; tone?: Toast['tone'] }): number {
  const id = ++seq
  // un aviso nuevo reemplaza al anterior con «Deshacer» (no se apilan): lo anterior ya no se puede deshacer desde aquí
  list = [...list.filter((x) => !x.undo || !t.undo).slice(-2), { tone: 'ok', ms: t.undo ? UNDO_MS : 4000, ...t, id }]
  emit()
  return id
}
export function dismissToast(id: number) {
  list = list.filter((x) => x.id !== id)
  emit()
}
export const useToasts = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => list,
  )
