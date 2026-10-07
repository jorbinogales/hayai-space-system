// Lo que pasa en el equipo, en vivo: un stream SSE (/api/events) trae cada aviso al instante; si se corta, se reconecta pidiendo lo
// que falto, y un sondeo cada 30 s cubre un proxy que retenga el stream. Tambien guarda las alertas (cuotas, seguimientos) y los
// popups. Todo en memoria, como el resto de listas: se vacia al cerrar sesion.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { loadClients } from './store'
import { loadProjects } from './projectData'
import { loadTasks } from './taskData'
import { noteVersion } from './updates'
import { notifyFeed } from './feedData'

export type ActivityKind = 'cliente_nuevo' | 'posible_nuevo' | 'tarea_nueva' | 'tarea_completada' | 'cobro_cobrado' | 'cambio_etapa' | 'cliente_ganado' | 'cliente_perdido' | 'lead_meta' | 'acuerdo_nuevo' | 'sistema_caido' | 'sistema_recuperado' | 'version_nueva' | 'feed_nuevo'
export interface Activity {
  id: number
  tipo: ActivityKind
  texto: string
  actor: { id: string; nombre: string; avatar: string }
  propia: boolean
  sujeto: string
  detalle: string | null
  cliente_id: string | null
  proyecto_id: string | null
  tarea_id: string | null
  fecha: string
}
export interface Alert {
  clave: string
  tipo: 'cuota_vencida' | 'seguimiento' | 'actualizacion' | 'feed'
  fecha: string
  dias: number
  titulo: string
  detalle: string
  /** null en la alerta de actualización (no es de un cliente) */
  cliente_id: string | null
  cliente: string | null
  monto: number | null
  leida: boolean
  /** solo en 'actualizacion': la versión anunciada */
  version?: string
  /** solo en 'feed': qué llegó (tipo del ítem y fuente), cuántos van juntos y, si es uno solo, su id */
  feed?: { tipo: string; fuente: string; cantidad: number; item_id: string | null }
}
export interface Toast {
  key: number
  event: Activity
}

interface State {
  alerts: Alert[]
  alertsUnread: number
  activity: Activity[]
  /** ids de actividad de otros que el socio aun no ha visto (para el punto "nuevo" y la cuenta de la campana) */
  activityUnread: number
  /** hasta que id se marco como visto; lo de despues se pinta como nuevo en el panel */
  seenUpTo: number
  toasts: Toast[]
  online: boolean
}

let state: State = { alerts: [], alertsUnread: 0, activity: [], activityUnread: 0, seenUpTo: 0, toasts: [], online: true }
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export const useLive = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  )
/** Lo que muestra el numero de la campana. */
export const unreadTotal = (s: State) => s.alertsUnread + s.activityUnread

const MAX_ACTIVITY = 40
const MAX_TOASTS = 3
let toastKey = 0
let lastId = 0
let es: EventSource | null = null
let timers: number[] = []
let running = false
let refreshTimer = 0

// ---------- alertas y actividad (lecturas) ----------
type Paged<T> = { data: T[]; meta: Record<string, number> }

export async function refreshAlerts() {
  const r = await api.get<Paged<Alert>>('/notifications?per_page=50')
  set({ alerts: r.data, alertsUnread: r.meta.sin_leer })
}
export async function refreshActivity() {
  const r = await api.get<Paged<Activity & { leida: boolean }>>(`/activity?per_page=${MAX_ACTIVITY}`)
  lastId = Math.max(lastId, r.meta.ultimo_id)
  set({ activity: r.data, activityUnread: r.meta.sin_leer, seenUpTo: r.meta.visto_hasta })
}

export async function markAlerts(claves: string[] | 'todas') {
  const body = claves === 'todas' ? { todas: true } : { claves }
  const r = await api.post<{ sin_leer: number }>('/notifications/read', body)
  set({
    alerts: state.alerts.map((a) => (claves === 'todas' || claves.includes(a.clave) ? { ...a, leida: true } : a)),
    alertsUnread: r.sin_leer,
  })
}
export async function markActivitySeen() {
  if (!state.activityUnread && !state.activity.length) return
  const upTo = Math.max(lastId, ...state.activity.map((a) => a.id))
  const r = await api.post<{ visto_hasta: number; sin_leer: number }>('/activity/read', { hasta_id: upTo })
  // seenUpTo NO se mueve aqui: el panel sigue marcando como "nuevo" lo que acaba de ver hasta que se cierre y se reabra.
  set({ activityUnread: r.sin_leer })
}
/** El panel se cerro: lo visto deja de ser "nuevo". */
export const settleSeen = () => set({ seenUpTo: Math.max(state.seenUpTo, lastId) })

