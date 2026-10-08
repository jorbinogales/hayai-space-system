// Chat interno del equipo: un solo canal de notas entre astronautas. Capa de datos (GET/POST /api/chat...) + lo que llega en vivo por el
// stream (evento «chat» de /api/events, ver live.ts) + los contadores del icono de mensajes (sin leer y menciones sin leer).
// Todo en memoria, como el resto de listas: se vacia al cerrar sesion.
import { useSyncExternalStore } from 'react'
import { api } from './api'

export interface ChatMessage {
  id: string
  autor: { id: string; nombre: string }
  cuerpo: string
  /** 'manual' si lo escribió un socio en la web; si no, la app o automatización que lo publicó */
  fuente: string
  clave_externa: string | null
  menciones: { id: string; nombre: string }[]
  editado_el: string | null
  /** instante con microsegundos: es el cursor del keyset y del «leído hasta» (se manda de vuelta tal cual) */
  creado_el: string
  /** marca de versión: se manda de vuelta como If-Match al editar */
  actualizado_el: string | null
}
interface Counters {
  sin_leer: number
  menciones_sin_leer: number
  leido_hasta: string
}
interface Page {
  data: ChatMessage[]
  meta: Counters & { hay_mas: boolean; siguiente: { antes_de: string; antes_de_id: string } | null }
}
/** Lo que manda el servidor por el stream: un mensaje nuevo o editado, o el id de uno borrado. */
export type ChatEvent = { op: 'nuevo' | 'editado'; mensaje: ChatMessage } | { op: 'borrado'; id: string }

export interface ChatToast {
  key: number
  message: ChatMessage
}
interface State {
  /** del más viejo al más nuevo (se lee de arriba abajo, lo último abajo) */
  messages: ChatMessage[]
  loaded: boolean
  loading: boolean
  hayMas: boolean
  sinLeer: number
  mencionesSinLeer: number
  leidoHasta: string | null
  /** el «leído hasta» de ANTES de abrir el panel: lo posterior es lo nuevo para este socio */
  seenUpTo: string | null
  /** no se pudo traer el canal al abrirlo */
  error: boolean
  open: boolean
  toast: ChatToast | null
}

const PAGE = 30
let state: State = { messages: [], loaded: false, loading: false, hayMas: false, sinLeer: 0, mencionesSinLeer: 0, leidoHasta: null, seenUpTo: null, error: false, open: false, toast: null }
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export const useChat = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  )

let me: string | null = null
let toastKey = 0
let timer = 0
/** Quien tiene la sesión: para saber si un mensaje es suyo o lo menciona. */
export const setChatUser = (id: string | null) => void (me = id)

const order = (a: ChatMessage, b: ChatMessage) => (a.creado_el < b.creado_el ? -1 : a.creado_el > b.creado_el ? 1 : a.id < b.id ? -1 : 1)
const upsert = (list: ChatMessage[], m: ChatMessage) => [...list.filter((x) => x.id !== m.id), m].sort(order)
const counters = (c: Counters) => ({ sinLeer: c.sin_leer, mencionesSinLeer: c.menciones_sin_leer, leidoHasta: c.leido_hasta })
export const mentionsMe = (m: ChatMessage) => !!me && m.menciones.some((x) => x.id === me)

// ---------- lecturas ----------
export async function refreshChatCounters() {
  if (!me) return
  set(counters(await api.get<Counters>('/chat/contadores')))
}

/** Carga (o recarga) lo más reciente. Devuelve el «leído hasta» de ANTES de marcar, o null si no se pudo (queda en `error`). */
export async function loadChat(): Promise<string | null> {
  set({ loading: true, error: false })
  try {
    const r = await api.get<Page>(`/chat?limite=${PAGE}`)
    set({ messages: [...r.data].reverse(), loaded: true, loading: false, hayMas: r.meta.hay_mas, ...counters(r.meta) })
    return r.meta.leido_hasta
  } catch {
    set({ loading: false, error: true })
    return null
  }
}

