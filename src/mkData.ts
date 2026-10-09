// Datos de la Central de marketing (/api/marketing/*): keywords, competidores, contenido y campañas. Mismos servicios que la API v1 y el MCP.
import { api } from './api'

export const INTENCIONES = ['informacional', 'comercial', 'local', 'marca'] as const
export type Intencion = (typeof INTENCIONES)[number]
export const INTENCION_LABEL: Record<Intencion, string> = { informacional: 'Informacional', comercial: 'Comercial', local: 'Local', marca: 'Marca' }
export const ESTADOS_KW = ['por_atacar', 'en_contenido', 'posicionada', 'descartada'] as const
export type EstadoKw = (typeof ESTADOS_KW)[number]
export const ESTADO_KW_LABEL: Record<EstadoKw, string> = { por_atacar: 'Por atacar', en_contenido: 'En contenido', posicionada: 'Posicionada', descartada: 'Descartada' }
export type FuenteKw = 'autocompletado' | 'serp' | 'manual'
export const FUENTE_KW_LABEL: Record<FuenteKw, string> = { autocompletado: 'Autocompletado', serp: 'SERP', manual: 'Manual' }

export interface Keyword {
  id: string
  texto: string
  intencion: Intencion
  estado: EstadoKw
  fuente: FuenteKw
  semilla: string | null
  guardada_el: string
  guardada_por: string | null
  idea_item_id: string | null
  serp_consultado_el: string | null
  contenidos: number
}
export interface Sugerencia {
  texto: string
  tipo: 'sugerencia' | 'pregunta'
  intencion_sugerida: Intencion
  guardada: boolean
  keyword_id: string | null
}
export interface Investigacion {
  semilla: string
  consultas: number
  fallidas: number
  sugerencias: Sugerencia[]
}
export interface SerpFila {
  posicion: number
  titulo: string
  dominio: string
  url: string
  competidor: { id: string; nombre: string } | null
}
export interface Serp {
  consultado_el: string
  consultado_por: string
  costo_estimado_usd: number
  resultados: SerpFila[]
}
export interface SerpAviso {
  keyword: string
  conectado: boolean
  costo_estimado_usd: number
  mensaje: string
  motivo: string | null
  ultimo_serp: Serp | null
}
export interface Hallazgo {
  id: string
  titulo: string
  resumen: string | null
  tipo: string
  fuente: string
  fecha: string
}
export interface Competidor {
  id: string
  nombre: string
  web: string | null
  instagram: string | null
  notas: string | null
  fecha_alta: string
  archivado: boolean
  hallazgos?: Hallazgo[]
}
export interface Aparicion {
  keyword_id: string
  keyword: string
  posicion: number
  titulo: string
  url: string
  consultado_el: string
}
export interface CruceCompetidor {
  competidor: string
  serp_revisados: number
  sin_datos_para_cruzar: string | null
  apariciones: Aparicion[]
}

export const ESTADOS_CT = ['idea', 'produccion', 'publicado'] as const
export type EstadoCt = (typeof ESTADOS_CT)[number]
export const ESTADO_CT_LABEL: Record<EstadoCt, string> = { idea: 'Idea', produccion: 'En producción', publicado: 'Publicado' }
export interface Pieza {
  id: string
  titulo: string
  estado: EstadoCt
  keyword: { id: string; texto: string } | null
  responsable: { id: string; nombre: string }
  fecha_objetivo: string | null
  semaforo: 'vencida' | 'proxima' | 'en_plazo' | null
  notas: string | null
  publicado_en: string | null
  enlace: string | null
  feed_item_id: string | null
}
export interface Campana {
  id: string
  cuenta_id: string
  nombre: string
  estado: string
  gasto: number
  leads: number
  cpl: number | null
}
export interface Campanas {
  dias: number
  conectado: boolean
  motivo: string | null
  error: string | null
  cuentas: { id: string; nombre: string; moneda: string }[]
  campanas: Campana[]
  totales: { moneda: string; gasto: number; leads: number; cpl: number | null } | null
}

const q = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const mk = {
  investigar: (semilla: string) => api.get<Investigacion>(`/marketing/keywords/investigar${q({ semilla })}`),
  keywords: (f: { q?: string; intencion?: string; estado?: string }) => api.get<{ data: Keyword[]; meta: { total: number; por_estado: Partial<Record<EstadoKw, number>> } }>(`/marketing/keywords${q({ ...f, per_page: 100 })}`),
  guardar: (items: { texto: string; intencion?: Intencion; fuente?: FuenteKw; semilla?: string }[]) =>
    api.post<{ recibidas: number; creadas: number; duplicadas: number; data: (Keyword & { creada: boolean })[] }>('/marketing/keywords', { items }),
  kwActualizar: (id: string, b: Partial<{ estado: EstadoKw; intencion: Intencion }>) => api.patch<Keyword>(`/marketing/keywords/${id}`, b),
  serpAviso: (id: string) => api.get<SerpAviso>(`/marketing/keywords/${id}/serp-aviso`),
  serp: (id: string) => api.post<Serp & { keyword: string }>(`/marketing/keywords/${id}/serp`, { confirmar_costo: true }),
  idea: (id: string) => api.post<{ creada: boolean; keyword: Keyword; item_id: string }>(`/marketing/keywords/${id}/idea`),
  kwContenido: (id: string) => api.post<{ creado: boolean; contenido_id: string; contenido: Pieza; keyword: Keyword }>(`/marketing/keywords/${id}/contenido`),

  competidores: (archivados: 'excluir' | 'solo' = 'excluir') => api.get<{ data: Competidor[]; meta: { total: number } }>(`/marketing/competidores${q({ archivados, per_page: 100 })}`),
  competidor: (id: string) => api.get<Competidor>(`/marketing/competidores/${id}`),
  competidorCrear: (b: { nombre: string; web?: string | null; instagram?: string | null; notas?: string | null }) => api.post<Competidor>('/marketing/competidores', b),
  competidorActualizar: (id: string, b: Partial<{ nombre: string; web: string | null; instagram: string | null; notas: string | null; archivado: boolean }>) => api.patch<Competidor>(`/marketing/competidores/${id}`, b),
  competidorKeywords: (id: string) => api.get<CruceCompetidor>(`/marketing/competidores/${id}/keywords`),

  contenidos: () => api.get<{ data: Pieza[]; columnas: Record<EstadoCt, number> }>('/marketing/contenidos'),
  contenidoCrear: (b: { titulo: string; keyword_id?: string | null; responsable?: string; fecha_objetivo?: string | null; notas?: string | null }) => api.post<Pieza>('/marketing/contenidos', b),
  contenidoActualizar: (id: string, b: Partial<{ titulo: string; keyword_id: string | null; responsable: string; fecha_objetivo: string | null; notas: string | null; publicado_en: string | null; enlace: string | null; archivado: boolean }>) =>
    api.patch<Pieza>(`/marketing/contenidos/${id}`, b),
  contenidoMover: (id: string, b: { estado: EstadoCt; publicado_en?: string; enlace?: string }) => api.post<Pieza>(`/marketing/contenidos/${id}/mover`, b),

  campanas: (dias = 30, cuenta?: string) => api.get<Campanas>(`/marketing/campanas${q({ dias, cuenta })}`),
}

/** Texto de error legible de una llamada que falló. */
export const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)
