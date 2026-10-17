// Radar de competidores (Feed, v1.8.2): capa de datos de la pantalla (GET/POST/PATCH/DELETE /api/competidores).
import { api, ApiError } from './api'

export const GRUPOS = ['saas_venezolano', 'gratis_offline', 'software_factory', 'restaurant_tech'] as const
export type Grupo = (typeof GRUPOS)[number]
export const GRUPO_LABEL: Record<Grupo, string> = {
  saas_venezolano: 'SaaS venezolano',
  gratis_offline: 'Gratis y offline',
  software_factory: 'Software factory',
  restaurant_tech: 'Tecnología para restaurantes',
}

export interface Competidor {
  id: string
  nombre: string
  web: string | null
  grupo: Grupo
  grupo_etiqueta: string
  que_vende: string | null
  precio: string | null
  mensaje: string | null
  a_quien: string | null
  fortaleza: string | null
  debilidad: string | null
  notas: string | null
  creado_el: string
  actualizado_el: string
}
export interface Oportunidad {
  titulo: string
  texto: string
}
export interface RadarRespuesta {
  data: Competidor[]
  oportunidades: Oportunidad[]
  meta: { total: number }
}

/** Lo que se escribe en el formulario: el texto vacío se guarda como «sin dato». */
export type CompetidorForm = { nombre: string; grupo: Grupo } & Record<'web' | 'que_vende' | 'precio' | 'mensaje' | 'a_quien' | 'fortaleza' | 'debilidad' | 'notas', string>

export const cargarRadar = () => api.get<RadarRespuesta>('/competidores?per_page=100')
export const crearCompetidor = (b: CompetidorForm) => api.post<Competidor>('/competidores', b)
export const editarCompetidor = (id: string, b: Partial<CompetidorForm>) => api.patch<Competidor>(`/competidores/${id}`, b)
export const borrarCompetidor = (id: string) => api.del<{ eliminado: boolean }>(`/competidores/${id}`)

/** El mensaje que ve el socio cuando algo falla. */
export const errorDe = (e: unknown, def: string) => (e instanceof ApiError && e.message && !/^Error \d+$/.test(e.message) ? e.message : def)

/** Sin esquema, el enlace se resolvería contra este sitio: se le antepone https:// (y se descarta lo que no sea http/https). */
export function urlWeb(v: string | null): string | null {
  if (!v) return null
  const t = /^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
/** El sitio sin https:// ni barra final, como se lee mejor. */
export const webCorta = (v: string) => v.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