// ---------- toasts ----------
export const dismissToast = (key: number) => set({ toasts: state.toasts.filter((t) => t.key !== key) })

function pushToast(event: Activity) {
  const t = { key: ++toastKey, event }
  set({ toasts: [...state.toasts, t].slice(-MAX_TOASTS) })
}

// ---------- recibir un aviso ----------
/** Que lista hay que recargar para que la pantalla de este socio refleje lo que hizo el otro. */
function reloadFor(e: Activity) {
  if (e.tipo === 'version_nueva') return // no cambia ningún dato de la pantalla
  if (e.tipo === 'feed_nuevo') return void notifyFeed() // el feed del Hub se vuelve a pedir; lo demás no cambia
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    if (e.tipo === 'cliente_nuevo' || e.tipo === 'lead_meta') void loadClients().catch(() => {})
    else if (e.tipo === 'cobro_cobrado') void loadClients().catch(() => {})
    // Un cambio de etapa puede crear la tarea de visita, el proyecto o los cobros de la venta: se recarga todo lo que toca.
    else if (e.tipo === 'posible_nuevo' || e.tipo === 'cambio_etapa' || e.tipo === 'cliente_ganado' || e.tipo === 'cliente_perdido')
      void Promise.all([loadClients(), loadProjects(), loadTasks()]).catch(() => {})
    else void loadTasks().catch(() => {})
  }, 600) // un instante: varios avisos seguidos recargan una sola vez
}

function receive(e: Activity) {
  if (state.activity.some((a) => a.id === e.id)) return // el stream y el sondeo pueden traer el mismo
  lastId = Math.max(lastId, e.id)
  // Una versión nueva publicada: el banner aparece al instante y la alerta de la campana se trae del servidor.
  if (e.tipo === 'version_nueva') {
    noteVersion(e.sujeto)
    void refreshAlerts().catch(() => {})
  }
  // Algo nuevo en el feed de oportunidades: su alerta de la campana se trae del servidor.
  if (e.tipo === 'feed_nuevo') void refreshAlerts().catch(() => {})
  set({
    activity: [e, ...state.activity].sort((a, b) => b.id - a.id).slice(0, MAX_ACTIVITY),
    activityUnread: state.activityUnread + (e.propia ? 0 : 1),
  })
  reloadFor(e)
  // Popup solo si lo hizo otro y la pestaña se esta viendo: en segundo plano nadie lo leeria y se perderia.
  if (!e.propia && !document.hidden) pushToast(e)
}

// ---------- conexion ----------
function connect() {
  es?.close()
  es = new EventSource(lastId ? `/api/events?desde_id=${lastId}` : '/api/events')
  es.addEventListener('actividad', (m) => {
    set({ online: true })
    receive(JSON.parse((m as MessageEvent<string>).data) as Activity)
  })
  es.onopen = () => set({ online: true })
  es.onerror = () => {
    set({ online: false })
    // EventSource reconecta solo ante un corte; si el servidor respondio con error se cierra y hay que reabrirlo a mano.
    if (es?.readyState === EventSource.CLOSED) timers.push(window.setTimeout(() => running && connect(), 4000))
  }
}

/** Sondeo de respaldo: si el stream estuviera retenido por un proxy, lo nuevo llega igual (con unos segundos de retraso). */
async function poll() {
  try {
    const r = await api.get<Paged<Activity>>(`/activity?desde_id=${lastId}&orden=asc&per_page=50`)
    for (const e of r.data) receive(e)
    set({ online: true })
  } catch {
    /* sin red: el siguiente intento */
  }
}

const onVisible = () => {
  if (document.hidden) return
  void poll()
  void refreshAlerts().catch(() => {})
}

export function startLive() {
  if (running) return
  running = true
  void Promise.all([refreshAlerts(), refreshActivity()])
    .catch(() => {})
    .then(() => running && connect())
  timers.push(window.setInterval(() => void poll(), 30_000))
  timers.push(window.setInterval(() => void refreshAlerts().catch(() => {}), 60_000)) // las alertas se derivan al consultar
  document.addEventListener('visibilitychange', onVisible)
}

export function stopLive() {
  running = false
  es?.close()
  es = null
  timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)))
  timers = []
  window.clearTimeout(refreshTimer)
  document.removeEventListener('visibilitychange', onVisible)
  lastId = 0
  set({ alerts: [], alertsUnread: 0, activity: [], activityUnread: 0, seenUpTo: 0, toasts: [], online: true })
}
