// Actividad del equipo: lo que hicieron los demas socios (cliente nuevo, tarea nueva, tarea completada). Un servicio para la
// web, la API v1 y el MCP. El texto nombra al dueño de la llave que lo hizo; la herramienta (web, Growi, Muse...) no aparece.
import { z } from 'zod'
import { ACTIVITY_SELECT, activityOut, ALERT_BACKED_KINDS, INTERNAL_ACTIVITY_SQL, isSystemKind, KINDS, SYSTEM_KINDS } from '../activity.ts'
import { pool } from '../db.ts'
import { tenantCtx, tid, visibleKinds } from '../tenant.ts'
import { op, pageShape, paged } from './common.ts'

// Multitenant: la actividad, el "visto hasta" y el ultimo id son del tenant en curso, y solo cuentan los tipos de los modulos del
// socio (un cobro no se le muestra a quien no tiene cobros).
const kinds = () => visibleKinds(tenantCtx().modules)

/** El "visto hasta" nace en el ultimo id del momento: nadie arranca con un monton de avisos viejos. */
async function seenOf(userId: string): Promise<number> {
  await pool.query(
    `INSERT INTO activity_seen (user_id, tenant_id, seen_id) SELECT $1, $2, coalesce(max(id), 0) FROM activity WHERE tenant_id = $2 ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    [userId, tid()],
  )
  return Number((await pool.query('SELECT seen_id FROM activity_seen WHERE user_id = $1 AND tenant_id = $2', [userId, tid()])).rows[0].seen_id)
}
const lastId = async () => Number((await pool.query('SELECT coalesce(max(id), 0)::bigint AS n FROM activity WHERE tenant_id = $1', [tid()])).rows[0].n)

/**
 * Lo posterior al "visto hasta" y hecho por OTRO socio: lo propio nunca cuenta como sin leer. La versión nueva y el feed ya tienen su
 * alerta en la campana: contarlos aquí también inflaría el número (una actualización sumaba 2).
 */
async function unread(userId: string, seen: number): Promise<number> {
  return (
    await pool.query('SELECT count(*)::int AS n FROM activity WHERE tenant_id = $5 AND id > $1 AND (actor_id <> $2 OR kind = ANY($3::text[])) AND kind <> ALL($4::text[]) AND kind = ANY($6::text[])', [
      seen,
      userId,
      SYSTEM_KINDS,
      ALERT_BACKED_KINDS,
      tid(),
      kinds(),
    ])
  ).rows[0].n
}

export const actividadListar = op(
  z.strictObject({
    tipo: z.enum(KINDS, `Tipo inválido (${KINDS.join(', ')})`).optional(),
    // Cursor: solo lo posterior a este id. Para consultar solo lo nuevo, usa orden=asc y guarda meta.ultimo_id.
    desde_id: z.number('desde_id debe ser un entero').int('desde_id debe ser un entero').min(0).optional(),
    orden: z.enum(['desc', 'asc'], 'orden inválido (desc o asc)').default('desc'),
    // interno: solo la bitácora interna de HAYAI (lo que no es de un cliente, acuerdos y sistemas); todo: sin filtro (por defecto)
    alcance: z.enum(['todo', 'interno'], 'alcance inválido (todo o interno)').default('todo'),
    ...pageShape,
  }),
  async (actor, i) => {
    const seen = await seenOf(actor.id)
    const args: unknown[] = [tid(), kinds()]
    const conds: string[] = ['a.tenant_id = $1', 'a.kind = ANY($2::text[])']
    if (i.tipo) conds.push(`a.kind = $${args.push(i.tipo)}`)
    if (i.desde_id !== undefined) conds.push(`a.id > $${args.push(i.desde_id)}`)
    if (i.alcance === 'interno') conds.push(INTERNAL_ACTIVITY_SQL)
    const where = `WHERE ${conds.join(' AND ')}`
    const [total, rows, last, sin] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM activity a ${where}`, args),
      pool.query(`${ACTIVITY_SELECT} ${where} ORDER BY a.id ${i.orden === 'asc' ? 'ASC' : 'DESC'} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [
        ...args,
        i.per_page,
        (i.page - 1) * i.per_page,
      ]),
      lastId(),
      unread(actor.id, seen),
    ])
    return paged(
      rows.rows.map((r) => ({ ...activityOut(r, actor.id), leida: Number(r.id) <= seen || (r.actor_id === actor.id && !isSystemKind(r.kind)) })),
      total.rows[0].n,
      i.page,
      i.per_page,
      { sin_leer: sin, visto_hasta: seen, ultimo_id: last },
    )
  },
)

export const actividadLeer = op(
  z
    .strictObject({
      hasta_id: z.number('hasta_id debe ser un entero').int('hasta_id debe ser un entero').min(0).optional(),
      todas: z.boolean('todas debe ser verdadero o falso').optional(),
    })
    .refine((v) => (v.hasta_id !== undefined) !== (v.todas === true), 'Envía hasta_id o todas:true (una de las dos)'),
  async (actor, b) => {
    const seen = await seenOf(actor.id)
    const max = await lastId()
    // Nunca retrocede, y no pasa del ultimo id real (un hasta_id inventado no deja el cursor "en el futuro").
    const to = Math.min(b.todas ? max : b.hasta_id!, max)
    const next = Math.max(seen, to)
    await pool.query('UPDATE activity_seen SET seen_id = $2 WHERE user_id = $1 AND tenant_id = $3', [actor.id, next, tid()])
    return { visto_hasta: next, sin_leer: await unread(actor.id, next) }
  },
)
