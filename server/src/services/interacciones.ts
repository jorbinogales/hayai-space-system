// Bitacora del cliente: llamadas, visitas, WhatsApp y notas. Las entradas de tipo 'etapa' las escribe SOLO el servidor
// (crm.ts, en cada cambio de etapa): aqui no se pueden crear, editar ni borrar, o el historial del pipeline se podria falsificar.
import { z } from 'zod'
import { pool } from '../db.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { op, pageShape, paged, TZ, todayISO } from './common.ts'

/** Los tipos que un socio (o un agente) puede escribir. 'etapa' no esta: es del sistema. */
export const KINDS = ['llamada', 'visita', 'whatsapp', 'nota'] as const

const SELECT = `SELECT i.id, i.client_id, i.kind, i.occurred_at, i.summary, i.meta, u.name AS author
  FROM interactions i JOIN users u ON u.id = i.created_by`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const interaccionOut = (r: any) => ({
  id: r.id as string,
  cliente_id: r.client_id as string,
  tipo: r.kind as string,
  fecha: (r.occurred_at as Date).toISOString(),
  resumen: r.summary as string,
  // Solo las de etapa: de que etapa a cual (y por que se perdio).
  cambio: r.kind === 'etapa' ? { de: r.meta.de ?? null, a: r.meta.a, motivo: r.meta.motivo ?? null, propuesta_version: r.meta.propuesta_version ?? null } : null,
  automatica: r.kind === 'etapa',
  registrada_por: r.author as string,
})

const TIPO_MSG = 'Tipo inválido (llamada, visita, whatsapp o nota); "etapa" lo escribe solo el sistema'
const FECHA_MSG = 'Fecha inválida (AAAA-MM-DD o AAAA-MM-DDThh:mm:ss con zona, p. ej. 2026-10-06T15:30:00-04:00)'
const fecha = z.union([z.iso.datetime({ offset: true }), isoDate], FECHA_MSG)

/** SQL del instante en que ocurrio. Solo fecha = mediodia de la zona del negocio. No se registra nada en el futuro. */
function occurredAt(f: string, param: number): string {
  if (f.includes('T')) {
    if (Date.parse(f) > Date.now() + 5 * 60_000) throw new HttpError(400, 'fecha: no puede estar en el futuro (lo que viene va como próxima acción)')
    return `$${param}::timestamptz`
  }
  if (f > todayISO()) throw new HttpError(400, 'fecha: no puede estar en el futuro (lo que viene va como próxima acción)')
  return `($${param}::date + time '12:00') AT TIME ZONE '${TZ.replace(/'/g, '')}'`
}

async function una(interactionId: string) {
  const r = (await pool.query(`${SELECT} WHERE i.id = $1`, [interactionId])).rows[0]
  if (!r) throw new HttpError(404, 'Interacción no encontrada')
  return interaccionOut(r)
}

export const interaccionesListar = op(
  z.strictObject({ cliente_id: id, tipo: z.enum([...KINDS, 'etapa'], 'Tipo inválido').optional(), ...pageShape }),
  async (_a, i) => {
    if (!(await pool.query('SELECT 1 FROM clients WHERE id = $1', [i.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
    const args: unknown[] = [i.cliente_id]
    let where = 'WHERE i.client_id = $1'
    if (i.tipo) {
      args.push(i.tipo)
      where += ` AND i.kind = $${args.length}`
    }
    const [total, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM interactions i ${where}`, args),
      pool.query(`${SELECT} ${where} ORDER BY i.occurred_at DESC, i.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [
        ...args,
        i.per_page,
        (i.page - 1) * i.per_page,
      ]),
    ])
    return paged(rows.rows.map(interaccionOut), total.rows[0].n, i.page, i.per_page)
  },
)

export const interaccionRegistrar = op(
  z.strictObject({ cliente_id: id, tipo: z.enum(KINDS, TIPO_MSG), resumen: text(2000), fecha: fecha.optional() }),
  async (actor, b) => {
    if (!(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
    const args: unknown[] = [b.cliente_id, b.tipo, b.resumen, actor.id]
    const when = b.fecha === undefined ? 'now()' : occurredAt(b.fecha, args.push(b.fecha)) // push devuelve el n.º del nuevo marcador
    const { rows } = await pool.query(
      `INSERT INTO interactions (client_id, kind, summary, created_by, occurred_at) VALUES ($1, $2, $3, $4, ${when}) RETURNING id`,
      args,
    )
    return una(rows[0].id)
  },
)

export const interaccionActualizar = op(
  z
    .strictObject({ id, tipo: z.enum(KINDS, TIPO_MSG).optional(), resumen: text(2000).optional(), fecha: fecha.optional() })
    .refine((v) => v.tipo !== undefined || v.resumen !== undefined || v.fecha !== undefined, 'Envía al menos tipo, resumen o fecha'),
  async (_a, b) => {
    const cur = (await pool.query('SELECT kind FROM interactions WHERE id = $1', [b.id])).rows[0]
    if (!cur) throw new HttpError(404, 'Interacción no encontrada')
    if (cur.kind === 'etapa') throw new HttpError(409, 'Las entradas de etapa las escribe el sistema y no se editan')
    const args: unknown[] = [b.id, b.tipo ?? null, b.resumen ?? null]
    const when = b.fecha === undefined ? 'occurred_at' : occurredAt(b.fecha, args.push(b.fecha))
    await pool.query(`UPDATE interactions SET kind = COALESCE($2, kind), summary = COALESCE($3, summary), occurred_at = ${when} WHERE id = $1`, args)
    return una(b.id)
  },
)
