// Pruebas de la API contra el servidor real. Levantan su propio Postgres embebido (puerto 54330, directorio
// temporal que se borra al terminar) y su propio servidor (puerto 3101): no tocan la BD de desarrollo.
// Uso: npm run test:server
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const root = resolve(import.meta.dirname, '../..')
const PG_PORT = 54330
const API_PORT = 3101
const DATABASE_URL = `postgres://hayai:hayai@localhost:${PG_PORT}/hayai`
const BASE = `http://localhost:${API_PORT}/api`
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let embedded: EmbeddedPostgres
let dataDir: string
let server: ChildProcess
let admin: pg.Client

type Res = { status: number; body: any; full?: any; cookie?: string; setCookie?: string }

const stripStamp = (x: any): any =>
  Array.isArray(x) ? x.map(stripStamp) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'updatedAt').map(([k, v]) => [k, stripStamp(v)])) : x

async function call(path: string, o: { method?: string; body?: unknown; raw?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers }
  if (o.cookie) headers.cookie = o.cookie
  let body: string | undefined
  if (o.raw !== undefined) body = o.raw
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body)
    headers['content-type'] ??= 'application/json'
  }
  const r = await fetch(BASE + path, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body })
  const text = await r.text()
  const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('hayai_sid='))
  return {
    status: r.status,
    // updatedAt = versión del registro (cambia en cada escritura): se quita de body para comparar formas exactas; `full` la conserva.
    body: stripStamp(text ? JSON.parse(text) : undefined),
    full: text ? JSON.parse(text) : undefined,
    setCookie,
    cookie: setCookie?.split(';')[0],
  }
}

/** Reemplaza cualquier uuid por '<uuid>' para comparar formas exactas. */
const shape = (x: any): any =>
  Array.isArray(x)
    ? x.map(shape)
    : x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shape(v)]))
      : typeof x === 'string' && UUID.test(x)
        ? '<uuid>'
        : typeof x === 'string' && ISO_TS.test(x)
          ? '<ts>'
          : x

/** Campos del CRM que trae todo cliente de la web (ficha vacía, sin pipeline); un cliente potencial los pisa con su etapa. */
const CRM = {
  createdAt: '<ts>',
  phone: null, email: null, contactName: null, contactRole: null, address: null, notes: null, tags: [], source: null, utmSource: null,
  stage: null, estValue: null, probability: null, expectedClose: null, lostReason: null, stageChangedAt: null,
  nextAction: null, nextActionDate: null, lastContactAt: null, delFeed: null, socials: [], systemLinks: [], hasLogo: false, implementationDate: null,
}
const CRM_KEYS = Object.keys(CRM)

const login = (name: string, pin = '000000') => call('/auth/login', { body: { name, pin } })

async function sessionFor(name: string, pin = '000000') {
  const r = await login(name, pin)
  assert.equal(r.status, 200, `login ${name}: ${JSON.stringify(r.body)}`)
  return r.cookie!
}

// ---------- multitenant (039): fixture de pruebas ----------
// HAYAI es el tenant de todas las pruebas de siempre: cada llamada a la web (/api, no /api/v1 ni el webhook) lleva X-Tenant-Id de HAYAI
// salvo que la prueba mande otro (o null para no mandarlo). Las pruebas de aislamiento entre tenants mandan el suyo.
let HAYAI = ''
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input)
  const h = new Headers(init.headers)
  if (HAYAI && /\/api\//.test(url) && !/\/api\/(v1|webhooks)/.test(url)) {
    if (!h.has('x-tenant-id')) h.set('x-tenant-id', HAYAI)
    else if (h.get('x-tenant-id') === 'null') h.delete('x-tenant-id')
  }
  return realFetch(input, { ...init, headers: h })
}) as typeof fetch
/** Inserts directos con el cliente admin (sin pasar por la API): en la BD de PRUEBAS tenant_id cae en HAYAI por defecto. La app no depende
 *  de esto: db.ts rechaza toda consulta de la app sobre una tabla de negocio que no nombre tenant_id. */
