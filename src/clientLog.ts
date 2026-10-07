// Bitácora del cliente (llamadas, visitas, WhatsApp, notas y los cambios de etapa que escribe el servidor) y datos de CRM de la ficha.
// GET/POST /api/clients/:id/interactions. Las entradas de tipo «etapa» son automáticas: no se crean ni se editan desde aquí.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Client } from './store'

export const KINDS = ['llamada', 'visita', 'whatsapp', 'nota'] as const
export type Kind = (typeof KINDS)[number]
export const KIND_LABEL: Record<Kind | 'etapa', string> = { llamada: 'Llamada', visita: 'Visita', whatsapp: 'WhatsApp', nota: 'Nota', etapa: 'Etapa' }

export interface Interaction {
  id: string
  cliente_id: string
  tipo: Kind | 'etapa'
  /** instante ISO */
  fecha: string
  resumen: string
  /** solo las de etapa: de qué etapa (clave) a cuál, y por qué se perdió */
  cambio: { de: string | null; a: string; motivo: string | null; propuesta_version: number | null } | null
  automatica: boolean
  registrada_por: string
}

type Phase = 'loading' | 'ok' | 'error'

/** Las interacciones del cliente (las 100 más recientes) con su total. Se vuelve a pedir al cambiar de cliente o con `reload`. */
export function useClientLog(clientId: string | null) {
  const [items, setItems] = useState<Interaction[]>([])
  const [total, setTotal] = useState(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const seq = useRef(0)

  const reload = useCallback(async () => {
    if (!clientId) return
    const mine = ++seq.current
    try {
      const r = await api.get<{ data: Interaction[]; meta: { total: number } }>(`/clients/${clientId}/interactions?per_page=100`)
      if (mine !== seq.current) return // llegó tarde: ya se pidió otro cliente
      setItems(r.data)
      setTotal(r.meta.total)
      setPhase('ok')
      setError('')
    } catch (e) {
      if (mine !== seq.current) return
      setError(e instanceof Error ? e.message : 'No se pudo cargar la bitácora.')
      setPhase('error')
    }
  }, [clientId])

  useEffect(() => {
    setItems([])
    setTotal(0)
    setPhase('loading')
    void reload()
    return () => void seq.current++
  }, [reload])

  return { items, total, phase, error, reload }
}

/** Registra una llamada, visita, WhatsApp o nota. `fecha` (AAAA-MM-DD) no puede ser futura; sin ella es ahora. */
export const addInteraction = (clientId: string, d: { tipo: Kind; resumen: string; fecha?: string }) => api.post<Interaction>(`/clients/${clientId}/interactions`, d)

// ---------- etapas del pipeline (de la API, no hardcodeadas) ----------
export interface Stage {
  etapa: string
  nombre: string
  posicion: number
  probabilidad: number
  tipo: 'abierta' | 'ganada' | 'perdida'
  activa: boolean
}
let stagesCache: Stage[] | null = null
let stagesAsk: Promise<Stage[]> | null = null
/** Etapas del pipeline, una sola consulta por sesión de la pestaña. */
export function useStages() {
  const [stages, setStages] = useState<Stage[]>(stagesCache ?? [])
  useEffect(() => {
    if (stagesCache) return
    let live = true
    stagesAsk ??= api.get<{ data: Stage[] }>('/pipeline/stages').then((r) => (stagesCache = r.data))
    stagesAsk.then((s) => live && setStages(s)).catch(() => (stagesAsk = null)) // sin etapas la ficha muestra la clave tal cual
    return () => void (live = false)
  }, [])
  return stages
}

/** Origen del lead (claves de la API) como se lee en pantalla. */
export const SOURCE_LABEL: Record<string, string> = {
  referido: 'Referido',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  meta_ads: 'Meta Ads',
  web: 'Web',
  visita_frio: 'Visita en frío',
  evento: 'Evento',
  otro: 'Otro',
}

// ---------- campos de CRM que el servidor ya manda en /clients ----------
/** Lo que `GET /clients` trae además de lo que declara `Client` en store.ts (ficha, pipeline y seguimiento). */
export interface ClientCrm {
  createdAt?: string | null
  email?: string | null
  contactName?: string | null
  contactRole?: string | null
  address?: string | null
  notes?: string | null
  tags?: string[]
  source?: string | null
  stage?: string | null
  estValue?: number | null
  probability?: number | null
  expectedClose?: string | null
  lostReason?: string | null
  nextAction?: string | null
  nextActionDate?: string | null
  lastContactAt?: string | null
}
export const crmOf = (c: Client): ClientCrm => c as Client & ClientCrm
