// Pruebas de la API v1 (X-API-Key) y del servidor MCP contra el servidor real. Levantan su propio Postgres embebido
// (puerto 54331, directorio temporal que se borra al terminar) y su propio servidor (puerto 3102): no tocan la BD de
// desarrollo ni chocan con api.test.ts. Uso: npm run test:server (como usuario no-root, por el Postgres embebido).
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { keyRateLimit } from '../src/v1/apiKey.ts'

const root = resolve(import.meta.dirname, '../..')
const PG_PORT = 54331
const API_PORT = 3102
const DATABASE_URL = `postgres://hayai:hayai@localhost:${PG_PORT}/hayai`
const ROOT = `http://localhost:${API_PORT}`
const NOPE = '00000000-0000-4000-8000-000000000000' // uuid valido que no existe

let embedded: EmbeddedPostgres
let dataDir: string
let server: ChildProcess
let admin: pg.Client
let env: NodeJS.ProcessEnv
// Graph API falso (Meta Lead Ads): el servidor de la app le pide aqui el detalle de cada lead. Sin salir a internet.
const GRAPH_PORT = 3199
const META_SECRET = 'secreto-de-prueba'
let graph: Server
const graphLeads = new Map<string, unknown>() // leadgen_id -> respuesta de Graph
const graphDown = new Set<string>() // leadgen_id que responden 500
const graphHits: string[] = []
// Sistema "de un cliente" falso: el vigilante lo consulta aquí. up=false => 500.
const TARGET_PORT = 3198
let target: Server
let targetUp = true
// Fuentes falsas de la tasa BCV: null = responde 500.
const BCV_PORT = 3196
let bcvServer: Server
const bcvPayload: { principal: unknown; respaldo: unknown } = { principal: null, respaldo: null }
const bcvHits = { principal: 0, respaldo: 0 }

// Servicios externos falsos de la Central de marketing: autocompletado de Google, Brightdata (SERP) y Meta (campañas, solo lectura).
const EXT_PORT = 3195
let ext: Server
const extDown = { google: false, brightdata: false, meta: false }
const extHits = { google: [] as string[], brightdata: [] as unknown[], meta: [] as string[] }
const SERP_FALSO = [
  { rank: 1, title: 'Guía de automatización para negocios', link: 'https://www.ejemplo-blog.com/guia' },
  { rank: 2, title: 'Rivalia Sistemas | Automatización', link: 'https://rivalia.com.ve/servicios' },
  { rank: 3, title: 'Rivalia (@rivaliave) • Instagram', link: 'https://www.instagram.com/rivaliave/' },
  { rank: 4, title: 'Otro sitio', link: 'https://otro.net/x' },
]

type Res = { status: number; body: any; headers: Headers; full?: any }
type Opts = { method?: string; body?: unknown; raw?: string; key?: string | null; headers?: Record<string, string> }

async function http(url: string, o: Opts = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers }
  if (o.key) headers['x-api-key'] = o.key
  let body: string | undefined
  if (o.raw !== undefined) body = o.raw
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body)
    headers['content-type'] ??= 'application/json'
  }
  const r = await fetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body })
  const text = await r.text()
  const full = text ? JSON.parse(text) : undefined
  // `actualizado_el` (la versión del registro) cambia en cada prueba: se quita de body para comparar formas exactas; `full` la conserva.
  return { status: r.status, body: stripStamp(full), headers: r.headers, full }
}
const stripStamp = (x: any): any =>
  Array.isArray(x) ? x.map(stripStamp) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'actualizado_el').map(([k, v]) => [k, stripStamp(v)])) : x

let KEY = '' // Leandro
let KEY_J = '' // Jorbi
let KEY_D = '' // Leandro, con permiso de borrado
const api = (path: string, o: Opts = {}) => http(`${ROOT}/api/v1${path}`, { key: KEY, ...o })
const apiD = (path: string, o: Opts = {}) => api(path, { key: KEY_D, ...o })

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/apikey-cli.ts', ...args], { cwd: root, env, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}
function newKey(user: string, name: string, scopes?: string) {
  const r = cli('create', '--user', user, '--name', name, ...(scopes ? ['--scopes', scopes] : []))
  assert.equal(r.status, 0, r.out)
  const m = r.out.match(/hy_[A-Za-z0-9_-]+/)
  assert.ok(m, r.out)
  return m[0]
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hayai-test-pg-v1-'))
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: PG_PORT,
    user: 'hayai',
    password: 'hayai',
    authMethod: 'scram-sha-256',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
    onLog: () => {},
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('hayai')

  graph = createServer((req, res) => {
    const m = /^\/v[\d.]+\/([^/?]+)/.exec(req.url ?? '')
    const lead = m ? decodeURIComponent(m[1]) : ''
    graphHits.push(lead)
    if (graphDown.has(lead) || !graphLeads.has(lead)) {
      res.writeHead(graphDown.has(lead) ? 500 : 404).end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(graphLeads.get(lead)))
  })
  await new Promise<void>((ok) => graph.listen(GRAPH_PORT, ok))

  ext = createServer((req, res) => {
    const url = req.url ?? ''
    const json = (o: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (url.startsWith('/complete/search')) {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
      extHits.google.push(q)
      if (extDown.google) return void res.writeHead(500).end('{}')
      // «semilla», «semilla » y «cómo semilla…»: cada consulta devuelve dos variantes (hay repetidas a propósito, y una con la semilla igual)
      return json([q, [`${q.trim()} precio`, `${q.trim()} en barquisimeto`, q.trim().length ? q.trim() : 'x']])
    }
    if (url.startsWith('/request')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        extHits.brightdata.push({ auth: req.headers.authorization, body: JSON.parse(raw || '{}') })
        if (extDown.brightdata) return json({}, 500)
        json({ organic: SERP_FALSO })
      })
      return
    }
    // Meta Marketing API: /v21.0/act_111, /act_111/campaigns, /act_111/insights (y act_222 en otra moneda)
    const m = /^\/v[\d.]+\/act_(\d+)(\/campaigns|\/insights)?/.exec(url)
    if (m) {
      extHits.meta.push(url)
      if (extDown.meta) return json({}, 500)
      const [, cuenta, sub] = m
      if (!sub) return json({ name: cuenta === '111' ? 'Cuenta HAYAI' : 'Cuenta Dos', currency: cuenta === '111' ? 'USD' : 'EUR' })
      if (sub === '/campaigns') return json({ data: cuenta === '111' ? [{ id: 'c1', name: 'Leads octubre', effective_status: 'ACTIVE' }, { id: 'c2', name: 'Marca', effective_status: 'PAUSED' }] : [{ id: 'c9', name: 'Otra cuenta', effective_status: 'ACTIVE' }] })
      return json({
        data:
          cuenta === '111'
            ? [{ campaign_id: 'c1', campaign_name: 'Leads octubre', spend: '30.00', actions: [{ action_type: 'link_click', value: '90' }, { action_type: 'lead', value: '6' }] }]
            : [{ campaign_id: 'c9', campaign_name: 'Otra cuenta', spend: '10.00', actions: [] }],
      })
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((ok) => ext.listen(EXT_PORT, ok))

  target = createServer((req, res) => {
    if (req.url?.startsWith('/siempre')) return void res.writeHead(200).end('ok')
    if (req.url?.startsWith('/redir')) return void res.writeHead(302, { location: `http://localhost:${TARGET_PORT}/health` }).end()
    res.writeHead(targetUp ? 200 : 500).end(targetUp ? 'ok' : 'caido')
  })
  await new Promise<void>((ok) => target.listen(TARGET_PORT, ok))
  bcvServer = createServer((req, res) => {
    const which = req.url?.startsWith('/respaldo') ? 'respaldo' : 'principal'
    bcvHits[which]++
    const p = bcvPayload[which]
    if (p === null) return void res.writeHead(500).end('{}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(p))
  })
  await new Promise<void>((ok) => bcvServer.listen(BCV_PORT, ok))

  env = {
    ...process.env,
    DATABASE_URL,
    PORT: String(API_PORT),
    LOGIN_IP_MAX: '100000',
    V1_RATE_MAX: '100000',
    NODE_ENV: 'test',
    META_LEADS_ENABLED: 'true',
    META_APP_SECRET: META_SECRET,
    META_VERIFY_TOKEN: 'verifica-123',
    META_PAGE_TOKEN: 'token-de-prueba',
    META_GRAPH_BASE: `http://localhost:${GRAPH_PORT}`,
    META_LEADS_OWNER: 'Elis,Jorbi',
    META_RETRY_MS: '400',
    // Central de marketing: todo apunta a servidores falsos locales (nunca a internet ni a saldo real).
    GOOGLE_SUGGEST_BASE: `http://localhost:${EXT_PORT}`,
    BRIGHTDATA_BASE: `http://localhost:${EXT_PORT}`,
    BRIGHTDATA_API_KEY: 'bd-llave-de-prueba',
    BRIGHTDATA_SERP_ZONE: 'serp_zona_prueba',
    BRIGHTDATA_SERP_COST_USD: '0.002',
    META_ADS_BASE: `http://localhost:${EXT_PORT}`,
    META_ADS_TOKEN: 'token-ads-de-prueba',
    META_AD_ACCOUNT_IDS: 'act_111',
    META_ADS_CACHE_MS: '0',
    // Hub y cobros: el mapeo de documentos se siembra desde el entorno (aquí, cédulas inventadas); el vigilante de sistemas
    // corre rápido y puede apuntar a localhost; la confirmación de una caída espera 100 ms en vez de 20 s.
    RECEIVER_DOCUMENTS: 'V-12345678=Jorbi,V-11111111=Nadie,roto,E-22222222=Leandro',
    SYSTEMS_ALLOW_PRIVATE: 'true',
    SYSTEMS_CHECK_MS: '2500',
    SYSTEMS_RETRY_MS: '100',
    // Tasa BCV: dos fuentes falsas (principal y respaldo); la caché caduca en 300 ms y el refresco automático está apagado.
    BCV_SOURCES: `http://localhost:${BCV_PORT}/principal,http://localhost:${BCV_PORT}/respaldo`,
    BCV_TTL_MS: '300',
    BCV_REFRESH_MS: '0',
    // El aviso de versión al arrancar se apaga: cada prueba que lo necesita publica su propia versión.
    ANNOUNCE_VERSION: 'false',
  }
  const mig = spawnSync(process.execPath, ['server/db/migrate.mjs'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(mig.status, 0, mig.stderr + mig.stdout)

  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${ROOT}/api/auth/me`)).status === 401) break
    } catch {
      /* aún arrancando */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  admin = new pg.Client({ connectionString: DATABASE_URL })
  await admin.connect()
  KEY = newKey('Leandro', 'growi')
  KEY_J = newKey('Jorbi', 'jorbi-laptop')
  KEY_D = newKey('Leandro', 'limpieza', 'read,write,delete')
})

after(async () => {
  await admin?.end().catch(() => {})
  server?.kill()
  graph?.close()
  target?.close()
  bcvServer?.close()
  ext?.close()
  await embedded?.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

// Estado compartido entre pruebas (corren en orden).
let karelys = ''
let posible = ''
let inicialId = ''
let extraId = ''
let atrasadoId = ''
let p1 = ''
let p2 = ''
let t1 = ''
let t2 = ''
let e1 = ''
let e2 = ''
let e3 = ''
let e4 = ''

describe('llaves y autenticación', () => {
  it('sin llave, llave inválida o sin prefijo => 401 con { error: { code, message } }', async () => {
    for (const key of [null, 'hy_no-existe', 'sin-prefijo']) {
      const r = await api('/me', { key })
      assert.equal(r.status, 401)
      assert.equal(r.body.error.code, 'unauthorized')
      assert.equal(typeof r.body.error.message, 'string')
    }
  })

  it('la cookie de sesión de la web NO sirve en v1', async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Elis', pin: '000000' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const r = await http(`${ROOT}/api/v1/me`, { headers: { cookie } })
    assert.equal(r.status, 401)
  })

  it('/me: dueño y nombre de la llave; en la BD solo queda el hash (sha256), nunca la llave', async () => {
    const r = await api('/me')
    assert.equal(r.status, 200)
    assert.equal(r.body.usuario.nombre, 'Leandro')
    assert.equal(r.body.llave.nombre, 'growi')
    assert.ok(KEY.startsWith(r.body.llave.prefijo))
    const { rows } = await admin.query("SELECT key_hash, prefix FROM api_keys WHERE name = 'growi'")
    assert.match(rows[0].key_hash, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(rows).includes(KEY))
    const used = await admin.query("SELECT last_used_at FROM api_keys WHERE name = 'growi'")
    assert.ok(used.rows[0].last_used_at, 'last_used_at se actualiza')
  })

  it('llave revocada o de un socio desactivado => 401', async () => {
    const tmp = newKey('Elis', 'temporal')
    assert.equal((await api('/me', { key: tmp })).status, 200)
    const prefix = (await admin.query("SELECT prefix FROM api_keys WHERE name = 'temporal'")).rows[0].prefix
    const rv = cli('revoke', prefix)
    assert.equal(rv.status, 0, rv.out)
    assert.equal((await api('/me', { key: tmp })).status, 401)

    const k2 = newKey('Elis', 'otra')
    await admin.query("UPDATE users SET active = false WHERE name = 'Elis'")
    assert.equal((await api('/me', { key: k2 })).status, 401)
    await admin.query("UPDATE users SET active = true WHERE name = 'Elis'")
    assert.equal((await api('/me', { key: k2 })).status, 200)
  })

  it('CLI: socio inexistente => error; list muestra activas y revocadas', () => {
    const bad = cli('create', '--user', 'Nadie', '--name', 'x')
    assert.equal(bad.status, 1)
    assert.match(bad.out, /No existe un socio activo/)
    const ls = cli('list')
    assert.match(ls.out, /\[activa\].*growi/)
    assert.match(ls.out, /\[revocada\].*temporal/)
  })

  it('ruta desconocida => 404; cuerpo no JSON => 415; JSON roto => 400', async () => {
    assert.equal((await apiD(`/clientes/${NOPE}`, { method: 'DELETE' })).status, 404)
    const nf = await api('/nada')
    assert.equal(nf.status, 404)
    assert.equal(nf.body.error.code, 'not_found')
    const ct = await api('/clientes', { raw: 'hola', headers: { 'content-type': 'text/plain' } })
    assert.equal(ct.status, 415)
    assert.equal(ct.body.error.code, 'unsupported_media_type')
    const bad = await api('/clientes', { raw: '{roto', headers: { 'content-type': 'application/json' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'invalid_json')
  })

  it('límite por llave: pasado el máximo => 429 con Retry-After', () => {
    const limit = keyRateLimit(3, 60_000)
    const req = { apiKey: { id: 'k-test' } } as any
    const hdrs: Record<string, unknown> = {}
    const res = { setHeader: (k: string, v: unknown) => void (hdrs[k] = v) } as any
    let passed = 0
    for (let i = 0; i < 3; i++) limit(req, res, () => passed++)
    assert.equal(passed, 3)
    assert.throws(
      () => limit(req, res, () => {}),
      (e: any) => e.status === 429 && e.extra.retryAfter > 0,
    )
    assert.ok(hdrs['Retry-After'])
    // otra llave tiene su propia cuenta
    limit({ apiKey: { id: 'otra' } } as any, res, () => passed++)
    assert.equal(passed, 4)
  })
})

describe('clientes', () => {
  it('POST /clientes: inicial cobrada + cuotas, totales derivados, atribuido al dueño de la llave', async () => {
    const r = await api('/clientes', {
      body: {
        nombre: 'Karelys',
        fecha_inicial: '2026-09-01',
        items: [
          { concepto: 'Sistema', monto: 150 },
          { concepto: 'Dominio', monto: 50 },
        ],
        cobros: [
          { fecha: '2026-10-15', monto: 20, concepto: 'Mensualidad', repetir_meses: 3 },
          { fecha: '2026-09-20', monto: 30, concepto: 'Extra' },
        ],
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const c = r.body
    karelys = c.id
    assert.equal(c.nombre, 'Karelys')
    assert.equal(c.estado, 'activo')
    assert.equal(c.recaudado, 200)
    assert.equal(c.por_cobrar, 90)
    assert.equal(c.pagos_completados, 1)
    assert.equal(c.pagos_por_cobrar, 4)
    assert.equal(c.n_items, 2)
    assert.deepEqual(c.proximo_pago, { id: c.proximo_pago.id, fecha: '2026-09-20', concepto: 'Extra', monto: 30 })
    assert.deepEqual(c.movimientos.map((m: any) => m.concepto), ['Inicial', 'Extra', 'Mensualidad 1/3', 'Mensualidad 2/3', 'Mensualidad 3/3'])
    assert.equal(c.movimientos[0].tipo, 'inicial')
    assert.equal(c.movimientos[0].estado, 'cobrado')
    assert.equal(c.movimientos[2].serie.total, 3)
    assert.deepEqual(c.items.map((i: any) => [i.concepto, i.monto]), [['Sistema', 150], ['Dominio', 50]])
    assert.ok(['nova', 'orion', 'lyra', 'vega', 'atlas', 'luna', 'kepler', 'sirio', 'rigel', 'titan', 'cygnus', 'pulsar'].includes(c.avatar))
    inicialId = c.movimientos[0].id
    extraId = c.movimientos[1].id
    const who = await admin.query('SELECT u.name FROM clients c JOIN users u ON u.id = c.created_by WHERE c.id = $1', [karelys])
    assert.equal(who.rows[0].name, 'Leandro')
  })

  it('claves desconocidas (p. ej. contacto, que no existe) => 400 legible; validaciones => 400', async () => {
    const a = await api('/clientes', { body: { nombre: 'X', contacto: '0414-0000000' } })
    assert.equal(a.status, 400)
    assert.match(a.body.error.message, /contacto/)
    assert.equal((await api('/clientes', { body: {} })).status, 400)
    assert.equal((await api('/clientes', { body: { nombre: 'X', items: [{ concepto: 'a', monto: 0 }] } })).status, 400)
    assert.equal((await api('/clientes', { body: { nombre: 'X', cobros: [{ fecha: '2026-13-40', monto: 1, concepto: 'a' }] } })).status, 400)
    assert.equal((await api('/clientes', { body: { nombre: 'X', cobros: [{ fecha: '2026-10-01', monto: 1, concepto: 'a', repetir_meses: 1 }] } })).status, 400)
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM clients WHERE name = 'X'")
    assert.equal(rows[0].n, 0, 'no deja rastro')
  })

  it('PATCH estado: un cliente sin nada pasa a posible; /clientes lista con meta.resumen igual al de la web', async () => {
    const mk = await api('/clientes', { body: { nombre: 'Posible SA' } })
    assert.equal(mk.status, 201)
    assert.equal(mk.body.recaudado, 0)
    assert.equal(mk.body.proximo_pago, null)
    posible = mk.body.id
    const p = await api(`/clientes/${posible}`, { method: 'PATCH', body: { estado: 'posible' } })
    assert.equal(p.status, 200)
    assert.equal(p.body.estado, 'posible')

    const r = await api('/clientes')
    assert.equal(r.status, 200)
    assert.equal(r.body.data.length, 2)
    assert.deepEqual(r.body.meta, {
      page: 1,
      per_page: 20,
      total: 2,
      resumen: { activos: 1, posibles: 1, archivados: 0, recaudado: 200, cuotas_por_cobrar: 4 },
    })
    assert.ok(!('movimientos' in r.body.data[0]), 'la lista es resumen; el detalle trae movimientos')
  })

  it('filtro estado, paginación y validación de parámetros', async () => {
    const pos = await api('/clientes?estado=posible')
    assert.deepEqual(pos.body.data.map((c: any) => c.nombre), ['Posible SA'])
    assert.equal(pos.body.meta.total, 1)
    const p2 = await api('/clientes?per_page=1&page=2')
    assert.deepEqual(p2.body.data.map((c: any) => c.nombre), ['Posible SA'])
    assert.equal(p2.body.meta.total, 2)
    assert.equal((await api('/clientes?page=3&per_page=1')).body.data.length, 0)
    for (const q of ['per_page=0', 'per_page=101', 'page=abc', 'page=0', 'estado=foo']) assert.equal((await api(`/clientes?${q}`)).status, 400, q)
  })

  it('GET /clientes/:id (detalle con proyectos), 404 y 400; PATCH parcial', async () => {
    const r = await api(`/clientes/${karelys}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.nombre, 'Karelys')
    assert.deepEqual(r.body.proyectos, [])
    assert.equal((await api(`/clientes/${NOPE}`)).status, 404)
    assert.equal((await api('/clientes/no-es-uuid')).status, 400)
    assert.equal((await api(`/clientes/${karelys}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/clientes/${NOPE}`, { method: 'PATCH', body: { nombre: 'Z' } })).status, 404)
    const p = await api(`/clientes/${karelys}`, { method: 'PATCH', body: { nombre: 'Karelys R' } })
    assert.equal(p.body.nombre, 'Karelys R')
    assert.equal(p.body.recaudado, 200, 'el resto no cambia')
  })
})

describe('pagos', () => {
  it('POST /clientes/:id/pagos: pendiente por defecto; el vencido se marca; validaciones', async () => {
    const r = await api(`/clientes/${karelys}/pagos`, { body: { fecha: '2000-01-01', monto: 10, concepto: 'Atrasado' } })
    assert.equal(r.status, 201)
    assert.equal(r.body.por_cobrar, 100)
    assert.equal(r.body.pagos_por_cobrar, 5)
    atrasadoId = r.body.movimientos.find((m: any) => m.concepto === 'Atrasado').id

    await api(`/clientes/${karelys}/pagos`, { body: { fecha: '2099-01-01', monto: 5, concepto: 'Futuro' } })
    const lst = await api('/pagos?estado=pendiente&hasta=2000-12-31')
    assert.equal(lst.body.data.length, 1)
    assert.equal(lst.body.data[0].vencido, true)
    assert.equal(lst.body.data[0].cliente, 'Karelys R')
    const fut = await api('/pagos?desde=2099-01-01')
    assert.equal(fut.body.data[0].vencido, false)

    const bad = [
      { fecha: '2026-10-01', monto: 0, concepto: 'a' },
      { fecha: '2026-10-01', monto: 1.234, concepto: 'a' },
      { fecha: '2026-10-01', monto: 5, concepto: 'a', estado: 'cobrado', repetir_meses: 3 },
      { fecha: '2026-10-01', monto: 5, concepto: 'a', estado: 'pagado' },
    ]
    for (const b of bad) assert.equal((await api(`/clientes/${karelys}/pagos`, { body: b })).status, 400, JSON.stringify(b))
    assert.equal((await api(`/clientes/${NOPE}/pagos`, { body: { fecha: '2026-10-01', monto: 5, concepto: 'a' } })).status, 404)
  })

  it('el pago "Futuro" de prueba se corrige: mover a otra fecha con PATCH /pagos/:id', async () => {
    const lst = await api('/pagos?desde=2099-01-01')
    const id = lst.body.data[0].id
    const r = await api(`/pagos/${id}`, { method: 'PATCH', body: { fecha: '2099-02-02', monto: 7.5, concepto: 'Futuro 2' } })
    assert.equal(r.status, 200)
    const m = r.body.movimientos.find((x: any) => x.id === id)
    assert.deepEqual([m.fecha, m.monto, m.concepto], ['2099-02-02', 7.5, 'Futuro 2'])
    // se deja el estado como estaba para las cuentas de finanzas: se vuelve a poner en 0 pendientes de 2099
    await admin.query('DELETE FROM payments WHERE id = $1', [id])
  })

  it('PATCH /pagos/:id estado=cobrado mueve lo recaudado; la inicial no se edita; 400/404', async () => {
    const r = await api(`/pagos/${extraId}`, { method: 'PATCH', body: { estado: 'cobrado' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.recaudado, 230)
    assert.equal(r.body.por_cobrar, 70)
    assert.equal(r.body.pagos_completados, 2)
    assert.equal(r.body.pagos_por_cobrar, 4)
    const ini = await api(`/pagos/${inicialId}`, { method: 'PATCH', body: { monto: 1 } })
    assert.equal(ini.status, 400)
    assert.match(ini.body.error.message, /inicial/i)
    assert.equal((await api(`/pagos/${extraId}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/pagos/${NOPE}`, { method: 'PATCH', body: { estado: 'cobrado' } })).status, 404)
  })
})

describe('proyectos', () => {
  it('POST /proyectos: por defecto icono box, estado visita y responsable = dueño de la llave', async () => {
    const r = await api('/proyectos', { body: { nombre: 'Sistema Karelys', cliente_id: karelys } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(
      { ...r.body, id: '<id>' },
      {
        id: '<id>',
        nombre: 'Sistema Karelys',
        descripcion: null,
        icono: 'box',
        cliente: 'Karelys R',
        cliente_id: karelys,
        responsable: 'Leandro',
        estado: 'visita',
        entrega: null,
        archivado: false,
        cliente_archivado: false,
        es_interno: false,
        tareas: { total: 0, completadas: 0 },
        hitos: { total: 0, hechos: 0 },
        checklist: { total: 0, hechas: 0 },
      },
    )
    p1 = r.body.id
    const full = await api('/proyectos', {
      body: { nombre: 'Web Posible', cliente_id: posible, icono: 'code', responsable: 'elis', estado: 'activo', entrega: '2026-12-01' },
    })
    assert.equal(full.status, 201)
    assert.equal(full.body.responsable, 'Elis', 'el responsable se resuelve sin distinguir mayúsculas')
    assert.equal(full.body.estado, 'activo')
    p2 = full.body.id
  })

  it('validaciones: planeacion no es un estado v1, responsable/cliente inexistentes, icono inválido', async () => {
    assert.equal((await api('/proyectos', { body: { nombre: 'a', cliente_id: karelys, estado: 'planeacion' } })).status, 400)
    assert.equal((await api('/proyectos', { body: { nombre: 'a', cliente_id: karelys, icono: 'rocket' } })).status, 400)
    const ellis = await api('/proyectos', { body: { nombre: 'a', cliente_id: karelys, responsable: 'Ellis' } })
    assert.equal(ellis.status, 404)
    assert.match(ellis.body.error.message, /Responsable/)
    assert.equal((await api('/proyectos', { body: { nombre: 'a', cliente_id: NOPE } })).status, 404)
    assert.equal((await api('/proyectos', { body: { cliente_id: karelys } })).status, 400, 'el nombre es obligatorio')
  })

  it('PATCH: cambia estado, borra la fecha con null; lista filtra por estado y trae por_estado', async () => {
    const e = await api(`/proyectos/${p1}`, { method: 'PATCH', body: { estado: 'entrega' } })
    assert.equal(e.body.estado, 'entrega')
    const d = await api(`/proyectos/${p2}`, { method: 'PATCH', body: { entrega: null } })
    assert.equal(d.body.entrega, null)
    assert.equal((await api(`/proyectos/${p2}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/proyectos/${NOPE}`, { method: 'PATCH', body: { estado: 'activo' } })).status, 404)

    const lst = await api('/proyectos?estado=entrega')
    assert.deepEqual(lst.body.data.map((p: any) => p.nombre), ['Sistema Karelys'])
    assert.deepEqual(lst.body.meta.por_estado, { activo: 1, entrega: 1, visita: 0, pausado: 0, completado: 0 })
    assert.equal((await api('/proyectos?estado=visita')).body.meta.total, 0)
    assert.equal((await api(`/proyectos?cliente_id=${posible}`)).body.data.length, 1)
    const det = await api(`/proyectos/${p1}`)
    assert.deepEqual(det.body.lista_tareas, [])
  })
})

describe('tareas', () => {
  it('POST /tareas: exige proyecto_id; se atribuye a la llave; lista pendientes primero con vence', async () => {
    assert.equal((await api('/tareas', { body: { titulo: 'Sin proyecto' } })).status, 400)
    assert.equal((await api('/tareas', { body: { titulo: 'x', proyecto_id: NOPE } })).status, 404)
    const a = await api('/tareas', { body: { titulo: 'Diseñar logo', proyecto_id: p1 } })
    const b = await api('/tareas', { body: { titulo: 'Reunión', proyecto_id: p1, vence: '2026-10-20' } })
    assert.equal(a.status, 201)
    assert.deepEqual(
      { ...b.body, id: '<id>', responsable: { ...b.body.responsable, id: '<id>' } },
      { id: '<id>', titulo: 'Reunión', proyecto_id: p1, proyecto: 'Sistema Karelys', hito_id: null, hito: null, estado: 'pendiente', vence: '2026-10-20', creada_por: 'Leandro', es_interno: false, responsable: { id: '<id>', nombre: 'Leandro' }, asignada: false },
    )
    t1 = a.body.id
    t2 = b.body.id
    const lst = await api('/tareas?estado=pendiente')
    assert.deepEqual(lst.body.data.map((t: any) => t.titulo), ['Reunión', 'Diseñar logo'], 'con fecha primero')
    assert.equal(lst.body.meta.pendientes, 2)
    assert.equal(lst.body.meta.completadas, 0)
  })

  it('PATCH: completar y reabrir (done_at coherente), cambiar título, borrar fecha; 400/404', async () => {
    const c = await api(`/tareas/${t1}`, { method: 'PATCH', body: { estado: 'completada' } })
    assert.equal(c.body.estado, 'completada')
    assert.ok((await admin.query('SELECT done_at FROM tasks WHERE id = $1', [t1])).rows[0].done_at)
    const pr = await api(`/proyectos/${p1}`)
    assert.deepEqual(pr.body.tareas, { total: 2, completadas: 1 })
    assert.equal((await api('/tareas?estado=completada')).body.data.length, 1)

    const re = await api(`/tareas/${t1}`, { method: 'PATCH', body: { estado: 'pendiente' } })
    assert.equal(re.body.estado, 'pendiente')
    assert.equal((await admin.query('SELECT done_at FROM tasks WHERE id = $1', [t1])).rows[0].done_at, null)

    const t = await api(`/tareas/${t2}`, { method: 'PATCH', body: { titulo: 'Reunión de arranque', vence: null } })
    assert.deepEqual([t.body.titulo, t.body.vence], ['Reunión de arranque', null])
    assert.equal((await api(`/tareas/${t2}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/tareas/${NOPE}`, { method: 'PATCH', body: { estado: 'completada' } })).status, 404)
    assert.equal((await api(`/tareas/${NOPE}`)).status, 404)
    assert.equal((await api('/tareas?estado=por_hacer')).status, 400)
  })
})

describe('gastos', () => {
  it('POST /gastos: general, de cliente y de proyecto; fecha por defecto hoy; atribuido a la llave', async () => {
    const a = await api('/gastos', { body: { concepto: 'Lovable', monto: 25, categoria: 'Herramientas', fecha: '2026-10-01' } })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.deepEqual({ ...a.body, id: '<id>' }, {
      id: '<id>', fecha: '2026-10-01', concepto: 'Lovable', monto: 25, categoria: 'Herramientas', ambito: 'general', referencia: null, registrado_por: 'Leandro', es_interno: true,
    })
    e1 = a.body.id
    const b = await api('/gastos', { body: { concepto: 'Anuncio', monto: 10, categoria: 'Marketing', fecha: '2026-10-02', ambito: 'cliente', referencia_id: karelys } })
    assert.deepEqual(b.body.referencia, { id: karelys, nombre: 'Karelys R' })
    e2 = b.body.id
    const c = await api('/gastos', { body: { concepto: 'Plugin', monto: 5.5, categoria: 'Otros', fecha: '2026-09-15', ambito: 'proyecto', referencia_id: p1 } })
    assert.deepEqual(c.body.referencia, { id: p1, nombre: 'Sistema Karelys' })
    e3 = c.body.id
    const d = await api('/gastos', { body: { concepto: 'Café', monto: 3.5, categoria: 'Otros' } })
    assert.match(d.body.fecha, /^\d{4}-\d{2}-\d{2}$/)
    e4 = d.body.id
    // se fija una fecha conocida para que las cuentas de finanzas no dependan del día en que corra la prueba
    const f = await api(`/gastos/${e4}`, { method: 'PATCH', body: { fecha: '2026-08-10' } })
    assert.equal(f.body.fecha, '2026-08-10')
  })

  it('validaciones: categoría, ámbito/referencia, referencia inexistente', async () => {
    const base = { concepto: 'x', monto: 1, categoria: 'Otros' }
    assert.equal((await api('/gastos', { body: { ...base, categoria: 'Comida' } })).status, 400)
    const g = await api('/gastos', { body: { ...base, referencia_id: karelys } })
    assert.equal(g.status, 400)
    assert.match(g.body.error.message, /general/)
    assert.equal((await api('/gastos', { body: { ...base, ambito: 'cliente' } })).status, 400)
    assert.equal((await api('/gastos', { body: { ...base, ambito: 'cliente', referencia_id: NOPE } })).status, 404)
    assert.equal((await api('/gastos', { body: { ...base, ambito: 'proyecto', referencia_id: NOPE } })).status, 404)
    assert.equal((await api('/gastos', { body: { ...base, monto: -1 } })).status, 400)
  })

  it('GET /gastos: filtros y total_monto de TODO el filtro; orden por fecha descendente; detalle y 404', async () => {
    const oct = await api('/gastos?desde=2026-10-01&hasta=2026-10-31')
    assert.deepEqual(oct.body.data.map((g: any) => g.concepto), ['Anuncio', 'Lovable'])
    assert.equal(oct.body.meta.total_monto, 35)
    const pag = await api('/gastos?desde=2026-10-01&hasta=2026-10-31&per_page=1')
    assert.equal(pag.body.data.length, 1)
    assert.equal(pag.body.meta.total, 2)
    assert.equal(pag.body.meta.total_monto, 35, 'la suma no depende de la página')
    assert.equal((await api('/gastos?categoria=Herramientas')).body.meta.total_monto, 25)
    assert.equal((await api('/gastos?ambito=proyecto')).body.data.length, 1)
    assert.equal((await api(`/gastos/${e1}`)).body.concepto, 'Lovable')
    assert.equal((await api(`/gastos/${NOPE}`)).status, 404)
  })

  it('PATCH /gastos/:id: cambiar ámbito exige/limpia la referencia; monto y categoría', async () => {
    const gen = await api(`/gastos/${e2}`, { method: 'PATCH', body: { ambito: 'general' } })
    assert.equal(gen.body.referencia, null)
    const row = (await admin.query('SELECT client_id, project_id FROM expenses WHERE id = $1', [e2])).rows[0]
    assert.deepEqual(row, { client_id: null, project_id: null })
    assert.equal((await api(`/gastos/${e2}`, { method: 'PATCH', body: { ambito: 'cliente' } })).status, 400, 'sin referencia no vale')
    const back = await api(`/gastos/${e2}`, { method: 'PATCH', body: { ambito: 'cliente', referencia_id: karelys, monto: 10, categoria: 'Marketing' } })
    assert.deepEqual(back.body.referencia, { id: karelys, nombre: 'Karelys R' })
    assert.equal((await api(`/gastos/${e1}`, { method: 'PATCH', body: { referencia_id: karelys } })).status, 400, 'un gasto general no lleva referencia')
    assert.equal((await api(`/gastos/${e3}`, { method: 'PATCH', body: { referencia_id: null } })).status, 400, 'un gasto de proyecto necesita su proyecto')
    assert.equal((await api(`/gastos/${e1}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/gastos/${NOPE}`, { method: 'PATCH', body: { monto: 1 } })).status, 404)
  })
})

describe('finanzas', () => {
  // Fixture que refleja lo creado arriba (la inicial y las cuotas de Karelys; los 4 gastos).
  const pays = [
    { d: '2026-09-01', a: 200, s: 'cobrado' },
    { d: '2026-09-20', a: 30, s: 'cobrado' },
    { d: '2000-01-01', a: 10, s: 'pendiente' },
    { d: '2026-10-15', a: 20, s: 'pendiente' },
    { d: '2026-11-15', a: 20, s: 'pendiente' },
    { d: '2026-12-15', a: 20, s: 'pendiente' },
  ]
  const exps = [
    { d: '2026-10-01', a: 25, general: true },
    { d: '2026-10-02', a: 10, general: false },
    { d: '2026-09-15', a: 5.5, general: false },
    { d: '2026-08-10', a: 3.5, general: true },
  ]
  const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100

  it('periodo=todo: números exactos, tabla por cliente por id, gastos generales aparte', async () => {
    const r = await api('/finanzas/resumen?periodo=todo')
    assert.equal(r.status, 200)
    const b = r.body
    assert.equal(b.periodo, 'todo')
    assert.equal(b.ingresos, 230)
    assert.equal(b.gastos, 44)
    assert.equal(b.balance, 186)
    assert.equal(b.por_cobrar, 70)
    assert.equal(b.por_cobrar_total, 70)
    assert.equal(b.gastos_generales, 28.5)
    // vencido = pendiente con fecha anterior a hoy; sigue contando dentro de por_cobrar (nunca se resta ni se duplica)
    const vencido = sum(pays.filter((p) => p.s === 'pendiente' && p.d < b.hoy).map((p) => p.a))
    assert.ok(vencido >= 10 && vencido <= 70)
    assert.equal(b.vencido, vencido)
    assert.equal(b.vencido_total, vencido)
    assert.deepEqual(b.clientes[0], { id: karelys, nombre: 'Karelys R', recaudado: 230, gastos: 15.5, por_cobrar: 70, vencido, utilidad: 214.5 })
    assert.deepEqual(b.clientes[1], { id: posible, nombre: 'Posible SA', recaudado: 0, gastos: 0, por_cobrar: 0, vencido: 0, utilidad: 0 })
  })

  for (const periodo of ['mes', 'anio'] as const) {
    it(`periodo=${periodo}: coincide con filtrar por el prefijo de "hoy" (hora de Caracas) que devuelve la API`, async () => {
      const r = await api(`/finanzas/resumen?periodo=${periodo}`)
      assert.equal(r.status, 200)
      const hoy: string = r.body.hoy
      assert.match(hoy, /^\d{4}-\d{2}-\d{2}$/)
      const pre = periodo === 'mes' ? hoy.slice(0, 7) : hoy.slice(0, 4)
      const inP = (d: string) => d.startsWith(pre)
      const ingresos = sum(pays.filter((p) => p.s === 'cobrado' && inP(p.d)).map((p) => p.a))
      const gastos = sum(exps.filter((e) => inP(e.d)).map((e) => e.a))
      assert.equal(r.body.ingresos, ingresos)
      assert.equal(r.body.gastos, gastos)
      assert.equal(r.body.balance, sum([ingresos, -gastos]))
      assert.equal(r.body.por_cobrar, sum(pays.filter((p) => p.s === 'pendiente' && inP(p.d)).map((p) => p.a)))
      assert.equal(r.body.gastos_generales, sum(exps.filter((e) => e.general && inP(e.d)).map((e) => e.a)))
    })
  }

  it('serie de 6 meses terminando en el actual; periodo por defecto = mes; periodo inválido => 400', async () => {
    const r = await api('/finanzas/resumen')
    assert.equal(r.body.periodo, 'mes')
    assert.equal(r.body.serie.length, 6)
    assert.equal(r.body.serie[5].mes, r.body.hoy.slice(0, 7))
    const meses: string[] = r.body.serie.map((s: any) => s.mes)
    assert.deepEqual([...meses].sort(), meses, 'en orden cronológico')
    assert.equal(new Set(meses).size, 6)
    for (const s of r.body.serie) {
      assert.equal(s.ingresos, sum(pays.filter((p) => p.s === 'cobrado' && p.d.startsWith(s.mes)).map((p) => p.a)), s.mes)
      assert.equal(s.gastos, sum(exps.filter((e) => e.d.startsWith(s.mes)).map((e) => e.a)), s.mes)
    }
    assert.equal((await api('/finanzas/resumen?periodo=siempre')).status, 400)
  })

  it('gastos de dos clientes con el mismo nombre no se mezclan (se cruza por id, no por nombre)', async () => {
    const dup = await api('/clientes', { body: { nombre: 'Karelys R' } })
    const g = await api('/gastos', { body: { concepto: 'Solo del duplicado', monto: 100, categoria: 'Otros', fecha: '2026-08-11', ambito: 'cliente', referencia_id: dup.body.id } })
    assert.equal(g.status, 201)
    const r = await api('/finanzas/resumen?periodo=todo')
    assert.equal(r.body.clientes.find((c: any) => c.id === karelys).gastos, 15.5)
    assert.equal(r.body.clientes.find((c: any) => c.id === dup.body.id).gastos, 100)
    await admin.query('DELETE FROM expenses WHERE id = $1', [g.body.id])
    await admin.query('DELETE FROM clients WHERE id = $1', [dup.body.id])
  })
})

describe('MCP', () => {
  let n = 0
  const rpc = (method: string, params: unknown = {}, key: string | null = KEY) =>
    http(`${ROOT}/mcp`, {
      key,
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: ++n, method, params },
    })
  const tool = async (name: string, args: unknown = {}, key: string | null = KEY) => {
    const r = await rpc('tools/call', { name, arguments: args }, key)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body
  }
  const data = (b: any) => JSON.parse(b.result.content[0].text)

  it('exige llave; GET/DELETE no aplican (sin estado)', async () => {
    const r = await rpc('tools/list', {}, null)
    assert.equal(r.status, 401)
    assert.equal(r.body.error.code, 'unauthorized')
    const g = await http(`${ROOT}/mcp`, { key: KEY })
    assert.equal(g.status, 405)
    assert.equal(g.headers.get('allow'), 'POST')
  })

  it('tools/list: las herramientas del SPEC + pagos + papelera, con esquema; sin permiso de borrado no se ven las de borrar', async () => {
    const r = await rpc('tools/list')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const names: string[] = r.body.result.tools.map((t: any) => t.name)
    const spec = [
      'hayai_clientes_listar', 'hayai_cliente_ver', 'hayai_cliente_crear', 'hayai_cliente_actualizar',
      'hayai_proyectos_listar', 'hayai_proyecto_ver', 'hayai_proyecto_crear', 'hayai_proyecto_estado',
      'hayai_gastos_listar', 'hayai_gasto_registrar', 'hayai_finanzas_resumen',
      'hayai_tareas_listar', 'hayai_tarea_crear', 'hayai_tarea_completar',
    ]
    for (const s of spec) assert.ok(names.includes(s), s)
    for (const s of ['hayai_pagos_listar', 'hayai_pago_registrar', 'hayai_pago_marcar_cobrado']) assert.ok(names.includes(s), s)
    for (const s of ['hayai_proyecto_actualizar', 'hayai_papelera_listar', 'hayai_papelera_restaurar']) assert.ok(names.includes(s), s)
    for (const s of ['hayai_interacciones_listar', 'hayai_interaccion_registrar', 'hayai_interaccion_actualizar', 'hayai_pipeline_resumen', 'hayai_notificaciones_listar', 'hayai_notificaciones_marcar_leidas', 'hayai_buscar', 'hayai_actividad_listar', 'hayai_actividad_marcar_leida'])
      assert.ok(names.includes(s), s)
    assert.equal(names.length, 97) // lectura + escritura
    assert.ok(!names.some((x) => /eliminar/.test(x)), 'la llave sin borrado no ve herramientas de borrar')
    const full = (await rpc('tools/list', {}, KEY_D)).body.result.tools
    assert.equal(full.length, 108)
    assert.equal(full.filter((t: any) => /eliminar|desactivar/.test(t.name) && t.annotations.destructiveHint === true).length, 10)
    const crear = r.body.result.tools.find((t: any) => t.name === 'hayai_tarea_crear')
    assert.deepEqual([...crear.inputSchema.required].sort(), ['proyecto_id', 'titulo'])
    assert.equal(r.body.result.tools.find((t: any) => t.name === 'hayai_finanzas_resumen').annotations.readOnlyHint, true)
    assert.equal(crear.annotations.readOnlyHint, false)
  })

  it('hayai_finanzas_resumen devuelve lo mismo que REST', async () => {
    const m = data(await tool('hayai_finanzas_resumen', { periodo: 'todo' }))
    const rest = (await api('/finanzas/resumen?periodo=todo')).body
    assert.deepEqual(m, rest)
  })

  it('las escrituras se atribuyen a la llave que llama (Jorbi), no a otra', async () => {
    const t = data(await tool('hayai_tarea_crear', { titulo: 'Desde MCP', proyecto_id: p1, vence: '2026-11-01' }, KEY_J))
    assert.equal(t.creada_por, 'Jorbi')
    assert.equal(t.proyecto_id, p1)
    const done = data(await tool('hayai_tarea_completar', { id: t.id }, KEY_J))
    assert.equal(done.estado, 'completada')
    const g = data(await tool('hayai_gasto_registrar', { concepto: 'MCP', monto: 1, categoria: 'Otros', fecha: '2026-10-03' }, KEY_J))
    assert.equal(g.registrado_por, 'Jorbi')
    await admin.query('DELETE FROM expenses WHERE id = $1', [g.id])
  })

  it('errores de negocio vuelven como resultado de la herramienta (isError) para que el agente los lea', async () => {
    const nf = await tool('hayai_tarea_completar', { id: NOPE })
    assert.equal(nf.result.isError, true)
    assert.match(nf.result.content[0].text, /Tarea no encontrada/)
    const bad = await tool('hayai_gasto_registrar', { concepto: 'x', monto: 1, categoria: 'Comida' })
    assert.ok(bad.error || bad.result?.isError, 'categoría inválida se rechaza')
    const ref = await tool('hayai_gasto_registrar', { concepto: 'x', monto: 1, categoria: 'Otros', ambito: 'cliente' })
    assert.equal(ref.result.isError, true)
    assert.match(ref.result.content[0].text, /referencia_id/)
    const sinProyecto = await tool('hayai_tarea_crear', { titulo: 'x' })
    assert.ok(sinProyecto.error || sinProyecto.result?.isError, 'proyecto_id es obligatorio')
  })

  it('pagos por MCP: marcar cobrado el pendiente atrasado mueve lo recaudado', async () => {
    const before = data(await tool('hayai_cliente_ver', { id: karelys }))
    assert.equal(before.recaudado, 230)
    const after = data(await tool('hayai_pago_marcar_cobrado', { id: atrasadoId }))
    assert.equal(after.recaudado, 240)
    assert.equal(after.por_cobrar, 60)
    const pend = data(await tool('hayai_pagos_listar', { estado: 'pendiente', cliente_id: karelys }))
    assert.equal(pend.meta.total, 3)
    assert.equal(pend.meta.total_monto, 60)
    const lst = data(await tool('hayai_clientes_listar', { estado: 'activo' }))
    assert.deepEqual(lst.data.map((c: any) => c.nombre), ['Karelys R'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Permisos por llave, papelera, archivo y gestión de llaves desde la web.
// ---------------------------------------------------------------------------------------------------------------

describe('permisos por llave', () => {
  it('/me lista los permisos; la CLI valida la lista; la BD también', async () => {
    const me = await api('/me')
    assert.deepEqual(me.body.llave.permisos.map((x: any) => x.permiso), ['read', 'write'])
    assert.equal(cli('create', '--user', 'Leandro', '--name', 'x', '--scopes', 'read,tirar').status, 1)
    await assert.rejects(
      admin.query("UPDATE api_keys SET scopes = ARRAY['admin'] WHERE name = 'growi'"),
      /api_keys_scopes_ck/,
    )
    await assert.rejects(admin.query("UPDATE api_keys SET scopes = '{}' WHERE name = 'growi'"), /api_keys_scopes_ck/)
  })

  it('sin permiso de borrado, DELETE => 403 forbidden y no borra nada', async () => {
    const r = await api(`/tareas/${t1}`, { method: 'DELETE' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error.code, 'forbidden')
    assert.equal(r.body.error.required_scope, 'delete')
    assert.equal((await api(`/tareas/${t1}`)).status, 200)
  })

  it('llave de solo lectura: GET sí, POST/PATCH/DELETE => 403', async () => {
    const ro = newKey('Elis', 'solo-lectura', 'read')
    assert.equal((await api('/clientes', { key: ro })).status, 200)
    const post = await api('/gastos', { key: ro, body: { concepto: 'x', monto: 1, categoria: 'Otros' } })
    assert.equal(post.status, 403)
    assert.equal(post.body.error.required_scope, 'write')
    assert.equal((await api(`/tareas/${t1}`, { key: ro, method: 'PATCH', body: { estado: 'completada' } })).status, 403)
    assert.equal((await api(`/tareas/${t1}`, { key: ro, method: 'DELETE' })).status, 403)
  })

  it('MCP: una herramienta que la llave no puede usar no existe para ella', async () => {
    const r = await http(`${ROOT}/mcp`, {
      key: KEY,
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hayai_cliente_eliminar', arguments: { id: karelys } } },
    })
    assert.ok(r.body.error || r.body.result?.isError, JSON.stringify(r.body))
    assert.equal((await api(`/clientes/${karelys}`)).status, 200, 'el cliente sigue ahí')
  })
})

describe('papelera y borrado', () => {
  const resumenFinanzas = async () => (await api('/finanzas/resumen?periodo=todo')).body
  let c = ''
  let pa = ''
  let ta = ''
  let ga = ''
  let pagoId = ''
  let before: any

  it('prepara un cliente con inicial, cobros, dos proyectos, tareas y gastos', async () => {
    const cl = await apiD('/clientes', {
      body: {
        nombre: 'Borrable SA',
        items: [{ concepto: 'Web', monto: 100 }],
        fecha_inicial: '2026-09-15',
        cobros: [{ fecha: '2026-12-01', monto: 50, concepto: 'Cuota' }],
      },
    })
    assert.equal(cl.status, 201, JSON.stringify(cl.body))
    c = cl.body.id
    pagoId = cl.body.movimientos.find((m: any) => m.tipo === 'pago').id
    pa = (await apiD('/proyectos', { body: { nombre: 'Proyecto A', cliente_id: c } })).body.id
    await apiD('/proyectos', { body: { nombre: 'Proyecto B', cliente_id: c } })
    ta = (await apiD('/tareas', { body: { titulo: 'Tarea de A', proyecto_id: pa } })).body.id
    ga = (await apiD('/gastos', { body: { concepto: 'Hosting A', monto: 10, categoria: 'Infraestructura', ambito: 'proyecto', referencia_id: pa, fecha: '2026-09-20' } })).body.id
    await apiD('/gastos', { body: { concepto: 'Dominio cliente', monto: 5, categoria: 'Otros', ambito: 'cliente', referencia_id: c, fecha: '2026-09-21' } })
    before = await resumenFinanzas()
    assert.ok(before.clientes.some((x: any) => x.id === c))
  })

  it('borrar un proyecto lo manda a la papelera con sus tareas y gastos', async () => {
    const r = await apiD(`/proyectos/${pa}`, { method: 'DELETE' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.entidad, 'proyecto')
    assert.match(r.body.resumen, /1 tarea, 1 gasto/)
    assert.ok(r.body.restaurable_hasta)
    assert.equal((await apiD(`/proyectos/${pa}`)).status, 404)
    assert.equal((await apiD(`/tareas/${ta}`)).status, 404)
    assert.equal((await apiD(`/gastos/${ga}`)).status, 404)
    const t = await apiD('/papelera')
    const item = t.body.data.find((x: any) => x.nombre === 'Proyecto A')
    assert.equal(item.origen, 'api:limpieza')
    assert.equal(item.eliminado_por, 'Leandro')
    pa = item.id // a partir de aquí pa es el id de papelera
  })

  it('borrar el cliente se lleva todo lo suyo; restaurar el proyecto antes que el cliente => 409', async () => {
    const r = await apiD(`/clientes/${c}`, { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.match(r.body.resumen, /2 cobros, 1 proyecto, 0 tareas, 1 gasto/)
    assert.equal((await apiD(`/clientes/${c}`)).status, 404)
    const { rows } = await admin.query('SELECT (SELECT count(*) FROM payments WHERE client_id = $1)::int AS p, (SELECT count(*) FROM projects WHERE client_id = $1)::int AS j', [c])
    assert.deepEqual(rows[0], { p: 0, j: 0 })
    const bad = await apiD(`/papelera/${pa}/restaurar`, { method: 'POST', body: {} })
    assert.equal(bad.status, 409)
    assert.match(bad.body.error.message, /cliente/)
  })

  it('restaurar el cliente y luego el proyecto deja las finanzas exactamente como estaban', async () => {
    const list = (await apiD('/papelera')).body.data
    const cli = list.find((x: any) => x.nombre === 'Borrable SA')
    const rc = await apiD(`/papelera/${cli.id}/restaurar`, { method: 'POST', body: {} })
    assert.equal(rc.status, 200, JSON.stringify(rc.body))
    assert.equal(rc.body.id, c, 'conserva el mismo id')
    const det = (await apiD(`/clientes/${c}`)).body
    assert.equal(det.n_items, 1)
    assert.equal(det.movimientos.length, 2)
    assert.equal(det.proyectos.length, 1)
    const rp = await apiD(`/papelera/${pa}/restaurar`, { method: 'POST', body: {} })
    assert.equal(rp.status, 200, JSON.stringify(rp.body))
    assert.equal((await apiD(`/tareas/${ta}`)).body.titulo, 'Tarea de A')
    assert.equal((await apiD(`/gastos/${ga}`)).body.concepto, 'Hosting A')
    assert.deepEqual(await resumenFinanzas(), before)
    assert.equal((await apiD(`/papelera/${cli.id}/restaurar`, { method: 'POST', body: {} })).status, 404, 'ya no está en la papelera')
  })

  it('cobros: la inicial no se borra; un cobro normal va a la papelera y vuelve', async () => {
    const inicial = (await apiD(`/clientes/${c}`)).body.movimientos.find((m: any) => m.tipo === 'inicial')
    assert.equal((await apiD(`/pagos/${inicial.id}`, { method: 'DELETE' })).status, 400)
    const d = await apiD(`/pagos/${pagoId}`, { method: 'DELETE' })
    assert.equal(d.status, 200)
    assert.match(d.body.nombre, /Cuota/)
    assert.equal((await apiD(`/clientes/${c}`)).body.movimientos.length, 1)
    const back = await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })
    assert.equal(back.status, 200)
    assert.equal((await apiD(`/clientes/${c}`)).body.movimientos.length, 2)
  })

  it('gastos y tareas sueltos: borrar y restaurar; un id que no existe => 404', async () => {
    const g = await apiD(`/gastos/${ga}`, { method: 'DELETE' })
    const t = await apiD(`/tareas/${ta}`, { method: 'DELETE' })
    assert.equal(g.status, 200)
    assert.equal(t.status, 200)
    assert.equal((await apiD(`/gastos/${ga}`, { method: 'DELETE' })).status, 404)
    // el gasto cuelga de un proyecto que sigue vivo, así que se restaura solo
    assert.equal((await apiD(`/papelera/${g.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await apiD(`/papelera/${t.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(await resumenFinanzas(), before)
  })

  it('restaurar exige escritura (una llave solo lectura no puede) y la papelera se lista con lectura', async () => {
    const d = await apiD(`/tareas/${ta}`, { method: 'DELETE' })
    const ro = newKey('Elis', 'lector', 'read')
    assert.equal((await api('/papelera', { key: ro })).status, 200)
    assert.equal((await api(`/papelera/${d.body.papelera_id}/restaurar`, { key: ro, method: 'POST', body: {} })).status, 403)
    assert.equal((await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 200)
  })

  it('lo que pasa de 30 días se limpia solo', async () => {
    const d = await apiD(`/tareas/${ta}`, { method: 'DELETE' })
    await admin.query("UPDATE trash SET deleted_at = now() - interval '31 days' WHERE id = $1", [d.body.papelera_id])
    const list = (await apiD('/papelera')).body.data
    assert.ok(!list.some((x: any) => x.id === d.body.papelera_id))
    assert.equal((await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 404)
  })
})

describe('archivo', () => {
  let c = ''
  let proj = ''
  let tarea = ''

  it('archivar un cliente lo oculta de listas, proyectos y tareas, pero Finanzas conserva su historial', async () => {
    const cl = await api('/clientes', { body: { nombre: 'Para archivar', items: [{ concepto: 'Web', monto: 40 }], fecha_inicial: '2026-10-01' } })
    c = cl.body.id
    proj = (await api('/proyectos', { body: { nombre: 'Proyecto archivable', cliente_id: c } })).body.id
    tarea = (await api('/tareas', { body: { titulo: 'Tarea archivable', proyecto_id: proj } })).body.id
    const antes = (await api('/finanzas/resumen?periodo=todo')).body
    const activosAntes = (await api('/clientes')).body.meta.resumen.activos

    const a = await api(`/clientes/${c}`, { method: 'PATCH', body: { archivado: true } })
    assert.equal(a.status, 200)
    assert.equal(a.body.archivado, true)

    const lst = (await api('/clientes')).body
    assert.ok(!lst.data.some((x: any) => x.id === c))
    assert.equal(lst.meta.resumen.activos, activosAntes - 1)
    assert.equal(lst.meta.resumen.archivados, 1)
    assert.ok((await api('/clientes?archivados=solo')).body.data.some((x: any) => x.id === c))
    assert.ok((await api('/clientes?archivados=incluir')).body.data.some((x: any) => x.id === c))
    assert.ok(!(await api('/proyectos')).body.data.some((x: any) => x.id === proj), 'el proyecto de un cliente archivado se oculta')
    assert.ok((await api('/proyectos?archivados=solo')).body.data.some((x: any) => x.id === proj))
    assert.ok(!(await api('/tareas')).body.data.some((x: any) => x.id === tarea))
    assert.equal((await api(`/clientes/${c}`)).status, 200, 'por id sigue accesible')
    assert.deepEqual((await api('/finanzas/resumen?periodo=todo')).body, antes, 'archivar no cambia los números')
  })

  it('desarchivar lo devuelve; archivar un proyecto es independiente del cliente', async () => {
    const u = await api(`/clientes/${c}`, { method: 'PATCH', body: { archivado: false } })
    assert.equal(u.body.archivado, false)
    assert.ok((await api('/proyectos')).body.data.some((x: any) => x.id === proj))
    const p = await api(`/proyectos/${proj}`, { method: 'PATCH', body: { archivado: true } })
    assert.equal(p.body.archivado, true)
    assert.equal(p.body.cliente_archivado, false)
    assert.ok((await api('/clientes')).body.data.some((x: any) => x.id === c), 'el cliente sigue visible')
    assert.ok(!(await api('/proyectos')).body.data.some((x: any) => x.id === proj))
    assert.ok(!(await api('/tareas')).body.data.some((x: any) => x.id === tarea))
    assert.ok((await api('/tareas?archivados=incluir')).body.data.some((x: any) => x.id === tarea))
    await api(`/proyectos/${proj}`, { method: 'PATCH', body: { archivado: false } })
    assert.ok((await api('/tareas')).body.data.some((x: any) => x.id === tarea))
  })

  it('archivados inválido => 400; PATCH vacío sigue rechazándose', async () => {
    assert.equal((await api('/clientes?archivados=quizas')).status, 400)
    assert.equal((await api(`/clientes/${c}`, { method: 'PATCH', body: {} })).status, 400)
  })
})

describe('llaves y papelera desde la web', () => {
  const NEW_PIN = '482913'
  let cookie = ''
  const web = (path: string, o: { method?: string; body?: unknown } = {}) =>
    http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })

  before(async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jorbi', pin: '000000' }),
    })
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    assert.equal((await web('/auth/change-pin', { body: { currentPin: '000000', newPin: NEW_PIN } })).status, 200)
  })

  it('exige sesión', async () => {
    assert.equal((await http(`${ROOT}/api/keys`)).status, 401)
    assert.equal((await http(`${ROOT}/api/trash`)).status, 401)
  })

  it('crear una llave: pide el PIN, valida permisos, muestra la llave una sola vez y funciona en v1', async () => {
    assert.equal((await web('/keys', { body: { name: 'mi-agente', scopes: ['read'], pin: '111111' } })).status, 403)
    assert.equal((await web('/keys', { body: { name: 'mi-agente', scopes: [], pin: NEW_PIN } })).status, 400)
    assert.equal((await web('/keys', { body: { name: 'mi-agente', scopes: ['root'], pin: NEW_PIN } })).status, 400)
    assert.equal((await web('/keys', { body: { name: '  ', scopes: ['read'], pin: NEW_PIN } })).status, 400)

    const r = await web('/keys', { body: { name: 'mi-agente', scopes: ['read', 'delete', 'read'], pin: NEW_PIN } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.match(r.body.key, /^hy_/)
    assert.deepEqual(r.body.scopes, ['read', 'delete'])
    const me = await api('/me', { key: r.body.key })
    assert.equal(me.body.usuario.nombre, 'Jorbi')
    assert.deepEqual(me.body.llave.permisos.map((x: any) => x.permiso), ['read', 'delete'])

    const list = await web('/keys')
    const mine = list.body.find((k: any) => k.id === r.body.id)
    assert.equal(mine.name, 'mi-agente')
    assert.ok(!JSON.stringify(list.body).includes(r.body.key), 'el listado nunca devuelve la llave')
    assert.ok(!('key' in mine) && !('key_hash' in mine))
  })

  it('el listado es solo de las llaves del usuario en sesión; no se puede revocar la de otro', async () => {
    const list = await web('/keys')
    assert.ok(list.body.every((k: any) => k.name !== 'growi'), 'no aparecen las llaves de Leandro')
    const other = (await admin.query("SELECT id FROM api_keys WHERE name = 'growi'")).rows[0].id
    assert.equal((await web(`/keys/${other}`, { method: 'DELETE' })).status, 404)
    assert.equal((await api('/me')).status, 200, 'la llave de Leandro sigue viva')
  })

  it('revocar: la llave deja de funcionar y desaparece del listado', async () => {
    const r = await web('/keys', { body: { name: 'temporal-web', scopes: ['read'], pin: NEW_PIN } })
    assert.equal((await api('/me', { key: r.body.key })).status, 200)
    assert.equal((await web(`/keys/${r.body.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await api('/me', { key: r.body.key })).status, 401)
    assert.ok(!(await web('/keys')).body.some((k: any) => k.id === r.body.id))
    assert.equal((await web(`/keys/${r.body.id}`, { method: 'DELETE' })).status, 404)
  })

  it('máximo 10 llaves activas por socio', async () => {
    let last = 0
    for (let i = 0; i < 12; i++) last = (await web('/keys', { body: { name: `k${i}`, scopes: ['read'], pin: NEW_PIN } })).status
    assert.equal(last, 409)
    const n = (await admin.query("SELECT count(*)::int AS n FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.name = 'Jorbi' AND k.revoked_at IS NULL")).rows[0].n
    assert.equal(n, 10)
    await admin.query("UPDATE api_keys SET revoked_at = now() WHERE name LIKE 'k%' AND name ~ '^k[0-9]+$'")
  })

  it('papelera en la web: borrar desde la web también es recuperable; borrado definitivo solo aquí', async () => {
    const g = await api('/gastos', { body: { concepto: 'Para la papelera', monto: 7, categoria: 'Otros', fecha: '2026-10-02' } })
    assert.equal((await web(`/expenses/${g.body.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await api(`/gastos/${g.body.id}`)).status, 404)
    const trash = await web('/trash')
    const item = trash.body.find((t: any) => t.label.startsWith('Para la papelera'))
    assert.equal(item.entity, 'gasto')
    assert.equal(item.via, 'web')
    assert.equal(item.deletedBy, 'Jorbi')
    assert.ok(new Date(item.expiresAt) > new Date(item.deletedAt))
    assert.equal((await web(`/trash/${item.id}/restore`, { body: {} })).status, 200)
    assert.equal((await api(`/gastos/${g.body.id}`)).status, 200)

    assert.equal((await web(`/expenses/${g.body.id}`, { method: 'DELETE' })).status, 204)
    const again = (await web('/trash')).body.find((t: any) => t.label.startsWith('Para la papelera'))
    assert.equal((await web(`/trash/${again.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await web(`/trash/${again.id}/restore`, { body: {} })).status, 404)
    assert.equal((await web(`/trash/${again.id}`, { method: 'DELETE' })).status, 404)
  })

  it('archivar desde la web: POST /clients/:id/archive y /unarchive', async () => {
    const cl = await api('/clientes', { body: { nombre: 'Archivo web' } })
    const a = await web(`/clients/${cl.body.id}/archive`, { body: {} })
    assert.equal(a.body.archived, true)
    assert.equal((await web('/clients')).body.find((x: any) => x.id === cl.body.id).archived, true, 'la web recibe la lista completa con la marca')
    assert.equal((await web(`/clients/${cl.body.id}/unarchive`, { body: {} })).body.archived, false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// CRM fase 1: ficha, pipeline, bitácora, alertas, búsqueda. Van al final: crean sus propios clientes y no tocan las cifras
// que verifican las suites de arriba.
// ---------------------------------------------------------------------------------------------------------------------
const sumOf = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100
const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const mkPosible = async (nombre: string, extra: Record<string, unknown> = {}) => {
  const r = await api('/clientes', { body: { nombre, estado: 'posible', ...extra } })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body as any
}

describe('CRM: ficha del cliente', () => {
  let id = ''

  it('POST /clientes con la ficha completa: se guarda y vuelve en el detalle (email en minúscula, etiquetas normalizadas)', async () => {
    const r = await api('/clientes', {
      body: {
        nombre: 'Panadería La Estrella',
        telefono: '0414-1234567',
        email: 'Dueno@LaEstrella.com',
        contacto_nombre: 'María Pérez',
        contacto_cargo: 'Dueña',
        direccion: 'Av. Lara, Barquisimeto',
        notas: 'Prefiere WhatsApp en la mañana',
        etiquetas: ['Panadería', ' VIP ', 'panadería', 'Zona  Este'],
        origen: 'meta_ads',
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    id = r.body.id
    const d = (await api(`/clientes/${id}`)).body
    assert.equal(d.telefono, '0414-1234567')
    assert.equal(d.email, 'dueno@laestrella.com')
    assert.equal(d.contacto_nombre, 'María Pérez')
    assert.equal(d.contacto_cargo, 'Dueña')
    assert.equal(d.direccion, 'Av. Lara, Barquisimeto')
    assert.equal(d.notas, 'Prefiere WhatsApp en la mañana')
    assert.deepEqual(d.etiquetas, ['panadería', 'vip', 'zona este'])
    assert.equal(d.origen, 'meta_ads')
    assert.equal(d.estado, 'activo')
    assert.equal(d.etapa, null, 'un cliente de entrada directa no tiene etapa de pipeline')
    assert.deepEqual(d.interacciones, { total: 0, recientes: [] })
  })

  it('PATCH parcial: lo no enviado no cambia; null borra; etiquetas [] las quita', async () => {
    const a = await api(`/clientes/${id}`, { method: 'PATCH', body: { telefono: '+58 414 000 1111', notas: null } })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.equal(a.body.telefono, '+58 414 000 1111')
    assert.equal(a.body.notas, null)
    assert.equal(a.body.email, 'dueno@laestrella.com')
    assert.equal(a.body.origen, 'meta_ads')
    const b = await api(`/clientes/${id}`, { method: 'PATCH', body: { etiquetas: [] } })
    assert.deepEqual(b.body.etiquetas, [])
    const c = await api(`/clientes/${id}`, { method: 'PATCH', body: { email: null, contacto_nombre: null, contacto_cargo: null, direccion: null, origen: null, telefono: null } })
    assert.equal(c.status, 200)
    for (const k of ['email', 'contacto_nombre', 'contacto_cargo', 'direccion', 'origen', 'telefono']) assert.equal(c.body[k], null, k)
  })

  it('validaciones: email, teléfono, origen, etiquetas y claves desconocidas => 400 y no cambian nada', async () => {
    const bad: Record<string, unknown>[] = [
      { email: 'sin-arroba' },
      { email: 'a@b' },
      { email: 'con espacio@x.com' },
      { telefono: 'abc' },
      { telefono: '12' },
      { origen: 'tiktok' },
      { etiquetas: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { etiquetas: ['x'.repeat(31)] },
      { etiquetas: [''] },
      { notas: '' },
      { notas: 'x'.repeat(4001) },
      { proxima_accion_fecha: '2026-13-01' },
      { campo_inventado: 1 },
    ]
    for (const body of bad) {
      const r = await api(`/clientes/${id}`, { method: 'PATCH', body })
      assert.equal(r.status, 400, JSON.stringify(body) + ' => ' + JSON.stringify(r.body))
    }
    const meta = await api(`/clientes/${id}`, { method: 'PATCH', body: { origen: 'meta_ads' } })
    assert.equal(meta.status, 200, 'meta_ads es un origen válido')
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: {} })).status, 400)
  })

  it('la BD también lo exige (CHECK): email malo y etapa incoherente se rechazan aunque se salte la API', async () => {
    await assert.rejects(admin.query("UPDATE clients SET email = 'basura' WHERE id = $1", [id]), /clients_email_ck/)
    await assert.rejects(admin.query("UPDATE clients SET pipeline_stage = 'prospecto' WHERE id = $1", [id]), /clients_stage_/, 'un cliente no puede tener etapa abierta')
    await assert.rejects(admin.query("UPDATE clients SET pipeline_stage = 'nuevo' WHERE id = $1", [id]), /clients_stage_/, 'etapas inexistentes: FK')
    await assert.rejects(admin.query("UPDATE clients SET next_action_date = '2026-01-01' WHERE id = $1", [id]), /clients_next_ck/)
  })

  it('próxima acción: la fecha exige acción; borrar la acción se lleva la fecha; la ven el resumen y el listado', async () => {
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: { proxima_accion_fecha: isoDay(3) } })).status, 400)
    const a = await api(`/clientes/${id}`, { method: 'PATCH', body: { proxima_accion: 'Llevar muestra', proxima_accion_fecha: isoDay(3) } })
    assert.equal(a.status, 200)
    assert.equal(a.body.proxima_accion, 'Llevar muestra')
    assert.equal(a.body.proxima_accion_fecha, isoDay(3))
    assert.equal(a.body.seguimiento_vencido, false)
    const l = (await api('/clientes?per_page=100')).body.data.find((x: any) => x.id === id)
    assert.equal(l.proxima_accion, 'Llevar muestra')
    const b = await api(`/clientes/${id}`, { method: 'PATCH', body: { proxima_accion: null } })
    assert.equal(b.body.proxima_accion, null)
    assert.equal(b.body.proxima_accion_fecha, null)
  })

  it('un cliente con ficha e interacciones va a la papelera con todo y vuelve igual', async () => {
    await api(`/clientes/${id}`, { method: 'PATCH', body: { telefono: '0412-9990000', etiquetas: ['vip'], notas: 'Nota' } })
    const i = await api(`/clientes/${id}/interacciones`, { body: { tipo: 'llamada', resumen: 'Llamada de prueba' } })
    assert.equal(i.status, 201, JSON.stringify(i.body))
    const del = await apiD(`/clientes/${id}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.match(del.body.resumen, /1 interacción|1 interacciones/)
    assert.equal((await api(`/clientes/${id}`)).status, 404)
    const item = (await apiD('/papelera')).body.data.find((x: any) => x.nombre === 'Panadería La Estrella')
    assert.equal((await apiD(`/papelera/${item.id}/restaurar`, { method: 'POST', body: {} })).status, 200)
    const d = (await api(`/clientes/${id}`)).body
    assert.deepEqual(d.etiquetas, ['vip'], 'text[] sobrevive a la papelera')
    assert.equal(d.telefono, '0412-9990000')
    assert.equal(d.interacciones.total, 1)
    assert.equal(d.interacciones.recientes[0].resumen, 'Llamada de prueba')
  })
})

describe('CRM: pipeline', () => {
  it('un posible nuevo entra en "prospecto" con 10 %; se puede crear en otra etapa abierta (incl. alias viejos), no en ganado/perdido/presentada', async () => {
    const a = await mkPosible('Pipe A')
    assert.equal(a.estado, 'posible')
    assert.equal(a.etapa, 'prospecto')
    assert.equal(a.probabilidad, 10)
    assert.equal(a.valor_ponderado, null, 'sin valor estimado no hay ponderado (null, no 0)')
    const b = await mkPosible('Pipe B', { etapa: 'propuesta', valor_estimado: 1000 }) // alias de la fase 1
    assert.equal(b.etapa, 'propuesta_en_armado', 'la salida siempre usa los nombres nuevos')
    assert.equal(b.probabilidad, 50)
    assert.equal(b.valor_ponderado, 500)
    for (const etapa of ['ganado', 'perdido', 'propuesta_presentada', 'negociacion', 'inventada'])
      assert.equal((await api('/clientes', { body: { nombre: 'Pipe X', estado: 'posible', etapa } })).status, 400, etapa)
    assert.equal((await api('/clientes', { body: { nombre: 'Pipe Y', etapa: 'prospecto' } })).status, 400, 'pipeline sin estado posible')
    assert.equal((await api('/clientes', { body: { nombre: 'Pipe Z', valor_estimado: 5 } })).status, 400)
  })

  it('transiciones: cada cambio de etapa deja una entrada automática en la bitácora; mismo valor no duplica', async () => {
    const p = await mkPosible('Pipe C', { valor_estimado: 2000 })
    const move = (body: unknown) => api(`/clientes/${p.id}`, { method: 'PATCH', body })
    const c1 = await move({ etapa: 'contactado' }) // alias viejo => visita_agendada
    assert.equal(c1.status, 200, JSON.stringify(c1.body))
    assert.equal(c1.body.etapa, 'visita_agendada')
    assert.equal(c1.body.probabilidad, 20, 'cada etapa trae su probabilidad')
    const c2 = await move({ etapa: 'propuesta_en_armado', probabilidad: 80 })
    assert.equal(c2.body.probabilidad, 80, 'se puede pisar a mano')
    assert.equal(c2.body.valor_ponderado, 1600)
    await move({ etapa: 'propuesta_en_armado' }) // sin cambio
    const feed = (await api(`/clientes/${p.id}/interacciones?tipo=etapa`)).body.data
    assert.deepEqual(feed.map((e: any) => e.cambio.a).sort(), ['propuesta_en_armado', 'visita_agendada'])
    assert.ok(feed.every((e: any) => e.automatica === true && e.tipo === 'etapa'))
    assert.equal(feed.find((e: any) => e.cambio.a === 'propuesta_en_armado').cambio.de, 'visita_agendada')
    assert.equal(feed[0].registrada_por, 'Leandro')
  })

  it('ganar: probabilidad 100, pasa a cliente activo; perder: exige motivo, probabilidad 0; reabrir devuelve la probabilidad de la etapa', async () => {
    const w = await mkPosible('Pipe Gana', { valor_estimado: 800 })
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'ganado' } })).status, 400, 'ganar exige fecha_implementacion')
    const won = await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(7) } })
    assert.equal(won.status, 200, JSON.stringify(won.body))
    assert.equal(won.body.fecha_implementacion, isoDay(7))
    assert.equal(won.body.estado, 'activo')
    assert.equal(won.body.etapa, 'ganado')
    assert.equal(won.body.probabilidad, 100)
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(7) } })).status, 409, 'ya es cliente')
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'x' } })).status, 409)

    const l = await mkPosible('Pipe Pierde', { valor_estimado: 800, etapa: 'propuesta_en_armado', probabilidad: 90 })
    assert.equal((await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'perdido' } })).status, 400, 'sin motivo')
    assert.equal((await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Precio', probabilidad: 30 } })).status, 400, 'perdido es 0')
    const lost = await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Precio' } })
    assert.equal(lost.status, 200, JSON.stringify(lost.body))
    assert.equal(lost.body.probabilidad, 0)
    assert.equal(lost.body.valor_ponderado, 0)
    assert.equal(lost.body.motivo_perdida, 'Precio')
    assert.equal(lost.body.estado, 'posible')
    const entry = (await api(`/clientes/${l.id}/interacciones?tipo=etapa`)).body.data.find((e: any) => e.cambio.a === 'perdido')
    assert.equal(entry.cambio.motivo, 'Precio')
    // el motivo solo existe en "perdido"
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { motivo_perdida: 'x' } })).status, 400)
    // reabrir
    const re = await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'visita_agendada' } })
    assert.equal(re.status, 200, JSON.stringify(re.body))
    assert.equal(re.body.etapa, 'visita_agendada')
    assert.equal(re.body.probabilidad, 20)
    assert.equal(re.body.motivo_perdida, null)
  })

  it('estado "activo" sobre un posible = ganado; "posible" sobre un cliente = prospecto; estado y etapa contradictorios => 400', async () => {
    const p = await mkPosible('Pipe Estado')
    assert.equal((await api(`/clientes/${p.id}`, { method: 'PATCH', body: { estado: 'activo', etapa: 'prospecto', fecha_implementacion: isoDay(3) } })).status, 400)
    const a = await api(`/clientes/${p.id}`, { method: 'PATCH', body: { estado: 'activo', fecha_implementacion: isoDay(3) } })
    assert.equal(a.body.etapa, 'ganado')
    assert.equal(a.body.probabilidad, 100)
    const old = (await api('/clientes', { body: { nombre: 'Pipe Viejo' } })).body
    assert.equal(old.etapa, null)
    const b = await api(`/clientes/${old.id}`, { method: 'PATCH', body: { estado: 'posible' } })
    assert.equal(b.body.etapa, 'prospecto')
    assert.equal(b.body.probabilidad, 10)
  })

  it('los datos de pipeline no se editan en un cliente (400); POST /clientes/:id/convertir no existe en v1, el cierre va por PATCH', async () => {
    const c = (await api('/clientes', { body: { nombre: 'Pipe Cliente' } })).body
    for (const body of [{ valor_estimado: 100 }, { probabilidad: 50 }, { cierre_previsto: isoDay(10) }])
      assert.equal((await api(`/clientes/${c.id}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body))
  })

  it('valor estimado y cierre previsto: se guardan, null los borra; monto inválido => 400', async () => {
    const p = await mkPosible('Pipe Valor')
    const a = await api(`/clientes/${p.id}`, { method: 'PATCH', body: { valor_estimado: 1234.5, cierre_previsto: isoDay(20) } })
    assert.equal(a.body.valor_estimado, 1234.5)
    assert.equal(a.body.cierre_previsto, isoDay(20))
    const b = await api(`/clientes/${p.id}`, { method: 'PATCH', body: { valor_estimado: null, cierre_previsto: null } })
    assert.equal(b.body.valor_estimado, null)
    assert.equal(b.body.cierre_previsto, null)
    for (const v of [0, -5, 10.123]) assert.equal((await api(`/clientes/${p.id}`, { method: 'PATCH', body: { valor_estimado: v } })).status, 400, String(v))
    assert.equal((await api(`/clientes/${p.id}`, { method: 'PATCH', body: { probabilidad: 101 } })).status, 400)
    assert.equal((await api(`/clientes/${p.id}`, { method: 'PATCH', body: { probabilidad: 5.5 } })).status, 400)
  })

  it('GET /pipeline: totales y ponderados por etapa, ganados/perdidos aparte, fríos con 14 días', async () => {
    const before = (await api('/pipeline')).body
    assert.equal(before.dias_frio, 14)
    assert.deepEqual(before.etapas.map((e: any) => e.etapa), ['prospecto', 'visita_agendada', 'visita_realizada', 'propuesta_en_armado', 'propuesta_presentada'])
    const prop = before.etapas.find((e: any) => e.etapa === 'propuesta_en_armado')
    const a = await mkPosible('Pipe Resumen A', { etapa: 'propuesta_en_armado', valor_estimado: 1000 }) // 50 % => 500
    const b = await mkPosible('Pipe Resumen B', { etapa: 'propuesta_en_armado', valor_estimado: 333.33, probabilidad: 33 }) // 109.9989 => 110
    await mkPosible('Pipe Resumen C', { etapa: 'propuesta_en_armado' }) // sin valor
    const after = (await api('/pipeline')).body
    const p2 = after.etapas.find((e: any) => e.etapa === 'propuesta_en_armado')
    assert.equal(p2.cantidad, prop.cantidad + 3)
    assert.equal(p2.valor_total, sumOf([prop.valor_total, 1000, 333.33]))
    assert.equal(p2.valor_ponderado, sumOf([prop.valor_ponderado, 500, 110]))
    assert.equal(p2.sin_valor, prop.sin_valor + 1)
    assert.equal(after.abiertos.cantidad, after.etapas.reduce((s: number, e: any) => s + e.cantidad, 0))
    assert.equal(after.abiertos.valor_total, sumOf(after.etapas.map((e: any) => e.valor_total)))
    const perd = await mkPosible('Pipe Resumen Perdido', { valor_estimado: 70 })
    await api(`/clientes/${perd.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Precio' } })
    const fin = (await api('/pipeline')).body
    assert.ok(fin.ganados.cantidad >= 1)
    assert.equal(fin.perdidos.cantidad, 1)
    assert.equal(fin.perdidos.valor_total, 70)
    assert.equal(fin.abiertos.cantidad, after.abiertos.cantidad, 'perdidos no cuentan como abiertos')

    // frío: más de 14 días sin una llamada/visita/WhatsApp/nota reales (las entradas de etapa no cuentan)
    assert.ok(!after.frios.some((f: any) => f.id === a.id), 'recién creado no está frío')
    await admin.query("UPDATE clients SET created_at = now() - interval '20 days' WHERE id = $1", [a.id])
    const frio = (await api('/pipeline')).body.frios.find((f: any) => f.id === a.id)
    assert.ok(frio && frio.dias_sin_contacto >= 20)
    assert.equal((await api(`/clientes/${a.id}`)).body.frio, true)
    await api(`/clientes/${a.id}/interacciones`, { body: { tipo: 'llamada', resumen: 'Lo llamé' } })
    assert.ok(!(await api('/pipeline')).body.frios.some((f: any) => f.id === a.id), 'una interacción real lo calienta')
    assert.equal((await api(`/clientes/${a.id}`)).body.frio, false)
    // cambiar de etapa NO calienta
    await admin.query("UPDATE clients SET created_at = now() - interval '30 days' WHERE id = $1", [b.id])
    await api(`/clientes/${b.id}`, { method: 'PATCH', body: { etapa: 'visita_realizada' } })
    assert.ok((await api('/pipeline')).body.frios.some((f: any) => f.id === b.id))
  })

  it('filtro etapa en /clientes y validación', async () => {
    const r = await api('/clientes?etapa=propuesta_en_armado&per_page=100')
    assert.equal(r.status, 200)
    assert.ok(r.body.data.length >= 3 && r.body.data.every((c: any) => c.etapa === 'propuesta_en_armado'))
    assert.equal((await api('/clientes?etapa=propuesta&per_page=100')).body.meta.total, r.body.meta.total, 'el alias viejo filtra igual')
    assert.equal((await api('/clientes?etapa=nada')).status, 400)
  })
})

describe('CRM: bitácora', () => {
  let cid = ''
  let first = ''

  before(async () => {
    cid = (await api('/clientes', { body: { nombre: 'Bitácora SA' } })).body.id
  })

  it('registrar los cuatro tipos; fecha opcional (solo día = mediodía de Caracas; con hora y zona exacta); lista por fecha descendente', async () => {
    const n = await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'nota', resumen: '  Le interesa el sistema de pedidos  ' } })
    assert.equal(n.status, 201, JSON.stringify(n.body))
    first = n.body.id
    assert.equal(n.body.resumen, 'Le interesa el sistema de pedidos')
    assert.equal(n.body.tipo, 'nota')
    assert.equal(n.body.automatica, false)
    assert.equal(n.body.cambio, null)
    assert.equal(n.body.registrada_por, 'Leandro')
    assert.equal(n.body.cliente_id, cid)
    const v = await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'visita', resumen: 'Visita al local', fecha: '2026-01-10' } })
    assert.equal(v.body.fecha, '2026-01-10T16:00:00.000Z', '12:00 en Caracas (UTC-4)')
    const w = await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'whatsapp', resumen: 'Mandé el catálogo', fecha: '2026-02-01T09:30:00-04:00' } })
    assert.equal(w.body.fecha, '2026-02-01T13:30:00.000Z')
    const l = await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'llamada', resumen: 'Llamada de seguimiento', fecha: '2026-03-01' } })
    assert.equal(l.status, 201)
    const feed = (await api(`/clientes/${cid}/interacciones`)).body
    assert.deepEqual(feed.data.map((e: any) => e.tipo), ['nota', 'llamada', 'whatsapp', 'visita'])
    assert.equal(feed.meta.total, 4)
    assert.deepEqual((await api(`/clientes/${cid}/interacciones?tipo=whatsapp`)).body.data.map((e: any) => e.resumen), ['Mandé el catálogo'])
    const page = (await api(`/clientes/${cid}/interacciones?per_page=2&page=2`)).body
    assert.deepEqual(page.data.map((e: any) => e.tipo), ['whatsapp', 'visita'])
  })

  it('un cliente no puede escribir tipo "etapa" (el historial del pipeline no se falsifica) ni crear entradas inventadas', async () => {
    const r = await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'etapa', resumen: 'Nuevo → Ganado' } })
    assert.equal(r.status, 400)
    assert.match(r.body.error.message, /etapa/)
    assert.equal((await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'nota', resumen: 'x', meta: { a: 'ganado' } } })).status, 400)
    assert.equal((await api(`/interacciones/${first}`, { method: 'PATCH', body: { tipo: 'etapa' } })).status, 400)
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM interactions WHERE client_id = $1 AND kind = 'etapa'", [cid])
    assert.equal(rows[0].n, 0)
  })

  it('validaciones: resumen vacío/largo, tipo, fecha futura o mal formada, cliente inexistente => 400/404', async () => {
    const post = (body: unknown, c = cid) => api(`/clientes/${c}/interacciones`, { body })
    assert.equal((await post({ tipo: 'nota', resumen: '   ' })).status, 400)
    assert.equal((await post({ tipo: 'nota', resumen: 'x'.repeat(2001) })).status, 400)
    assert.equal((await post({ tipo: 'correo', resumen: 'x' })).status, 400)
    assert.equal((await post({ resumen: 'x' })).status, 400)
    assert.equal((await post({ tipo: 'nota', resumen: 'x', fecha: isoDay(2) })).status, 400, 'día futuro')
    assert.equal((await post({ tipo: 'nota', resumen: 'x', fecha: new Date(Date.now() + 3_600_000).toISOString() })).status, 400, 'hora futura')
    assert.equal((await post({ tipo: 'nota', resumen: 'x', fecha: '10/01/2026' })).status, 400)
    assert.equal((await post({ tipo: 'nota', resumen: 'x' }, NOPE)).status, 404)
    assert.equal((await api(`/clientes/${NOPE}/interacciones`)).status, 404)
    assert.equal((await api('/interacciones/no-es-uuid', { method: 'PATCH', body: { resumen: 'x' } })).status, 400)
    assert.equal((await api(`/interacciones/${NOPE}`, { method: 'PATCH', body: { resumen: 'x' } })).status, 404)
  })

  it('editar: parcial (tipo, resumen, fecha); PATCH vacío => 400', async () => {
    const r = await api(`/interacciones/${first}`, { method: 'PATCH', body: { tipo: 'llamada', resumen: 'Corregido' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.tipo, 'llamada')
    assert.equal(r.body.resumen, 'Corregido')
    const f = await api(`/interacciones/${first}`, { method: 'PATCH', body: { fecha: '2026-03-02' } })
    assert.equal(f.body.fecha, '2026-03-02T16:00:00.000Z')
    assert.equal(f.body.resumen, 'Corregido')
    assert.equal((await api(`/interacciones/${first}`, { method: 'PATCH', body: {} })).status, 400)
  })

  it('las entradas automáticas de etapa no se editan ni se borran (409) y desde la bitácora se ven marcadas', async () => {
    const p = await mkPosible('Bitácora Etapa')
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'visita_agendada' } })
    const e = (await api(`/clientes/${p.id}/interacciones?tipo=etapa`)).body.data[0]
    assert.equal(e.automatica, true)
    assert.equal(e.resumen, 'Prospecto captado → Visita agendada')
    assert.equal((await api(`/interacciones/${e.id}`, { method: 'PATCH', body: { resumen: 'Mentira' } })).status, 409)
    assert.equal((await apiD(`/interacciones/${e.id}`, { method: 'DELETE' })).status, 409)
    assert.equal((await api(`/clientes/${p.id}/interacciones?tipo=etapa`)).body.data.length, 1)
  })

  it('borrar va a la papelera (exige permiso de borrado) y restaurar la devuelve con su fecha', async () => {
    assert.equal((await api(`/interacciones/${first}`, { method: 'DELETE' })).status, 403, 'la llave sin borrado no puede')
    const del = await apiD(`/interacciones/${first}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal(del.body.entidad, 'interaccion')
    assert.equal((await api(`/clientes/${cid}/interacciones`)).body.meta.total, 3)
    const item = (await apiD('/papelera')).body.data.find((x: any) => x.id === del.body.papelera_id)
    assert.ok(item)
    assert.equal(item.tipo, 'interaccion')
    assert.equal((await apiD(`/papelera/${item.id}/restaurar`, { method: 'POST', body: {} })).status, 200)
    const back = (await api(`/clientes/${cid}/interacciones`)).body
    assert.equal(back.meta.total, 4)
    assert.equal(back.data[0].id, first)
    assert.equal(back.data[0].fecha, '2026-03-02T16:00:00.000Z')
  })

  it('restaurar una interacción cuyo cliente ya no existe => 409; el detalle del cliente trae las 10 recientes', async () => {
    const c2 = (await api('/clientes', { body: { nombre: 'Bitácora Huérfana' } })).body.id
    const i = (await api(`/clientes/${c2}/interacciones`, { body: { tipo: 'nota', resumen: 'Suelta' } })).body
    const del = await apiD(`/interacciones/${i.id}`, { method: 'DELETE' })
    await apiD(`/clientes/${c2}`, { method: 'DELETE' })
    const item = (await apiD('/papelera')).body.data.find((x: any) => x.tipo === 'interaccion' && x.id === del.body.papelera_id)
    assert.equal((await apiD(`/papelera/${item.id}/restaurar`, { method: 'POST', body: {} })).status, 409)
    for (let k = 0; k < 12; k++) await api(`/clientes/${cid}/interacciones`, { body: { tipo: 'nota', resumen: `Nota ${k}`, fecha: '2026-03-03' } })
    const d = (await api(`/clientes/${cid}`)).body
    assert.equal(d.interacciones.total, 16)
    assert.equal(d.interacciones.recientes.length, 10)
  })
})

describe('CRM: alertas (campana)', () => {
  const alertas = async (q = '', key = KEY) => (await api(`/notificaciones${q}`, { key })).body
  let overdueClient = ''
  let seguimientoClient = ''

  it('una cuota vencida alerta una vez; la vencida sigue dentro de por_cobrar; pagarla quita la alerta', async () => {
    const base = await alertas('?per_page=100')
    const cl = await api('/clientes', {
      body: { nombre: 'Alerta Cuotas', cobros: [{ fecha: '2020-01-01', monto: 40, concepto: 'Mensualidad' }, { fecha: isoDay(30), monto: 60, concepto: 'Futura' }] },
    })
    overdueClient = cl.body.id
    assert.equal(cl.body.por_cobrar, 100)
    assert.equal(cl.body.cuotas_vencidas, 1)
    assert.equal(cl.body.monto_vencido, 40)
    const a = await alertas('?per_page=100')
    assert.equal(a.meta.total_alertas, base.meta.total_alertas + 1)
    assert.equal(a.meta.sin_leer, base.meta.sin_leer + 1)
    const mine = a.data.filter((x: any) => x.cliente_id === overdueClient)
    assert.equal(mine.length, 1, 'la cuota futura no alerta')
    assert.equal(mine[0].tipo, 'cuota_vencida')
    assert.match(mine[0].clave, /^cuota:/)
    assert.equal(mine[0].monto, 40)
    assert.equal(mine[0].leida, false)
    assert.ok(mine[0].dias > 365)
    assert.match(mine[0].titulo, /Alerta Cuotas/)
    // Finanzas ve lo mismo
    const f = (await api('/finanzas/resumen?periodo=todo')).body
    const fila = f.clientes.find((x: any) => x.id === overdueClient)
    assert.equal(fila.vencido, 40)
    assert.equal(fila.por_cobrar, 100)
    // pagos?vencido=true
    const pv = await api(`/pagos?cliente_id=${overdueClient}&vencido=true`)
    assert.equal(pv.status, 200, JSON.stringify(pv.body))
    assert.deepEqual(pv.body.data.map((p: any) => p.concepto), ['Mensualidad'])
    assert.equal((await api(`/pagos?cliente_id=${overdueClient}&vencido=false`)).body.data.every((p: any) => p.concepto !== 'Mensualidad' || p.estado === 'cobrado'), true)
    assert.equal((await api('/pagos?vencido=quizas')).status, 400)
    // cobrarla la quita
    await api(`/pagos/${pv.body.data[0].id}`, { method: 'PATCH', body: { estado: 'cobrado' } })
    const z = await alertas('?per_page=100')
    assert.equal(z.meta.total_alertas, base.meta.total_alertas)
    assert.ok(!z.data.some((x: any) => x.cliente_id === overdueClient))
  })

  it('un posible cliente, uno archivado o uno en la papelera no generan alertas de cuota', async () => {
    const p = await mkPosible('Alerta Posible')
    const base = (await alertas()).meta.total_alertas
    await api(`/clientes/${p.id}/pagos`, { body: { fecha: '2020-02-01', monto: 10, concepto: 'Vieja' } })
    assert.equal((await alertas()).meta.total_alertas, base, 'posible')
    const c = (await api('/clientes', { body: { nombre: 'Alerta Archivo', cobros: [{ fecha: '2020-02-01', monto: 10, concepto: 'Vieja' }] } })).body.id
    assert.equal((await alertas()).meta.total_alertas, base + 1)
    await api(`/clientes/${c}`, { method: 'PATCH', body: { archivado: true } })
    assert.equal((await alertas()).meta.total_alertas, base, 'archivado')
    await api(`/clientes/${c}`, { method: 'PATCH', body: { archivado: false } })
    assert.equal((await alertas()).meta.total_alertas, base + 1)
    await apiD(`/clientes/${c}`, { method: 'DELETE' })
    assert.equal((await alertas()).meta.total_alertas, base, 'papelera')
  })

  it('seguimiento: aparece el día de la fecha (no antes), se reprograma con otra clave y se apaga en "perdido"', async () => {
    const base = (await alertas()).meta.total_alertas
    const p = await mkPosible('Alerta Seguimiento', { proxima_accion: 'Llamar a María', proxima_accion_fecha: isoDay(2) })
    seguimientoClient = p.id
    assert.equal((await alertas()).meta.total_alertas, base, 'todavía no toca')
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { proxima_accion_fecha: isoDay(0) } })
    const hoy = await alertas('?tipo=seguimiento&per_page=100')
    const a = hoy.data.find((x: any) => x.cliente_id === p.id)
    assert.ok(a)
    assert.equal(a.clave, `seguimiento:${p.id}:${isoDay(0)}`)
    assert.equal(a.detalle, 'Hoy')
    assert.equal(a.dias, 0)
    assert.equal(a.titulo, 'Alerta Seguimiento: Llamar a María')
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { proxima_accion_fecha: isoDay(-3) } })
    const atrasado = (await alertas('?tipo=seguimiento&per_page=100')).data.find((x: any) => x.cliente_id === p.id)
    assert.equal(atrasado.detalle, 'Atrasado 3 días')
    assert.equal((await api(`/clientes/${p.id}`)).body.seguimiento_vencido, true)
    // perdido => ya no hay nada que seguir
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Sin presupuesto' } })
    assert.ok(!(await alertas('?per_page=100')).data.some((x: any) => x.cliente_id === p.id))
  })

  it('marcar leídas: por clave o todas; una clave inventada no deja nada; cada socio marca las suyas', async () => {
    const p = await mkPosible('Alerta Lectura', { proxima_accion: 'Visitar', proxima_accion_fecha: isoDay(-1) })
    const all = await alertas('?per_page=100')
    const mia = all.data.find((x: any) => x.cliente_id === p.id)
    const sinLeer0 = all.meta.sin_leer
    const r = await api('/notificaciones/leer', { body: { claves: [mia.clave, `cuota:${NOPE}`, `seguimiento:${NOPE}:2020-01-01`] } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.marcadas, 1, 'solo la que existe')
    assert.equal(r.body.sin_leer, sinLeer0 - 1)
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM notification_reads WHERE key LIKE $1", [`%${NOPE}%`])
    assert.equal(rows[0].n, 0)
    assert.equal((await alertas('?per_page=100')).data.find((x: any) => x.cliente_id === p.id).leida, true)
    assert.ok(!(await alertas('?estado=sin_leer&per_page=100')).data.some((x: any) => x.cliente_id === p.id))
    // otro socio la sigue viendo sin leer
    const theirs = (await alertas('?per_page=100', KEY_J)).data.find((x: any) => x.cliente_id === p.id)
    assert.equal(theirs.leida, false)
    // reprogramar la vuelve a sacar sin leer (clave nueva)
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { proxima_accion_fecha: isoDay(-2) } })
    assert.equal((await alertas('?per_page=100')).data.find((x: any) => x.cliente_id === p.id).leida, false)
    // todas
    const t = await api('/notificaciones/leer', { body: { todas: true } })
    assert.equal(t.body.sin_leer, 0)
    assert.equal((await alertas('?estado=sin_leer')).data.length, 0)
    assert.equal((await alertas('', KEY_J)).meta.sin_leer > 0, true, 'lo de Jorbi sigue intacto')
  })

  it('validaciones de /notificaciones/leer y de los filtros', async () => {
    for (const body of [{}, { claves: [] }, { claves: ['hola'] }, { todas: false }, { claves: [`cuota:${NOPE}`], todas: true }, { otra: 1 }])
      assert.equal((await api('/notificaciones/leer', { body })).status, 400, JSON.stringify(body))
    assert.equal((await api('/notificaciones?estado=ninguna')).status, 400)
    assert.equal((await api('/notificaciones?tipo=otro')).status, 400)
  })

  it('el seguimiento vencido cuenta en /pipeline y las alertas de cuota no se duplican al paginar', async () => {
    assert.ok((await api('/pipeline')).body.seguimientos_vencidos >= 0)
    const a = await alertas('?per_page=100')
    const keys = a.data.map((x: any) => x.clave)
    assert.equal(new Set(keys).size, keys.length)
    const p1 = (await alertas('?per_page=1&page=1')).data[0]
    assert.equal(p1.clave, keys[0], 'el orden es estable: lo más viejo primero')
    assert.ok(a.data.findIndex((x: any) => x.tipo === 'seguimiento') > a.data.findLastIndex((x: any) => x.tipo === 'cuota_vencida'), 'cuotas antes que seguimientos')
    assert.ok(overdueClient && seguimientoClient)
  })
})

describe('CRM: búsqueda global', () => {
  const buscar = (q: string, extra = '') => api(`/buscar?q=${encodeURIComponent(q)}${extra}`)
  let cid = ''
  let pid = ''

  before(async () => {
    cid = (await api('/clientes', { body: { nombre: 'Charcutería Doña Ñoña', telefono: '0414-5550123', email: 'nona@charcu.com', etiquetas: ['Embutidos'], notas: 'Quiere sistema de inventario' } })).body.id
    pid = (await api('/proyectos', { body: { nombre: 'Sistema de pedidos', cliente_id: cid } })).body.id
    await api('/tareas', { body: { titulo: 'Instalar báscula conectada', proyecto_id: pid } })
  })

  it('encuentra por nombre sin importar acentos, mayúsculas ni la ñ; devuelve clientes, proyectos y tareas', async () => {
    for (const q of ['charcuteria', 'CHARCUTERÍA', 'dona nona', 'doña ñoña']) {
      const r = await buscar(q)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.ok(r.body.clientes.some((c: any) => c.id === cid), q)
    }
    const r = await buscar('sistema')
    assert.ok(r.body.proyectos.some((p: any) => p.id === pid && p.cliente_id === cid))
    assert.ok(r.body.clientes.some((c: any) => c.id === cid), 'las notas también se buscan')
    const t = await buscar('bascula')
    assert.equal(t.body.tareas.length, 1)
    assert.deepEqual(Object.keys(t.body.tareas[0]).sort(), ['estado', 'id', 'proyecto', 'proyecto_id', 'titulo', 'vence'])
    assert.equal(t.body.total, t.body.clientes.length + t.body.proyectos.length + t.body.tareas.length)
  })

  it('varias palabras (todas deben estar), teléfono por dígitos, email y etiqueta', async () => {
    assert.ok((await buscar('doña charcu')).body.clientes.some((c: any) => c.id === cid))
    assert.ok(!(await buscar('doña zapatería')).body.clientes.some((c: any) => c.id === cid))
    for (const q of ['0414-5550123', '0414 555', '555 0123', '5550123']) assert.ok((await buscar(q)).body.clientes.some((c: any) => c.id === cid), q)
    assert.ok((await buscar('nona@charcu.com')).body.clientes.some((c: any) => c.id === cid))
    const e = (await buscar('embutidos')).body.clientes.find((c: any) => c.id === cid)
    assert.deepEqual(e.etiquetas, ['embutidos'])
    assert.equal(e.telefono, '0414-5550123')
    assert.equal(e.estado, 'activo')
  })

  it('filtro por tipo, límite, archivados y validaciones', async () => {
    const solo = await buscar('sistema', '&tipo=proyecto')
    assert.equal(solo.body.clientes.length, 0)
    assert.equal(solo.body.tareas.length, 0)
    assert.ok(solo.body.proyectos.length >= 1)
    assert.ok((await buscar('Pipe', '&limite=2')).body.clientes.length <= 2)
    await api(`/clientes/${cid}`, { method: 'PATCH', body: { archivado: true } })
    assert.ok(!(await buscar('charcuteria')).body.clientes.some((c: any) => c.id === cid), 'archivados fuera por defecto')
    assert.ok(!(await buscar('sistema')).body.proyectos.some((p: any) => p.id === pid))
    const con = await buscar('charcuteria', '&archivados=incluir')
    assert.equal(con.body.clientes.find((c: any) => c.id === cid)?.archivado, true)
    const solos = await buscar('charcuteria', '&archivados=solo')
    assert.ok(solos.body.clientes.some((c: any) => c.id === cid))
    await api(`/clientes/${cid}`, { method: 'PATCH', body: { archivado: false } })
    for (const q of ['', 'a', encodeURIComponent('x'.repeat(81))]) assert.equal((await api(`/buscar?q=${q}`)).status, 400, q)
    assert.equal((await api('/buscar')).status, 400)
    assert.equal((await buscar('sistema', '&tipo=otro')).status, 400)
    assert.equal((await buscar('sistema', '&limite=0')).status, 400)
    assert.equal((await buscar('sistema', '&limite=26')).status, 400)
  })

  it('lo escrito va como parámetro, nunca como SQL (comillas, % y _ no rompen ni comodinean)', async () => {
    for (const q of ["'; DROP TABLE clients; --", '%%', '__', '\\\\', '""']) {
      const r = await buscar(q)
      assert.equal(r.status, 200, q + JSON.stringify(r.body))
    }
    assert.equal((await buscar('%%')).body.total, 0, '% no es comodín')
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM clients')).rows[0].n > 0, true)
  })

  it('el orden pone primero el nombre que empieza por lo escrito', async () => {
    const a = (await api('/clientes', { body: { nombre: 'Zeta Ordenada' } })).body.id
    const b = (await api('/clientes', { body: { nombre: 'Aaa Ordenada', notas: 'zeta' } })).body.id
    const r = (await buscar('zeta')).body.clientes.map((c: any) => c.id)
    assert.ok(r.indexOf(a) < r.indexOf(b))
  })
})

describe('CRM: permisos y MCP', () => {
  let n = 0
  const rpc = (method: string, params: unknown = {}, key: string = KEY) =>
    http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: ++n, method, params } })
  const tool = async (name: string, args: unknown = {}, key: string = KEY) => {
    const r = await rpc('tools/call', { name, arguments: args }, key)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return r.body
  }
  const data = (b: any) => JSON.parse(b.result.content[0].text)
  let KEY_R = ''
  let cid = ''

  before(() => {
    KEY_R = newKey('Leandro', 'solo-lectura-crm', 'read')
  })

  it('REST: una llave de solo lectura lee bitácora, alertas, pipeline y búsqueda, pero no escribe ni marca leídas', async () => {
    cid = (await api('/clientes', { body: { nombre: 'Permisos CRM' } })).body.id
    const r = (p: string, o: Opts = {}) => api(p, { key: KEY_R, ...o })
    for (const p of [`/clientes/${cid}/interacciones`, '/notificaciones', '/pipeline', '/buscar?q=permisos']) assert.equal((await r(p)).status, 200, p)
    assert.equal((await r(`/clientes/${cid}/interacciones`, { body: { tipo: 'nota', resumen: 'x' } })).status, 403)
    assert.equal((await r('/notificaciones/leer', { body: { todas: true } })).status, 403)
    assert.equal((await r(`/clientes/${cid}`, { method: 'PATCH', body: { telefono: '0414-0000000' } })).status, 403)
    assert.equal((await r('/interacciones/' + NOPE, { method: 'DELETE' })).status, 403)
    assert.equal((await api('/pipeline', { key: null })).status, 401)
    assert.equal((await api('/buscar?q=permisos', { key: null })).status, 401)
  })

  it('MCP: las herramientas nuevas existen según el permiso (lectura 6, escritura +3, borrado +1)', async () => {
    const names = async (key: string) => (await rpc('tools/list', {}, key)).body.result.tools.map((t: any) => t.name) as string[]
    const ro = await names(KEY_R)
    for (const t of ['hayai_interacciones_listar', 'hayai_pipeline_resumen', 'hayai_notificaciones_listar', 'hayai_buscar']) assert.ok(ro.includes(t), t)
    for (const t of ['hayai_interaccion_registrar', 'hayai_interaccion_actualizar', 'hayai_notificaciones_marcar_leidas', 'hayai_interaccion_eliminar']) assert.ok(!ro.includes(t), t)
    const rw = await names(KEY)
    for (const t of ['hayai_interaccion_registrar', 'hayai_interaccion_actualizar', 'hayai_notificaciones_marcar_leidas']) assert.ok(rw.includes(t), t)
    assert.ok(!rw.includes('hayai_interaccion_eliminar'))
    assert.ok((await names(KEY_D)).includes('hayai_interaccion_eliminar'))
    const full = (await rpc('tools/list', {}, KEY_D)).body.result.tools
    const reg = full.find((t: any) => t.name === 'hayai_interaccion_registrar')
    assert.deepEqual([...reg.inputSchema.required].sort(), ['cliente_id', 'resumen', 'tipo'])
    assert.deepEqual(reg.inputSchema.properties.tipo.enum, ['llamada', 'visita', 'whatsapp', 'nota'], 'etapa no se ofrece al agente')
  })

  it('MCP: ficha, pipeline y bitácora de punta a punta; los errores de negocio llegan como isError', async () => {
    const created = data(await tool('hayai_cliente_crear', { nombre: 'MCP Prospecto', estado: 'posible', telefono: '0412-1112233', etiquetas: ['mcp'], origen: 'meta_ads', valor_estimado: 500, proxima_accion: 'Enviar propuesta', proxima_accion_fecha: isoDay(-1) }))
    assert.equal(created.etapa, 'prospecto')
    assert.equal(created.origen, 'meta_ads')
    assert.equal(created.seguimiento_vencido, true)
    const upd = data(await tool('hayai_cliente_actualizar', { id: created.id, etapa: 'propuesta_en_armado' }))
    assert.equal(upd.etapa, 'propuesta_en_armado')
    assert.equal(upd.probabilidad, 50)
    const i = data(await tool('hayai_interaccion_registrar', { cliente_id: created.id, tipo: 'whatsapp', resumen: 'Mandé la propuesta' }, KEY_J))
    assert.equal(i.registrada_por, 'Jorbi')
    const list = data(await tool('hayai_interacciones_listar', { cliente_id: created.id }))
    assert.deepEqual(list.data.map((e: any) => e.tipo).sort(), ['etapa', 'whatsapp'])
    const etapa = await tool('hayai_interaccion_registrar', { cliente_id: created.id, tipo: 'etapa', resumen: 'x' })
    assert.equal(etapa.result.isError, true)
    const perdido = await tool('hayai_cliente_actualizar', { id: created.id, etapa: 'perdido' })
    assert.equal(perdido.result.isError, true)
    assert.match(perdido.result.content[0].text, /motivo_perdida/)
    const rest = (await api('/pipeline')).body
    assert.deepEqual(data(await tool('hayai_pipeline_resumen')), rest)
    const found = data(await tool('hayai_buscar', { q: 'mcp prospecto' }))
    assert.ok(found.clientes.some((c: any) => c.id === created.id))
    const al = data(await tool('hayai_notificaciones_listar', { tipo: 'seguimiento' }))
    const mine = al.data.find((a: any) => a.cliente_id === created.id)
    assert.ok(mine)
    const read = data(await tool('hayai_notificaciones_marcar_leidas', { claves: [mine.clave] }))
    assert.equal(read.marcadas, 1)
    const del = await tool('hayai_interaccion_eliminar', { id: i.id }, KEY_D)
    assert.notEqual(del.result.isError, true, JSON.stringify(del))
  })
})

describe('CRM: web (sesión)', () => {
  const PIN = '713904'
  let cookie = ''
  const web = (path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })

  before(async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Elis', pin: '000000' }),
    })
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    assert.equal((await web('/auth/change-pin', { body: { currentPin: '000000', newPin: PIN } })).status, 200)
  })

  it('exige sesión en todas las rutas nuevas', async () => {
    for (const p of ['/notifications', '/search?q=ab', '/pipeline', `/clients/${NOPE}/interactions`]) assert.equal((await http(`${ROOT}/api${p}`)).status, 401, p)
    assert.equal((await http(`${ROOT}/api/notifications/read`, { body: { todas: true } })).status, 401)
  })

  it('PATCH /clients/:id/ficha: traduce camelCase, devuelve el cliente de la lista, rechaza campos desconocidos y vacíos', async () => {
    const p = (await web('/prospects', { body: { name: 'Web CRM', avatar: 'nova', project: { name: 'Web', icon: 'box', owner: 'Elis' } } })).body.client
    assert.equal(p.stage, 'prospecto')
    const r = await web(`/clients/${p.id}/ficha`, {
      method: 'PATCH',
      body: { phone: '0414-7778899', email: 'WEB@crm.com', contactName: 'Ana', tags: ['Nuevo', 'nuevo'], source: 'meta_ads', stage: 'visita_agendada', estValue: 900, probability: 30, expectedClose: isoDay(15), nextAction: 'Llamar', nextActionDate: isoDay(1) },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.phone, '0414-7778899')
    assert.equal(r.body.email, 'web@crm.com')
    assert.deepEqual(r.body.tags, ['nuevo'])
    assert.equal(r.body.stage, 'visita_agendada')
    assert.equal(r.body.estValue, 900)
    assert.equal(r.body.probability, 30)
    assert.equal(r.body.nextActionDate, isoDay(1))
    assert.equal(r.body.lastContactAt, null, 'el cambio de etapa no cuenta como contacto')
    assert.deepEqual((await web('/clients')).body.find((c: any) => c.id === p.id), r.body, 'la lista trae lo mismo')
    assert.equal((await web(`/clients/${p.id}/ficha`, { method: 'PATCH', body: { telefono: '1' } })).status, 400, 'llaves en español no valen en la web')
    assert.equal((await web(`/clients/${p.id}/ficha`, { method: 'PATCH', body: { name: 'Otro' } })).status, 400, 'el nombre va por PATCH /clients/:id')
    assert.equal((await web(`/clients/${p.id}/ficha`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await web(`/clients/${p.id}/ficha`, { method: 'PATCH', body: { stage: 'perdido' } })).status, 400)
    const lost = await web(`/clients/${p.id}/ficha`, { method: 'PATCH', body: { stage: 'perdido', lostReason: 'Eligió a otro' } })
    assert.equal(lost.body.stage, 'perdido')
    assert.equal(lost.body.probability, 0)
    assert.equal(lost.body.lostReason, 'Eligió a otro')
    assert.equal((await web(`/clients/${NOPE}/ficha`, { method: 'PATCH', body: { notes: 'x' } })).status, 404)
  })

  it('PATCH /clients/:id sigue siendo solo nombre y avatar (estricto): la ficha no se cuela por ahí', async () => {
    const c = (await web('/clients', { body: { name: 'Estricto', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })).body
    assert.equal((await web(`/clients/${c.id}`, { method: 'PATCH', body: { name: 'Estricto 2', phone: '0414' } })).status, 400)
    assert.equal((await web(`/clients/${c.id}`, { method: 'PATCH', body: { name: 'Estricto 2' } })).body.name, 'Estricto 2')
  })

  it('bitácora, alertas, búsqueda y pipeline desde la web usan los mismos servicios que la API', async () => {
    const c = (await web('/clients', { body: { name: 'Web Bitácora', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [{ date: '2020-01-01', amount: 15, concept: 'Vieja' }] } })).body
    const i = await web(`/clients/${c.id}/interactions`, { body: { tipo: 'visita', resumen: 'Pasé por el local' } })
    assert.equal(i.status, 201, JSON.stringify(i.body))
    assert.equal(i.body.registrada_por, 'Elis')
    assert.equal((await web(`/clients/${c.id}/interactions`, { body: { tipo: 'etapa', resumen: 'x' } })).status, 400)
    assert.equal((await web(`/interactions/${i.body.id}`, { method: 'PATCH', body: { resumen: 'Pasé dos veces' } })).body.resumen, 'Pasé dos veces')
    assert.equal((await web(`/clients/${c.id}/interactions`)).body.meta.total, 1)
    assert.equal((await web(`/clients`)).body.find((x: any) => x.id === c.id).lastContactAt !== null, true)

    const al = await web('/notifications?per_page=100')
    const a = al.body.data.find((x: any) => x.cliente_id === c.id)
    assert.equal(a.tipo, 'cuota_vencida')
    const read = await web('/notifications/read', { body: { claves: [a.clave] } })
    assert.equal(read.body.marcadas, 1)
    assert.equal((await web('/notifications?per_page=100')).body.data.find((x: any) => x.cliente_id === c.id).leida, true)

    assert.ok((await web('/search?q=web%20bitacora')).body.clientes.some((x: any) => x.id === c.id))
    assert.equal((await web('/search?q=w')).status, 400)
    assert.equal((await web('/pipeline')).body.dias_frio, 14)

    assert.equal((await web(`/interactions/${i.body.id}`, { method: 'DELETE' })).status, 204)
    const item = (await web('/trash')).body.find((t: any) => t.kind === 'interaccion' || t.entity === 'interaccion')
    assert.ok(item, 'aparece en la papelera con su propio tipo')
    assert.equal((await web(`/trash/${item.id}/restore`, { body: {} })).status, 200)
    assert.equal((await web(`/clients/${c.id}/interactions`)).body.meta.total, 1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Actividad del equipo: cliente nuevo, tarea nueva, tarea completada; el aviso nombra al dueño de la llave; en vivo por SSE.
// ---------------------------------------------------------------------------------------------------------------------
describe('Actividad del equipo', () => {
  const act = async (q = '', key = KEY) => (await api(`/actividad${q}`, { key })).body
  const ultimo = async () => (await act('?per_page=1')).meta.ultimo_id as number
  const nuevos = async (desde: number, key = KEY) => (await act(`?desde_id=${desde}&orden=asc&per_page=100`, key)).data as any[]
  let proyecto = ''
  let clienteId = ''

  before(async () => {
    await act('', KEY_J) // el "visto hasta" de Jorbi nace aquí: lo anterior no cuenta como sin leer
  })

  it('un cliente creado por API: el aviso dice "Leandro añadió…" (dueño de la llave), nunca la herramienta; la vía queda en la BD', async () => {
    const base = await ultimo()
    const r = await api('/clientes', { body: { nombre: 'Actividad Panadería' } })
    assert.equal(r.status, 201)
    clienteId = r.body.id
    const ev = await nuevos(base)
    assert.equal(ev.length, 1)
    assert.equal(ev[0].tipo, 'cliente_nuevo')
    assert.equal(ev[0].texto, 'Leandro añadió un cliente nuevo: Actividad Panadería')
    assert.equal(ev[0].actor.nombre, 'Leandro')
    assert.equal(ev[0].cliente_id, clienteId)
    assert.deepEqual(Object.keys(ev[0]).sort(), ['actor', 'cliente_id', 'detalle', 'fecha', 'id', 'leida', 'propia', 'proyecto_id', 'sujeto', 'tarea_id', 'texto', 'tipo'])
    assert.ok(!/growi|muse|api/i.test(ev[0].texto), 'el texto no menciona la herramienta')
    const { rows } = await admin.query('SELECT via FROM activity WHERE id = $1', [ev[0].id])
    assert.equal(rows[0].via, 'api:growi', 'la vía se guarda como dato de auditoría')
  })

  it('propia vs de otros: quien lo hizo no lo cuenta como sin leer; el otro socio sí; leída sigue al "visto hasta"', async () => {
    const mine = await act('?per_page=1')
    assert.equal(mine.data[0].propia, true)
    assert.equal(mine.data[0].leida, true)
    const theirs = await act('?per_page=1', KEY_J)
    assert.equal(theirs.data[0].propia, false)
    assert.equal(theirs.data[0].leida, false)
    assert.ok(theirs.meta.sin_leer >= 1)
    assert.equal(mine.meta.sin_leer, 0)
  })

  it('posible cliente: un solo aviso (no tres) tanto por API como por la web; tarea nueva y completada con su proyecto', async () => {
    const base = await ultimo()
    const p = await api('/clientes', { body: { nombre: 'Actividad Posible', estado: 'posible' } })
    const ev = await nuevos(base)
    assert.deepEqual(ev.map((e) => e.tipo), ['posible_nuevo'])
    assert.equal(ev[0].texto, 'Leandro añadió un posible cliente: Actividad Posible')
    assert.ok(p.body.id)

    const pr = await api('/proyectos', { body: { nombre: 'Sistema Panadería', cliente_id: clienteId } })
    proyecto = pr.body.id
    assert.deepEqual(await nuevos(await ultimo()), [], 'crear un proyecto no avisa (no se pidió)')

    const b2 = await ultimo()
    const t = await api('/tareas', { body: { titulo: 'Llamar a María', proyecto_id: proyecto }, key: KEY_J })
    assert.equal(t.status, 201)
    const e2 = await nuevos(b2)
    assert.equal(e2.length, 1)
    assert.equal(e2[0].texto, 'Jorbi añadió la tarea «Llamar a María» en Sistema Panadería')
    assert.equal(e2[0].tarea_id, t.body.id)
    assert.equal(e2[0].proyecto_id, proyecto)
    assert.equal(e2[0].cliente_id, clienteId)

    const b3 = await ultimo()
    const done = await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { estado: 'completada' } })
    assert.equal(done.status, 200)
    const e3 = await nuevos(b3)
    assert.deepEqual(e3.map((e) => e.texto), ['Leandro completó la tarea «Llamar a María» de Sistema Panadería'])
    // repetir "completada", reabrir, cambiar título o fecha: nada de eso avisa
    await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { estado: 'completada' } })
    await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { estado: 'pendiente' } })
    await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { titulo: 'Llamar a María otra vez', vence: '2026-12-01' } })
    assert.equal((await nuevos(b3)).length, 1)
    // completarla de nuevo después de reabrirla sí vuelve a avisar (es otro momento)
    await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { estado: 'completada' } })
    const e4 = await nuevos(b3)
    assert.equal(e4.length, 2)
    assert.equal(e4[1].sujeto, 'Llamar a María otra vez')
    assert.equal((await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { estado: 'pendiente' } })).status, 200)
  })

  it('lo que falla no avisa: validación, proyecto inexistente, tarea inexistente', async () => {
    const base = await ultimo()
    assert.equal((await api('/clientes', { body: { nombre: '' } })).status, 400)
    assert.equal((await api('/clientes', { body: { nombre: 'Falla', cobros: [{ fecha: '2026-13-01', monto: 1, concepto: 'x' }] } })).status, 400)
    assert.equal((await api('/tareas', { body: { titulo: 'x', proyecto_id: NOPE } })).status, 404)
    assert.equal((await api(`/tareas/${NOPE}`, { method: 'PATCH', body: { estado: 'completada' } })).status, 404)
    assert.deepEqual(await nuevos(base), [])
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM clients WHERE name = 'Falla'")).rows[0].n, 0)
  })

  it('filtros y cursor: tipo, desde_id + orden=asc, paginación, validaciones', async () => {
    const todos = (await act('?per_page=100&orden=asc')).data as any[]
    assert.ok(todos.length >= 6)
    assert.deepEqual(todos.map((e) => e.id), [...todos.map((e) => e.id)].sort((a, b) => a - b))
    const soloTareas = (await act('?tipo=tarea_completada&per_page=100')).data as any[]
    assert.ok(soloTareas.length >= 2 && soloTareas.every((e) => e.tipo === 'tarea_completada'))
    const mitad = todos[2].id
    assert.ok((await nuevos(mitad)).every((e) => e.id > mitad))
    const p1 = (await act('?per_page=2&page=1')).data
    const p2 = (await act('?per_page=2&page=2')).data
    assert.equal(p1.length, 2)
    assert.ok(p1[1].id > p2[0].id, 'descendente: la página 2 es más vieja')
    for (const q of ['?tipo=otro', '?orden=raro', '?desde_id=abc', '?desde_id=-1', '?per_page=0', '?per_page=101'])
      assert.equal((await api(`/actividad${q}`)).status, 400, q)
  })

  it('"visto hasta": hasta_id y todas mueven el cursor, nunca retroceden ni pasan del último; cada socio el suyo', async () => {
    const last = await ultimo()
    const before = (await act('', KEY_J)).meta
    assert.ok(before.sin_leer >= 1)
    const parcial = await api('/actividad/leer', { body: { hasta_id: before.visto_hasta + 1 }, key: KEY_J })
    assert.equal(parcial.body.visto_hasta, before.visto_hasta + 1)
    const atras = await api('/actividad/leer', { body: { hasta_id: 0 }, key: KEY_J })
    assert.equal(atras.body.visto_hasta, before.visto_hasta + 1, 'no retrocede')
    const lejos = await api('/actividad/leer', { body: { hasta_id: 999999999 }, key: KEY_J })
    assert.equal(lejos.body.visto_hasta, last, 'no pasa del último id real')
    assert.equal(lejos.body.sin_leer, 0)
    // Leandro no se movió
    const base = await ultimo()
    const sinLeerAntes = (await act('')).meta.sin_leer // lo que Jorbi hizo antes también cuenta: su cursor no se movió con el de Jorbi
    await api('/tareas', { body: { titulo: 'Para Leandro', proyecto_id: proyecto }, key: KEY_J })
    assert.equal((await act('')).meta.sin_leer, sinLeerAntes + 1, 'Leandro ve la de Jorbi como sin leer')
    const all = await api('/actividad/leer', { body: { todas: true } })
    assert.equal(all.body.sin_leer, 0)
    assert.equal(all.body.visto_hasta, base + 1)
    for (const body of [{}, { hasta_id: 1, todas: true }, { todas: false }, { hasta_id: -1 }, { hasta_id: 1.5 }, { otra: 1 }])
      assert.equal((await api('/actividad/leer', { body })).status, 400, JSON.stringify(body))
  })

  it('el aviso sobrevive a que borren el cliente (queda sin enlace útil, pero el texto está) y no cuenta tareas de otros ámbitos', async () => {
    const base = await ultimo()
    const c = (await api('/clientes', { body: { nombre: 'Actividad Efímero' } })).body.id
    await apiD(`/clientes/${c}`, { method: 'DELETE' })
    const ev = await nuevos(base)
    assert.equal(ev.length, 1)
    assert.equal(ev[0].cliente_id, c)
    assert.equal(ev[0].texto, 'Leandro añadió un cliente nuevo: Actividad Efímero')
  })

  it('permisos: lectura puede listar, solo escritura mueve el cursor; sin llave 401', async () => {
    const ro = newKey('Leandro', 'solo-lectura-actividad', 'read')
    assert.equal((await api('/actividad', { key: ro })).status, 200)
    assert.equal((await api('/actividad/leer', { key: ro, body: { todas: true } })).status, 403)
    assert.equal((await api('/actividad', { key: null })).status, 401)
  })

  it('MCP: hayai_actividad_listar y hayai_actividad_marcar_leida, mismo resultado que REST', async () => {
    const rpc = (name: string, args: unknown, key = KEY) =>
      http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    const m = JSON.parse((await rpc('hayai_actividad_listar', { per_page: 3 })).body.result.content[0].text)
    const rest = await act('?per_page=3')
    assert.deepEqual(m, rest)
    const r = JSON.parse((await rpc('hayai_actividad_marcar_leida', { todas: true })).body.result.content[0].text)
    assert.equal(r.sin_leer, 0)
    const bad = (await rpc('hayai_actividad_listar', { tipo: 'nada' })).body.result
    assert.equal(bad.isError, true)
  })

  it('cobros y pipeline avisan: cobro cobrado, cambio de etapa, ganado y perdido (texto con el dueño de la llave, una sola vez)', async () => {
    const c = (await api('/clientes', { body: { nombre: 'Aviso Cobros', cobros: [{ fecha: isoDay(-1), monto: 120, concepto: 'Mensualidad' }, { fecha: isoDay(5), monto: 50.5, concepto: 'Extra' }] } })).body
    const pagos = c.movimientos.filter((m: any) => m.tipo === 'pago')
    const base = await ultimo()
    // marcar cobrado avisa; repetirlo no (ya estaba cobrado); cambiar el concepto de uno pendiente tampoco
    assert.equal((await api(`/pagos/${pagos[0].id}`, { method: 'PATCH', body: { estado: 'cobrado' } })).status, 200)
    await api(`/pagos/${pagos[0].id}`, { method: 'PATCH', body: { estado: 'cobrado' } })
    await api(`/pagos/${pagos[1].id}`, { method: 'PATCH', body: { concepto: 'Extra 2' } })
    let ev = await nuevos(base)
    assert.deepEqual(ev.map((e) => e.tipo), ['cobro_cobrado'])
    assert.equal(ev[0].texto, 'Leandro registró el cobro de $120 a Aviso Cobros')
    assert.equal(ev[0].cliente_id, c.id)
    // "marcar cobrado" por la herramienta dedicada y un cobro creado ya cobrado también avisan, con decimales
    const b2 = await ultimo()
    const mcp = (name: string, args: unknown) =>
      http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    assert.equal((await mcp('hayai_pago_marcar_cobrado', { id: pagos[1].id })).body.result.isError, undefined)
    ev = await nuevos(b2)
    assert.equal(ev[0]?.texto, 'Leandro registró el cobro de $50,50 a Aviso Cobros')
    const b3 = await ultimo()
    await api(`/clientes/${c.id}/pagos`, { body: { fecha: isoDay(0), monto: 10, concepto: 'Suelto', estado: 'cobrado' } })
    assert.equal((await nuevos(b3))[0]?.texto, 'Leandro registró el cobro de $10 a Aviso Cobros')

    // etapas: cada cambio avisa "movió a X (De → A)"; ganar y perder tienen su propio texto
    const p = await mkPosible('Aviso Etapas')
    const b4 = await ultimo()
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'visita_agendada' } })
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'visita_agendada' } }) // sin cambio: no avisa
    ev = await nuevos(b4)
    assert.deepEqual(ev.map((e) => e.texto), ['Leandro movió a Aviso Etapas (Prospecto captado → Visita agendada)'])
    assert.equal(ev[0].tipo, 'cambio_etapa')
    const b5 = await ultimo()
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(2) } })
    ev = await nuevos(b5)
    assert.deepEqual(ev.map((e) => [e.tipo, e.texto]), [['cliente_ganado', 'Leandro ganó a Aviso Etapas: ya es cliente']])
    const l = await mkPosible('Aviso Perdido')
    const b6 = await ultimo()
    assert.equal((await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'perdido' } })).status, 400)
    assert.deepEqual(await nuevos(b6), [], 'una etapa rechazada no deja aviso')
    await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Precio' } })
    ev = await nuevos(b6)
    assert.deepEqual(ev.map((e) => [e.tipo, e.texto]), [['cliente_perdido', 'Leandro marcó como perdido a Aviso Perdido (Precio)']])
    const { rows } = await admin.query("SELECT via FROM activity WHERE kind = 'cliente_perdido' ORDER BY id DESC LIMIT 1")
    assert.equal(rows[0].via, 'api:growi')
  })
})

describe('Actividad en vivo (web: sesión + SSE)', () => {
  type Sess = { cookie: string; user: string }
  const sessions: Record<string, Sess> = {}
  const login = async (name: string, pin: string) => {
    const r = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, pin }) })
    assert.equal(r.status, 200, `login ${name}`)
    return r.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
  }
  const web = (who: string, path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie: sessions[who].cookie }, ...o })

  /** Abre el stream y devuelve utilidades para esperar eventos concretos. */
  async function stream(who: string, headers: Record<string, string> = {}, query = '') {
    const ac = new AbortController()
    const res = await fetch(`${ROOT}/api/events${query}`, { headers: { cookie: sessions[who].cookie, ...headers }, signal: ac.signal })
    const events: any[] = []
    const ids: string[] = []
    let raw = ''
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          raw += dec.decode(value, { stream: true })
          let i: number
          while ((i = raw.indexOf('\n\n')) >= 0) {
            const block = raw.slice(0, i)
            raw = raw.slice(i + 2)
            const data = block.split('\n').find((l) => l.startsWith('data: '))
            if (data) {
              events.push(JSON.parse(data.slice(6)))
              ids.push(block.split('\n').find((l) => l.startsWith('id: '))!.slice(4))
            }
          }
        }
      } catch {
        /* abortado */
      }
    })()
    const waitFor = async (pred: (e: any) => boolean, ms = 4000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const e = events.find(pred)
        if (e) return e
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`no llegó el evento a tiempo; llegaron: ${JSON.stringify(events.map((e) => e.texto))}`)
    }
    return { res, events, ids, waitFor, close: () => ac.abort() }
  }

  before(async () => {
    sessions.Jorbi = { cookie: await login('Jorbi', '482913'), user: 'Jorbi' } // PIN que dejó la suite de llaves
    sessions.Elis = { cookie: await login('Elis', '713904'), user: 'Elis' } // PIN que dejó la suite del CRM web
  })

  it('exige sesión; cabeceras de stream sin caché ni transformación', async () => {
    assert.equal((await http(`${ROOT}/api/events`).catch((e) => e)).status, 401)
    const s = await stream('Jorbi')
    assert.equal(s.res.status, 200)
    assert.match(s.res.headers.get('content-type')!, /^text\/event-stream/)
    assert.match(s.res.headers.get('cache-control')!, /no-cache/)
    assert.match(s.res.headers.get('cache-control')!, /no-transform/)
    s.close()
  })

  it('lo que otro socio hace por API llega en vivo a las pestañas abiertas, con propia=false; lo propio llega con propia=true', async () => {
    const jorbi = await stream('Jorbi')
    const elis = await stream('Elis')
    await new Promise((r) => setTimeout(r, 150)) // que ambas queden suscritas
    const c = await api('/clientes', { body: { nombre: 'En Vivo SA' } }) // Leandro, por llave
    const a = await jorbi.waitFor((e) => e.sujeto === 'En Vivo SA')
    const b = await elis.waitFor((e) => e.sujeto === 'En Vivo SA')
    assert.equal(a.texto, 'Leandro añadió un cliente nuevo: En Vivo SA')
    assert.equal(a.propia, false)
    assert.equal(b.propia, false)
    assert.equal(a.cliente_id, c.body.id)
    assert.equal(a.id, b.id)
    // Jorbi crea algo por la web: a él le llega propia=true (la UI no le muestra popup) y a Elis propia=false
    const p = await web('Jorbi', '/prospects', { body: { name: 'Prospecto En Vivo', avatar: 'nova', project: { name: 'Web', icon: 'box', owner: 'Elis' } } })
    assert.equal(p.status, 201)
    const own = await jorbi.waitFor((e) => e.sujeto === 'Prospecto En Vivo')
    const other = await elis.waitFor((e) => e.sujeto === 'Prospecto En Vivo')
    assert.equal(own.propia, true)
    assert.equal(other.propia, false)
    assert.equal(other.texto, 'Jorbi añadió un posible cliente: Prospecto En Vivo')
    assert.equal(other.actor.nombre, 'Jorbi')
    assert.equal(jorbi.events.filter((e) => e.sujeto === 'Prospecto En Vivo').length, 1, 'un solo evento por el alta completa')
    // tarea nueva y completada por la web
    const t = await web('Elis', '/tasks', { body: { projectId: p.body.project.id, title: 'Visitar en vivo' } })
    await jorbi.waitFor((e) => e.tipo === 'tarea_nueva' && e.sujeto === 'Visitar en vivo' && e.propia === false)
    await web('Elis', `/tasks/${t.body.id}`, { method: 'PATCH', body: { done: true } })
    const done = await jorbi.waitFor((e) => e.tipo === 'tarea_completada' && e.sujeto === 'Visitar en vivo')
    assert.equal(done.texto, 'Elis completó la tarea «Visitar en vivo» de Web')
    await web('Elis', `/tasks/${t.body.id}`, { method: 'PATCH', body: { done: true } }) // repetir no avisa de nuevo
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(jorbi.events.filter((e) => e.tipo === 'tarea_completada' && e.sujeto === 'Visitar en vivo').length, 1)
    jorbi.close()
    elis.close()
  })

  it('al reconectar con Last-Event-ID se reenvía lo perdido (y solo eso)', async () => {
    const first = await stream('Jorbi')
    await new Promise((r) => setTimeout(r, 100))
    await api('/clientes', { body: { nombre: 'Antes de caer' } })
    const e1 = await first.waitFor((e) => e.sujeto === 'Antes de caer')
    first.close() // se "cae" la pestaña
    await api('/clientes', { body: { nombre: 'Mientras estaba caída 1' } })
    await api('/clientes', { body: { nombre: 'Mientras estaba caída 2' } })
    const back = await stream('Jorbi', { 'last-event-id': String(e1.id) })
    await back.waitFor((e) => e.sujeto === 'Mientras estaba caída 2')
    assert.deepEqual(back.events.map((e) => e.sujeto).filter((s) => s.startsWith('M') || s === 'Antes de caer'), ['Mientras estaba caída 1', 'Mientras estaba caída 2'])
    assert.ok(back.events.every((e) => e.id > e1.id))
    back.close()
    // también por ?desde_id= (para clientes que no pueden poner cabeceras)
    const q = await stream('Jorbi', {}, `?desde_id=${e1.id}`)
    await q.waitFor((e) => e.sujeto === 'Mientras estaba caída 2')
    q.close()
  })

  it('las rutas web de la lista y el visto hasta usan el mismo servicio que la API', async () => {
    const list = await web('Jorbi', '/activity?per_page=3')
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.data.length, 3)
    assert.ok(typeof list.body.meta.sin_leer === 'number' && typeof list.body.meta.ultimo_id === 'number')
    const ok = await web('Jorbi', '/activity/read', { body: { todas: true } })
    assert.equal(ok.body.sin_leer, 0)
    assert.equal((await web('Jorbi', '/activity/read', { body: {} })).status, 400)
    assert.equal((await web('Jorbi', '/activity?desde_id=0&orden=asc&per_page=1')).body.data.length, 1)
    assert.equal((await http(`${ROOT}/api/activity`)).status, 401)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fase 1.5-A: pipeline en tabla, propuestas, ficha ampliada, proyectos con hitos/checklist y leads de Meta.
// ---------------------------------------------------------------------------------------------------------------------
const items3 = (mensual = 40) => [
  { tipo: 'mensualidad', concepto: 'Mostrador POS', precio_unitario: mensual },
  { tipo: 'extra_mensual', concepto: 'Lector de barras (renta)', cantidad: 2, precio_unitario: 5 },
  { tipo: 'extra_unico', concepto: 'Impresora', precio_unitario: 120 },
]
const mkProp = async (nombre: string, mensual = 40) => {
  const c = await mkPosible(nombre)
  const r = await api(`/clientes/${c.id}/propuestas`, { body: { items: items3(mensual) } })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { c, p: r.body as any }
}

const data = (r: any) => JSON.parse(r.content[0].text)

describe('1.5: pipeline y propuestas', () => {
  it('GET /pipeline/etapas: las 7 etapas con su probabilidad', async () => {
    const r = await api('/pipeline/etapas')
    assert.equal(r.status, 200)
    assert.deepEqual(
      r.body.data.map((e: any) => [e.etapa, e.probabilidad, e.tipo]),
      [['prospecto', 10, 'abierta'], ['visita_agendada', 20, 'abierta'], ['visita_realizada', 35, 'abierta'], ['propuesta_en_armado', 50, 'abierta'], ['propuesta_presentada', 70, 'abierta'], ['ganado', 100, 'ganada'], ['perdido', 0, 'perdida']],
    )
  })

  it('propuesta: mensualidad base + extras, totales exactos y valor_estimado = la mensualidad; versiones que reemplazan', async () => {
    const { c, p } = await mkProp('Prop Uno')
    assert.equal(p.version, 1)
    assert.equal(p.estado, 'borrador')
    assert.deepEqual(p.totales, { mensual: 50, unico: 120 })
    assert.deepEqual(p.items.map((i: any) => [i.tipo, i.cantidad, i.subtotal]), [['mensualidad', 1, 40], ['extra_mensual', 2, 10], ['extra_unico', 1, 120]])
    const det = (await api(`/clientes/${c.id}`)).body
    assert.equal(det.valor_estimado, 50)
    assert.equal(det.valor_ponderado, 5, 'pipeline pondera la mensualidad (10 % de 50)')
    assert.equal(det.propuesta_vigente.id, p.id)
    assert.equal((await api(`/clientes/${c.id}`, { method: 'PATCH', body: { valor_estimado: 99 } })).status, 400, 'con propuesta el valor sale de ella')

    const v2 = await api(`/clientes/${c.id}/propuestas`, { body: { items: items3(60), notas: 'Segunda ronda' } })
    assert.equal(v2.status, 201)
    assert.equal(v2.body.version, 2)
    assert.equal((await api(`/propuestas/${p.id}`)).body.estado, 'reemplazada')
    assert.equal((await api(`/clientes/${c.id}`)).body.valor_estimado, 70)
    const list = (await api(`/clientes/${c.id}/propuestas`)).body.data
    assert.deepEqual(list.map((x: any) => [x.version, x.estado, x.vigente]), [[2, 'borrador', true], [1, 'reemplazada', false]])
    // editar la viva recalcula; la reemplazada ya no se edita
    const up = await api(`/propuestas/${v2.body.id}`, { method: 'PATCH', body: { items: items3(80) } })
    assert.equal(up.status, 200, JSON.stringify(up.body))
    assert.equal((await api(`/clientes/${c.id}`)).body.valor_estimado, 90)
    assert.equal((await api(`/propuestas/${p.id}`, { method: 'PATCH', body: { notas: 'x' } })).status, 409)
  })

  it('propuesta: validaciones (una sola mensualidad, precios, ofertas, también para clientes activos)', async () => {
    const c = await mkPosible('Prop Valida')
    const post = (items: unknown) => api(`/clientes/${c.id}/propuestas`, { body: { items } })
    assert.equal((await post([])).status, 400)
    assert.equal((await post([{ tipo: 'extra_unico', concepto: 'x', precio_unitario: 1 }])).status, 400, 'sin mensualidad')
    assert.equal((await post([{ tipo: 'mensualidad', concepto: 'a', precio_unitario: 1 }, { tipo: 'mensualidad', concepto: 'b', precio_unitario: 1 }])).status, 400, 'dos mensualidades')
    assert.equal((await post([{ tipo: 'mensualidad', concepto: 'a' }])).status, 400, 'sin precio')
    assert.equal((await post([{ tipo: 'mensualidad', precio_unitario: 5 }])).status, 400, 'sin concepto')
    assert.equal((await post([{ tipo: 'mensualidad', concepto: 'a', precio_unitario: 1.234 }])).status, 400, 'tres decimales')
    assert.equal((await post([{ tipo: 'mensualidad', concepto: 'a', precio_unitario: 5, cantidad: 0 }])).status, 400)
    assert.equal((await post([{ tipo: 'mensualidad', oferta_id: NOPE, precio_unitario: 5 }])).status, 404)
    assert.equal((await api(`/clientes/${NOPE}/propuestas`, { body: { items: items3() } })).status, 404)
    const cli = (await api('/clientes', { body: { nombre: 'Prop Activo' } })).body
    const up = await api(`/clientes/${cli.id}/propuestas`, { body: { items: items3() } })
    assert.equal(up.status, 201, 'un cliente activo también recibe propuestas (ampliación)')
    assert.equal((await api(`/clientes/${cli.id}`)).body.valor_estimado ?? null, null, 'en un cliente activo no toca el valor estimado del pipeline')
  })

  it('catálogo de ofertas: sembrado, se usa para armar propuestas, y desactivar no rompe lo ya armado', async () => {
    const seed = (await api('/ofertas')).body.data
    assert.deepEqual(seed.map((o: any) => o.clave).sort(), ['automatizaciones', 'el_chasis', 'mostrador_pos', 'sistemas_whatsapp'])
    const o = await api('/ofertas', { body: { clave: 'pos_prueba', nombre: 'POS de prueba', tipo: 'sistema', mensualidad_sugerida: 35, instalacion_sugerida: 90.5 } })
    assert.equal(o.status, 201, JSON.stringify(o.body))
    assert.equal((await api('/ofertas', { body: { clave: 'pos_prueba', nombre: 'Otra', tipo: 'sistema' } })).status, 409, 'clave repetida')
    assert.equal((await api('/ofertas', { body: { clave: 'Mala Clave', nombre: 'x', tipo: 'sistema' } })).status, 400)
    const c = await mkPosible('Prop Oferta')
    const pr = await api(`/clientes/${c.id}/propuestas`, {
      body: { items: [{ tipo: 'mensualidad', oferta_id: o.body.id }, { tipo: 'extra_unico', oferta_id: o.body.id, cantidad: 2 }] },
    })
    assert.equal(pr.status, 201, JSON.stringify(pr.body))
    assert.deepEqual(pr.body.items.map((i: any) => [i.concepto, i.precio_unitario, i.oferta]), [['POS de prueba', 35, 'POS de prueba'], ['POS de prueba', 90.5, 'POS de prueba']])
    assert.deepEqual(pr.body.totales, { mensual: 35, unico: 181 })
    const upd = await api(`/ofertas/${o.body.id}`, { method: 'PATCH', body: { mensualidad_sugerida: null, descripcion: 'Con nota' } })
    assert.equal(upd.body.mensualidad_sugerida, null)
    assert.equal((await api(`/ofertas/${o.body.id}`, { method: 'DELETE' })).status, 403, 'desactivar pide permiso de borrado')
    const off = await apiD(`/ofertas/${o.body.id}`, { method: 'DELETE' })
    assert.equal(off.body.activa, false)
    assert.ok(!(await api('/ofertas')).body.data.some((x: any) => x.id === o.body.id), 'las desactivadas no salen por defecto')
    assert.equal((await api(`/clientes/${c.id}/propuestas`, { body: { items: [{ tipo: 'mensualidad', oferta_id: o.body.id }] } })).status, 409, 'oferta desactivada')
    assert.equal((await api(`/propuestas/${pr.body.id}`)).body.items[0].concepto, 'POS de prueba', 'lo ya armado se conserva')
  })

  it('propuesta_presentada exige una propuesta y la marca presentada; el aviso de etapa sale una vez', async () => {
    const sin = await mkPosible('Prop Sin')
    assert.equal((await api(`/clientes/${sin.id}`, { method: 'PATCH', body: { etapa: 'propuesta_presentada' } })).status, 400)
    assert.equal((await api(`/clientes/${sin.id}`, { method: 'PATCH', body: { etapa: 'negociacion' } })).status, 400, 'el alias viejo tampoco se salta la regla')
    const { c, p } = await mkProp('Prop Presenta')
    const r = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'propuesta_presentada' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.probabilidad, 70)
    assert.equal(r.body.valor_ponderado, 35, '70 % de 50')
    const pv = (await api(`/propuestas/${p.id}`)).body
    assert.equal(pv.estado, 'presentada')
    assert.ok(pv.presentada_el)
    assert.equal((await api(`/propuestas/${p.id}`, { method: 'PATCH', body: { notas: 'Ajuste tras la visita' } })).status, 200, 'presentada aún se negocia')
  })

  it('ganar con propuesta: exige esquema_cobro y genera mensualidades y pagos únicos; la propuesta queda aceptada', async () => {
    const { c, p } = await mkProp('Prop Gana')
    const g = (body: Record<string, unknown>) => api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(3), ...body } })
    assert.equal((await g({})).status, 400, 'con propuesta vigente hace falta esquema_cobro')
    assert.equal((await g({ esquema_cobro: { inicio_cobro: isoDay(10), meses: 1 } })).status, 400, 'meses 2 a 36')
    assert.equal((await g({ esquema_cobro: { inicio_cobro: isoDay(10), meses: 3, extra: 1 } })).status, 400)
    const ok = await g({ esquema_cobro: { inicio_cobro: isoDay(10), meses: 3, unicos_cobrados: false } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.estado, 'activo')
    assert.equal(ok.body.fecha_implementacion, isoDay(3))
    const pagos = ok.body.movimientos.filter((m: any) => m.tipo === 'pago')
    assert.deepEqual(pagos.map((m: any) => [m.concepto, m.monto, m.estado]).sort(), [['Implementación y extras', 120, 'pendiente'], ['Mensualidad 1/3', 50, 'pendiente'], ['Mensualidad 2/3', 50, 'pendiente'], ['Mensualidad 3/3', 50, 'pendiente']])
    assert.equal(ok.body.valor_estimado, 50)
    assert.equal(ok.body.propuesta_vigente.estado, 'aceptada')
    assert.equal((await api(`/propuestas/${p.id}`)).body.estado, 'aceptada')
    assert.equal((await api(`/propuestas/${p.id}`, { method: 'PATCH', body: { notas: 'x' } })).status, 409, 'aceptada ya no se edita')
    assert.equal((await api(`/clientes/${c.id}/propuestas`, { body: { items: items3() } })).status, 201, 'ya cliente: una ampliación es una propuesta nueva')
  })

  it('ganar con propuesta y unicos_cobrados: lo único entra como la inicial, ya cobrado, con su desglose', async () => {
    const { c } = await mkProp('Prop Gana Inicial')
    const r = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(0), esquema_cobro: { inicio_cobro: isoDay(30), unicos_cobrados: true } } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const ini = r.body.movimientos.filter((m: any) => m.tipo === 'inicial')
    assert.deepEqual(ini.map((m: any) => [m.monto, m.estado]), [[120, 'cobrado']])
    assert.deepEqual(r.body.items.map((i: any) => [i.concepto, i.monto]), [['Impresora', 120]])
    assert.equal(r.body.movimientos.filter((m: any) => m.concepto.startsWith('Mensualidad')).length, 12, 'meses por defecto: 12')
  })

  it('ganar sin propuesta: exige fecha_implementacion, no admite esquema_cobro; perder con propuesta la rechaza y reabrir permite otra versión', async () => {
    const s = await mkPosible('Prop Sin Gana', { valor_estimado: 300 })
    const body = { etapa: 'ganado', fecha_implementacion: isoDay(1) }
    assert.equal((await api(`/clientes/${s.id}`, { method: 'PATCH', body: { ...body, esquema_cobro: { inicio_cobro: isoDay(5) } } })).status, 400)
    const ok = await api(`/clientes/${s.id}`, { method: 'PATCH', body })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.movimientos.length, 0, 'sin propuesta no se inventan cobros')

    const { c, p } = await mkProp('Prop Pierde')
    const lost = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'Precio' } })
    assert.equal(lost.status, 200, JSON.stringify(lost.body))
    assert.equal((await api(`/propuestas/${p.id}`)).body.estado, 'rechazada')
    const re = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'visita_realizada' } })
    assert.equal(re.status, 200)
    const v2 = await api(`/clientes/${c.id}/propuestas`, { body: { items: items3(45) } })
    assert.equal(v2.body.version, 2)
  })

  it('visitas: fecha_visita crea la tarea (y su proyecto) y reprograma sin duplicar; resumen_visita queda en la bitácora', async () => {
    const c = await mkPosible('Visita Cli')
    const mv = (body: Record<string, unknown>) => api(`/clientes/${c.id}`, { method: 'PATCH', body })
    assert.equal((await mv({ fecha_visita: isoDay(4) })).status, 400, 'fecha_visita solo con visita_agendada')
    assert.equal((await mv({ etapa: 'visita_agendada', fecha_visita: isoDay(4) })).status, 200)
    const tareas = () => api('/tareas?per_page=100').then((r) => r.body.data.filter((t: any) => t.titulo === 'Visita a Visita Cli'))
    let t = await tareas()
    assert.equal(t.length, 1)
    assert.equal(t[0].vence, isoDay(4))
    await mv({ etapa: 'prospecto' })
    await mv({ etapa: 'visita_agendada', fecha_visita: isoDay(6) })
    t = await tareas()
    assert.equal(t.length, 1, 'reprogramar no duplica')
    assert.equal(t[0].vence, isoDay(6))
    assert.equal((await mv({ etapa: 'visita_realizada', resumen_visita: 'Quiere POS y lector' })).status, 200)
    const feed = (await api(`/clientes/${c.id}/interacciones?tipo=visita`)).body.data
    assert.equal(feed[0].resumen, 'Quiere POS y lector')
    assert.equal((await mv({ etapa: 'propuesta_en_armado', resumen_visita: 'x' })).status, 400, 'resumen_visita solo con visita_realizada')
  })

  it('ficha: redes (normaliza @usuario, una por tipo, https), fecha_implementacion; la web lo ve igual', async () => {
    const c = await mkPosible('Redes Cli')
    const patch = (body: unknown) => api(`/clientes/${c.id}`, { method: 'PATCH', body })
    const ok = await patch({ redes: [{ red: 'instagram', url: '@panaderia.luna' }, { red: 'web', url: 'https://luna.com' }, { red: 'otra', url: 'https://t.me/luna' }], fecha_implementacion: isoDay(20) })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual(ok.body.redes, [{ red: 'instagram', url: 'https://instagram.com/panaderia.luna' }, { red: 'web', url: 'https://luna.com/' }, { red: 'otra', url: 'https://t.me/luna' }])
    assert.equal(ok.body.fecha_implementacion, isoDay(20))
    for (const redes of [
      [{ red: 'instagram', url: '@a' }, { red: 'instagram', url: '@b' }],
      [{ red: 'web', url: 'http://inseguro.com' }],
      [{ red: 'web', url: 'no es url' }],
      [{ red: 'myspace', url: 'https://x.com' }],
      Array.from({ length: 9 }, (_, i) => ({ red: 'otra', url: `https://r${i}.com` })),
    ])
      assert.equal((await patch({ redes })).status, 400, JSON.stringify(redes).slice(0, 80))
    assert.equal((await patch({ redes: [] })).body.redes.length, 0, '[] las quita todas')
    assert.equal((await patch({ fecha_implementacion: null })).body.fecha_implementacion, null)
  })

  it('MCP: propuestas, ofertas y etapas llegan por las mismas rutas de servicio', async () => {
    const rpc = (name: string, args: unknown) =>
      http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    const call = async (name: string, args: unknown) => {
      const r = await rpc(name, args)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      return r.body.result
    }
    const c = data(await call('hayai_cliente_crear', { nombre: 'MCP Propuesta', estado: 'posible', redes: [{ red: 'tiktok', url: '@mcp' }] }))
    assert.equal(c.redes[0].url, 'https://tiktok.com/@mcp')
    const p = data(await call('hayai_propuesta_crear', { cliente_id: c.id, items: items3(25) }))
    assert.deepEqual(p.totales, { mensual: 35, unico: 120 })
    assert.equal(data(await call('hayai_propuestas_listar', { cliente_id: c.id })).data.length, 1)
    assert.equal(data(await call('hayai_propuesta_ver', { id: p.id })).id, p.id)
    assert.equal(data(await call('hayai_pipeline_etapas', {})).data.length, 7)
    assert.ok(data(await call('hayai_ofertas_listar', {})).data.length >= 4)
    const bad = await call('hayai_propuesta_crear', { cliente_id: c.id, items: [{ tipo: 'extra_unico', concepto: 'x', precio_unitario: 1 }] })
    assert.equal(bad.isError, true)
  })
})

describe('1.5: proyectos sin cliente, hitos y checklist', () => {
  let interno = ''
  let hitos: string[] = []

  it('proyecto interno (sin cliente), descripción y estados nuevos; desvincular y re-vincular cliente', async () => {
    const r = await api('/proyectos', { body: { nombre: 'Interno HAYAI', descripcion: 'Automatizar el CRM', estado: 'pausado' } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    interno = r.body.id
    assert.equal(r.body.cliente, null)
    assert.equal(r.body.cliente_id, null)
    assert.equal(r.body.descripcion, 'Automatizar el CRM')
    assert.equal(r.body.estado, 'pausado')
    assert.ok((await api('/proyectos?sin_cliente=true&per_page=100')).body.data.some((p: any) => p.id === interno))
    assert.ok(!(await api('/proyectos?sin_cliente=false&per_page=100')).body.data.some((p: any) => p.id === interno))
    assert.equal((await api(`/proyectos/${interno}`, { method: 'PATCH', body: { estado: 'completado' } })).body.estado, 'completado')
    assert.equal((await api(`/proyectos/${interno}`, { method: 'PATCH', body: { estado: 'invalido' } })).status, 400)
    const linked = await api(`/proyectos/${interno}`, { method: 'PATCH', body: { cliente_id: karelys, descripcion: null } })
    assert.equal(linked.body.cliente_id, karelys)
    assert.equal(linked.body.descripcion, null)
    const back = await api(`/proyectos/${interno}`, { method: 'PATCH', body: { cliente_id: null } })
    assert.equal(back.body.cliente, null)
    assert.equal((await api('/proyectos', { body: { nombre: 'x', cliente_id: NOPE } })).status, 404)
    // aparece en la búsqueda y sus tareas en la lista, aunque no tenga cliente
    assert.ok((await api('/buscar?q=Interno HAYAI')).body.proyectos.some((p: any) => p.id === interno))
    const t = await api('/tareas', { body: { titulo: 'Tarea interna', proyecto_id: interno } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.ok((await api('/tareas?per_page=100')).body.data.some((x: any) => x.id === t.body.id))
  })

  it('hitos: crear con posición, validar, reordenar (todos o nada), tareas por hito, vistas del proyecto', async () => {
    const mk = async (titulo: string, extra: Record<string, unknown> = {}) => {
      const r = await api(`/proyectos/${interno}/hitos`, { body: { titulo, ...extra } })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      return r.body
    }
    const a = await mk('Diseño', { vence: isoDay(10) })
    const b = await mk('Backend', { estado: 'en_curso' })
    const c = await mk('Lanzamiento')
    hitos = [a.id, b.id, c.id]
    assert.deepEqual([a.posicion, b.posicion, c.posicion], [1, 2, 3])
    assert.equal(a.estado, 'pendiente')
    assert.equal((await api(`/proyectos/${interno}/hitos`, { body: { titulo: '' } })).status, 400)
    assert.equal((await api(`/proyectos/${interno}/hitos`, { body: { titulo: 'x', estado: 'listo' } })).status, 400)
    assert.equal((await api(`/proyectos/${NOPE}/hitos`, { body: { titulo: 'x' } })).status, 404)

    assert.equal((await api(`/proyectos/${interno}/hitos/orden`, { body: { ids: [c.id, a.id] } })).status, 400, 'faltan hitos')
    assert.equal((await api(`/proyectos/${interno}/hitos/orden`, { body: { ids: [c.id, a.id, a.id] } })).status, 400, 'repetidos')
    assert.equal((await api(`/proyectos/${interno}/hitos/orden`, { body: { ids: [c.id, a.id, NOPE] } })).status, 400, 'ajeno')
    const ord = await api(`/proyectos/${interno}/hitos/orden`, { body: { ids: [c.id, a.id, b.id] } })
    assert.equal(ord.status, 200, JSON.stringify(ord.body))
    assert.deepEqual(ord.body.data.map((h: any) => h.titulo), ['Lanzamiento', 'Diseño', 'Backend'])

    const upd = await api(`/hitos/${a.id}`, { method: 'PATCH', body: { estado: 'hecho', vence: null } })
    assert.equal(upd.body.estado, 'hecho')
    assert.equal(upd.body.vence, null)
    assert.equal((await api(`/hitos/${a.id}`, { method: 'PATCH', body: {} })).status, 400)

    // tareas por hito (del mismo proyecto)
    const t = await api('/tareas', { body: { titulo: 'Maquetar', proyecto_id: interno, hito_id: a.id } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.equal(t.body.hito_id, a.id)
    assert.equal(t.body.hito, 'Diseño')
    assert.equal((await api('/tareas', { body: { titulo: 'Ajena', proyecto_id: p1, hito_id: a.id } })).status, 400, 'hito de otro proyecto')
    assert.equal((await api('/tareas', { body: { titulo: 'Fantasma', proyecto_id: interno, hito_id: NOPE } })).status, 404)
    const byHito = await api(`/tareas?hito_id=${a.id}`)
    assert.deepEqual(byHito.body.data.map((x: any) => x.titulo), ['Maquetar'])
    const moved = await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { hito_id: b.id } })
    assert.equal(moved.body.hito, 'Backend')
    assert.equal((await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { hito_id: null } })).body.hito_id, null)
    await api(`/tareas/${t.body.id}`, { method: 'PATCH', body: { hito_id: a.id } })

    const det = (await api(`/proyectos/${interno}`)).body
    assert.deepEqual(det.hitos.map((h: any) => [h.titulo, h.estado, h.tareas.total]), [['Lanzamiento', 'pendiente', 0], ['Diseño', 'hecho', 1], ['Backend', 'en_curso', 0]])
    assert.deepEqual(det.hitos, [...det.hitos].sort((x: any, y: any) => x.posicion - y.posicion))
    assert.equal(det.lista_tareas.find((x: any) => x.id === t.body.id).hito_id, a.id)
    assert.deepEqual((await api(`/proyectos?sin_cliente=true`)).body.data.find((p: any) => p.id === interno).hitos, { total: 3, hechos: 1 })
  })

  it('borrar un hito lo manda a la papelera (sus tareas quedan sueltas); restaurar las vuelve a colgar', async () => {
    const a = hitos[0] // Diseño, con la tarea "Maquetar"
    const del = await apiD(`/hitos/${a}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal((await api('/tareas?per_page=100')).body.data.find((x: any) => x.titulo === 'Maquetar').hito_id, null)
    const item = (await api('/papelera?per_page=100')).body.data.find((x: any) => x.tipo === 'hito' && x.nombre === 'Diseño')
    assert.ok(item)
    const res = await api(`/papelera/${item.id}/restaurar`, { method: 'POST' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal((await api('/tareas?per_page=100')).body.data.find((x: any) => x.titulo === 'Maquetar').hito_id, a)
    assert.equal((await apiD(`/hitos/${NOPE}`, { method: 'DELETE' })).status, 404)
  })

  it('checklist: agregar, marcar hecho (hecho_el coherente), reordenar todos o nada, borrar y restaurar', async () => {
    const add = async (texto: string) => (await api(`/proyectos/${interno}/checklist`, { body: { texto } })).body
    const x = await add('Comprar dominio')
    const y = await add('Configurar DNS')
    assert.deepEqual([x.posicion, y.posicion, x.hecho], [1, 2, false])
    assert.equal((await api(`/proyectos/${interno}/checklist`, { body: { texto: '  ' } })).status, 400)
    const done = await api(`/checklist/${x.id}`, { method: 'PATCH', body: { hecho: true } })
    assert.equal(done.body.hecho, true)
    assert.ok(done.body.hecho_el)
    const undone = await api(`/checklist/${x.id}`, { method: 'PATCH', body: { hecho: false, texto: 'Comprar dominio .com.ve' } })
    assert.equal(undone.body.hecho_el, null)
    assert.equal(undone.body.texto, 'Comprar dominio .com.ve')
    assert.equal((await api(`/checklist/${x.id}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/proyectos/${interno}/checklist/orden`, { body: { ids: [y.id] } })).status, 400)
    const ord = await api(`/proyectos/${interno}/checklist/orden`, { body: { ids: [y.id, x.id] } })
    assert.deepEqual(ord.body.data.map((i: any) => i.texto), ['Configurar DNS', 'Comprar dominio .com.ve'])
    assert.deepEqual((await api(`/proyectos/${interno}`)).body.checklist.map((i: any) => i.id), [y.id, x.id])
    assert.deepEqual((await api(`/proyectos?sin_cliente=true`)).body.data.find((p: any) => p.id === interno).checklist, { total: 2, hechas: 0 })
    await apiD(`/checklist/${y.id}`, { method: 'DELETE' })
    assert.equal((await api(`/proyectos/${interno}`)).body.checklist.length, 1)
    const item = (await api('/papelera?per_page=100')).body.data.find((t: any) => t.tipo === 'checklist_item')
    assert.equal((await api(`/papelera/${item.id}/restaurar`, { method: 'POST' })).status, 200)
    assert.equal((await api(`/proyectos/${interno}`)).body.checklist.length, 2)
  })

  it('papelera: un cliente con propuestas, proyectos con hitos y checklist se restaura completo', async () => {
    const { c } = await mkProp('Papelera Completa')
    const pr = (await api('/proyectos', { body: { nombre: 'Proy Papelera', cliente_id: c.id } })).body
    const h = (await api(`/proyectos/${pr.id}/hitos`, { body: { titulo: 'Hito P' } })).body
    await api(`/proyectos/${pr.id}/checklist`, { body: { texto: 'Item P' } })
    await api('/tareas', { body: { titulo: 'Tarea P', proyecto_id: pr.id, hito_id: h.id } })
    const del = await apiD(`/clientes/${c.id}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.match(del.body.resumen, /1 propuesta/)
    assert.equal((await api(`/clientes/${c.id}`)).status, 404)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM proposals WHERE client_id = $1', [c.id])).rows[0].n, 0)
    const item = (await api('/papelera?per_page=100')).body.data.find((t: any) => t.tipo === 'cliente' && t.nombre === 'Papelera Completa')
    const res = await api(`/papelera/${item.id}/restaurar`, { method: 'POST' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const back = (await api(`/clientes/${c.id}`)).body
    assert.equal(back.propuesta_vigente.totales.mensual, 50)
    assert.equal(back.valor_estimado, 50)
    const proy = (await api(`/proyectos/${pr.id}`)).body
    assert.deepEqual([proy.hitos.length, proy.checklist.length, proy.lista_tareas[0].hito_id], [1, 1, h.id])
  })

  it('MCP: hitos, checklist y tareas por hito', async () => {
    const rpc = (name: string, args: unknown, key = KEY) =>
      http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
    const call = async (name: string, args: unknown, key = KEY) => {
      const r = await rpc(name, args, key)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      return r.body.result
    }
    const h = data(await call('hayai_hito_crear', { proyecto_id: interno, titulo: 'Desde MCP' }))
    assert.equal(h.estado, 'pendiente')
    assert.equal(data(await call('hayai_hito_actualizar', { id: h.id, estado: 'hecho' })).estado, 'hecho')
    const t = data(await call('hayai_tarea_crear', { titulo: 'MCP con hito', proyecto_id: interno, hito_id: h.id }))
    assert.equal(t.hito, 'Desde MCP')
    assert.equal(data(await call('hayai_tarea_actualizar', { id: t.id, hito_id: null })).hito_id, null)
    const k = data(await call('hayai_checklist_agregar', { proyecto_id: interno, texto: 'Item MCP' }))
    assert.equal(data(await call('hayai_checklist_actualizar', { id: k.id, hecho: true })).hecho, true)
    const det = data(await call('hayai_proyecto_ver', { id: interno }))
    assert.ok(det.hitos.some((x: any) => x.id === h.id) && det.checklist.some((x: any) => x.id === k.id))
    const ord = data(await call('hayai_hitos_ordenar', { proyecto_id: interno, ids: det.hitos.map((x: any) => x.id).reverse() }))
    assert.equal(ord.data[0].id, det.hitos[det.hitos.length - 1].id)
    const del = await call('hayai_hito_eliminar', { id: h.id }, KEY_D)
    assert.ok(!del.isError)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Meta Lead Ads: webhook firmado, Graph falso local, idempotencia, duplicados y reintentos.
// ---------------------------------------------------------------------------------------------------------------------
describe('Meta Lead Ads (webhook)', () => {
  const HOOK = `${ROOT}/api/webhooks/meta`
  const sign = (raw: string, secret = META_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
  const payload = (...ids: string[]) => JSON.stringify({ object: 'page', entry: [{ id: 'pg1', time: 1, changes: ids.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: 'pg1', form_id: 'f1', ad_id: 'a1' } })) }] })
  const post = async (raw: string, sig: string | null = sign(raw)) => {
    const r = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: raw })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const lead = (name: string, extra: Record<string, string> = {}, over: Record<string, unknown> = {}) => ({
    created_time: '2026-10-01T10:00:00+0000',
    campaign_name: 'Campaña Octubre',
    adset_name: 'Conjunto Lara',
    ad_name: 'Anuncio POS',
    field_data: [
      { name: 'full_name', values: [name] },
      ...Object.entries(extra).map(([k, v]) => ({ name: k, values: [v] })),
    ],
    ...over,
  })
  const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('tiempo agotado esperando al lead')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const status = async (id: string) => (await admin.query('SELECT status, client_id, attempts, error FROM meta_leads WHERE leadgen_id = $1', [id])).rows[0]
  const done = (id: string) => until(async () => {
    const r = await status(id)
    return r && (r.status === 'procesado' || r.status === 'duplicado') ? r : undefined
  })

  before(async () => {
    // pruebas anteriores crearon clientes con origen meta_ads a mano: aquí el reparto se cuenta desde cero
    await admin.query(`UPDATE clients SET lead_source = NULL WHERE lead_source = 'meta_ads'`)
  })

  it('la verificación de la suscripción responde el desafío solo con el token correcto', async () => {
    const q = (t: string) => fetch(`${HOOK}?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=abc123`)
    const ok = await q('verifica-123')
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'abc123')
    assert.equal((await q('otro-token')).status, 403)
    assert.equal((await fetch(`${HOOK}?hub.mode=subscribe`)).status, 400)
  })

  it('firma ausente, mala o de otro secreto: 401 y no se guarda nada', async () => {
    const raw = payload('firma-1')
    assert.equal((await post(raw, null)).status, 401)
    assert.equal((await post(raw, 'sha256=00')).status, 401)
    assert.equal((await post(raw, sign(raw, 'otro-secreto'))).status, 401)
    assert.equal((await post(raw, sign(raw + ' '))).status, 401, 'la firma es sobre los bytes exactos')
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM meta_leads WHERE leadgen_id = 'firma-1'`)).rows[0].n, 0)
  })

  it('un lead válido crea un posible cliente en "prospecto", sin proyecto ni tarea, con aviso para todos', async () => {
    graphLeads.set('lead-1', lead('Panadería La Espiga', { phone_number: '+58 414-1234567', email: 'Espiga@Correo.com', company_name: 'Panadería La Espiga', city: 'Barquisimeto', pregunta_interes: 'Quiero un POS' }))
    const owners0 = (await admin.query(`SELECT count(*)::int AS n FROM clients WHERE lead_source = 'meta_ads'`)).rows[0].n
    assert.equal(owners0, 0, 'ningún cliente de Meta antes de esta prueba')
    const proyectos = (await admin.query('SELECT count(*)::int AS n FROM projects')).rows[0].n
    const tareas = (await admin.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n
    const base = (await api('/actividad?per_page=1')).body.meta.ultimo_id
    const r = await post(payload('lead-1'))
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { recibidos: 1 })
    const row = await done('lead-1')
    assert.equal(row.status, 'procesado')
    const c = (await api(`/clientes/${row.client_id}`)).body
    assert.equal(c.nombre, 'Panadería La Espiga')
    assert.equal(c.estado, 'posible')
    assert.equal(c.etapa, 'prospecto')
    assert.equal(c.origen, 'meta_ads')
    assert.deepEqual(c.etiquetas, ['meta ads'])
    assert.equal(c.email, 'espiga@correo.com')
    assert.match(c.telefono, /414-1234567/)
    assert.match(c.notas, /Campaña: Campaña Octubre/)
    assert.match(c.notas, /pregunta interes: Quiero un POS/)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM projects')).rows[0].n, proyectos)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n, tareas)
    const ev = (await api(`/actividad?desde_id=${base}&orden=asc&per_page=100`)).body.data.filter((e: any) => e.tipo === 'lead_meta')
    assert.equal(ev.length, 1)
    assert.match(ev[0].texto, /^Llegó un posible cliente de Meta Ads: Panadería La Espiga/)
    assert.equal(ev[0].cliente_id, row.client_id)
    // llega como no leído a TODOS, también a quien quedó como responsable
    for (const k of [KEY, KEY_J]) {
      const mine = (await api(`/actividad?desde_id=${base}&orden=asc&per_page=100`, { key: k })).body.data.find((e: any) => e.tipo === 'lead_meta')
      assert.equal(mine.propia, false)
      assert.equal(mine.leida, false)
    }
    assert.ok(['Elis', 'Jorbi'].includes((await admin.query('SELECT u.name FROM clients c JOIN users u ON u.id = c.created_by WHERE c.id = $1', [row.client_id])).rows[0].name))
  })

  it('idempotente: Meta reintenta el mismo webhook y no nace otro cliente ni otro aviso', async () => {
    const antes = (await admin.query(`SELECT count(*)::int AS n FROM clients WHERE lead_source = 'meta_ads'`)).rows[0].n
    const hits = graphHits.filter((h) => h === 'lead-1').length
    const r = await post(payload('lead-1', 'lead-1'))
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { recibidos: 0 })
    await new Promise((ok) => setTimeout(ok, 500))
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients WHERE lead_source = 'meta_ads'`)).rows[0].n, antes)
    assert.equal(graphHits.filter((h) => h === 'lead-1').length, hits, 'ni siquiera vuelve a pedirlo a Graph')
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM activity WHERE kind = 'lead_meta' AND client_id = (SELECT client_id FROM meta_leads WHERE leadgen_id = 'lead-1')`)).rows[0].n, 1)
  })

  it('reparto equitativo: dos leads seguidos van a socios distintos de META_LEADS_OWNER', async () => {
    graphLeads.set('lead-2', lead('Charcutería El Trébol', { phone_number: '04245550001' }))
    assert.equal((await post(payload('lead-2'))).status, 200)
    const r2 = await done('lead-2')
    const names = (await admin.query(`SELECT u.name FROM clients c JOIN users u ON u.id = c.created_by WHERE c.lead_source = 'meta_ads' ORDER BY c.created_at`)).rows.map((r) => r.name)
    assert.equal(names.length, 2)
    assert.deepEqual([...names].sort(), ['Elis', 'Jorbi'])
    assert.ok(r2.client_id)
  })

  it('duplicado por teléfono (aunque venga con otro formato): no crea cliente y deja nota en la bitácora del existente', async () => {
    graphLeads.set('lead-3', lead('Otra Persona', { phone_number: '+58 (424) 555-0001' }))
    const antes = (await admin.query(`SELECT count(*)::int AS n FROM clients`)).rows[0].n
    assert.equal((await post(payload('lead-3'))).status, 200)
    const row = await done('lead-3')
    assert.equal(row.status, 'duplicado')
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients`)).rows[0].n, antes)
    const orig = (await admin.query(`SELECT client_id FROM meta_leads WHERE leadgen_id = 'lead-2'`)).rows[0].client_id
    assert.equal(row.client_id, orig)
    const bit = (await api(`/clientes/${orig}/interacciones`)).body.data
    assert.ok(bit.some((i: any) => /Volvió a llegar por Meta Ads/.test(i.resumen)))
  })

  it('duplicado por email', async () => {
    graphLeads.set('lead-4', lead('Persona Email', { email: 'ESPIGA@correo.com' }))
    assert.equal((await post(payload('lead-4'))).status, 200)
    assert.equal((await done('lead-4')).status, 'duplicado')
  })

  it('teléfono o email inválidos no rompen el alta: el cliente nace y el dato queda en las notas', async () => {
    graphLeads.set('lead-5', lead('Sin Datos Buenos', { phone_number: 'no tengo', email: 'esto-no-es-email' }))
    assert.equal((await post(payload('lead-5'))).status, 200)
    const row = await done('lead-5')
    assert.equal(row.status, 'procesado')
    const c = (await api(`/clientes/${row.client_id}`)).body
    assert.equal(c.telefono, null)
    assert.equal(c.email, null)
    assert.match(c.notas, /Teléfono \(no válido\): no tengo/)
    assert.match(c.notas, /Email \(no válido\): esto-no-es-email/)
  })

  it('si Graph falla el lead queda en error y el reintento automático lo completa', async () => {
    graphDown.add('lead-6')
    graphLeads.set('lead-6', lead('Reintento Exitoso', { phone_number: '04125550006' }))
    assert.equal((await post(payload('lead-6'))).status, 200, 'Meta recibe 200 igual: el detalle se pide después')
    await until(async () => (await status('lead-6')).status === 'error')
    const e = await status('lead-6')
    assert.match(e.error, /500/)
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients WHERE name = 'Reintento Exitoso'`)).rows[0].n, 0)
    graphDown.delete('lead-6')
    await admin.query(`UPDATE meta_leads SET next_attempt_at = now() WHERE leadgen_id = 'lead-6'`)
    const row = await done('lead-6')
    assert.equal(row.status, 'procesado')
    assert.ok(row.attempts >= 2)
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients WHERE name = 'Reintento Exitoso'`)).rows[0].n, 1)
  })

  it('payloads sin leads, mal formados o de otro campo se aceptan sin crear nada', async () => {
    const vacio = JSON.stringify({ object: 'page', entry: [{ id: 'pg1', changes: [{ field: 'feed', value: { leadgen_id: 'ignorado' } }] }] })
    assert.deepEqual((await post(vacio)).body, { recibidos: 0 })
    assert.deepEqual((await post('{"entry":[]}')).body, { recibidos: 0 })
    assert.equal((await post('esto no es json')).status, 400)
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM meta_leads WHERE leadgen_id = 'ignorado'`)).rows[0].n, 0)
  })

  it('apagado (META_LEADS_ENABLED sin "true"): las dos rutas responden 404', async () => {
    assert.notEqual(process.env.META_LEADS_ENABLED, 'true')
    const { default: express } = await import('express')
    const { metaRouter } = await import('../src/meta.ts')
    const app = express()
    app.use('/hook', metaRouter)
    app.use((err: { status?: number }, _req: unknown, res: { status: (n: number) => { end: () => void } }, _next: unknown) => res.status(err.status ?? 500).end())
    const srv = createServer(app)
    await new Promise<void>((ok) => srv.listen(0, ok))
    try {
      const port = (srv.address() as { port: number }).port
      assert.equal((await fetch(`http://localhost:${port}/hook?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=x`)).status, 404)
      assert.equal((await fetch(`http://localhost:${port}/hook`, { method: 'POST', body: '{}' })).status, 404)
    } finally {
      srv.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Hub central + módulo de cobros: detalle del cobro, comprobante con OCR, mapeo de cédulas, sistemas, acuerdos, equipo.
// ---------------------------------------------------------------------------------------------------------------------
const FIXTURE_PNG = readFileSync(resolve(root, 'server/test/fixtures/comprobante-prueba.png'))
const png64 = FIXTURE_PNG.toString('base64')
const mcp = async (name: string, args: unknown, key = KEY) => {
  const r = await http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.result
}

describe('Cobros: detalle del pago (bolívares, tasa, banco, recibido por)', () => {
  let cid = ''
  let pid = ''
  const mkPago = async (b: Record<string, unknown>) => {
    const r = await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-07', monto: 75, concepto: 'Mensualidad', estado: 'cobrado', ...b } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r
  }
  const lastId = async () => (await admin.query('SELECT id FROM payments WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [cid])).rows[0].id as string

  before(async () => {
    const r = await api('/clientes', { body: { nombre: 'Cobros SA' } })
    assert.equal(r.status, 201)
    cid = r.body.id
  })

  it('registrar con el detalle del caso real: la tasa se deriva (873,87), el banco se separa de los 4 dígitos, recibido_por se resuelve por nombre', async () => {
    await mkPago({
      monto_bs: 65540.25,
      referencia: '071026007463',
      banco_origen: 'Bancrecer ****8017',
      banco_destino: 'Mercantil',
      recibido_por: 'elis',
      metodo: 'transferencia',
    })
    pid = await lastId()
    const r = await api(`/pagos/${pid}`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(
      { ...r.body, id: '<id>', cliente_id: '<id>', recibido_por: { ...r.body.recibido_por, id: '<id>' } },
      {
        id: '<id>', cliente_id: '<id>', cliente: 'Cobros SA', fecha: '2026-10-07', concepto: 'Mensualidad', monto: 75, tipo: 'pago', estado: 'cobrado', vencido: false,
        monto_bs: 65540.25, tasa: 873.87, fecha_tasa: '2026-10-07', referencia: '071026007463', banco_origen: 'Bancrecer', cuenta_origen_ultimos4: '8017', banco_destino: 'Mercantil',
        recibido_por: { id: '<id>', nombre: 'Elis' }, recibido_por_origen: 'manual', metodo: 'transferencia', notas: null, comprobante: null,
      },
    )
  })

  it('receptor por defecto: un cobro nace recibido por quien lo registra (llave o sesión); se puede cambiar; el pendiente no lleva receptor hasta cobrarse', async () => {
    await mkPago({ concepto: 'Sin receptor dicho' }) // Leandro (KEY)
    const a = (await api(`/pagos/${await lastId()}`)).body
    assert.deepEqual([a.recibido_por.nombre, a.recibido_por_origen], ['Leandro', 'manual'])
    await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-07', monto: 30, concepto: 'Lo registra Jorbi', estado: 'cobrado' }, key: KEY_J })
    assert.equal((await api(`/pagos/${await lastId()}`)).body.recibido_por.nombre, 'Jorbi')
    await mkPago({ concepto: 'Lo recibió Elis', recibido_por: 'Elis' })
    assert.equal((await api(`/pagos/${await lastId()}`)).body.recibido_por.nombre, 'Elis', 'lo manual manda')
    await mkPago({ concepto: 'Sin receptor a propósito', recibido_por: null })
    assert.equal((await api(`/pagos/${await lastId()}`)).body.recibido_por, null)
    // pendiente: sin receptor; al marcarlo cobrado, queda con quien lo marca; si dices quién, manda lo tuyo
    await mkPago({ concepto: 'Pendiente A', estado: 'pendiente' })
    const pa = await lastId()
    assert.equal((await api(`/pagos/${pa}`)).body.recibido_por, null)
    await api(`/pagos/${pa}`, { method: 'PATCH', body: { estado: 'cobrado' }, key: KEY_J })
    assert.equal((await api(`/pagos/${pa}`)).body.recibido_por.nombre, 'Jorbi')
    await mkPago({ concepto: 'Pendiente B', estado: 'pendiente' })
    const pb = await lastId()
    await api(`/pagos/${pb}`, { method: 'PATCH', body: { estado: 'cobrado', recibido_por: 'Elis' }, key: KEY_J })
    assert.equal((await api(`/pagos/${pb}`)).body.recibido_por.nombre, 'Elis')
    // y se cambia después
    const ch = await api(`/pagos/${pa}`, { method: 'PATCH', body: { recibido_por: 'Leandro' } })
    assert.equal(ch.status, 200, JSON.stringify(ch.body))
    assert.equal((await api(`/pagos/${pa}`)).body.recibido_por.nombre, 'Leandro')
  })

  it('tasa sin bolívares => bolívares = monto × tasa; los dos a la vez deben cuadrar (400); método y últimos 4 se validan', async () => {
    await mkPago({ monto: 100, tasa: 900, concepto: 'Solo tasa' })
    const a = (await api(`/pagos/${await lastId()}`)).body
    assert.equal(a.monto_bs, 90000)
    assert.equal(a.tasa, 900)
    const bad = [
      { monto: 100, monto_bs: 1000, tasa: 900 },
      { monto_bs: -5 },
      { monto_bs: 10.123 },
      { tasa: 0 },
      { metodo: 'cheque' },
      { cuenta_origen_ultimos4: '12' },
      { referencia: 'x', repetir_meses: 2, estado: 'pendiente' },
      { fecha_tasa: '2026-10-01' },
    ]
    for (const b of bad) assert.equal((await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-07', monto: 100, concepto: 'x', ...b } })).status, 400, JSON.stringify(b))
    assert.equal((await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-07', monto: 100, concepto: 'x', monto_bs: 9000, tasa: 90, recibido_por: 'Ellis' } })).status, 404)
  })

  it('cambiar el monto en USD recalcula la tasa (los bolívares recibidos no cambian); quitar los bolívares quita también la tasa', async () => {
    const m = await api(`/pagos/${pid}`, { method: 'PATCH', body: { monto: 80 } })
    assert.equal(m.status, 200, JSON.stringify(m.body))
    const a = (await api(`/pagos/${pid}`)).body
    assert.equal(a.monto, 80)
    assert.equal(a.monto_bs, 65540.25)
    assert.equal(a.tasa, 819.2531)
    const d = await api(`/pagos/${pid}`, { method: 'PATCH', body: { monto_bs: null } })
    assert.equal(d.status, 200)
    const b = (await api(`/pagos/${pid}`)).body
    assert.deepEqual([b.monto_bs, b.tasa, b.fecha_tasa], [null, null, null])
    assert.equal(b.referencia, '071026007463', 'lo demás se conserva')
    // volver a ponerlos: la fecha de la tasa por defecto es la del cobro
    await api(`/pagos/${pid}`, { method: 'PATCH', body: { monto: 75, monto_bs: 65540.25, fecha_tasa: '2026-10-06' } })
    const c = (await api(`/pagos/${pid}`)).body
    assert.deepEqual([c.monto_bs, c.tasa, c.fecha_tasa], [65540.25, 873.87, '2026-10-06'])
  })

  it('una referencia bancaria no se registra dos veces (409, sin importar mayúsculas); la propia se puede reescribir', async () => {
    const dup = await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-08', monto: 10, concepto: 'Repetido', referencia: '071026007463' } })
    assert.equal(dup.status, 409)
    assert.match(dup.body.error.message, /ya está registrada/)
    assert.equal((await api(`/pagos/${pid}`, { method: 'PATCH', body: { referencia: '071026007463', notas: 'Confirmado por el banco' } })).status, 200)
    assert.equal((await api(`/pagos/${pid}`)).body.notas, 'Confirmado por el banco')
  })

  it('la inicial acepta detalle (notas, método) pero no cambia sus campos de fondo', async () => {
    const ini = await api('/clientes', { body: { nombre: 'Con inicial', items: [{ concepto: 'Web', monto: 40 }], fecha_inicial: '2026-10-01' } })
    const id = ini.body.movimientos.find((m: any) => m.tipo === 'inicial').id
    assert.equal((await api(`/pagos/${id}`, { method: 'PATCH', body: { notas: 'Efectivo en la visita', metodo: 'efectivo' } })).status, 200)
    assert.equal((await api(`/pagos/${id}`)).body.metodo, 'efectivo')
    assert.equal((await api(`/pagos/${id}`, { method: 'PATCH', body: { monto: 1 } })).status, 400)
    assert.equal((await api(`/pagos/${NOPE}`)).status, 404)
  })

  it('GET /pagos filtra por recibido_por y método y trae el detalle', async () => {
    const e = await api('/pagos?recibido_por=Elis&per_page=100')
    assert.equal(e.status, 200, JSON.stringify(e.body))
    assert.ok(e.body.data.some((p: any) => p.id === pid))
    assert.ok(e.body.data.every((p: any) => p.recibido_por?.nombre === 'Elis'))
    const row = e.body.data.find((p: any) => p.id === pid)
    assert.equal(row.referencia, '071026007463')
    assert.equal(row.banco_destino, 'Mercantil')
    const m = await api('/pagos?metodo=efectivo&per_page=100')
    assert.ok(m.body.data.length >= 1 && m.body.data.every((p: any) => p.metodo === 'efectivo'))
    assert.equal((await api('/pagos?metodo=cheque')).status, 400)
  })

  it('MCP: hayai_pago_actualizar y hayai_pago_ver', async () => {
    const a = data(await mcp('hayai_pago_actualizar', { id: pid, banco_destino: 'Banesco' }))
    assert.equal(a.id, cid)
    const v = data(await mcp('hayai_pago_ver', { id: pid }))
    assert.equal(v.banco_destino, 'Banesco')
    assert.equal(v.recibido_por.nombre, 'Elis')
  })
})

describe('Cobros: comprobante, OCR y mapeo de cédulas a socios', () => {
  let cid = ''
  const mkPago = async (b: Record<string, unknown> = {}) => {
    // recibido_por: null = sin receptor (por defecto un cobro nace recibido por quien lo registra): así se prueba la detección por cédula
    const r = await api(`/clientes/${cid}/pagos`, { body: { fecha: '2026-10-07', monto: 20, concepto: 'Pago', estado: 'cobrado', recibido_por: null, ...b } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return (await admin.query('SELECT id FROM payments WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [cid])).rows[0].id as string
  }
  const subir = (id: string, b: Record<string, unknown> = {}, key = KEY) => api(`/pagos/${id}/comprobante`, { key, body: { imagen_base64: png64, nombre: 'captura.png', ...b } })

  before(async () => {
    cid = (await api('/clientes', { body: { nombre: 'Comprobantes SA' } })).body.id
  })

  it('el mapeo sembrado desde RECEIVER_DOCUMENTS (entradas rotas ignoradas) se lista ENMASCARADO, sin cédulas completas', async () => {
    const r = await api('/receptores')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.map((x: any) => [x.socio.nombre, x.documento]).sort(), [['Jorbi', 'V-123•••78'], ['Leandro', 'E-222•••22']])
    const raw = JSON.stringify(r.body)
    assert.ok(!raw.includes('12345678') && !raw.includes('22222222'), 'la cédula completa nunca sale por la API')
    const { seedReceiverDocuments } = await import('../src/services/cobros.ts')
    assert.equal(typeof seedReceiverDocuments, 'function')
  })

  it('subir el capture: guarda la imagen, el OCR lee "DOCUMENTO V-99999999"; sin mapeo NO se inventa el receptor y pide confirmar', async () => {
    const id = await mkPago()
    const r = await subir(id)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.deteccion.estado, 'sin_mapeo')
    assert.equal(r.body.deteccion.requiere_confirmacion, true)
    assert.match(r.body.deteccion.documento, /^V-999.*99$/)
    assert.ok(!JSON.stringify(r.body).includes('99999999'), 'el documento sale enmascarado')
    assert.match(r.body.deteccion.texto_ocr, /DOCUMENTO/i)
    assert.equal(r.body.cobro.recibido_por, null)
    assert.deepEqual([r.body.cobro.comprobante.nombre, r.body.cobro.comprobante.tipo, r.body.cobro.comprobante.tamano], ['captura.png', 'image/png', FIXTURE_PNG.length])
  })

  it('agregar el mapeo y volver a detectar asigna al socio (origen "comprobante"); no se pisa lo ya fijado a mano', async () => {
    const id = (await admin.query("SELECT payment_id AS id FROM payment_receipts ORDER BY uploaded_at DESC LIMIT 1")).rows[0].id as string
    const sin = await api('/receptores', { body: { documento: 'v - 99.999.999', socio: 'elis' } })
    assert.equal(sin.status, 200, JSON.stringify(sin.body))
    assert.match(sin.body.documento, /^V-999.*99$/)
    const d = await api(`/pagos/${id}/comprobante/detectar`, { body: {} })
    assert.equal(d.status, 200, JSON.stringify(d.body))
    assert.equal(d.body.deteccion.estado, 'asignado')
    assert.equal(d.body.deteccion.socio.nombre, 'Elis')
    assert.equal(d.body.cobro.recibido_por.nombre, 'Elis')
    assert.equal(d.body.cobro.recibido_por_origen, 'comprobante')
    assert.equal((await api(`/pagos/${id}/comprobante/detectar`, { body: {} })).body.deteccion.estado, 'ya_asignado')

    // difiere: ya había un receptor fijado a mano distinto del que dice el capture => no se cambia, se avisa
    const j = await mkPago({ recibido_por: 'Jorbi' })
    const r = await subir(j)
    assert.equal(r.body.deteccion.estado, 'difiere')
    assert.equal(r.body.deteccion.requiere_confirmacion, true)
    assert.equal(r.body.cobro.recibido_por.nombre, 'Jorbi')
    assert.equal(r.body.cobro.recibido_por_origen, 'manual')
    // ya_asignado: coincide con lo fijado
    const e = await mkPago({ recibido_por: 'Elis' })
    assert.equal((await subir(e)).body.deteccion.estado, 'ya_asignado')
    // un pago nuevo sin receptor se asigna solo al subir
    const n = await mkPago()
    const up = await subir(n)
    assert.equal(up.body.deteccion.estado, 'asignado')
    assert.equal(up.body.cobro.recibido_por.nombre, 'Elis')
  })

  it('texto_ocr (agente con visión) sustituye al OCR del servidor; sin "DOCUMENTO" => no_detectado, confirmar a mano', async () => {
    const a = await mkPago()
    const r = await subir(a, { texto_ocr: 'Comprobante\nDOCUMENTO: V-99999999\nMonto 10' })
    assert.equal(r.body.deteccion.estado, 'asignado')
    const b = await mkPago()
    const n = await subir(b, { texto_ocr: 'Transferencia exitosa. Gracias por usar el banco' })
    assert.equal(n.body.deteccion.estado, 'no_detectado')
    assert.equal(n.body.deteccion.requiere_confirmacion, true)
    assert.equal(n.body.cobro.recibido_por, null)
    const m = await api(`/pagos/${b}`, { method: 'PATCH', body: { recibido_por: 'Leandro' } })
    assert.equal(m.status, 200)
    assert.equal((await api(`/pagos/${b}`)).body.recibido_por_origen, 'manual')
  })

  it('valida: solo PNG/JPEG/WebP por los bytes (no por el nombre), máximo 4 MB, pago inexistente 404, sin imagen 400', async () => {
    const id = await mkPago()
    const fake = Buffer.from('<html>no soy una imagen, '.repeat(20)).toString('base64')
    assert.equal((await subir(id, { imagen_base64: fake, nombre: 'ok.png' })).status, 400)
    const big = Buffer.concat([FIXTURE_PNG.subarray(0, 16), Buffer.alloc(4 * 1024 * 1024 + 10)]).toString('base64')
    const huge = await subir(id, { imagen_base64: big })
    assert.equal(huge.status, 413, JSON.stringify(huge.body))
    assert.equal((await subir(NOPE)).status, 404)
    assert.equal((await api(`/pagos/${id}/comprobante`, { body: {} })).status, 400)
    assert.equal((await api(`/pagos/${id}/comprobante`)).status, 404, 'sin comprobante')
  })

  it('GET comprobante/archivo devuelve los bytes exactos, con tipo, cabeceras seguras y exige llave; ver trae el texto leído', async () => {
    const id = (await admin.query("SELECT payment_id AS id FROM payment_receipts ORDER BY uploaded_at ASC LIMIT 1")).rows[0].id as string
    const f = await fetch(`${ROOT}/api/v1/pagos/${id}/comprobante/archivo`, { headers: { 'x-api-key': KEY } })
    assert.equal(f.status, 200)
    assert.equal(f.headers.get('content-type'), 'image/png')
    assert.match(f.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.ok(Buffer.from(await f.arrayBuffer()).equals(FIXTURE_PNG))
    assert.equal((await fetch(`${ROOT}/api/v1/pagos/${id}/comprobante/archivo`)).status, 401)
    const v = await api(`/pagos/${id}/comprobante`)
    assert.equal(v.status, 200)
    assert.match(v.body.texto_ocr, /DOCUMENTO/i)
    assert.match(v.body.documento_detectado, /^V-999.*99$/)
  })

  it('el mapeo se cambia con guardar (mismo documento, otro socio) y eliminar exige permiso de borrado', async () => {
    const a = await api('/receptores', { body: { documento: 'V-99999999', socio: 'Jorbi' } })
    assert.equal(a.status, 200)
    const lst = (await api('/receptores')).body.data
    assert.equal(lst.filter((x: any) => /^V-999/.test(x.documento)).length, 1, 'un documento, un socio')
    assert.equal(lst.find((x: any) => /^V-999/.test(x.documento)).socio.nombre, 'Jorbi')
    assert.equal((await api('/receptores', { body: { documento: '123', socio: 'Jorbi' } })).status, 400)
    assert.equal((await api('/receptores', { body: { documento: 'V-12345678', socio: 'Ellis' } })).status, 404)
    assert.equal((await api(`/receptores/${a.body.id}`, { method: 'DELETE' })).status, 403)
    assert.equal((await apiD(`/receptores/${a.body.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await apiD(`/receptores/${a.body.id}`, { method: 'DELETE' })).status, 404)
  })

  it('papelera: un cobro borrado vuelve con su comprobante y todo su detalle', async () => {
    const id = await mkPago({ monto_bs: 1000, referencia: 'REF-PAPELERA-1', recibido_por: 'Leandro' })
    await subir(id, { texto_ocr: 'sin documento' })
    const antes = (await api(`/pagos/${id}`)).body
    assert.ok(antes.comprobante)
    const del = await apiD(`/pagos/${id}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal((await api(`/pagos/${id}`)).status, 404)
    const back = await apiD(`/papelera/${del.body.papelera_id}/restaurar`, { method: 'POST', body: {} })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    assert.deepEqual((await api(`/pagos/${id}`)).body, antes)
    const f = await fetch(`${ROOT}/api/v1/pagos/${id}/comprobante/archivo`, { headers: { 'x-api-key': KEY } })
    assert.ok(Buffer.from(await f.arrayBuffer()).equals(FIXTURE_PNG), 'los bytes sobreviven a la ida y vuelta')
  })

  it('MCP: hayai_comprobante_subir/ver/detectar y listar receptores', async () => {
    await api('/receptores', { body: { documento: 'V-99999999', socio: 'Elis' } })
    const id = await mkPago()
    const s = data(await mcp('hayai_comprobante_subir', { id, imagen_base64: png64, texto_ocr: 'DOCUMENTO V-99999999' }))
    assert.equal(s.deteccion.estado, 'asignado')
    assert.equal(data(await mcp('hayai_comprobante_ver', { id })).cobro.id, id)
    assert.equal(data(await mcp('hayai_comprobante_detectar', { id })).deteccion.estado, 'ya_asignado')
    assert.ok(data(await mcp('hayai_receptores_listar', {})).data.length >= 3)
  })

  it('web (sesión): detalle, comprobante y archivo con las mismas reglas; el parser grande solo en la ruta del comprobante', async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const web = (path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })
    const id = await mkPago()
    const up = await web(`/cobros/${id}/comprobante`, { body: { imagen_base64: png64 } })
    assert.equal(up.status, 200, JSON.stringify(up.body))
    assert.equal(up.body.deteccion.estado, 'asignado')
    const patch = await web(`/cobros/${id}`, { method: 'PATCH', body: { notas: 'desde la web', banco_origen: 'Banesco ****1234' } })
    assert.equal(patch.status, 200, JSON.stringify(patch.body))
    assert.deepEqual([patch.body.notas, patch.body.banco_origen, patch.body.cuenta_origen_ultimos4], ['desde la web', 'Banesco', '1234'])
    const img = await fetch(`${ROOT}/api/cobros/${id}/comprobante/archivo`, { headers: { cookie } })
    assert.equal(img.status, 200)
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(FIXTURE_PNG))
    assert.equal((await http(`${ROOT}/api/cobros/${id}`)).status, 401)
    assert.equal((await web('/receptores')).body.data.length >= 3, true)
    // fuera de la ruta del comprobante el límite sigue siendo 100 KB
    const huge = await web(`/cobros/${id}`, { method: 'PATCH', body: { notas: 'x'.repeat(200_000) } })
    assert.equal(huge.status, 413)
  })
})

describe('Sistemas de los clientes: semáforo de disponibilidad', () => {
  let cid = ''
  let sid = ''
  const act = async (q = '', key = KEY_J) => (await api(`/actividad${q}`, { key })).body
  const ultimo = async () => (await act('?per_page=1')).meta.ultimo_id as number
  const nuevos = async (desde: number) => ((await act(`?desde_id=${desde}&orden=asc&per_page=100`)).data as any[]).filter((e) => /^sistema_/.test(e.tipo))

  before(async () => {
    cid = (await api('/clientes', { body: { nombre: 'Panadería Sistemas' } })).body.id
    await act() // fija el "visto hasta" de Jorbi
  })

  it('crear: solo URLs y el nombre del usuario de gestión; sin usuario:clave@ ni esquemas raros; estado inicial desconocido', async () => {
    const r = await api('/sistemas', { body: { cliente_id: cid, nombre: 'Inventario', enlace: `http://localhost:${TARGET_PORT}/health`, usuario_gestion: 'admin.panaderia', servidor: 'VPS Hostinger', verificar: false } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    sid = r.body.id
    assert.deepEqual([r.body.estado, r.body.cliente, r.body.verificar, r.body.activo, r.body.usuario_gestion], ['desconocido', 'Panadería Sistemas', false, true, 'admin.panaderia'])
    for (const enlace of ['http://admin:secreto@x.com', 'ftp://x.com', 'javascript:alert(1)', 'no es una url']) assert.equal((await api('/sistemas', { body: { cliente_id: cid, nombre: 'Mal', enlace } })).status, 400, enlace)
    assert.equal((await api('/sistemas', { body: { cliente_id: cid, nombre: 'Mal', clave: 'x' } })).status, 400, 'no hay campo para contraseñas')
    assert.equal((await api('/sistemas', { body: { cliente_id: NOPE, nombre: 'x' } })).status, 404)
  })

  it('verificar: arriba -> caído (se confirma con un segundo intento) -> recuperado; cada cambio avisa UNA vez y a todos', async () => {
    const base = await ultimo()
    targetUp = true
    const a = await api(`/sistemas/${sid}/verificar`, { body: {} })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.deepEqual([a.body.verificacion.estado, a.body.verificacion.codigo_http, a.body.sistema.estado], ['arriba', 200, 'arriba'])
    assert.equal((await nuevos(base)).length, 0, 'arrancar en "arriba" no avisa')

    targetUp = false
    const d = await api(`/sistemas/${sid}/verificar`, { body: {} })
    assert.deepEqual([d.body.verificacion.estado, d.body.verificacion.codigo_http, d.body.verificacion.cambio], ['caido', 500, true])
    assert.equal(d.body.sistema.disponibilidad_24h < 100, true)
    assert.ok(d.body.sistema.desde)
    const dos = await api(`/sistemas/${sid}/verificar`, { body: {} })
    assert.equal(dos.body.verificacion.cambio, false, 'seguir caído no repite el aviso')

    targetUp = true
    const u = await api(`/sistemas/${sid}/verificar`, { body: {} })
    assert.deepEqual([u.body.verificacion.estado, u.body.verificacion.cambio], ['arriba', true])

    const ev = await nuevos(base)
    assert.deepEqual(ev.map((e) => e.tipo), ['sistema_caido', 'sistema_recuperado'])
    assert.ok(ev.every((e) => e.propia === false && e.leida === false), 'avisa a todos los socios, también a quien creó el sistema')
    assert.match(ev[0].texto, /Inventario/)
    assert.equal(ev[0].cliente_id, cid)
    const mine = await act(`?desde_id=${base}&orden=asc`, KEY)
    assert.ok(mine.data.filter((e: any) => /^sistema_/.test(e.tipo)).every((e: any) => e.propia === false), 'tampoco es "propia" para el dueño: lo hizo el monitor')
  })

  it('un fallo aislado no alarma: el segundo intento sale bien', async () => {
    const base = await ultimo()
    // el servidor falso responde 500 solo a la primera petición de esta verificación
    const { createServer: mk } = await import('node:http')
    let hits = 0
    const flaky = mk((_q, res) => void res.writeHead(++hits === 1 ? 500 : 200).end('x'))
    await new Promise<void>((ok) => flaky.listen(3197, ok))
    try {
      const s = (await api('/sistemas', { body: { cliente_id: cid, nombre: 'Intermitente', enlace: 'http://localhost:3197/', verificar: false } })).body.id
      assert.equal((await api(`/sistemas/${s}/verificar`, { body: {} })).body.verificacion.estado, 'arriba')
      assert.equal(hits, 2)
      assert.equal((await nuevos(base)).length, 0)
    } finally {
      flaky.close()
    }
  })

  it('sigue las redirecciones; una URL que cambia reinicia el semáforo; sin URL queda "desconocido"', async () => {
    const r = (await api('/sistemas', { body: { cliente_id: cid, nombre: 'Con redirección', url_produccion: `http://localhost:${TARGET_PORT}/redir`, verificar: false } })).body
    targetUp = true
    assert.equal((await api(`/sistemas/${r.id}/verificar`, { body: {} })).body.verificacion.estado, 'arriba')
    const p = await api(`/sistemas/${r.id}`, { method: 'PATCH', body: { url_verificacion: `http://localhost:${TARGET_PORT}/siempre` } })
    assert.deepEqual([p.body.estado, p.body.desde, p.body.codigo_http], ['desconocido', null, null])
    const none = (await api('/sistemas', { body: { cliente_id: cid, nombre: 'Sin URL', verificar: false } })).body
    const v = await api(`/sistemas/${none.id}/verificar`, { body: {} })
    assert.deepEqual([v.body.verificacion.estado, v.body.verificacion.error], ['desconocido', 'Sin URL para verificar'])
  })

  it('listar: caídos primero, resumen por estado, filtros; PATCH vacío 400; 404', async () => {
    targetUp = false
    await api(`/sistemas/${sid}/verificar`, { body: {} })
    const l = await api('/sistemas?per_page=100')
    assert.equal(l.status, 200)
    assert.equal(l.body.data[0].id, sid, 'el caído va primero')
    assert.ok(l.body.meta.por_estado.caido >= 1)
    assert.ok((await api(`/sistemas?estado=caido`)).body.data.every((x: any) => x.estado === 'caido'))
    assert.equal((await api(`/sistemas?cliente_id=${cid}`)).body.data.every((x: any) => x.cliente_id === cid), true)
    assert.equal((await api(`/sistemas/${sid}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/sistemas/${NOPE}`)).status, 404)
    const off = await api(`/sistemas/${sid}`, { method: 'PATCH', body: { activo: false } })
    assert.equal(off.body.activo, false)
    assert.ok(!(await api('/sistemas')).body.data.some((x: any) => x.id === sid))
    assert.ok((await api('/sistemas?activos=false')).body.data.some((x: any) => x.id === sid))
    await api(`/sistemas/${sid}`, { method: 'PATCH', body: { activo: true } })
    targetUp = true
  })

  it('el vigilante verifica solo los sistemas con monitor activo (SYSTEMS_CHECK_MS)', async () => {
    const s = (await api('/sistemas', { body: { cliente_id: cid, nombre: 'Vigilado', enlace: `http://localhost:${TARGET_PORT}/siempre` } })).body
    assert.equal(s.verificar, true)
    let estado = 'desconocido'
    for (let i = 0; i < 40 && estado !== 'arriba'; i++) {
      await new Promise((r) => setTimeout(r, 500))
      estado = (await api(`/sistemas/${s.id}`)).body.estado
    }
    assert.equal(estado, 'arriba', 'el vigilante lo verificó sin que nadie lo pidiera')
  })

  it('protección SSRF: sin SYSTEMS_ALLOW_PRIVATE no se consulta localhost, redes privadas ni metadatos de la nube', async () => {
    const { assertPublicTarget } = await import('../src/systems.ts')
    const before = process.env.SYSTEMS_ALLOW_PRIVATE
    delete process.env.SYSTEMS_ALLOW_PRIVATE
    try {
      for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.5/x', 'http://192.168.1.10/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://0.0.0.0/', 'http://[fd00::1]/'])
        await assert.rejects(assertPublicTarget(u), /privada|local/, u)
      await assert.rejects(assertPublicTarget('file:///etc/passwd'), /http/)
      await assert.rejects(assertPublicTarget('http://u:p@8.8.8.8/'), /usuario/)
      assert.equal((await assertPublicTarget('http://8.8.8.8/')).hostname, '8.8.8.8')
    } finally {
      if (before !== undefined) process.env.SYSTEMS_ALLOW_PRIVATE = before
    }
  })

  it('papelera: borrar el cliente se lleva sus sistemas y restaurar los devuelve (con su estado)', async () => {
    const c2 = (await api('/clientes', { body: { nombre: 'Se va con sistemas' } })).body.id
    const s = (await api('/sistemas', { body: { cliente_id: c2, nombre: 'Mi sistema', enlace: 'http://localhost:3198/siempre', usuario_gestion: 'dueno', verificar: false } })).body.id
    const del = await apiD(`/clientes/${c2}`, { method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal((await api(`/sistemas/${s}`)).status, 404)
    assert.equal((await apiD(`/papelera/${del.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 200)
    const back = await api(`/sistemas/${s}`)
    assert.equal(back.status, 200)
    assert.equal(back.body.usuario_gestion, 'dueno')
  })

  it('MCP y web: sistemas listar/ver/crear/actualizar/verificar y las rutas de sesión', async () => {
    const lst = data(await mcp('hayai_sistemas_listar', {}))
    assert.ok(lst.data.length >= 3)
    const n = data(await mcp('hayai_sistema_crear', { cliente_id: cid, nombre: 'Por MCP', enlace: `http://localhost:${TARGET_PORT}/siempre`, verificar: false }))
    assert.equal(data(await mcp('hayai_sistema_actualizar', { id: n.id, notas: 'ok' })).notas, 'ok')
    assert.equal(data(await mcp('hayai_sistema_verificar', { id: n.id })).verificacion.estado, 'arriba')
    assert.equal(data(await mcp('hayai_sistema_ver', { id: n.id })).nombre, 'Por MCP')
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const web = (path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })
    assert.ok((await web('/systems')).body.data.length >= 3)
    assert.equal((await web(`/systems/${n.id}/check`, { body: {} })).body.verificacion.estado, 'arriba')
  })
})

describe('Hub central: equipo, acuerdos, bitácora interna y pulso', () => {
  let agr = ''

  it('acuerdos: crear (responsable por nombre, fecha de hoy por defecto), cerrar, reabrir, descartar; el aviso "acuerdo_nuevo" llega al otro socio', async () => {
    const base = ((await api('/actividad?per_page=1', { key: KEY_J })).body.meta.ultimo_id as number) ?? 0
    const r = await api('/acuerdos', { body: { texto: 'Subir el plan de contenidos de octubre', responsable: 'jorbi', vence: '2026-10-14' } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    agr = r.body.id
    assert.deepEqual([r.body.estado, r.body.responsable.nombre, r.body.vence, r.body.registrado_por, r.body.cerrado_el], ['abierto', 'Jorbi', '2026-10-14', 'Leandro', null])
    assert.match(r.body.fecha_reunion, /^\d{4}-\d{2}-\d{2}$/)
    const ev = ((await api(`/actividad?desde_id=${base}&orden=asc`, { key: KEY_J })).body.data as any[]).filter((e) => e.tipo === 'acuerdo_nuevo')
    assert.equal(ev.length, 1)
    assert.match(ev[0].texto, /Leandro/)
    assert.equal(ev[0].propia, false)

    const c = await api(`/acuerdos/${agr}`, { method: 'PATCH', body: { estado: 'cumplido' } })
    assert.equal(c.body.estado, 'cumplido')
    assert.ok(c.body.cerrado_el)
    assert.equal((await api(`/acuerdos/${agr}`, { method: 'PATCH', body: { estado: 'abierto' } })).body.cerrado_el, null)
    const sinResp = await api(`/acuerdos/${agr}`, { method: 'PATCH', body: { responsable: null, vence: null } })
    assert.deepEqual([sinResp.body.responsable, sinResp.body.vence], [null, null])
    assert.equal((await api(`/acuerdos/${agr}`, { method: 'PATCH', body: { estado: 'descartado' } })).body.estado, 'descartado')
    assert.equal((await api(`/acuerdos/${agr}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/acuerdos/${NOPE}`, { method: 'PATCH', body: { estado: 'cumplido' } })).status, 404)
    assert.equal((await api('/acuerdos', { body: { texto: '' } })).status, 400)
    assert.equal((await api('/acuerdos', { body: { texto: 'x', responsable: 'Ellis' } })).status, 404)
  })

  it('listar acuerdos: abiertos primero, conteo por estado, filtro', async () => {
    await api('/acuerdos', { body: { texto: 'Abierto B' } })
    const l = await api('/acuerdos')
    assert.equal(l.status, 200)
    assert.equal(l.body.data[0].estado, 'abierto')
    assert.ok(l.body.meta.por_estado.abierto >= 1 && l.body.meta.por_estado.descartado >= 1)
    assert.ok((await api('/acuerdos?estado=descartado')).body.data.every((a: any) => a.estado === 'descartado'))
    assert.equal((await api('/acuerdos?estado=raro')).status, 400)
  })

  it('equipo: rol y responsabilidades editables; la carga cuenta lo asignado y, sin asignar, lo del proyecto que lleva', async () => {
    const eq = await api('/equipo')
    assert.equal(eq.status, 200)
    assert.deepEqual(eq.body.data.map((x: any) => x.nombre), ['Elis', 'Jorbi', 'Leandro'])
    assert.ok(eq.body.data.every((x: any) => x.rol && x.responsabilidades), 'la migración deja un rol inicial para cada socio')
    const carga = (n: string, d: any) => d.data.find((x: any) => x.nombre === n).carga
    const antes = eq.body

    const p = (await api('/proyectos', { body: { nombre: 'Interno de carga', responsable: 'Leandro' } })).body
    const sinAsignar = await api('/tareas', { body: { titulo: 'La lleva el dueño del proyecto', proyecto_id: p.id } })
    assert.equal(sinAsignar.body.responsable.nombre, 'Leandro')
    assert.equal(sinAsignar.body.asignada, false)
    assert.equal(sinAsignar.body.es_interno, true)
    const asignada = await api('/tareas', { body: { titulo: 'Para Jorbi', proyecto_id: p.id, responsable: 'jorbi', vence: '2000-01-01' } })
    assert.equal(asignada.body.responsable.nombre, 'Jorbi')
    assert.equal(asignada.body.asignada, true)
    const des = await api('/equipo')
    assert.equal(carga('Leandro', des.body).abiertas, carga('Leandro', antes).abiertas + 1)
    assert.equal(carga('Jorbi', des.body).abiertas, carga('Jorbi', antes).abiertas + 1)
    assert.equal(carga('Jorbi', des.body).vencidas, carga('Jorbi', antes).vencidas + 1)
    assert.equal(carga('Jorbi', des.body).internas_abiertas, carga('Jorbi', antes).internas_abiertas + 1)

    await api(`/tareas/${asignada.body.id}`, { method: 'PATCH', body: { estado: 'completada' } })
    const fin = await api('/equipo')
    assert.equal(carga('Jorbi', fin.body).abiertas, carga('Jorbi', antes).abiertas)
    assert.equal(carga('Jorbi', fin.body).completadas_7d, carga('Jorbi', antes).completadas_7d + 1)
    // reasignar y des-asignar
    assert.equal((await api(`/tareas/${asignada.body.id}`, { method: 'PATCH', body: { responsable: 'Elis' } })).body.responsable.nombre, 'Elis')
    assert.equal((await api(`/tareas/${asignada.body.id}`, { method: 'PATCH', body: { responsable: null } })).body.responsable.nombre, 'Leandro')
    assert.equal((await api('/tareas', { body: { titulo: 'x', proyecto_id: p.id, responsable: 'Ellis' } })).status, 404)

    const e = await api('/equipo/jorbi', { method: 'PATCH', body: { rol: 'Backend e IA', responsabilidades: 'Sistemas, servidores y automatizaciones' } })
    assert.equal(e.status, 200, JSON.stringify(e.body))
    assert.deepEqual([e.body.nombre, e.body.rol, e.body.responsabilidades], ['Jorbi', 'Backend e IA', 'Sistemas, servidores y automatizaciones'])
    assert.equal((await api('/equipo/jorbi', { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api('/equipo/nadie', { method: 'PATCH', body: { rol: 'x' } })).status, 404)
  })

  it('interno vs cliente: tareas, proyectos y gastos filtran por "interno"; finanzas?interno=true es la vista de gastos generales', async () => {
    const t = await api('/tareas?interno=true&per_page=100')
    assert.equal(t.status, 200, JSON.stringify(t.body))
    assert.ok(t.body.data.length >= 1 && t.body.data.every((x: any) => x.es_interno === true))
    assert.ok((await api('/tareas?interno=false&per_page=100')).body.data.every((x: any) => x.es_interno === false))
    assert.ok((await api('/tareas?responsable=jorbi&per_page=100')).body.data.every((x: any) => x.responsable.nombre === 'Jorbi'))
    assert.ok((await api('/proyectos?interno=true&per_page=100')).body.data.every((x: any) => x.es_interno === true))

    await api('/gastos', { body: { concepto: 'Servidor HAYAI', monto: 12.5, categoria: 'Infraestructura', fecha: isoDay(0) } })
    const g = await api('/gastos?interno=true&per_page=100')
    assert.ok(g.body.data.length >= 1 && g.body.data.every((x: any) => x.es_interno === true))
    assert.ok((await api('/gastos?interno=false&per_page=100')).body.data.every((x: any) => x.es_interno === false))

    const full = (await api('/finanzas/resumen?periodo=todo')).body
    const int = (await api('/finanzas/resumen?periodo=todo&interno=true')).body
    assert.equal(full.interno, false)
    assert.equal(int.interno, true)
    assert.deepEqual(int.clientes, [])
    assert.equal(int.gastos, full.gastos_generales)
    assert.equal(int.ingresos, 0)
    assert.equal(int.balance, -full.gastos_generales)
  })

  it('GET /hub: pulso, astronautas, bitácora interna, acuerdos abiertos, sistemas y el hueco de analytics', async () => {
    const h = await api('/hub')
    assert.equal(h.status, 200, JSON.stringify(h.body))
    assert.deepEqual(Object.keys(h.body).sort(), ['acuerdos', 'analytics', 'astronautas', 'bitacora', 'feed', 'pulso', 'sistemas'])
    assert.equal(h.body.astronautas.length, 3)
    assert.match(h.body.pulso.mes, /^\d{4}-\d{2}$/)
    assert.ok(h.body.pulso.gastos_generales_mes >= 12.5)
    assert.ok(h.body.pulso.proyectos_internos.total >= 1)
    assert.ok(h.body.pulso.tareas_internas.pendientes >= 1)
    assert.ok(h.body.acuerdos.abiertos.every((a: any) => a.estado === 'abierto'))
    assert.ok(h.body.sistemas.data.length >= 3 && typeof h.body.sistemas.resumen.arriba === 'number')
    assert.deepEqual(h.body.analytics, { disponible: false, planeta: 'marketing', resumen: null })
    assert.ok(h.body.bitacora.length >= 1)
    // la bitácora interna no trae movimientos de clientes (cobros, pipeline) pero sí lo interno
    const tipos = new Set(h.body.bitacora.map((e: any) => e.tipo))
    assert.ok(!tipos.has('cobro_cobrado') && !tipos.has('cliente_nuevo'), [...tipos].join())
    assert.ok(tipos.has('acuerdo_nuevo') || tipos.has('sistema_caido') || tipos.has('tarea_nueva'))
    assert.equal(h.body.bitacora.length <= 15, true)
  })

  it('actividad?alcance=interno separa lo interno de lo de clientes', async () => {
    const todo = (await api('/actividad?per_page=100')).body.data
    const int = (await api('/actividad?alcance=interno&per_page=100')).body.data
    assert.ok(int.length >= 1 && int.length < todo.length)
    assert.ok(!int.some((e: any) => e.tipo === 'cliente_nuevo'))
    assert.equal((await api('/actividad?alcance=raro')).status, 400)
  })

  it('MCP y web: hub, equipo y acuerdos', async () => {
    assert.equal(data(await mcp('hayai_hub_ver', {})).astronautas.length, 3)
    assert.equal(data(await mcp('hayai_equipo_ver', {})).data.length, 3)
    const a = data(await mcp('hayai_acuerdo_crear', { texto: 'Desde MCP', responsable: 'Elis' }))
    assert.equal(data(await mcp('hayai_acuerdo_actualizar', { id: a.id, estado: 'cumplido' })).estado, 'cumplido')
    assert.ok(data(await mcp('hayai_acuerdos_listar', { estado: 'cumplido' })).data.length >= 1)
    assert.equal(data(await mcp('hayai_equipo_actualizar', { socio: 'Elis', rol: 'Gerencia' })).rol, 'Gerencia')
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const web = (path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })
    assert.equal((await web('/hub')).status, 200)
    assert.equal((await web('/team')).body.data.length, 3)
    assert.equal((await web('/agreements', { body: { texto: 'Desde la web' } })).status, 201)
    assert.equal((await web('/marketing/funnel')).status, 200)
    assert.equal((await http(`${ROOT}/api/hub`)).status, 401)
  })
})

describe('Marketing: embudo y decisión 3 (versión de la propuesta en la bitácora)', () => {
  it('GET /marketing/embudo: etapas abiertas con valor y ponderado, cierres, cohorte por origen y Meta Ads', async () => {
    const r = await api('/marketing/embudo?dias=90')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.etapas.map((e: any) => e.etapa), ['prospecto', 'visita_agendada', 'visita_realizada', 'propuesta_en_armado', 'propuesta_presentada'])
    assert.ok(r.body.etapas.every((e: any) => typeof e.posibles === 'number' && typeof e.valor_ponderado === 'number'))
    assert.ok(Array.isArray(r.body.por_origen))
    assert.ok('tasa_cierre' in r.body.cierres)
    assert.deepEqual(Object.keys(r.body.meta_ads).sort(), ['con_error', 'conectado', 'duplicados', 'leads_30d', 'procesados', 'total'])
    assert.equal((await api('/marketing/embudo?dias=3')).status, 400)
    assert.equal(data(await mcp('hayai_marketing_embudo', { dias: 30 })).dias, 30)
  })

  it('al presentar y al ganar, la entrada de etapa guarda la versión de la propuesta vigente', async () => {
    const { c } = await mkProp('Versión Propuesta')
    await api(`/clientes/${c.id}/propuestas`, { body: { items: items3(55) } }) // v2 reemplaza a v1
    const pres = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'propuesta_presentada' } })
    assert.equal(pres.status, 200, JSON.stringify(pres.body))
    const feed = (await api(`/clientes/${c.id}/interacciones?tipo=etapa`)).body.data
    const e1 = feed.find((e: any) => e.cambio.a === 'propuesta_presentada')
    assert.equal(e1.cambio.propuesta_version, 2)
    assert.match(e1.resumen, /propuesta v2/)
    const gan = await api(`/clientes/${c.id}`, { method: 'PATCH', body: { etapa: 'ganado', fecha_implementacion: isoDay(2), esquema_cobro: { inicio_cobro: isoDay(10), meses: 2, unicos_cobrados: false } } })
    assert.equal(gan.status, 200, JSON.stringify(gan.body))
    const e2 = (await api(`/clientes/${c.id}/interacciones?tipo=etapa`)).body.data.find((e: any) => e.cambio.a === 'ganado')
    assert.equal(e2.cambio.propuesta_version, 2)
    // sin propuesta no hay versión que registrar
    const sin = await mkPosible('Sin versión')
    await api(`/clientes/${sin.id}`, { method: 'PATCH', body: { etapa: 'visita_agendada' } })
    const e3 = (await api(`/clientes/${sin.id}/interacciones?tipo=etapa`)).body.data[0]
    assert.equal(e3.cambio.propuesta_version ?? null, null)
  })
})

describe('Migración 010: datos que se mueven al estrenar el hub', () => {
  // Se rehace la migración a mano sobre datos sembrados para probar sus bloques de datos (el esquema ya existe).
  const sql = readFileSync(resolve(root, 'server/db/migrations/010_hub_cobros.sql'), 'utf8')
  const doBlocks = [...sql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)].map((m) => m[0])

  it('hay bloques de datos y todos son re-ejecutables sin romper nada (idempotentes)', async () => {
    assert.ok(doBlocks.length >= 2)
    for (const b of doBlocks) await admin.query(b)
    for (const b of doBlocks) await admin.query(b)
  })

  it('cliente falso "HAYAI (interno)": sus proyectos pasan a internos, sus gastos a generales y el cliente se archiva; el total de Finanzas no cambia', async () => {
    const u = (await admin.query("SELECT id FROM users WHERE name = 'Leandro'")).rows[0].id
    const fake = (await admin.query("INSERT INTO clients (name, avatar, created_by) VALUES ('HAYAI (interno)', 'HI', $1) RETURNING id", [u])).rows[0].id
    const proj = (await admin.query("INSERT INTO projects (client_id, name, icon, owner_id, status, created_by) VALUES ($1, 'Sistema Space', 'code', $2, 'activo', $2) RETURNING id", [fake, u])).rows[0].id
    await admin.query("INSERT INTO expenses (date, concept, amount, category, scope, client_id, created_by) VALUES ('2026-10-02', 'Dominio', 11, 'Otros', 'cliente', $1, $2)", [fake, u])
    await admin.query("INSERT INTO expenses (date, concept, amount, category, scope, project_id, created_by) VALUES ('2026-10-03', 'Hosting Space', 9, 'Otros', 'proyecto', $1, $2)", [proj, u])
    const antes = (await api('/finanzas/resumen?periodo=todo')).body
    assert.equal(antes.clientes.some((c: any) => c.nombre === 'HAYAI (interno)'), true)
    for (const b of doBlocks) await admin.query(b)
    const p = (await api(`/proyectos/${proj}`)).body
    assert.deepEqual([p.cliente_id, p.es_interno], [null, true])
    const des = (await api('/finanzas/resumen?periodo=todo')).body
    assert.equal(des.gastos, antes.gastos, 'el total de gastos no cambia')
    assert.equal(des.balance, antes.balance)
    assert.equal(des.gastos_generales, antes.gastos_generales + 20, 'los 11 del cliente falso y los 9 de su proyecto ahora son generales')
    assert.equal(des.clientes.some((c: any) => c.nombre === 'HAYAI (interno)'), false, 'archivado y sin movimientos propios: no ocupa fila')
    assert.equal((await admin.query('SELECT archived_at IS NOT NULL AS a FROM clients WHERE id = $1', [fake])).rows[0].a, true)
    assert.equal((await api('/gastos?interno=true&per_page=100')).body.data.filter((g: any) => ['Dominio', 'Hosting Space'].includes(g.concepto)).length, 2)
  })

  it('Super Miga: con UN candidato se completa el cobro del caso real; con dos no se toca ninguno', async () => {
    const elis = (await admin.query("SELECT id FROM users WHERE name = 'Elis'")).rows[0].id
    const c = (await admin.query("INSERT INTO clients (name, avatar, created_by) VALUES ('Super Miga', 'SM', $1) RETURNING id", [elis])).rows[0].id
    const pay = (await admin.query("INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by) VALUES ($1, '2026-10-07', 'Mensualidad', 75, 'pago', 'cobrado', $2) RETURNING id", [c, elis])).rows[0].id
    for (const b of doBlocks) await admin.query(b)
    const r = (await api(`/pagos/${pay}`)).body
    assert.deepEqual([r.monto_bs, r.tasa, r.fecha_tasa, r.referencia, r.banco_origen, r.cuenta_origen_ultimos4, r.banco_destino, r.recibido_por?.nombre, r.metodo], [65540.25, 873.87, '2026-10-07', '071026007463', 'Bancrecer', '8017', 'Mercantil', 'Elis', 'transferencia'])
    // ya completado: otra pasada no cambia nada (idempotente)
    for (const b of doBlocks) await admin.query(b)
    assert.deepEqual((await api(`/pagos/${pay}`)).body, r)

    // dos candidatos iguales: se limpia el primero y se agrega otro => ambiguo, no se asume cuál es
    await admin.query('UPDATE payments SET bank_reference = NULL, amount_bs = NULL, exchange_rate = NULL, rate_date = NULL, bank_origin = NULL, origin_last4 = NULL, bank_destination = NULL, method = NULL, received_by = NULL, received_by_source = NULL WHERE id = $1', [pay])
    await admin.query("INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by) VALUES ($1, '2026-10-07', 'Otra', 75, 'pago', 'cobrado', $2)", [c, elis])
    for (const b of doBlocks) await admin.query(b)
    const n = (await admin.query('SELECT count(*)::int AS n FROM payments WHERE client_id = $1 AND bank_reference IS NOT NULL', [c])).rows[0].n
    assert.equal(n, 0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Barra superior: versión del sistema, tasa BCV e historial de versiones.
// ---------------------------------------------------------------------------------------------------------------------
describe('Barra superior: tasa BCV (caché en servidor, respaldo, fecha de la tasa)', () => {
  const caracas = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86_400_000))
  const oficial = (promedio: number, dia: string) => ({ moneda: 'USD', fuente: 'oficial', nombre: 'Dólar', compra: null, venta: null, promedio, fechaActualizacion: `${dia}T00:00:00-04:00` })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const version = async () => (await api('/version')).body

  it('parseRate: objeto o lista (fuente "oficial"), coma decimal, sin fecha = hoy; datos rotos y fechas imposibles se descartan', async () => {
    const { parseRate } = await import('../src/bcv.ts')
    const hoy = caracas()
    assert.deepEqual(parseRate(oficial(873.87, hoy)), { rate: 873.87, date: hoy })
    assert.deepEqual(parseRate([{ fuente: 'paralelo', promedio: 999 }, oficial(880.12345, hoy)]), { rate: 880.1235, date: hoy })
    assert.deepEqual(parseRate({ precio: '870,5' })?.rate, 870.5)
    assert.equal(parseRate({ promedio: 870 })?.date, hoy, 'sin fecha, la de hoy')
    assert.equal(parseRate(oficial(870, caracas(-3)))?.date, caracas(-3), 'fin de semana o feriado: la fecha que reporta la fuente')
    assert.equal(parseRate(oficial(870, caracas(1)))?.date, caracas(1), 'el BCV publica el día hábil siguiente')
    for (const bad of [null, 'x', [], [{ fuente: 'paralelo', promedio: 5 }], { promedio: 0 }, { promedio: -4 }, { promedio: 'abc' }, { promedio: 1e9 }, oficial(870, caracas(30))]) assert.equal(parseRate(bad), null, JSON.stringify(bad))
  })

  it('la primera consulta espera a la fuente; /version trae versión + tasa con su fecha y la fuente; las siguientes salen de la caché', async () => {
    bcvPayload.principal = oficial(873.87, caracas())
    const r = await api('/version')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.version, '1.7.5')
    assert.equal(r.body.hoy, caracas())
    assert.deepEqual({ ...r.body.bcv, actualizada_el: '<t>' }, { moneda: 'USD', tasa: 873.87, fecha: caracas(), es_de_hoy: true, fuente: `localhost:${BCV_PORT}`, actualizada_el: '<t>' })
    const hits = bcvHits.principal
    await version()
    assert.equal(bcvHits.principal, hits, 'dentro del TTL no vuelve a pedir')
  })

  it('caducada la caché responde al instante con lo guardado y actualiza en segundo plano; una sola petición aunque lleguen varias', async () => {
    bcvPayload.principal = oficial(880.5, caracas())
    await sleep(450)
    const hits = bcvHits.principal
    const primera = await version()
    assert.equal(primera.bcv.tasa, 873.87, 'no hace esperar: devuelve la tasa guardada')
    await Promise.all([version(), version()])
    await sleep(300)
    assert.equal(bcvHits.principal, hits + 1, 'un solo refresco para las tres consultas')
    assert.equal((await version()).bcv.tasa, 880.5, 'la corrección del mismo día reemplaza el valor')
  })

  it('si la principal falla usa el respaldo; si fallan todas se sigue sirviendo la última tasa (la barra nunca queda en blanco)', async () => {
    bcvPayload.principal = null
    bcvPayload.respaldo = [{ fuente: 'paralelo', promedio: 999 }, oficial(881.25, caracas())]
    await sleep(450)
    await version() // dispara el refresco
    await sleep(300)
    assert.equal((await version()).bcv.tasa, 881.25)
    assert.ok(bcvHits.respaldo >= 1)
    bcvPayload.respaldo = null
    await sleep(450)
    await version()
    await sleep(300)
    const v = await version()
    assert.equal(v.bcv.tasa, 881.25, 'todas fallan: queda la última guardada')
    assert.equal(v.bcv.fecha, caracas())
  })

  it('una tasa con fecha más vieja no pisa a la más reciente; una de mañana (publicada por adelantado) pasa a ser la vigente con es_de_hoy=false', async () => {
    bcvPayload.principal = oficial(700, caracas(-3))
    await sleep(450)
    await version()
    await sleep(300)
    const v = await version()
    assert.equal(v.bcv.tasa, 881.25)
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM exchange_rates WHERE rate_date = $1', [caracas(-3)])
    assert.equal(rows[0].n, 1, 'queda en el historial de tasas')
    bcvPayload.principal = oficial(890, caracas(1))
    await sleep(450)
    await version()
    await sleep(300)
    const f = await version()
    assert.deepEqual([f.bcv.tasa, f.bcv.fecha, f.bcv.es_de_hoy], [890, caracas(1), false])
  })

  it('MCP y web: la misma respuesta; sin llave o sin sesión 401', async () => {
    const m = data(await mcp('hayai_version_ver', {}))
    assert.equal(m.version, '1.7.5')
    assert.equal(m.bcv.tasa, 890)
    assert.equal((await http(`${ROOT}/api/v1/version`)).status, 401)
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const w = await http(`${ROOT}/api/version`, { headers: { cookie } })
    assert.equal(w.status, 200)
    assert.equal(w.body.bcv.tasa, 890)
    assert.equal((await http(`${ROOT}/api/version`)).status, 401)
  })
})

describe('Historial de versiones (changelog)', () => {
  const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const publicar = (b: Record<string, unknown>, key = KEY) => api('/versiones', { key, body: b })

  it('GET /versiones: 1.0.0, 1.5.0, 1.6.0, 1.6.5, 1.6.6, 1.6.7, 1.7.0 y 1.7.5 vienen publicadas; la más nueva primero y marcada como actual', async () => {
    const r = await api('/versiones')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.map((v: any) => [v.version, v.actual]), [['1.7.5', true], ['1.7.0', false], ['1.6.7', false], ['1.6.6', false], ['1.6.5', false], ['1.6.0', false], ['1.5.0', false], ['1.0.0', false]])
    const [v175, v17, v167, v166, , v16, v15, v10] = r.body.data
    assert.deepEqual([v175.titulo, v175.autor, v175.fecha, v175.cambios.length], ['Central de marketing', 'Equipo HAYAI', '2026-10-08', 12])
    assert.deepEqual([v167.titulo, v167.autor, v167.fecha, v167.cambios.length], ['Órbita fina III', 'Equipo HAYAI', '2026-10-08', 4])
    assert.deepEqual([v166.titulo, v166.autor, v166.fecha, v166.cambios.length], ['Órbita fina II', 'Equipo HAYAI', '2026-10-08', 7])
    assert.deepEqual([v17.titulo, v17.autor, v17.fecha, v17.cambios.length], ['Chat interno', 'Equipo HAYAI', '2026-10-08', 5])
    assert.deepEqual([v16.titulo, v16.autor, v16.fecha, v16.cambios.length], ['Feed de oportunidades', 'Equipo HAYAI', '2026-10-08', 6])
    assert.equal(v10.titulo, 'Lanzamiento inicial')
    assert.equal(v10.autor, 'Equipo HAYAI', 'las históricas no tienen autor individual')
    assert.ok(v15.cambios.length >= 10 && v15.cambios.every((c: string) => c.length > 10))
    for (const palabra of ['Actividad', 'Pipeline', 'Propuestas', 'Cobros', 'Factura', 'WhatsApp', 'MCP', 'Hub']) assert.ok(v15.cambios.join(' ').includes(palabra), palabra)
    assert.match(v15.fecha, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('POST /versiones: el autor es el dueño de la llave, la fecha por defecto es hoy, pasa a ser la actual y avisa al equipo', async () => {
    const base = (await api('/actividad?per_page=1', { key: KEY_J })).body.meta.ultimo_id as number
    const r = await publicar({ version: '1.7.6', titulo: 'Ajustes de la barra', cambios: ['Se muestra la tasa BCV con su fecha.', 'Se corrige el redondeo.'] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.version, r.body.autor, r.body.fecha, r.body.actual, r.body.cambios.length], ['1.7.6', 'Leandro', hoy(), true, 2])
    assert.equal((await api('/version')).body.version, '1.7.6')
    assert.equal((await api('/versiones')).body.data[0].version, '1.7.6')
    assert.equal((await api('/versiones')).body.data.filter((v: any) => v.actual).length, 1)
    const ev = ((await api(`/actividad?desde_id=${base}&orden=asc`, { key: KEY_J })).body.data as any[]).filter((e) => e.tipo === 'version_nueva')
    assert.equal(ev.length, 1)
    assert.equal(ev[0].texto, 'Nueva actualización v1.7.6 disponible: Ajustes de la barra') // la trae el sistema: no nombra al autor
    assert.equal(ev[0].propia, false)
    // y le llega a TODOS, también a quien la publicó (su pestaña abierta también debe enterarse)
    const mio = ((await api(`/actividad?desde_id=${base}&orden=asc`)).body.data as any[]).find((e) => e.tipo === 'version_nueva')
    assert.equal(mio.propia, false)
    assert.equal(mio.leida, false)
    const j = await publicar({ version: '1.9.0', cambios: ['Algo de Jorbi'], fecha: '2026-10-01' }, KEY_J)
    assert.deepEqual([j.body.autor, j.body.titulo, j.body.fecha], ['Jorbi', null, '2026-10-01'])
  })

  it('el orden es numérico (1.10.0 va después de 1.9.0) y la versión nueva siempre debe ser mayor que la actual', async () => {
    assert.equal((await publicar({ version: '1.10.0', cambios: ['x'] })).status, 201)
    assert.deepEqual((await api('/versiones')).body.data.map((v: any) => v.version), ['1.10.0', '1.9.0', '1.7.6', '1.7.5', '1.7.0', '1.6.7', '1.6.6', '1.6.5', '1.6.0', '1.5.0', '1.0.0'])
    assert.equal((await api('/version')).body.version, '1.10.0')
    for (const v of ['1.10.0', '1.9.5', '1.4.0', '0.9.0']) {
      const r = await publicar({ version: v, cambios: ['x'] })
      assert.equal(r.status, 409, v)
    }
    assert.match((await publicar({ version: '1.9.9', cambios: ['x'] })).body.error.message, /mayor que la actual \(1\.10\.0\)/)
  })

  it('valida: formato semver, al menos un cambio, textos no vacíos, fecha no futura, sin campos de más', async () => {
    const bad: Record<string, unknown>[] = [
      { version: 'v2.0', cambios: ['x'] },
      { version: '2.0', cambios: ['x'] },
      { version: '2.0.0-beta', cambios: ['x'] },
      { version: '2.0.0', cambios: [] },
      { version: '2.0.0', cambios: ['  '] },
      { version: '2.0.0', cambios: 'texto suelto' },
      { version: '2.0.0' },
      { version: '2.0.0', cambios: ['x'], fecha: '2099-01-01' },
      { version: '2.0.0', cambios: ['x'], titulo: 'y'.repeat(81) },
      { version: '2.0.0', cambios: ['x'], autor: 'Elis' },
      { version: '2.0.0', cambios: Array.from({ length: 61 }, () => 'x') },
    ]
    for (const b of bad) assert.equal((await publicar(b)).status, 400, JSON.stringify(b).slice(0, 80))
    assert.equal((await api('/version')).body.version, '1.10.0', 'nada de lo rechazado quedó publicado')
  })

  it('dos publicaciones a la vez de la misma versión: una gana y la otra recibe 409 (nadie se salta la regla de orden)', async () => {
    const [a, b] = await Promise.all([publicar({ version: '1.11.0', cambios: ['A'] }), publicar({ version: '1.11.0', cambios: ['B'] }, KEY_J)])
    assert.deepEqual([a.status, b.status].sort(), [201, 409])
    assert.equal((await api('/versiones')).body.data.filter((v: any) => v.version === '1.11.0').length, 1)
  })

  it('permisos: una llave de solo lectura lee pero no publica; el historial no se edita ni se borra', async () => {
    const ro = newKey('Elis', 'solo-lectura-versiones', 'read')
    assert.equal((await api('/versiones', { key: ro })).status, 200)
    assert.equal((await publicar({ version: '3.0.0', cambios: ['x'] }, ro)).status, 403)
    const id = (await api('/versiones')).body.data[0].id
    for (const m of ['PATCH', 'DELETE', 'PUT']) assert.equal((await api(`/versiones/${id}`, { method: m, body: {} })).status, 404, m)
    assert.equal((await http(`${ROOT}/api/v1/versiones`)).status, 401)
  })

  it('MCP: hayai_versiones_listar y hayai_version_publicar (autor = dueño de la llave)', async () => {
    const l = data(await mcp('hayai_versiones_listar', {}))
    assert.ok(l.data.length >= 5 && l.data[0].actual === true)
    const p = data(await mcp('hayai_version_publicar', { version: '1.12.0', titulo: 'Desde un agente', cambios: ['Publicado por MCP'] }, KEY_J))
    assert.deepEqual([p.version, p.autor, p.actual], ['1.12.0', 'Jorbi', true])
    assert.equal(data(await mcp('hayai_version_ver', {})).version, '1.12.0')
    const err = await http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hayai_version_publicar', arguments: { version: '1.12.0', cambios: ['otra vez'] } } } })
    assert.equal(err.body.result.isError, true, 'versión repetida => error de herramienta')
  })

  it('web (sesión): ver, listar y publicar; el autor es quien tiene la sesión', async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const web = (path: string, o: { method?: string; body?: unknown } = {}) => http(`${ROOT}/api${path}`, { headers: { cookie }, ...o })
    assert.equal((await web('/versions')).body.data[0].version, '1.12.0')
    const p = await web('/versions', { body: { version: '1.13.0', cambios: ['Desde el formulario'] } })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.equal(p.body.autor, 'Jorbi')
    assert.equal((await web('/version')).body.version, '1.13.0')
    assert.equal((await web('/versions', { body: { version: '1.13.0', cambios: ['x'] } })).status, 409)
    assert.equal((await http(`${ROOT}/api/versions`, { body: { version: '9.9.9', cambios: ['x'] } })).status, 401)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Aviso de actualización (campana, en vivo, agentes) y guardado sin pisar a nadie (If-Match / actualizado_el).
// ---------------------------------------------------------------------------------------------------------------------
describe('Aviso de actualización y conflictos al guardar', () => {
  const alertas = async (key: string, q = '') => (await api(`/notificaciones?per_page=100${q}`, { key })).body
  const publicar = (b: Record<string, unknown>, key = KEY) => api('/versiones', { key, body: b })

  it('publicar una versión crea la alerta «Nueva actualización vX disponible» para TODOS los socios, y se lee por socio', async () => {
    const r = await publicar({ version: '2.0.0', titulo: 'Gran salto', cambios: ['Algo nuevo'] })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    for (const key of [KEY, KEY_J]) {
      const a = (await alertas(key, '&tipo=actualizacion')).data as any[]
      assert.equal(a.length, 1, 'solo la versión vigente')
      assert.deepEqual(
        [a[0].clave, a[0].tipo, a[0].titulo, a[0].detalle, a[0].version, a[0].leida, a[0].cliente_id, a[0].cliente, a[0].monto],
        ['version:2.0.0', 'actualizacion', 'Nueva actualización v2.0.0 disponible', 'Gran salto', '2.0.0', false, null, null, null],
      )
    }
    // Primera de la lista: es lo más reciente y afecta a todos.
    assert.equal((await alertas(KEY)).data[0].clave, 'version:2.0.0')
    // Leerla (por clave) solo la marca para quien la leyó.
    const m = await api('/notificaciones/leer', { body: { claves: ['version:2.0.0'] } })
    assert.equal(m.status, 200, JSON.stringify(m.body))
    assert.equal(m.body.marcadas, 1)
    assert.equal(((await alertas(KEY, '&tipo=actualizacion')).data as any[])[0].leida, true)
    assert.equal(((await alertas(KEY_J, '&tipo=actualizacion')).data as any[])[0].leida, false, 'Jorbi aún no la leyó')
    assert.equal((await api('/notificaciones/leer', { body: { claves: ['version:9.9.9'] } })).body.marcadas, 0, 'una versión que no es la vigente no existe como alerta')
    assert.equal((await api('/notificaciones?tipo=otra')).status, 400)
  })

  it('la actividad es del sistema: avisa a todos con el texto del aviso y llega a quien publicó', async () => {
    const base = (await api('/actividad?per_page=1')).body.meta.ultimo_id as number
    assert.equal((await publicar({ version: '2.0.1', titulo: 'Parche', cambios: ['Fix'] }, KEY_J)).status, 201)
    for (const key of [KEY, KEY_J]) {
      const ev = ((await api(`/actividad?desde_id=${base}&orden=asc`, { key })).body.data as any[]).filter((e) => e.tipo === 'version_nueva')
      assert.equal(ev.length, 1)
      assert.deepEqual([ev[0].texto, ev[0].propia, ev[0].leida, ev[0].sujeto], ['Nueva actualización v2.0.1 disponible: Parche', false, false, '2.0.1'])
    }
  })

  it('/version trae el cambio de la versión y, con ?desde=, lo que cambió desde la que conocías (para agentes)', async () => {
    const v = (await api('/version')).body
    assert.deepEqual([v.version, v.titulo, v.cambios, typeof v.anunciada_el], ['2.0.1', 'Parche', ['Fix'], 'string'])
    assert.equal(v.novedades, undefined, 'sin desde no hay novedades')
    const n = (await api('/version?desde=2.0.0')).body.novedades
    assert.deepEqual([n.desde, n.hay_cambios, n.versiones.map((x: any) => x.version)], ['2.0.0', true, ['2.0.1']])
    assert.equal(n.versiones[0].cambios[0], 'Fix')
    const igual = (await api('/version?desde=2.0.1')).body.novedades
    assert.deepEqual([igual.hay_cambios, igual.versiones], [false, []])
    assert.deepEqual(((await api('/versiones?desde=1.13.0')).body.data as any[]).map((x) => x.version), ['2.0.1', '2.0.0'])
    assert.equal((await api('/version?desde=abc')).status, 400)
  })

  it('cada respuesta de la API, del MCP y de la web trae X-Hayai-Version (la fuente de verdad es /version)', async () => {
    const top = (await api('/version')).body.version
    assert.equal((await api('/clientes?per_page=1')).headers.get('x-hayai-version'), top)
    assert.equal((await api('/me')).headers.get('x-hayai-version'), top)
    assert.equal((await http(`${ROOT}/api/v1/clientes`)).headers.get('x-hayai-version'), null, 'sin llave no hay respuesta útil: 401 sin cabecera')
    const m = await http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } } })
    assert.equal(m.headers.get('x-hayai-version'), top)
    assert.equal(m.body.result.serverInfo.version, top, 'serverInfo.version = versión del sistema')
    assert.match(m.body.result.instructions, new RegExp(`Versión actual del sistema: v${top.replace(/\./g, '\\.')}`))
    const web = await http(`${ROOT}/api/auth/me`)
    assert.equal(web.headers.get('x-hayai-version'), top, 'también en la web, incluso sin sesión')
  })

  it('al arrancar, la versión vigente sin anunciar (sembrada por una migración) se anuncia UNA sola vez', async () => {
    const top = (await api('/version')).body.version as string
    await admin.query('UPDATE app_versions SET announced_at = NULL WHERE version = $1', [top])
    const run = (extra: Record<string, string> = {}) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./server/src/services/versiones.ts').then((m) => m.announceCurrentVersion()).then((v) => { console.log('ANUNCIADA:' + v); process.exit(0) })"], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.match(/ANUNCIADA:(.*)/)![1]
    }
    const base = (await api('/actividad?per_page=1')).body.meta.ultimo_id as number
    assert.equal(run({ ANNOUNCE_VERSION: 'false' }), 'null', 'apagado por entorno')
    assert.equal(run({ ANNOUNCE_VERSION: 'true' }), top)
    assert.equal(run({ ANNOUNCE_VERSION: 'true' }), 'null', 'idempotente: no se repite al reiniciar')
    const ev = ((await api(`/actividad?desde_id=${base}&orden=asc`)).body.data as any[]).filter((e) => e.tipo === 'version_nueva')
    assert.equal(ev.length, 1)
    assert.equal(ev[0].sujeto, top)
    assert.equal(typeof (await api('/version')).body.anunciada_el, 'string')
    // Una versión histórica sin autor se anuncia a nombre del socio activo más antiguo (la actividad exige un actor).
    await admin.query('UPDATE app_versions SET announced_at = NULL, author_id = NULL WHERE version = $1', [top])
    assert.equal(run({ ANNOUNCE_VERSION: 'true' }), top)
  })

  // ---------- conflictos ----------
  const stampOf = async (path: string) => {
    // Los acuerdos no tienen lectura individual: el sello sale de la lista.
    const m = path.match(/^\/acuerdos\/(.+)$/)
    if (m) return ((await api('/acuerdos')).full.data as any[]).find((x) => x.id === m[1]).actualizado_el as string
    return (await api(path)).full.actualizado_el as string
  }
  const espera = (ms = 15) => new Promise((r) => setTimeout(r, ms))

  it('cliente: If-Match con la versión vista guarda; con una vieja da 409 con la versión actual; sin versión guarda como siempre', async () => {
    const c = await api('/clientes', { body: { nombre: 'Conflicto SA' } })
    assert.equal(c.status, 201)
    const id = c.body.id as string
    const v1 = c.full.actualizado_el as string
    assert.match(v1, /^\d{4}-\d{2}-\d{2}T.*Z$/)
    // el sistema (o un socio) cambia el registro mientras otro lo edita
    await espera()
    const otro = await api(`/clientes/${id}`, { method: 'PATCH', body: { telefono: '+584141112222' }, key: KEY_J })
    assert.equal(otro.status, 200)
    const v2 = otro.full.actualizado_el as string
    assert.notEqual(v2, v1)
    const viejo = await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'mi cambio' }, headers: { 'if-match': `"${v1}"` } })
    assert.equal(viejo.status, 409)
    assert.deepEqual([viejo.body.error.code, viejo.body.error.codigo, viejo.full.error.actualizado_el], ['conflict', 'conflicto', v2])
    assert.match(viejo.body.error.message, /cambió mientras lo editabas/)
    assert.equal((await api(`/clientes/${id}`)).body.notas, null, 'no se guardó nada')
    assert.equal((await api(`/clientes/${id}`)).body.telefono, '+584141112222', 'lo del otro sigue intacto')
    // la versión al día guarda (cabecera o campo del cuerpo)
    const ok = await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'ahora sí' }, headers: { 'if-match': v2 } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.notas, 'ahora sí')
    const v3 = ok.full.actualizado_el as string
    const body = await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'por el cuerpo', actualizado_el: v3 } })
    assert.equal(body.status, 200, JSON.stringify(body.body))
    const viejoCuerpo = await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'x', actualizado_el: v1 } })
    assert.equal(viejoCuerpo.status, 409)
    // compatibilidad aditiva: un cliente viejo (sin versión) sigue guardando
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'sin versión' } })).status, 200)
    // valor inválido: 400 legible, no 500
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'x' }, headers: { 'if-match': 'ayer' } })).status, 400)
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'x', actualizado_el: 12 } })).status, 400)
    // "*" y vacío = sin condición
    assert.equal((await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'comodín' }, headers: { 'if-match': '*' } })).status, 200)
  })

  it('proyecto, tarea, cobro, gasto, acuerdo y propuesta: misma regla (409 si cambió, guarda si está al día)', async () => {
    const cli = (await api('/clientes', { body: { nombre: 'Versionado SA' } })).body.id as string
    const p = (await api('/proyectos', { body: { nombre: 'Proy versión', cliente_id: cli } })).body.id as string
    const t = (await api('/tareas', { body: { titulo: 'Tarea versión', proyecto_id: p } })).body.id as string
    const g = (await api('/gastos', { body: { concepto: 'Gasto versión', monto: 5, categoria: 'Otros', fecha: '2026-10-01' } })).body.id as string
    const a = (await api('/acuerdos', { body: { texto: 'Acuerdo versión' } })).body.id as string
    await api(`/clientes/${cli}/pagos`, { body: { fecha: '2026-11-01', monto: 10, concepto: 'Cuota versión' } })
    const pg = ((await api(`/pagos?cliente_id=${cli}`)).body.data as any[])[0].id as string
    const prop = await mkProp('Propuesta versión')
    const casos: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
      ['proyecto', `/proyectos/${p}`, { descripcion: 'otro cambio' }, { descripcion: 'mi cambio' }],
      ['tarea', `/tareas/${t}`, { titulo: 'Tarea cambiada por otro' }, { titulo: 'Mi título' }],
      ['pago', `/pagos/${pg}`, { concepto: 'Cuota (otro)' }, { concepto: 'Cuota (mía)' }],
      ['gasto', `/gastos/${g}`, { concepto: 'Gasto (otro)' }, { concepto: 'Gasto (mío)' }],
      ['acuerdo', `/acuerdos/${a}`, { texto: 'Acuerdo (otro)' }, { texto: 'Acuerdo (mío)' }],
      ['propuesta', `/propuestas/${prop.p.id}`, { notas: 'Notas (otro)' }, { notas: 'Notas (mías)' }],
    ]
    for (const [nombre, path, deOtro, mio] of casos) {
      const visto = await stampOf(path)
      assert.match(visto, /^\d{4}-\d{2}-\d{2}T/, `${nombre}: la lectura trae actualizado_el`)
      await espera()
      assert.equal((await api(path, { method: 'PATCH', body: deOtro, key: KEY_J })).status, 200, nombre)
      const r = await api(path, { method: 'PATCH', body: mio, headers: { 'if-match': visto } })
      assert.equal(r.status, 409, `${nombre}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.error.codigo, 'conflicto', nombre)
      const fresco = await stampOf(path)
      assert.equal(r.full.error.actualizado_el, fresco, nombre)
      const ok = await api(path, { method: 'PATCH', body: mio, headers: { 'if-match': fresco } })
      assert.equal(ok.status, 200, `${nombre}: ${JSON.stringify(ok.body)}`)
    }
  })

  it('completar una tarea y marcar cobrado también respetan la versión (el borrador viejo no revive nada)', async () => {
    const cli = (await api('/clientes', { body: { nombre: 'Cobro versión SA' } })).body.id as string
    const p = (await api('/proyectos', { body: { nombre: 'P', cliente_id: cli } })).body.id as string
    const t = (await api('/tareas', { body: { titulo: 'T', proyecto_id: p } })).body.id as string
    const visto = await stampOf(`/tareas/${t}`)
    await espera()
    await api(`/tareas/${t}`, { method: 'PATCH', body: { vence: '2026-12-01' }, key: KEY_J })
    assert.equal((await api(`/tareas/${t}`, { method: 'PATCH', body: { estado: 'completada' }, headers: { 'if-match': visto } })).status, 409)
    assert.equal((await api(`/tareas/${t}`)).body.estado, 'pendiente')
  })

  it('MCP: actualizado_el opcional en las herramientas de edición; el conflicto vuelve como error legible con la versión actual', async () => {
    const c = await api('/clientes', { body: { nombre: 'Agente versión SA' } })
    const id = c.body.id as string
    const visto = c.full.actualizado_el as string
    await espera()
    await api(`/clientes/${id}`, { method: 'PATCH', body: { notas: 'otro agente' }, key: KEY_J })
    const raw = await http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hayai_cliente_actualizar', arguments: { id, notas: 'mi cambio', actualizado_el: visto } } } })
    assert.equal(raw.body.result.isError, true)
    assert.match(raw.body.result.content[0].text, /cambió mientras lo editabas.*actualizado_el actual: \d{4}-/)
    const sin = await mcp('hayai_cliente_actualizar', { id, notas: 'sin versión' })
    assert.equal(data(sin).notas, 'sin versión', 'sin actualizado_el guarda como siempre')
    const fresco = data(await mcp('hayai_cliente_ver', { id })).actualizado_el
    assert.equal(data(await mcp('hayai_cliente_actualizar', { id, notas: 'al día', actualizado_el: fresco })).notas, 'al día')
    // la herramienta anuncia el campo en su esquema
    const list = await http(`${ROOT}/mcp`, { key: KEY, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} } })
    const tools = list.full.result.tools as any[]
    assert.ok(tools.find((x) => x.name === 'hayai_cliente_actualizar').inputSchema.properties.actualizado_el)
    assert.equal(tools.find((x) => x.name === 'hayai_tarea_crear').inputSchema.properties.actualizado_el, undefined)
  })

  it('web (sesión): If-Match en PATCH de cliente, proyecto y tarea; las listas traen updatedAt', async () => {
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    const web = (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      http(`${ROOT}/api${path}`, { ...o, headers: { cookie, ...(o.headers ?? {}) } })
    const clients = (await web('/clients')).body as any[]
    const c = clients.find((x) => x.name === 'Conflicto SA')
    assert.match(c.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    await espera()
    assert.equal((await web(`/clients/${c.id}`, { method: 'PATCH', body: { name: 'Conflicto SRL' } })).status, 200)
    const viejo = await web(`/clients/${c.id}`, { method: 'PATCH', body: { name: 'Mi nombre' }, headers: { 'if-match': c.updatedAt } })
    assert.equal(viejo.status, 409)
    assert.equal(viejo.body.codigo, 'conflicto')
    assert.match(viejo.body.error, /cambió mientras lo editabas/)
    const ficha = await web(`/clients/${c.id}/ficha`, { method: 'PATCH', body: { notes: 'web' }, headers: { 'if-match': c.updatedAt } })
    assert.equal(ficha.status, 409)
    const fresco = ((await web('/clients')).body as any[]).find((x) => x.id === c.id).updatedAt
    assert.equal((await web(`/clients/${c.id}/ficha`, { method: 'PATCH', body: { notes: 'web' }, headers: { 'if-match': fresco } })).status, 200)
    // proyecto y tarea
    const proj = ((await web('/projects')).body as any[])[0]
    assert.match(proj.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    const task = ((await web('/tasks')).body as any[])[0]
    assert.match(task.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    await espera()
    await web(`/tasks/${task.id}`, { method: 'PATCH', body: { due: '2027-01-01' } })
    assert.equal((await web(`/tasks/${task.id}`, { method: 'PATCH', body: { done: true }, headers: { 'if-match': task.updatedAt } })).status, 409)
    await web(`/projects/${proj.id}`, { method: 'PATCH', body: { description: 'cambiada' } })
    assert.equal((await web(`/projects/${proj.id}`, { method: 'PATCH', body: { name: 'otro' }, headers: { 'if-match': proj.updatedAt } })).status, 409)
    // cobros del cliente: cada movimiento trae su versión
    const conMov = ((await web('/clients')).body as any[]).find((x) => x.movements.length)
    assert.match(conMov.movements[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('un cambio que hace el SISTEMA (una migración o tarea) también bumpea la versión: el editor lo detecta', async () => {
    const c = await api('/clientes', { body: { nombre: 'Sistema toca SA' } })
    const visto = c.full.actualizado_el as string
    await espera()
    await admin.query(`UPDATE clients SET notes = 'migración' WHERE id = $1`, [c.body.id]) // como un deploy que corrige datos
    const r = await api(`/clientes/${c.body.id}`, { method: 'PATCH', body: { telefono: '+584140000000' }, headers: { 'if-match': visto } })
    assert.equal(r.status, 409)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Feed de oportunidades: lo que las máquinas y los agentes ENCONTRARON (la bitácora es lo que el equipo HIZO).
describe('Feed de oportunidades', () => {
  let n = 0
  const rpc = (method: string, params: unknown = {}, key: string | null = KEY) =>
    http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: ++n, method, params } })
  const mcp = async (name: string, args: unknown = {}, key: string | null = KEY) => (await rpc('tools/call', { name, arguments: args }, key)).body
  const dato = (b: any) => JSON.parse(b.result.content[0].text)
  const pub = (body: unknown, key = KEY) => api('/feed', { body, key })
  const eventos = async (desde: number, key = KEY_J) =>
    ((await api(`/actividad?desde_id=${desde}&orden=asc&per_page=100`, { key })).body.data as any[]).filter((e) => e.tipo === 'feed_nuevo')
  const ultimo = async () => ((await api('/actividad?per_page=1')).body.meta.ultimo_id as number) ?? 0
  let cookie = ''
  let KEY_R = '' // solo lectura
  let idea = ''
  let prospecto = ''

  before(async () => {
    KEY_R = newKey('Jorbi', 'solo-lectura-feed', 'read')
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
  })

  it('publicar: quien publica sale de la llave, nace "nuevo"; la fuente se normaliza; datos de forma libre', async () => {
    const r = await pub({
      titulo: 'Panadería La Espiga: 3 fugas en su Instagram',
      resumen: 'Responden tarde y no cobran los encargos por adelantado.',
      tipo: 'prospecto',
      fuente: 'Video-Auditorias',
      clave_externa: 'va-001',
      datos: { negocio: { nombre: 'Panadería La Espiga' }, fugas: ['No responde DMs', 'Sin catálogo'], guion: 'Hola, vi tu panadería…', urls: ['https://instagram.com/laespiga'] },
      fecha: '2026-10-01',
      categoria: ' Panadería ',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.estado, r.body.tipo, r.body.fuente, r.body.publicado_por.nombre, r.body.creado, r.body.convertido, r.body.mi_estado, r.body.guardado, r.body.categoria], ['nuevo', 'prospecto', 'video-auditorias', 'Leandro', true, null, 'nuevo', false, 'panadería'])
    assert.equal(r.body.datos.fugas.length, 2)
    assert.match(r.body.fecha, /^2026-10-01T/)
    assert.ok(r.full.actualizado_el)
    prospecto = r.body.id
    const idem = await pub({ titulo: 'Otro título', tipo: 'idea', fuente: 'video-auditorias', clave_externa: 'va-001' })
    assert.equal(idem.status, 200, 'misma (fuente, clave_externa): no se duplica')
    assert.deepEqual([idem.body.id, idem.body.creado, idem.body.titulo], [prospecto, false, 'Panadería La Espiga: 3 fugas en su Instagram'])
    const otraFuente = await pub({ titulo: 'Misma clave, otra fuente', tipo: 'idea', fuente: 'radar-hayai', clave_externa: 'va-001' })
    assert.equal(otraFuente.status, 201)
    idea = otraFuente.body.id
    assert.equal((await pub({ titulo: 'Sin clave 1', tipo: 'idea', fuente: 'manual' })).status, 201)
    assert.equal((await pub({ titulo: 'Sin clave 1', tipo: 'idea', fuente: 'manual' })).status, 201, 'sin clave_externa no hay idempotencia')
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM feed_items WHERE source = 'video-auditorias' AND external_key = 'va-001'`)).rows[0].n, 1)
    // Otro socio publicando con su llave: se atribuye a él
    assert.equal((await pub({ titulo: 'Idea de Jorbi', tipo: 'idea', fuente: 'muse-jorbi' }, KEY_J)).body.publicado_por.nombre, 'Jorbi')
  })

  it('validación: fuente, tipo, título, datos, fecha futura, campos desconocidos y lote mal armado', async () => {
    const ok = { titulo: 'X', tipo: 'idea', fuente: 'manual' }
    const malos: [string, unknown][] = [
      ['fuente con espacio', { ...ok, fuente: 'radar hayai' }],
      ['fuente vacía', { ...ok, fuente: '' }],
      ['tipo inválido', { ...ok, tipo: 'chisme' }],
      ['título vacío', { ...ok, titulo: '' }],
      ['título largo', { ...ok, titulo: 'x'.repeat(161) }],
      ['datos no objeto', { ...ok, datos: ['a'] }],
      ['datos enormes', { ...ok, datos: { x: 'y'.repeat(70_000) } }],
      ['fecha futura', { ...ok, fecha: '2999-01-01' }],
      ['fecha basura', { ...ok, fecha: 'ayer' }],
      ['campo desconocido', { ...ok, prioridad: 'alta' }],
      ['categoría vacía', { ...ok, categoria: '  ' }],
      ['categoría larga', { ...ok, categoria: 'x'.repeat(41) }],
      ['faltan campos', { titulo: 'Solo título' }],
      ['ítem y lista juntos', { ...ok, items: [ok] }],
      ['lista vacía', { items: [] }],
      ['lista de 51', { items: Array.from({ length: 51 }, () => ok) }],
      ['ítem malo dentro del lote', { items: [ok, { ...ok, tipo: 'x' }] }],
    ]
    for (const [que, body] of malos) {
      const r = await api('/feed', { body })
      assert.equal(r.status, 400, `${que}: ${JSON.stringify(r.body)}`)
    }
  })

  it('lote (items): una llamada, orden respetado, duplicados contados, también dentro del mismo lote', async () => {
    const r = await pub({
      items: [
        { titulo: 'Lote A', tipo: 'idea', fuente: 'radar-lote', clave_externa: 'a' },
        { titulo: 'Lote B', tipo: 'idea', fuente: 'radar-lote', clave_externa: 'b' },
        { titulo: 'Lote A repetido', tipo: 'idea', fuente: 'radar-lote', clave_externa: 'a' },
      ],
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.recibidos, r.body.creados, r.body.duplicados], [3, 2, 1])
    assert.deepEqual(r.body.data.map((x: any) => [x.titulo, x.creado]), [['Lote A', true], ['Lote B', true], ['Lote A', false]])
    const de = await pub({ items: [{ titulo: 'Lote A', tipo: 'idea', fuente: 'radar-lote', clave_externa: 'a' }] })
    assert.equal(de.status, 200, 'si no se creó nada, 200')
    assert.equal(de.body.creados, 0)
  })

  it('listar: filtros por tipo, estado, fuente y texto (sin acentos), paginación y contadores globales', async () => {
    const todo = await api('/feed?per_page=100')
    assert.equal(todo.status, 200)
    assert.ok(todo.body.meta.nuevos >= 6)
    assert.equal(todo.body.meta.nuevos, todo.body.meta.por_estado.nuevo)
    assert.ok(todo.body.meta.por_tipo.idea.total >= 4 && todo.body.meta.por_tipo.prospecto.total >= 1)
    assert.ok(todo.body.meta.fuentes.some((f: any) => f.fuente === 'radar-lote' && f.total === 2))
    // recientes primero
    const fechas = todo.body.data.map((x: any) => x.fecha)
    assert.deepEqual(fechas, [...fechas].sort().reverse())
    assert.equal((await api('/feed?tipo=prospecto')).body.data.every((x: any) => x.tipo === 'prospecto'), true)
    assert.equal((await api('/feed?fuente=radar-lote')).body.meta.total, 2)
    assert.equal((await api('/feed?q=panaderia')).body.data[0].id, prospecto, 'busca sin importar acentos')
    assert.equal((await api('/feed?q=espiga&tipo=idea')).body.data.length, 0)
    const p1 = await api('/feed?per_page=2&page=1')
    const p2 = await api('/feed?per_page=2&page=2')
    assert.equal(p1.body.data.length, 2)
    assert.ok(!p2.body.data.some((x: any) => p1.body.data.some((y: any) => y.id === x.id)))
    // los contadores no dependen del filtro
    assert.equal((await api('/feed?fuente=radar-lote')).body.meta.nuevos, todo.body.meta.nuevos)
    for (const q of ['tipo=chisme', 'estado=roto', 'fuente=Con Espacio', 'per_page=0', 'raro=1']) assert.equal((await api(`/feed?${q}`)).status, 400, q)
    assert.equal((await api(`/feed/${prospecto}`)).body.id, prospecto)
    assert.equal((await api(`/feed/${NOPE}`)).status, 404)
  })

  it('categoría y Growi: filtro por categoría y "sin_categoria", contadores, republicar completa la categoría, el nombre viejo de la fuente cae en growi', async () => {
    const c1 = await pub({ titulo: 'Restaurante El Fogón', tipo: 'prospecto', fuente: 'growi', clave_externa: 'g-1', categoria: 'Restaurante' })
    assert.equal(c1.status, 201, JSON.stringify(c1.body))
    assert.equal(c1.body.categoria, 'restaurante')
    const c2 = await pub({ titulo: 'Sin categoría todavía', tipo: 'prospecto', fuente: 'gumloop-video-auditorias', clave_externa: 'g-2' })
    assert.equal(c2.body.fuente, 'growi', 'el nombre anterior se normaliza a growi')
    assert.equal(c2.body.categoria, null)
    // republicar con categoría la completa (si no tenía); no pisa una que ya tiene
    const c2b = await pub({ titulo: 'Sin categoría todavía', tipo: 'prospecto', fuente: 'growi', clave_externa: 'g-2', categoria: 'Ferretería' })
    assert.deepEqual([c2b.status, c2b.body.id, c2b.body.creado, c2b.body.categoria], [200, c2.body.id, false, 'ferretería'])
    const c1b = await pub({ titulo: 'Restaurante El Fogón', tipo: 'prospecto', fuente: 'growi', clave_externa: 'g-1', categoria: 'otra' })
    assert.equal(c1b.body.categoria, 'restaurante')
    const sin = await api('/feed?categoria=sin_categoria&per_page=100')
    assert.ok(sin.body.data.every((x: any) => x.categoria === null))
    assert.equal(sin.body.meta.total, sin.body.meta.sin_categoria)
    const rest = await api('/feed?categoria=restaurante')
    assert.deepEqual(rest.body.data.map((x: any) => x.id), [c1.body.id])
    assert.ok(rest.body.meta.categorias.some((c: any) => c.categoria === 'restaurante' && c.total === 1))
    assert.ok(rest.body.meta.categorias.some((c: any) => c.categoria === 'panadería'))
    assert.equal((await api('/feed?fuente=growi')).body.meta.total, 2)
    assert.equal((await api('/feed?categoria=' + 'x'.repeat(41))).status, 400)
  })

  it('guardar: es personal (no lo ve otro socio), vale también en convertidos, se filtra con guardado=true y se quita con guardado:false', async () => {
    const g = await api(`/feed/${idea}/guardar`, { body: {} })
    assert.equal(g.status, 200, JSON.stringify(g.body))
    assert.deepEqual([g.body.guardado, g.body.estado, g.body.mi_estado], [true, 'nuevo', 'nuevo'])
    assert.equal((await api(`/feed/${idea}`, { key: KEY_J })).body.guardado, false, 'Jorbi no lo guardó')
    const mios = await api('/feed?guardado=true')
    assert.deepEqual(mios.body.data.map((x: any) => x.id), [idea])
    assert.equal(mios.body.meta.guardados, 1)
    assert.equal((await api('/feed?guardado=true', { key: KEY_J })).body.data.length, 0)
    assert.ok((await api('/feed?guardado=false&per_page=100')).body.data.every((x: any) => x.guardado === false))
    // sigue guardado aunque lo revise o descarte (son cosas distintas)
    await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'descartado', motivo: 'luego' } })
    const d = (await api(`/feed/${idea}`)).body
    assert.deepEqual([d.guardado, d.mi_estado], [true, 'descartado'])
    await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'nuevo' } })
    const q = await api(`/feed/${idea}/guardar`, { body: { guardado: false } })
    assert.equal(q.body.guardado, false)
    assert.equal((await api('/feed?guardado=true')).body.data.length, 0)
    assert.equal((await api(`/feed/${NOPE}/guardar`, { body: {} })).status, 404)
    assert.equal((await api(`/feed/${idea}/guardar`, { body: { guardado: 'si' } })).status, 400)
    assert.equal((await api(`/feed/${idea}/guardar`, { body: {}, key: KEY_R })).status, 403)
  })

  it('marcar: es PERSONAL (revisado/descartado con motivo corto/vuelve a nuevo); a los demás socios no les cambia nada; "convertido" no se marca a mano', async () => {
    const rev = await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'revisado' } })
    assert.equal(rev.status, 200, JSON.stringify(rev.body))
    assert.deepEqual([rev.body.estado, rev.body.mi_estado], ['nuevo', 'revisado'], 'estado es global; mi_estado, mío')
    assert.equal((await api(`/feed/${idea}`, { key: KEY_J })).body.mi_estado, 'nuevo', 'Jorbi lo sigue viendo nuevo')
    const des = await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'descartado', motivo: 'Ya lo hace otro competidor' } })
    assert.deepEqual([des.body.mi_estado, des.body.motivo_descarte], ['descartado', 'Ya lo hace otro competidor'])
    assert.equal((await api(`/feed/${idea}`, { key: KEY_J })).body.motivo_descarte, null)
    // cada quien con lo suyo: Jorbi lo revisa, Leandro lo sigue teniendo descartado
    assert.equal((await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'revisado' }, key: KEY_J })).body.mi_estado, 'revisado')
    assert.equal((await api(`/feed/${idea}`)).body.mi_estado, 'descartado')
    // los filtros y contadores son los de quien consulta
    assert.ok((await api('/feed?estado=descartado&per_page=100')).body.data.some((x: any) => x.id === idea))
    assert.ok(!(await api('/feed?estado=descartado&per_page=100', { key: KEY_J })).body.data.some((x: any) => x.id === idea))
    const nj = (await api('/feed', { key: KEY_J })).body.meta.nuevos
    const nl = (await api('/feed')).body.meta.nuevos
    assert.ok(nl === nj, 'Leandro descartó 1 y Jorbi revisó 1: ambos tienen uno menos')
    await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'nuevo' }, key: KEY_J })
    const nuevo = await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'nuevo' } })
    assert.deepEqual([nuevo.body.mi_estado, nuevo.body.motivo_descarte], ['nuevo', null])
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM feed_item_usuarios WHERE item_id = $1 AND status IS NOT NULL`, [idea])).rows[0].n, 0)
    assert.equal((await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'revisado', motivo: 'no aplica' } })).status, 400)
    assert.equal((await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'descartado', motivo: 'x'.repeat(201) } })).status, 400)
    assert.equal((await api(`/feed/${idea}/estado`, { method: 'PATCH', body: { estado: 'convertido' } })).status, 400)
    assert.equal((await api(`/feed/${idea}/estado`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await api(`/feed/${NOPE}/estado`, { method: 'PATCH', body: { estado: 'revisado' } })).status, 404)
  })

  it('convertir en posible cliente: pre-llena nombre, origen, teléfono y notas con lo del ítem; queda en la bitácora; el ítem queda enlazado', async () => {
    const it = await pub({
      titulo: 'Charcutería El Buen Corte',
      resumen: 'Vende por WhatsApp sin sistema de pedidos.',
      tipo: 'prospecto',
      fuente: 'cazador-summit',
      clave_externa: 'cz-9',
      datos: { negocio: { nombre: 'Charcutería El Buen Corte C.A.' }, fugas: ['Pedidos a mano'], guion: 'Buenas, le escribo por…', urls: ['https://maps.example/buencorte'], telefono: '+584141234567', origen: 'instagram', metricas: { resenas: 41 } },
    })
    const r = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.item.estado, r.body.item.convertido.a, r.body.creado.tipo], ['convertido', 'posible_cliente', 'posible_cliente'])
    assert.equal(r.body.item.convertido.id, r.body.creado.id)
    assert.equal(r.body.item.convertido.por, 'Leandro')
    const visto = (await api(`/feed/${it.body.id}`, { key: KEY_J })).body
    assert.deepEqual([visto.estado, visto.convertido.por], ['convertido', 'Leandro'], 'convertir es GLOBAL: todos lo ven convertido')
    assert.ok((await api('/feed?estado=convertido&per_page=100', { key: KEY_J })).body.data.some((x: any) => x.id === it.body.id))
    const c = await api(`/clientes/${r.body.creado.id}`)
    assert.equal(c.body.nombre, 'Charcutería El Buen Corte C.A.')
    assert.equal(c.body.estado, 'posible')
    assert.equal(c.body.etapa, 'prospecto')
    assert.equal(c.body.origen, 'instagram')
    assert.equal(c.body.telefono, '+584141234567')
    assert.match(c.body.notas, /cazador-summit/)
    assert.doesNotMatch(c.body.notas, /Pedidos a mano|Buenas, le escribo|maps\.example/, 'la nota no vuelca fugas, guion ni enlaces: eso sigue en el ítem')
    const bit = (await api(`/clientes/${r.body.creado.id}/interacciones`)).body.data as any[]
    assert.ok(bit.some((x) => x.tipo === 'nota' && /feed de oportunidades \(cazador-summit\)/i.test(x.resumen)))
    // cada clase se crea una sola vez (repetirla da 409), pero el ítem ya convertido admite otras clases; su estado personal ya no cambia
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })).status, 409)
    assert.equal((await api(`/feed/${it.body.id}/estado`, { method: 'PATCH', body: { estado: 'nuevo' } })).status, 409)
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients WHERE name = 'Charcutería El Buen Corte C.A.'`)).rows[0].n, 1)
  })

  it('convertir: lo que pasas pisa lo pre-llenado; un dato sucio del ítem (teléfono, origen) no rompe la conversión', async () => {
    const it = await pub({ titulo: 'Repostería Dulce Hogar', tipo: 'prospecto', fuente: 'cazador-summit', datos: { telefono: 'no es un teléfono', origen: 'tiktok-ads' } })
    const r = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente', nombre: 'Dulce Hogar', origen: 'referido', notas: 'Me la pasó Elis', valor_estimado: 120 } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const c = (await api(`/clientes/${r.body.creado.id}`)).body
    assert.deepEqual([c.nombre, c.origen, c.notas, c.valor_estimado, c.telefono], ['Dulce Hogar', 'referido', 'Me la pasó Elis', 120, null])
    const sucio = await pub({ titulo: 'Floristería Pétalo', tipo: 'prospecto', fuente: 'cazador-summit', datos: { telefono: 'xx', origen: 'tiktok-ads' } })
    const s = await api(`/feed/${sucio.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(s.status, 200, JSON.stringify(s.body))
    const cs = (await api(`/clientes/${s.body.creado.id}`)).body
    assert.deepEqual([cs.origen, cs.telefono], ['otro', null])
  })

  it('convertir en tarea (con proyecto o, sin él, al proyecto interno de HAYAI) y en proyecto', async () => {
    const proy = (await api('/proyectos', { body: { nombre: 'Proyecto para tareas del feed' } })).body.id
    const a = await pub({ titulo: 'Probar el radar de precios', tipo: 'idea', fuente: 'radar-hayai' })
    const t1 = await api(`/feed/${a.body.id}/convertir`, { body: { a: 'tarea', proyecto_id: proy, vence: '2026-11-01' } })
    assert.equal(t1.status, 200, JSON.stringify(t1.body))
    const tarea = (await api(`/tareas/${t1.body.creado.id}`)).body
    assert.deepEqual([tarea.titulo, tarea.proyecto_id, tarea.vence], ['Probar el radar de precios', proy, '2026-11-01'])
    assert.equal(tarea.responsable?.nombre ?? tarea.responsable, 'Leandro', 'sin responsable, la tarea queda con quien la crea')
    const a2 = await pub({ titulo: 'Tarea para Elis', tipo: 'idea', fuente: 'radar-hayai' })
    const t1b = await api(`/feed/${a2.body.id}/convertir`, { body: { a: 'tarea', proyecto_id: proy, responsable: 'Elis' } })
    { const rb = (await api(`/tareas/${t1b.body.creado.id}`)).body.responsable; assert.equal(rb?.nombre ?? rb, 'Elis') }
    const b = await pub({ titulo: 'Escribir guion para la charcutería', tipo: 'oportunidad', fuente: 'manual' })
    const t2 = await api(`/feed/${b.body.id}/convertir`, { body: { a: 'tarea', titulo: 'Guion charcutería (v1)' } })
    assert.equal(t2.status, 200, JSON.stringify(t2.body))
    const q = await admin.query(`SELECT t.title, p.client_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [t2.body.creado.id])
    assert.deepEqual([q.rows[0].title, q.rows[0].client_id], ['Guion charcutería (v1)', null], 'sin proyecto: cae en un proyecto interno (sin cliente)')
    const c = await pub({ titulo: 'Mostrador POS para ferreterías', resumen: 'Nicho sin atender', tipo: 'proyecto', fuente: 'muse-elis', datos: { urls: ['https://ejemplo.com/a'] } })
    const p = await api(`/feed/${c.body.id}/convertir`, { body: { a: 'proyecto', responsable: 'Elis' } })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    const pv = (await api(`/proyectos/${p.body.creado.id}`)).body
    assert.equal(pv.nombre, 'Mostrador POS para ferreterías')
    assert.match(pv.descripcion, /Nicho sin atender/)
    assert.equal(pv.responsable, 'Elis')
    assert.equal((await api(`/feed/${c.body.id}`)).body.convertido.a, 'proyecto')
  })

  it('convertir que falla (proyecto que no existe, datos inválidos) deja el ítem como estaba y se puede reintentar', async () => {
    const it = await pub({ titulo: 'Intento fallido', tipo: 'idea', fuente: 'manual' })
    const mal = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'tarea', proyecto_id: NOPE } })
    assert.equal(mal.status, 404, JSON.stringify(mal.body))
    const igual = (await api(`/feed/${it.body.id}`)).body
    assert.deepEqual([igual.estado, igual.convertido], ['nuevo', null])
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente', origen: 'paloma' } })).status, 400)
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'cohete' } })).status, 400)
    assert.equal((await api(`/feed/${NOPE}/convertir`, { body: { a: 'tarea' } })).status, 404)
    // revisado antes de fallar: mi estado personal no se toca
    await api(`/feed/${it.body.id}/estado`, { method: 'PATCH', body: { estado: 'revisado' } })
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'tarea', proyecto_id: NOPE } })).status, 404)
    const rev = (await api(`/feed/${it.body.id}`)).body
    assert.deepEqual([rev.estado, rev.mi_estado], ['nuevo', 'revisado'])
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'tarea' } })).status, 200)
  })

  it('dos socios convirtiendo el mismo ítem a la vez: se crea UNA sola cosa y el otro recibe 409', async () => {
    const it = await pub({ titulo: 'Carrera de conversión SA', tipo: 'prospecto', fuente: 'manual' })
    const rs = await Promise.all([api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } }), api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' }, key: KEY_J })])
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409])
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM clients WHERE name = 'Carrera de conversión SA'`)).rows[0].n, 1)
  })

  it('v1.6.6 vínculo: sin_vinculo → posible_cliente → cliente según lo convertido o lo que traiga el ítem; creados dice qué ya existe', async () => {
    const it = await pub({ titulo: 'Vínculo Uno C.A.', tipo: 'prospecto', fuente: 'manual', datos: { telefono: '+584141110000' } })
    assert.deepEqual([it.body.vinculo.estado, it.body.vinculo.cliente_id, it.body.creados], ['sin_vinculo', null, {}])
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'cliente' } })).status, 409, 'sin posible cliente no hay a quién promover')
    const pc = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(pc.status, 200, JSON.stringify(pc.body))
    assert.deepEqual([pc.body.item.vinculo.estado, pc.body.item.vinculo.cliente_id, pc.body.item.vinculo.origen], ['posible_cliente', pc.body.creado.id, 'conversion'])
    assert.equal(pc.body.item.creados.posible_cliente.id, pc.body.creado.id)
    assert.equal(pc.body.item.creados.posible_cliente.por, 'Leandro')
    // otro socio lo ve igual (es global)
    assert.equal((await api(`/feed/${it.body.id}`, { key: KEY_J })).body.vinculo.estado, 'posible_cliente')
    // promover: el lead pasa a cliente activo
    const cl = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'cliente' } })
    assert.equal(cl.status, 200, JSON.stringify(cl.body))
    assert.deepEqual([cl.body.item.vinculo.estado, cl.body.item.vinculo.cliente_id], ['cliente', pc.body.creado.id])
    assert.equal((await api(`/clientes/${pc.body.creado.id}`)).body.estado, 'activo')
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'cliente' } })).status, 409, 'ya es cliente: no hay conversión')
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })).status, 409)
    // un ítem que trae el cliente en sus datos (id o nombre único) nace vinculado, sin convertir nada
    const viva = await api('/clientes', { body: { nombre: 'Growi Cliente Vinculado' } })
    const porId = await pub({ titulo: 'Upsell por id', tipo: 'oportunidad', fuente: 'growi', datos: { cliente_id: viva.body.id } })
    assert.deepEqual([porId.body.vinculo.estado, porId.body.vinculo.cliente_id, porId.body.vinculo.origen, porId.body.estado], ['cliente', viva.body.id, 'datos', 'nuevo'])
    const porNombre = await pub({ titulo: 'Upsell por nombre', tipo: 'oportunidad', fuente: 'growi', datos: { cliente: 'growi cliente vinculado' } })
    assert.deepEqual([porNombre.body.vinculo.estado, porNombre.body.vinculo.cliente_id, porNombre.body.vinculo.origen], ['cliente', viva.body.id, 'nombre'])
    assert.equal((await pub({ titulo: 'Ni idea', tipo: 'oportunidad', fuente: 'growi', datos: { cliente: 'No Existe Este Negocio' } })).body.vinculo.estado, 'sin_vinculo')
    // el listado y el detalle traen lo mismo
    const lst = (await api('/feed?per_page=100')).body.data.find((x: any) => x.id === porId.body.id)
    assert.equal(lst.vinculo.cliente_id, viva.body.id)
  })

  it('v1.6.6 seguimiento: tarea «Seguimiento: …» con vencimiento hoy + 3 días (hora de Caracas); hereda el proyecto del cliente vinculado', async () => {
    const hoyCcs = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const mas3 = new Date(Date.parse(`${hoyCcs}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)
    const cli = (await api('/clientes', { body: { nombre: 'Cliente Con Proyecto Feed' } })).body
    const proy = (await api('/proyectos', { body: { nombre: 'Proyecto del cliente feed', cliente_id: cli.id } })).body
    const it = await pub({ titulo: 'Ampliar el sistema de pedidos', tipo: 'oportunidad', fuente: 'growi', datos: { cliente_id: cli.id } })
    const sg = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'seguimiento' } })
    assert.equal(sg.status, 200, JSON.stringify(sg.body))
    const t = (await api(`/tareas/${sg.body.creado.id}`)).body
    assert.deepEqual([t.titulo, t.vence, t.proyecto_id], ['Seguimiento: Ampliar el sistema de pedidos', mas3, proy.id])
    assert.equal(sg.body.item.creados.seguimiento.id, sg.body.creado.id)
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'seguimiento' } })).status, 409, 'sin duplicados')
    // la tarea normal es otra clase: también se puede, y hereda el mismo proyecto
    const tr = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'tarea' } })
    assert.equal(tr.status, 200, JSON.stringify(tr.body))
    assert.equal((await api(`/tareas/${tr.body.creado.id}`)).body.proyecto_id, proy.id)
    assert.deepEqual(Object.keys((await api(`/feed/${it.body.id}`)).body.creados).sort(), ['seguimiento', 'tarea'])
    // un proyecto creado desde un ítem vinculado hereda el cliente
    const pr = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'proyecto' } })
    assert.equal(pr.status, 200, JSON.stringify(pr.body))
    assert.equal((await api(`/proyectos/${pr.body.creado.id}`)).body.cliente_id, cli.id)
    // sin cliente vinculado: va al proyecto interno y el seguimiento también vence en 3 días
    const suelto = await pub({ titulo: 'Suelto', tipo: 'prospecto', fuente: 'manual' })
    const s2 = await api(`/feed/${suelto.body.id}/convertir`, { body: { a: 'seguimiento' } })
    assert.equal((await api(`/tareas/${s2.body.creado.id}`)).body.vence, mas3)
  })

  it('v1.6.6 deshacer: solo quien convirtió, dentro de la ventana; lo creado va a la papelera y el ítem vuelve a «nuevo»', async () => {
    const it = await pub({ titulo: 'Para deshacer', tipo: 'prospecto', fuente: 'manual' })
    const pc = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(pc.status, 200)
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'posible_cliente' }, key: KEY_J })).status, 403, 'solo quien lo creó')
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'tarea' } })).status, 404, 'nada que deshacer en esa clase')
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'cohete' } })).status, 400)
    const ok = await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'posible_cliente' } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.item.estado, ok.body.item.convertido, ok.body.item.vinculo.estado, ok.body.item.creados], ['nuevo', null, 'sin_vinculo', {}])
    assert.equal((await api(`/clientes/${pc.body.creado.id}`)).status, 404, 'el posible cliente fue a la papelera')
    assert.ok((await apiD('/papelera')).body.data.some((x: any) => x.nombre === 'Para deshacer'), 'y se puede restaurar')
    // se puede volver a convertir
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })).status, 200)
    // pasada la ventana ya no
    await admin.query(`UPDATE feed_item_vinculos SET created_at = now() - interval '3 minutes' WHERE item_id = $1`, [it.body.id])
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'posible_cliente' } })).status, 409)
    // promover y deshacer la promoción: el cliente vuelve a posible, el ítem sigue vinculado a él
    const it2 = await pub({ titulo: 'Para promover y deshacer', tipo: 'prospecto', fuente: 'manual' })
    const p2 = await api(`/feed/${it2.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal((await api(`/feed/${it2.body.id}/convertir`, { body: { a: 'cliente' } })).status, 200)
    assert.equal((await api(`/feed/${it2.body.id}/deshacer`, { body: { a: 'posible_cliente' } })).status, 409, 'primero se deshace la promoción')
    const und = await api(`/feed/${it2.body.id}/deshacer`, { body: { a: 'cliente' } })
    assert.equal(und.status, 200, JSON.stringify(und.body))
    assert.deepEqual([und.body.item.vinculo.estado, und.body.item.vinculo.cliente_id], ['posible_cliente', p2.body.creado.id])
    assert.equal((await api(`/clientes/${p2.body.creado.id}`)).body.estado, 'posible')
    // una tarea creada y deshecha: el ítem sigue «convertido» si queda otra cosa creada
    const it3 = await pub({ titulo: 'Dos cosas', tipo: 'idea', fuente: 'manual' })
    const tt = await api(`/feed/${it3.body.id}/convertir`, { body: { a: 'tarea' } })
    await api(`/feed/${it3.body.id}/convertir`, { body: { a: 'proyecto' } })
    const u3 = await api(`/feed/${it3.body.id}/deshacer`, { body: { a: 'tarea' } })
    assert.equal(u3.status, 200, JSON.stringify(u3.body))
    assert.deepEqual([u3.body.item.estado, u3.body.item.convertido.a, Object.keys(u3.body.item.creados)], ['convertido', 'proyecto', ['proyecto']])
    assert.equal((await api(`/tareas/${tt.body.creado.id}`)).status, 404)
  })

  it('v1.6.7 nota de conversión ordenada: «Del feed: fuente · fecha» + enlace al ítem, resumen corto y contacto en líneas', async () => {
    const it = await pub({
      titulo: 'Panadería La Espiga',
      resumen: 'Hornea a diario y toma pedidos por WhatsApp sin ningún sistema.\n\n   Quiere ordenar los pedidos de sus clientes frecuentes.',
      tipo: 'prospecto',
      fuente: 'video-auditorias',
      datos: { fugas: ['Pedidos a mano'], guion: 'Buenas, le escribo por…', contacto: { telefono: '+584141112233', whatsapp: '+584141112233', correo: 'espiga@example.com', instagram: '@laespiga' }, urls: ['https://maps.example/espiga'] },
    })
    const r = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const notas = (await api(`/clientes/${r.body.creado.id}`)).body.notas as string
    const [cab, resumen, contacto, ...mas] = notas.split('\n\n')
    assert.match(cab, new RegExp(`^Del feed: video-auditorias · \\d{1,2} [a-zñ]+ \\d{4}\\nÍtem original: #hub/feed/${it.body.id}$`))
    assert.equal(resumen, 'Resumen\nHornea a diario y toma pedidos por WhatsApp sin ningún sistema. Quiere ordenar los pedidos de sus clientes frecuentes.')
    assert.equal(contacto, 'Contacto\nTeléfono: +584141112233\nWhatsApp: +584141112233\nCorreo: espiga@example.com\nInstagram: @laespiga')
    assert.equal(mas.length, 0)
    assert.doesNotMatch(notas, /Pedidos a mano|Buenas, le escribo|maps\.example/)
    // sin resumen ni contacto: solo la cabecera
    const vacio = await pub({ titulo: 'Sin datos', tipo: 'prospecto', fuente: 'manual' })
    const v = await api(`/feed/${vacio.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal((await api(`/clientes/${v.body.creado.id}`)).body.notas, (await api(`/clientes/${v.body.creado.id}`)).body.notas.split('\n\n')[0])
    assert.match((await api(`/clientes/${v.body.creado.id}`)).body.notas, /^Del feed: manual · .+\nÍtem original: #hub\/feed\//)
    // el teléfono/correo sueltos del ítem (datos.telefono / datos.email) también cuentan como contacto
    const suelto = await pub({ titulo: 'Contacto suelto', resumen: 'Algo.', tipo: 'prospecto', fuente: 'manual', datos: { telefono: '+584125550000', email: 'a@b.co' } })
    const sc = await api(`/feed/${suelto.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.match((await api(`/clientes/${sc.body.creado.id}`)).body.notas, /Contacto\nTeléfono: \+584125550000\nCorreo: a@b\.co$/)
  })

  it('v1.6.7 devolver al feed: sin ventana de tiempo y para cualquier socio; solo un posible cliente que siga siéndolo; limpia lo que colgaba de él', async () => {
    const it = await pub({ titulo: 'Para devolver al feed', tipo: 'prospecto', fuente: 'manual' })
    const pc = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(pc.status, 200)
    // la ficha dice de qué hallazgo salió
    const ficha = (await api(`/clientes/${pc.body.creado.id}`)).body
    assert.deepEqual([ficha.del_feed.id, ficha.del_feed.titulo, ficha.del_feed.fuente], [it.body.id, 'Para devolver al feed', 'manual'])
    // un cliente que NO salió de una conversión no trae del_feed
    const otro = (await api('/clientes', { body: { nombre: 'Cliente sin feed', estado: 'posible' } })).body
    assert.equal((await api(`/clientes/${otro.id}`)).body.del_feed, null)
    // cuelga un proyecto del posible cliente, hecho desde el mismo ítem
    const pr = await api(`/feed/${it.body.id}/convertir`, { body: { a: 'proyecto' } })
    assert.equal(pr.status, 200, JSON.stringify(pr.body))
    // pasada la ventana de 2 minutos, el «Deshacer» normal ya no sirve…
    await admin.query(`UPDATE feed_item_vinculos SET created_at = now() - interval '1 hour' WHERE item_id = $1`, [it.body.id])
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'posible_cliente' } })).status, 409)
    // …pero «devolver» sí, y lo puede hacer otro socio
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'tarea', devolver: true }, key: KEY_J })).status, 404, 'devolver solo existe para posible_cliente (aquí no hay tarea)')
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'proyecto', devolver: true } })).status, 400)
    const ok = await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'posible_cliente', devolver: true }, key: KEY_J })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.item.estado, ok.body.item.convertido, ok.body.item.vinculo.estado, ok.body.item.creados], ['nuevo', null, 'sin_vinculo', {}], 'el proyecto se fue con el cliente a la papelera: el ítem queda limpio')
    assert.equal((await api(`/clientes/${pc.body.creado.id}`)).status, 404)
    assert.equal((await api(`/proyectos/${pr.body.creado.id}`)).status, 404)
    assert.ok((await apiD('/papelera')).body.data.some((x: any) => x.nombre === 'Para devolver al feed'), 'sigue en la papelera 30 días')
    // y se puede volver a convertir
    assert.equal((await api(`/feed/${it.body.id}/convertir`, { body: { a: 'posible_cliente' } })).status, 200)
    // ya promovido a cliente: no se devuelve
    const it2 = await pub({ titulo: 'Ya es cliente', tipo: 'prospecto', fuente: 'manual' })
    await api(`/feed/${it2.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    await api(`/feed/${it2.body.id}/convertir`, { body: { a: 'cliente' } })
    const no = await api(`/feed/${it2.body.id}/deshacer`, { body: { a: 'posible_cliente', devolver: true } })
    assert.equal(no.status, 409, JSON.stringify(no.body))
    assert.equal((await api(`/feed/${it2.body.id}/deshacer`, { body: { a: 'posible_cliente', devolver: 'si' } })).status, 400)
    // un ítem sin nada creado
    assert.equal((await api(`/feed/${(await pub({ titulo: 'Nada creado', tipo: 'idea', fuente: 'manual' })).body.id}/deshacer`, { body: { a: 'posible_cliente', devolver: true } })).status, 404)
  })

  it('v1.6.6 propuesta desde el ítem: queda enlazada («✓ Creada»), el ítem pasa a convertido y la propuesta es válida también para un cliente activo', async () => {
    const cli = (await api('/clientes', { body: { nombre: 'Cliente Para Propuesta Feed' } })).body
    const it = await pub({ titulo: 'Upsell Supermigas', tipo: 'oportunidad', fuente: 'growi', datos: { cliente_id: cli.id, concepto: 'Módulo de reservas' } })
    const pr = await api(`/clientes/${cli.id}/propuestas`, { body: { items: [{ tipo: 'mensualidad', concepto: 'Módulo de reservas', precio_unitario: 25 }], feed_item_id: it.body.id } })
    assert.equal(pr.status, 201, JSON.stringify(pr.body))
    const v = (await api(`/feed/${it.body.id}`)).body
    assert.deepEqual([v.estado, v.convertido.a, v.creados.propuesta.id], ['convertido', 'propuesta', pr.body.id])
    assert.equal((await api(`/clientes/${cli.id}`)).body.valor_estimado ?? null, null, 'el valor estimado del pipeline no se toca en un cliente activo')
    assert.equal((await api(`/clientes/${cli.id}/propuestas`, { body: { items: [{ tipo: 'mensualidad', concepto: 'x', precio_unitario: 1 }], feed_item_id: NOPE } })).status, 404, 'ítem inexistente')
    // la propuesta no se deshace desde el feed (tiene su propia ficha)
    assert.equal((await api(`/feed/${it.body.id}/deshacer`, { body: { a: 'propuesta' } })).status, 400)
    // por la web (sesión): mismo servicio, cuerpo en español
    const w = await fetch(`${ROOT}/api/clients/${cli.id}/proposals`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': 'x' }, body: JSON.stringify({ items: [{ tipo: 'mensualidad', concepto: 'Otra', precio_unitario: 5 }] }) })
    assert.notEqual(w.status, 500)
  })

  it('avisos en vivo: solo alerta, noticia y prospecto; UNO por (fuente, tipo) y lote; una siembra de 20 no inunda; no es bitácora', async () => {
    await api('/actividad', { key: KEY_J }) // fija el "visto hasta" de Jorbi
    let base = await ultimo()
    await pub({ titulo: 'Una idea cualquiera', tipo: 'idea', fuente: 'aviso-test' })
    await pub({ titulo: 'Una oportunidad', tipo: 'oportunidad', fuente: 'aviso-test' })
    assert.equal((await eventos(base)).length, 0, 'idea, oportunidad y proyecto no avisan')
    await pub({ titulo: 'El competidor bajó precios', tipo: 'alerta', fuente: 'espia-pos' })
    const e1 = await eventos(base)
    assert.equal(e1.length, 1)
    assert.match(e1[0].texto, /Feed de oportunidades: alerta nueva: El competidor bajó precios/)
    assert.equal(e1[0].propia, false)
    assert.equal(e1[0].cliente_id, null)
    // siembra de 20 prospectos de una fuente: un solo aviso con la cuenta
    base = await ultimo()
    const siembra = await pub({ items: Array.from({ length: 20 }, (_, i) => ({ titulo: `Negocio ${i + 1}`, tipo: 'prospecto', fuente: 'siembra-test', clave_externa: `n${i}` })) })
    assert.equal(siembra.body.creados, 20)
    const e2 = await eventos(base)
    assert.equal(e2.length, 1)
    assert.match(e2[0].texto, /20 prospectos nuevos de siembra-test/)
    // la misma fuente y tipo otra vez en seguida: no repite el aviso; otro tipo de la misma fuente sí
    base = await ultimo()
    await pub({ titulo: 'Negocio 21', tipo: 'prospecto', fuente: 'siembra-test' })
    assert.equal((await eventos(base)).length, 0)
    await pub({ titulo: 'Noticia del sector', tipo: 'noticia', fuente: 'siembra-test' })
    assert.equal((await eventos(base)).length, 1)
    // un duplicado no avisa
    base = await ultimo()
    await pub({ titulo: 'Negocio 1 otra vez', tipo: 'prospecto', fuente: 'siembra-test', clave_externa: 'n0' })
    assert.equal((await eventos(base)).length, 0)
    // la bitácora interna del hub NO lleva el feed, y el hub trae el contador
    const h = await api('/hub')
    assert.ok(!(h.body.bitacora as any[]).some((e) => e.tipo === 'feed_nuevo'), 'el feed no es bitácora')
    assert.equal(h.body.feed.nuevos, (await api('/feed')).body.meta.nuevos)
    assert.equal(h.body.feed.total, (await api('/feed')).body.meta.total)
    assert.ok((await admin.query(`SELECT 1 FROM activity WHERE kind = 'feed_nuevo' AND client_id IS NULL LIMIT 1`)).rowCount)
  })

  it('campana: alerta/noticia/prospecto nuevos sin revisar; varios de un mismo origen y día van juntos; revisar o descartar la quita; la lectura es por socio', async () => {
    const lista = async (key = KEY_J) => (await api('/notificaciones?tipo=feed&per_page=100', { key })).body
    const a = await lista()
    assert.ok(a.data.length >= 1)
    assert.ok(a.data.every((x: any) => x.tipo === 'feed' && x.feed && x.cliente_id === null))
    const idea1 = a.data.find((x: any) => x.feed.tipo === 'idea')
    assert.equal(idea1, undefined, 'las ideas no alertan')
    // la siembra de 20 es UNA alerta con la cuenta
    const sem = a.data.find((x: any) => x.feed.fuente === 'siembra-test' && x.feed.tipo === 'prospecto')
    assert.ok(sem, JSON.stringify(a.data.map((x: any) => x.clave)))
    assert.equal(sem.feed.cantidad, 21)
    assert.match(sem.titulo, /21 prospectos nuevos en el feed/)
    assert.equal(sem.feed.item_id, null)
    assert.match(sem.clave, /^feed:prospecto:siembra-test:\d{4}-\d{2}-\d{2}:21$/)
    // uno solo: su propia alerta, con el id del ítem
    const sola = a.data.find((x: any) => x.feed.fuente === 'espia-pos')
    assert.equal(sola.feed.cantidad, 1)
    assert.match(sola.clave, /^feed:[0-9a-f-]{36}$/)
    assert.equal(sola.feed.item_id, sola.clave.slice(5))
    assert.match(sola.titulo, /El competidor bajó precios/)
    // leer es por socio
    const antes = (await api('/notificaciones', { key: KEY_J })).body.meta.sin_leer
    const l = await api('/notificaciones/leer', { body: { claves: [sola.clave] }, key: KEY_J })
    assert.equal(l.body.marcadas, 1)
    assert.equal(l.body.sin_leer, antes - 1)
    assert.equal((await lista(KEY)).data.find((x: any) => x.clave === sola.clave).leida, false, 'Leandro no la ha leído')
    // si llega uno más al grupo, cambia la clave y vuelve a salir sin leer
    await pub({ titulo: 'Negocio 22', tipo: 'prospecto', fuente: 'siembra-test' })
    await api('/notificaciones/leer', { body: { claves: [sem.clave] }, key: KEY_J })
    const b = await lista()
    const sem2 = b.data.find((x: any) => x.feed.fuente === 'siembra-test' && x.feed.tipo === 'prospecto')
    assert.equal(sem2.feed.cantidad, 22)
    assert.equal(sem2.leida, false)
    // claves inventadas no se aceptan
    assert.equal((await api('/notificaciones/leer', { body: { claves: ['feed:no-es-una-clave'] }, key: KEY_J })).status, 400)
    // revisar o descartar quita la alerta, pero solo a quien lo hizo (Leandro); Jorbi la sigue viendo
    const itemSolo = sola.feed.item_id as string
    await api(`/feed/${itemSolo}/estado`, { method: 'PATCH', body: { estado: 'revisado' } })
    assert.ok(!(await lista(KEY)).data.some((x: any) => x.clave === sola.clave))
    assert.ok((await lista()).data.some((x: any) => x.clave === sola.clave), 'a Jorbi le sigue apareciendo')
    await api(`/feed/${itemSolo}/estado`, { method: 'PATCH', body: { estado: 'descartado' }, key: KEY_J })
    assert.ok(!(await lista()).data.some((x: any) => x.clave === sola.clave))
    // la alerta ya no vigente no se marca
    assert.equal((await api('/notificaciones/leer', { body: { claves: [sola.clave] }, key: KEY_J })).body.marcadas, 0)
    // fuera de los 14 días ya no estorba
    await admin.query(`UPDATE feed_items SET created_at = now() - interval '20 days' WHERE source = 'siembra-test'`)
    assert.ok(!(await lista()).data.some((x: any) => x.feed.fuente === 'siembra-test'))
  })

  it('permisos: la llave de solo lectura lee el feed pero no publica, marca ni convierte; Space sin sesión no entra', async () => {
    assert.equal((await api('/feed', { key: KEY_R })).status, 200)
    assert.equal((await api(`/feed/${prospecto}`, { key: KEY_R })).status, 200)
    assert.equal((await pub({ titulo: 'X', tipo: 'idea', fuente: 'manual' }, KEY_R)).status, 403)
    assert.equal((await api(`/feed/${prospecto}/estado`, { method: 'PATCH', body: { estado: 'revisado' }, key: KEY_R })).status, 403)
    assert.equal((await api(`/feed/${prospecto}/guardar`, { body: {}, key: KEY_R })).status, 403)
    assert.equal((await api(`/feed/${prospecto}/convertir`, { body: { a: 'tarea' }, key: KEY_R })).status, 403)
    assert.equal((await api('/feed', { key: null })).status, 401)
    assert.equal((await http(`${ROOT}/api/feed`)).status, 401)
  })

  it('MCP: las seis herramientas (la de lectura se ve con solo lectura), publicar idempotente, marcar y guardar personales y convertir', async () => {
    const nombres = async (key: string) => ((await rpc('tools/list', {}, key)).body.result.tools as any[]).map((t) => t.name).filter((x: string) => x.startsWith('hayai_feed'))
    assert.deepEqual((await nombres(KEY)).sort(), ['hayai_feed_convertir', 'hayai_feed_deshacer', 'hayai_feed_guardar', 'hayai_feed_listar', 'hayai_feed_marcar', 'hayai_feed_publicar'])
    assert.deepEqual(await nombres(KEY_R), ['hayai_feed_listar'])
    const tools = (await rpc('tools/list')).full.result.tools as any[] // full: body quita `actualizado_el`
    assert.equal(tools.find((t) => t.name === 'hayai_feed_listar').annotations.readOnlyHint, true)
    assert.ok(!tools.find((t) => t.name === 'hayai_feed_marcar').inputSchema.properties.actualizado_el, 'marcar es personal: no hay conflicto que cuidar')
    const p = dato(await mcp('hayai_feed_publicar', { titulo: 'Idea desde el Muse', tipo: 'idea', fuente: 'muse-leandro', clave_externa: 'm-1', datos: { nota: 'hola' } }))
    assert.deepEqual([p.creado, p.publicado_por.nombre, p.fuente], [true, 'Leandro', 'muse-leandro'])
    const again = dato(await mcp('hayai_feed_publicar', { titulo: 'Idea desde el Muse', tipo: 'idea', fuente: 'muse-leandro', clave_externa: 'm-1' }))
    assert.deepEqual([again.creado, again.id], [false, p.id])
    const l = dato(await mcp('hayai_feed_listar', { fuente: 'muse-leandro' }))
    assert.equal(l.meta.total, 1)
    const malo = await mcp('hayai_feed_publicar', { titulo: 'x', tipo: 'chisme', fuente: 'manual' })
    assert.ok(malo.result.isError)
    const m = dato(await mcp('hayai_feed_marcar', { id: p.id, estado: 'revisado' }))
    assert.deepEqual([m.estado, m.mi_estado], ['nuevo', 'revisado'])
    const mj = dato(await mcp('hayai_feed_marcar', { id: p.id, estado: 'descartado', motivo: 'no aplica' }, KEY_J))
    assert.equal(mj.mi_estado, 'descartado')
    assert.equal(dato(await mcp('hayai_feed_listar', { fuente: 'muse-leandro' })).data[0].mi_estado, 'revisado', 'lo de Jorbi no cambió lo de Leandro')
    assert.equal(dato(await mcp('hayai_feed_guardar', { id: p.id })).guardado, true)
    assert.equal(dato(await mcp('hayai_feed_listar', { guardado: true })).meta.total, 1)
    assert.equal(dato(await mcp('hayai_feed_guardar', { id: p.id, guardado: false })).guardado, false)
    const cv = dato(await mcp('hayai_feed_convertir', { id: p.id, a: 'tarea', titulo: 'Desde MCP' }))
    assert.equal(cv.creado.tipo, 'tarea')
    assert.equal(dato(await mcp('hayai_feed_listar', { estado: 'convertido', fuente: 'muse-leandro' })).data[0].convertido.a, 'tarea')
    const dos = await mcp('hayai_feed_convertir', { id: p.id, a: 'tarea' })
    assert.ok(dos.result.isError)
    assert.match(dos.result.content[0].text, /Ya se creó la tarea/)
    const nf = dato(await mcp('hayai_notificaciones_listar', { tipo: 'feed' }))
    assert.ok(Array.isArray(nf.data))
  })

  it('web (sesión): listar, publicar como "manual", marcar y convertir; sin sesión 401', async () => {
    const web = (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => http(`${ROOT}/api${path}`, { ...o, headers: { cookie, ...o.headers } })
    const l = await web('/feed')
    assert.equal(l.status, 200)
    assert.ok(l.body.meta.nuevos >= 1)
    const p = await web('/feed', { body: { titulo: 'Propuesta de Jorbi desde la pantalla', tipo: 'idea', fuente: 'manual', datos: { nota: 'probar' } } })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.equal(p.body.publicado_por.nombre, 'Jorbi')
    const m = await web(`/feed/${p.body.id}/estado`, { method: 'PATCH', body: { estado: 'descartado', motivo: 'Fuera de foco' } })
    assert.deepEqual([m.status, m.body.mi_estado, m.body.estado], [200, 'descartado', 'nuevo'])
    const gu = await web(`/feed/${p.body.id}/guardar`, { body: { guardado: true } })
    assert.deepEqual([gu.status, gu.body.guardado], [200, true])
    assert.equal((await web('/feed?guardado=true')).body.data[0].id, p.body.id)
    const q = await web('/feed', { body: { titulo: 'Para convertir desde la web', tipo: 'prospecto', fuente: 'manual' } })
    const c = await web(`/feed/${q.body.id}/convertir`, { body: { a: 'posible_cliente' } })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.equal(c.body.item.estado, 'convertido')
    assert.equal((await http(`${ROOT}/api/feed`)).status, 401)
  })

  it('base de datos: las reglas viven también en la tabla (convertido exige a qué, motivo solo al descartar, fuente válida)', async () => {
    const insert = (cols: string, vals: string) => admin.query(`INSERT INTO feed_items (title, kind, source, published_by, ${cols}) SELECT 'x', 'idea', 'manual', id, ${vals} FROM users LIMIT 1`)
    await assert.rejects(insert('status', `'convertido'`), /feed_converted_ck/)
    await assert.rejects(insert('discard_reason', `'porque sí'`), /feed_discard_ck/)
    const it = (await admin.query(`SELECT f.id, f.published_by AS u FROM feed_items f LIMIT 1`)).rows[0]
    await assert.rejects(admin.query(`INSERT INTO feed_item_usuarios (item_id, user_id, status, discard_reason) VALUES ($1, $2, 'revisado', 'motivo')`, [it.id, it.u]), /feed_user_reason_ck/)
    await assert.rejects(admin.query(`INSERT INTO feed_item_usuarios (item_id, user_id, status) VALUES ($1, $2, 'convertido')`, [it.id, it.u]), /check/i)
    await assert.rejects(admin.query(`UPDATE feed_items SET category = 'Mayúscula' WHERE id = $1`, [it.id]), /check/i)
    await assert.rejects(admin.query(`INSERT INTO feed_items (title, kind, source, published_by) SELECT 'x', 'idea', 'Mala Fuente', id FROM users LIMIT 1`), /check/i)
    await assert.rejects(admin.query(`INSERT INTO feed_items (title, kind, source, published_by) SELECT 'x', 'chisme', 'manual', id FROM users LIMIT 1`), /check/i)
  })
})

describe('Chat interno', () => {
  let n = 0
  const rpc = (method: string, params: unknown = {}, key: string | null = KEY) =>
    http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: ++n, method, params } })
  const mcp = async (name: string, args: unknown = {}, key: string | null = KEY) => (await rpc('tools/call', { name, arguments: args }, key)).body
  const dato = (b: any) => JSON.parse(b.result.content[0].text)
  const espera = (ms = 15) => new Promise((r) => setTimeout(r, ms))
  const pub = (cuerpo: string, extra: Record<string, unknown> = {}, key = KEY) => api('/chat', { key, body: { cuerpo, fuente: 'growi', ...extra } })
  const cookies: Record<string, string> = {}
  const web = (who: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => http(`${ROOT}/api${path}`, { ...o, headers: { cookie: cookies[who], ...o.headers } })
  const uid: Record<string, string> = {}
  let KEY_JD = '' // Jorbi con borrado
  let KEY_R = '' // Jorbi, solo lectura
  const ids: string[] = []

  before(async () => {
    for (const [name, pin] of [['Jorbi', '482913'], ['Elis', '713904']]) {
      const r = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, pin }) })
      assert.equal(r.status, 200, `login ${name}`)
      cookies[name] = r.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
    }
    KEY_JD = newKey('Jorbi', 'chat-borra', 'read,write,delete')
    KEY_R = newKey('Jorbi', 'chat-lee', 'read')
    for (const u of (await api('/chat/usuarios')).body.data) uid[u.nombre] = u.id
    // Primer acceso de cada uno: el "leído hasta" nace ahora, así que todo lo que se publique después cuenta como no leído.
    for (const k of [KEY, KEY_J]) assert.equal((await api('/chat/contadores', { key: k })).body.sin_leer, 0)
    assert.equal((await web('Elis', '/chat/contadores')).body.sin_leer, 0)
    await espera(5)
  })

  it('usuarios mencionables: los astronautas activos con su id', async () => {
    const r = await api('/chat/usuarios')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.data.map((u: any) => u.nombre).sort(), ['Elis', 'Jorbi', 'Leandro'])
    assert.ok(r.body.data.every((u: any) => u.id && u.avatar))
  })

  it('publicar: el autor sale de la llave, no del cuerpo; fuente obligatoria; idempotente por (fuente, clave_externa)', async () => {
    const r = await pub('Hola equipo, el cron de Growi ya corrió.', { clave_externa: 'run-1' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.autor.nombre, r.body.autor.id, r.body.fuente, r.body.clave_externa, r.body.creado, r.body.editado_el, r.body.menciones], ['Leandro', uid.Leandro, 'growi', 'run-1', true, null, []])
    assert.match(r.body.creado_el, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, 'con microsegundos')
    assert.ok(r.full.actualizado_el)
    const id = r.body.id
    ids.push(id)
    const otra = await pub('Otro texto', { clave_externa: 'run-1' })
    assert.equal(otra.status, 200, 'misma (fuente, clave): no se duplica')
    assert.deepEqual([otra.body.id, otra.body.creado, otra.body.cuerpo], [id, false, 'Hola equipo, el cron de Growi ya corrió.'])
    assert.equal((await pub('Misma clave, otra fuente', { clave_externa: 'run-1', fuente: 'muse-leandro' })).status, 201)
    assert.equal((await pub('Sin clave')).status, 201)
    assert.equal((await pub('Sin clave')).status, 201, 'sin clave_externa no hay idempotencia')
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM chat_messages WHERE source = 'growi' AND external_key = 'run-1'`)).rows[0].n, 1)
    // Otra llave de otro socio: se atribuye a ese socio
    const j = await pub('Soy Jorbi', {}, KEY_J)
    assert.equal(j.body.autor.nombre, 'Jorbi')
    ids.push(j.body.id)
    assert.equal((await api(`/chat/${id}`)).body.id, id)
    assert.equal((await api(`/chat/${NOPE}`)).status, 404)
  })

  it('validación: cuerpo, fuente, clave, menciones, autor en el cuerpo y campos desconocidos', async () => {
    const malos: [string, unknown][] = [
      ['cuerpo vacío', { cuerpo: '   ', fuente: 'growi' }],
      ['sin cuerpo', { fuente: 'growi' }],
      ['cuerpo largo', { cuerpo: 'x'.repeat(4001), fuente: 'growi' }],
      ['sin fuente', { cuerpo: 'hola' }],
      ['fuente con espacio', { cuerpo: 'hola', fuente: 'mi app' }],
      ['clave larga', { cuerpo: 'hola', fuente: 'growi', clave_externa: 'k'.repeat(201) }],
      ['menciones no uuid', { cuerpo: 'hola', fuente: 'growi', menciones: ['Elis'] }],
      ['menciones con uuid inexistente', { cuerpo: 'hola', fuente: 'growi', menciones: [NOPE] }],
      ['autor en el cuerpo', { cuerpo: 'hola', fuente: 'growi', autor: uid.Elis }],
      ['author_id en el cuerpo', { cuerpo: 'hola', fuente: 'growi', author_id: uid.Elis }],
    ]
    for (const [que, body] of malos) assert.equal((await api('/chat', { body })).status, 400, `${que}`)
    assert.equal((await pub('x'.repeat(4000))).status, 201, '4000 caracteres justos caben')
    assert.equal((await api('/chat', { raw: JSON.stringify({ cuerpo: 'hola', fuente: 'growi' }), headers: { 'content-type': 'text/plain' } })).status, 415)
  })

  it('menciones: @Nombre sin importar mayúsculas, ids explícitos, sin repetidos ni el propio autor; los @ que no existen se ignoran', async () => {
    const r = await pub('Hola @jorbi y @ELIS, @Jorbi otra vez, @nadie, escríbeme a leandro@jorbi.com, o @Leandro (yo mismo)')
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(r.body.menciones.map((m: any) => m.nombre), ['Elis', 'Jorbi'], 'sin repetir, sin el autor, sin @nadie ni el correo')
    assert.deepEqual(r.body.menciones.map((m: any) => m.id), [uid.Elis, uid.Jorbi])
    assert.equal(r.body.cuerpo.includes('@nadie'), true, 'el texto no se toca')
    ids.push(r.body.id)
    // por uuid (además de las @), con repetidos y con el propio autor
    const u = await pub('Sin arrobas', { menciones: [uid.Elis, uid.Elis, uid.Leandro] })
    assert.deepEqual(u.body.menciones.map((m: any) => m.nombre), ['Elis'])
    const mezcla = await pub('Mira esto @Jorbi', { menciones: [uid.Elis] })
    assert.deepEqual(mezcla.body.menciones.map((m: any) => m.nombre), ['Elis', 'Jorbi'])
    ids.push(mezcla.body.id)
    assert.equal((await pub('@Elisabeth no es @Elis.')).body.menciones.map((m: any) => m.nombre).join(), 'Elis', 'el límite de la palabra: @Elisabeth no es Elis, pero «@Elis.» sí')
    assert.equal((await pub('Elis sin arroba')).body.menciones.length, 0)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM chat_mentions WHERE message_id = $1', [r.body.id])).rows[0].n, 2)
  })

  it('contadores: sin leer son los de OTROS posteriores al «leído hasta»; las menciones, los míos; lo propio no cuenta', async () => {
    const mensajes = (await admin.query(`SELECT count(*) FILTER (WHERE a.name = 'Leandro')::int AS de_leandro, count(*) FILTER (WHERE a.name = 'Jorbi')::int AS de_jorbi, count(*)::int AS todos FROM chat_messages m JOIN users a ON a.id = m.author_id WHERE m.source <> 'seed'`)).rows[0]
    const menciona = async (u: string) => (await admin.query(`SELECT count(*)::int AS n FROM chat_mentions cm JOIN chat_messages m ON m.id = cm.message_id WHERE cm.user_id = $1 AND m.author_id <> $1`, [uid[u]])).rows[0].n
    const j = (await api('/chat/contadores', { key: KEY_J })).body
    assert.deepEqual([j.sin_leer, j.menciones_sin_leer], [mensajes.de_leandro, await menciona('Jorbi')])
    assert.ok(j.sin_leer >= 6 && j.menciones_sin_leer === 2)
    const l = (await api('/chat/contadores')).body
    assert.deepEqual([l.sin_leer, l.menciones_sin_leer], [mensajes.de_jorbi, 0], 'Leandro: solo lo de Jorbi cuenta; lo suyo no')
    const e = (await web('Elis', '/chat/contadores')).body
    assert.deepEqual([e.sin_leer, e.menciones_sin_leer], [mensajes.todos, await menciona('Elis')])
    // el listado trae los mismos contadores en meta
    const lista = await api('/chat?limite=1', { key: KEY_J })
    assert.deepEqual([lista.body.meta.sin_leer, lista.body.meta.menciones_sin_leer], [j.sin_leer, j.menciones_sin_leer])
  })

  it('marcar leído: hasta = creado_el del más nuevo MOSTRADO (no «ahora»); nunca retrocede; no pasa de ahora; todos=true', async () => {
    const todos = (await api('/chat?limite=100', { key: KEY_J })).body.data as any[]
    const delaOtros = todos.filter((m) => m.autor.nombre !== 'Jorbi').sort((a, b) => (a.creado_el < b.creado_el ? -1 : 1))
    const antes = (await api('/chat/contadores', { key: KEY_J })).body.sin_leer
    assert.equal(antes, delaOtros.length)
    const mitad = delaOtros[3] // el cuarto de los de Leandro
    const r = await api('/chat/leido', { key: KEY_J, body: { hasta: mitad.creado_el } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.sin_leer, delaOtros.length - 4, 'quedan los posteriores al marcado, no todos ni ninguno')
    assert.equal(r.body.leido_hasta, mitad.creado_el)
    // un instante anterior no retrocede el cursor
    assert.equal((await api('/chat/leido', { key: KEY_J, body: { hasta: delaOtros[0].creado_el } })).body.leido_hasta, mitad.creado_el)
    // un instante futuro se recorta a «ahora»: no deja el cursor adelantado para tragarse lo que llegue después
    const fut = await api('/chat/leido', { key: KEY_J, body: { hasta: '2999-01-01T00:00:00Z' } })
    assert.equal(fut.body.sin_leer, 0)
    assert.ok(fut.body.leido_hasta < '2999')
    await espera(5)
    await pub('Mensaje posterior al marcado')
    assert.equal((await api('/chat/contadores', { key: KEY_J })).body.sin_leer, 1, 'lo nuevo vuelve a contar')
    // todos=true: hasta el último
    assert.equal((await api('/chat/leido', { key: KEY_J, body: { todos: true } })).body.sin_leer, 0)
    for (const b of [{}, { hasta: 'ayer' }, { todos: false }, { hasta: mitad.creado_el, todos: true }, { raro: 1 }]) assert.equal((await api('/chat/leido', { key: KEY_J, body: b })).status, 400, JSON.stringify(b))
    // la web: Elis marca con el creado_el del más nuevo que vio
    const nuevo = (await web('Elis', '/chat?limite=1')).body.data[0]
    const w = await web('Elis', '/chat/leido', { body: { hasta: nuevo.creado_el } })
    assert.deepEqual([w.status, w.body.sin_leer, w.body.menciones_sin_leer], [200, 0, 0])
  })

  it('listar con keyset: más reciente primero, sin huecos ni repetidos, también con milisegundos iguales y empates exactos', async () => {
    // Tres mensajes con el MISMO milisegundo y microsegundos distintos, y tres con el instante idéntico: un cursor truncado a ms perdería filas.
    const instantes = ['2026-01-01T00:00:00.123100Z', '2026-01-01T00:00:00.123400Z', '2026-01-01T00:00:00.123900Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z']
    for (const [i, t] of instantes.entries())
      await admin.query(`INSERT INTO chat_messages (author_id, body, source, created_at, updated_at) VALUES ($1, $2, 'seed', $3::timestamptz, $3::timestamptz)`, [uid.Leandro, `viejo ${t} #${i}`, t])
    const total = (await admin.query('SELECT count(*)::int AS n FROM chat_messages')).rows[0].n as number
    const orden = (await admin.query('SELECT id FROM chat_messages ORDER BY created_at DESC, id DESC')).rows.map((r) => r.id)
    const vistos: string[] = []
    let q = '/chat?limite=4'
    let paginas = 0
    for (;;) {
      const r = await api(q)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.ok(r.body.data.length <= 4)
      vistos.push(...r.body.data.map((m: any) => m.id))
      paginas++
      if (!r.body.meta.hay_mas) {
        assert.equal(r.body.meta.siguiente, null)
        break
      }
      assert.equal(r.body.data.length, 4)
      q = `/chat?limite=4&antes_de=${encodeURIComponent(r.body.meta.siguiente.antes_de)}&antes_de_id=${r.body.meta.siguiente.antes_de_id}`
      assert.ok(paginas < 50)
    }
    assert.equal(vistos.length, total)
    assert.deepEqual(vistos, orden, 'el orden es (created_at, id) descendente, sin saltarse ni repetir nada')
    assert.ok(paginas >= 3)
    const primera = (await api('/chat?limite=1')).body.data[0]
    const antes = await api(`/chat?limite=2&antes_de=${encodeURIComponent(primera.creado_el)}&antes_de_id=${primera.id}`)
    assert.ok(antes.body.data.every((m: any) => m.id !== primera.id))
    for (const bad of ['limite=0', 'limite=101', 'limite=x', `antes_de=${encodeURIComponent('2026-01-01T00:00:00Z')}`, `antes_de_id=${NOPE}`, `antes_de=ayer&antes_de_id=${NOPE}`, 'page=2', 'raro=1'])
      assert.equal((await api(`/chat?${bad}`)).status, 400, bad)
    await admin.query(`DELETE FROM chat_messages WHERE source = 'seed'`)
  })

  it('editar: solo el autor, queda «(editado)», recalcula las menciones, sin cambios no marca, If-Match / actualizado_el', async () => {
    const m = await pub('Primera versión para @Jorbi', { clave_externa: 'edit-1' })
    const id = m.body.id
    assert.deepEqual(m.body.menciones.map((x: any) => x.nombre), ['Jorbi'])
    assert.equal((await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Intento ajeno' }, key: KEY_J })).status, 403, 'otro socio no edita')
    assert.equal((await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Lo cambia la llave de solo lectura' }, key: KEY_R })).status, 403)
    assert.equal((await api(`/chat/${NOPE}`, { method: 'PATCH', body: { cuerpo: 'x' } })).status, 404)
    await espera()
    const e = await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Segunda versión para @Elis' }, headers: { 'if-match': m.full.actualizado_el } })
    assert.equal(e.status, 200, JSON.stringify(e.body))
    assert.deepEqual([e.body.cuerpo, e.body.autor.nombre, e.body.menciones.map((x: any) => x.nombre)], ['Segunda versión para @Elis', 'Leandro', ['Elis']])
    assert.ok(e.body.editado_el)
    assert.equal(e.body.creado_el, m.body.creado_el, 'la hora original no cambia')
    assert.equal(e.body.fuente, 'growi')
    assert.notEqual(e.full.actualizado_el, m.full.actualizado_el)
    // la misma versión de nuevo: no hay nada que cambiar ni que marcar
    const igual = await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Segunda versión para @Elis' } })
    assert.deepEqual([igual.status, igual.body.editado_el], [200, e.body.editado_el])
    // conflicto: quien tenía la versión vieja no pisa
    const viejo = await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Pisando', actualizado_el: m.full.actualizado_el } })
    assert.equal(viejo.status, 409, JSON.stringify(viejo.body))
    assert.equal((await api(`/chat/${id}`)).body.cuerpo, 'Segunda versión para @Elis')
    const ok = await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Tercera, con ids', menciones: [uid.Jorbi], actualizado_el: e.full.actualizado_el } })
    assert.deepEqual(ok.body.menciones.map((x: any) => x.nombre), ['Jorbi'])
    // los ids explícitos inexistentes se rechazan y no cambian nada
    assert.equal((await api(`/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Con id malo', menciones: [NOPE] } })).status, 400)
    assert.equal((await api(`/chat/${id}`)).body.cuerpo, 'Tercera, con ids')
    for (const b of [{}, { cuerpo: '' }, { cuerpo: 'x'.repeat(4001) }, { cuerpo: 'ok', fuente: 'otra' }, { cuerpo: 'ok', autor: uid.Elis }])
      assert.equal((await api(`/chat/${id}`, { method: 'PATCH', body: b })).status, 400, JSON.stringify(b))
    ids.push(id)
  })

  it('borrar: exige el permiso de borrado; solo el autor o un ADMIN; va a la papelera con su etiqueta y se restaura con sus menciones', async () => {
    const largo = `Mensaje para borrar con un texto largo ${'y '.repeat(60)}fin @Jorbi`
    const m = await pub(largo)
    const id = m.body.id
    assert.equal((await api(`/chat/${id}`, { method: 'DELETE' })).status, 403, 'KEY no tiene permiso de borrado')
    assert.equal((await api(`/chat/${id}`, { method: 'DELETE', key: KEY_R })).status, 403)
    const noAutor = await api(`/chat/${id}`, { method: 'DELETE', key: KEY_JD })
    assert.equal(noAutor.status, 403, 'Jorbi tiene el permiso, pero no es el autor ni ADMIN')
    assert.equal((await api(`/chat/${id}`)).status, 200)
    assert.equal((await apiD(`/chat/${NOPE}`, { method: 'DELETE' })).status, 404)

    // un ADMIN sí puede borrar el mensaje de otro
    await admin.query(`UPDATE users SET role = 'ADMIN' WHERE name = 'Jorbi'`)
    const adm = await pub('Mensaje que borrará un administrador')
    const ad = await api(`/chat/${adm.body.id}`, { method: 'DELETE', key: KEY_JD })
    await admin.query(`UPDATE users SET role = 'SOCIO' WHERE name = 'Jorbi'`)
    assert.equal(ad.status, 200, JSON.stringify(ad.body))
    assert.equal((await api(`/chat/${adm.body.id}`)).status, 404)

    const antesDeBorrar = (await api('/chat/contadores', { key: KEY_J })).body.sin_leer
    const d = await apiD(`/chat/${id}`, { method: 'DELETE' })
    assert.equal(d.status, 200, JSON.stringify(d.body))
    assert.equal(d.body.entidad, 'mensaje')
    assert.equal(d.body.nombre, `${largo.replace(/\s+/g, ' ').slice(0, 80)}…`, 'la etiqueta son los primeros 80 caracteres')
    assert.match(d.body.resumen, /Mensaje de Leandro .*1 mención/)
    assert.equal((await api(`/chat/${id}`)).status, 404)
    assert.ok(!(await api('/chat?limite=100')).body.data.some((x: any) => x.id === id))
    assert.equal((await api('/chat/contadores', { key: KEY_J })).body.sin_leer, antesDeBorrar - 1, 'el borrado se descuenta de los no leídos')
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM chat_mentions WHERE message_id = $1', [id])).rows[0].n, 0)

    const pap = (await apiD('/papelera?per_page=100')).body.data.find((x: any) => x.id === d.body.papelera_id)
    assert.deepEqual([pap.tipo, pap.origen, pap.eliminado_por], ['mensaje', 'api:limpieza', 'Leandro'])
    const rest = await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })
    assert.equal(rest.status, 200, JSON.stringify(rest.body))
    const back = await api(`/chat/${id}`)
    assert.deepEqual([back.body.cuerpo, back.body.creado_el, back.body.menciones.map((x: any) => x.nombre)], [largo, m.body.creado_el, ['Jorbi']], 'vuelve idéntico, con la hora original y sus menciones')
    assert.equal((await api('/chat/contadores', { key: KEY_J })).body.sin_leer, antesDeBorrar)
    assert.equal((await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 404, 'ya no está en la papelera')
    // si la clave externa se reutilizó mientras estaba en la papelera, restaurar avisa en vez de duplicar
    const k = await pub('Con clave', { clave_externa: 'k-papelera' })
    const dk = await apiD(`/chat/${k.body.id}`, { method: 'DELETE' })
    assert.equal((await pub('Otra vez con la misma clave', { clave_externa: 'k-papelera' })).status, 201)
    assert.equal((await apiD(`/papelera/${dk.body.papelera_id}/restaurar`, { method: 'POST', body: {} })).status, 409)
  })

  it('web (sesión): publica como «manual» con su nombre, edita y borra lo suyo, la papelera de la web lo lista y restaura; sin sesión 401', async () => {
    const p = await web('Elis', '/chat', { body: { cuerpo: 'Nota de Elis desde la pantalla, cc @leandro', fuente: 'otra', autor: uid.Jorbi } })
    assert.equal(p.status, 400, 'el autor no se manda: strict')
    const q = await web('Elis', '/chat', { body: { cuerpo: 'Nota de Elis desde la pantalla, cc @leandro', fuente: 'otra' } })
    assert.equal(q.status, 201, JSON.stringify(q.body))
    assert.deepEqual([q.body.autor.nombre, q.body.fuente, q.body.menciones.map((x: any) => x.nombre)], ['Elis', 'manual', ['Leandro']], 'la web siempre es «manual» y el autor es la sesión')
    const id = q.body.id
    assert.equal((await web('Jorbi', `/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'ajeno' } })).status, 403)
    assert.equal((await web('Jorbi', `/chat/${id}`, { method: 'DELETE' })).status, 403, 'Jorbi no es ADMIN aquí ni autor')
    const e = await web('Elis', `/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'Nota de Elis, editada' }, headers: { 'if-match': q.full.actualizado_el } })
    assert.deepEqual([e.status, e.body.cuerpo, e.body.menciones.length], [200, 'Nota de Elis, editada', 0])
    assert.ok(e.body.editado_el)
    assert.equal((await web('Elis', `/chat/${id}`, { method: 'PATCH', body: { cuerpo: 'tarde' }, headers: { 'if-match': q.full.actualizado_el } })).status, 409)
    const lista = await web('Jorbi', '/chat?limite=3')
    assert.equal(lista.status, 200)
    assert.equal(lista.body.data[0].id, id)
    assert.equal((await web('Jorbi', `/chat/${id}`)).body.autor.nombre, 'Elis')
    // borrar: la papelera de la web lo muestra y lo restaura
    assert.equal((await web('Elis', `/chat/${id}`, { method: 'DELETE' })).status, 200)
    const trash = (await web('Elis', '/trash')).body as any[]
    const item = trash.find((t) => t.entity === 'mensaje' && t.label === 'Nota de Elis, editada')
    assert.ok(item, JSON.stringify(trash.map((t) => t.entity)))
    assert.equal(item.deletedBy, 'Elis')
    assert.equal((await web('Elis', `/trash/${item.id}/restore`, { method: 'POST' })).body.restaurado, true)
    assert.equal((await web('Elis', `/chat/${id}`)).status, 200)
    for (const [m, p2] of [['GET', '/chat'], ['GET', '/chat/contadores'], ['GET', '/chat/usuarios'], ['POST', '/chat'], ['POST', '/chat/leido']]) {
      const r = await http(`${ROOT}/api${p2}`, { method: m, ...(m === 'POST' ? { body: {} } : {}) })
      assert.equal(r.status, 401, `${m} ${p2}`)
    }
  })

  it('permisos de la llave: leer exige read, publicar/editar/marcar exigen write, borrar exige delete', async () => {
    const r = (path: string, o: any = {}) => api(path, { key: KEY_R, ...o })
    assert.equal((await r('/chat')).status, 200)
    assert.equal((await r('/chat/contadores')).status, 200)
    assert.equal((await r('/chat/usuarios')).status, 200)
    for (const [m, path, body] of [['POST', '/chat', { cuerpo: 'x', fuente: 'growi' }], ['POST', '/chat/leido', { todos: true }], ['PATCH', `/chat/${ids[0]}`, { cuerpo: 'x' }]] as const) {
      const x = await r(path, { method: m, body })
      assert.equal(x.status, 403, `${m} ${path}`)
      assert.equal(x.body.error.required_scope, 'write')
    }
    assert.equal((await r(`/chat/${ids[0]}`, { method: 'DELETE' })).body.error.required_scope, 'delete')
    assert.equal((await http(`${ROOT}/api/v1/chat`)).status, 401)
  })

  it('MCP: las herramientas según los permisos de la llave, publicar idempotente, @ y uuid, editar con conflicto, marcar leído y borrar', async () => {
    const nombres = async (key: string) => ((await rpc('tools/list', {}, key)).body.result.tools as any[]).map((t) => t.name).filter((x: string) => x.startsWith('hayai_chat')).sort()
    assert.deepEqual(await nombres(KEY), ['hayai_chat_editar', 'hayai_chat_listar', 'hayai_chat_marcar_leido', 'hayai_chat_publicar', 'hayai_chat_usuarios'])
    assert.deepEqual(await nombres(KEY_D), ['hayai_chat_borrar', 'hayai_chat_editar', 'hayai_chat_listar', 'hayai_chat_marcar_leido', 'hayai_chat_publicar', 'hayai_chat_usuarios'])
    assert.deepEqual(await nombres(KEY_R), ['hayai_chat_listar', 'hayai_chat_usuarios'])
    const tools = (await rpc('tools/list')).full.result.tools as any[]
    assert.equal(tools.find((t) => t.name === 'hayai_chat_listar').annotations.readOnlyHint, true)
    assert.ok(tools.find((t) => t.name === 'hayai_chat_editar').inputSchema.properties.actualizado_el, 'editar acepta actualizado_el')
    const p = dato(await mcp('hayai_chat_publicar', { cuerpo: 'Aviso desde el Muse para @Jorbi', fuente: 'muse-leandro', clave_externa: 'mcp-1' }))
    assert.deepEqual([p.creado, p.autor.nombre, p.fuente, p.menciones.map((m: any) => m.nombre)], [true, 'Leandro', 'muse-leandro', ['Jorbi']])
    const otra = dato(await mcp('hayai_chat_publicar', { cuerpo: 'Aviso desde el Muse para @Jorbi', fuente: 'muse-leandro', clave_externa: 'mcp-1' }))
    assert.deepEqual([otra.creado, otra.id], [false, p.id])
    assert.deepEqual(dato(await mcp('hayai_chat_publicar', { cuerpo: 'Por id', fuente: 'muse-leandro', menciones: [uid.Elis] })).menciones.map((m: any) => m.nombre), ['Elis'])
    const l = dato(await mcp('hayai_chat_listar', { limite: 2 }))
    assert.equal(l.data.length, 2)
    assert.ok(typeof l.meta.sin_leer === 'number' && l.meta.hay_mas === true && l.meta.siguiente.antes_de_id)
    const sig = dato(await mcp('hayai_chat_listar', { limite: 2, antes_de: l.meta.siguiente.antes_de, antes_de_id: l.meta.siguiente.antes_de_id }))
    assert.ok(!sig.data.some((m: any) => l.data.some((x: any) => x.id === m.id)))
    assert.ok((await mcp('hayai_chat_publicar', { cuerpo: '', fuente: 'x' })).result.isError)
    assert.ok((await mcp('hayai_chat_publicar', { cuerpo: 'hola' })).result.isError, 'la fuente es obligatoria')
    const visto = p.actualizado_el
    await espera()
    assert.notEqual(dato(await mcp('hayai_chat_editar', { id: p.id, cuerpo: 'Corregido' })).editado_el, null)
    const conf = await mcp('hayai_chat_editar', { id: p.id, cuerpo: 'Pisando', actualizado_el: visto })
    assert.ok(conf.result.isError)
    assert.match(conf.result.content[0].text, /cambió mientras lo editabas/)
    const ajeno = await mcp('hayai_chat_editar', { id: p.id, cuerpo: 'De Jorbi' }, KEY_J)
    assert.ok(ajeno.result.isError)
    assert.match(ajeno.result.content[0].text, /Solo el autor/)
    assert.equal(dato(await mcp('hayai_chat_marcar_leido', { todos: true }, KEY_J)).sin_leer, 0)
    assert.equal(dato(await mcp('hayai_chat_usuarios', {})).data.length, 3)
    const del = dato(await mcp('hayai_chat_borrar', { id: p.id }, KEY_D))
    assert.equal(del.entidad, 'mensaje')
    assert.ok((await mcp('hayai_chat_borrar', { id: p.id }, KEY_D)).result.isError, 'ya no existe')
  })

  it('en vivo (SSE): nuevo, editado, borrado y restaurado llegan a las pestañas abiertas con el evento «chat», sin pisar el id de la actividad', async () => {
    const ac = new AbortController()
    const res = await fetch(`${ROOT}/api/events`, { headers: { cookie: cookies.Elis }, signal: ac.signal })
    const eventos: { event: string; id: string | null; data: any }[] = []
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    void (async () => {
      let raw = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          raw += dec.decode(value, { stream: true })
          let i: number
          while ((i = raw.indexOf('\n\n')) >= 0) {
            const lines = raw.slice(0, i).split('\n')
            raw = raw.slice(i + 2)
            const ev = lines.find((l) => l.startsWith('event: '))
            const data = lines.find((l) => l.startsWith('data: '))
            if (ev && data) eventos.push({ event: ev.slice(7), id: lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null, data: JSON.parse(data.slice(6)) })
          }
        }
      } catch {
        /* abortado */
      }
    })()
    const llega = async (pred: (e: (typeof eventos)[number]) => boolean) => {
      for (let t = 0; t < 160; t++) {
        const e = eventos.find(pred)
        if (e) return e
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`no llegó el evento; llegaron: ${JSON.stringify(eventos.map((e) => [e.event, e.data.op]))}`)
    }
    try {
      await espera(150)
      const m = await pub('En vivo para @Elis')
      const nuevo = await llega((e) => e.event === 'chat' && e.data.op === 'nuevo' && e.data.mensaje.id === m.body.id)
      assert.equal(nuevo.id, null, 'sin id: no pisa el Last-Event-ID de la actividad')
      assert.deepEqual([nuevo.data.mensaje.autor.nombre, nuevo.data.mensaje.cuerpo, nuevo.data.mensaje.menciones.map((x: any) => x.nombre)], ['Leandro', 'En vivo para @Elis', ['Elis']])
      await api(`/chat/${m.body.id}`, { method: 'PATCH', body: { cuerpo: 'En vivo, editado' } })
      const ed = await llega((e) => e.data.op === 'editado' && e.data.mensaje.id === m.body.id)
      assert.deepEqual([ed.event, ed.data.mensaje.cuerpo, ed.data.mensaje.editado_el !== null], ['chat', 'En vivo, editado', true])
      const d = await apiD(`/chat/${m.body.id}`, { method: 'DELETE' })
      const bo = await llega((e) => e.data.op === 'borrado' && e.data.id === m.body.id)
      assert.equal(bo.event, 'chat')
      await apiD(`/papelera/${d.body.papelera_id}/restaurar`, { method: 'POST', body: {} })
      await llega((e) => e.data.op === 'nuevo' && e.data.mensaje.id === m.body.id && e !== nuevo)
      // el stream de la actividad sigue igual: ningún evento del chat se hace pasar por actividad
      assert.ok(eventos.filter((e) => e.event === 'chat').every((e) => e.data.tipo === undefined))
      // una publicación idempotente repetida no vuelve a avisar
      await pub('Idempotente en vivo', { clave_externa: 'live-1' })
      await llega((e) => e.data.mensaje?.cuerpo === 'Idempotente en vivo')
      const cuantos = eventos.length
      await pub('Idempotente en vivo', { clave_externa: 'live-1' })
      await espera(300)
      assert.equal(eventos.length, cuantos)
    } finally {
      ac.abort()
    }
  })

  it('base de datos: las reglas viven también en las tablas (cuerpo recortado y no vacío, fuente en slug, edición no anterior a la creación)', async () => {
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO chat_messages (author_id, ${cols}) SELECT id, ${vals} FROM users LIMIT 1`)
    await assert.rejects(ins('body', `' '`), /check/i)
    await assert.rejects(ins('body', `' hola'`), /check/i)
    await assert.rejects(ins('body', `repeat('x', 4001)`), /check/i)
    await assert.rejects(ins('body, source', `'hola', 'Mala Fuente'`), /check/i)
    await assert.rejects(ins('body, edited_at', `'hola', now() - interval '1 day'`), /chat_messages_edited_ck/)
    await assert.rejects(admin.query(`INSERT INTO chat_mentions (message_id, user_id) VALUES ($1, $2)`, [NOPE, uid.Elis]), /foreign key/i)
  })
})

describe('1.7.5 Central de marketing', () => {
  let n = 0
  const rpc = (method: string, params: unknown = {}, key: string | null = KEY) =>
    http(`${ROOT}/mcp`, { key, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: ++n, method, params } })
  const tool = async (name: string, args: unknown = {}, key: string | null = KEY) => (await rpc('tools/call', { name, arguments: args }, key)).body
  const dato = (b: any) => JSON.parse(b.result.content[0].text)
  const mk = (path: string, o: Opts = {}) => api(`/marketing${path}`, o)
  let cookie = ''
  let KEY_R = ''
  let kwPrecio = ''
  let comp = ''
  let pieza = ''

  before(async () => {
    KEY_R = newKey('Jorbi', 'solo-lectura-mk', 'read')
    const login = await fetch(`${ROOT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorbi', pin: '482913' }) })
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))!.split(';')[0]
  })

  // ---------- Parte 1: origen y embudo ----------
  it('origen: un posible cliente nuevo nunca queda sin origen (por defecto «otro»), no admite null y guarda utm_source', async () => {
    const a = await api('/clientes', { body: { nombre: 'Lead sin decir origen', estado: 'posible' } })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.equal(a.body.origen, 'otro')
    const b = await api('/clientes', { body: { nombre: 'Lead de Instagram', estado: 'posible', origen: 'instagram', utm_source: 'bio_link' } })
    assert.deepEqual([b.body.origen, b.body.utm_source], ['instagram', 'bio_link'])
    const nulo = await api('/clientes', { body: { nombre: 'Lead nulo', estado: 'posible', origen: null } })
    assert.equal(nulo.status, 400)
    assert.match(nulo.body.error.message, /origen/)
    const malo = await api('/clientes', { body: { nombre: 'Lead raro', estado: 'posible', origen: 'tiktok' } })
    assert.equal(malo.status, 400)
    // un cliente activo (alta directa) no se obliga: el origen es del embudo
    assert.equal((await api('/clientes', { body: { nombre: 'Cliente directo' } })).body.origen, null)
    const p = await api(`/clientes/${b.body.id}`, { method: 'PATCH', body: { utm_source: 'anuncio_2' } })
    assert.equal(p.body.utm_source, 'anuncio_2')
    assert.equal((await api(`/clientes/${b.body.id}`, { method: 'PATCH', body: { utm_source: null } })).body.utm_source, null)
  })

  it('web: crear un posible cliente manda el origen (obligatorio, por defecto «otro») y utmSource', async () => {
    const post = (b: unknown) =>
      fetch(`${ROOT}/api/prospects`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': 'x' }, body: JSON.stringify(b) })
    const base = { name: 'Web Lead', avatar: 'nova', project: { name: 'Sistema web', icon: 'globe', owner: 'Jorbi' } }
    const r1 = await post(base)
    assert.equal(r1.status, 201, await r1.clone().text())
    assert.equal(((await r1.json()) as any).client.source, 'otro')
    const r2 = await post({ ...base, name: 'Web Lead 2', source: 'whatsapp', utmSource: 'qr_local' })
    const j2 = (await r2.json()) as any
    assert.deepEqual([j2.client.source, j2.client.utmSource], ['whatsapp', 'qr_local'])
    assert.equal((await post({ ...base, name: 'Web Lead 3', source: 'tiktok' })).status, 400)
  })

  it('embudo: el desglose por origen suma exacto (abiertos + ganados + perdidos + descartados + alta directa) y trae el estado de Meta', async () => {
    await admin.query(`UPDATE clients SET lead_source = NULL WHERE lead_source IS NOT NULL AND name LIKE 'Lead%'`)
    const r = await mk('/embudo')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    for (const o of r.body.por_origen) {
      assert.equal(o.abiertos + o.ganados + o.perdidos + o.descartados + o.directos, o.entraron, JSON.stringify(o))
      assert.ok(o.directos >= 0)
    }
    assert.equal(r.body.meta_ads.conectado, true)
    assert.ok(r.body.meta_ads.total >= r.body.meta_ads.con_error)
    const sin = r.body.por_origen.find((o: any) => o.origen === 'sin_origen')
    assert.ok(sin && sin.directos >= 1, 'el cliente directo explica los que no son abiertos ni cerrados')
  })

  it('embudo: el selector de período recalcula (una alta vieja sale de 30 días y entra en 90)', async () => {
    const c = await api('/clientes', { body: { nombre: 'Lead de hace 60 días', estado: 'posible', origen: 'referido' } })
    const entraron = (r: any, origen = 'referido') => r.body.por_origen.find((o: any) => o.origen === origen)?.entraron ?? 0
    const corto0 = entraron(await mk('/embudo?dias=30'))
    const largo0 = entraron(await mk('/embudo?dias=90'))
    await admin.query(`UPDATE clients SET created_at = now() - interval '60 days' WHERE id = $1`, [c.body.id])
    const corto = await mk('/embudo?dias=30')
    const largo = await mk('/embudo?dias=90')
    assert.equal(corto.body.dias, 30)
    assert.equal(largo.body.dias, 90)
    assert.equal(entraron(corto), corto0 - 1, 'a 30 días ya no cuenta')
    assert.equal(entraron(largo), largo0, 'a 90 días sigue contando')
  })

  // ---------- Parte 2: keywords ----------
  it('investigar: sugerencias y preguntas del autocompletado, sin repetir la semilla ni entre sí, con intención sugerida', async () => {
    const r = await mk('/keywords/investigar?semilla=sistema%20de%20citas')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.fallidas, 0)
    const textos = r.body.sugerencias.map((s: any) => s.texto)
    assert.equal(new Set(textos.map((t: string) => t.toLowerCase())).size, textos.length, 'sin repetidas')
    assert.ok(!textos.includes('sistema de citas'), 'la semilla no se sugiere a sí misma')
    const precio = r.body.sugerencias.find((s: any) => s.texto === 'sistema de citas precio')
    assert.deepEqual([precio.intencion_sugerida, precio.guardada], ['comercial', false])
    assert.equal(r.body.sugerencias.find((s: any) => s.texto === 'sistema de citas en barquisimeto').intencion_sugerida, 'local')
    assert.ok(r.body.sugerencias.some((s: any) => s.tipo === 'pregunta'), 'trae preguntas tipo «la gente también pregunta»')
    assert.ok(extHits.google.length >= 11)
    assert.equal((await mk('/keywords/investigar')).status, 400, 'la semilla es obligatoria')
  })

  it('investigar: si el autocompletado cae responde 502 con un mensaje claro (y se puede cargar a mano)', async () => {
    extDown.google = true
    try {
      const r = await mk('/keywords/investigar?semilla=cualquier%20cosa')
      assert.equal(r.status, 502)
      assert.match(r.body.error.message, /no respondió.*a mano/i)
    } finally {
      extDown.google = false
    }
    const manual = await mk('/keywords', { body: { texto: 'Carga a mano', fuente: 'manual' } })
    assert.equal(manual.status, 201)
    assert.equal(manual.body.fuente, 'manual')
  })

  it('guardar en lote: sin duplicados (mayúsculas y acentos no cuentan), la guardada sale como «guardada» al investigar', async () => {
    const r = await mk('/keywords', { body: { items: [{ texto: 'Sistema de citas precio', fuente: 'autocompletado' }, { texto: 'sistema de citas en barquisimeto', intencion: 'local', fuente: 'autocompletado' }, { texto: 'SISTEMA DE CITAS PRECIO' }, { texto: 'cómo automatizar mi negocio' }] } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual([r.body.recibidas, r.body.creadas, r.body.duplicadas], [4, 3, 1])
    assert.equal(r.body.data[0].intencion, 'comercial')
    assert.equal(r.body.data[0].estado, 'por_atacar')
    assert.equal(r.body.data[0].guardada_por, 'Leandro')
    assert.equal(r.body.data[2].creada, false)
    assert.equal(r.body.data[2].id, r.body.data[0].id)
    kwPrecio = r.body.data[0].id
    const otra = await mk('/keywords', { body: { texto: 'cOmO AUTOMATIZAR mi negocio' } })
    assert.equal(otra.status, 200, 'ya estaba: 200 y creada=false')
    assert.equal(otra.body.creada, false)
    const inv = await mk('/keywords/investigar?semilla=sistema%20de%20citas')
    const s = inv.body.sugerencias.find((x: any) => x.texto === 'sistema de citas precio')
    assert.deepEqual([s.guardada, s.keyword_id], [true, kwPrecio])
    // forma: o una o lista
    assert.equal((await mk('/keywords', { body: { texto: 'x', items: [{ texto: 'y' }] } })).status, 400)
    assert.equal((await mk('/keywords', { body: {} })).status, 400)
    assert.equal((await mk('/keywords', { body: { items: [] } })).status, 400)
  })

  it('listar: buscador y filtros por intención y estado; actualizar estado/intención; no se renombra a una que ya existe', async () => {
    const todas = await mk('/keywords?per_page=100')
    assert.ok(todas.body.meta.total >= 4)
    assert.equal(todas.body.meta.por_estado.por_atacar, todas.body.meta.total)
    assert.deepEqual((await mk('/keywords?q=CITAS')).body.data.map((k: any) => k.texto).sort(), ['Sistema de citas precio', 'sistema de citas en barquisimeto'])
    assert.deepEqual((await mk('/keywords?intencion=local')).body.data.map((k: any) => k.texto), ['sistema de citas en barquisimeto'])
    assert.equal((await mk('/keywords?intencion=otra')).status, 400)
    const d = await mk(`/keywords/${kwPrecio}`, { method: 'PATCH', body: { estado: 'descartada' } })
    assert.equal(d.body.estado, 'descartada')
    assert.equal((await mk('/keywords?estado=descartada')).body.data.length, 1)
    assert.equal((await mk(`/keywords/${kwPrecio}`, { method: 'PATCH', body: { estado: 'por_atacar', intencion: 'comercial' } })).body.estado, 'por_atacar')
    assert.equal((await mk(`/keywords/${kwPrecio}`, { method: 'PATCH', body: { texto: 'SISTEMA de citas en Barquisimeto' } })).status, 409)
    assert.equal((await mk(`/keywords/${kwPrecio}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await mk(`/keywords/${NOPE}`)).status, 404)
  })

  it('SERP: el aviso de costo va primero; sin confirmar_costo NO se llama a Brightdata; confirmado, guarda el top 10 (y reconsultar no es gratis)', async () => {
    const aviso = await mk(`/keywords/${kwPrecio}/serp-aviso`)
    assert.equal(aviso.status, 200, JSON.stringify(aviso.body))
    assert.equal(aviso.body.conectado, true)
    assert.equal(aviso.body.costo_estimado_usd, 0.002)
    assert.match(aviso.body.mensaje, /Esta consulta consume saldo de tu cuenta de Brightdata/)
    assert.equal(aviso.body.ultimo_serp, null)
    const antes = extHits.brightdata.length
    for (const body of [{}, { confirmar_costo: false }, { confirmar_costo: 'false' }]) {
      const r = await mk(`/keywords/${kwPrecio}/serp`, { body })
      assert.equal(r.status, 409, JSON.stringify(body))
      assert.equal(r.body.error.requiere_confirmacion, true)
      assert.equal(r.body.error.costo_estimado_usd, 0.002)
      assert.match(r.body.error.message, /consume saldo/)
    }
    assert.equal(extHits.brightdata.length, antes, 'sin confirmación no se gasta nada')
    const ok = await mk(`/keywords/${kwPrecio}/serp`, { body: { confirmar_costo: true } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(extHits.brightdata.length, antes + 1)
    const llamada = extHits.brightdata.at(-1) as any
    assert.equal(llamada.auth, 'Bearer bd-llave-de-prueba')
    assert.equal(llamada.body.zone, 'serp_zona_prueba')
    assert.match(llamada.body.url, /google\.com\/search\?q=Sistema%20de%20citas%20precio/)
    assert.deepEqual(ok.body.resultados.map((x: any) => [x.posicion, x.dominio]), [[1, 'ejemplo-blog.com'], [2, 'rivalia.com.ve'], [3, 'instagram.com'], [4, 'otro.net']])
    assert.equal(ok.body.costo_estimado_usd, 0.002)
    assert.ok(ok.body.resultados.every((x: any) => x.competidor === null), 'aún no hay competidores')
    // queda guardado en la ficha y en el aviso
    assert.equal((await mk(`/keywords/${kwPrecio}`)).body.serp.resultados.length, 4)
    assert.ok((await mk(`/keywords/${kwPrecio}/serp-aviso`)).body.ultimo_serp)
    // si Brightdata falla: 502 y no se guarda un SERP nuevo
    const filas = (await admin.query('SELECT count(*)::int AS n FROM mk_serp')).rows[0].n
    extDown.brightdata = true
    try {
      const caido = await mk(`/keywords/${kwPrecio}/serp`, { body: { confirmar_costo: true } })
      assert.equal(caido.status, 502)
      assert.match(caido.body.error.message, /No se guardó nada/)
    } finally {
      extDown.brightdata = false
    }
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM mk_serp')).rows[0].n, filas)
    assert.equal((await mk(`/keywords/${NOPE}/serp`, { body: { confirmar_costo: true } })).status, 404)
  })

  it('SERP: una llave de solo lectura puede ver el aviso pero no gastar saldo', async () => {
    assert.equal((await mk(`/keywords/${kwPrecio}/serp-aviso`, { key: KEY_R })).status, 200)
    assert.equal((await mk(`/keywords/${kwPrecio}/serp`, { key: KEY_R, body: { confirmar_costo: true } })).status, 403)
  })

  it('Brightdata sin configurar: se dice sin gastar nada (503) y el aviso lo marca', async () => {
    const { brightdataListo, serpGoogle } = await import('../src/marketingExterno.ts')
    const guardado = { k: process.env.BRIGHTDATA_API_KEY, z: process.env.BRIGHTDATA_SERP_ZONE }
    delete process.env.BRIGHTDATA_API_KEY
    delete process.env.BRIGHTDATA_SERP_ZONE
    try {
      assert.equal(brightdataListo(), false)
      await assert.rejects(serpGoogle('x'), (e: any) => e.status === 503 && /no está configurado/.test(e.message))
    } finally {
      if (guardado.k) process.env.BRIGHTDATA_API_KEY = guardado.k
      if (guardado.z) process.env.BRIGHTDATA_SERP_ZONE = guardado.z
    }
  })

  it('crear idea de contenido: va al feed firmada por quien la crea, vinculada a la keyword; una sola por keyword', async () => {
    const r = await mk(`/keywords/${kwPrecio}/idea`, { body: {}, key: KEY_J })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.creada, true)
    const item = await api(`/feed/${r.body.item_id}`)
    assert.deepEqual([item.body.tipo, item.body.fuente, item.body.publicado_por.nombre, item.body.clave_externa], ['idea', 'marketing', 'Jorbi', `kw:${kwPrecio}`])
    assert.equal(item.body.datos.keyword_id, kwPrecio)
    assert.equal((await mk(`/keywords/${kwPrecio}`)).body.idea_item_id, r.body.item_id)
    const otra = await mk(`/keywords/${kwPrecio}/idea`, { body: {}, key: KEY })
    assert.equal(otra.status, 200)
    assert.deepEqual([otra.body.creada, otra.body.item_id], [false, r.body.item_id])
  })

  // ---------- Parte 4: contenido ----------
  it('mover keyword a contenido: crea la pieza en Idea (responsable por defecto: quien la mueve), marca la keyword «En contenido» y no duplica', async () => {
    const r = await mk(`/keywords/${kwPrecio}/contenido`, { body: { fecha_objetivo: '2099-01-10', notas: 'Enfocar a negocios locales' }, key: KEY_J })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const c = r.body.contenido
    assert.deepEqual([c.estado, c.titulo, c.keyword.texto, c.responsable.nombre, c.fecha_objetivo, c.notas], ['idea', 'Sistema de citas precio', 'Sistema de citas precio', 'Jorbi', '2099-01-10', 'Enfocar a negocios locales'])
    assert.equal(c.feed_item_id, (await mk(`/keywords/${kwPrecio}`)).body.idea_item_id, 'conserva el vínculo con la idea del feed')
    assert.equal(r.body.keyword.estado, 'en_contenido')
    pieza = c.id
    const otra = await mk(`/keywords/${kwPrecio}/contenido`, { body: {} })
    assert.equal(otra.status, 200)
    assert.deepEqual([otra.body.creado, otra.body.contenido_id], [false, pieza])
  })

  it('tablero: crear a mano, responsable por defecto, semáforo (vencida / próxima / en plazo) y validaciones', async () => {
    const ayer = new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10)
    const enDos = new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10)
    const vencida = await mk('/contenidos', { body: { titulo: 'Reel de bienvenida', fecha_objetivo: ayer } })
    assert.equal(vencida.status, 201, JSON.stringify(vencida.body))
    assert.deepEqual([vencida.body.estado, vencida.body.responsable.nombre, vencida.body.keyword], ['idea', 'Leandro', null])
    assert.equal(vencida.body.semaforo, 'vencida')
    const proxima = await mk('/contenidos', { body: { titulo: 'Post de precios', fecha_objetivo: enDos, responsable: 'jorbi', keyword_id: kwPrecio } })
    assert.deepEqual([proxima.body.semaforo, proxima.body.responsable.nombre, proxima.body.keyword.id], ['proxima', 'Jorbi', kwPrecio])
    assert.equal((await mk('/contenidos', { body: { titulo: 'Sin fecha' } })).body.semaforo, null)
    assert.equal((await mk(`/contenidos/${pieza}`)).body.semaforo, 'en_plazo')
    for (const body of [{}, { titulo: '' }, { titulo: 'x', responsable: 'Nadie' }, { titulo: 'x', fecha_objetivo: '10/10/2026' }, { titulo: 'x', keyword_id: NOPE }]) {
      assert.ok([400, 404].includes((await mk('/contenidos', { body })).status), JSON.stringify(body))
    }
    const lista = await mk('/contenidos')
    assert.equal(lista.body.columnas.idea, lista.body.data.length)
    assert.equal(lista.body.data[0].semaforo, 'vencida', 'lo más urgente primero')
    assert.deepEqual((await mk('/contenidos?responsable=Jorbi')).body.data.map((c: any) => c.responsable.nombre), ['Jorbi', 'Jorbi'])
  })

  it('tablero: mover a producción; publicar EXIGE dónde y enlace (http/https); volver a atrás limpia lo publicado', async () => {
    const prod = await mk(`/contenidos/${pieza}/mover`, { body: { estado: 'produccion' } })
    assert.equal(prod.body.estado, 'produccion')
    for (const body of [{ estado: 'publicado' }, { estado: 'publicado', publicado_en: 'Instagram' }, { estado: 'publicado', enlace: 'https://instagram.com/p/abc' }]) {
      const r = await mk(`/contenidos/${pieza}/mover`, { body })
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.ok(Array.isArray(r.body.error.faltan) && r.body.error.faltan.length >= 1)
    }
    assert.equal((await mk(`/contenidos/${pieza}/mover`, { body: { estado: 'publicado', publicado_en: 'Instagram', enlace: 'no es un enlace' } })).status, 400)
    assert.equal((await mk(`/contenidos/${pieza}`)).body.estado, 'produccion', 'los intentos fallidos no movieron nada')
    const pub = await mk(`/contenidos/${pieza}/mover`, { body: { estado: 'publicado', publicado_en: 'Instagram', enlace: 'https://instagram.com/p/abc' } })
    assert.equal(pub.status, 200, JSON.stringify(pub.body))
    assert.deepEqual([pub.body.estado, pub.body.publicado_en, pub.body.enlace, pub.body.semaforo], ['publicado', 'Instagram', 'https://instagram.com/p/abc', null])
    assert.ok(pub.body.publicado_el)
    assert.equal((await mk(`/keywords/${kwPrecio}`)).body.estado, 'en_contenido')
    // publicada: dónde y enlace se corrigen pero no se vacían
    assert.equal((await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { enlace: 'https://instagram.com/p/xyz' } })).body.enlace, 'https://instagram.com/p/xyz')
    assert.equal((await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { enlace: null } })).status, 400)
    const atras = await mk(`/contenidos/${pieza}/mover`, { body: { estado: 'idea' } })
    assert.deepEqual([atras.body.estado, atras.body.enlace, atras.body.publicado_en, atras.body.publicado_el], ['idea', null, null, null])
    // y antes de publicar no se pueden fijar a mano
    assert.equal((await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { enlace: 'https://x.com/y' } })).status, 400)
    // la base lo impone también (por si algo escribe directo)
    await assert.rejects(admin.query(`UPDATE mk_contenidos SET estado = 'publicado' WHERE id = $1`, [pieza]))
  })

  it('tablero: editar, archivar y restaurar una pieza', async () => {
    const e = await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { titulo: 'Guía de precios', responsable: 'Elis', fecha_objetivo: null, notas: null } })
    assert.deepEqual([e.body.titulo, e.body.responsable.nombre, e.body.fecha_objetivo], ['Guía de precios', 'Elis', null])
    const a = await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { archivado: true } })
    assert.equal(a.body.archivado, true)
    assert.ok(!(await mk('/contenidos')).body.data.some((c: any) => c.id === pieza))
    assert.ok((await mk('/contenidos?archivados=solo')).body.data.some((c: any) => c.id === pieza))
    assert.equal((await mk(`/contenidos/${pieza}/mover`, { body: { estado: 'produccion' } })).status, 409)
    assert.equal((await mk(`/contenidos/${pieza}`, { method: 'PATCH', body: { archivado: false } })).body.archivado, false)
    assert.equal((await mk(`/contenidos/${NOPE}`)).status, 404)
  })

  it('feed → contenido: «Mover a contenido» crea la pieza, conserva el vínculo (creados) y se puede deshacer', async () => {
    const it0 = await api('/feed', { body: { titulo: 'Idea: reels de antes y después', resumen: 'Mostrar el cambio de un negocio.', tipo: 'idea', fuente: 'muse-jorbi', clave_externa: 'ct-1' } })
    const cv = await api(`/feed/${it0.body.id}/convertir`, { body: { a: 'contenido', responsable: 'Elis', vence: '2099-02-01' }, key: KEY_J })
    assert.equal(cv.status, 200, JSON.stringify(cv.body))
    assert.equal(cv.body.item.estado, 'convertido')
    assert.equal(cv.body.item.convertido.a, 'contenido')
    const cid = cv.body.creado.id
    assert.equal(cv.body.item.creados.contenido.id, cid)
    assert.equal(cv.body.item.creados.contenido.por, 'Jorbi')
    const c = (await mk(`/contenidos/${cid}`)).body
    assert.deepEqual([c.titulo, c.estado, c.responsable.nombre, c.fecha_objetivo, c.notas, c.feed_item_id], ['Idea: reels de antes y después', 'idea', 'Elis', '2099-02-01', 'Mostrar el cambio de un negocio.', it0.body.id])
    // no se convierte dos veces en lo mismo
    assert.equal((await api(`/feed/${it0.body.id}/convertir`, { body: { a: 'contenido' } })).status, 409)
    const und = await api(`/feed/${it0.body.id}/deshacer`, { body: { a: 'contenido' }, key: KEY_J })
    assert.equal(und.status, 200, JSON.stringify(und.body))
    assert.equal((await mk(`/contenidos/${cid}`)).body.archivado, true)
    assert.equal((await api(`/feed/${it0.body.id}`)).body.estado, 'nuevo')
  })

  it('feed → contenido desde la idea de una keyword: hereda la keyword y la pasa a «En contenido»', async () => {
    const k = (await mk('/keywords', { body: { texto: 'automatizar whatsapp negocio', fuente: 'manual' } })).body
    const idea = (await mk(`/keywords/${k.id}/idea`, { body: {} })).body
    const cv = await api(`/feed/${idea.item_id}/convertir`, { body: { a: 'contenido' } })
    assert.equal(cv.status, 200, JSON.stringify(cv.body))
    const c = (await mk(`/contenidos/${cv.body.creado.id}`)).body
    assert.equal(c.keyword.id, k.id)
    assert.equal((await mk(`/keywords/${k.id}`)).body.estado, 'en_contenido')
  })

  // ---------- Parte 3: competidores ----------
  it('competidores: solo el nombre es obligatorio; fecha de alta; sin repetidos; editar y archivar', async () => {
    assert.equal((await mk('/competidores', { body: {} })).status, 400)
    const c = await mk('/competidores', { body: { nombre: 'Rivalia' } })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    assert.deepEqual([c.body.web, c.body.instagram, c.body.notas, c.body.archivado], [null, null, null, false])
    assert.match(c.body.fecha_alta, /^\d{4}-\d{2}-\d{2}T/)
    comp = c.body.id
    assert.equal((await mk('/competidores', { body: { nombre: ' RIVALIA ' } })).status, 409)
    const e = await mk(`/competidores/${comp}`, { method: 'PATCH', body: { web: 'https://www.rivalia.com.ve', instagram: '@rivaliave', notas: 'Agencia local' } })
    assert.deepEqual([e.body.web, e.body.instagram, e.body.notas], ['https://www.rivalia.com.ve', '@rivaliave', 'Agencia local'])
    assert.equal((await mk(`/competidores/${comp}`, { method: 'PATCH', body: {} })).status, 400)
    const otro = (await mk('/competidores', { body: { nombre: 'Temporal' } })).body.id
    assert.equal((await mk(`/competidores/${otro}`, { method: 'PATCH', body: { archivado: true } })).body.archivado, true)
    assert.ok(!(await mk('/competidores')).body.data.some((c: any) => c.id === otro))
    assert.ok((await mk('/competidores?archivados=solo')).body.data.some((c: any) => c.id === otro))
    assert.equal((await mk('/competidores', { body: { nombre: 'Temporal' } })).status, 201, 'un archivado libera el nombre')
    assert.deepEqual((await mk('/competidores?q=rival')).body.data.map((c: any) => c.nombre), ['Rivalia'])
  })

  it('competidores — «lo que sabemos»: hallazgos del espía de anuncios que lo mencionan; sin coincidencias, lista vacía (nada inventado)', async () => {
    assert.deepEqual((await mk(`/competidores/${comp}`)).body.hallazgos, [])
    await api('/feed', { body: { items: [
      { titulo: 'Anuncio nuevo de Rivalia: «Automatiza tu negocio»', resumen: 'Oferta de 30 días gratis.', tipo: 'alerta', fuente: 'espia-pos', clave_externa: 'sp-1' },
      { titulo: 'Anuncio de Otra Marca', tipo: 'alerta', fuente: 'espia-pos', clave_externa: 'sp-2' },
      { titulo: 'Noticia: Rivalia abre sede', tipo: 'noticia', fuente: 'radar-hayai', clave_externa: 'sp-3' },
    ] } })
    const v = (await mk(`/competidores/${comp}`)).body
    assert.deepEqual(v.hallazgos.map((h: any) => [h.titulo, h.fuente]), [['Anuncio nuevo de Rivalia: «Automatiza tu negocio»', 'espia-pos']])
  })

  it('competidores — cruce con keywords y marca en el SERP: por su web y por su Instagram; sin consultar nada nuevo', async () => {
    const antes = extHits.brightdata.length
    const x = await mk(`/competidores/${comp}/keywords`)
    assert.equal(x.status, 200, JSON.stringify(x.body))
    assert.equal(extHits.brightdata.length, antes, 'cruzar no gasta saldo')
    assert.equal(x.body.serp_revisados, 1)
    assert.deepEqual(x.body.apariciones.map((a: any) => [a.keyword, a.posicion]), [['Sistema de citas precio', 2], ['Sistema de citas precio', 3]])
    const k = (await mk(`/keywords/${kwPrecio}`)).body
    assert.deepEqual(k.serp.resultados.map((r: any) => r.competidor?.nombre ?? null), [null, 'Rivalia', 'Rivalia', null])
    // sin web ni Instagram no hay con qué buscarlo
    const solo = (await mk('/competidores', { body: { nombre: 'Sin datos' } })).body.id
    const v = (await mk(`/competidores/${solo}/keywords`)).body
    assert.deepEqual(v.apariciones, [])
    assert.match(v.sin_datos_para_cruzar, /web o el Instagram/)
    assert.equal((await mk(`/competidores/${NOPE}/keywords`)).status, 404)
  })

  // ---------- Parte 5: campañas ----------
  it('campañas: solo lectura — gasto, leads y CPL por campaña y en total, con el filtro de cuenta', async () => {
    const r = await mk('/campanas')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.conectado, r.body.solo_lectura, r.body.dias, r.body.error], [true, true, 30, null])
    assert.deepEqual(r.body.cuentas, [{ id: '111', nombre: 'Cuenta HAYAI', moneda: 'USD' }])
    assert.deepEqual(r.body.campanas.map((c: any) => [c.nombre, c.estado, c.gasto, c.leads, c.cpl]), [['Leads octubre', 'ACTIVE', 30, 6, 5], ['Marca', 'PAUSED', 0, 0, null]])
    assert.deepEqual(r.body.totales, { moneda: 'USD', gasto: 30, leads: 6, cpl: 5 })
    assert.ok(extHits.meta.every((u) => !/method=|status=PAUSED/.test(u)), 'solo consultas de lectura')
    assert.equal((await mk('/campanas?dias=7')).body.dias, 7)
    assert.equal((await mk('/campanas?dias=3')).status, 400)
    assert.equal((await mk('/campanas?dias=400')).status, 400)
    assert.equal((await mk('/campanas?cuenta=999')).body.campanas.length, 0, 'una cuenta que no está configurada no se consulta')
  })

  it('campañas: sin POST/PATCH (nada crea, edita ni pausa campañas) y si Meta falla lo dice sin tumbar la pantalla', async () => {
    for (const [method, body] of [['POST', { nombre: 'x' }], ['PATCH', { estado: 'PAUSED' }], ['DELETE', undefined]] as const) {
      const r = await fetch(`${ROOT}/api/v1/marketing/campanas`, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      assert.ok([404, 405].includes(r.status), `${method} ${r.status}`)
    }
    extDown.meta = true
    try {
      const r = await mk('/campanas')
      assert.equal(r.status, 200)
      assert.deepEqual([r.body.conectado, r.body.campanas.length, r.body.totales], [true, 0, null])
      assert.match(r.body.error, /Meta/)
    } finally {
      extDown.meta = false
    }
  })

  it('campañas sin credenciales: «Pendiente de conexión» con el motivo en una línea', async () => {
    const { metaCampanasListo, metaCampanasMotivo } = await import('../src/marketingExterno.ts')
    const t = process.env.META_ADS_TOKEN
    const c = process.env.META_AD_ACCOUNT_IDS
    process.env.META_ADS_TOKEN = 'x'
    process.env.META_AD_ACCOUNT_IDS = ''
    try {
      assert.equal(metaCampanasListo(), false)
      assert.match(metaCampanasMotivo()!, /META_AD_ACCOUNT_IDS/)
      delete process.env.META_ADS_TOKEN
      assert.match(metaCampanasMotivo()!, /META_ADS_TOKEN/)
    } finally {
      if (t) process.env.META_ADS_TOKEN = t
      else delete process.env.META_ADS_TOKEN
      if (c !== undefined) process.env.META_AD_ACCOUNT_IDS = c
    }
  })

  // ---------- permisos, web y MCP ----------
  it('permisos: sin llave 401; lectura sí, escribir con llave de solo lectura 403', async () => {
    assert.equal((await mk('/keywords', { key: null })).status, 401)
    assert.equal((await mk('/keywords', { key: KEY_R })).status, 200)
    for (const [path, body] of [['/keywords', { texto: 'nope' }], ['/competidores', { nombre: 'Nope' }], ['/contenidos', { titulo: 'Nope' }]] as const) assert.equal((await mk(path, { key: KEY_R, body })).status, 403, path)
  })

  it('web (sesión): las mismas rutas bajo /api/marketing/…', async () => {
    const w = (path: string, init: RequestInit = {}) => fetch(`${ROOT}/api/marketing${path}`, { ...init, headers: { cookie, 'x-csrf-token': 'x', 'content-type': 'application/json', ...(init.headers as object) } })
    assert.equal((await fetch(`${ROOT}/api/marketing/keywords`)).status, 401)
    const l = await w('/keywords?intencion=local')
    assert.equal(l.status, 200)
    assert.equal(((await l.json()) as any).data.length, 1)
    const c = await w('/contenidos', { method: 'POST', body: JSON.stringify({ titulo: 'Desde la web' }) })
    assert.equal(c.status, 201)
    const cj = (await c.json()) as any
    assert.equal(cj.responsable.nombre, 'Jorbi')
    const m = await w(`/contenidos/${cj.id}/mover`, { method: 'POST', body: JSON.stringify({ estado: 'publicado' }) })
    assert.equal(m.status, 400)
    assert.equal((await w('/campanas')).status, 200)
    assert.equal((await w('/keywords/investigar?semilla=hola')).status, 200)
    const sp = await w(`/keywords/${kwPrecio}/serp`, { method: 'POST', body: '{}' })
    assert.equal(sp.status, 409)
  })

  it('MCP: las herramientas de marketing llaman a los mismos servicios (y la llave de solo lectura solo ve las de lectura)', async () => {
    const names = ((await rpc('tools/list')).body.result.tools as any[]).map((t) => t.name)
    for (const t of ['hayai_kw_investigar', 'hayai_kw_guardar', 'hayai_kw_listar', 'hayai_kw_ver', 'hayai_kw_actualizar', 'hayai_kw_serp_aviso', 'hayai_kw_serp', 'hayai_kw_idea', 'hayai_kw_contenido', 'hayai_competidores_listar', 'hayai_competidor_ver', 'hayai_competidor_crear', 'hayai_competidor_actualizar', 'hayai_competidor_keywords', 'hayai_contenidos_listar', 'hayai_contenido_ver', 'hayai_contenido_crear', 'hayai_contenido_actualizar', 'hayai_contenido_mover', 'hayai_campanas_ver']) assert.ok(names.includes(t), t)
    const lectura = ((await rpc('tools/list', {}, KEY_R)).body.result.tools as any[]).map((t) => t.name)
    assert.ok(lectura.includes('hayai_kw_serp_aviso') && lectura.includes('hayai_campanas_ver') && lectura.includes('hayai_kw_investigar'))
    assert.ok(!lectura.includes('hayai_kw_serp') && !lectura.includes('hayai_kw_guardar') && !lectura.includes('hayai_contenido_mover'))

    const inv = dato(await tool('hayai_kw_investigar', { semilla: 'agenda digital' }))
    assert.ok(inv.sugerencias.length > 3)
    const g = dato(await tool('hayai_kw_guardar', { items: [{ texto: 'agenda digital precio' }, { texto: 'agenda digital precio' }] }))
    assert.deepEqual([g.creadas, g.duplicadas], [1, 1])
    const id = g.data[0].id
    const sinConfirmar = await tool('hayai_kw_serp', { id })
    assert.equal(sinConfirmar.result.isError, true)
    assert.match(sinConfirmar.result.content[0].text, /consume saldo/)
    assert.equal(dato(await tool('hayai_kw_serp_aviso', { id })).conectado, true)
    const serp = dato(await tool('hayai_kw_serp', { id, confirmar_costo: true }))
    assert.equal(serp.resultados.length, 4)
    const c = dato(await tool('hayai_competidor_crear', { nombre: 'Agenda Rival', web: 'otro.net' }))
    assert.equal(dato(await tool('hayai_competidor_keywords', { id: c.id })).apariciones.length, 2, 'otro.net aparece en los dos SERP consultados')
    const ct = dato(await tool('hayai_kw_contenido', { id }))
    assert.equal(ct.contenido.estado, 'idea')
    const pub = await tool('hayai_contenido_mover', { id: ct.contenido_id, estado: 'publicado' })
    assert.equal(pub.result.isError, true)
    const ok = dato(await tool('hayai_contenido_mover', { id: ct.contenido_id, estado: 'publicado', publicado_en: 'Blog', enlace: 'https://hayai.com.ve/blog/agenda' }))
    assert.equal(ok.estado, 'publicado')
    assert.equal(dato(await tool('hayai_contenidos_listar', { estado: 'publicado' })).data.length, 1)
    assert.equal(dato(await tool('hayai_campanas_ver', { dias: 30 })).totales.leads, 6)
    assert.equal(dato(await tool('hayai_kw_listar', { q: 'agenda' })).meta.total, 1)
    assert.equal(dato(await tool('hayai_competidores_listar', {})).data.length >= 2, true)
  })
})
