// Datos del Hub central (GET /api/hub) y de Marketing (GET /api/marketing/funnel). Lecturas con estado propio de cada pantalla:
// no son listas compartidas, asi que viven en un hook local con recarga manual (y en vivo desde el Hub).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Activity } from './live'

export interface Carga {
  abiertas: number
  vencidas: number
  completadas_7d: number
  internas_abiertas: number
}
export interface Astronauta {
  id: string
  nombre: string
  avatar: string
  rol: string | null
  responsabilidades: string | null
  carga: Carga
}
export type AcuerdoEstado = 'abierto' | 'cumplido' | 'descartado'
export interface Acuerdo {
  id: string
  texto: string
  fecha_reunion: string
  responsable: { id: string; nombre: string } | null
  vence: string | null
  estado: AcuerdoEstado
  cerrado_el: string | null
  registrado_por: string
  /** marca de version: se manda de vuelta como `actualizado_el` al editar */
  actualizado_el: string | null
}
export type SistemaEstado = 'arriba' | 'caido' | 'desconocido'
export interface Sistema {
  id: string
  cliente_id: string
  cliente: string
  nombre: string
  enlace: string | null
  url_produccion: string | null
  url_verificacion: string | null
  verificar: boolean
  activo: boolean
  estado: SistemaEstado
  desde: string | null
  ultima_verificacion: string | null
  ultima_vez_arriba: string | null
  codigo_http: number | null
  respuesta_ms: number | null
  error: string | null
  disponibilidad_24h: number | null
}
export interface HubData {
  pulso: {
    mes: string
    gastos_generales_mes: number
    gastos_generales_movimientos: number
    tareas_internas: { pendientes: number; vencidas: number; completadas_mes: number }
    proyectos_internos: { activos: number; total: number }
  }
  astronautas: Astronauta[]
  bitacora: Activity[]
  acuerdos: { abiertos: Acuerdo[]; por_estado: Record<AcuerdoEstado, number> }
  sistemas: { data: Sistema[]; resumen: Record<SistemaEstado, number> }
  /** feed de oportunidades: cuántos hay nuevos (sirve para el contador antes de que cargue el feed) */
  feed: { nuevos: number; total: number }
  analytics: { disponible: boolean; planeta: 'marketing'; resumen: unknown }
}

export interface Funnel {
  dias: number
  etapas: { etapa: string; nombre: string; probabilidad: number; posibles: number; valor_mensual: number; valor_ponderado: number }[]
  cierres: { ganados: number; perdidos: number; tasa_cierre: number | null }
  por_origen: { origen: string; entraron: number; ganados: number; perdidos: number; abiertos: number }[]
  meta_ads: { leads_30d: number; procesados: number; duplicados: number; con_error: number }
}
export interface PipelineStage {
  etapa: string
  nombre: string
  posicion: number
  probabilidad: number
  tipo: 'abierta' | 'ganada' | 'perdida'
  activa: boolean
}

export interface Loaded<T> {
  data: T | null
  /** error de la ultima carga (los datos viejos, si los hay, se siguen mostrando) */
  error: string | null
  loading: boolean
  reload: () => void
  /** reemplaza los datos en memoria (tras guardar un cambio) */
  patch: (fn: (d: T) => T) => void
}

/** Carga un recurso y lo recarga a demanda. Una respuesta vieja nunca pisa a una mas nueva. */
export function useLoaded<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const fn = useRef(load)
  fn.current = load

  const reload = useCallback(() => {
    const mine = ++seq.current
    setLoading(true)
    fn.current()
      .then((d) => {
        if (mine !== seq.current) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return
        setError(e instanceof Error ? e.message : 'No se pudo cargar.')
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    reload()
    return () => void seq.current++
  }, [reload])

  const patch = useCallback((f: (d: T) => T) => setData((d) => (d ? f(d) : d)), [])
  return { data, error, loading, reload, patch }
}

export const loadHub = () => api.get<HubData>('/hub')
export const loadFunnel = (dias: number) => api.get<Funnel>(`/marketing/funnel?dias=${dias}`)
export const loadStages = async () => (await api.get<{ data: PipelineStage[] }>('/pipeline/stages')).data
