// Ingesta de leads de Meta Lead Ads (planeta Marketing). Meta avisa por webhook ("llego el lead X"); aqui se pide el detalle a la
// Graph API, se crea el posible cliente y se avisa al equipo. APAGADO por defecto: con META_LEADS_ENABLED distinto de "true" las dos
// rutas responden 404 y no se crea nada (las credenciales llegan despues de la revision de Meta).
//  - Idempotente: meta_leads.leadgen_id es la llave; el mismo lead jamas crea dos clientes aunque Meta reintente el webhook.
//  - Si Graph falla, el lead queda 'error' y se reintenta con espera creciente (hasta MAX_ATTEMPTS); nada se pierde.
//  - Duplicados (mismo telefono o email que un cliente existente) NO crean otro cliente: se anota en su bitacora.
//  - No crea proyecto ni tarea: solo el posible cliente (origen meta_ads, etiqueta "Meta Ads"), su bitacora y el aviso.
import { createHmac, timingSafeEqual } from 'node:crypto'
import express, { Router } from 'express'
import { z } from 'zod'
import { recordActivity } from './activity.ts'
import { applyClientPatch, type ClientPatch, entryStage, fichaShape, loadStages } from './crm.ts'
import { pool, tx } from './db.ts'
import { HttpError } from './util.ts'

const MAX_ATTEMPTS = 6
const GRAPH_FIELDS = 'created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id'
const AVATARS = ['nova', 'orion', 'lyra', 'vega', 'atlas', 'luna', 'kepler', 'sirio', 'rigel', 'titan', 'cygnus', 'pulsar']

export const metaEnabled = () => process.env.META_LEADS_ENABLED === 'true'
const need = (name: string) => {
  const v = process.env[name]
  if (!v) throw new HttpError(503, `Meta no está configurado (falta ${name})`)
  return v
}

/** Firma de Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(cuerpo crudo, app secret). Comparacion en tiempo constante. */
export function validSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const want = createHmac('sha256', secret).update(raw).digest()
  const got = Buffer.from(header.slice(7), 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

type LeadRef = { leadgen_id: string; page_id: string | null; form_id: string | null; ad_id: string | null }

/** Los leads de un payload de webhook (entry[].changes[] con field "leadgen"). Lo que no tenga leadgen_id se ignora. */
export function leadsOf(body: unknown): LeadRef[] {
  const out: LeadRef[] = []
  const entries = (body as { entry?: unknown[] } | null)?.entry
  if (!Array.isArray(entries)) return out
  for (const e of entries as { id?: unknown; changes?: { field?: string; value?: Record<string, unknown> }[] }[]) {
    for (const ch of e.changes ?? []) {
      const v = ch.value ?? {}
      if (ch.field !== 'leadgen' || typeof v.leadgen_id !== 'string' && typeof v.leadgen_id !== 'number') continue
      const str = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x) : null)
      out.push({ leadgen_id: String(v.leadgen_id), page_id: str(v.page_id) ?? str(e.id), form_id: str(v.form_id), ad_id: str(v.ad_id) })
    }
  }
  return out
}

/** Guarda los leads nuevos (los repetidos se ignoran) y devuelve los ids que hay que procesar. */
export async function storeLeads(leads: LeadRef[]): Promise<string[]> {
  if (!leads.length) return []
  const { rows } = await pool.query(
    `INSERT INTO meta_leads (leadgen_id, page_id, form_id, ad_id)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT (leadgen_id) DO NOTHING RETURNING leadgen_id`,
    [leads.map((l) => l.leadgen_id), leads.map((l) => l.page_id), leads.map((l) => l.form_id), leads.map((l) => l.ad_id)],
  )
  return rows.map((r) => r.leadgen_id as string)
}

// ---------- responsable (reparto equitativo) ----------
/** Elis, Jorbi y Leandro por defecto; META_LEADS_OWNER (nombres separados por coma) permite sumar o cambiar. */
async function pickOwner(): Promise<{ id: string; name: string }> {
  const names = (process.env.META_LEADS_OWNER ?? 'Elis,Jorbi,Leandro').split(',').map((n) => n.trim()).filter(Boolean)
  const { rows } = await pool.query('SELECT id, name FROM users WHERE active ORDER BY name')
  const pool_ = names.map((n) => rows.find((u) => u.name.toLowerCase() === n.toLowerCase())).filter(Boolean) as { id: string; name: string }[]
  const candidates = pool_.length ? pool_ : (rows as { id: string; name: string }[])
  if (!candidates.length) throw new HttpError(500, 'No hay socios activos para asignar el lead')
  // Reparto equitativo: el que menos leads de Meta lleva (empate: el primero de la lista).
  const counts = (
    await pool.query(`SELECT created_by, count(*)::int AS n FROM clients WHERE lead_source = 'meta_ads' AND created_by = ANY($1::uuid[]) GROUP BY created_by`, [
      candidates.map((c) => c.id),
    ])
  ).rows
  const n = (id: string) => counts.find((c) => c.created_by === id)?.n ?? 0
  return candidates.reduce((best, c) => (n(c.id) < n(best.id) ? c : best))
}

