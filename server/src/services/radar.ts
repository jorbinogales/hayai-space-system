// Radar de competidores (Feed, v1.8.2): fichas comerciales de a quién le compite HAYAI. Mismos servicios para la web (/api/competidores)
// y para la API v1 (/api/v1/competidores). No confundir con services/marketing.ts (mk_competidores: dominio, keywords y anuncios para SEO).
import { z } from 'zod'
import { pool } from '../db.ts'
import { stamp } from '../concurrency.ts'
import { HttpError, id, text } from '../util.ts'
import { filters, op } from './common.ts'

export const GRUPOS = ['saas_venezolano', 'gratis_offline', 'software_factory', 'restaurant_tech'] as const
export const GRUPO_ETIQUETA: Record<(typeof GRUPOS)[number], string> = {
  saas_venezolano: 'SaaS venezolano',
  gratis_offline: 'Gratis y offline',
  software_factory: 'Software factory',
  restaurant_tech: 'Tecnología para restaurantes',
}
const grupo = z.enum(GRUPOS, `Grupo inválido (${GRUPOS.join(', ')})`)

/** Lo que HAYAI puede hacer contra ellos: bloque fijo que se muestra arriba de las fichas (la lista de competidores sí es viva; esto no). */
export const OPORTUNIDADES = [
  {
    titulo: 'Te lo instalo yo',
    texto: 'Ningún SaaS pisa el local ni capacita al personal; HAYAI sí. Gancho principal del mensaje: «hoy mismo queda funcionando en tu negocio».',
  },
  {
    titulo: 'Verticales que el SaaS genérico no cubre',
    texto: 'Comandas con panel de cocina, producción y recetas para fábricas artesanales, inventario por talla y color. HAYAI ya tiene esos casos reales: es su foso.',
  },
  {
    titulo: 'Encuadre de precio',
    texto: '$250 de pago único equivalen a unos 2 años de Clarito ($10/mes), pero a medida, instalado y con soporte local, no rentado.',
  },
] as const

const COLS = 'id, nombre, web, grupo, que_vende, precio, mensaje, a_quien, fortaleza, debilidad, notas, created_at, updated_at'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id as string,
  nombre: r.nombre as string,
  web: r.web as string | null,
  grupo: r.grupo as (typeof GRUPOS)[number],
  grupo_etiqueta: GRUPO_ETIQUETA[r.grupo as (typeof GRUPOS)[number]],
  que_vende: r.que_vende as string | null,
  precio: r.precio as string | null,
  mensaje: r.mensaje as string | null,
  a_quien: r.a_quien as string | null,
  fortaleza: r.fortaleza as string | null,
  debilidad: r.debilidad as string | null,
  notas: r.notas as string | null,
  creado_el: stamp(r.created_at),
  actualizado_el: stamp(r.updated_at),
})

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
// Los textos de la ficha: opcionales, y un texto vacío se guarda como «sin dato» (null).
const opc = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo ${max} caracteres`)
    .transform((v) => (v === '' ? null : v))
const campos = {
  web: opc(300),
  que_vende: opc(400),
  precio: opc(300),
  mensaje: opc(400),
  a_quien: opc(300),
  fortaleza: opc(400),
  debilidad: opc(400),
  notas: opc(4000),
}

async function ficha(competidorId: string) {
  const r = (await pool.query(`SELECT ${COLS} FROM competidores WHERE id = $1`, [competidorId])).rows[0]
  if (!r) throw new HttpError(404, 'Competidor no encontrado')
  return out(r)
}
const repetido = (e: unknown) => {
  if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Ya hay un competidor con ese nombre')
  throw e
}

export const radarListar = op(
  z.strictObject({
    q: z.string().trim().max(120).optional(), // busca por nombre
    grupo: grupo.optional(),
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(100).default(100),
  }),
  async (_a, i) => {
    const f = filters()
    if (i.q) f.add("nombre_norm LIKE '%' || ? || '%'", norm(i.q).replace(/[\\%_]/g, '\\$&'))
    if (i.grupo) f.add('grupo = ?', i.grupo)
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, rows, porGrupo] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM competidores ${f.where()}`, f.params()),
      pool.query(`SELECT ${COLS} FROM competidores ${f.where()} ORDER BY orden, created_at, id ${clause}`, args),
      pool.query('SELECT grupo, count(*)::int AS n FROM competidores GROUP BY grupo'),
    ])
    const grupos = Object.fromEntries(GRUPOS.map((g) => [g, 0])) as Record<string, number>
    for (const r of porGrupo.rows) grupos[r.grupo] = r.n
    return {
      data: rows.rows.map(out),
      meta: { page: i.page, per_page: i.per_page, total: total.rows[0].n, por_grupo: grupos },
      grupos: GRUPOS.map((g) => ({ grupo: g, etiqueta: GRUPO_ETIQUETA[g], total: grupos[g] })),
      oportunidades: OPORTUNIDADES,
    }
  },
)

