// Registro de actividad del equipo (cliente nuevo, tarea nueva, tarea completada, cobros y cambios de etapa). Hoja del grafo de imports a proposito
// (solo tipos de pg): lo usan routes/ y services/, y estos ya se importan entre si.
// Se llama DENTRO de la transaccion del cambio: el INSERT y el pg_notify se confirman (o se deshacen) con el. Asi no hay
// avisos de algo que no paso, ni algo que pasa sin aviso.
import type { Pool, PoolClient } from 'pg'

export const KINDS = ['cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido', 'lead_meta', 'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva', 'feed_nuevo'] as const
export type ActivityKind = (typeof KINDS)[number]

/** Avisos que trae el sistema (no un socio): le llegan a TODOS, también a quien figura como actor. */
export const SYSTEM_KINDS: readonly ActivityKind[] = ['lead_meta', 'sistema_caido', 'sistema_recuperado', 'version_nueva', 'feed_nuevo']
/** Eventos que YA tienen su propia alerta en la campana (leída por socio): no cuentan otra vez como «sin leer» del equipo ni se repiten en su pestaña. */
export const ALERT_BACKED_KINDS: readonly ActivityKind[] = ['version_nueva', 'feed_nuevo']
export const isSystemKind = (k: string) => (SYSTEM_KINDS as readonly string[]).includes(k)
/** Condicion SQL de la bitácora interna de HAYAI (hub): lo que no es de un cliente, más acuerdos y sistemas. */
// El feed de oportunidades (lo que encontraron las máquinas) NO es bitácora: tiene su propia vista en el hub.
export const INTERNAL_ACTIVITY_SQL = "((a.client_id IS NULL AND a.kind NOT IN ('lead_meta', 'feed_nuevo')) OR a.kind IN ('acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva'))"

export const CHANNEL = 'activity'
/** Canal del chat interno: el payload es JSON { op: 'nuevo' | 'editado' | 'borrado', id }. Se avisa DENTRO de la transaccion del cambio. */
export const CHAT_CHANNEL = 'chat'
export const notifyChat = (db: Pool | PoolClient, op: 'nuevo' | 'editado' | 'borrado', id: string) =>
  db.query('SELECT pg_notify($1, $2)', [CHAT_CHANNEL, JSON.stringify({ op, id })])
/** Canal de las vistas de proyecto: lo dispara un trigger (migracion 026) al confirmarse un cambio en el proyecto, sus hitos, su checklist o sus tareas. */
export const PROYECTO_CHANNEL = 'proyecto'
const RETENTION_DAYS = 60

export type ActivityInput = {
  kind: ActivityKind
  actorId: string
  /** Nombre del cliente o titulo de la tarea. */
  subject: string
  /** Tareas: nombre del proyecto. Cobros: el monto. Etapas: 'De → A' con los nombres de las etapas. */
  detail?: string | null
  clientId?: string | null
  projectId?: string | null
  taskId?: string | null
  /** 'web' o 'api:<nombre de la llave>' (auditoria; no se muestra en el texto). */
  via?: string
}

export async function recordActivity(db: Pool | PoolClient, a: ActivityInput): Promise<number> {
  // Limpieza oportunista, sin tareas programadas (como la papelera).
  await db.query(`DELETE FROM activity WHERE created_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])
  const { rows } = await db.query(
    `INSERT INTO activity (kind, actor_id, client_id, project_id, task_id, subject, detail, via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [a.kind, a.actorId, a.clientId ?? null, a.projectId ?? null, a.taskId ?? null, a.subject, a.detail ?? null, a.via ?? 'web'],
  )
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, String(rows[0].id)])
  return Number(rows[0].id)
}

/** Texto del aviso: siempre "<socio> <verbo>...", con el nombre del dueño de la llave. */
export function activityText(kind: ActivityKind, actor: string, subject: string, detail: string | null): string {
  switch (kind) {
    case 'cliente_nuevo':
      return `${actor} añadió un cliente nuevo: ${subject}`
    case 'posible_nuevo':
      return `${actor} añadió un cliente potencial: ${subject}`
    case 'tarea_nueva':
      return `${actor} añadió la tarea «${subject}»${detail ? ` en ${detail}` : ''}`
    case 'tarea_completada':
      return `${actor} completó la tarea «${subject}»${detail ? ` de ${detail}` : ''}`
    case 'cobro_cobrado':
      return `${actor} registró el cobro${detail ? ` de ${detail}` : ''} a ${subject}`
    case 'cambio_etapa':
      return `${actor} movió a ${subject}${detail ? ` (${detail})` : ''}`
    case 'cliente_ganado':
      return `${actor} ganó a ${subject}: ya es cliente`
    case 'cliente_perdido':
      return `${actor} marcó como perdido a ${subject}${detail ? ` (${detail})` : ''}`
    case 'lead_meta':
      return `Llegó un cliente potencial de Meta Ads: ${subject}` // lo trae el sistema, no un socio: no nombra a nadie
    case 'acuerdo_nuevo':
      return `${actor} registró un acuerdo: ${subject}`
    case 'version_nueva':
      return `Nueva actualización v${subject} disponible${detail ? `: ${detail}` : ''}` // la trae el sistema: avisa a TODOS y no nombra a nadie
    case 'feed_nuevo':
      return `Feed de oportunidades: ${subject}` // lo trae un agente o una automatización: avisa a TODOS y no nombra a nadie
    case 'sistema_caido':
      return `El sistema «${subject}»${detail ? ` de ${detail}` : ''} dejó de responder`
    case 'sistema_recuperado':
      return `El sistema «${subject}»${detail ? ` de ${detail}` : ''} volvió a responder`
  }
}

/** Fila de activity unida a su autor -> forma publica (la misma en la API, el MCP y el stream en vivo). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const activityOut = (r: any, viewerId?: string) => ({
  id: Number(r.id),
  tipo: r.kind as ActivityKind,
  texto: activityText(r.kind, r.actor_name, r.subject, r.detail),
  actor: { id: r.actor_id as string, nombre: r.actor_name as string, avatar: r.actor_avatar as string },
  // Un lead de Meta o un sistema caído los trae el sistema (el socio del actor es solo una referencia): avisan a TODOS, también a el.
  propia: !isSystemKind(r.kind) && viewerId !== undefined && r.actor_id === viewerId,
  sujeto: r.subject as string,
  detalle: (r.detail ?? null) as string | null,
  cliente_id: (r.client_id ?? null) as string | null,
  proyecto_id: (r.project_id ?? null) as string | null,
  tarea_id: (r.task_id ?? null) as string | null,
  fecha: (r.created_at as Date).toISOString(),
})

export const ACTIVITY_SELECT = `SELECT a.id, a.kind, a.actor_id, a.client_id, a.project_id, a.task_id, a.subject, a.detail, a.created_at,
    u.name AS actor_name, u.avatar AS actor_avatar
  FROM activity a JOIN users u ON u.id = a.actor_id`