// ---------- datos del lead ----------
type Graph = {
  created_time?: string
  field_data?: { name: string; values?: string[] }[]
  ad_id?: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
  campaign_id?: string
  campaign_name?: string
  form_id?: string
}

async function fetchLead(leadgenId: string): Promise<Graph> {
  const ver = process.env.META_GRAPH_VERSION ?? 'v21.0'
  // META_GRAPH_BASE solo se cambia en las pruebas (un Graph falso local); en produccion es siempre graph.facebook.com.
  const base = process.env.META_GRAPH_BASE ?? 'https://graph.facebook.com'
  const url = `${base}/${ver}/${encodeURIComponent(leadgenId)}?fields=${GRAPH_FIELDS}&access_token=${encodeURIComponent(need('META_PAGE_TOKEN'))}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Graph respondió ${res.status}`)
  return (await res.json()) as Graph
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const STANDARD = new Set(['full_name', 'first_name', 'last_name', 'email', 'phone_number', 'company_name', 'city', 'job_title'])

/** Convierte las respuestas del formulario en campos de la ficha; lo que no valida se deja en las notas, nunca rompe el alta. */
export function mapLead(g: Graph) {
  const val = new Map<string, string>()
  for (const f of g.field_data ?? []) if (f.values?.[0]?.trim()) val.set(f.name, f.values[0].trim())
  const person = val.get('full_name') ?? ([val.get('first_name'), val.get('last_name')].filter(Boolean).join(' ') || undefined)
  const company = val.get('company_name')
  const name = (company ?? person ?? 'Lead de Meta Ads').slice(0, 80)
  const extra: string[] = []
  const ficha: Record<string, unknown> = { origen: 'meta_ads', etiquetas: ['Meta Ads'] }
  const put = (key: keyof typeof fichaShape, v: string | undefined, label: string) => {
    if (!v) return
    const ok = fichaShape[key].safeParse(v)
    if (ok.success) ficha[key] = ok.data
    else extra.push(`${label} (no válido): ${v}`)
  }
  put('telefono', val.get('phone_number'), 'Teléfono')
  put('email', val.get('email'), 'Email')
  if (company && person) put('contacto_nombre', person, 'Contacto')
  put('contacto_cargo', val.get('job_title'), 'Cargo')
  put('direccion', val.get('city'), 'Ciudad')
  for (const [k, v] of val) if (!STANDARD.has(k)) extra.push(`${k.replace(/_/g, ' ')}: ${v}`)
  const origin = [g.campaign_name && `Campaña: ${g.campaign_name}`, g.adset_name && `Conjunto: ${g.adset_name}`, g.ad_name && `Anuncio: ${g.ad_name}`].filter(Boolean)
  const notes = [...origin, ...extra].join('\n').slice(0, 4000)
  if (notes) ficha.notas = notes
  return { name, ficha, notes }
}

