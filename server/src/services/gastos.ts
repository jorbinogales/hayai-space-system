import { z } from 'zod'
import { assertFresh, stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { HttpError, id, isoDate, money, text } from '../util.ts'
import { CATEGORIES, filters, op, pageShape, paged, r2, todayISO } from './common.ts'

const SELECT = `SELECT e.id, e.updated_at, e.date, e.concept, e.amount, e.category, e.scope, e.client_id, e.project_id,
    COALESCE(c.name, p.name) AS ref, u.name AS owner,
    (e.scope = 'general' OR (e.scope = 'proyecto' AND p.client_id IS NULL)) AS internal
  FROM expenses e
  LEFT JOIN clients c ON c.id = e.client_id
  LEFT JOIN projects p ON p.id = e.project_id
  JOIN users u ON u.id = e.created_by`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id,
  fecha: r.date as string,
  concepto: r.concept as string,
  monto: r.amount as number,
  categoria: r.category as string,
  ambito: r.scope as string,
  es_interno: r.internal as boolean, // general o de un proyecto interno: no se imputa a ningún cliente
  referencia: r.scope === 'general' ? null : { id: (r.client_id ?? r.project_id) as string, nombre: r.ref as string },
  registrado_por: r.owner as string,
  actualizado_el: stamp(r.updated_at),
})

const INTERNAL = "(e.scope = 'general' OR (e.scope = 'proyecto' AND p.client_id IS NULL))"
const categoria = z.enum(CATEGORIES, `Categoría inválida (${CATEGORIES.join(', ')})`)
const ambito = z.enum(['general', 'cliente', 'proyecto'], 'Ámbito inválido (general, cliente o proyecto)')

async function gasto(expenseId: string) {
  const r = (await pool.query(`${SELECT} WHERE e.id = $1`, [expenseId])).rows[0]
  if (!r) throw new HttpError(404, 'Gasto no encontrado')
  return out(r)
}

/** El esquema exige: general sin referencia; cliente con client_id; proyecto con project_id. Aquí el error es legible. */
async function checkRef(scope: string, refId: string | null) {
  if (scope === 'general') {
    if (refId) throw new HttpError(400, 'referencia_id: un gasto general no lleva cliente ni proyecto')
    return
  }
  if (!refId) throw new HttpError(400, `referencia_id: indica el ${scope} del gasto`)
  const table = scope === 'cliente' ? 'clients' : 'projects'
  if (!(await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [refId])).rowCount)
    throw new HttpError(404, scope === 'cliente' ? 'Cliente no encontrado' : 'Proyecto no encontrado')
}

export const gastosListar = op(
  z.strictObject({
    desde: isoDate.optional(),
    hasta: isoDate.optional(),
    categoria: categoria.optional(),
    ambito: ambito.optional(),
    interno: z.union([z.boolean(), z.enum(['true', 'false'])], 'interno inválido (true o false)').optional(), // true: solo gastos internos de HAYAI (generales o de proyectos sin cliente)
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.desde) f.add('e.date >= ?', i.desde)
    if (i.hasta) f.add('e.date <= ?', i.hasta)
    if (i.categoria) f.add('e.category = ?', i.categoria)
    if (i.ambito) f.add('e.scope = ?', i.ambito)
    if (i.interno !== undefined) f.raw(i.interno === true || i.interno === 'true' ? INTERNAL : `NOT ${INTERNAL}`)
    const { clause, args } = f.page(i.per_page, i.page)
    const [agg, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n, COALESCE(sum(e.amount), 0) AS total FROM expenses e LEFT JOIN projects p ON p.id = e.project_id ${f.where()}`, f.params()),
      pool.query(`${SELECT} ${f.where()} ORDER BY e.date DESC, e.created_at DESC, e.id ${clause}`, args),
    ])
    // total_monto = suma de TODO el filtro (no solo de esta página): p. ej. el total del mes.
    return paged(rows.rows.map(out), agg.rows[0].n, i.page, i.per_page, { total_monto: r2(agg.rows[0].total) })
  },
)

export const gastoVer = op(z.strictObject({ id }), (_a, i) => gasto(i.id))

export const gastoRegistrar = op(
  z.strictObject({
    concepto: text(120),
    monto: money,
    categoria,
    fecha: isoDate.optional(), // por defecto, hoy (hora de Caracas)
    ambito: ambito.default('general'),
    referencia_id: id.nullish(),
  }),
  async (actor, b) => {
    await checkRef(b.ambito, b.referencia_id ?? null)
    const { rows } = await pool.query(
      `INSERT INTO expenses (date, concept, amount, category, scope, client_id, project_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        b.fecha ?? todayISO(),
        b.concepto,
        b.monto,
        b.categoria,
        b.ambito,
        b.ambito === 'cliente' ? b.referencia_id : null,
        b.ambito === 'proyecto' ? b.referencia_id : null,
        actor.id,
      ],
    )
    return gasto(rows[0].id)
  },
)

export const gastoActualizar = op(
  z
    .strictObject({
      id,
      concepto: text(120).optional(),
      monto: money.optional(),
      categoria: categoria.optional(),
      fecha: isoDate.optional(),
      ambito: ambito.optional(),
      referencia_id: id.nullable().optional(),
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  async (_a, b) => {
    const cur = (await pool.query('SELECT scope, client_id, project_id FROM expenses WHERE id = $1', [b.id])).rows[0]
    if (!cur) throw new HttpError(404, 'Gasto no encontrado')

    // Ámbito y referencia finales: si cambia el ámbito sin dar referencia, la anterior ya no sirve.
    const scope: string = b.ambito ?? cur.scope
    const ref: string | null =
      b.referencia_id !== undefined ? b.referencia_id : b.ambito !== undefined && b.ambito !== cur.scope ? null : (cur.client_id ?? cur.project_id)
    await checkRef(scope, ref)

    await tx(async (c) => {
      await assertFresh(c, 'expenses', b.id)
      await c.query(
        `UPDATE expenses SET date = COALESCE($2, date), concept = COALESCE($3, concept), amount = COALESCE($4, amount),
           category = COALESCE($5, category), scope = $6, client_id = $7, project_id = $8
         WHERE id = $1`,
        [b.id, b.fecha ?? null, b.concepto ?? null, b.monto ?? null, b.categoria ?? null, scope, scope === 'cliente' ? ref : null, scope === 'proyecto' ? ref : null],
      )
    })
    return gasto(b.id)
  },
)
