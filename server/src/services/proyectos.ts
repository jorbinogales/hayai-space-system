import { z } from 'zod'
import { assertFresh, stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { archivadosParam, filters, op, pageShape, paged, PROJECT_STATES, projectIcon, projectStateIn, projectStateOut } from './common.ts'

// Un proyecto puede no tener cliente (trabajo interno de HAYAI): de ahi el LEFT JOIN. Hitos = roadmap; checklist = accionables
// simples del proyecto (sin fecha ni responsable). Las tareas pueden colgar de un hito.
const SELECT = `SELECT p.id, p.name, p.description, p.icon, p.updated_at, u.name AS owner, c.name AS client, p.client_id, p.status, p.due_date,
    (p.archived_at IS NOT NULL) AS archived, COALESCE(c.archived_at IS NOT NULL, false) AS client_archived,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS t_total,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.done) AS t_done,
    (SELECT count(*)::int FROM project_milestones m WHERE m.project_id = p.id) AS m_total,
    (SELECT count(*)::int FROM project_milestones m WHERE m.project_id = p.id AND m.status = 'hecho') AS m_done,
    (SELECT count(*)::int FROM project_checklist k WHERE k.project_id = p.id) AS k_total,
    (SELECT count(*)::int FROM project_checklist k WHERE k.project_id = p.id AND k.done) AS k_done
  FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN clients c ON c.id = p.client_id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id,
  nombre: r.name,
  descripcion: r.description as string | null,
  icono: r.icon,
  cliente: r.client as string | null,
  cliente_id: r.client_id as string | null,
  es_interno: r.client_id === null, // proyecto de HAYAI (sin cliente): vive en el hub central
  responsable: r.owner,
  estado: projectStateOut(r.status),
  entrega: r.due_date as string | null,
  archivado: r.archived as boolean,
  actualizado_el: stamp(r.updated_at), // mándalo como If-Match / actualizado_el al editar: si cambió, 409 en vez de pisar
  cliente_archivado: r.client_archived as boolean,
  tareas: { total: r.t_total as number, completadas: r.t_done as number },
  hitos: { total: r.m_total as number, hechos: r.m_done as number },
  checklist: { total: r.k_total as number, hechas: r.k_done as number },
})

const estado = z.enum(PROJECT_STATES, `Estado inválido (${PROJECT_STATES.join(', ')})`)
const HITO_ESTADOS = ['pendiente', 'en_curso', 'hecho'] as const
const hitoEstado = z.enum(HITO_ESTADOS, `Estado de hito inválido (${HITO_ESTADOS.join(', ')})`)
const MAX_HITOS = 50
const MAX_CHECKLIST = 100

async function ownerId(name: string): Promise<string> {
  const o = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1) AND active', [name])).rows[0]
  if (!o) throw new HttpError(404, 'Responsable no encontrado')
  return o.id
}

async function proyecto(projectId: string) {
  const r = (await pool.query(`${SELECT} WHERE p.id = $1`, [projectId])).rows[0]
  if (!r) throw new HttpError(404, 'Proyecto no encontrado')
  return out(r)
}

export const proyectosListar = op(
  z.strictObject({
    estado: estado.optional(),
    cliente_id: id.optional(),
    sin_cliente: z.union([z.boolean(), z.enum(['true', 'false'])], 'sin_cliente inválido (true o false)').optional(), // true: solo los internos
    interno: z.union([z.boolean(), z.enum(['true', 'false'])], 'interno inválido (true o false)').optional(), // igual que sin_cliente (el nombre del hub)
    archivados: archivadosParam,
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('p.status = ?', projectStateIn(i.estado))
    if (i.cliente_id) f.add('p.client_id = ?', i.cliente_id)
    const interno = i.sin_cliente ?? i.interno
    if (interno !== undefined) f.raw(interno === true || interno === 'true' ? 'p.client_id IS NULL' : 'p.client_id IS NOT NULL')
    // Un proyecto queda oculto si él o su cliente están archivados.
    if (i.archivados === 'excluir') f.raw('p.archived_at IS NULL AND c.archived_at IS NULL')
    if (i.archivados === 'solo') f.raw('(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)')
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, rows, groups] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM projects p LEFT JOIN clients c ON c.id = p.client_id ${f.where()}`, f.params()),
      pool.query(`${SELECT} ${f.where()} ORDER BY p.created_at, p.id ${clause}`, args),
      pool.query(
        'SELECT p.status, count(*)::int AS n FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.archived_at IS NULL AND c.archived_at IS NULL GROUP BY p.status',
      ),
    ])
    const por_estado: Record<string, number> = Object.fromEntries(PROJECT_STATES.map((s) => [s, 0]))
    for (const g of groups.rows) por_estado[projectStateOut(g.status)] = g.n
    return paged(rows.rows.map(out), total.rows[0].n, i.page, i.per_page, { por_estado })
  },
)