// ---------- procesar un lead ----------
/** Crea el posible cliente (o anota el duplicado) y avisa. Idempotente: un lead ya procesado no se vuelve a procesar. */
export async function processLead(leadgenId: string): Promise<'procesado' | 'duplicado' | 'omitido'> {
  const row = (await pool.query(`SELECT status FROM meta_leads WHERE leadgen_id = $1`, [leadgenId])).rows[0]
  if (!row || row.status === 'procesado' || row.status === 'duplicado') return 'omitido'
  try {
    const g = await fetchLead(leadgenId)
    const { name, ficha } = mapLead(g)
    const owner = await pickOwner()
    const stages = await loadStages(pool)
    const entry = entryStage(stages)
    const phone = digits(ficha.telefono as string | undefined)
    const email = (ficha.email as string | undefined)?.toLowerCase()

    const result = await tx(async (c) => {
      // Bloquea la fila del lead: dos procesos a la vez no lo crean dos veces.
      const cur = (await c.query('SELECT status FROM meta_leads WHERE leadgen_id = $1 FOR UPDATE', [leadgenId])).rows[0]
      if (!cur || cur.status === 'procesado' || cur.status === 'duplicado') return null
      const dup = (
        await c.query(
          `SELECT id, name FROM clients
           WHERE ($1::text <> '' AND length(regexp_replace(coalesce(phone, ''), '\\D', '', 'g')) >= 7 AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right($1, 10))
              OR ($2::text IS NOT NULL AND lower(email) = $2)
           ORDER BY created_at LIMIT 1`,
          [phone, email ?? null],
        )
      ).rows[0]
      const setLead = (status: string, clientId: string) =>
        c.query(
          `UPDATE meta_leads SET status = $2, client_id = $3, error = NULL, processed_at = now(), attempts = attempts + 1, raw = $4::jsonb,
             campaign_id = $5, campaign_name = $6, adset_id = $7, adset_name = $8, ad_id = COALESCE($9, ad_id), ad_name = $10, form_id = COALESCE($11, form_id)
           WHERE leadgen_id = $1`,
          [leadgenId, status, clientId, JSON.stringify(g), g.campaign_id ?? null, g.campaign_name ?? null, g.adset_id ?? null, g.adset_name ?? null, g.ad_id ?? null, g.ad_name ?? null, g.form_id ?? null],
        )

      if (dup) {
        await c.query(`INSERT INTO interactions (client_id, kind, summary, created_by) VALUES ($1, 'nota', $2, $3)`, [
          dup.id,
          `Volvió a llegar por Meta Ads${g.campaign_name ? ` (campaña ${g.campaign_name})` : ''}: mismo teléfono o email. No se creó otro cliente.`,
          owner.id,
        ])
        await setLead('duplicado', dup.id)
        return 'duplicado' as const
      }

      const { rows } = await c.query(
        `INSERT INTO clients (name, avatar, created_by, is_prospect, pipeline_stage, probability, stage_changed_at)
         VALUES ($1, $2, $3, true, $4, $5, now()) RETURNING id`,
        [name, AVATARS[Math.floor(Math.random() * AVATARS.length)], owner.id, entry.key, entry.probability],
      )
      const clientId = rows[0].id as string
      await applyClientPatch(c, owner.id, clientId, ficha as ClientPatch, 'meta')
      await c.query(`INSERT INTO interactions (client_id, kind, summary, created_by) VALUES ($1, 'nota', $2, $3)`, [
        clientId,
        `Lead de Meta Ads asignado a ${owner.name}${g.campaign_name ? `. Campaña: ${g.campaign_name}` : ''}`,
        owner.id,
      ])
      await setLead('procesado', clientId)
      await recordActivity(c, { kind: 'lead_meta', actorId: owner.id, subject: name, detail: `Responsable: ${owner.name}`, clientId, via: 'meta' })
      return 'procesado' as const
    })
    return result ?? 'omitido'
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300)
    // Espera creciente (2, 8, 18... minutos); pasado el maximo queda en 'error' sin mas intentos para revisarlo a mano.
    await pool.query(
      `UPDATE meta_leads SET status = 'error', error = $2, attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => (LEAST(attempts + 1, 6) * LEAST(attempts + 1, 6) * 2)::int) WHERE leadgen_id = $1`,
      [leadgenId, msg],
    )
    console.error(`meta: lead ${leadgenId}:`, msg)
    return 'omitido'
  }
}

/** Reintenta los leads recibidos o con error cuya espera ya paso. */
export async function processPending(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT leadgen_id FROM meta_leads WHERE status IN ('recibido', 'error') AND attempts < $1 AND next_attempt_at <= now() ORDER BY received_at LIMIT 20`,
    [MAX_ATTEMPTS],
  )
  for (const r of rows) await processLead(r.leadgen_id)
  return rows.length
}

let timer: NodeJS.Timeout | null = null
export function startMetaWorker() {
  if (!metaEnabled() || timer) return
  timer = setInterval(() => void processPending().catch((e) => console.error('meta:', (e as Error).message)), Number(process.env.META_RETRY_MS) || 60_000)
  timer.unref()
}
export const stopMetaWorker = () => {
  if (timer) clearInterval(timer)
  timer = null
}

// ---------- rutas ----------
export const metaRouter = Router()

// Apagado: ni siquiera se sabe que la ruta existe.
metaRouter.use((_req, _res, next) => (metaEnabled() ? next() : next(new HttpError(404, 'No encontrado'))))

// Verificacion de la suscripcion (Meta la llama una vez al configurar el webhook).
metaRouter.get('/', (req, res) => {
  const q = z.object({ 'hub.mode': z.string(), 'hub.verify_token': z.string(), 'hub.challenge': z.string() }).safeParse(req.query)
  if (!q.success || q.data['hub.mode'] !== 'subscribe') throw new HttpError(400, 'Verificación inválida')
  const token = Buffer.from(q.data['hub.verify_token'])
  const want = Buffer.from(need('META_VERIFY_TOKEN'))
  if (token.length !== want.length || !timingSafeEqual(token, want)) throw new HttpError(403, 'Token de verificación incorrecto')
  res.type('text/plain').send(q.data['hub.challenge'])
})

// Cuerpo CRUDO: la firma se calcula sobre los bytes exactos, asi que no puede pasar antes por express.json().
metaRouter.post('/', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!validSignature(raw, req.header('x-hub-signature-256'), need('META_APP_SECRET'))) throw new HttpError(401, 'Firma inválida')
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HttpError(400, 'JSON inválido')
  }
  const fresh = await storeLeads(leadsOf(body))
  res.status(200).json({ recibidos: fresh.length }) // Meta exige 200 rapido; el detalle se pide a Graph despues
  for (const id of fresh) void processLead(id)
})
