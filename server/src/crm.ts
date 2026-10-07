// Nucleo del CRM: ficha del cliente y pipeline de posibles clientes. Un solo lugar decide como cambia una etapa, asi que la
// web, la API v1 y el MCP no pueden contradecirse (ni dejar la probabilidad o el motivo de perdida a medias).
// Hoja del grafo de imports a proposito (solo db/util): lo usan routes/ y services/, y estos ya se importan entre si.
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { HttpError, isoDate, money, text } from './util.ts'

export const STAGES = ['nuevo', 'contactado', 'propuesta', 'negociacion', 'ganado', 'perdido'] as const
export type Stage = (typeof STAGES)[number]
export const OPEN_STAGES = ['nuevo', 'contactado', 'propuesta', 'negociacion'] as const
export const isOpenStage = (s: string | null): s is (typeof OPEN_STAGES)[number] => !!s && (OPEN_STAGES as readonly string[]).includes(s)

/** Probabilidad que se sugiere (y se pone al entrar desde ganado/perdido) en cada etapa. Ganado y perdido son fijas: 100 y 0. */
export const STAGE_PROB: Record<Stage, number> = { nuevo: 10, contactado: 25, propuesta: 50, negociacion: 75, ganado: 100, perdido: 0 }
export const STAGE_LABEL: Record<Stage, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  propuesta: 'Propuesta',
  negociacion: 'Negociación',
  ganado: 'Ganado',
  perdido: 'Perdido',
}

export const SOURCES = ['referido', 'instagram', 'whatsapp', 'facebook', 'meta_ads', 'web', 'visita_frio', 'evento', 'otro'] as const

/** Un posible cliente sin contacto real desde hace mas de estos dias esta "frio". */
export const COLD_DAYS = 14

// ---------- esquema compartido (REST v1 y MCP lo usan tal cual; la web lo usa tras traducir sus llaves) ----------
// `null` borra un campo; omitirlo lo deja como esta. Cadenas vacias no valen (text() exige contenido): para borrar, null.
const phone = z
  .string()
  .trim()
  .max(40, 'Máximo 40 caracteres')
  .regex(/^\+?[\d\s().-]{6,40}$/, 'Teléfono inválido (solo dígitos, espacios, + ( ) . -)')
const tag = z.string().trim().min(1, 'Etiqueta vacía').max(30, 'Cada etiqueta admite máximo 30 caracteres')

export const fichaShape = {
  telefono: phone.nullable().optional(),
  email: z.email('Email inválido').max(120, 'Máximo 120 caracteres').nullable().optional(),
  contacto_nombre: text(80).nullable().optional(),
  contacto_cargo: text(80).nullable().optional(),
  direccion: text(300).nullable().optional(),
  notas: text(4000).nullable().optional(),
  etiquetas: z.array(tag).max(10, 'Máximo 10 etiquetas').optional(), // [] las quita todas
  origen: z.enum(SOURCES, `Origen inválido (${SOURCES.join(', ')})`).nullable().optional(),
  // pipeline (solo posibles clientes)
  etapa: z.enum(STAGES, `Etapa inválida (${STAGES.join(', ')})`).optional(),
  valor_estimado: money.nullable().optional(),
  probabilidad: z.number('Probabilidad inválida (entero de 0 a 100)').int('Probabilidad inválida (entero de 0 a 100)').min(0, 'Mínimo 0').max(100, 'Máximo 100').optional(),
  cierre_previsto: isoDate.nullable().optional(),
  motivo_perdida: text(300).nullable().optional(),
  // seguimiento
  proxima_accion: text(160).nullable().optional(),
  proxima_accion_fecha: isoDate.nullable().optional(),
}
export type FichaPatch = z.infer<z.ZodObject<typeof fichaShape>>
export type ClientPatch = FichaPatch & { nombre?: string; avatar?: string; estado?: 'activo' | 'posible'; archivado?: boolean }

const PIPELINE_KEYS = ['etapa', 'valor_estimado', 'probabilidad', 'cierre_previsto', 'motivo_perdida'] as const

/** Minuscula, espacios colapsados, sin repetidas y en el orden en que llegaron. */
export const normTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().replace(/\s+/g, ' ').toLowerCase()))]

/** Dias enteros entre dos fechas 'AAAA-MM-DD' (calendario puro, sin zonas horarias). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * Aplica un cambio de ficha / pipeline / seguimiento (y de nombre, avatar, estado o archivo) a un cliente, dentro de la
 * transaccion `c`. Bloquea la fila, resuelve la etapa final y la valida entera ANTES de escribir:
 *  - estado 'activo' sobre un posible = ganado; estado 'posible' sobre un cliente = nuevo; etapa 'ganado' = convertir.
 *  - ganado fija la probabilidad en 100 y perdido en 0 (pedir otra cosa es un 400, no se ignora en silencio).
 *    Al reabrir un perdido o ganado, la probabilidad vuelve a la de la etapa (10/25/50/75) si no se manda una.
 *  - perdido exige motivo_perdida; fuera de perdido el motivo no existe.
 *  - los datos de pipeline solo se editan en un posible cliente (o en la misma peticion que lo convierte, para anotar el valor).
 *  - cada cambio de etapa deja una entrada 'etapa' en la bitacora, escrita aqui y solo aqui.
 * Devuelve si cambio la etapa.
 */
