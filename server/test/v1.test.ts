// Pruebas de la API v1 (X-API-Key) y del servidor MCP contra el servidor real. Levantan su propio Postgres embebido
// (puerto 54331, directorio temporal que se borra al terminar) y su propio servidor (puerto 3102): no tocan la BD de
// desarrollo ni chocan con api.test.ts. Uso: npm run test:server (como usuario no-root, por el Postgres embebido).
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

type Res = { status: number; body: any; headers: Headers }
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
  return { status: r.status, body: text ? JSON.parse(text) : undefined, headers: r.headers }
}

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

  env = { ...process.env, DATABASE_URL, PORT: String(API_PORT), LOGIN_IP_MAX: '100000', V1_RATE_MAX: '100000', NODE_ENV: 'test' }
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
        icono: 'box',
        cliente: 'Karelys R',
        cliente_id: karelys,
        responsable: 'Leandro',
        estado: 'visita',
        entrega: null,
        archivado: false,
        cliente_archivado: false,
        tareas: { total: 0, completadas: 0 },
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
    assert.equal((await api('/proyectos', { body: { nombre: 'a' } })).status, 400)
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
    assert.deepEqual(lst.body.meta.por_estado, { activo: 1, entrega: 1, visita: 0 })
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
      { ...b.body, id: '<id>' },
      { id: '<id>', titulo: 'Reunión', proyecto_id: p1, proyecto: 'Sistema Karelys', estado: 'pendiente', vence: '2026-10-20', creada_por: 'Leandro' },
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
      id: '<id>', fecha: '2026-10-01', concepto: 'Lovable', monto: 25, categoria: 'Herramientas', ambito: 'general', referencia: null, registrado_por: 'Leandro',
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
    for (const s of ['hayai_interacciones_listar', 'hayai_interaccion_registrar', 'hayai_interaccion_actualizar', 'hayai_pipeline_resumen', 'hayai_notificaciones_listar', 'hayai_notificaciones_marcar_leidas', 'hayai_buscar'])
      assert.ok(names.includes(s), s)
    assert.equal(names.length, 27) // lectura + escritura
    assert.ok(!names.some((x) => /eliminar/.test(x)), 'la llave sin borrado no ve herramientas de borrar')
    const full = (await rpc('tools/list', {}, KEY_D)).body.result.tools
    assert.equal(full.length, 33)
    assert.equal(full.filter((t: any) => /eliminar/.test(t.name) && t.annotations.destructiveHint === true).length, 6)
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
    await assert.rejects(admin.query("UPDATE clients SET pipeline_stage = 'nuevo' WHERE id = $1", [id]), /clients_stage_/)
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
  it('un posible nuevo entra en "nuevo" con 10 %; se puede crear en otra etapa abierta, no en ganado/perdido', async () => {
    const a = await mkPosible('Pipe A')
    assert.equal(a.estado, 'posible')
    assert.equal(a.etapa, 'nuevo')
    assert.equal(a.probabilidad, 10)
    assert.equal(a.valor_ponderado, null, 'sin valor estimado no hay ponderado (null, no 0)')
    const b = await mkPosible('Pipe B', { etapa: 'propuesta', valor_estimado: 1000 })
    assert.equal(b.etapa, 'propuesta')
    assert.equal(b.probabilidad, 50)
    assert.equal(b.valor_ponderado, 500)
    for (const etapa of ['ganado', 'perdido'])
      assert.equal((await api('/clientes', { body: { nombre: 'Pipe X', estado: 'posible', etapa } })).status, 400, etapa)
    assert.equal((await api('/clientes', { body: { nombre: 'Pipe Y', etapa: 'nuevo' } })).status, 400, 'pipeline sin estado posible')
    assert.equal((await api('/clientes', { body: { nombre: 'Pipe Z', valor_estimado: 5 } })).status, 400)
  })

  it('transiciones: cada cambio de etapa deja una entrada automática en la bitácora; mismo valor no duplica', async () => {
    const p = await mkPosible('Pipe C', { valor_estimado: 2000 })
    const move = (body: unknown) => api(`/clientes/${p.id}`, { method: 'PATCH', body })
    const c1 = await move({ etapa: 'contactado' })
    assert.equal(c1.status, 200, JSON.stringify(c1.body))
    assert.equal(c1.body.etapa, 'contactado')
    assert.equal(c1.body.probabilidad, 10, 'cambiar de etapa abierta no pisa la probabilidad que ya había')
    const c2 = await move({ etapa: 'negociacion', probabilidad: 80 })
    assert.equal(c2.body.probabilidad, 80)
    assert.equal(c2.body.valor_ponderado, 1600)
    await move({ etapa: 'negociacion' }) // sin cambio
    const feed = (await api(`/clientes/${p.id}/interacciones?tipo=etapa`)).body.data
    assert.deepEqual(feed.map((e: any) => e.cambio.a).sort(), ['contactado', 'negociacion'])
    assert.ok(feed.every((e: any) => e.automatica === true && e.tipo === 'etapa'))
    assert.equal(feed.find((e: any) => e.cambio.a === 'negociacion').cambio.de, 'contactado')
    assert.equal(feed[0].registrada_por, 'Leandro')
  })

  it('ganar: probabilidad 100, pasa a cliente activo; perder: exige motivo, probabilidad 0; reabrir devuelve la probabilidad de la etapa', async () => {
    const w = await mkPosible('Pipe Gana', { valor_estimado: 800 })
    const won = await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'ganado' } })
    assert.equal(won.status, 200, JSON.stringify(won.body))
    assert.equal(won.body.estado, 'activo')
    assert.equal(won.body.etapa, 'ganado')
    assert.equal(won.body.probabilidad, 100)
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'ganado' } })).status, 409, 'ya es cliente')
    assert.equal((await api(`/clientes/${w.id}`, { method: 'PATCH', body: { etapa: 'perdido', motivo_perdida: 'x' } })).status, 409)

    const l = await mkPosible('Pipe Pierde', { valor_estimado: 800, etapa: 'negociacion', probabilidad: 90 })
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
    const re = await api(`/clientes/${l.id}`, { method: 'PATCH', body: { etapa: 'contactado' } })
    assert.equal(re.status, 200, JSON.stringify(re.body))
    assert.equal(re.body.etapa, 'contactado')
    assert.equal(re.body.probabilidad, 25)
    assert.equal(re.body.motivo_perdida, null)
  })

  it('estado "activo" sobre un posible = ganado; "posible" sobre un cliente = nuevo; estado y etapa contradictorios => 400', async () => {
    const p = await mkPosible('Pipe Estado')
    assert.equal((await api(`/clientes/${p.id}`, { method: 'PATCH', body: { estado: 'activo', etapa: 'nuevo' } })).status, 400)
    const a = await api(`/clientes/${p.id}`, { method: 'PATCH', body: { estado: 'activo' } })
    assert.equal(a.body.etapa, 'ganado')
    assert.equal(a.body.probabilidad, 100)
    const old = (await api('/clientes', { body: { nombre: 'Pipe Viejo' } })).body
    assert.equal(old.etapa, null)
    const b = await api(`/clientes/${old.id}`, { method: 'PATCH', body: { estado: 'posible' } })
    assert.equal(b.body.etapa, 'nuevo')
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
    assert.deepEqual(before.etapas.map((e: any) => e.etapa), ['nuevo', 'contactado', 'propuesta', 'negociacion'])
    const prop = before.etapas.find((e: any) => e.etapa === 'propuesta')
    const a = await mkPosible('Pipe Resumen A', { etapa: 'propuesta', valor_estimado: 1000 }) // 50 % => 500
    const b = await mkPosible('Pipe Resumen B', { etapa: 'propuesta', valor_estimado: 333.33, probabilidad: 33 }) // 109.9989 => 110
    await mkPosible('Pipe Resumen C', { etapa: 'propuesta' }) // sin valor
    const after = (await api('/pipeline')).body
    const p2 = after.etapas.find((e: any) => e.etapa === 'propuesta')
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
    await api(`/clientes/${b.id}`, { method: 'PATCH', body: { etapa: 'negociacion' } })
    assert.ok((await api('/pipeline')).body.frios.some((f: any) => f.id === b.id))
  })

  it('filtro etapa en /clientes y validación', async () => {
    const r = await api('/clientes?etapa=propuesta&per_page=100')
    assert.equal(r.status, 200)
    assert.ok(r.body.data.length >= 3 && r.body.data.every((c: any) => c.etapa === 'propuesta'))
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
    await api(`/clientes/${p.id}`, { method: 'PATCH', body: { etapa: 'contactado' } })
    const e = (await api(`/clientes/${p.id}/interacciones?tipo=etapa`)).body.data[0]
    assert.equal(e.automatica, true)
    assert.equal(e.resumen, 'Nuevo → Contactado')
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
    assert.equal(created.etapa, 'nuevo')
    assert.equal(created.origen, 'meta_ads')
    assert.equal(created.seguimiento_vencido, true)
    const upd = data(await tool('hayai_cliente_actualizar', { id: created.id, etapa: 'propuesta' }))
    assert.equal(upd.etapa, 'propuesta')
    assert.equal(upd.probabilidad, 10)
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
    assert.equal(p.stage, 'nuevo')
    const r = await web(`/clients/${p.id}/ficha`, {
      method: 'PATCH',
      body: { phone: '0414-7778899', email: 'WEB@crm.com', contactName: 'Ana', tags: ['Nuevo', 'nuevo'], source: 'meta_ads', stage: 'contactado', estValue: 900, probability: 30, expectedClose: isoDay(15), nextAction: 'Llamar', nextActionDate: isoDay(1) },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.phone, '0414-7778899')
    assert.equal(r.body.email, 'web@crm.com')
    assert.deepEqual(r.body.tags, ['nuevo'])
    assert.equal(r.body.stage, 'contactado')
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