/** Los anteriores al más viejo que ya hay (keyset: nunca se salta ni repite nada, aunque lleguen mensajes nuevos). */
export async function loadOlder() {
  const oldest = state.messages[0]
  if (!oldest || state.loading || !state.hayMas) return
  set({ loading: true })
  try {
    const r = await api.get<Page>(`/chat?limite=${PAGE}&antes_de=${encodeURIComponent(oldest.creado_el)}&antes_de_id=${oldest.id}`)
    set({ messages: [...[...r.data].reverse(), ...state.messages], hayMas: r.meta.hay_mas, loading: false })
  } catch (e) {
    set({ loading: false })
    throw e
  }
}

// ---------- escrituras ----------
export async function sendChat(cuerpo: string) {
  const m = await api.post<ChatMessage & { creado: boolean }>('/chat', { cuerpo })
  set({ messages: upsert(state.messages, m) }) // el aviso en vivo trae el mismo: se junta por id
  return m
}
export async function editChat(m: ChatMessage, cuerpo: string) {
  const out = await api.patch<ChatMessage>(`/chat/${m.id}`, { cuerpo }, { ifMatch: m.actualizado_el })
  set({ messages: upsert(state.messages, out) })
}
/** Vuelve a pedir un mensaje (p. ej. tras un conflicto al editarlo). */
export async function reloadMessage(id: string) {
  set({ messages: upsert(state.messages, await api.get<ChatMessage>(`/chat/${id}`)) })
}
export async function deleteChat(m: ChatMessage) {
  await api.del(`/chat/${m.id}`)
  set({ messages: state.messages.filter((x) => x.id !== m.id) })
  void refreshChatCounters().catch(() => {})
}

/** Marca como leído hasta el mensaje más nuevo que se está mostrando (no «ahora»: lo que llegue después sigue sin leer). */
export async function markChatRead() {
  const newest = state.messages.at(-1)
  if (!newest || (!state.sinLeer && !state.mencionesSinLeer)) return
  set(counters(await api.post<Counters>('/chat/leido', { hasta: newest.creado_el })))
}

// ---------- el panel ----------
/** El panel se abre o se cierra. Al abrir: trae lo último, guarda el «leído hasta» previo (para señalar lo nuevo) y marca leído. */
export async function setChatOpen(open: boolean) {
  set({ open, toast: open ? null : state.toast })
  if (!open) return
  const seen = await loadChat()
  if (seen === null) return
  set({ seenUpTo: seen })
  if (state.open) await markChatRead().catch(() => {})
}

export const dismissChatToast = () => set({ toast: null })

// ---------- recibir un aviso en vivo ----------
const soon = (fn: () => void) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(fn, 150) // varios avisos seguidos se cuentan una sola vez
}

export function receiveChat(e: ChatEvent) {
  if (e.op === 'borrado') {
    set({ messages: state.messages.filter((x) => x.id !== e.id) })
  } else {
    const m = e.mensaje
    if (state.loaded) set({ messages: upsert(state.messages, m) })
    // Alguien me nombró y no tengo el chat a la vista: aviso lateral (la pestaña oculta no lo leería).
    if (e.op === 'nuevo' && m.autor.id !== me && mentionsMe(m) && !state.open && !document.hidden) set({ toast: { key: ++toastKey, message: m } })
  }
  // Con el panel abierto lo que llega se está leyendo; cerrado, solo cambian los contadores.
  soon(() => void (state.open && !document.hidden ? markChatRead() : refreshChatCounters()).catch(() => {}))
}

/** El stream se (re)conectó: lo que pasó mientras estuvo caído se vuelve a pedir. */
export function chatReconnected() {
  if (state.loaded && state.open) void loadChat()
  else void refreshChatCounters().catch(() => {})
}

export function resetChat() {
  window.clearTimeout(timer)
  me = null
  set({ messages: [], loaded: false, loading: false, hayMas: false, sinLeer: 0, mencionesSinLeer: 0, leidoHasta: null, seenUpTo: null, error: false, open: false, toast: null })
}
