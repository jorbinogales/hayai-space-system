// API REST v1 para integraciones (agentes como Growi): autenticada con X-API-Key, NO con la cookie de la web.
// Contrato: ver SPEC.md y server/src/v1/README en el README del repo. Errores: { error: { code, message } }.
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { exec, type Op } from '../services/common.ts'
import { clienteActualizar, clienteCrear, clientesListar, clienteVer, pagoActualizar, pagoRegistrar, pagosListar } from '../services/clientes.ts'
import { comprobanteArchivo, comprobanteDetectar, comprobanteSubir, comprobanteVer, pagoVer, receptorEliminar, receptorGuardar, receptoresListar } from '../services/cobros.ts'
import { acuerdoActualizar, acuerdoCrear, acuerdosListar, equipoActualizar, equipoVer, hubVer, marketingEmbudo } from '../services/hub.ts'
import { sistemaActualizar, sistemaCrear, sistemasListar, sistemaVer, sistemaVerificar } from '../services/sistemas.ts'
import { finanzasResumen } from '../services/finanzas.ts'
import { notificacionesLeer, notificacionesListar, pipelineEtapas, pipelineResumen } from '../services/alertas.ts'
import { actividadLeer, actividadListar } from '../services/actividad.ts'
import { buscar } from '../services/buscar.ts'
import { interaccionActualizar, interaccionesListar, interaccionRegistrar } from '../services/interacciones.ts'
import { checklistEliminar, clienteEliminar, gastoEliminar, hitoEliminar, interaccionEliminar, pagoEliminar, papeleraListar, papeleraRestaurar, proyectoEliminar, tareaEliminar } from '../services/papelera.ts'
import { gastoActualizar, gastoRegistrar, gastosListar, gastoVer } from '../services/gastos.ts'
import { checklistActualizar, checklistAgregar, checklistOrdenar, hitoActualizar, hitoCrear, hitosOrdenar, proyectoActualizar, proyectoCrear, proyectosListar, proyectoVer } from '../services/proyectos.ts'
import { ofertaActualizar, ofertaCrear, ofertaDesactivar, ofertasListar, propuestaActualizar, propuestaCrear, propuestasListar, propuestaVer } from '../services/propuestas.ts'
import { tareaActualizar, tareaCrear, tareasListar, tareaVer } from '../services/tareas.ts'
import { HttpError } from '../util.ts'
import { apiKeyAuth, keyRateLimit, requireScope, SCOPE_LABEL, type Scope } from './apiKey.ts'

const CODES: Record<number, string> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  423: 'locked',
  429: 'rate_limited',
}

/** Manejador de errores del formato v1 (tambien lo usa /mcp). */
export function apiErrors(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as { type?: string; code?: string; message?: string }
  const send = (status: number, message: string, extra: Record<string, unknown> = {}) =>
    void res.status(status).json({ error: { code: CODES[status] ?? 'error', message, ...extra } })

  if (err instanceof HttpError) return send(err.status, err.message, err.extra)
  if (e.type === 'entity.too.large') return send(413, 'Cuerpo demasiado grande')
  if (e.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'invalid_json', message: 'JSON inválido' } })
  if (e.code === '23503' || e.code === '23505') return send(409, 'Conflicto con datos existentes')
  if (e.code === '23514' || e.code === '22P02') return send(400, 'Datos inválidos')
  console.error(err)
  res.status(500).json({ error: { code: 'internal_error', message: 'Error interno del servidor' } })
}

