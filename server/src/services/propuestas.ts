// Propuestas comerciales de un cliente potencial (mensualidad base + extras) y el catalogo de ofertas de HAYAI.
// El negocio vende por mensualidad: una propuesta tiene UNA mensualidad base, extras mensuales (p. ej. un lector de codigo de
// barras en renta) y extras unicos (p. ej. una impresora). Los totales se calculan al leer, nunca se guardan.
// La negociacion se registra como VERSIONES: crear una propuesta nueva deja la viva anterior como 'reemplazada'.
import { z } from 'zod'
import { assertFresh, stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { proposalTotals, syncEstValue } from '../crm.ts'
import { vincular } from '../feedLinks.ts'
import { HttpError, id, text } from '../util.ts'
import { op, r2 } from './common.ts'

const KINDS = ['mensualidad', 'extra_mensual', 'extra_unico'] as const
const OFFER_KINDS = ['sistema', 'automatizacion', 'hardware', 'servicio'] as const
const MAX_ITEMS = 30

// ---------- ofertas ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ofertaOut = (r: any) => ({
  id: r.id as string,
  clave: r.key as string,
  nombre: r.name as string,
  tipo: r.kind as string,
  mensualidad_sugerida: r.default_monthly as number | null,
  instalacion_sugerida: r.default_setup as number | null,
  descripcion: r.description as string | null,
  activa: r.active as boolean,
})
const OFERTA_SELECT = 'SELECT id, key, name, kind, default_monthly, default_setup, description, active FROM offerings'

const precio = z
  .number('Precio inválido')
  .min(0, 'El precio no puede ser negativo')
  .max(1_000_000_000, 'El precio máximo es 1.000.000.000')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Máximo 2 decimales')

export const ofertasListar = op(z.strictObject({ incluir_inactivas: z.boolean().default(false) }), async (_a, i) => {
  const { rows } = await pool.query(`${OFERTA_SELECT} ${i.incluir_inactivas ? '' : 'WHERE active'} ORDER BY active DESC, name, id`)
  return { data: rows.map(ofertaOut) }
})

const ofertaVer = async (offerId: string) => {
  const r = (await pool.query(`${OFERTA_SELECT} WHERE id = $1`, [offerId])).rows[0]
  if (!r) throw new HttpError(404, 'Oferta no encontrada')
  return ofertaOut(r)
}

const ofertaShape = {
  nombre: text(80),
  tipo: z.enum(OFFER_KINDS, `Tipo inválido (${OFFER_KINDS.join(', ')})`),
  mensualidad_sugerida: precio.nullable(),
  instalacion_sugerida: precio.nullable(),
  descripcion: text(500).nullable(),
}