export const radarCrear = op(
  z.strictObject({ nombre: text(120), grupo, web: campos.web.optional(), que_vende: campos.que_vende.optional(), precio: campos.precio.optional(), mensaje: campos.mensaje.optional(), a_quien: campos.a_quien.optional(), fortaleza: campos.fortaleza.optional(), debilidad: campos.debilidad.optional(), notas: campos.notas.optional() }),
  async (actor, b) => {
    const r = await pool
      .query(
        `INSERT INTO competidores (nombre, nombre_norm, web, grupo, que_vende, precio, mensaje, a_quien, fortaleza, debilidad, notas, orden, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (SELECT COALESCE(max(orden), 0) + 1 FROM competidores), $12) RETURNING id`,
        [b.nombre, norm(b.nombre), b.web ?? null, b.grupo, b.que_vende ?? null, b.precio ?? null, b.mensaje ?? null, b.a_quien ?? null, b.fortaleza ?? null, b.debilidad ?? null, b.notas ?? null, actor.id],
      )
      .catch(repetido)
    return ficha(r.rows[0].id)
  },
)

const EDITABLES = ['web', 'que_vende', 'precio', 'mensaje', 'a_quien', 'fortaleza', 'debilidad', 'notas'] as const
export const radarActualizar = op(
  z
    .strictObject({ id, nombre: text(120).optional(), grupo: grupo.optional(), web: campos.web.nullable().optional(), que_vende: campos.que_vende.nullable().optional(), precio: campos.precio.nullable().optional(), mensaje: campos.mensaje.nullable().optional(), a_quien: campos.a_quien.nullable().optional(), fortaleza: campos.fortaleza.nullable().optional(), debilidad: campos.debilidad.nullable().optional(), notas: campos.notas.nullable().optional() })
    .refine((v) => v.nombre !== undefined || v.grupo !== undefined || EDITABLES.some((k) => v[k] !== undefined), 'Envía al menos un campo para cambiar'),
  async (_a, b) => {
    // Un campo ausente no cambia; uno en null (o vacío) se borra.
    const set: string[] = []
    const args: unknown[] = [b.id]
    const poner = (col: string, v: unknown) => {
      args.push(v)
      set.push(`${col} = $${args.length}`)
    }
    if (b.nombre !== undefined) {
      poner('nombre', b.nombre)
      poner('nombre_norm', norm(b.nombre))
    }
    if (b.grupo !== undefined) poner('grupo', b.grupo)
    for (const k of EDITABLES) if (b[k] !== undefined) poner(k, b[k])
    const r = await pool.query(`UPDATE competidores SET ${set.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, args).catch(repetido)
    if (!r.rowCount) throw new HttpError(404, 'Competidor no encontrado')
    return ficha(b.id)
  },
)

export const radarEliminar = op(z.strictObject({ id }), async (_a, b) => {
  const r = await pool.query('DELETE FROM competidores WHERE id = $1 RETURNING nombre', [b.id])
  if (!r.rowCount) throw new HttpError(404, 'Competidor no encontrado')
  return { eliminado: true, id: b.id, nombre: r.rows[0].nombre as string }
})