// ---------- hitos y checklist: lectura ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hitoOut = (r: any) => ({
  id: r.id as string,
  proyecto_id: r.project_id as string,
  titulo: r.title as string,
  vence: r.due_date as string | null,
  estado: r.status as string,
  posicion: r.position as number,
  tareas: { total: (r.t_total ?? 0) as number, completadas: (r.t_done ?? 0) as number },
})
const HITO_SELECT = `SELECT m.id, m.project_id, m.title, m.due_date, m.status, m.position,
    (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id) AS t_total,
    (SELECT count(*)::int FROM tasks t WHERE t.milestone_id = m.id AND t.done) AS t_done
  FROM project_milestones m`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itemOut = (r: any) => ({
  id: r.id as string,
  proyecto_id: r.project_id as string,
  texto: r.text as string,
  hecho: r.done as boolean,
  hecho_el: r.done_at ? (r.done_at as Date).toISOString() : null,
  posicion: r.position as number,
})
const ITEM_SELECT = 'SELECT id, project_id, text, done, done_at, position FROM project_checklist'

export async function hitosDe(projectId: string) {
  return (await pool.query(`${HITO_SELECT} WHERE m.project_id = $1 ORDER BY m.position, m.id`, [projectId])).rows.map(hitoOut)
}
export async function checklistDe(projectId: string) {
  return (await pool.query(`${ITEM_SELECT} WHERE project_id = $1 ORDER BY position, id`, [projectId])).rows.map(itemOut)
}

export const proyectoVer = op(z.strictObject({ id }), async (_a, i) => {
  const p = await proyecto(i.id)
  const [tareas, hitos, checklist] = await Promise.all([
    pool.query(
      `SELECT t.id, t.title, t.done, t.due_date, t.milestone_id FROM tasks t WHERE t.project_id = $1 ORDER BY t.done, t.due_date NULLS LAST, t.created_at, t.id`,
      [i.id],
    ),
    hitosDe(i.id),
    checklistDe(i.id),
  ])
  return {
    ...p,
    lista_tareas: tareas.rows.map((t) => ({
      id: t.id,
      titulo: t.title,
      estado: t.done ? 'completada' : 'pendiente',
      vence: t.due_date as string | null,
      hito_id: t.milestone_id as string | null,
    })),
    hitos,
    checklist,
  }
})