export const ofertaCrear = op(
  z.strictObject({
    clave: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'clave: 2 a 40 caracteres en minúscula, números o _'),
    ...ofertaShape,
    mensualidad_sugerida: ofertaShape.mensualidad_sugerida.optional(),
    instalacion_sugerida: ofertaShape.instalacion_sugerida.optional(),
    descripcion: ofertaShape.descripcion.optional(),
  }),
  async (_a, b) => {
    try {
      const { rows } = await pool.query(
        `INSERT INTO offerings (key, name, kind, default_monthly, default_setup, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [b.clave, b.nombre, b.tipo, b.mensualidad_sugerida ?? null, b.instalacion_sugerida ?? null, b.descripcion ?? null],
      )
      return ofertaVer(rows[0].id)
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, `Ya existe una oferta con la clave "${b.clave}"`)
      throw e
    }
  },
)

export const ofertaActualizar = op(
  z
    .strictObject({
      id,
      nombre: ofertaShape.nombre.optional(),
      tipo: ofertaShape.tipo.optional(),
      mensualidad_sugerida: ofertaShape.mensualidad_sugerida.optional(), // null la quita
      instalacion_sugerida: ofertaShape.instalacion_sugerida.optional(),
      descripcion: ofertaShape.descripcion.optional(),
      activa: z.boolean().optional(),
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  async (_a, b) => {
    const { rowCount } = await pool.query(
      `UPDATE offerings SET name = COALESCE($2, name), kind = COALESCE($3, kind),
         default_monthly = CASE WHEN $4::boolean THEN $5::numeric ELSE default_monthly END,
         default_setup = CASE WHEN $6::boolean THEN $7::numeric ELSE default_setup END,
         description = CASE WHEN $8::boolean THEN $9::text ELSE description END,
         active = COALESCE($10, active)
       WHERE id = $1`,
      [
        b.id,
        b.nombre ?? null,
        b.tipo ?? null,
        b.mensualidad_sugerida !== undefined,
        b.mensualidad_sugerida ?? null,
        b.instalacion_sugerida !== undefined,
        b.instalacion_sugerida ?? null,
        b.descripcion !== undefined,
        b.descripcion ?? null,
        b.activa ?? null,
      ],
    )
    if (!rowCount) throw new HttpError(404, 'Oferta no encontrada')
    return ofertaVer(b.id)
  },
)

/** "Eliminar" una oferta la desactiva: las propuestas que ya la usan conservan su texto y precio. */
export const ofertaDesactivar = op(z.strictObject({ id }), async (_a, b) => {
  const { rowCount } = await pool.query('UPDATE offerings SET active = false WHERE id = $1', [b.id])
  if (!rowCount) throw new HttpError(404, 'Oferta no encontrada')
  return ofertaVer(b.id)
})

// ---------- propuestas ----------
const itemShape = z.strictObject({
  tipo: z.enum(KINDS, `Tipo inválido (${KINDS.join(', ')})`),
  concepto: text(120).optional(), // con oferta_id puede omitirse: se usa el nombre de la oferta
  cantidad: z.number('Cantidad inválida (entero de 1 a 999)').int('Cantidad inválida (entero de 1 a 999)').min(1, 'Mínimo 1').max(999, 'Máximo 999').default(1),
  precio_unitario: precio.optional(), // con oferta_id puede omitirse: mensualidad_sugerida / instalacion_sugerida de la oferta
  oferta_id: id.optional(),
})
const itemsShape = z.array(itemShape).min(1, 'Una propuesta necesita al menos la mensualidad').max(MAX_ITEMS, `Máximo ${MAX_ITEMS} ítems`)

type ItemIn = z.infer<typeof itemShape>
type ItemRow = { kind: string; concept: string; qty: number; unit_price: number; offering_id: string | null; position: number }

/** Completa cada item desde su oferta (nombre y precio sugerido) y exige exactamente una mensualidad base. */
async function resolveItems(items: ItemIn[]): Promise<ItemRow[]> {
  if (items.filter((i) => i.tipo === 'mensualidad').length !== 1)
    throw new HttpError(400, 'items: debe haber exactamente un ítem de tipo "mensualidad" (la mensualidad base)')
  const ids = [...new Set(items.flatMap((i) => (i.oferta_id ? [i.oferta_id] : [])))]
  const offers = new Map<string, { name: string; monthly: number | null; setup: number | null; active: boolean }>()
  if (ids.length) {
    const { rows } = await pool.query('SELECT id, name, default_monthly, default_setup, active FROM offerings WHERE id = ANY($1::uuid[])', [ids])
    for (const r of rows) offers.set(r.id, { name: r.name, monthly: r.default_monthly, setup: r.default_setup, active: r.active })
  }
  return items.map((i, n) => {
    const o = i.oferta_id ? offers.get(i.oferta_id) : undefined
    if (i.oferta_id && !o) throw new HttpError(404, `items.${n}.oferta_id: oferta no encontrada`)
    if (o && !o.active) throw new HttpError(409, `items.${n}.oferta_id: la oferta "${o.name}" está desactivada`)
    const concept = i.concepto ?? o?.name
    if (!concept) throw new HttpError(400, `items.${n}.concepto: es obligatorio (o indica oferta_id)`)
    const price = i.precio_unitario ?? (i.tipo === 'extra_unico' ? o?.setup : o?.monthly) ?? undefined
    if (price === undefined) throw new HttpError(400, `items.${n}.precio_unitario: es obligatorio (la oferta no trae precio sugerido)`)
    return { kind: i.tipo, concept, qty: i.cantidad, unit_price: price, offering_id: i.oferta_id ?? null, position: n + 1 }
  })
}

async function insertItems(c: { query: typeof pool.query }, proposalId: string, items: ItemRow[]) {
  await c.query(
    `INSERT INTO proposal_items (proposal_id, kind, concept, qty, unit_price, offering_id, position)
     SELECT $1, t.k, t.c, t.q, t.p, t.o, t.n
     FROM unnest($2::text[], $3::text[], $4::smallint[], $5::numeric[], $6::uuid[], $7::smallint[]) AS t(k, c, q, p, o, n)`,
    [proposalId, items.map((i) => i.kind), items.map((i) => i.concept), items.map((i) => i.qty), items.map((i) => i.unit_price), items.map((i) => i.offering_id), items.map((i) => i.position)],
  )
}

const PROPUESTA_SELECT = `SELECT p.id, p.client_id, p.version, p.status, p.notes, p.presented_at, p.created_at, p.updated_at, u.name AS author
  FROM proposals p JOIN users u ON u.id = p.created_by`

/** Propuestas con sus items (2 consultas, sin N+1). */
export async function propuestasPor(where: string, args: unknown[]) {
  const { rows } = await pool.query(`${PROPUESTA_SELECT} ${where} ORDER BY p.version DESC, p.id`, args)
  if (!rows.length) return []
  const items = (
    await pool.query(
      `SELECT i.id, i.proposal_id, i.kind, i.concept, i.qty, i.unit_price, i.offering_id, o.name AS offering
       FROM proposal_items i LEFT JOIN offerings o ON o.id = i.offering_id
       WHERE i.proposal_id = ANY($1::uuid[]) ORDER BY i.position, i.id`,
      [rows.map((r) => r.id)],
    )
  ).rows
  return rows.map((r) => {
    const its = items.filter((i) => i.proposal_id === r.id)
    const t = proposalTotals(its.map((i) => ({ kind: i.kind, qty: i.qty, unit_price: i.unit_price })))
    return {
      id: r.id as string,
      cliente_id: r.client_id as string,
      version: r.version as number,
      estado: r.status as string,
      // Viva o aceptada: la que cuenta para la mensualidad del cliente. Reemplazadas y rechazadas son historia.
      vigente: ['borrador', 'presentada', 'aceptada'].includes(r.status),
      notas: r.notes as string | null,
      presentada_el: r.presented_at ? (r.presented_at as Date).toISOString() : null,
      creada_por: r.author as string,
      creada_el: (r.created_at as Date).toISOString(),
      actualizado_el: stamp(r.updated_at),
      items: its.map((i) => ({
        id: i.id as string,
        tipo: i.kind as string,
        concepto: i.concept as string,
        cantidad: i.qty as number,
        precio_unitario: i.unit_price as number,
        subtotal: r2((Math.round(i.unit_price * 100) * i.qty) / 100),
        oferta_id: i.offering_id as string | null,
        oferta: i.offering as string | null,
      })),
      totales: { mensual: t.mensual / 100, unico: t.unico / 100 },
    }
  })
}

async function una(proposalId: string) {
  const p = (await propuestasPor('WHERE p.id = $1', [proposalId]))[0]
  if (!p) throw new HttpError(404, 'Propuesta no encontrada')
  return p
}

export const propuestasListar = op(z.strictObject({ cliente_id: id }), async (_a, i) => {
  if (!(await pool.query('SELECT 1 FROM clients WHERE id = $1', [i.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
  return { data: await propuestasPor('WHERE p.client_id = $1', [i.cliente_id]) }
})

export const propuestaVer = op(z.strictObject({ id }), (_a, i) => una(i.id))

export const propuestaCrear = op(
  z.strictObject({ cliente_id: id, items: itemsShape, notas: text(4000).optional(), feed_item_id: id.optional() }),
  async (actor, b) => {
    const items = await resolveItems(b.items)
    const proposalId = await tx(async (c) => {
      const client = (await c.query('SELECT is_prospect FROM clients WHERE id = $1 FOR UPDATE', [b.cliente_id])).rows[0]
      if (!client) throw new HttpError(404, 'Cliente no encontrado')
      // Un cliente activo también puede tener propuesta (una ampliación o upsell): ahí no toca su valor estimado de pipeline.
      // Una version nueva reemplaza a la viva anterior (la negociacion queda como historia).
      await c.query(`UPDATE proposals SET status = 'reemplazada' WHERE client_id = $1 AND status IN ('borrador', 'presentada')`, [b.cliente_id])
      const version = (await c.query('SELECT COALESCE(max(version), 0) + 1 AS v FROM proposals WHERE client_id = $1', [b.cliente_id])).rows[0].v
      const { rows } = await c.query(
        `INSERT INTO proposals (client_id, version, status, notes, created_by) VALUES ($1, $2, 'borrador', $3, $4) RETURNING id`,
        [b.cliente_id, version, b.notas ?? null, actor.id],
      )
      await insertItems(c, rows[0].id, items)
      if (client.is_prospect) await syncEstValue(c, b.cliente_id)
      // Armada desde un ítem del feed: queda enlazada (el botón pasa a «✓ Creada» y no se duplica).
      if (b.feed_item_id) await vincular(c, b.feed_item_id, 'propuesta', rows[0].id, actor.id)
      return rows[0].id as string
    })
    return una(proposalId)
  },
)

export const propuestaActualizar = op(
  z
    .strictObject({ id, items: itemsShape.optional(), notas: text(4000).nullable().optional() })
    .refine((v) => v.items !== undefined || v.notas !== undefined, 'Envía items o notas'),
  async (_a, b) => {
    const items = b.items ? await resolveItems(b.items) : null
    await tx(async (c) => {
      await assertFresh(c, 'proposals', b.id)
      const cur = (await c.query('SELECT client_id, status FROM proposals WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
      if (!cur) throw new HttpError(404, 'Propuesta no encontrada')
      if (!['borrador', 'presentada'].includes(cur.status))
        throw new HttpError(409, `Una propuesta ${cur.status} ya no se edita: crea una versión nueva`)
      if (b.notas !== undefined) await c.query('UPDATE proposals SET notes = $2 WHERE id = $1', [b.id, b.notas])
      if (items) {
        await c.query('DELETE FROM proposal_items WHERE proposal_id = $1', [b.id])
        await insertItems(c, b.id, items)
        await c.query('UPDATE proposals SET updated_at = now() WHERE id = $1', [b.id])
      }
      if ((await c.query('SELECT is_prospect FROM clients WHERE id = $1', [cur.client_id])).rows[0]?.is_prospect) await syncEstValue(c, cur.client_id)
    })
    return una(b.id)
  },
)
