// Espacio de trabajo (tenant) activo. El servidor lo exige en cada peticion (X-Tenant-Id) y valida membresia y modulo; aqui solo se
// guarda cual esta elegido (el ultimo por usuario, en localStorage) y que modulos tiene el socio en el. Hoja del grafo de imports a
// proposito: api.ts lo lee y nada de aqui depende de api.ts.
import { useSyncExternalStore } from 'react'

export const MODULES = ['hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'tablero', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'] as const
export type ModuleKey = (typeof MODULES)[number]

export const MODULE_LABEL: Record<ModuleKey, string> = {
  hub: 'Hub',
  feed: 'Feed',
  clientes: 'Clientes',
  crm: 'CRM',
  cobros: 'Cobros',
  proyectos: 'Proyectos',
  tareas: 'Tareas',
  tablero: 'Tablero',
  finanzas: 'Finanzas',
  marketing: 'Marketing',
  sistemas: 'Sistemas',
  chat: 'Chat',
  integraciones: 'Integraciones',
  papelera: 'Papelera',
}

export interface Tenant {
  id: string
  name: string
  slug: string
  modules: ModuleKey[]
}

/** Modulo que exige cada pantalla (null = libre). `gastos` es la vista Gastos de Finanzas. */
export const SCREEN_MODULE: Record<string, ModuleKey | null> = {
  home: null,
  hub: 'hub',
  clientes: 'clientes',
  proyectos: 'proyectos',
  tareas: 'tareas',
  tablero: 'tablero',
  finanzas: 'finanzas',
  gastos: 'finanzas',
  marketing: 'marketing',
}

interface State {
  userId: string | null
  tenants: Tenant[]
  activeId: string | null
}

let state: State = { userId: null, tenants: [], activeId: null }
const subs = new Set<() => void>()
const set = (next: State) => {
  state = next
  subs.forEach((f) => f())
}

const storeKey = (userId: string) => `hayai.tenant.${userId}`
const stored = (userId: string) => {
  try {
    return localStorage.getItem(storeKey(userId))
  } catch {
    return null
  }
}
const remember = (userId: string, id: string) => {
  try {
    localStorage.setItem(storeKey(userId), id)
  } catch {
    /* sin almacenamiento: se elige de nuevo en la proxima visita */
  }
}

/**
 * Fija los tenants del usuario (login, /auth/me) y elige el activo: el que ya estaba si sigue valiendo, si no el ultimo guardado
 * para ese usuario, si no el primero. Devuelve el id activo (null = sin acceso a ningun espacio).
 */
export function setTenants(userId: string, tenants: Tenant[]): string | null {
  const kept = state.userId === userId && tenants.some((t) => t.id === state.activeId) ? state.activeId : null
  const id = kept ?? tenants.find((t) => t.id === stored(userId))?.id ?? tenants[0]?.id ?? null
  if (id) remember(userId, id)
  set({ userId, tenants, activeId: id })
  return id
}

/** Cambia el tenant activo (debe ser uno de los del usuario). */
export function selectTenant(id: string) {
  if (!state.userId || !state.tenants.some((t) => t.id === id)) return
  remember(state.userId, id)
  set({ ...state, activeId: id })
}

/** Cierre de sesion: no queda nada del usuario (la eleccion guardada si, para su proxima entrada). */
export const clearTenants = () => set({ userId: null, tenants: [], activeId: null })

export const activeTenantId = () => state.activeId
const activeOf = (s: State) => s.tenants.find((t) => t.id === s.activeId) ?? null
export const activeTenant = () => activeOf(state)
/** Lectura puntual (fuera de React): ¿el socio tiene este modulo en el tenant activo? */
export const can = (m: ModuleKey | null | undefined) => !m || !!activeOf(state)?.modules.includes(m)
/** ¿Puede abrir esta pantalla (o vista) en el tenant activo? */
export const canOpen = (screen: string) => can(SCREEN_MODULE[screen])

export const useTenants = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  )
/** Tenant activo y utilidades para la interfaz: se redibuja al cambiar de tenant o de permisos. */
export function useTenant() {
  const s = useTenants()
  const active = activeOf(s)
  return { tenants: s.tenants, active, can: (m: ModuleKey | null | undefined) => !m || !!active?.modules.includes(m) }
}
