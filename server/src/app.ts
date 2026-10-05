import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { requirePinChanged, requireSession } from './auth.ts'
import { authRouter } from './routes/auth.ts'
import { clientsRouter, paymentsRouter, prospectsRouter } from './routes/clients.ts'
import { expensesRouter } from './routes/expenses.ts'
import { projectsRouter } from './routes/projects.ts'
import { tasksRouter } from './routes/tasks.ts'
import { usersRouter } from './routes/users.ts'
import { mcpRouter } from './mcp/index.ts'
import { v1Router } from './v1/index.ts'
import { HttpError } from './util.ts'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Anti-CSRF básico: Origin (si viene) debe coincidir con el host, y los cuerpos deben ser JSON. */
function csrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next()
  const origin = req.headers.origin
  if (origin) {
    let host: string | null = null
    try {
      host = new URL(origin).host
    } catch {
      /* Origin: null u otro valor inválido */
    }
    if (host !== req.headers.host) throw new HttpError(403, 'Origen no permitido')
  }
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined
  if (hasBody && !req.is('application/json')) throw new HttpError(415, 'Content-Type debe ser application/json')
  next()
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  })

  // Integraciones (X-API-Key, sin cookies ni CSRF): van antes de /api, que exige sesion de la web.
  app.use('/api/v1', v1Router)
  app.use('/mcp', mcpRouter)

  const api = express.Router()
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  api.use(csrf)
  api.use(express.json({ limit: '100kb' }))
  api.use('/auth', authRouter)
  api.use(requireSession, requirePinChanged)
  api.use('/users', usersRouter)
  api.use('/clients', clientsRouter)
  api.use('/payments', paymentsRouter)
  api.use('/prospects', prospectsRouter)
  api.use('/projects', projectsRouter)
  api.use('/expenses', expensesRouter)
  api.use('/tasks', tasksRouter)
  api.use((_req, _res) => {
    throw new HttpError(404, 'No encontrado')
  })
  app.use('/api', api)

  // Producción: sirve el build del frontend (../dist) con fallback a index.html.
  const dist = resolve(import.meta.dirname, '../../dist')
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist))
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(resolve(dist, 'index.html')) : next()))
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string; code?: string; message?: string }
    if (err instanceof HttpError) return void res.status(err.status).json({ ...err.extra, error: err.message })
    if (e.type === 'entity.too.large') return void res.status(413).json({ error: 'Cuerpo demasiado grande' })
    if (e.type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON inválido' })
    if (e.code === '23503' || e.code === '23505') return void res.status(409).json({ error: 'Conflicto con datos existentes' })
    if (e.code === '23514' || e.code === '22P02') return void res.status(400).json({ error: 'Datos inválidos' })
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  })

  return app
}