async function tenantFixture(db: pg.Client) {
  HAYAI = (await db.query("SELECT id FROM tenants WHERE slug = 'hayai'")).rows[0].id
  const { rows } = await db.query("SELECT table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema = 'public' AND table_name NOT IN ('user_tenants')")
  for (const r of rows) await db.query(`ALTER TABLE ${r.table_name} ALTER COLUMN tenant_id SET DEFAULT '${HAYAI}'`)
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hayai-test-pg-'))
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

  const env = { ...process.env, DATABASE_URL, PORT: String(API_PORT), LOGIN_IP_MAX: '100000', NODE_ENV: 'test' }
  const mig = spawnSync(process.execPath, ['server/db/migrate.mjs'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(mig.status, 0, mig.stderr + mig.stdout)

  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/auth/me')).status === 401) break
    } catch {
      /* aún arrancando */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  admin = new pg.Client({ connectionString: DATABASE_URL })
  await admin.connect()
  await tenantFixture(admin)
})

after(async () => {
  await admin?.end().catch(() => {})
  server?.kill()
  await embedded?.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
})

describe('semilla', () => {
  it('arranca con solo los 3 socios y sin datos de demostración', async () => {
    const q = async (t: string) => (await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n
    assert.equal(await q('users'), 3)
    for (const t of ['clients', 'client_items', 'payments', 'projects', 'expenses', 'tasks']) assert.equal(await q(t), 0, t)
    const { rows } = await admin.query('SELECT name, avatar, role, must_change_pin, active, pin_hash FROM users ORDER BY name')
    assert.deepEqual(
      rows.map((r) => [r.name, r.avatar, r.role, r.must_change_pin, r.active]),
      [
        ['Elis', 'nova', 'ADMIN', true, true],
        ['Jorbi', 'orion', 'ADMIN', true, true],
        ['Leandro', 'vega', 'ADMIN', true, true],
      ],
    )
    for (const r of rows) assert.match(r.pin_hash, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/)
    assert.notEqual(rows[0].pin_hash, rows[1].pin_hash) // sal por usuario
  })
})

describe('auth', () => {
  it('sin cookie => 401', async () => {
    for (const p of ['/auth/me', '/users', '/clients', '/projects', '/expenses', '/tasks']) {
      const r = await call(p)
      assert.equal(r.status, 401, p)
      assert.equal(typeof r.body.error, 'string')
    }
  })

  it('lookup: existe (sin distinguir mayúsculas) y 404 si no', async () => {
    const ok = await call('/auth/lookup', { body: { name: 'leandro' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { name: 'Leandro', avatar: 'vega' })
    const no = await call('/auth/lookup', { body: { name: 'Nadie' } })
    assert.equal(no.status, 404)
    assert.equal(typeof no.body.error, 'string')
  })

  it('login: PIN malo => 401 genérico; formato inválido => 400; usuario inexistente => mismo 401', async () => {
    const bad = await login('Elis', '111111')
    assert.equal(bad.status, 401)
    const ghost = await login('Nadie', '111111')
    assert.equal(ghost.status, 401)
    assert.equal(bad.body.error, ghost.body.error)
    assert.equal((await login('Elis', '123')).status, 400)
    assert.equal((await login('Elis', 'abcdef')).status, 400)
  })

  it('login ok con 000000 => mustChangePin=true, cookie httpOnly/Lax/Path=/, sin pin_hash', async () => {
    const r = await login('Elis')
    assert.equal(r.status, 200)
    assert.deepEqual(shape(r.body), { id: '<uuid>', name: 'Elis', avatar: 'nova', role: 'ADMIN', mustChangePin: true, tenants: [{ id: '<uuid>', name: 'HAYAI', slug: 'hayai', modules: ['hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'tablero', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'] }] })
    assert.match(r.setCookie!, /HttpOnly/i)
    assert.match(r.setCookie!, /SameSite=Lax/i)
    assert.match(r.setCookie!, /Path=\//)
    assert.match(r.setCookie!, /Expires=|Max-Age=/i)
    assert.ok(!JSON.stringify(r.body).includes('pin'))
    // en BD solo vive el hash del token, nunca el token
    const token = r.cookie!.split('=')[1]
    const { rows } = await admin.query('SELECT token_hash FROM sessions')
    assert.ok(rows.length > 0 && rows.every((x) => x.token_hash !== token && /^[0-9a-f]{64}$/.test(x.token_hash)))
  })

  it('con mustChangePin: /auth/me ok y todos los datos => 403 pin_change_required', async () => {
    const cookie = await sessionFor('Elis')
    assert.equal((await call('/auth/me', { cookie })).body.mustChangePin, true)
    for (const p of ['/users', '/clients', '/projects', '/expenses', '/tasks']) {
      const r = await call(p, { cookie })
      assert.equal(r.status, 403, p)
      assert.deepEqual(r.body, { error: 'pin_change_required' })
    }
    const post = await call('/clients', { cookie, body: { name: 'X' } })
    assert.equal(post.status, 403)
  })

  it('change-pin: rechaza 000000, PIN corto, no numérico, PIN actual incorrecto; exige sesión', async () => {
    const cookie = await sessionFor('Elis')
    assert.equal((await call('/auth/change-pin', { body: { currentPin: '000000', newPin: '482913' } })).status, 401)
    assert.equal((await call('/auth/change-pin', { cookie, body: { currentPin: '000000', newPin: '000000' } })).status, 400)
    assert.equal((await call('/auth/change-pin', { cookie, body: { currentPin: '000000', newPin: '12345' } })).status, 400)
    assert.equal((await call('/auth/change-pin', { cookie, body: { currentPin: '000000', newPin: '12345a' } })).status, 400)
    assert.equal((await call('/auth/change-pin', { cookie, body: { currentPin: '999999', newPin: '482913' } })).status, 403)
    // sigue pendiente de cambiar
    assert.equal((await call('/auth/me', { cookie })).body.mustChangePin, true)
  })

  it('change-pin ok: mustChangePin=false, revoca otras sesiones, rechaza PIN igual al actual', async () => {
    const a = await sessionFor('Elis')
    const b = await sessionFor('Elis') // otra sesión del mismo usuario
    const r = await call('/auth/change-pin', { cookie: a, body: { currentPin: '000000', newPin: '482913' } })
    assert.equal(r.status, 200)
    assert.deepEqual(shape(r.body), { id: '<uuid>', name: 'Elis', avatar: 'nova', role: 'ADMIN', mustChangePin: false, tenants: [{ id: '<uuid>', name: 'HAYAI', slug: 'hayai', modules: ['hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'tablero', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'] }] })
    assert.equal((await call('/auth/me', { cookie: b })).status, 401) // la otra sesión murió
    assert.equal((await call('/auth/me', { cookie: a })).body.mustChangePin, false) // la actual sigue
    assert.equal((await call('/auth/change-pin', { cookie: a, body: { currentPin: '482913', newPin: '482913' } })).status, 400)
    // el PIN viejo ya no sirve y el nuevo sí
    assert.equal((await login('Elis', '000000')).status, 401)
    assert.equal((await login('Elis', '482913')).body.mustChangePin, false)
  })

  it('anti fuerza bruta: 5 fallos => 423 con segundos; ni el PIN correcto entra mientras dura', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await login('Jorbi', '111111')).status, 401)
    const locked = await login('Jorbi', '111111')
    assert.equal(locked.status, 423)
    assert.ok(locked.body.retryAfter > 0 && locked.body.retryAfter <= 900)
    assert.equal(typeof locked.body.error, 'string')
    const stillLocked = await login('Jorbi', '000000')
    assert.equal(stillLocked.status, 423)
    // al vencer el bloqueo vuelve a entrar y el contador queda en 0
    await admin.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE name = 'Jorbi'")
    assert.equal((await login('Jorbi', '000000')).status, 200)
    const { rows } = await admin.query("SELECT failed_attempts, locked_until FROM users WHERE name = 'Jorbi'")
    assert.deepEqual(rows[0], { failed_attempts: 0, locked_until: null })
  })

  it('un login correcto resetea el contador de fallos', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await login('Leandro', '111111')).status, 401)
    assert.equal((await login('Leandro')).status, 200)
    for (let i = 0; i < 4; i++) assert.equal((await login('Leandro', '111111')).status, 401)
  })

  it('cabeceras de seguridad', async () => {
    const r = await fetch(BASE + '/auth/me')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('x-frame-options'), 'DENY')
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.ok(r.headers.get('referrer-policy'))
    assert.equal(r.headers.get('x-powered-by'), null)
  })

  it('anti-CSRF: Origin ajeno => 403, Content-Type no JSON => 415, body > 100kb => 413, JSON roto => 400', async () => {
    const evil = await call('/auth/login', { body: { name: 'Elis', pin: '482913' }, headers: { origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    const same = await call('/auth/login', { body: { name: 'Elis', pin: '482913' }, headers: { origin: `http://localhost:${API_PORT}` } })
    assert.equal(same.status, 200)
    const plain = await call('/auth/login', { raw: '{"name":"Elis","pin":"482913"}', headers: { 'content-type': 'text/plain' } })
    assert.equal(plain.status, 415)
    const big = await call('/auth/lookup', { body: { name: 'x'.repeat(200_000) } })
    assert.equal(big.status, 413)
    const broken = await call('/auth/login', { raw: '{nope', headers: { 'content-type': 'application/json' } })
    assert.equal(broken.status, 400)
  })
})

describe('datos', () => {
  let cookie: string
  let clientId: string
  let projectId: string

  before(async () => {
    cookie = await sessionFor('Elis', '482913')
  })

  it('arrancan vacíos y /users devuelve solo {id,name,avatar} de los activos', async () => {
    for (const p of ['/clients', '/projects', '/expenses', '/tasks']) {
      const r = await call(p, { cookie })
      assert.equal(r.status, 200, p)
      assert.deepEqual(r.body, [], p)
    }
    const users = await call('/users', { cookie })
    assert.deepEqual(shape(users.body).map((u: any) => Object.keys(u).sort()), [
      ['avatar', 'id', 'name'],
      ['avatar', 'id', 'name'],
      ['avatar', 'id', 'name'],
    ])
    assert.deepEqual(users.body.map((u: any) => u.name).sort(), ['Elis', 'Jorbi', 'Leandro'])
  })

  it('POST /clients: 201 con la forma exacta, inicial cobrada + pagos pendientes, numbers y fechas string', async () => {
    const r = await call('/clients', {
      cookie,
      body: {
        name: '  Acme SA ',
        avatar: 'orion',
        initialDate: '2026-02-10',
        items: [
          { concept: 'Landing', amount: 1500 },
          { concept: 'Hosting', amount: 250.5 },
        ],
        charges: [
          { date: '2026-04-01', amount: 300, concept: 'Cuota 2' },
          { date: '2026-03-01', amount: 300.25, concept: 'Cuota 1' },
        ],
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    clientId = r.body.id
    assert.deepEqual(shape(r.body), {
      id: '<uuid>',
      name: 'Acme SA',
      avatar: 'orion',
      prospect: false,
      archived: false,
      ...CRM,
      items: [
        { id: '<uuid>', concept: 'Landing', amount: 1500 },
        { id: '<uuid>', concept: 'Hosting', amount: 250.5 },
      ],
      movements: [
        { id: '<uuid>', date: '2026-02-10', concept: 'Inicial', amount: 1750.5, kind: 'inicial', status: 'cobrado', series: null },
        { id: '<uuid>', date: '2026-03-01', concept: 'Cuota 1', amount: 300.25, kind: 'pago', status: 'pendiente', series: null },
        { id: '<uuid>', date: '2026-04-01', concept: 'Cuota 2', amount: 300, kind: 'pago', status: 'pendiente', series: null },
      ],
    })
    const list = await call('/clients', { cookie })
    assert.deepEqual(list.body, [r.body]) // GET igual que el POST
    const { rows } = await admin.query('SELECT created_by FROM clients')
    assert.equal(rows[0].created_by, (await call('/auth/me', { cookie })).body.id)
  })

  it('POST /clients sin items => sin movimiento inicial; validaciones => 400 legible', async () => {
    const r = await call('/clients', { cookie, body: { name: 'Sin items', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    assert.equal(r.status, 201)
    assert.deepEqual(shape(r.body), { id: '<uuid>', name: 'Sin items', avatar: 'x', prospect: false, archived: false, ...CRM, items: [], movements: [] })
    const bad = [
      { name: '', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] },
      { name: 'x'.repeat(81), avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] },
      { name: 'ok', avatar: 'x', initialDate: '2026-02-30', items: [], charges: [] },
      { name: 'ok', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'a', amount: 1.234 }], charges: [] },
      { name: 'ok', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'a', amount: -5 }], charges: [] },
      { name: 'ok', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'a', amount: 2_000_000_000 }], charges: [] },
      { name: 'ok', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'a', amount: '10' }], charges: [] },
      { name: 'ok' },
    ]
    for (const body of bad) {
      const b = await call('/clients', { cookie, body })
      assert.equal(b.status, 400, JSON.stringify(body))
      assert.equal(typeof b.body.error, 'string')
    }
    assert.equal((await call('/clients', { cookie })).body.length, 2) // los inválidos no dejaron nada
  })

  it('pago mensual recurrente: serie de 12 desde el 31 sin arrastrar el recorte, series_id común, GET igual', async () => {
    const base = { name: 'Serie', avatar: 'x', initialDate: '2026-01-01', items: [] }
    const r = await call('/clients', { cookie, body: { ...base, charges: [{ date: '2026-01-31', amount: 100, concept: 'Mensual', repeatMonths: 12 }] } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const m = r.body.movements
    assert.deepEqual(
      m.map((x: any) => x.date),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'],
    )
    assert.deepEqual(m.map((x: any) => x.series.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.ok(m.every((x: any) => x.series.total === 12 && x.series.id === m[0].series.id && x.kind === 'pago' && x.status === 'pendiente' && x.amount === 100))
    assert.match(m[0].series.id, UUID)
    assert.deepEqual(Object.keys(m[0]).sort(), ['amount', 'concept', 'date', 'id', 'kind', 'series', 'status'])
    const list = await call('/clients', { cookie })
    assert.deepEqual(list.body.find((c: any) => c.id === r.body.id), r.body)
  })

  it('pago mensual recurrente: bisiesto, cobros mixtos y series distintas', async () => {
    const base = { name: 'Mixto', avatar: 'x', initialDate: '2028-01-01', items: [] }
    const leap = await call('/clients', { cookie, body: { ...base, charges: [{ date: '2028-01-31', amount: 10, concept: 'L', repeatMonths: 3 }] } })
    assert.deepEqual(leap.body.movements.map((x: any) => x.date), ['2028-01-31', '2028-02-29', '2028-03-31'])

    const r = await call('/clients', {
      cookie,
      body: {
        ...base,
        charges: [
          { date: '2026-05-10', amount: 5, concept: 'Suelto' },
          { date: '2026-05-15', amount: 20, concept: 'A', repeatMonths: 2 },
          { date: '2026-05-20', amount: 30, concept: 'B', repeatMonths: 3 },
        ],
      },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const by = (c: string) => r.body.movements.filter((x: any) => x.concept === c)
    assert.equal(by('Suelto')[0].series, null)
    const [a, b] = [by('A'), by('B')]
    assert.equal(a.length, 2)
    assert.equal(b.length, 3)
    assert.notEqual(a[0].series.id, b[0].series.id)
    assert.deepEqual(b.map((x: any) => x.date), ['2026-05-20', '2026-06-20', '2026-07-20'])
    assert.deepEqual(r.body.movements.map((x: any) => x.date), [...r.body.movements.map((x: any) => x.date)].sort())
    const { rows } = await admin.query('SELECT count(DISTINCT series_id)::int AS n FROM payments WHERE client_id = $1', [r.body.id])
    assert.equal(rows[0].n, 2)
  })

  it('repeatMonths inválido (1, 37, 2.5, "x") => 400 legible y no deja nada', async () => {
    const before = (await call('/clients', { cookie })).body.length
    for (const repeatMonths of [1, 37, 2.5, 'x']) {
      const b = await call('/clients', {
        cookie,
        body: { name: 'Mal', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [{ date: '2026-01-31', amount: 1, concept: 'c', repeatMonths }] },
      })
      assert.equal(b.status, 400, String(repeatMonths))
      assert.match(b.body.error, /repeatMonths/)
    }
    assert.equal((await call('/clients', { cookie })).body.length, before)
  })

  it('POST /projects: owner por NOMBRE, forma exacta; owner/cliente inexistente => 404; icono inválido => 400', async () => {
    const r = await call('/projects', {
      cookie,
      body: { name: 'Sitio Acme', icon: 'globe', clientId, owner: 'leandro', status: 'activo', due: '2026-05-01' },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    projectId = r.body.id
    assert.deepEqual(shape(r.body), {
      id: '<uuid>',
      name: 'Sitio Acme',
      icon: 'globe',
      owner: 'Leandro',
      client: 'Acme SA',
      clientId: '<uuid>',
      status: 'activo',
      due: '2026-05-01',
      archived: false,
      clientArchived: false,
      description: null,
    })
    const noDue = await call('/projects', { cookie, body: { name: 'Sin fecha', icon: 'code', clientId, owner: 'Elis', status: 'planeacion', due: null } })
    assert.equal(noDue.status, 201)
    assert.equal(noDue.body.due, null)
    const base = { name: 'P', icon: 'globe', clientId, owner: 'Elis', status: 'activo', due: null }
    assert.equal((await call('/projects', { cookie, body: { ...base, owner: 'Fantasma' } })).status, 404)
    assert.equal((await call('/projects', { cookie, body: { ...base, clientId: '11111111-1111-4111-8111-111111111111' } })).status, 404)
    assert.equal((await call('/projects', { cookie, body: { ...base, icon: 'rocket' } })).status, 400)
    assert.equal((await call('/projects', { cookie, body: { ...base, status: 'otro' } })).status, 400)
    assert.equal((await call('/projects', { cookie, body: { ...base, clientId: 'no-uuid' } })).status, 400)
    const list = await call('/projects', { cookie })
    assert.equal(list.body.length, 2)
    assert.deepEqual(list.body[0], r.body)
  })

  it('POST /expenses: general/cliente/proyecto con ref y refId; cliente sin refId => 400', async () => {
    const base = { date: '2026-03-15', concept: 'Licencia', amount: 49.99, category: 'Herramientas' }
    const g = await call('/expenses', { cookie, body: { ...base, scope: 'general' } })
    assert.equal(g.status, 201, JSON.stringify(g.body))
    assert.deepEqual(shape(g.body), {
      id: '<uuid>', date: '2026-03-15', concept: 'Licencia', amount: 49.99, category: 'Herramientas',
      scope: 'general', ref: null, refId: null, owner: 'Elis',
    })
    const c = await call('/expenses', { cookie, body: { ...base, scope: 'cliente', refId: clientId } })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    assert.deepEqual(c.body, { ...c.body, scope: 'cliente', ref: 'Acme SA', refId: clientId, owner: 'Elis' })
    const p = await call('/expenses', { cookie, body: { ...base, scope: 'proyecto', refId: projectId } })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.deepEqual(shape(p.body), {
      id: '<uuid>', date: '2026-03-15', concept: 'Licencia', amount: 49.99, category: 'Herramientas',
      scope: 'proyecto', ref: 'Sitio Acme', refId: '<uuid>', owner: 'Elis',
    })
    assert.equal(p.body.refId, projectId)

    const noRef = await call('/expenses', { cookie, body: { ...base, scope: 'cliente' } })
    assert.equal(noRef.status, 400)
    assert.match(noRef.body.error, /refId/)
    assert.equal((await call('/expenses', { cookie, body: { ...base, scope: 'proyecto', refId: null } })).status, 400)
    assert.equal((await call('/expenses', { cookie, body: { ...base, scope: 'cliente', refId: '11111111-1111-4111-8111-111111111111' } })).status, 404)
    assert.equal((await call('/expenses', { cookie, body: { ...base, scope: 'general', category: 'Café' } })).status, 400)
    assert.equal((await call('/expenses', { cookie, body: { ...base, scope: 'general', amount: 0 } })).status, 400)
    // status ya no existe: se ignora, no es error ni aparece en la respuesta ni en la lista
    const legacy = await call('/expenses', { cookie, body: { ...base, scope: 'general', status: 'pagado' } })
    assert.equal(legacy.status, 201)
    assert.ok(!('status' in legacy.body))
    await admin.query('DELETE FROM expenses WHERE id = $1', [legacy.body.id])

    const list = await call('/expenses', { cookie })
    assert.equal(list.body.length, 3)
    for (const e of list.body) assert.deepEqual(Object.keys(e), ['id', 'date', 'concept', 'amount', 'category', 'scope', 'ref', 'refId', 'owner'])
    assert.equal(typeof list.body[0].amount, 'number')
  })

  it('tareas: crear, listar, marcar/desmarcar (done_at coherente), borrar, 404', async () => {
    const t = await call('/tasks', { cookie, body: { projectId, title: 'Diseñar home' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.deepEqual(shape(t.body), { id: '<uuid>', projectId: '<uuid>', title: 'Diseñar home', done: false, due: null, owner: 'Elis', hidden: false, milestoneId: null, assigneeId: null, responsable: 'Leandro', asignada: false })
    assert.equal(t.body.projectId, projectId)
    assert.deepEqual((await call('/tasks', { cookie })).body, [t.body])

    const done = await call(`/tasks/${t.body.id}`, { cookie, method: 'PATCH', body: { done: true } })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { ...t.body, done: true })
    assert.equal((await admin.query('SELECT done_at IS NOT NULL AS ok FROM tasks')).rows[0].ok, true)
    const undone = await call(`/tasks/${t.body.id}`, { cookie, method: 'PATCH', body: { done: false } })
    assert.deepEqual(undone.body, t.body)
    assert.equal((await admin.query('SELECT done_at IS NULL AS ok FROM tasks')).rows[0].ok, true)

    assert.equal((await call(`/tasks/${t.body.id}`, { cookie, method: 'PATCH', body: { done: 'si' } })).status, 400)
    assert.equal((await call('/tasks/no-uuid', { cookie, method: 'PATCH', body: { done: true } })).status, 400)
    assert.equal((await call('/tasks/11111111-1111-4111-8111-111111111111', { cookie, method: 'PATCH', body: { done: true } })).status, 404)
    assert.equal((await call('/tasks', { cookie, body: { projectId: '11111111-1111-4111-8111-111111111111', title: 'x' } })).status, 404)
    assert.equal((await call('/tasks', { cookie, body: { projectId, title: '   ' } })).status, 400)

    const del = await fetch(`${BASE}/tasks/${t.body.id}`, { method: 'DELETE', headers: { cookie } })
    assert.equal(del.status, 204)
    assert.equal((await call(`/tasks/${t.body.id}`, { cookie, method: 'DELETE' })).status, 404)
    assert.deepEqual((await call('/tasks', { cookie })).body, [])
  })

  const NOPE = '11111111-1111-4111-8111-111111111111'

  it('editar cliente y cuotas: flujo completo (fechas pasadas, inicial, cuota suelta, serie, cobrar, editar, borrar)', async () => {
    const keys = ['archived', 'avatar', 'id', 'items', 'movements', 'name', 'prospect', ...CRM_KEYS].sort()
    const created = await call('/clients', {
      cookie,
      body: {
        name: 'Flujo', avatar: 'x', initialDate: '2020-01-15',
        items: [{ concept: 'A', amount: 100 }],
        charges: [{ date: '2020-02-01', amount: 50, concept: 'Pasada' }],
      },
    })
    assert.equal(created.status, 201)
    const id = created.body.id as string

    // PATCH /clients/:id
    const ren = await call(`/clients/${id}`, { cookie, method: 'PATCH', body: { name: ' Flujo 2 ' } })
    assert.equal(ren.status, 200, JSON.stringify(ren.body))
    assert.deepEqual(Object.keys(ren.body).sort(), keys)
    assert.equal(ren.body.name, 'Flujo 2')
    assert.equal(ren.body.avatar, 'x')
    assert.equal((await call(`/clients/${id}`, { cookie, method: 'PATCH', body: { avatar: 'y' } })).body.avatar, 'y')

    // PUT /clients/:id/initial: reemplaza items, monto y fecha de la inicial (pasada)
    const init = await call(`/clients/${id}/initial`, {
      cookie, method: 'PUT',
      body: { date: '2019-12-01', items: [{ concept: 'Uno', amount: 10.5 }, { concept: 'Dos', amount: 4.25 }, { concept: 'Tres', amount: 1 }] },
    })
    assert.equal(init.status, 200, JSON.stringify(init.body))
    assert.deepEqual(init.body.items.map((i: any) => [i.concept, i.amount]), [['Uno', 10.5], ['Dos', 4.25], ['Tres', 1]]) // orden enviado
    const ini = init.body.movements.find((m: any) => m.kind === 'inicial')
    assert.deepEqual(shape(ini), { id: '<uuid>', date: '2019-12-01', concept: 'Inicial', amount: 15.75, kind: 'inicial', status: 'cobrado', series: null })
    assert.equal(init.body.movements.length, 2) // inicial + la cuota pasada
    // se actualiza la misma fila (no se recrea)
    const again = await call(`/clients/${id}/initial`, { cookie, method: 'PUT', body: { date: '2019-12-02', items: [{ concept: 'Solo', amount: 2 }] } })
    const ini2 = again.body.movements.find((m: any) => m.kind === 'inicial')
    assert.deepEqual([ini2.id, ini2.date, ini2.amount], [ini.id, '2019-12-02', 2])
    assert.equal(again.body.items.length, 1)

    // POST /clients/:id/payments: suelta cobrada con fecha pasada; por defecto pendiente
    const one = await call(`/clients/${id}/payments`, { cookie, body: { date: '2018-06-30', amount: 75, concept: 'Extra', status: 'cobrado' } })
    assert.equal(one.status, 201, JSON.stringify(one.body))
    assert.deepEqual(shape(one.body.movements.find((m: any) => m.concept === 'Extra')), {
      id: '<uuid>', date: '2018-06-30', concept: 'Extra', amount: 75, kind: 'pago', status: 'cobrado', series: null,
    })
    const def = await call(`/clients/${id}/payments`, { cookie, body: { date: '2031-01-01', amount: 5, concept: 'Futura' } })
    assert.equal(def.status, 201)
    assert.equal(def.body.movements.find((m: any) => m.concept === 'Futura').status, 'pendiente')

    // serie: 3 cuotas pendientes, mismo día recortado a fin de mes; con status cobrado => 400
    const ser = await call(`/clients/${id}/payments`, { cookie, body: { date: '2026-01-31', amount: 20, concept: 'Mensual', repeatMonths: 3 } })
    assert.equal(ser.status, 201, JSON.stringify(ser.body))
    const cuotas = ser.body.movements.filter((m: any) => m.concept === 'Mensual')
    assert.deepEqual(cuotas.map((m: any) => m.date), ['2026-01-31', '2026-02-28', '2026-03-31'])
    assert.ok(cuotas.every((m: any) => m.status === 'pendiente' && m.series.total === 3 && m.series.id === cuotas[0].series.id))
    assert.deepEqual(cuotas.map((m: any) => m.series.index), [1, 2, 3])
    const bad = await call(`/clients/${id}/payments`, { cookie, body: { date: '2026-01-31', amount: 20, concept: 'M', repeatMonths: 3, status: 'cobrado' } })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /recurrente/)
    assert.equal(ser.body.movements.length, 7) // inicial, Pasada, Extra, Futura y las 3 cuotas; la 400 no dejó nada

    // PATCH /payments/:id: marcar cobrada una cuota de la serie (conserva la serie), luego editar monto/fecha
    const cuota2 = cuotas[1]
    const paid = await call(`/payments/${cuota2.id}`, { cookie, method: 'PATCH', body: { status: 'cobrado' } })
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
    assert.deepEqual(Object.keys(paid.body).sort(), keys)
    assert.deepEqual(paid.body.movements.find((m: any) => m.id === cuota2.id), { ...cuota2, status: 'cobrado' })
    const edited = await call(`/payments/${cuota2.id}`, { cookie, method: 'PATCH', body: { amount: 33.33, date: '2010-05-05', concept: 'Mensual (ajustada)' } })
    assert.deepEqual(edited.body.movements.find((m: any) => m.id === cuota2.id), {
      ...cuota2, status: 'cobrado', amount: 33.33, date: '2010-05-05', concept: 'Mensual (ajustada)',
    })
    assert.equal(edited.body.movements.length, 7)
    // vuelve a pendiente
    const back = await call(`/payments/${cuota2.id}`, { cookie, method: 'PATCH', body: { status: 'pendiente' } })
    assert.equal(back.body.movements.find((m: any) => m.id === cuota2.id).status, 'pendiente')

    // la inicial no se edita ni se borra por /payments
    for (const method of ['PATCH', 'DELETE']) {
      const r = await call(`/payments/${ini.id}`, { cookie, method, body: method === 'PATCH' ? { amount: 1 } : undefined })
      assert.equal(r.status, 400, method)
      assert.match(r.body.error, /inicial/)
    }

    // DELETE de una cuota de la serie: 200 con el cliente completo, la serie queda con hueco
    const del = await call(`/payments/${cuota2.id}`, { cookie, method: 'DELETE' })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.deepEqual(Object.keys(del.body).sort(), keys)
    assert.equal(del.body.movements.length, 6)
    assert.deepEqual(del.body.movements.filter((m: any) => m.series).map((m: any) => m.series.index), [1, 3])
    assert.equal((await call(`/payments/${cuota2.id}`, { cookie, method: 'DELETE' })).status, 404)
    assert.deepEqual((await call('/clients', { cookie })).body.find((c: any) => c.id === id), del.body) // GET igual

    // items vacíos (o suma 0) borran la inicial y los items
    const empty = await call(`/clients/${id}/initial`, { cookie, method: 'PUT', body: { date: '2020-01-01', items: [] } })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.items, [])
    assert.ok(empty.body.movements.every((m: any) => m.kind === 'pago'))
    assert.equal(empty.body.movements.length, 5)
    // y se puede volver a crear
    const re = await call(`/clients/${id}/initial`, { cookie, method: 'PUT', body: { date: '2040-01-01', items: [{ concept: 'N', amount: 9 }] } })
    assert.deepEqual(shape(re.body.movements.find((m: any) => m.kind === 'inicial')), {
      id: '<uuid>', date: '2040-01-01', concept: 'Inicial', amount: 9, kind: 'inicial', status: 'cobrado', series: null,
    })
  })

  it('editar cliente/cuotas: validaciones 400 y 404 sin dejar rastro', async () => {
    const c = await call('/clients', { cookie, body: { name: 'Val', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'a', amount: 10 }], charges: [{ date: '2026-02-01', amount: 5, concept: 'p' }] } })
    const id = c.body.id as string
    const payId = c.body.movements.find((m: any) => m.kind === 'pago').id as string
    const snapshot = async () => (await call('/clients', { cookie })).body.find((x: any) => x.id === id)
    const before = await snapshot()
    const put = (body: unknown) => call(`/clients/${id}/initial`, { cookie, method: 'PUT', body })
    const post = (body: unknown) => call(`/clients/${id}/payments`, { cookie, body })
    const patch = (body: unknown) => call(`/payments/${payId}`, { cookie, method: 'PATCH', body })
    const cases: [string, Promise<Res>][] = [
      ['patch cliente vacío', call(`/clients/${id}`, { cookie, method: 'PATCH', body: {} })],
      ['patch nombre vacío', call(`/clients/${id}`, { cookie, method: 'PATCH', body: { name: '  ' } })],
      ['patch nombre largo', call(`/clients/${id}`, { cookie, method: 'PATCH', body: { name: 'x'.repeat(81) } })],
      ['initial sin fecha', put({ items: [] })],
      ['initial fecha inválida', put({ date: '2026-02-30', items: [] })],
      ['initial sin items', put({ date: '2026-01-01' })],
      ['initial monto 0', put({ date: '2026-01-01', items: [{ concept: 'a', amount: 0 }] })],
      ['initial 3 decimales', put({ date: '2026-01-01', items: [{ concept: 'a', amount: 1.001 }] })],
      ['initial > 1e9', put({ date: '2026-01-01', items: [{ concept: 'a', amount: 2_000_000_000 }] })],
      ['initial concepto largo', put({ date: '2026-01-01', items: [{ concept: 'a'.repeat(121), amount: 1 }] })],
      ['pago sin concepto', post({ date: '2026-01-01', amount: 1 })],
      ['pago monto negativo', post({ date: '2026-01-01', amount: -1, concept: 'x' })],
      ['pago estado inválido', post({ date: '2026-01-01', amount: 1, concept: 'x', status: 'pagado' })],
      ['pago repeatMonths 1', post({ date: '2026-01-01', amount: 1, concept: 'x', repeatMonths: 1 })],
      ['pago repeatMonths 37', post({ date: '2026-01-01', amount: 1, concept: 'x', repeatMonths: 37 })],
      ['pago repeat + cobrado', post({ date: '2026-01-01', amount: 1, concept: 'x', repeatMonths: 2, status: 'cobrado' })],
      ['patch pago vacío', patch({})],
      ['patch pago monto 0', patch({ amount: 0 })],
      ['patch pago fecha inválida', patch({ date: 'ayer' })],
      ['patch pago estado inválido', patch({ status: 'x' })],
      ['patch pago concepto largo', patch({ concept: 'c'.repeat(121) })],
      ['id no uuid', call('/payments/no-uuid', { cookie, method: 'PATCH', body: { amount: 1 } })],
    ]
    for (const [name, p] of cases) {
      const r = await p
      assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`)
      assert.equal(typeof r.body.error, 'string', name)
    }
    assert.deepEqual(await snapshot(), before) // nada cambió

    const notFound: [string, Promise<Res>][] = [
      ['patch cliente', call(`/clients/${NOPE}`, { cookie, method: 'PATCH', body: { name: 'Z' } })],
      ['initial', call(`/clients/${NOPE}/initial`, { cookie, method: 'PUT', body: { date: '2026-01-01', items: [] } })],
      ['payments', call(`/clients/${NOPE}/payments`, { cookie, body: { date: '2026-01-01', amount: 1, concept: 'x' } })],
      ['patch pago', call(`/payments/${NOPE}`, { cookie, method: 'PATCH', body: { amount: 1 } })],
      ['delete pago', call(`/payments/${NOPE}`, { cookie, method: 'DELETE' })],
      ['convert', call(`/clients/${NOPE}/convert`, { cookie, method: 'POST' })],
    ]
    for (const [name, p] of notFound) {
      const r = await p
      assert.equal(r.status, 404, `${name}: ${JSON.stringify(r.body)}`)
      assert.equal(typeof r.body.error, 'string', name)
    }
    // sin sesión => 401 en las rutas nuevas
    for (const [method, path] of [['PATCH', `/clients/${id}`], ['PUT', `/clients/${id}/initial`], ['POST', `/clients/${id}/payments`], ['PATCH', `/payments/${payId}`], ['DELETE', `/payments/${payId}`], ['POST', '/prospects'], ['POST', `/clients/${id}/convert`], ['PATCH', `/projects/${NOPE}`]] as const) {
      assert.equal((await call(path, { method, body: {} })).status, 401, `${method} ${path}`)
    }
  })

  it('cliente potencial: POST /prospects crea cliente+proyecto+visita; convert => cliente; dos veces => 409', async () => {
    const body = { name: ' Futuro SA ', avatar: 'vega', project: { name: 'Web Futuro', icon: 'globe', owner: 'leandro', due: '2020-03-01' }, visit: { date: '2020-02-10' } }
    const r = await call('/prospects', { cookie, body })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(Object.keys(r.body).sort(), ['client', 'project', 'task'])
    const { client, project, task } = r.body
    assert.deepEqual(shape(client), { id: '<uuid>', name: 'Futuro SA', avatar: 'vega', prospect: true, archived: false, ...CRM, source: 'otro', stage: 'potencial', probability: 10, stageChangedAt: '<ts>', items: [], movements: [] })
    assert.deepEqual(shape(project), {
      id: '<uuid>', name: 'Web Futuro', icon: 'globe', owner: 'Leandro', client: 'Futuro SA', clientId: '<uuid>', status: 'planeacion', due: '2020-03-01', archived: false, clientArchived: false, description: null,
    })
    assert.equal(project.clientId, client.id)
    assert.deepEqual(shape(task), { id: '<uuid>', projectId: '<uuid>', title: 'Visita a Futuro SA', done: false, due: '2020-02-10', owner: 'Elis', hidden: false, milestoneId: null, assigneeId: null, responsable: 'Leandro', asignada: false })
    assert.equal(task.projectId, project.id)
    const { rows } = await admin.query('SELECT created_by FROM clients WHERE id = $1', [client.id])
    assert.equal(rows[0].created_by, (await call('/auth/me', { cookie })).body.id)
    // aparece en los listados con la misma forma
    assert.deepEqual((await call('/clients', { cookie })).body.find((c: any) => c.id === client.id), client)
    assert.deepEqual((await call('/projects', { cookie })).body.find((p: any) => p.id === project.id), project)
    assert.deepEqual((await call('/tasks', { cookie })).body.find((t: any) => t.id === task.id), task)

    // título propio, due y fecha opcionales (null)
    const r2 = await call('/prospects', { cookie, body: { name: 'Otro', avatar: 'x', project: { name: 'P', icon: 'box', owner: 'Elis', due: null }, visit: { title: 'Llamada', date: null } } })
    assert.equal(r2.status, 201, JSON.stringify(r2.body))
    assert.equal(r2.body.task.title, 'Llamada')
    assert.equal(r2.body.task.due, null)
    assert.equal(r2.body.project.due, null)
    const r3 = await call('/prospects', { cookie, body: { name: 'Mínimo', avatar: 'x', project: { name: 'P', icon: 'box', owner: 'Elis' } } })
    assert.equal(r3.status, 201, JSON.stringify(r3.body))
    assert.equal(r3.body.task.title, 'Visita a Mínimo')

    // convert: prospect=false, conserva su proyecto; la segunda vez => 409
    const conv = await call(`/clients/${client.id}/convert`, { cookie, method: 'POST' })
    assert.equal(conv.status, 200, JSON.stringify(conv.body))
    assert.match(conv.body.implementationDate, /^\d{4}-\d\d-\d\d$/, 'la pantalla actual no pide el día de implementación: queda hoy')
    assert.deepEqual(shape(conv.body), { ...shape(client), prospect: false, stage: 'ganado', probability: 100, stageChangedAt: '<ts>', implementationDate: conv.body.implementationDate })
    assert.deepEqual((await call('/projects', { cookie })).body.find((p: any) => p.id === project.id), project)
    const twice = await call(`/clients/${client.id}/convert`, { cookie, method: 'POST' })
    assert.equal(twice.status, 409)
    assert.equal(typeof twice.body.error, 'string')
    // un cliente normal (no potencial) tampoco se convierte
    const normal = await call('/clients', { cookie, body: { name: 'Normal', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    assert.equal(normal.body.prospect, false)
    assert.equal((await call(`/clients/${normal.body.id}/convert`, { cookie, method: 'POST' })).status, 409)
  })

  it('POST /prospects: owner inexistente => 404 y no queda nada; validaciones => 400', async () => {
    const count = async () => [(await call('/clients', { cookie })).body.length, (await call('/projects', { cookie })).body.length, (await call('/tasks', { cookie })).body.length]
    const before = await count()
    const ok = { name: 'Fantasma SA', avatar: 'x', project: { name: 'P', icon: 'box', owner: 'Elis' }, visit: { date: '2026-01-01' } }
    const ghost = await call('/prospects', { cookie, body: { ...ok, project: { ...ok.project, owner: 'Nadie' } } })
    assert.equal(ghost.status, 404)
    assert.equal(typeof ghost.body.error, 'string')
    const bad = [
      { ...ok, name: '' },
      { ...ok, avatar: undefined },
      { ...ok, project: undefined },
      { ...ok, project: { ...ok.project, icon: 'rocket' } },
      { ...ok, project: { ...ok.project, name: 'x'.repeat(81) } },
      { ...ok, project: { ...ok.project, due: '2026-13-01' } },
      { ...ok, visit: { date: 'mañana' } },
    ]
    for (const b of bad) {
      const r = await call('/prospects', { cookie, body: b })
      assert.equal(r.status, 400, JSON.stringify(b))
      assert.equal(typeof r.body.error, 'string')
    }
    assert.deepEqual(await count(), before)
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM clients WHERE name = 'Fantasma SA'")
    assert.equal(rows[0].n, 0)
  })

  it('tareas con fecha: due en POST/PATCH/GET, null la borra, PATCH vacío => 400', async () => {
    const t = await call('/tasks', { cookie, body: { projectId, title: 'Con fecha', due: '2019-05-05' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.deepEqual(shape(t.body), { id: '<uuid>', projectId: '<uuid>', title: 'Con fecha', done: false, due: '2019-05-05', owner: 'Elis', hidden: false, milestoneId: null, assigneeId: null, responsable: 'Leandro', asignada: false })
    assert.deepEqual((await call('/tasks', { cookie })).body.find((x: any) => x.id === t.body.id), t.body)
    const nul = await call('/tasks', { cookie, body: { projectId, title: 'Sin fecha', due: null } })
    assert.equal(nul.body.due, null)
    assert.equal((await call('/tasks', { cookie, body: { projectId, title: 'Omitida' } })).body.due, null)

    const url = `/tasks/${t.body.id}`
    // done no toca due; due no toca done
    const done = await call(url, { cookie, method: 'PATCH', body: { done: true } })
    assert.deepEqual(done.body, { ...t.body, done: true })
    const moved = await call(url, { cookie, method: 'PATCH', body: { due: '2035-01-31' } })
    assert.deepEqual(moved.body, { ...t.body, done: true, due: '2035-01-31' })
    assert.equal((await admin.query('SELECT done_at IS NOT NULL AS ok FROM tasks WHERE id = $1', [t.body.id])).rows[0].ok, true)
    // ambos a la vez; null borra la fecha
    const both = await call(url, { cookie, method: 'PATCH', body: { done: false, due: null } })
    assert.deepEqual(both.body, { ...t.body, done: false, due: null })
    assert.equal((await admin.query('SELECT done_at IS NULL AS ok FROM tasks WHERE id = $1', [t.body.id])).rows[0].ok, true)

    assert.equal((await call(url, { cookie, method: 'PATCH', body: {} })).status, 400)
    assert.equal((await call(url, { cookie, method: 'PATCH', body: { due: 'x' } })).status, 400)
    assert.equal((await call(url, { cookie, method: 'PATCH', body: { due: '2026-02-30' } })).status, 400)
    assert.equal((await call('/tasks', { cookie, body: { projectId, title: 'x', due: 'x' } })).status, 400)
    assert.equal((await call(`/tasks/${NOPE}`, { cookie, method: 'PATCH', body: { due: null } })).status, 404)
    for (const x of [t.body.id, nul.body.id]) await call(`/tasks/${x}`, { cookie, method: 'DELETE' })
  })

  it('PATCH /projects/:id: edición parcial, cambio de cliente/responsable/estado/fecha, due null, 400/404', async () => {
    const other = await call('/clients', { cookie, body: { name: 'Otro cliente', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    const p = await call('/projects', { cookie, body: { name: 'Editable', icon: 'code', clientId, owner: 'Elis', status: 'activo', due: '2026-05-01' } })
    assert.equal(p.status, 201)
    const url = `/projects/${p.body.id}`
    const patch = (body: unknown) => call(url, { cookie, method: 'PATCH', body })

    const name = await patch({ name: ' Renombrado ' })
    assert.equal(name.status, 200, JSON.stringify(name.body))
    assert.deepEqual(name.body, { ...p.body, name: 'Renombrado' }) // solo cambia lo enviado
    const multi = await patch({ icon: 'chart', status: 'entrega', owner: 'jorbi', clientId: other.body.id, due: '2019-01-01' })
    assert.deepEqual(multi.body, {
      ...p.body, name: 'Renombrado', icon: 'chart', status: 'entrega', owner: 'Jorbi', client: 'Otro cliente', clientId: other.body.id, due: '2019-01-01',
    })
    assert.deepEqual(Object.keys(multi.body), ['id', 'name', 'description', 'icon', 'owner', 'client', 'clientId', 'status', 'due', 'archived', 'clientArchived'])
    assert.deepEqual((await call('/projects', { cookie })).body.find((x: any) => x.id === p.body.id), multi.body) // GET igual
    const nul = await patch({ due: null })
    assert.equal(nul.body.due, null)
    assert.equal(nul.body.name, 'Renombrado')
    const entregado = await patch({ status: 'entregado' }) // terminal pero visible: sigue en GET /projects, sin archivar
    assert.equal(entregado.status, 200, JSON.stringify(entregado.body))
    assert.deepEqual([entregado.body.status, entregado.body.archived], ['entregado', false])
    assert.equal((await call('/projects', { cookie })).body.find((x: any) => x.id === p.body.id).status, 'entregado')
    assert.equal((await patch({ status: 'planeacion' })).body.status, 'planeacion')
    assert.equal((await patch({ due: null })).body.due, null) // idempotente

    assert.equal((await patch({})).status, 400)
    assert.match((await patch({})).body.error, /al menos/i)
    for (const b of [{ name: '' }, { name: 'x'.repeat(81) }, { icon: 'rocket' }, { status: 'otro' }, { clientId: 'no-uuid' }, { due: '2026-02-30' }, { due: 'x' }, { owner: '' }]) {
      assert.equal((await patch(b)).status, 400, JSON.stringify(b))
    }
    assert.equal((await patch({ owner: 'Fantasma' })).status, 404)
    assert.equal((await patch({ clientId: NOPE })).status, 404)
    assert.equal((await call(`/projects/${NOPE}`, { cookie, method: 'PATCH', body: { name: 'Z' } })).status, 404)
    assert.equal((await call('/projects/no-uuid', { cookie, method: 'PATCH', body: { name: 'Z' } })).status, 400)
    // los intentos fallidos no cambiaron nada
    assert.deepEqual((await call('/projects', { cookie })).body.find((x: any) => x.id === p.body.id), { ...nul.body, status: 'planeacion' })
  })

  it('ruta desconocida => 404 JSON', async () => {
    const r = await call('/nada', { cookie })
    assert.equal(r.status, 404)
    assert.equal(typeof r.body.error, 'string')
  })

  it('logout: 204 e invalida la cookie (sesión borrada en BD)', async () => {
    const c = await sessionFor('Elis', '482913')
    assert.equal((await call('/clients', { cookie: c })).status, 200)
    const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: c } })
    assert.equal(out.status, 204)
    assert.match(out.headers.getSetCookie().find((x) => x.startsWith('hayai_sid=')) ?? '', /hayai_sid=;/)
    assert.equal((await call('/auth/me', { cookie: c })).status, 401)
    assert.equal((await call('/clients', { cookie: c })).status, 401)
  })

  it('sesión expirada => 401', async () => {
    const c = await sessionFor('Elis', '482913')
    await admin.query("UPDATE sessions SET expires_at = now() + interval '1 second', created_at = now() - interval '1 day'")
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal((await call('/auth/me', { cookie: c })).status, 401)
  })
})

describe('borrar', () => {
  it('cliente borra en cascada proyectos, tareas, cobros y gastos; proyecto y gasto sueltos también; 404 si no existe', async () => {
    const cookie = await sessionFor('Elis', '482913')
    const count = async (t: string) => Number((await admin.query(`SELECT count(*) FROM ${t}`)).rows[0].count)
    const before = { clients: await count('clients'), payments: await count('payments'), projects: await count('projects'), tasks: await count('tasks'), expenses: await count('expenses') }

    const c = (await call('/clients', { cookie, body: { name: 'Borrable', avatar: 'x', initialDate: '2026-01-01', items: [{ concept: 'A', amount: 10 }], charges: [{ date: '2026-02-01', amount: 5, concept: 'B' }] } })).body
    const p = (await call('/projects', { cookie, body: { name: 'P', icon: 'box', clientId: c.id, owner: 'Elis', due: '2026-03-01' } })).body
    await call('/tasks', { cookie, body: { projectId: p.id, title: 'T' } })
    const mk = (scope: string, refId?: string) => call('/expenses', { cookie, body: { date: '2026-01-05', concept: 'G', amount: 1, category: 'Otros', scope, refId } })
    const eCli = (await mk('cliente', c.id)).body
    await mk('proyecto', p.id)

    assert.equal((await call(`/expenses/${eCli.id}`, { cookie, method: 'DELETE' })).status, 204)
    assert.equal((await call(`/expenses/${eCli.id}`, { cookie, method: 'DELETE' })).status, 404)
    assert.equal((await call(`/projects/${p.id}`, { cookie, method: 'DELETE' })).status, 204) // arrastra su gasto y tarea
    assert.equal(await count('tasks'), before.tasks)
    assert.equal(await count('expenses'), before.expenses)

    const p2 = (await call('/projects', { cookie, body: { name: 'P2', icon: 'box', clientId: c.id, owner: 'Elis', due: '2026-03-01' } })).body
    await call('/tasks', { cookie, body: { projectId: p2.id, title: 'T2' } })
    await mk('proyecto', p2.id)
    assert.equal((await call(`/clients/${c.id}`, { cookie, method: 'DELETE' })).status, 204)
    assert.deepEqual(
      { clients: await count('clients'), payments: await count('payments'), projects: await count('projects'), tasks: await count('tasks'), expenses: await count('expenses') },
      before,
    )
    assert.equal((await call(`/clients/${c.id}`, { cookie, method: 'DELETE' })).status, 404)
    assert.equal((await call(`/projects/${p.id}`, { cookie, method: 'DELETE' })).status, 404)
  })
})

describe('multitenant', () => {
  // Elis es ADMIN (global) con PIN 482913 (lo dejó la suite de auth). Crea un segundo tenant y dos SOCIO desde /admin.
  let adminCookie = ''
  let otro = '' // id del tenant «Otra Empresa»
  let hayai = ''
  let socioCookie = '' // Pedro: SOCIO solo en Otra Empresa, con clientes, tareas y proyectos (sin cobros ni finanzas)
  let sinNadaCookie = '' // Rosa: SOCIO sin ningún tenant
  const NOPE = '00000000-0000-4000-8000-000000000000'
  const as = (cookie: string, tenant: string | null, path: string, o: { method?: string; body?: unknown } = {}) =>
    call(path, { cookie, ...o, headers: { 'x-tenant-id': tenant ?? 'null' } })

  async function nuevoSocio(name: string, tenants: { tenantId: string; modules: string[] }[]) {
    const r = await call('/admin/users', { cookie: adminCookie, body: { name, tenants } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.role, 'SOCIO')
    assert.equal(r.body.mustChangePin, true)
    const first = await sessionFor(name) // PIN inicial 000000
    assert.equal((await call('/clients', { cookie: first })).status, 403) // debe cambiar el PIN antes de usar nada
    const ch = await call('/auth/change-pin', { cookie: first, body: { currentPin: '000000', newPin: '246813' } })
    assert.equal(ch.status, 200, JSON.stringify(ch.body))
    assert.equal(ch.body.mustChangePin, false)
    return first
  }

  before(async () => {
    adminCookie = await sessionFor('Elis', '482913')
    hayai = (await call('/auth/me', { cookie: adminCookie })).body.tenants[0].id
    const t = await call('/admin/tenants', { cookie: adminCookie, body: { name: 'Otra Empresa' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.equal(t.body.slug, 'otra-empresa')
    otro = t.body.id
    socioCookie = await nuevoSocio('Pedro', [{ tenantId: otro, modules: ['clientes', 'tareas', 'proyectos'] }])
    sinNadaCookie = await nuevoSocio('Rosa', [])
  })

  it('/admin es solo de ADMIN: un SOCIO recibe 403; slug único; validación zod', async () => {
    assert.equal((await call('/admin/tenants', { cookie: socioCookie })).status, 403)
    assert.equal((await call('/admin/users', { cookie: socioCookie, body: { name: 'Hack' } })).status, 403)
    assert.equal((await call('/admin/tenants')).status, 401)
    assert.equal((await call('/admin/tenants', { cookie: adminCookie, body: { name: 'otra empresa' } })).status, 409)
    assert.equal((await call('/admin/tenants', { cookie: adminCookie, body: { name: '' } })).status, 400)
    assert.equal((await call('/admin/users', { cookie: adminCookie, body: { name: 'X', tenants: [{ tenantId: otro, modules: ['nope'] }] } })).status, 400)
    const users = await call('/admin/users', { cookie: adminCookie })
    assert.equal(users.status, 200)
    assert.deepEqual(users.body.find((u: any) => u.name === 'Pedro').tenants.map((x: any) => [x.slug, x.modules]), [['otra-empresa', ['clientes', 'tareas', 'proyectos']]])
    const me = users.body.find((u: any) => u.name === 'Elis')
    assert.equal((await call(`/admin/users/${me.id}`, { cookie: adminCookie, method: 'PATCH', body: { active: false } })).status, 409) // no se deja fuera a sí mismo
  })

  it('/auth/me: el SOCIO ve solo sus tenants y módulos; el ADMIN todos los activos con todos los módulos', async () => {
    const me = (await call('/auth/me', { cookie: socioCookie })).body
    assert.deepEqual(me.tenants.map((t: any) => [t.slug, t.modules]), [['otra-empresa', ['clientes', 'tareas', 'proyectos']]])
    const adm = (await call('/auth/me', { cookie: adminCookie })).body
    assert.deepEqual(adm.tenants.map((t: any) => t.slug), ['hayai', 'otra-empresa'])
    assert.equal(adm.tenants[1].modules.length, 14)
    assert.deepEqual((await call('/auth/me', { cookie: sinNadaCookie })).body.tenants, [])
  })

  it('sin cabecera => 400; tenant ajeno, inexistente o basura => 403; SOCIO sin el módulo => 403', async () => {
    const sin = await as(socioCookie, null, '/clients')
    assert.deepEqual([sin.status, sin.body.codigo], [400, 'tenant_requerido'])
    const ajeno = await as(socioCookie, hayai, '/clients')
    assert.deepEqual([ajeno.status, ajeno.body.codigo], [403, 'tenant_sin_acceso'])
    assert.equal((await as(socioCookie, NOPE, '/clients')).status, 403)
    assert.equal((await as(socioCookie, 'basura', '/clients')).status, 403)
    assert.equal((await as(sinNadaCookie, otro, '/clients')).status, 403) // sin membresía
    assert.equal((await as(sinNadaCookie, hayai, '/tasks')).status, 403)
    const mod = await as(socioCookie, otro, '/expenses')
    assert.deepEqual([mod.status, mod.body.codigo, mod.body.modulo], [403, 'modulo_sin_acceso', 'finanzas'])
    assert.equal((await as(socioCookie, otro, '/chat')).status, 403)
    assert.equal((await as(socioCookie, otro, '/trash')).status, 403)
    assert.equal((await as(socioCookie, otro, `/clients/${NOPE}/payments`, { body: {} })).status, 403) // cobros
    assert.equal((await as(socioCookie, otro, '/clients')).status, 200)
  })

  it('aislamiento: nada de HAYAI se ve ni se toca desde otro tenant (listados, detalle, escritura) y viceversa', async () => {
    const hClients = (await as(adminCookie, hayai, '/clients')).body
    const hProjects = (await as(adminCookie, hayai, '/projects')).body
    const hTasks = (await as(adminCookie, hayai, '/tasks')).body
    assert.ok(hClients.length > 0 && hProjects.length > 0 && hTasks.length > 0)

    for (const p of ['/clients', '/projects', '/tasks']) assert.deepEqual((await as(socioCookie, otro, p)).body, [], p)
    const c = await as(socioCookie, otro, '/clients', { body: { name: 'Cliente de Otra', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    const p = await as(socioCookie, otro, '/projects', { body: { name: 'Proyecto de Otra', icon: 'box', clientId: c.body.id, owner: 'Pedro' } })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const t = await as(socioCookie, otro, '/tasks', { body: { projectId: p.body.id, title: 'Tarea de Otra' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    assert.equal((await as(socioCookie, otro, '/projects', { body: { name: 'X', icon: 'box', owner: 'Rosa' } })).status, 404) // Rosa no es miembro

    assert.deepEqual((await as(socioCookie, otro, '/clients')).body.map((x: any) => x.name), ['Cliente de Otra'])
    assert.deepEqual((await as(socioCookie, otro, '/tasks')).body.map((x: any) => x.title), ['Tarea de Otra'])
    assert.ok(!(await as(adminCookie, hayai, '/clients')).body.some((x: any) => x.id === c.body.id))
    assert.ok(!(await as(adminCookie, hayai, '/tasks')).body.some((x: any) => x.id === t.body.id))
    assert.deepEqual((await as(adminCookie, otro, '/clients')).body.map((x: any) => x.id), [c.body.id])
    const socios = (await as(adminCookie, otro, '/users')).body.map((u: any) => u.name)
    assert.ok(socios.includes('Pedro') && socios.includes('Elis') && !socios.includes('Rosa')) // miembros + ADMIN

    // Ids de HAYAI desde el otro tenant: 404 (no 403), lectura y escritura.
    const [hc, hp, ht] = [hClients[0].id, hProjects[0].id, hTasks[0].id]
    assert.equal((await as(socioCookie, otro, `/clients/${hc}`, { method: 'PATCH', body: { name: 'Robado' } })).status, 404)
    assert.equal((await as(socioCookie, otro, `/clients/${hc}/interactions`)).status, 404)
    assert.equal((await as(socioCookie, otro, `/clients/${hc}/archive`, { body: {} })).status, 404)
    assert.equal((await as(socioCookie, otro, `/clients/${hc}`, { method: 'DELETE' })).status, 404)
    assert.equal((await as(socioCookie, otro, `/projects/${hp}/detail`)).status, 404)
    assert.equal((await as(socioCookie, otro, `/tasks/${ht}`, { method: 'PATCH', body: { done: true } })).status, 404)
    assert.equal((await as(socioCookie, otro, `/tasks/${ht}`, { method: 'DELETE' })).status, 404)
    assert.equal((await as(socioCookie, otro, '/tasks', { body: { projectId: hp, title: 'Intrusa' } })).status, 404)
    assert.equal((await as(socioCookie, otro, '/projects', { body: { name: 'Y', icon: 'box', clientId: hc, owner: 'Pedro' } })).status, 404)
    assert.equal((await as(socioCookie, otro, `/clients/${hc}/interactions`, { body: { tipo: 'nota', resumen: 'x' } })).status, 404)
    assert.equal((await as(adminCookie, hayai, `/clients/${c.body.id}`, { method: 'PATCH', body: { name: 'X' } })).status, 404)
    assert.equal((await as(adminCookie, hayai, `/projects/${p.body.id}/detail`)).status, 404)
    // Búsqueda, actividad y papelera: solo lo del tenant.
    const s = (await as(socioCookie, otro, '/search?q=otra')).body
    assert.deepEqual(s.clientes.map((x: any) => x.id), [c.body.id])
    const act = (await as(socioCookie, otro, '/activity')).body
    assert.ok(act.data.length > 0)
    assert.ok(act.data.every((a: any) => a.cliente_id === null || a.cliente_id === c.body.id))
    assert.ok(!(await as(adminCookie, hayai, '/activity?per_page=100')).body.data.some((a: any) => a.cliente_id === c.body.id))
    assert.equal((await as(adminCookie, hayai, '/trash')).status, 200)
    assert.deepEqual((await as(adminCookie, otro, '/trash')).body, [])
  })

  it('tenant desactivado: nadie entra (ni el ADMIN); se reactiva', async () => {
    assert.equal((await call(`/admin/tenants/${otro}`, { cookie: adminCookie, method: 'PATCH', body: { active: false } })).status, 200)
    assert.equal((await as(socioCookie, otro, '/clients')).status, 403)
    assert.equal((await as(adminCookie, otro, '/clients')).status, 403)
    assert.deepEqual((await call('/auth/me', { cookie: socioCookie })).body.tenants, [])
    assert.equal((await call(`/admin/tenants/${otro}`, { cookie: adminCookie, method: 'PATCH', body: { active: true } })).status, 200)
    assert.equal((await as(socioCookie, otro, '/clients')).status, 200)
  })

  it('cambiar módulos, quitar el acceso y resetear PIN desde /admin', async () => {
    const pedro = (await call('/admin/users', { cookie: adminCookie })).body.find((u: any) => u.name === 'Pedro')
    assert.equal((await call(`/admin/users/${pedro.id}/tenants/${otro}`, { cookie: adminCookie, method: 'PUT', body: { modules: ['clientes'] } })).status, 200)
    assert.equal((await as(socioCookie, otro, '/tasks')).status, 403)
    assert.equal((await call(`/admin/users/${pedro.id}/tenants/${otro}`, { cookie: adminCookie, method: 'DELETE' })).status, 200)
    assert.equal((await as(socioCookie, otro, '/clients')).status, 403)
    const r = await call(`/admin/users/${pedro.id}/reset-pin`, { cookie: adminCookie, body: {} })
    assert.deepEqual([r.status, r.body.mustChangePin], [200, true])
    assert.equal((await call('/auth/me', { cookie: socioCookie })).status, 401) // sus sesiones se cerraron
    assert.equal((await login('Pedro', '000000')).status, 200)
  })
})

describe('tablero (040)', () => {
  // Elis es ADMIN. Tomas: SOCIO de HAYAI con tablero y clientes. Ines: SOCIO de HAYAI sin tablero. Bruno: SOCIO de otro tenant con tablero.
  let elis = ''
  let tomas = ''
  let ines = ''
  let bruno = ''
  let dos = '' // tenant «Tablero Dos»
  const ids: Record<string, string> = {}
  const NOPE = '00000000-0000-4000-8000-000000000000'
  const as = (cookie: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => call(path, { cookie, ...o })
  const inDos = (path: string, o: { method?: string; body?: unknown } = {}) => call(path, { cookie: bruno, ...o, headers: { 'x-tenant-id': dos } })
  const boardOf = async (cookie = elis) => (await as(cookie, '/board')).body
  const col = async (name: string) => (await boardOf()).columns.find((c: any) => c.name === name)
  const titles = async (name: string) => (await col(name)).cards.map((k: any) => k.title)
  const newCard = async (columnId: string, title: string, extra: Record<string, unknown> = {}) => {
    const r = await as(elis, '/board/cards', { body: { columnId, title, ...extra } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.full
  }
  const move = (cardId: string, columnId: string, afterId?: string | null, cookie = elis) =>
    as(cookie, `/board/cards/${cardId}/move`, { body: { columnId, ...(afterId !== undefined ? { afterId } : {}) } })
  const acts = async (tipo: string, cardId: string) => (await as(elis, '/activity?per_page=100')).body.data.filter((a: any) => a.tipo === tipo && a.tarjeta_id === cardId)

  async function socio(name: string, tenants: { tenantId: string; modules: string[] }[]) {
    assert.equal((await call('/admin/users', { cookie: elis, body: { name, tenants } })).status, 201)
    const first = await sessionFor(name)
    assert.equal((await call('/auth/change-pin', { cookie: first, body: { currentPin: '000000', newPin: '246813' } })).status, 200)
    return first
  }

  before(async () => {
    elis = await sessionFor('Elis', '482913')
    const t = await call('/admin/tenants', { cookie: elis, body: { name: 'Tablero Dos' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    dos = t.body.id
    tomas = await socio('Tomas', [{ tenantId: HAYAI, modules: ['tablero', 'clientes'] }])
    ines = await socio('Ines', [{ tenantId: HAYAI, modules: ['clientes'] }])
    bruno = await socio('Bruno', [{ tenantId: dos, modules: ['tablero', 'clientes'] }])
    const users = (await call('/admin/users', { cookie: elis })).body
    for (const n of ['Tomas', 'Ines', 'Bruno', 'Elis']) ids[n] = users.find((u: any) => u.name === n).id
  })

  it('cada tenant nace con su tablero y 4 columnas (sembradas por la BD); sin el módulo => 403', async () => {
    const b = await boardOf()
    assert.deepEqual(b.columns.map((c: any) => [c.name, c.cards]), [['Por hacer', []], ['En curso', []], ['En revisión', []], ['Hecho', []]])
    const d = (await inDos('/board')).body
    assert.notEqual(d.id, b.id)
    assert.deepEqual(d.columns.map((c: any) => c.name), ['Por hacer', 'En curso', 'En revisión', 'Hecho'])
    const no = await as(ines, '/board')
    assert.deepEqual([no.status, no.body.codigo, no.body.modulo], [403, 'modulo_sin_acceso', 'tablero'])
    assert.equal((await as(ines, '/board/cards', { body: { columnId: b.columns[0].id, title: 'x' } })).status, 403)
    assert.equal((await as(tomas, '/board')).status, 200)
    const members = (await as(tomas, '/board/members')).body.map((u: any) => u.name)
    assert.ok(members.includes('Tomas') && members.includes('Elis') && !members.includes('Ines') && !members.includes('Bruno'), members.join())
  })

  it('columnas: crear al final o tras after_id, renombrar, reordenar; validación', async () => {
    const a = await as(elis, '/board/columns', { body: { name: 'Bloqueado' } })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    const top = await as(elis, '/board/columns', { body: { name: 'Ideas', afterId: null } })
    assert.equal(top.status, 201)
    const hecho = await col('Hecho')
    assert.equal((await as(elis, '/board/columns', { body: { name: 'Tras hecho', afterId: hecho.id } })).status, 201)
    assert.deepEqual((await boardOf()).columns.map((c: any) => c.name), ['Ideas', 'Por hacer', 'En curso', 'En revisión', 'Hecho', 'Tras hecho', 'Bloqueado'])
    assert.equal((await as(elis, `/board/columns/${top.body.id}`, { method: 'PATCH', body: { name: 'Ideas sueltas', afterId: a.body.id } })).status, 200)
    assert.deepEqual((await boardOf()).columns.map((c: any) => c.name).slice(-2), ['Bloqueado', 'Ideas sueltas'])
    assert.equal((await as(elis, '/board/columns', { body: { name: 'x'.repeat(61) } })).status, 400)
    assert.equal((await as(elis, '/board/columns', { body: { name: 'X', afterId: NOPE } })).status, 400)
    assert.equal((await as(elis, `/board/columns/${top.body.id}`, { method: 'PATCH', body: {} })).status, 400)
    assert.equal((await as(elis, `/board/columns/${NOPE}`, { method: 'PATCH', body: { name: 'Y' } })).status, 404)
    assert.equal((await as(elis, `/board/columns/${top.body.id}`, { method: 'DELETE' })).status, 204)
  })

  it('tarjetas: orden al crear (final / arriba / tras after_id), mover entre y dentro de columnas; solo cambiar de columna avisa', async () => {
    const ph = (await col('Por hacer')).id
    const ec = (await col('En curso')).id
    const A = await newCard(ph, 'A')
    assert.deepEqual([A.priority, A.assignee, A.client, A.comments, A.archivedAt, A.createdBy.name], ['media', null, null, 0, null, 'Elis'])
    const B = await newCard(ph, 'B')
    const C = await newCard(ph, 'C')
    await newCard(ph, 'D', { afterId: null })
    const E = await newCard(ph, 'E', { afterId: A.id, priority: 'urgente', dueDate: '2026-12-01', description: '  Detalle  ' })
    assert.deepEqual([E.priority, E.dueDate, E.description], ['urgente', '2026-12-01', 'Detalle'])
    assert.deepEqual(await titles('Por hacer'), ['D', 'A', 'E', 'B', 'C'])
    const nueva = await acts('tarjeta_nueva', A.id)
    assert.equal(nueva.length, 1)
    assert.equal(nueva[0].texto, 'Elis añadió la tarjeta «A» en Por hacer')

    const m = await move(C.id, ec, null)
    assert.equal(m.status, 200, JSON.stringify(m.body))
    assert.equal(m.body.columnId, ec)
    assert.equal(m.full.updatedAt, C.updatedAt, 'mover no cambia la versión del contenido')
    assert.equal((await acts('tarjeta_movida', C.id))[0].texto, 'Elis movió la tarjeta «C» a En curso')
    assert.equal((await move(B.id, ph, (await col('Por hacer')).cards[0].id)).status, 200) // B tras D, misma columna
    assert.deepEqual(await titles('Por hacer'), ['D', 'B', 'A', 'E'])
    assert.equal((await move(B.id, ph)).status, 200) // al final
    assert.deepEqual(await titles('Por hacer'), ['D', 'A', 'E', 'B'])
    assert.equal((await acts('tarjeta_movida', B.id)).length, 0, 'reordenar en la misma columna no avisa')
    assert.equal((await move(A.id, ec, A.id)).status, 400) // tras sí misma
    assert.equal((await move(A.id, ec, B.id)).status, 400) // B no está en la columna destino
    assert.equal((await move(A.id, NOPE)).status, 404)
    assert.equal((await move(NOPE, ec)).status, 404)
    assert.equal((await as(elis, '/board/cards', { body: { columnId: ph, title: '' } })).status, 400)
    assert.equal((await as(elis, '/board/cards', { body: { columnId: ph, title: 'x'.repeat(201) } })).status, 400)
    assert.equal((await as(elis, '/board/cards', { body: { columnId: ph, title: 'x', priority: 'maxima' } })).status, 400)
  })

  it('renumera la columna tras muchos arrastres al mismo hueco (scale <= 10) sin perder el orden', async () => {
    const c = (await as(elis, '/board/columns', { body: { name: 'Arrastres' } })).body.id
    const P = await newCard(c, 'P')
    await newCard(c, 'Q')
    const X = await newCard(c, 'X')
    const Y = await newCard(c, 'Y')
    for (let i = 0; i < 30; i++) assert.equal((await move(i % 2 ? Y.id : X.id, c, P.id)).status, 200)
    assert.deepEqual(await titles('Arrastres'), ['P', 'Y', 'X', 'Q'])
    const { rows } = await admin.query('SELECT max(scale(position))::int AS s, count(DISTINCT position)::int AS n FROM board_cards WHERE column_id = $1', [c])
    assert.ok(rows[0].s <= 10, `scale ${rows[0].s}`)
    assert.equal(rows[0].n, 4)
  })

  it('editar con If-Match (409 si cambió), archivar/desarchivar, responsable y cliente validados', async () => {
    const ph = (await col('Por hacer')).id
    const k = await newCard(ph, 'Editable')
    const stale = k.updatedAt
    const ok = await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { title: 'Editada', description: '' }, headers: { 'if-match': stale } })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.title, ok.body.description], ['Editada', null])
    assert.notEqual(ok.full.updatedAt, stale)
    const conf = await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { priority: 'alta' }, headers: { 'if-match': stale } })
    assert.deepEqual([conf.status, conf.body.codigo], [409, 'conflicto'])
    assert.equal((await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: {} })).status, 400)

    const asg = await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { assigneeId: ids.Tomas } })
    assert.equal(asg.status, 200, JSON.stringify(asg.body))
    assert.deepEqual([asg.body.assignee.id, asg.body.assignee.name], [ids.Tomas, 'Tomas'])
    assert.equal((await acts('tarjeta_asignada', k.id))[0].texto, 'Elis asignó la tarjeta «Editada» a Tomas')
    assert.equal((await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { assigneeId: ids.Tomas } })).status, 200)
    assert.equal((await acts('tarjeta_asignada', k.id)).length, 1, 'el mismo responsable no vuelve a avisar')
    for (const who of [ids.Ines, ids.Bruno, NOPE]) {
      const r = await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { assigneeId: who } })
      assert.deepEqual([r.status, r.body.codigo], [400, 'responsable_invalido'], who)
    }
    assert.equal((await as(elis, '/board/cards', { body: { columnId: ph, title: 'x', assigneeId: ids.Ines } })).status, 400)
    assert.equal((await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { assigneeId: ids.Elis } })).status, 200) // ADMIN: siempre

    const cli = await as(elis, '/clients', { body: { name: 'Cliente Tablero', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    assert.equal(cli.status, 201, JSON.stringify(cli.body))
    ids.cliente = cli.body.id
    const ajeno = await call('/clients', { cookie: bruno, headers: { 'x-tenant-id': dos }, body: { name: 'Cliente de Dos', avatar: 'x', initialDate: '2026-01-01', items: [], charges: [] } })
    assert.equal(ajeno.status, 201, JSON.stringify(ajeno.body))
    ids.clienteDos = ajeno.body.id
    assert.deepEqual((await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { clientId: ids.cliente } })).body.client, { id: ids.cliente, name: 'Cliente Tablero' })
    assert.equal((await as(elis, `/board/cards/${k.id}`, { method: 'PATCH', body: { clientId: ids.clienteDos } })).status, 404)
    assert.equal((await as(elis, '/board/cards', { body: { columnId: ph, title: 'x', clientId: ids.clienteDos } })).status, 404)

    const before = (await as(elis, `/board/cards/${k.id}`)).full.updatedAt
    const arch = await as(elis, `/board/cards/${k.id}/archive`, { body: {} })
    assert.equal(arch.status, 200)
    assert.ok(arch.body.archivedAt)
    assert.ok(!(await titles('Por hacer')).includes('Editada'))
    assert.ok((await as(elis, '/board/cards/archived')).body.some((x: any) => x.id === k.id))
    const un = await as(elis, `/board/cards/${k.id}/unarchive`, { body: {} })
    assert.deepEqual([un.body.archivedAt, un.full.updatedAt], [null, before])
    assert.ok((await titles('Por hacer')).includes('Editada'))
    ids.editable = k.id
  })

  it('comentarios: cualquiera con el módulo comenta; editar/borrar solo el autor o un ADMIN (403)', async () => {
    const k = ids.editable
    const c1 = await as(tomas, `/board/cards/${k}/comments`, { body: { body: 'Hola desde Tomas' } })
    assert.equal(c1.status, 201, JSON.stringify(c1.body))
    assert.deepEqual([c1.body.author.name, c1.body.editedAt, c1.body.cardId], ['Tomas', null, k])
    assert.equal((await acts('tarjeta_comentada', k))[0].texto, 'Tomas comentó la tarjeta «Editada»')
    const c2 = (await as(elis, `/board/cards/${k}/comments`, { body: { body: 'De Elis' } })).body
    assert.equal((await as(elis, `/board/cards/${k}`)).body.comments, 2)
    assert.equal((await as(tomas, `/board/comments/${c2.id}`, { method: 'PATCH', body: { body: 'pisado' } })).status, 403)
    assert.equal((await as(tomas, `/board/comments/${c2.id}`, { method: 'DELETE' })).status, 403)
    const ed = await as(elis, `/board/comments/${c1.body.id}`, { method: 'PATCH', body: { body: 'Corregido por admin' } })
    assert.deepEqual([ed.status, ed.body.body, typeof ed.body.editedAt], [200, 'Corregido por admin', 'string'])
    assert.equal((await as(tomas, `/board/comments/${c1.body.id}`, { method: 'PATCH', body: { body: 'Mío' } })).status, 200)
    assert.equal((await as(tomas, `/board/cards/${k}/comments`, { body: { body: ' ' } })).status, 400)
    assert.equal((await as(tomas, `/board/cards/${k}/comments`, { body: { body: 'x'.repeat(4001) } })).status, 400)
    assert.deepEqual((await as(tomas, `/board/cards/${k}/comments`)).body.map((m: any) => m.body), ['Mío', 'De Elis'])
    assert.equal((await as(tomas, `/board/comments/${c1.body.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await as(elis, `/board/cards/${k}`)).body.comments, 1)
    assert.equal((await as(elis, `/board/comments/${NOPE}`, { method: 'DELETE' })).status, 404)
  })

  it('aislamiento: nada del tablero de HAYAI se ve ni se toca desde otro tenant', async () => {
    const k = ids.editable
    const hph = (await col('Por hacer')).id
    const dph = (await inDos('/board')).body.columns[0].id
    assert.ok((await inDos('/board')).body.columns.every((c: any) => c.cards.length === 0))
    const probes: [string, string, unknown?][] = [
      ['GET', `/board/cards/${k}`], ['PATCH', `/board/cards/${k}`, { title: 'Robada' }], ['POST', `/board/cards/${k}/move`, { columnId: dph }],
      ['POST', `/board/cards/${k}/archive`, {}], ['DELETE', `/board/cards/${k}`], ['GET', `/board/cards/${k}/comments`], ['POST', `/board/cards/${k}/comments`, { body: 'x' }],
      ['PATCH', `/board/columns/${hph}`, { name: 'Robada' }], ['DELETE', `/board/columns/${hph}`], ['POST', '/board/cards', { columnId: hph, title: 'Intrusa' }],
    ]
    for (const [method, path, body] of probes) assert.equal((await inDos(path, { method, body })).status, 404, `${method} ${path}`)
    const own = (await inDos('/board/cards', { body: { columnId: dph, title: 'De Dos' } })).body
    assert.equal((await move(own.id, hph)).status, 404) // desde HAYAI no existe
    assert.equal((await inDos(`/board/cards/${own.id}/move`, { body: { columnId: hph } })).status, 404) // ni la columna de HAYAI desde Dos
    assert.equal((await inDos(`/board/cards/${own.id}`, { method: 'PATCH', body: { clientId: ids.cliente } })).status, 404)
    assert.ok(!(await as(elis, '/activity?per_page=100')).body.data.some((a: any) => a.tarjeta_id === own.id))
    assert.equal((await admin.query('SELECT title FROM board_cards WHERE id = $1', [k])).rows[0].title, 'Editada')
  })

  it('papelera: tarjeta con comentarios, columna con sus tarjetas (archivadas incluidas), cliente borrado y columna borrada', async () => {
    const trashOf = async (entity: string, label: string) => (await as(elis, '/trash')).body.find((t: any) => t.entity === entity && t.label === label)
    const restore = async (entity: string, label: string) => as(elis, `/trash/${(await trashOf(entity, label)).id}/restore`, { body: {} })
    const k = ids.editable // con 1 comentario y el cliente Cliente Tablero
    assert.equal((await as(elis, `/board/cards/${k}`, { method: 'DELETE' })).status, 204)
    assert.equal((await as(elis, `/board/cards/${k}`)).status, 404)
    assert.match((await trashOf('tarjeta', 'Editada')).detail, /Tarjeta de «Por hacer», 1 comentario/)
    assert.equal((await restore('tarjeta', 'Editada')).status, 200)
    const back = (await as(elis, `/board/cards/${k}`)).body
    assert.deepEqual([back.comments, back.client?.id, back.columnId], [1, ids.cliente, (await col('Por hacer')).id])

    // Columna con una tarjeta archivada: se va todo junto y vuelve todo junto.
    const cid = (await as(elis, '/board/columns', { body: { name: 'Temporal' } })).body.id
    const t1 = await newCard(cid, 'T1')
    const t2 = await newCard(cid, 'T2')
    await as(elis, `/board/cards/${t2.id}/archive`, { body: {} })
    await as(elis, `/board/cards/${t1.id}/comments`, { body: { body: 'nota' } })
    assert.equal((await as(elis, `/board/columns/${cid}`, { method: 'DELETE' })).status, 204)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM board_cards WHERE column_id = $1', [cid])).rows[0].n, 0)
    assert.match((await trashOf('columna', 'Temporal')).detail, /2 tarjetas/)
    assert.equal((await restore('columna', 'Temporal')).status, 200)
    assert.deepEqual(await titles('Temporal'), ['T1'])
    assert.notEqual((await as(elis, `/board/cards/${t2.id}`)).body.archivedAt, null)
    assert.equal((await as(elis, `/board/cards/${t1.id}`)).body.comments, 1)

    // Tarjeta cuya columna ya no está => 409; restaurada la columna, la tarjeta vuelve.
    assert.equal((await as(elis, `/board/cards/${t1.id}`, { method: 'DELETE' })).status, 204)
    assert.equal((await as(elis, `/board/columns/${cid}`, { method: 'DELETE' })).status, 204)
    assert.equal((await restore('tarjeta', 'T1')).status, 409)
    assert.equal((await restore('columna', 'Temporal')).status, 200)
    assert.equal((await restore('tarjeta', 'T1')).status, 200)
    assert.deepEqual(await titles('Temporal'), ['T1'])

    // Cliente a la papelera: la tarjeta pierde el enlace (SET NULL) y lo recupera al restaurar el cliente.
    assert.equal((await as(elis, `/clients/${ids.cliente}`, { method: 'DELETE' })).status, 204)
    assert.equal((await as(elis, `/board/cards/${k}`)).body.client, null)
    assert.equal((await restore('cliente', 'Cliente Tablero')).status, 200)
    assert.deepEqual((await as(elis, `/board/cards/${k}`)).body.client, { id: ids.cliente, name: 'Cliente Tablero' })
    // Tarjeta y luego su cliente a la papelera: la tarjeta vuelve sin cliente.
    assert.equal((await as(elis, `/board/cards/${k}`, { method: 'DELETE' })).status, 204)
    assert.equal((await as(elis, `/clients/${ids.cliente}`, { method: 'DELETE' })).status, 204)
    assert.equal((await restore('tarjeta', 'Editada')).status, 200)
    assert.equal((await as(elis, `/board/cards/${k}`)).body.client, null)
  })

  it('SSE: el aviso «tablero» llega solo a las pestañas del tenant con el módulo', async () => {
    const open = async (cookie: string, tenant: string) => {
      const ac = new AbortController()
      const res = await fetch(`${BASE}/events?tenant=${tenant}`, { headers: { cookie, 'x-tenant-id': 'null' }, signal: ac.signal })
      assert.equal(res.status, 200)
      const s = { buf: '', close: () => ac.abort() }
      const reader = res.body!.getReader()
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return
            s.buf += new TextDecoder().decode(value)
          }
        } catch {
          /* abortado */
        }
      })()
      return s
    }
    const sE = await open(elis, HAYAI)
    const sI = await open(ines, HAYAI)
    const sB = await open(bruno, dos)
    await new Promise((r) => setTimeout(r, 200))
    const k = await newCard((await col('En curso')).id, 'En vivo')
    const frame = `event: tablero\ndata: ${JSON.stringify({ op: 'nuevo', seccion: 'tarjetas', id: k.id })}`
    for (let i = 0; i < 40 && !sE.buf.includes(frame); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 200))
    for (const s of [sE, sI, sB]) s.close()
    assert.ok(sE.buf.includes(frame), sE.buf)
    assert.ok(!sI.buf.includes('event: tablero'), 'sin el módulo tablero no llega')
    assert.ok(!sB.buf.includes('event: tablero'), 'otro tenant no lo recibe')
  })
})
