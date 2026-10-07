// Rutas de la web (sesion + CSRF) para la ficha, la bitacora, las alertas, la busqueda y el pipeline.
// No tienen logica propia: llaman a los MISMOS servicios que /api/v1 y el MCP, asi que validan y se comportan igual.
// La web de clientes habla en camelCase (name, tags, nextAction...); la ficha se traduce a las llaves del servicio
// y cualquier campo que no este en la tabla se rechaza con 400.
import { Router, type Request } from 'express'
import { z } from 'zod'
import { applyClientPatch, fichaShape } from '../crm.ts'
import { pool, tx } from '../db.ts'
import { exec } from '../services/common.ts'
import { notificacionesLeer, notificacionesListar, pipelineResumen } from '../services/alertas.ts'
import { openStream } from '../events.ts'
import { actividadLeer, actividadListar } from '../services/actividad.ts'
import { buscar } from '../services/buscar.ts'
import { interaccionActualizar, interaccionesListar, interaccionRegistrar } from '../services/interacciones.ts'
import { sendToTrash } from '../trash.ts'
import { HttpError, idParam, parse } from '../util.ts'
import { loadClients } from './clients.ts'

export const crmRouter = Router()

const FICHA_KEYS: Record<string, string> = {
  phone: 'telefono',
  email: 'email',
  contactName: 'contacto_nombre',
  contactRole: 'contacto_cargo',
  address: 'direccion',
  notes: 'notas',
  tags: 'etiquetas',
  source: 'origen',
  stage: 'etapa',
  estValue: 'valor_estimado',
  probability: 'probabilidad',
  expectedClose: 'cierre_previsto',
  lostReason: 'motivo_perdida',
  nextAction: 'proxima_accion',
  nextActionDate: 'proxima_accion_fecha',
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fromQuery = (req: Request, nums: string[] = []) => {
  const o: Record<string, unknown> = { ...req.query }
  for (const k of ['page', 'per_page', 'limite', ...nums]) if (typeof o[k] === 'string') o[k] = Number(o[k])
  return o
}

// Ficha, pipeline y seguimiento del cliente. null borra un campo; omitirlo lo deja igual.
crmRouter.patch('/clients/:id/ficha', async (req, res) => {
  const clientId = idParam(req.params.id)
  if (!isObject(req.body)) throw new HttpError(400, 'Cuerpo inválido')
  const mapped: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(req.body)) {
    const to = FICHA_KEYS[k]
    if (!to) throw new HttpError(400, `Campo desconocido: ${k}`)
    mapped[to] = v
  }
  const patch = parse(
    z.strictObject(fichaShape).refine((v) => Object.values(v).some((x) => x !== undefined), 'Envía al menos un campo a modificar'),
    mapped,
  )
  await tx((c) => applyClientPatch(c, req.user!.id, clientId, patch))
  res.json((await loadClients(pool, [clientId]))[0])
})

// Bitacora
crmRouter.get('/clients/:id/interactions', async (req, res) => {
  res.json(await exec(interaccionesListar, req.user!, { ...fromQuery(req), cliente_id: req.params.id }))
})
crmRouter.post('/clients/:id/interactions', async (req, res) => {
  res.status(201).json(await exec(interaccionRegistrar, req.user!, { ...(isObject(req.body) ? req.body : {}), cliente_id: req.params.id }))
})
crmRouter.patch('/interactions/:id', async (req, res) => {
  res.json(await exec(interaccionActualizar, req.user!, { ...(isObject(req.body) ? req.body : {}), id: req.params.id }))
})
// Borrar manda a la papelera (30 dias), como todo lo demas; las entradas automaticas de etapa no se borran.
crmRouter.delete('/interactions/:id', async (req, res) => {
  await sendToTrash('interaccion', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})

// Alertas de la campana (por socio: cada uno marca las suyas), busqueda global y pipeline.
crmRouter.get('/notifications', async (req, res) => {
  res.json(await exec(notificacionesListar, req.user!, fromQuery(req)))
})
crmRouter.post('/notifications/read', async (req, res) => {
  res.json(await exec(notificacionesLeer, req.user!, isObject(req.body) ? req.body : {}))
})
crmRouter.get('/search', async (req, res) => {
  res.json(await exec(buscar, req.user!, fromQuery(req)))
})
crmRouter.get('/pipeline', async (_req, res) => {
  res.json(await exec(pipelineResumen, _req.user!, {}))
})

// Actividad del equipo: lista, "visto hasta" y el stream en vivo (SSE) que alimenta el popup y la campana.
crmRouter.get('/activity', async (req, res) => {
  res.json(await exec(actividadListar, req.user!, fromQuery(req, ['desde_id'])))
})
crmRouter.post('/activity/read', async (req, res) => {
  res.json(await exec(actividadLeer, req.user!, isObject(req.body) ? req.body : {}))
})
crmRouter.get('/events', openStream)
