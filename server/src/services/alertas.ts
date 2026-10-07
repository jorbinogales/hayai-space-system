// Alertas de la campana + resumen del pipeline. Las alertas se DERIVAN al consultar (no hay tabla de avisos ni tarea programada):
// pagar la cuota o reprogramar el seguimiento las quita solas. Solo se guarda quien leyo cada una (notification_reads).
// Vencida = cuota pendiente con fecha anterior a hoy (hora de Caracas). Se excluyen clientes archivados (Finanzas sigue contandolos).
import { z } from 'zod'
import { pool, tx } from '../db.ts'
import { COLD_DAYS, daysBetween, OPEN_STAGES } from '../crm.ts'
import { dayISO, op, pageShape, paged, r2, todayISO } from './common.ts'

const LECTURAS_DIAS = 90

type Alerta = {
  clave: string
  tipo: 'cuota_vencida' | 'seguimiento'
  fecha: string
  dias: number
  titulo: string
  detalle: string
  cliente_id: string
  cliente: string
  monto: number | null
  responsable: string | null
  leida: boolean
}

const dias = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`

/** Todas las alertas vigentes y si `userId` ya las leyo. Primero lo mas grave: cuotas vencidas (las mas viejas arriba), luego seguimientos. */
async function calcular(userId: string): Promise<Alerta[]> {
  const hoy = todayISO()
  const [cuotas, seguimientos, leidas] = await Promise.all([
    pool.query(
      `SELECT p.id, p.client_id, c.name AS client, p.date, p.concept, p.amount, p.series_index, p.series_total
       FROM payments p JOIN clients c ON c.id = p.client_id
       WHERE p.status = 'pendiente' AND p.date < $1::date AND NOT c.is_prospect AND c.archived_at IS NULL
       ORDER BY p.date, p.created_at, p.id`,
      [hoy],
    ),
    pool.query(
      `SELECT c.id, c.name AS client, c.next_action, c.next_action_date,
              (SELECT u.name FROM projects pr JOIN users u ON u.id = pr.owner_id
               WHERE pr.client_id = c.id AND pr.archived_at IS NULL ORDER BY pr.created_at LIMIT 1) AS owner
       FROM clients c
       WHERE c.next_action_date <= $1::date AND c.archived_at IS NULL AND c.pipeline_stage IS DISTINCT FROM 'perdido'
       ORDER BY c.next_action_date, c.created_at, c.id`,
      [hoy],
    ),
    pool.query('SELECT key FROM notification_reads WHERE user_id = $1', [userId]),
  ])
  const read = new Set<string>(leidas.rows.map((r) => r.key))
  const out: Alerta[] = []
  for (const r of cuotas.rows) {
    const clave = `cuota:${r.id}`
    const d = daysBetween(r.date, hoy)
    const concepto = r.series_index ? `${r.concept} ${r.series_index}/${r.series_total}` : r.concept
    out.push({
      clave,
      tipo: 'cuota_vencida',
      fecha: r.date,
      dias: d,
      titulo: `${r.client}: ${concepto} vencida`,
      detalle: `$${r.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} · venció hace ${dias(d)}`,
      cliente_id: r.client_id,
      cliente: r.client,
      monto: r.amount,
      responsable: null,
      leida: read.has(clave),
    })
  }
  for (const r of seguimientos.rows) {
    const clave = `seguimiento:${r.id}:${r.next_action_date}`
    const d = daysBetween(r.next_action_date, hoy)
    out.push({
      clave,
      tipo: 'seguimiento',
      fecha: r.next_action_date,
      dias: d,
      titulo: `${r.client}: ${r.next_action}`,
      detalle: d === 0 ? 'Hoy' : `Atrasado ${dias(d)}`,
      cliente_id: r.id,
      cliente: r.client,
      monto: null,
      responsable: r.owner,
      leida: read.has(clave),
    })
  }
  return out
}

export const notificacionesListar = op(
  z.strictObject({
    estado: z.enum(['todas', 'sin_leer'], 'Estado inválido (todas o sin_leer)').default('todas'),
    tipo: z.enum(['cuota_vencida', 'seguimiento'], 'Tipo inválido (cuota_vencida o seguimiento)').optional(),
    ...pageShape,
  }),
  async (actor, i) => {
    const all = await calcular(actor.id)
    const sinLeer = all.filter((a) => !a.leida).length
    const list = all.filter((a) => (!i.tipo || a.tipo === i.tipo) && (i.estado === 'todas' || !a.leida))
    return paged(list.slice((i.page - 1) * i.per_page, i.page * i.per_page), list.length, i.page, i.per_page, {
      sin_leer: sinLeer,
      total_alertas: all.length,
      hoy: todayISO(),
    })
  },
)

const CLAVE = /^(cuota:[0-9a-f-]{36}|seguimiento:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2})$/

export const notificacionesLeer = op(
  z
    .strictObject({
      claves: z.array(z.string().regex(CLAVE, 'Clave de alerta inválida')).min(1).max(200).optional(),
      todas: z.boolean().optional(),
    })
    .refine((v) => (v.claves !== undefined) !== (v.todas === true), 'Envía claves o todas:true (una de las dos)'),
  async (actor, b) => {
    // Solo se marcan alertas que existen hoy: una clave inventada no deja basura en la tabla.
    const vigentes = new Set((await calcular(actor.id)).map((a) => a.clave))
    const claves = b.todas ? [...vigentes] : [...new Set(b.claves!)].filter((k) => vigentes.has(k))
    await tx(async (c) => {
      await c.query('DELETE FROM notification_reads WHERE read_at < now() - make_interval(days => $1)', [LECTURAS_DIAS])
      if (claves.length)
        await c.query(
          `INSERT INTO notification_reads (user_id, key) SELECT $1, k FROM unnest($2::text[]) AS k ON CONFLICT (user_id, key) DO UPDATE SET read_at = now()`,
          [actor.id, claves],
        )
    })
    const sinLeer = (await calcular(actor.id)).filter((a) => !a.leida).length
    return { marcadas: claves.length, sin_leer: sinLeer }
  },
)

// ---------- pipeline ----------
export const pipelineResumen = op(z.strictObject({}), async () => {
  const hoy = todayISO()
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.pipeline_stage AS stage, c.est_value, c.probability, c.created_at, c.next_action_date,
            (SELECT max(i.occurred_at) FROM interactions i WHERE i.client_id = c.id AND i.kind <> 'etapa') AS last_contact
     FROM clients c WHERE c.pipeline_stage IS NOT NULL AND c.archived_at IS NULL ORDER BY c.created_at, c.id`,
  )
  const cents = (n: number | null) => Math.round((n ?? 0) * 100)
  const etapas = OPEN_STAGES.map((etapa) => {
    const xs = rows.filter((r) => r.stage === etapa)
    return {
      etapa,
      cantidad: xs.length,
      valor_total: xs.reduce((s, r) => s + cents(r.est_value), 0) / 100,
      // valor x probabilidad: lo que se espera cerrar. Se redondea una sola vez, al final, para no acumular error.
      valor_ponderado: r2(xs.reduce((s, r) => s + (cents(r.est_value) * (r.probability ?? 0)) / 100, 0) / 100),
      sin_valor: xs.filter((r) => r.est_value === null).length,
    }
  })
  const abiertos = rows.filter((r) => (OPEN_STAGES as readonly string[]).includes(r.stage))
  const group = (stage: string) => {
    const xs = rows.filter((r) => r.stage === stage)
    return { cantidad: xs.length, valor_total: xs.reduce((s, r) => s + cents(r.est_value), 0) / 100 }
  }
  const frios = abiertos
    .map((r) => ({ r, d: daysBetween(dayISO(r.last_contact ?? r.created_at), hoy) }))
    .filter((x) => x.d > COLD_DAYS)
    .sort((a, b) => b.d - a.d)
    .map(({ r, d }) => ({ id: r.id, nombre: r.name, etapa: r.stage, dias_sin_contacto: d, valor_estimado: r.est_value }))
  return {
    hoy,
    etapas,
    abiertos: {
      cantidad: abiertos.length,
      valor_total: etapas.reduce((s, e) => s + e.valor_total * 100, 0) / 100,
      valor_ponderado: r2(etapas.reduce((s, e) => s + e.valor_ponderado, 0)),
    },
    ganados: group('ganado'),
    perdidos: group('perdido'),
    frios,
    seguimientos_vencidos: abiertos.filter((r) => r.next_action_date !== null && r.next_action_date < hoy).length,
    dias_frio: COLD_DAYS,
  }
})