/** Los cuerpos con contenido deben ser JSON. */
export function jsonOnly(req: Request, _res: Response, next: NextFunction) {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined
  if (hasBody && !req.is('application/json')) throw new HttpError(415, 'Content-Type debe ser application/json')
  next()
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Query string -> entrada: page y per_page llegan como texto y el esquema espera numeros. */
const fromQuery = (req: Request) => {
  const o: Record<string, unknown> = { ...req.query }
  for (const k of ['page', 'per_page', 'limite', 'desde_id', 'dias']) if (typeof o[k] === 'string') o[k] = Number(o[k])
  return { ...o, ...req.params }
}
/** Cuerpo JSON + parametros de la ruta (los de la ruta mandan: el :id de la URL no se puede pisar desde el cuerpo). */
const fromBody = (req: Request) => ({ ...(isObject(req.body) ? req.body : {}), ...req.params })

export const v1Router = Router()

v1Router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})
v1Router.use(apiKeyAuth, keyRateLimit())
// El comprobante viaja en base64 (hasta 4 MB de imagen): solo esa ruta admite un cuerpo grande.
v1Router.post('/pagos/:id/comprobante', jsonOnly, express.json({ limit: '6mb' }))
v1Router.use(jsonOnly, express.json({ limit: '100kb' }))

const SCOPE_OF = { get: 'read', post: 'write', patch: 'write', delete: 'delete' } as const

// Cada ruta exige el permiso de su método (GET lee, POST/PATCH escriben, DELETE borra) ANTES de ejecutar nada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function route(method: 'get' | 'post' | 'patch' | 'delete', path: string, o: Op<any, any>, status = 200) {
  const input = method === 'get' || method === 'delete' ? fromQuery : fromBody
  v1Router[method](path, async (req, res) => {
    requireScope(req, SCOPE_OF[method])
    res.status(status).json(await exec(o, req.user!, input(req)))
  })
}

// Quien soy: sirve para probar la conexion y ver a quien se atribuyen las escrituras de esta llave.
v1Router.get('/me', (req, res) => {
  const k = req.apiKey!
  res.json({
    usuario: { id: req.user!.id, nombre: req.user!.name },
    llave: { nombre: k.name, prefijo: k.prefix, permisos: k.scopes.map((x: Scope) => ({ permiso: x, descripcion: SCOPE_LABEL[x] })) },
  })
})

route('get', '/clientes', clientesListar)
route('get', '/clientes/:id', clienteVer)
route('post', '/clientes', clienteCrear, 201)
route('patch', '/clientes/:id', clienteActualizar)
route('post', '/clientes/:cliente_id/pagos', pagoRegistrar, 201)
route('delete', '/clientes/:id', clienteEliminar)

// Bitácora del cliente. Las entradas de tipo "etapa" las escribe solo el sistema: aquí no se crean, editan ni borran.
route('get', '/clientes/:cliente_id/interacciones', interaccionesListar)
route('post', '/clientes/:cliente_id/interacciones', interaccionRegistrar, 201)
route('patch', '/interacciones/:id', interaccionActualizar)
route('delete', '/interacciones/:id', interaccionEliminar)

// Propuestas comerciales (versionadas, con mensualidad base + extras) y el catalogo de ofertas de HAYAI.
route('get', '/clientes/:cliente_id/propuestas', propuestasListar)
route('post', '/clientes/:cliente_id/propuestas', propuestaCrear, 201)
route('get', '/propuestas/:id', propuestaVer)
route('patch', '/propuestas/:id', propuestaActualizar)
route('get', '/ofertas', ofertasListar)
route('post', '/ofertas', ofertaCrear, 201)
route('patch', '/ofertas/:id', ofertaActualizar)
route('delete', '/ofertas/:id', ofertaDesactivar) // desactiva (no destruye): las propuestas que la usan conservan su texto y precio