// ---------- proyectos ----------
export const proyectoCrear = op(
  z.strictObject({
    nombre: text(80),
    cliente_id: id.nullish(), // sin cliente = proyecto interno
    descripcion: text(4000).nullish(),
    icono: projectIcon.default('box'),
    responsable: text(80).optional(), // por defecto, el dueño de la llave
    estado: estado.default('visita'),
    entrega: isoDate.nullish(),
  }),
  async (actor, b) => {
    const owner = b.responsable ? await ownerId(b.responsable) : actor.id
    if (b.cliente_id && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
    const { rows } = await pool.query(
      `INSERT INTO projects (name, description, icon, client_id, owner_id, status, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [b.nombre, b.descripcion ?? null, b.icono, b.cliente_id ?? null, owner, projectStateIn(b.estado), b.entrega ?? null, actor.id],
    )
    return proyecto(rows[0].id)
  },
)

export async function actualizarProyecto(b: {
  id: string
  nombre?: string
  descripcion?: string | null
  icono?: string
  cliente_id?: string | null
  responsable?: string
  estado?: string
  entrega?: string | null
  archivado?: boolean
}) {
  const owner = b.responsable !== undefined ? await ownerId(b.responsable) : null
  if (b.cliente_id && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount)
    throw new HttpError(404, 'Cliente no encontrado')
  const rowCount = await tx(async (c) => {
    await assertFresh(c, 'projects', b.id)
    return (await c.query(
    `UPDATE projects SET name = COALESCE($2, name), icon = COALESCE($3, icon),
       client_id = CASE WHEN $10::boolean THEN $4::uuid ELSE client_id END,
       owner_id = COALESCE($5::uuid, owner_id), status = COALESCE($6, status),
       due_date = CASE WHEN $7::boolean THEN $8::date ELSE due_date END,
       archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9::boolean THEN COALESCE(archived_at, now()) ELSE NULL END,
       description = CASE WHEN $11::boolean THEN $12::text ELSE description END
     WHERE id = $1`,
    [
      b.id,
      b.nombre ?? null,
      b.icono ?? null,
      b.cliente_id ?? null,
      owner,
      b.estado ? projectStateIn(b.estado) : null,
      b.entrega !== undefined,
      b.entrega ?? null,
      b.archivado ?? null,
      b.cliente_id !== undefined, // null desvincula al cliente
      b.descripcion !== undefined,
      b.descripcion ?? null,
    ],
  )).rowCount
  })
  if (!rowCount) throw new HttpError(404, 'Proyecto no encontrado')
  return proyecto(b.id)
}

export const proyectoActualizar = op(
  z
    .strictObject({
      id,
      nombre: text(80).optional(),
      descripcion: text(4000).nullable().optional(), // null la borra
      icono: projectIcon.optional(),
      cliente_id: id.nullable().optional(), // null = proyecto interno (sin cliente)
      responsable: text(80).optional(),
      estado: estado.optional(),
      entrega: isoDate.nullable().optional(), // null borra la fecha
      archivado: z.boolean().optional(), // true = archivar (se oculta pero conserva su historial), false = desarchivar
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  (_a, b) => actualizarProyecto(b),
)

export const proyectoEstado = op(z.strictObject({ id, estado }), (_a, b) => actualizarProyecto({ id: b.id, estado: b.estado }))

// ---------- hitos (roadmap) ----------
async function lockProject(c: { query: typeof pool.query }, projectId: string) {
  if (!(await c.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId])).rowCount) throw new HttpError(404, 'Proyecto no encontrado')
}
const hito = async (milestoneId: string) => {
  const r = (await pool.query(`${HITO_SELECT} WHERE m.id = $1`, [milestoneId])).rows[0]
  if (!r) throw new HttpError(404, 'Hito no encontrado')
  return hitoOut(r)
}

export const hitoCrear = op(
  z.strictObject({ proyecto_id: id, titulo: text(120), vence: isoDate.nullish(), estado: hitoEstado.default('pendiente') }),
  async (_a, b) => {
    const milestoneId = await tx(async (c) => {
      await lockProject(c, b.proyecto_id) // serializa altas concurrentes: la posicion sale de max+1
      const cur = (await c.query('SELECT count(*)::int AS n, COALESCE(max(position), 0) AS m FROM project_milestones WHERE project_id = $1', [b.proyecto_id])).rows[0]
      if (cur.n >= MAX_HITOS) throw new HttpError(409, `Un proyecto admite máximo ${MAX_HITOS} hitos`)
      const { rows } = await c.query(
        'INSERT INTO project_milestones (project_id, title, due_date, status, position) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [b.proyecto_id, b.titulo, b.vence ?? null, b.estado, cur.m + 1],
      )
      return rows[0].id as string
    })
    return hito(milestoneId)
  },
)

export const hitoActualizar = op(
  z
    .strictObject({ id, titulo: text(120).optional(), vence: isoDate.nullable().optional(), estado: hitoEstado.optional() })
    .refine((v) => v.titulo !== undefined || v.vence !== undefined || v.estado !== undefined, 'Envía titulo, vence o estado'),
  async (_a, b) => {
    const { rowCount } = await pool.query(
      `UPDATE project_milestones SET title = COALESCE($2, title), status = COALESCE($3, status),
         due_date = CASE WHEN $4::boolean THEN $5::date ELSE due_date END WHERE id = $1`,
      [b.id, b.titulo ?? null, b.estado ?? null, b.vence !== undefined, b.vence ?? null],
    )
    if (!rowCount) throw new HttpError(404, 'Hito no encontrado')
    return hito(b.id)
  },
)

/** Reordena: `ids` debe traer TODOS los hitos del proyecto, en el orden nuevo (nada se pierde en silencio). */
async function reordenar(table: 'project_milestones' | 'project_checklist', projectId: string, ids: string[], what: string) {
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'ids: hay elementos repetidos')
  await tx(async (c) => {
    await lockProject(c, projectId)
    const have = (await c.query(`SELECT id FROM ${table} WHERE project_id = $1`, [projectId])).rows.map((r) => r.id as string)
    if (have.length !== ids.length || !ids.every((x) => have.includes(x)))
      throw new HttpError(400, `ids: debe incluir exactamente todos los ${what} del proyecto (${have.length})`)
    await c.query(
      `UPDATE ${table} t SET position = o.n FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n) WHERE t.id = o.id AND t.project_id = $2`,
      [ids, projectId],
    )
  })
}

export const hitosOrdenar = op(z.strictObject({ proyecto_id: id, ids: z.array(id).max(MAX_HITOS) }), async (_a, b) => {
  await reordenar('project_milestones', b.proyecto_id, b.ids, 'hitos')
  return { data: await hitosDe(b.proyecto_id) }
})

// ---------- checklist de accionables ----------
const item = async (itemId: string) => {
  const r = (await pool.query(`${ITEM_SELECT} WHERE id = $1`, [itemId])).rows[0]
  if (!r) throw new HttpError(404, 'Elemento no encontrado')
  return itemOut(r)
}

export const checklistAgregar = op(z.strictObject({ proyecto_id: id, texto: text(200) }), async (_a, b) => {
  const itemId = await tx(async (c) => {
    await lockProject(c, b.proyecto_id)
    const cur = (await c.query('SELECT count(*)::int AS n, COALESCE(max(position), 0) AS m FROM project_checklist WHERE project_id = $1', [b.proyecto_id])).rows[0]
    if (cur.n >= MAX_CHECKLIST) throw new HttpError(409, `La checklist admite máximo ${MAX_CHECKLIST} elementos`)
    const { rows } = await c.query('INSERT INTO project_checklist (project_id, text, position) VALUES ($1, $2, $3) RETURNING id', [b.proyecto_id, b.texto, cur.m + 1])
    return rows[0].id as string
  })
  return item(itemId)
})

export const checklistActualizar = op(
  z
    .strictObject({ id, texto: text(200).optional(), hecho: z.boolean('hecho debe ser verdadero o falso').optional() })
    .refine((v) => v.texto !== undefined || v.hecho !== undefined, 'Envía texto o hecho'),
  async (_a, b) => {
    const { rowCount } = await pool.query(
      `UPDATE project_checklist SET text = COALESCE($2, text), done = COALESCE($3::boolean, done),
         done_at = CASE WHEN $3::boolean IS NULL THEN done_at WHEN $3::boolean THEN COALESCE(done_at, now()) ELSE NULL END WHERE id = $1`,
      [b.id, b.texto ?? null, b.hecho ?? null],
    )
    if (!rowCount) throw new HttpError(404, 'Elemento no encontrado')
    return item(b.id)
  },
)

export const checklistOrdenar = op(z.strictObject({ proyecto_id: id, ids: z.array(id).max(MAX_CHECKLIST) }), async (_a, b) => {
  await reordenar('project_checklist', b.proyecto_id, b.ids, 'elementos de la checklist')
  return { data: await checklistDe(b.proyecto_id) }
})
