// Hub central (planeta HAYAI): pulso interno, equipo (astronautas), acuerdos de la reunión semanal, sistemas y bitácora interna.
// "Interno" = lo que no se imputa a ningún cliente: proyectos sin cliente, sus tareas y los gastos generales. Más el embudo
// del planeta Marketing, que sale de los mismos datos del pipeline. Un servicio para la web, la API v1 y el MCP.
import { z } from 'zod'
import { ACTIVITY_SELECT, activityOut, INTERNAL_ACTIVITY_SQL, recordActivity } from '../activity.ts'
import { assertFresh, stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { userByName } from '../socios.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { op, pageShape, paged, r2, TZ, todayISO } from './common.ts'
import { sistemasListar } from './sistemas.ts'

// ---------- equipo (astronautas) ----------
const WORKLOAD = `SELECT u.id, u.name, u.avatar, u.role_title, u.responsibilities,
    count(t.id) FILTER (WHERE NOT t.done)::int AS abiertas,
    count(t.id) FILTER (WHERE NOT t.done AND t.due_date < $1::date)::int AS vencidas,
    count(t.id) FILTER (WHERE t.done AND t.done_at > now() - interval '7 days')::int AS completadas_7d,
    count(t.id) FILTER (WHERE NOT t.done AND p.client_id IS NULL)::int AS internas_abiertas
  FROM users u
  LEFT JOIN (tasks t JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL) ON COALESCE(t.assignee_id, p.owner_id) = u.id
  WHERE u.active GROUP BY u.id ORDER BY u.name`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const astronauta = (r: any) => ({
  id: r.id as string,
  nombre: r.name as string,
  avatar: r.avatar as string,
  rol: (r.role_title ?? null) as string | null,
  responsabilidades: (r.responsibilities ?? null) as string | null,
  // Tareas que lleva: las asignadas y, sin asignar, las de los proyectos donde es responsable (proyectos archivados no cuentan).
  carga: { abiertas: r.abiertas as number, vencidas: r.vencidas as number, completadas_7d: r.completadas_7d as number, internas_abiertas: r.internas_abiertas as number },
})

async function equipo() {
  return (await pool.query(WORKLOAD, [todayISO()])).rows.map(astronauta)
}

export const equipoVer = op(z.strictObject({}), async () => ({ data: await equipo() }))

export const equipoActualizar = op(
  z
    .strictObject({ socio: text(40), rol: text(80).nullish(), responsabilidades: text(600).nullish() })
    .refine((v) => v.rol !== undefined || v.responsabilidades !== undefined, 'Envía rol o responsabilidades'),
  async (_a, b) => {
    const u = await userByName(pool, b.socio, 'socio')
    await pool.query(
      `UPDATE users SET role_title = CASE WHEN $2::boolean THEN $3 ELSE role_title END, responsibilities = CASE WHEN $4::boolean THEN $5 ELSE responsibilities END WHERE id = $1`,
      [u.id, b.rol !== undefined, b.rol ?? null, b.responsabilidades !== undefined, b.responsabilidades ?? null],
    )
    return (await equipo()).find((x) => x.id === u.id)!
  },
)

// ---------- acuerdos de la reunión semanal ----------
const ESTADOS = ['abierto', 'cumplido', 'descartado'] as const
const estado = z.enum(ESTADOS, `Estado inválido (${ESTADOS.join(', ')})`)

const A_SELECT = `SELECT a.id, a.updated_at, a.meeting_date, a.body, a.due_date, a.status, a.closed_at, a.created_at, o.id AS owner_id, o.name AS owner, u.name AS author
  FROM agreements a LEFT JOIN users o ON o.id = a.owner_id JOIN users u ON u.id = a.created_by`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const acuerdoOut = (r: any) => ({
  id: r.id as string,
  texto: r.body as string,
  fecha_reunion: r.meeting_date as string,
  responsable: r.owner_id ? { id: r.owner_id as string, nombre: r.owner as string } : null,
  vence: (r.due_date ?? null) as string | null,
  estado: r.status as (typeof ESTADOS)[number],
  cerrado_el: r.closed_at ? (r.closed_at as Date).toISOString() : null,
  registrado_por: r.author as string,
  actualizado_el: stamp(r.updated_at),
})

async function acuerdo(agreementId: string) {
  const r = (await pool.query(`${A_SELECT} WHERE a.id = $1`, [agreementId])).rows[0]
  if (!r) throw new HttpError(404, 'Acuerdo no encontrado')
  return acuerdoOut(r)
}

export const acuerdosListar = op(z.strictObject({ estado: estado.optional(), ...pageShape }), async (_a, i) => {
  const where = i.estado ? 'WHERE a.status = $1' : ''
  const base = i.estado ? [i.estado] : []
  const [total, rows, counts] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM agreements a ${where}`, base),
    pool.query(`${A_SELECT} ${where} ORDER BY (a.status = 'abierto') DESC, a.meeting_date DESC, a.created_at DESC, a.id LIMIT $${base.length + 1} OFFSET $${base.length + 2}`, [
      ...base,
      i.per_page,
      (i.page - 1) * i.per_page,
    ]),
    pool.query('SELECT status, count(*)::int AS n FROM agreements GROUP BY status'),
  ])
  const por_estado = { abierto: 0, cumplido: 0, descartado: 0 } as Record<string, number>
  for (const c of counts.rows) por_estado[c.status] = c.n
  return paged(rows.rows.map(acuerdoOut), total.rows[0].n, i.page, i.per_page, { por_estado })
})

export const acuerdoCrear = op(
  z.strictObject({ texto: text(1000), fecha_reunion: isoDate.optional(), responsable: text(40).nullish(), vence: isoDate.nullish() }),
  async (actor, b) => {
    const newId = await tx(async (c) => {
      const owner = b.responsable ? (await userByName(c, b.responsable)).id : null
      const { rows } = await c.query(
        `INSERT INTO agreements (meeting_date, body, owner_id, due_date, created_by) VALUES (COALESCE($1::date, (now() AT TIME ZONE $6)::date), $2, $3, $4, $5) RETURNING id`,
        [b.fecha_reunion ?? null, b.texto, owner, b.vence ?? null, actor.id, TZ],
      )
      await recordActivity(c, { kind: 'acuerdo_nuevo', actorId: actor.id, subject: b.texto.length > 90 ? `${b.texto.slice(0, 87)}...` : b.texto, via: actor.via })
      return rows[0].id as string
    })
    return acuerdo(newId)
  },
)

export const acuerdoActualizar = op(
  z
    .strictObject({
      id,
      texto: text(1000).optional(),
      fecha_reunion: isoDate.optional(),
      responsable: text(40).nullish(),
      vence: isoDate.nullish(),
      estado: estado.optional(), // cumplido o descartado lo cierra; abierto lo reabre
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  async (_a, b) => {
    await tx(async (c) => {
      await assertFresh(c, 'agreements', b.id)
      const owner = b.responsable ? (await userByName(c, b.responsable)).id : null
      const r = await c.query(
        `UPDATE agreements SET
           body = COALESCE($2, body),
           meeting_date = COALESCE($3::date, meeting_date),
           owner_id = CASE WHEN $4::boolean THEN $5::uuid ELSE owner_id END,
           due_date = CASE WHEN $6::boolean THEN $7::date ELSE due_date END,
           status = COALESCE($8, status),
           closed_at = CASE WHEN $8::text IS NULL THEN closed_at WHEN $8::text = 'abierto' THEN NULL ELSE COALESCE(closed_at, now()) END
         WHERE id = $1`,
        [b.id, b.texto ?? null, b.fecha_reunion ?? null, b.responsable !== undefined, owner, b.vence !== undefined, b.vence ?? null, b.estado ?? null],
      )
      if (!r.rowCount) throw new HttpError(404, 'Acuerdo no encontrado')
    })
    return acuerdo(b.id)
  },
)

// ---------- hub ----------
async function pulso() {
  const hoy = todayISO()
  const mes = hoy.slice(0, 7)
  const [g, t, p] = await Promise.all([
    // Mismo criterio que la fila "Gastos generales de HAYAI" de Finanzas: sin cliente ni proyecto de cliente.
    pool.query(
      `SELECT COALESCE(sum(e.amount), 0) AS total, count(*)::int AS n
       FROM expenses e LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.client_id IS NULL AND (p.id IS NULL OR p.client_id IS NULL) AND to_char(e.date, 'YYYY-MM') = $1`,
      [mes],
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE NOT t.done)::int AS pendientes,
              count(*) FILTER (WHERE NOT t.done AND t.due_date < $1::date)::int AS vencidas,
              count(*) FILTER (WHERE t.done AND to_char(t.done_at AT TIME ZONE $2, 'YYYY-MM') = $3)::int AS completadas_mes
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.client_id IS NULL AND p.archived_at IS NULL`,
      [hoy, TZ, mes],
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status IN ('activo', 'entrega'))::int AS activos, count(*)::int AS total
       FROM projects WHERE client_id IS NULL AND archived_at IS NULL`,
    ),
  ])
  return {
    mes,
    gastos_generales_mes: r2(g.rows[0].total),
    gastos_generales_movimientos: g.rows[0].n as number,
    tareas_internas: { pendientes: t.rows[0].pendientes as number, vencidas: t.rows[0].vencidas as number, completadas_mes: t.rows[0].completadas_mes as number },
    proyectos_internos: { activos: p.rows[0].activos as number, total: p.rows[0].total as number },
  }
}

export const hubVer = op(z.strictObject({}), async (actor) => {
  const [pulsoData, equipoData, abiertos, conteo, sistemas, bitacora] = await Promise.all([
    pulso(),
    equipo(),
    pool.query(`${A_SELECT} WHERE a.status = 'abierto' ORDER BY a.meeting_date DESC, a.created_at DESC, a.id LIMIT 12`),
    pool.query(`SELECT status, count(*)::int AS n FROM agreements GROUP BY status`),
    sistemasListar.run(actor, { activos: true, page: 1, per_page: 100 }),
    pool.query(`${ACTIVITY_SELECT} WHERE ${INTERNAL_ACTIVITY_SQL} ORDER BY a.id DESC LIMIT 15`),
  ])
  const acuerdosPor = { abierto: 0, cumplido: 0, descartado: 0 } as Record<string, number>
  for (const c of conteo.rows) acuerdosPor[c.status] = c.n
  return {
    pulso: pulsoData,
    astronautas: equipoData,
    bitacora: bitacora.rows.map((r) => activityOut(r, actor.id)),
    acuerdos: { abiertos: abiertos.rows.map(acuerdoOut), por_estado: acuerdosPor },
    sistemas: { data: sistemas.data, resumen: (sistemas.meta as unknown as { por_estado: Record<string, number> }).por_estado },
    // Las fuentes de analítica (GA4, Cloudflare, Meta Graph) se conectan después; el módulo completo vive en el planeta Marketing.
    analytics: { disponible: false, planeta: 'marketing' as const, resumen: null },
  }
})

// ---------- embudo (planeta Marketing) ----------
export const marketingEmbudo = op(
  z.strictObject({ dias: z.number('dias debe ser un entero').int('dias debe ser un entero').min(7).max(365).default(90) }),
  async (_a, i) => {
    const [stages, now, closed, origins, meta] = await Promise.all([
      pool.query('SELECT key, label, position, probability, kind FROM pipeline_stages WHERE active ORDER BY position'),
      pool.query(
        `SELECT pipeline_stage AS stage, count(*)::int AS n, COALESCE(sum(est_value), 0) AS valor, COALESCE(sum(est_value * probability / 100.0), 0) AS ponderado
         FROM clients WHERE is_prospect AND archived_at IS NULL GROUP BY pipeline_stage`,
      ),
      pool.query(
        `SELECT pipeline_stage AS stage, count(*)::int AS n FROM clients
         WHERE pipeline_stage IN ('ganado', 'perdido') AND stage_changed_at > now() - make_interval(days => $1) GROUP BY pipeline_stage`,
        [i.dias],
      ),
      // Cohorte: lo que entró en los últimos N días, por origen, y en qué terminó hasta hoy.
      pool.query(
        `SELECT COALESCE(lead_source, 'sin_origen') AS origen, count(*)::int AS entraron,
                count(*) FILTER (WHERE pipeline_stage = 'ganado')::int AS ganados,
                count(*) FILTER (WHERE pipeline_stage = 'perdido')::int AS perdidos,
                count(*) FILTER (WHERE is_prospect AND pipeline_stage NOT IN ('ganado', 'perdido'))::int AS abiertos
         FROM clients WHERE created_at > now() - make_interval(days => $1) AND archived_at IS NULL GROUP BY 1 ORDER BY 2 DESC, 1`,
        [i.dias],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE received_at > now() - interval '30 days')::int AS leads_30d,
                count(*) FILTER (WHERE received_at > now() - interval '30 days' AND status = 'procesado')::int AS procesados,
                count(*) FILTER (WHERE received_at > now() - interval '30 days' AND status = 'duplicado')::int AS duplicados,
                count(*) FILTER (WHERE status = 'error')::int AS con_error
         FROM meta_leads`,
      ),
    ])
    const byStage = new Map(now.rows.map((r) => [r.stage as string, r]))
    const count = (k: string) => (closed.rows.find((r) => r.stage === k)?.n ?? 0) as number
    const ganados = count('ganado')
    const perdidos = count('perdido')
    return {
      dias: i.dias,
      etapas: stages.rows
        .filter((s) => s.kind === 'abierta')
        .map((s) => ({
          etapa: s.key as string,
          nombre: s.label as string,
          probabilidad: s.probability as number,
          posibles: (byStage.get(s.key)?.n ?? 0) as number,
          valor_mensual: r2(byStage.get(s.key)?.valor ?? 0),
          valor_ponderado: r2(byStage.get(s.key)?.ponderado ?? 0),
        })),
      cierres: { ganados, perdidos, tasa_cierre: ganados + perdidos ? Math.round((1000 * ganados) / (ganados + perdidos)) / 10 : null },
      por_origen: origins.rows,
      meta_ads: { leads_30d: meta.rows[0].leads_30d as number, procesados: meta.rows[0].procesados as number, duplicados: meta.rows[0].duplicados as number, con_error: meta.rows[0].con_error as number },
    }
  },
)
