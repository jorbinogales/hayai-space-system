// Propuestas comerciales (mensualidad base + extras) y el catálogo de ofertas. Capa de datos de la web: mismo servicio que la API v1
// (POST /api/clients/:id/proposals), con los cuerpos en español.
import { useSyncExternalStore } from 'react'
import { api } from './api'

export type ItemTipo = 'mensualidad' | 'extra_mensual' | 'extra_unico'
export const ITEM_TIPO_LABEL: Record<ItemTipo, string> = { mensualidad: 'Mensualidad base', extra_mensual: 'Extra mensual', extra_unico: 'Extra único' }

export interface Offering {
  id: string
  clave: string
  nombre: string
  tipo: string
  mensualidad_sugerida: number | null
  instalacion_sugerida: number | null
  descripcion: string | null
  activa: boolean
}
export interface ProposalItem {
  id: string
  tipo: ItemTipo
  concepto: string
  cantidad: number
  precio_unitario: number
  subtotal: number
  oferta_id: string | null
  oferta: string | null
}
export interface Proposal {
  id: string
  cliente_id: string
  version: number
  estado: 'borrador' | 'presentada' | 'aceptada' | 'rechazada' | 'reemplazada'
  vigente: boolean
  notas: string | null
  creada_por: string
  creada_el: string
  items: ProposalItem[]
  totales: { mensual: number; unico: number }
}

export const loadOfferings = () => api.get<{ data: Offering[] }>('/offerings').then((r) => r.data)
export const loadProposals = (clientId: string) => api.get<{ data: Proposal[] }>(`/clients/${clientId}/proposals`).then((r) => r.data)

export interface ProposalBody {
  items: { tipo: ItemTipo; concepto: string; cantidad: number; precio_unitario: number; oferta_id?: string }[]
  notas?: string
  /** si nace de un ítem del feed: queda enlazado («✓ Creada») */
  feed_item_id?: string
}
export const createProposal = (clientId: string, b: ProposalBody) => api.post<{ proposal: Proposal }>(`/clients/${clientId}/proposals`, b).then((r) => r.proposal)

// ---------- «Nueva propuesta» abierta desde otro sitio (el feed): se abre sobre la ficha del cliente ----------
export interface ProposalRequest {
  clientId: string
  feedItemId?: string
  /** prellenado de la mensualidad base */
  concepto?: string
  notas?: string
}
let request: ProposalRequest | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
/** Pide abrir el formulario de propuesta de ese cliente; la ficha (History) lo muestra en cuanto está abierta. */
export function openProposal(r: ProposalRequest) {
  request = r
  emit()
}
export function closeProposal() {
  if (request) {
    request = null
    emit()
  }
}
export const useProposalRequest = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => request,
  )

/** Avisa a quien muestre propuestas de un cliente que cambiaron (la lista de la ficha vuelve a pedirlas). */
let version = 0
const verSubs = new Set<() => void>()
export const bumpProposals = () => {
  version++
  verSubs.forEach((f) => f())
}
export const useProposalsVersion = () =>
  useSyncExternalStore(
    (f) => (verSubs.add(f), () => void verSubs.delete(f)),
    () => version,
  )
