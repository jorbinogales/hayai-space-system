// Enlaces dentro de la app. El hash ya decide la pantalla (#clientes, #tareas...); `#clientes/<id>` abre ademas el cajon de ese cliente.
import { useSyncExternalStore } from 'react'

export type Target = { screen: 'clientes' | 'proyectos' | 'tareas' | 'finanzas'; clientId?: string | null }

/** Id de cliente del hash actual (`#clientes/<id>`), o null. */
export const hashClientId = (): string | null => {
  const [screen, id] = location.hash.slice(1).split('/')
  return screen === 'clientes' && id ? id : null
}

/** Lleva a una pantalla; con clientId abre el cajon de ese cliente (tambien si ya se esta en Clientes con ese mismo enlace). */
export function go(t: Target) {
  setInternal(false) // un enlace normal nunca hereda el filtro interno del Hub
  const h = t.clientId && t.screen === 'clientes' ? `clientes/${t.clientId}` : t.screen
  if (location.hash.slice(1) === h) window.dispatchEvent(new Event('hayai:open-client'))
  else location.hash = h
}

// ---------- filtro interno (atajos del Hub) ----------
// Los atajos «Tareas internas», «Gastos internos» y «Finanzas internas» del Hub abren esas pantallas con lo interno de HAYAI
// (sin cliente) ya filtrado. El Hub lo enciende justo antes de navegar; Home lo apaga al volver al core o al entrar normal.
let internal = false
const subs = new Set<() => void>()

/** Enciende o apaga el filtro interno. */
export function setInternal(on: boolean) {
  if (internal === on) return
  internal = on
  subs.forEach((f) => f())
}
/** ¿Hay un filtro interno aplicado? Se re-renderiza al cambiar. */
export const useInternalFilter = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => internal,
  )

/** Un proyecto es interno (de HAYAI) cuando no tiene cliente: el servidor manda `clientId: null`. */
export const isInternalProject = (p: { clientId?: string | null }) => !p.clientId

/**
 * Un gasto es interno cuando no se imputa a ningun cliente: ambito general, o de un proyecto sin cliente.
 * Mismo criterio que `pulso()` del servidor y la fila «Gastos generales de HAYAI» de Finanzas.
 */
export const isInternalExpense = (x: { scope: string; refId?: string | null }, projects: { id: string; clientId?: string | null }[]) =>
  x.scope === 'general' || (x.scope === 'proyecto' && !!x.refId && projects.some((p) => p.id === x.refId && !p.clientId))