route('get', '/pagos', pagosListar)
route('get', '/pagos/:id', pagoVer) // detalle del cobro: bolívares, tasa, referencia, bancos, recibido_por, método, comprobante
route('patch', '/pagos/:id', pagoActualizar)
route('post', '/pagos/:id/comprobante', comprobanteSubir) // imagen_base64 (PNG/JPEG/WebP, máx. 4 MB); lee "DOCUMENTO V-..." y asigna recibido_por si está mapeado
route('get', '/pagos/:id/comprobante', comprobanteVer)
route('post', '/pagos/:id/comprobante/detectar', comprobanteDetectar) // vuelve a cruzar el documento leído con el mapeo (sin repetir el OCR)
v1Router.get('/pagos/:id/comprobante/archivo', async (req, res) => {
  requireScope(req, 'read')
  const f = await comprobanteArchivo(String(req.params.id))
  res.setHeader('Content-Type', f.mime)
  res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`)
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.send(f.data)
})
route('get', '/receptores', receptoresListar) // documentos -> socio que recibe (enmascarados)
route('post', '/receptores', receptorGuardar)
route('delete', '/receptores/:id', receptorEliminar)
route('delete', '/pagos/:id', pagoEliminar)

route('get', '/proyectos', proyectosListar)
route('get', '/proyectos/:id', proyectoVer)
route('post', '/proyectos', proyectoCrear, 201)
route('patch', '/proyectos/:id', proyectoActualizar)
route('delete', '/proyectos/:id', proyectoEliminar)
// Hitos (roadmap) y checklist de accionables del proyecto.
route('post', '/proyectos/:proyecto_id/hitos', hitoCrear, 201)
route('post', '/proyectos/:proyecto_id/hitos/orden', hitosOrdenar)
route('patch', '/hitos/:id', hitoActualizar)
route('delete', '/hitos/:id', hitoEliminar)
route('post', '/proyectos/:proyecto_id/checklist', checklistAgregar, 201)
route('post', '/proyectos/:proyecto_id/checklist/orden', checklistOrdenar)
route('patch', '/checklist/:id', checklistActualizar)
route('delete', '/checklist/:id', checklistEliminar)

route('get', '/gastos', gastosListar)
route('get', '/gastos/:id', gastoVer)
route('post', '/gastos', gastoRegistrar, 201)
route('patch', '/gastos/:id', gastoActualizar)
route('delete', '/gastos/:id', gastoEliminar)

route('get', '/finanzas/resumen', finanzasResumen)

// Hub central (planeta HAYAI) y embudo del planeta Marketing.
route('get', '/hub', hubVer)
route('get', '/equipo', equipoVer)
route('patch', '/equipo/:socio', equipoActualizar)
route('get', '/acuerdos', acuerdosListar)
route('post', '/acuerdos', acuerdoCrear, 201)
route('patch', '/acuerdos/:id', acuerdoActualizar)
route('get', '/sistemas', sistemasListar)
route('get', '/sistemas/:id', sistemaVer)
route('post', '/sistemas', sistemaCrear, 201)
route('patch', '/sistemas/:id', sistemaActualizar)
route('post', '/sistemas/:id/verificar', sistemaVerificar)
route('get', '/marketing/embudo', marketingEmbudo)

route('get', '/pipeline', pipelineResumen)
route('get', '/pipeline/etapas', pipelineEtapas)
route('get', '/notificaciones', notificacionesListar)
route('post', '/notificaciones/leer', notificacionesLeer) // marca como leídas las alertas de ESTE socio (el dueño de la llave)
route('get', '/actividad', actividadListar) // lo que hacen los demás socios; desde_id + orden=asc para consultar solo lo nuevo
route('post', '/actividad/leer', actividadLeer) // mueve el "visto hasta" de ESTE socio
route('get', '/buscar', buscar)

route('get', '/tareas', tareasListar)
route('get', '/tareas/:id', tareaVer)
route('post', '/tareas', tareaCrear, 201)
route('patch', '/tareas/:id', tareaActualizar)
route('delete', '/tareas/:id', tareaEliminar)

// Papelera: lo borrado se puede ver y restaurar. El borrado definitivo no existe en la API.
route('get', '/papelera', papeleraListar)
route('post', '/papelera/:id/restaurar', papeleraRestaurar)

// Lo que no es una ruta de arriba no existe.
v1Router.use((_req, _res) => {
  throw new HttpError(404, 'No encontrado')
})
v1Router.use(apiErrors)
