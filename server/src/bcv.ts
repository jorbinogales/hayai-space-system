// Tasa BCV (dólar oficial) para la barra superior. La consulta el servidor (nunca el navegador) y la guarda en la BD:
//  - fuentes en orden (BCV_SOURCES, separadas por coma); por defecto ve.dolarapi.com. La primera que responda con una tasa válida gana;
//  - la tasa trae SU fecha (la que reporta la fuente): fin de semana o feriado = la última publicada, con su fecha;
//  - si ninguna fuente responde se sirve lo último guardado (la barra nunca queda en blanco una vez que hubo una tasa);
//  - BCV_TTL_MS (30 min): pasado ese tiempo, la siguiente consulta dispara una actualización en segundo plano sin hacer esperar;
//  - BCV_REFRESH_MS (30 min; 0 lo apaga) la mantiene al día aunque nadie consulte.
import { pool } from './db.ts'

const DEFAULT_SOURCES = ['https://ve.dolarapi.com/v1/dolares/oficial', 'https://ve.dolarapi.com/v1/dolares']
const sources = () =>
  (process.env.BCV_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(process.env.BCV_SOURCES ? [] : DEFAULT_SOURCES)
const TTL_MS = () => (process.env.BCV_TTL_MS === undefined ? 1_800_000 : Number(process.env.BCV_TTL_MS))
const TIMEOUT_MS = Number(process.env.BCV_TIMEOUT_MS) || 8_000
const TZ = process.env.APP_TZ ?? 'America/Caracas'

const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

type Parsed = { rate: number; date: string }

/** Acepta el formato de DolarAPI (objeto, o lista donde se busca la fuente "oficial") y variantes comunes. */
export function parseRate(payload: unknown, now = new Date()): Parsed | null {
  const pick = (x: unknown): Record<string, unknown> | null => {
    if (Array.isArray(x)) return (x.find((i) => i && typeof i === 'object' && String((i as Record<string, unknown>).fuente ?? '').toLowerCase() === 'oficial') as Record<string, unknown>) ?? null
    return x && typeof x === 'object' ? (x as Record<string, unknown>) : null
  }
  const o = pick(payload)
  if (!o) return null
  const raw = o.promedio ?? o.venta ?? o.precio ?? o.price ?? o.rate
  const rate = typeof raw === 'string' ? Number(raw.replace(',', '.')) : (raw as number)
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1e7) return null
  const when = o.fechaActualizacion ?? o.fecha_actualizacion ?? o.fecha ?? o.last_update ?? o.updated
  const t = typeof when === 'string' || typeof when === 'number' ? new Date(when) : null
  const date = t && !Number.isNaN(t.getTime()) ? dayOf(t) : dayOf(now)
  // Una fecha de más de 4 días en el futuro es un dato roto, no una tasa publicada por adelantado (el BCV publica el día hábil siguiente).
  if (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${dayOf(now)}T00:00:00Z`).getTime() > 4 * 86_400_000) return null
  return { rate: Math.round(rate * 10_000) / 10_000, date }
}

let inflight: Promise<boolean> | null = null

/** Pide la tasa a las fuentes en orden y la guarda. true = hay tasa nueva guardada. Nunca lanza. */
export function refreshRate(): Promise<boolean> {
  inflight ??= (async () => {
    for (const url of sources()) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'HayaiSpace/1.5' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const p = parseRate(await res.json())
        if (!p) throw new Error('respuesta sin tasa válida')
        const source = new URL(url).host
        await pool.query(
          `INSERT INTO exchange_rates (rate_date, source, rate, fetched_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (rate_date, source) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = now()`,
          [p.date, source, p.rate],
        )
        return true
      } catch (e) {
        console.error('bcv:', url, (e as Error).message)
      }
    }
    return false
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export type BcvRate = { tasa: number; fecha: string; fuente: string; actualizada_el: string; es_de_hoy: boolean }

async function latest(): Promise<BcvRate | null> {
  const r = (await pool.query('SELECT rate, rate_date::text AS d, source, fetched_at FROM exchange_rates ORDER BY rate_date DESC, fetched_at DESC LIMIT 1')).rows[0]
  if (!r) return null
  return { tasa: Number(r.rate), fecha: r.d as string, fuente: r.source as string, actualizada_el: (r.fetched_at as Date).toISOString(), es_de_hoy: r.d === dayOf(new Date()) }
}

/** La tasa vigente: lo guardado, al instante. Si no hay nada espera a la primera consulta; si está vieja actualiza en segundo plano. */
export async function currentRate(): Promise<BcvRate | null> {
  let r = await latest()
  if (!r) {
    await refreshRate()
    return latest()
  }
  if (Date.now() - new Date(r.actualizada_el).getTime() > TTL_MS()) void refreshRate()
  return r
}

let timer: NodeJS.Timeout | null = null
let first: NodeJS.Timeout | null = null
export function startBcvWorker() {
  const every = process.env.BCV_REFRESH_MS === undefined ? 1_800_000 : Number(process.env.BCV_REFRESH_MS)
  if (!every || every < 0 || timer) return
  first = setTimeout(() => void refreshRate(), 5_000)
  first.unref()
  timer = setInterval(() => void refreshRate(), every)
  timer.unref()
}
export function stopBcvWorker() {
  if (timer) clearInterval(timer)
  if (first) clearTimeout(first)
  timer = first = null
}
