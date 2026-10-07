// Feed de oportunidades (planeta HAYAI): lo que las máquinas y los agentes ENCONTRARON. La bitácora es lo que el equipo HIZO;
// esto es lo que llega de afuera. Capa de datos de la pantalla (GET/POST /api/feed...) + el aviso en vivo + el "abrir el feed".
import { useSyncExternalStore } from 'react'
import { api } from './api'

export const FEED_TIPOS = ['idea', 'prospecto', 'alerta', 'noticia', 'oportunidad', 'proyecto'] as const
export const FEED_ESTADOS = ['nuevo', 'revisado', 'descartado', 'convertido'] as const
export type FeedTipo = (typeof FEED_TIPOS)[number]
export type FeedEstado = (typeof FEED_ESTADOS)[number]
export type FeedConversion = 'posible_cliente' | 'tarea' | 'proyecto'

export const FEED_TIPO_LABEL: Record<FeedTipo, string> = {
  idea: 'Idea',
  prospecto: 'Prospecto',
  alerta: 'Alerta',
  noticia: 'Noticia',
  oportunidad: 'Oportunidad',
  proyecto: 'Proyecto',
}
export const FEED_ESTADO_LABEL: Record<FeedEstado, string> = { nuevo: 'Nuevo', revisado: 'Revisado', descartado: 'Descartado', convertido: 'Convertido' }

export interface FeedItem {
  id: string
  titulo: string
  resumen: string | null
  tipo: FeedTipo
  fuente: string
  clave_externa: string | null
  publicado_por: { id: string; nombre: string }
  estado: FeedEstado
  motivo_descarte: string | null
  /** forma libre: negocio, fugas, guion, urls, metricas, telefono, email, origen... */
  datos: Record<string, unknown>
  fecha: string
  publicado_el: string
  revisado_por: string | null
  revisado_el: string | null
  convertido: { a: FeedConversion; id: string | null } | null
  /** marca de versión: se manda de vuelta como If-Match al marcar o convertir */
  actualizado_el: string | null
}
export interface FeedMeta {
  page: number
  per_page: number
  total: number
  /** el contador visible del hub: no depende del filtro */
  nuevos: number
  por_estado: Record<FeedEstado, number>
  por_tipo: Record<FeedTipo, { total: number; nuevos: number }>
  fuentes: { fuente: string; total: number; nuevos: number }[]
}
export interface FeedPage {
  data: FeedItem[]
  meta: FeedMeta
}
export interface FeedFilters {
  tipo?: FeedTipo
  estado?: FeedEstado
  fuente?: string
  q?: string
  page?: number
  per_page?: number
}

const qs = (f: FeedFilters) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const loadFeed = (f: FeedFilters = {}) => api.get<FeedPage>(`/feed${qs(f)}`)
/** Un ítem por id (GET /feed/:id): la campana abre una tarjeta que puede no estar en la primera página. */
export const loadFeedItem = (id: string) => api.get<FeedItem>(`/feed/${encodeURIComponent(id)}`)

/** Publicar a mano (la fuente es «manual»; quien publica sale de la sesión). */
export const publishFeed = (b: { titulo: string; tipo: FeedTipo; resumen?: string; datos?: Record<string, unknown>; fuente?: string }) =>
  api.post<FeedItem & { creado: boolean }>('/feed', { fuente: 'manual', ...b })

export const markFeed = (it: FeedItem, estado: 'nuevo' | 'revisado' | 'descartado', motivo?: string) =>
  api.patch<FeedItem>(`/feed/${it.id}/estado`, { estado, ...(motivo ? { motivo } : {}) }, { ifMatch: it.actualizado_el })

export interface ConvertBody {
  a: FeedConversion
  nombre?: string
  origen?: string
  notas?: string
  telefono?: string
  email?: string
  valor_estimado?: number
  titulo?: string
  proyecto_id?: string
  vence?: string
  responsable?: string
  cliente_id?: string
  descripcion?: string
}
export interface ConvertResult {
  item: FeedItem
  creado: { tipo: FeedConversion; id: string; detalle: Record<string, unknown> }
}
export const convertFeed = (it: FeedItem, b: ConvertBody) => api.post<ConvertResult>(`/feed/${it.id}/convertir`, b)

// ---------- aviso en vivo: llegó algo nuevo al feed ----------
let tick = 0
const tickSubs = new Set<() => void>()
/** live.ts lo llama cuando el servidor avisa `feed_nuevo`: las pantallas que muestran el feed lo vuelven a pedir. */
export const notifyFeed = () => {
  tick++
  tickSubs.forEach((f) => f())
}
export const useFeedTick = () =>
  useSyncExternalStore(
    (f) => (tickSubs.add(f), () => void tickSubs.delete(f)),
    () => tick,
  )

// ---------- abrir el feed desde otro sitio (la campana) ----------
export interface FeedFocus {
  /** si viene, esa tarjeta se resalta (y se baja hasta ella) */
  itemId?: string | null
  filters?: Pick<FeedFilters, 'tipo' | 'fuente' | 'estado'>
}
let pending: FeedFocus | null = null
const focusSubs = new Set<() => void>()
/** Lleva al Hub con el feed enfocado (y, si hace falta, filtrado). */
export function openFeed(f: FeedFocus = {}) {
  pending = f
  if (location.hash.slice(1).split('/')[0] === 'hub') focusSubs.forEach((fn) => fn())
  else location.hash = 'hub'
}
/** El feed recoge (una sola vez) lo que se le pidió enfocar. */
export const takeFeedFocus = (): FeedFocus | null => {
  const f = pending
  pending = null
  return f
}
/** Se dispara cuando se pide enfocar el feed estando ya en el Hub. */
export const onFeedFocus = (fn: () => void) => (focusSubs.add(fn), () => void focusSubs.delete(fn))