export async function applyClientPatch(c: PoolClient, actorId: string, clientId: string, p: ClientPatch): Promise<{ changed: boolean }> {
  const cur = (
    await c.query(
      `SELECT is_prospect, pipeline_stage, probability, lost_reason, next_action, next_action_date, archived_at
       FROM clients WHERE id = $1 FOR UPDATE`,
      [clientId],
    )
  ).rows[0]
  if (!cur) throw new HttpError(404, 'Cliente no encontrado')
  const was: Stage | null = cur.pipeline_stage

  // ---- etapa final ----
  if (p.estado && p.etapa && (p.estado === 'activo') !== (p.etapa === 'ganado'))
    throw new HttpError(400, 'estado y etapa se contradicen: "activo" equivale a la etapa "ganado" y "posible" a las demás')
  if (p.etapa === 'ganado' && !cur.is_prospect) throw new HttpError(409, 'El cliente ya no es un posible cliente')
  if (p.etapa === 'perdido' && !cur.is_prospect) throw new HttpError(409, 'Solo un posible cliente se marca como perdido')

  let stage: Stage | null = was
  if (p.etapa) stage = p.etapa
  else if (p.estado === 'activo' && cur.is_prospect) stage = 'ganado'
  else if (p.estado === 'posible' && !cur.is_prospect) stage = 'nuevo'
  const changed = stage !== was
  const prospect = stage !== null && stage !== 'ganado'

  const touchesPipeline = PIPELINE_KEYS.some((k) => p[k] !== undefined)
  if (touchesPipeline && !(prospect || (changed && stage === 'ganado')))
    throw new HttpError(400, 'Los datos de pipeline (etapa, valor, probabilidad, cierre, motivo) solo aplican a un posible cliente')

  // ---- probabilidad ----
  let prob: number | null = cur.probability
  if (stage === 'ganado' || stage === 'perdido') {
    if (p.probabilidad !== undefined && p.probabilidad !== STAGE_PROB[stage])
      throw new HttpError(400, `En la etapa "${stage}" la probabilidad es ${STAGE_PROB[stage]}`)
    prob = STAGE_PROB[stage]
  } else if (stage !== null) {
    if (p.probabilidad !== undefined) prob = p.probabilidad
    else if (changed && (was === null || was === 'ganado' || was === 'perdido')) prob = STAGE_PROB[stage]
  }

  // ---- motivo de perdida ----
  let lost: string | null = null
  if (stage === 'perdido') {
    lost = p.motivo_perdida !== undefined ? p.motivo_perdida : changed ? null : cur.lost_reason
    if (!lost) throw new HttpError(400, 'Indica motivo_perdida para marcar un posible cliente como perdido')
  } else if (p.motivo_perdida != null) throw new HttpError(400, 'motivo_perdida solo aplica a la etapa "perdido"')

  // ---- proxima accion: la fecha siempre acompana a una accion ----
  let action: string | null = cur.next_action
  let actionDate: string | null = cur.next_action_date
  if (p.proxima_accion !== undefined) action = p.proxima_accion
  if (p.proxima_accion_fecha !== undefined) actionDate = p.proxima_accion_fecha
  if (action === null) {
    if (p.proxima_accion_fecha != null) throw new HttpError(400, 'proxima_accion_fecha necesita una proxima_accion')
    actionDate = null // borrar la accion se lleva su fecha
  }

  // ---- escritura (un solo UPDATE: los CHECK se evaluan al final, con todo coherente) ----
  const sets: string[] = []
  const args: unknown[] = [clientId]
  const set = (col: string, value: unknown, cast = '') => {
    args.push(value)
    sets.push(`${col} = $${args.length}${cast}`)
  }
  if (p.nombre !== undefined) set('name', p.nombre)
  if (p.avatar !== undefined) set('avatar', p.avatar)
  if (p.telefono !== undefined) set('phone', p.telefono)
  if (p.email !== undefined) set('email', p.email === null ? null : p.email.toLowerCase())
  if (p.contacto_nombre !== undefined) set('contact_name', p.contacto_nombre)
  if (p.contacto_cargo !== undefined) set('contact_role', p.contacto_cargo)
  if (p.direccion !== undefined) set('address', p.direccion)
  if (p.notas !== undefined) set('notes', p.notas)
  if (p.etiquetas !== undefined) set('tags', normTags(p.etiquetas), '::text[]')
  if (p.origen !== undefined) set('lead_source', p.origen)
  if (p.valor_estimado !== undefined) set('est_value', p.valor_estimado)
  if (p.cierre_previsto !== undefined) set('expected_close', p.cierre_previsto)
  if (p.proxima_accion !== undefined || p.proxima_accion_fecha !== undefined) {
    set('next_action', action)
    set('next_action_date', actionDate, '::date')
  }
  if (changed) {
    set('is_prospect', prospect)
    set('pipeline_stage', stage)
    sets.push('stage_changed_at = now()')
  }
  if (changed || touchesPipeline) {
    set('probability', prob)
    set('lost_reason', lost)
  }
  if (p.archivado === true) sets.push('archived_at = COALESCE(archived_at, now())')
  if (p.archivado === false) sets.push('archived_at = NULL')
  if (sets.length) await c.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1`, args)

  if (changed) {
    const label = (s: Stage | null) => (s ? STAGE_LABEL[s] : 'Sin etapa')
    await c.query(
      `INSERT INTO interactions (client_id, kind, summary, meta, created_by) VALUES ($1, 'etapa', $2, $3::jsonb, $4)`,
      [clientId, `${label(was)} → ${label(stage)}`, JSON.stringify({ de: was, a: stage, ...(lost ? { motivo: lost } : {}) }), actorId],
    )
  }
  return { changed }
}
