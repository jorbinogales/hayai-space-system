// Fuentes externas de la Central de marketing. Todas con la misma regla: las credenciales viven SOLO en el servidor (variables de entorno),
// nunca llegan al navegador ni al repositorio, y nada de aquí crea, edita ni pausa nada en las plataformas (solo lectura).
//  - Autocompletado de Google (suggestqueries.google.com): gratis y sin llave. Alimenta el explorador de keywords.
//  - Brightdata (SERP): consume saldo de la cuenta. NO se llama sin que el usuario confirme el costo (lo exige el servicio).
//  - Meta Marketing API (insights): gasto, leads y costo por lead de las campañas, solo lectura.
import { HttpError } from './util.ts'

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
export { norm }

// ---------- autocompletado de Google ----------
const PREGUNTAS = ['cómo', 'qué', 'por qué', 'cuánto', 'cuál', 'dónde', 'para qué', 'cuándo', 'quién']
const esPregunta = (t: string) => /\?/.test(t) || new RegExp(`^(${PREGUNTAS.map(norm).join('|')}|como|que|cuanto|cual|donde|cuando|quien|puedo|se puede)\\b`).test(norm(t))

async function suggest(q: string): Promise<string[]> {
  const base = process.env.GOOGLE_SUGGEST_BASE ?? 'https://suggestqueries.google.com'
  const r = await fetch(`${base}/complete/search?client=firefox&hl=es&gl=ve&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as unknown
  const list = Array.isArray(j) && Array.isArray(j[1]) ? (j[1] as unknown[]) : []
  return list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

export type Sugerencia = { texto: string; tipo: 'sugerencia' | 'pregunta' }

/** Sugerencias del autocompletado para una semilla, más las preguntas típicas («la gente también pregunta»). Cae con 502 si Google no responde. */
export async function investigarSemilla(semilla: string): Promise<{ sugerencias: Sugerencia[]; consultas: number; fallidas: number }> {
  const consultas = [semilla, `${semilla} `, ...PREGUNTAS.map((p) => `${p} ${semilla}`)]
  const res = await Promise.allSettled(consultas.map(suggest))
  const ok = res.filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
  if (!ok.length) throw new HttpError(502, 'El autocompletado de Google no respondió. Prueba en un momento o carga las palabras a mano.')
  const visto = new Set<string>([norm(semilla)])
  const out: Sugerencia[] = []
  for (const r of ok)
    for (const t of r.value) {
      const k = norm(t)
      if (visto.has(k) || k.length > 120) continue
      visto.add(k)
      out.push({ texto: t.trim(), tipo: esPregunta(t) ? 'pregunta' : 'sugerencia' })
    }
  return { sugerencias: out, consultas: consultas.length, fallidas: res.length - ok.length }
}

// ---------- Brightdata (SERP de Google) ----------
/** Costo estimado por consulta, en USD. Es un estimado configurable (BRIGHTDATA_SERP_COST_USD): el precio real depende del plan de la cuenta. */
export const serpCostoUSD = () => {
  const n = Number(process.env.BRIGHTDATA_SERP_COST_USD)
  return Number.isFinite(n) && n >= 0 && process.env.BRIGHTDATA_SERP_COST_USD !== undefined ? n : 0.0015
}
export const brightdataListo = () => !!(process.env.BRIGHTDATA_API_KEY && process.env.BRIGHTDATA_SERP_ZONE)

export type SerpFila = { posicion: number; titulo: string; dominio: string; url: string }

export const dominioDe = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Top 10 orgánico de Google (es, Venezuela). Brightdata devuelve JSON con `organic` (o `results`); se leen los dos nombres por si cambia la forma. */
export async function serpGoogle(consulta: string): Promise<SerpFila[]> {
  const key = process.env.BRIGHTDATA_API_KEY
  const zone = process.env.BRIGHTDATA_SERP_ZONE
  if (!key || !zone) throw new HttpError(503, 'Brightdata no está configurado en el servidor (faltan BRIGHTDATA_API_KEY y BRIGHTDATA_SERP_ZONE)')
  const base = process.env.BRIGHTDATA_BASE ?? 'https://api.brightdata.com'
  const url = `https://www.google.com/search?q=${encodeURIComponent(consulta)}&hl=es&gl=ve&num=10&brd_json=1`
  let r: Response
  try {
    r = await fetch(`${base}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ zone, url, format: 'raw' }),
      signal: AbortSignal.timeout(45_000),
    })
  } catch {
    throw new HttpError(502, 'Brightdata no respondió. Inténtalo de nuevo en un momento.')
  }
  if (!r.ok) throw new HttpError(502, `Brightdata respondió con error (${r.status}). No se guardó nada.`)
  let j: unknown
  try {
    j = await r.json()
  } catch {
    throw new HttpError(502, 'Brightdata devolvió algo que no se pudo leer. No se guardó nada.')
  }
  const o = j as { organic?: unknown[]; results?: unknown[] }
  const lista = (Array.isArray(o.organic) ? o.organic : Array.isArray(o.results) ? o.results.filter((x) => (x as { type?: string }).type === 'organic') : []) as Record<string, unknown>[]
  const filas: SerpFila[] = []
  for (const [i, x] of lista.entries()) {
    const link = typeof x.link === 'string' ? x.link : typeof x.url === 'string' ? x.url : ''
    if (!link) continue
    const pos = [x.rank, x.global_rank, x.position].find((n) => typeof n === 'number') as number | undefined
    filas.push({ posicion: pos ?? i + 1, titulo: typeof x.title === 'string' ? x.title.slice(0, 300) : link, dominio: dominioDe(link), url: link.slice(0, 500) })
  }
  return filas.sort((a, b) => a.posicion - b.posicion).slice(0, 10)
}

// ---------- Meta (campañas, solo lectura) ----------
export type Campana = { id: string; cuenta_id: string; nombre: string; estado: string; gasto: number; leads: number; cpl: number | null }
export type CuentaMeta = { id: string; nombre: string; moneda: string }

const cuentasConfig = () =>
  (process.env.META_AD_ACCOUNT_IDS ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^act_/, ''))
    .filter((x) => /^\d+$/.test(x))

export const metaCampanasListo = () => !!(process.env.META_ADS_TOKEN && cuentasConfig().length)
/** Por qué no está conectado (null si lo está): se muestra tal cual en la pestaña. */
export const metaCampanasMotivo = (): string | null =>
  !process.env.META_ADS_TOKEN ? 'Falta el token de solo lectura de Meta en el servidor (META_ADS_TOKEN).' : !cuentasConfig().length ? 'Faltan las cuentas publicitarias en el servidor (META_AD_ACCOUNT_IDS).' : null

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const ver = process.env.META_GRAPH_VERSION ?? 'v21.0'
  const base = process.env.META_ADS_BASE ?? process.env.META_GRAPH_BASE ?? 'https://graph.facebook.com'
  const qs = new URLSearchParams({ ...params, access_token: process.env.META_ADS_TOKEN ?? '' })
  let r: Response
  try {
    r = await fetch(`${base}/${ver}/${path}?${qs}`, { signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new HttpError(502, 'Meta no respondió. Inténtalo de nuevo en un momento.')
  }
  if (!r.ok) throw new HttpError(502, r.status === 400 || r.status === 401 || r.status === 403 ? 'Meta rechazó la consulta: revisa que el token tenga permiso de lectura (ads_read) sobre la cuenta.' : `Meta respondió con error (${r.status}).`)
  return (await r.json()) as T
}

const cache = new Map<string, { at: number; v: unknown }>()
const cacheMs = () => (process.env.META_ADS_CACHE_MS !== undefined ? Number(process.env.META_ADS_CACHE_MS) : 300_000)

/** Gasto, leads y costo por lead por campaña de los últimos `dias` días (solo lectura). `cuenta` filtra una sola cuenta publicitaria. */
export async function campanasMeta(dias: number, cuenta?: string): Promise<{ cuentas: CuentaMeta[]; campanas: Campana[] }> {
  const ids = cuentasConfig().filter((c) => !cuenta || c === cuenta.replace(/^act_/, ''))
  const k = `${dias}|${ids.join(',')}`
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < cacheMs()) return hit.v as { cuentas: CuentaMeta[]; campanas: Campana[] }
  const hasta = new Date()
  const desde = new Date(hasta.getTime() - (dias - 1) * 86_400_000)
  const d = (x: Date) => x.toISOString().slice(0, 10)
  const cuentas: CuentaMeta[] = []
  const campanas: Campana[] = []
  for (const id of ids) {
    const a = `act_${id}`
    const [info, camps, ins] = await Promise.all([
      graph<{ name?: string; currency?: string }>(a, { fields: 'name,currency' }),
      graph<{ data?: { id: string; name?: string; effective_status?: string }[] }>(`${a}/campaigns`, { fields: 'id,name,effective_status', limit: '200' }),
      graph<{ data?: { campaign_id: string; campaign_name?: string; spend?: string; actions?: { action_type: string; value: string }[] }[] }>(`${a}/insights`, {
        level: 'campaign',
        fields: 'campaign_id,campaign_name,spend,actions',
        time_range: JSON.stringify({ since: d(desde), until: d(hasta) }),
        limit: '200',
      }),
    ])
    cuentas.push({ id, nombre: info.name ?? `act_${id}`, moneda: info.currency ?? 'USD' })
    const porId = new Map((ins.data ?? []).map((r) => [r.campaign_id, r]))
    const vistos = new Set<string>()
    for (const c of camps.data ?? []) {
      vistos.add(c.id)
      campanas.push(fila(id, c.id, c.name ?? c.id, c.effective_status ?? 'DESCONOCIDO', porId.get(c.id)))
    }
    // con gasto en el período pero ya sin aparecer en la lista (archivada): igual cuenta
    for (const [cid, r] of porId) if (!vistos.has(cid)) campanas.push(fila(id, cid, r.campaign_name ?? cid, 'ARCHIVADA', r))
  }
  const v = { cuentas, campanas }
  cache.set(k, { at: Date.now(), v })
  return v
}

function fila(cuenta: string, id: string, nombre: string, estado: string, r?: { spend?: string; actions?: { action_type: string; value: string }[] }): Campana {
  const gasto = Math.round(Number(r?.spend ?? 0) * 100) / 100 || 0
  const acts = r?.actions ?? []
  const lead = acts.find((a) => a.action_type === 'lead') ?? acts.find((a) => a.action_type === 'onsite_conversion.lead_grouped')
  const leads = Math.round(Number(lead?.value ?? 0)) || 0
  return { id, cuenta_id: cuenta, nombre, estado, gasto, leads, cpl: leads > 0 ? Math.round((gasto / leads) * 100) / 100 : null }
}
