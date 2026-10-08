// Alertas de la campana + resumen del pipeline. Las alertas se DERIVAN al consultar (no hay tabla de avisos ni tarea programada):
// pagar la cuota o reprogramar el seguimiento las quita solas. Solo se guarda quien leyo cada una (notification_reads).
// Vencida = cuota pendiente con fecha anterior a hoy (hora de Caracas). Se excluyen clientes archivados (Finanzas sigue contandolos).
import { z } from 'zod'
import { pool, tx } from '../db.ts'
import { COLD_DAYS, daysBetween, loadStages } from '../crm.ts'
import { dayISO, op, pageShape, paged, r2, todayISO } from './common.ts'
import { feedAlertas } from './feed.ts'

const LECTURAS_DIAS = 90
/** Cuántos días sigue visible en la campana el aviso de una versión nueva (si no se lee antes). */
const ACTUALIZACION_DIAS = 14

const TIPOS = ['cuota_vencida', 'seguimiento', 'actualizacion', 'feed'] as const

type Alerta = {
  clave: string
  tipo: (typeof TIPOS)[number]
  fecha: string
  dias: number
  titulo: string
  detalle: string
  cliente_id: string | null // null en la alerta de actualización (no es de un cliente)
  cliente: string | null
  monto: number | null
  responsable: string | null
  leida: boolean
  /** Solo en 'actualizacion': la versión anunciada (el botón "Ver cambios" abre su entrada del historial). */
  version?: string
  /** Solo en 'feed': qué llegó (tipo y fuente), cuántos (varios del mismo origen y día van juntos) y, si es uno solo, su id para abrirlo en el hub. */
  feed?: { tipo: string; fuente: string; cantidad: number; item_id: string | null }
}

const dias = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`

/** Todas las alertas vigentes y si `userId` ya las leyo. Primero lo mas grave: cuotas vencidas (las mas viejas arriba), luego seguimientos. */
async function calcular(userId: string): Promise<Alerta[]> {
  const hoy = todayISO()
  const [cuotas, seguimientos, leidas, version, feed] = await Promise.all([
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
    // Aviso de actualización: la versión más alta, ya anunciada y reciente. Es para TODOS los socios (la lectura es por socio).
    pool.query(
      `SELECT v.version, v.title, v.announced_at FROM app_versions v
       WHERE v.announced_at IS NOT NULL AND v.announced_at > now() - make_interval(days => $1)
       ORDER BY (string_to_array(v.version, '.'))[1]::int DESC, (string_to_array(v.version, '.'))[2]::int DESC, (string_to_array(v.version, '.'))[3]::int DESC LIMIT 1`,
      [ACTUALIZACION_DIAS],
    ),
    feedAlertas(userId),
  ])
  const read = new Set<string>(leidas.rows.map((r) => r.key))
  const out: Alerta[] = []
  // Primero lo más reciente y que afecta a todos: la actualización disponible.
  for (const r of version.rows) {
    const clave = `version:${r.version}`
    out.push({
      clave,
      tipo: 'actualizacion',
      fecha: dayISO(r.announced_at as Date),
      dias: daysBetween(dayISO(r.announced_at as Date), hoy),
      titulo: `Nueva actualización v${r.version} disponible`,
      detalle: (r.title as string | null) ?? 'Mira qué cambió en el historial de versiones',
      cliente_id: null,
      cliente: null,
      monto: null,
      responsable: null,
      leida: read.has(clave),
      version: r.version as string,
    })
  }
  // Feed de oportunidades: alerta, noticia y prospecto nuevos sin revisar (para todos los socios; la lectura es por socio).
  for (const f of feed) {
    out.push({
      clave: f.clave,
      tipo: 'feed',
      fecha: f.fecha,
      dias: Math.max(0, daysBetween(f.fecha, hoy)),
      titulo: f.titulo,
      detalle: f.detalle,
      cliente_id: null,
      cliente: null,
      monto: null,
      responsable: null,
      leida: read.has(f.clave),
      feed: { tipo: f.tipo, fuente: f.fuente, cantidad: f.cantidad, item_id: f.item_id },
    })
  }
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
    tipo: z.enum(TIPOS, 'Tipo inválido (cuota_vencida, seguimiento, actualizacion o feed)').optional(),
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

const CLAVE = /^(cuota:[0-9a-f-]{36}|seguimiento:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}|version:\d{1,4}\.\d{1,4}\.\d{1,4}|feed:[0-9a-f-]{36}|feed:[a-z]+:[a-z0-9._-]{1,60}:\d{4}-\d{2}-\d{2}:\d{1,4})$/

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
  const stages = (await loadStages(pool)).filter((s) => s.kind === 'abierta' && s.active)
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.pipeline_stage AS stage, c.est_value, c.probability, c.created_at, c.next_action_date,
            (SELECT max(i.occurred_at) FROM interactions i WHERE i.client_id = c.id AND i.kind <> 'etapa') AS last_contact
     FROM clients c WHERE c.pipeline_stage IS NOT NULL AND c.archived_at IS NULL ORDER BY c.created_at, c.id`,
  )
  const cents = (n: number | null) => Math.round((n ?? 0) * 100)
  const etapas = stages.map((st) => {
    const xs = rows.filter((r) => r.stage === st.key)
    return {
      etapa: st.key,
      nombre: st.label,
      probabilidad: st.probability,
      cantidad: xs.length,
      valor_total: xs.reduce((s, r) => s + cents(r.est_value), 0) / 100,
      // valor x probabilidad: lo que se espera cerrar. Se redondea una sola vez, al final, para no acumular error.
      valor_ponderado: r2(xs.reduce((s, r) => s + (cents(r.est_value) * (r.probability ?? 0)) / 100, 0) / 100),
      sin_valor: xs.filter((r) => r.est_value === null).length,
    }
  })
  const openKeys = new Set(stages.map((x) => x.key))
  const abiertos = rows.filter((r) => openKeys.has(r.stage))
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

/** Las etapas del pipeline con su probabilidad (viven en la tabla pipeline_stages): para pintar y validar sin adivinar. */
export const pipelineEtapas = op(z.strictObject({}), async () => ({
  data: (await loadStages(pool)).map((s) => ({
    etapa: s.key,
    nombre: s.label,
    posicion: s.position,
    probabilidad: s.probability,
    tipo: s.kind,
    activa: s.active,
  })),
}))
