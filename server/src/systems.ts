// Verificación de los sistemas entregados a los clientes (semáforo del hub). Cada ~10 minutos pide la URL de cada sistema
// activo y registra el resultado; HTTP 2xx/3xx = arriba. Un fallo aislado no alarma: se confirma con un segundo intento
// y solo entonces el sistema pasa a "caído" y se avisa al equipo (una vez; al volver, otro aviso).
//  - Solo lectura: GET a la URL del sistema; no manda cookies ni credenciales.
//  - Protección SSRF: solo http/https y nunca hacia direcciones privadas, locales o de enlace local (también en redirecciones).
//    SYSTEMS_ALLOW_PRIVATE=true la desactiva (solo para pruebas locales).
//  - SYSTEMS_CHECK_MS cambia el periodo (0 apaga el vigilante; la verificación manual sigue funcionando).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { recordActivity } from './activity.ts'
import { pool, tx } from './db.ts'
import { HttpError } from './util.ts'

const TIMEOUT_MS = Number(process.env.SYSTEMS_TIMEOUT_MS) || 10_000
const CONFIRM_MS = process.env.SYSTEMS_RETRY_MS === undefined ? 20_000 : Number(process.env.SYSTEMS_RETRY_MS)
const KEEP_DAYS = 7
const MAX_REDIRECTS = 3

function privateAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.replace(/^::ffff:/i, ''))
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const x = ip.toLowerCase()
  return x === '::' || x === '::1' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')
}

/** Rechaza destinos que no sean sitios públicos. */
export async function assertPublicTarget(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('URL inválida')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Solo se verifican URLs http o https')
  if (u.username || u.password) throw new Error('La URL no puede llevar usuario ni clave')
  if (process.env.SYSTEMS_ALLOW_PRIVATE === 'true') return u
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (!addrs.length || addrs.some(privateAddress)) throw new Error('La URL apunta a una dirección privada o local: no se verifica')
  return u
}

type Probe = { ok: boolean; code: number | null; ms: number; error: string | null }

async function probe(url: string): Promise<Probe> {
  const t0 = Date.now()
  let target = url
  try {
    for (let hop = 0; ; hop++) {
      const u = await assertPublicTarget(target)
      const res = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'HayaiSpace-Monitor/1.0', accept: '*/*' } })
      void res.body?.cancel().catch(() => {}) // solo importa el código
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) return { ok: false, code: res.status, ms: Date.now() - t0, error: 'Demasiadas redirecciones' }
        target = new URL(res.headers.get('location')!, u).toString()
        continue
      }
      return { ok: res.status >= 200 && res.status < 400, code: res.status, ms: Date.now() - t0, error: res.status >= 400 ? `HTTP ${res.status}` : null }
    }
  } catch (e) {
    const err = e as Error & { name?: string; cause?: { code?: string } }
    const why = err.name === 'TimeoutError' ? 'Sin respuesta (tiempo agotado)' : (err.cause?.code ?? err.message)
    return { ok: false, code: null, ms: Date.now() - t0, error: String(why).slice(0, 200) }
  }
}

export type CheckResult = { estado: 'arriba' | 'caido' | 'desconocido'; codigo: number | null; ms: number | null; error: string | null; cambio: boolean }

/** Verifica un sistema ahora y guarda el resultado. Devuelve el estado resultante (tras confirmar un fallo con un 2.º intento). */
export async function checkSystem(systemId: string): Promise<CheckResult> {
  const s = (await pool.query('SELECT id, name, client_id, check_url, prod_url, app_url FROM systems WHERE id = $1', [systemId])).rows[0]
  if (!s) throw new HttpError(404, 'Sistema no encontrado')
  const url = (s.check_url ?? s.prod_url ?? s.app_url) as string | null
  if (!url) {
    await pool.query(`UPDATE systems SET status = 'desconocido', last_check_at = now(), last_error = 'Sin URL para verificar', last_code = NULL, last_ms = NULL WHERE id = $1`, [systemId])
    return { estado: 'desconocido', codigo: null, ms: null, error: 'Sin URL para verificar', cambio: false }
  }
  let r = await probe(url)
  if (!r.ok) {
    await record(systemId, r)
    if (CONFIRM_MS > 0) await new Promise((ok) => setTimeout(ok, CONFIRM_MS))
    r = await probe(url) // segundo intento: un fallo aislado no es una caída
  }
  return apply(systemId, r)
}

