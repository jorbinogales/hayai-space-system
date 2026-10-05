// API REST v1 para integraciones (agentes como Growi): autenticada con X-API-Key, NO con la cookie de la web.
// Contrato: ver SPEC.md y server/src/v1/README en el README del repo. Errores: { error: { code, message } }.
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { exec, type Op } from '../services/common.ts'
import { clienteActualizar, clienteCrear, clientesListar, clienteVer, pagoActualizar, pagoRegistrar, pagosListar } from '../services/clientes.ts'
import { finanzasResumen } from '../services/finanzas.ts'
import { gastoActualizar, gastoRegistrar, gastosListar, gastoVer } from '../services/gastos.ts'
import { proyectoActualizar, proyectoCrear, proyectosListar, proyectoVer } from '../services/proyectos.ts'
import { tareaActualizar, tareaCrear, tareasListar, tareaVer } from '../services/tareas.ts'
import { HttpError } from '../util.ts'
import { apiKeyAuth, keyRateLimit } from './apiKey.ts'

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
  for (const k of ['page', 'per_page']) if (typeof o[k] === 'string') o[k] = Number(o[k])
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
v1Router.use(jsonOnly, express.json({ limit: '100kb' }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function route(method: 'get' | 'post' | 'patch', path: string, o: Op<any, any>, status = 200) {
  const input = method === 'get' ? fromQuery : fromBody
  v1Router[method](path, async (req, res) => {
    res.status(status).json(await exec(o, req.user!, input(req)))
  })
}

// Quien soy: sirve para probar la conexion y ver a quien se atribuyen las escrituras de esta llave.
v1Router.get('/me', (req, res) => {
  res.json({ usuario: { id: req.user!.id, nombre: req.user!.name }, llave: { nombre: req.apiKey!.name, prefijo: req.apiKey!.prefix } })
})

route('get', '/clientes', clientesListar)
route('get', '/clientes/:id', clienteVer)
route('post', '/clientes', clienteCrear, 201)
route('patch', '/clientes/:id', clienteActualizar)
route('post', '/clientes/:cliente_id/pagos', pagoRegistrar, 201)

route('get', '/pagos', pagosListar)
route('patch', '/pagos/:id', pagoActualizar)

route('get', '/proyectos', proyectosListar)
route('get', '/proyectos/:id', proyectoVer)
route('post', '/proyectos', proyectoCrear, 201)
route('patch', '/proyectos/:id', proyectoActualizar)

route('get', '/gastos', gastosListar)
route('get', '/gastos/:id', gastoVer)
route('post', '/gastos', gastoRegistrar, 201)
route('patch', '/gastos/:id', gastoActualizar)

route('get', '/finanzas/resumen', finanzasResumen)

route('get', '/tareas', tareasListar)
route('get', '/tareas/:id', tareaVer)
route('post', '/tareas', tareaCrear, 201)
route('patch', '/tareas/:id', tareaActualizar)

// Sin DELETE en v1 (SPEC §2): ni siquiera responde 405, simplemente no existe.
v1Router.use((_req, _res) => {
  throw new HttpError(404, 'No encontrado')
})
v1Router.use(apiErrors)
