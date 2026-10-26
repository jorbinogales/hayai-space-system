// Webhook saliente de tareas asignadas a Leandro (Release 1.8.3 «Órbita fina IV»).
// Cuando a Leandro le cae una tarea (creada con él como responsable, o reasignada a él),
// Space avisa de inmediato con un POST firmado a un receptor externo, para que Growi lo
// sepa sin tener que consultar. APAGADO por defecto: sin HAYAI_TASK_WEBHOOK_URL o sin
// HAYAI_TASK_WEBHOOK_SECRET no se encola ni se envía nada (igual que el webhook de Meta).
//  - At-least-once: la entrega queda registrada en task_webhook_deliveries y se reintenta
//    con espera creciente (máx. 3 intentos); el receptor deduplica por event_id.
//  - La firma es HMAC-SHA256 sobre el cuerpo crudo, mismo patrón que server/src/meta.ts.
//  - En los logs solo van event_id y estado; jamás el secreto ni el payload completo.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { pool } from './db.ts'

export const TASK_WEBHOOK_EVENT = 'tarea.asignada'
export const TASK_WEBHOOK_MAX_ATTEMPTS = 3

const webhookUrl = () => process.env.HAYAI_TASK_WEBHOOK_URL?.trim() || ''
const webhookSecret = () => process.env.HAYAI_TASK_WEBHOOK_SECRET || ''
const webhookOwner = () => process.env.HAYAI_TASK_WEBHOOK_OWNER?.trim() || 'Leandro'
const retryIntervalMs = () => Number(process.env.TASK_WEBHOOK_RETRY_MS) || 60_000
const retryBaseMs = () => Number(process.env.TASK_WEBHOOK_RETRY_BASE_MS) || 60_000

export const taskWebhookEnabled = () => Boolean(webhookUrl() && webhookSecret())

/** Firma: header X-Hayai-Signature = "sha256=" + hex(HMAC-SHA256(secreto, cuerpo crudo)). */
export function signTaskWebhookBody(secret: string, raw: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}

/** Verifica la firma en tiempo constante; cuerpo alterado, firma corta o ausente => false. */
export function verifyTaskWebhookSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const want = createHmac('sha256', secret).update(raw).digest()
  const got = Buffer.from(header.slice(7), 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

type TareaPayload = {
  id: string
  titulo: string
  proyecto_id: string
  proyecto: string
  vence: string | null
  creada_por: string
  responsable: { id: string; nombre: string }
}

export function buildTaskWebhookPayload(tarea: TareaPayload) {
  return { event_id: randomUUID(), event: TASK_WEBHOOK_EVENT, timestamp: new Date().toISOString(), tarea }
}

/**
 * Encola `tarea.asignada` dentro de la misma transacción del cambio (el cliente `c` es el
 * de la transacción que crea o actualiza la tarea). Solo dispara cuando el responsable
 * resuelto es el socio de HAYAI_TASK_WEBHOOK_OWNER y hay transición hacia él:
 *  - creación (prevRespId null): dispara si la tarea nace con él de responsable;
 *  - actualización: dispara solo si el responsable anterior era otro.
 */
export async function queueTaskWebhookIfAssigned(c: { query: typeof pool.query }, taskId: string, prevRespId: string | null): Promise<void> {
  if (!taskWebhookEnabled()) return
  const row = (
    await c.query(
      `SELECT t.title, t.due_date::text AS vence, p.id AS proyecto_id, p.name AS proyecto,
              cb.name AS creada_por, COALESCE(au.id, po.id) AS resp_id, COALESCE(au.name, po.name) AS resp_name
         FROM tasks t JOIN projects p ON p.id = t.project_id JOIN users cb ON cb.id = t.created_by
         LEFT JOIN users au ON au.id = t.assignee_id JOIN users po ON po.id = p.owner_id
        WHERE t.id = $1`,
      [taskId],
    )
  ).rows[0]
  if (!row) return
  if ((row.resp_name as string).toLowerCase() !== webhookOwner().toLowerCase()) return
  if (prevRespId !== null && prevRespId === (row.resp_id as string)) return
  const payload = buildTaskWebhookPayload({
    id: taskId,
    titulo: row.title as string,
    proyecto_id: row.proyecto_id as string,
    proyecto: row.proyecto as string,
    vence: row.vence as string | null,
    creada_por: row.creada_por as string,
    responsable: { id: row.resp_id as string, nombre: row.resp_name as string },
  })
  await c.query(`INSERT INTO task_webhook_deliveries (event_id, event, task_id, payload) VALUES ($1, $2, $3, $4::jsonb)`, [
    payload.event_id,
    TASK_WEBHOOK_EVENT,
    taskId,
    JSON.stringify(payload),
  ])
}

/** Envía una entrega pendiente; 2xx => enviado, si no => intento + espera creciente (1x, 4x, 9x la base). */
async function deliverOne(row: { event_id: string; payload: unknown; attempts: number }): Promise<void> {
  const raw = Buffer.from(JSON.stringify(row.payload), 'utf8')
  const sentAt = Math.floor(Date.now() / 1000)
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(webhookUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Hayai-Signature': signTaskWebhookBody(webhookSecret(), raw),
        'X-Hayai-Timestamp': String(sentAt),
        'X-Hayai-Event': TASK_WEBHOOK_EVENT,
      },
      body: raw,
      signal: ctrl.signal,
    })
    if (res.ok) {
      await pool.query(`UPDATE task_webhook_deliveries SET status = 'enviado', delivered_at = now() WHERE event_id = $1`, [row.event_id])
      console.log(`webhook tarea: ${row.event_id} enviado`)
      return
    }
    throw new Error(`receptor respondió ${res.status}`)
  } catch (e) {
    const attempts = row.attempts + 1
    const failed = attempts >= TASK_WEBHOOK_MAX_ATTEMPTS
    await pool.query(
      `UPDATE task_webhook_deliveries SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5 WHERE event_id = $1`,
      [
        row.event_id,
        failed ? 'error' : 'pendiente',
        attempts,
        (e as Error).message.slice(0, 300),
        failed ? null : new Date(Date.now() + retryBaseMs() * attempts * attempts),
      ],
    )
    console.error(`webhook tarea: ${row.event_id} intento ${attempts} falló:`, (e as Error).message)
  } finally {
    clearTimeout(timeout)
  }
}

/** Reintenta las entregas pendientes o con error cuya espera ya pasó (máx. 20 por ciclo). */
export async function processPendingTaskWebhooks(limit = 20): Promise<number> {
  if (!taskWebhookEnabled()) return 0
  const { rows } = await pool.query(
    `SELECT event_id, payload, attempts FROM task_webhook_deliveries
      WHERE status IN ('pendiente', 'error') AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
    [limit],
  )
  for (const r of rows) await deliverOne(r)
  return rows.length
}

let timer: NodeJS.Timeout | null = null
export function startTaskWebhookWorker() {
  if (!taskWebhookEnabled() || timer) return
  timer = setInterval(() => void processPendingTaskWebhooks().catch((e) => console.error('webhook tarea:', (e as Error).message)), retryIntervalMs())
  timer.unref()
}
export const stopTaskWebhookWorker = () => {
  if (timer) clearInterval(timer)
  timer = null
}