const record = (systemId: string, r: Probe) =>
  pool.query('INSERT INTO system_checks (system_id, ok, code, ms, error) VALUES ($1, $2, $3, $4, $5)', [systemId, r.ok, r.code, r.ms, r.error])

async function apply(systemId: string, r: Probe): Promise<CheckResult> {
  await record(systemId, r)
  return tx(async (c) => {
    const cur = (
      await c.query(
        `SELECT s.name, s.client_id, s.status, s.fail_streak, s.created_by, cl.name AS client FROM systems s JOIN clients cl ON cl.id = s.client_id WHERE s.id = $1 FOR UPDATE OF s`,
        [systemId],
      )
    ).rows[0]
    if (!cur) throw new HttpError(404, 'Sistema no encontrado')
    // Un solo fallo que sigue a un "arriba" no cambia el estado hasta confirmarse (aquí llega ya confirmado: dos fallos seguidos).
    const next: 'arriba' | 'caido' = r.ok ? 'arriba' : 'caido'
    const changed = next !== cur.status
    await c.query(
      `UPDATE systems SET status = $2, status_since = CASE WHEN $3::boolean THEN now() ELSE status_since END, last_check_at = now(),
         last_ok_at = CASE WHEN $4::boolean THEN now() ELSE last_ok_at END, last_code = $5, last_ms = $6, last_error = $7,
         fail_streak = CASE WHEN $4::boolean THEN 0 ELSE fail_streak + 1 END WHERE id = $1`,
      [systemId, next, changed, r.ok, r.code, r.ms, r.error],
    )
    // Aviso solo al CAMBIAR: caída confirmada, o recuperación de una caída (arrancar en "arriba" no avisa).
    if (changed && (next === 'caido' || cur.status === 'caido'))
      await recordActivity(c, {
        kind: next === 'caido' ? 'sistema_caido' : 'sistema_recuperado',
        actorId: cur.created_by as string,
        subject: cur.name as string,
        detail: cur.client as string,
        clientId: cur.client_id as string,
        via: 'monitor',
      })
    await c.query(`DELETE FROM system_checks WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS])
    return { estado: next, codigo: r.code, ms: r.ms, error: r.error, cambio: changed }
  })
}

let running = false
/** Verifica todos los sistemas activos con monitoreo (de a 3 en paralelo). */
export async function checkAll(): Promise<number> {
  if (running) return 0
  running = true
  try {
    const ids = (await pool.query(`SELECT id FROM systems WHERE active AND monitor ORDER BY created_at`)).rows.map((r) => r.id as string)
    let i = 0
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++]
        await checkSystem(id).catch((e) => console.error('systems:', id, (e as Error).message))
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return ids.length
  } finally {
    running = false
  }
}

let timer: NodeJS.Timeout | null = null
let first: NodeJS.Timeout | null = null
export function startSystemsWorker() {
  const every = process.env.SYSTEMS_CHECK_MS === undefined ? 600_000 : Number(process.env.SYSTEMS_CHECK_MS)
  if (!every || every < 0 || timer) return
  const tick = () => void checkAll().catch((e) => console.error('systems:', (e as Error).message))
  first = setTimeout(tick, Math.min(every, 30_000)) // el primer semáforo no espera 10 minutos tras arrancar
  first.unref()
  timer = setInterval(tick, every)
  timer.unref()
}
export function stopSystemsWorker() {
  if (timer) clearInterval(timer)
  if (first) clearTimeout(first)
  timer = first = null
}
