// Registro de actividad del equipo (cliente nuevo, tarea nueva, tarea completada). Hoja del grafo de imports a proposito
// (solo tipos de pg): lo usan routes/ y services/, y estos ya se importan entre si.
// Se llama DENTRO de la transaccion del cambio: el INSERT y el pg_notify se confirman (o se deshacen) con el. Asi no hay
// avisos de algo que no paso, ni algo que pasa sin aviso.
import type { Pool, PoolClient } from 'pg'

export const KINDS = ['cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada'] as const
export type ActivityKind = (typeof KINDS)[number]

export const CHANNEL = 'activity'
const RETENTION_DAYS = 60

export type ActivityInput = {
  kind: ActivityKind
  actorId: string
  /** Nombre del cliente o titulo de la tarea. */
  subject: string
  /** Tareas: nombre del proyecto. */
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
      return `${actor} añadió un posible cliente: ${subject}`
    case 'tarea_nueva':
      return `${actor} añadió la tarea «${subject}»${detail ? ` en ${detail}` : ''}`
    case 'tarea_completada':
      return `${actor} completó la tarea «${subject}»${detail ? ` de ${detail}` : ''}`
  }
}

/** Fila de activity unida a su autor -> forma publica (la misma en la API, el MCP y el stream en vivo). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const activityOut = (r: any, viewerId?: string) => ({
  id: Number(r.id),
  tipo: r.kind as ActivityKind,
  texto: activityText(r.kind, r.actor_name, r.subject, r.detail),
  actor: { id: r.actor_id as string, nombre: r.actor_name as string, avatar: r.actor_avatar as string },
  propia: viewerId !== undefined && r.actor_id === viewerId,
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
