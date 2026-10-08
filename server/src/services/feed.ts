// Feed de oportunidades (planeta HAYAI / hub): lo que la máquina y los agentes ENCONTRARON (ideas del radar, prospectos del cazador,
// negocios de las video-auditorías, alertas de competencia, noticias y propuestas manuales). La Bitácora cuenta lo que el equipo
// HIZO; esto es lo que llega de afuera. Un servicio para la web, la API v1 y el MCP.
//
// Varias vías de publicación al MISMO endpoint: los crons de Growi, el Muse de cada socio con su propia llave y, a futuro, Gumloop
// directo (conector MCP o nodo HTTP al mismo POST /feed: no hace falta código nuevo, solo una llave). Quién publica sale SIEMPRE de
// la llave (published_by); `fuente` es el origen lógico (qué automatización o qué Muse).
//
// Estado por socio (v1.6.5): revisar, descartar y guardar son PERSONALES (tabla feed_item_usuarios) y no afectan a los demás. Lo global
// es feed_items.status: 'nuevo' o 'convertido' (convertir en posible cliente / tarea / proyecto lo ve todo el equipo).
import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { stamp } from '../concurrency.ts'
import { SOURCES, fichaShape } from '../crm.ts'
import { pool, tx, type Db } from '../db.ts'
import { HttpError, id, text } from '../util.ts'
import { boolFlag, exec, filters, op, pageShape, paged, TZ, type Actor } from './common.ts'
import { clienteCrear } from './clientes.ts'
import { interaccionRegistrar } from './interacciones.ts'
import { proyectoCrear } from './proyectos.ts'
import { tareaCrear } from './tareas.ts'

export const TIPOS = ['idea', 'prospecto', 'alerta', 'noticia', 'oportunidad', 'proyecto'] as const
export const ESTADOS = ['nuevo', 'revisado', 'descartado', 'convertido'] as const
/** Los tipos que avisan en la campana al publicarse (el resto se ve en el feed sin interrumpir). */
export const TIPOS_AVISO = ['alerta', 'noticia', 'prospecto'] as const
export const CONVERSIONES = ['posible_cliente', 'tarea', 'proyecto'] as const
/** Cuántos días sigue en la campana el aviso de un ítem nuevo que nadie ha revisado. */
export const AVISO_DIAS = 14
/** Si una fuente ya avisó de un tipo hace menos de esto, la siguiente publicación no repite el aviso en vivo (una siembra de 20 es UN aviso). */
const AVISO_AGRUPA_MIN = 10

const tipo = z.enum(TIPOS, `Tipo inválido (${TIPOS.join(', ')})`)
const estado = z.enum(ESTADOS, `Estado inválido (${ESTADOS.join(', ')})`)
/** Nombre anterior de lo que hoy es Growi: si algún flujo viejo sigue publicando con él, cae en `growi` (misma clave externa = no se duplica). */
const FUENTES_ANTIGUAS: Record<string, string> = { 'gumloop-video-auditorias': 'growi' }
const fuente = z
  .string('fuente es obligatoria')
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{0,59}$/, 'fuente: minúsculas, números, punto, guion o guion bajo (máx. 60), p. ej. growi, muse-elis o manual')
  .transform((v) => FUENTES_ANTIGUAS[v] ?? v)
/** Categoría del negocio o la noticia (restaurante, panadería, salud, mercado, servicios…): minúsculas, hasta 40 caracteres. */
const categoria = z
  .string('categoria inválida')
  .trim()
  .toLowerCase()
  .min(1, 'categoria no puede estar vacía')
  .max(40, 'categoria: máximo 40 caracteres')

const jsonLibre = z
  .record(z.string(), z.unknown(), 'datos debe ser un objeto JSON')
  .refine((v) => JSON.stringify(v).length <= 60_000, 'datos es demasiado grande (máx. ~60 KB)')

/** Fecha del hallazgo: un día (AAAA-MM-DD) o un instante con zona; nunca en el futuro. */
const fechaHallazgo = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], 'fecha inválida (AAAA-MM-DD o con hora y zona)')
  .refine((v) => Date.parse(v) <= Date.now() + 5 * 60_000, 'La fecha del hallazgo no puede ser futura')

const itemShape = {
  titulo: text(160),
  resumen: text(2000).nullish(),
  tipo,
  fuente,
  clave_externa: text(200).nullish(), // idempotencia por fuente: la misma (fuente, clave_externa) no se publica dos veces
  categoria: categoria.nullish(),
  datos: jsonLibre.optional(), // negocio, fugas, guion, URLs, métricas… forma libre
  fecha: fechaHallazgo.optional(),
}
const itemSchema = z.strictObject(itemShape)
type Item = z.infer<typeof itemSchema>

// ---------- salida ----------
/** `u` es el marcador ($n) del id del socio que mira: su estado personal y sus guardados salen de feed_item_usuarios. */
const SELECT = (u: string) => `SELECT f.id, f.title, f.summary, f.kind, f.source, f.external_key, f.category, f.status, f.data, f.found_at, f.status_at, f.converted_to, f.converted_id,
    f.created_at, f.updated_at, pu.id AS pub_id, pu.name AS pub_name, su.name AS status_by,
    mu.status AS my_status, mu.discard_reason AS my_reason, COALESCE(mu.saved, false) AS saved
  FROM feed_items f JOIN users pu ON pu.id = f.published_by LEFT JOIN users su ON su.id = f.status_by
  LEFT JOIN feed_item_usuarios mu ON mu.item_id = f.id AND mu.user_id = ${u}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const itemOut = (r: any) => ({
  id: r.id as string,
  titulo: r.title as string,
  resumen: (r.summary ?? null) as string | null,
  tipo: r.kind as (typeof TIPOS)[number],
  fuente: r.source as string,
  categoria: (r.category ?? null) as string | null,
  clave_externa: (r.external_key ?? null) as string | null,
  publicado_por: { id: r.pub_id as string, nombre: r.pub_name as string },
  /** GLOBAL: nuevo o convertido. Lo que cada socio revisó o descartó es suyo: mira mi_estado. */
  estado: (r.status === 'convertido' ? 'convertido' : 'nuevo') as 'nuevo' | 'convertido',
  /** PERSONAL (del socio que consulta): nuevo | revisado | descartado. */
  mi_estado: (r.my_status ?? 'nuevo') as 'nuevo' | 'revisado' | 'descartado',
  motivo_descarte: (r.my_reason ?? null) as string | null,
  /** PERSONAL: lo guardó el socio que consulta. */
  guardado: !!r.saved,
  datos: (r.data ?? {}) as Record<string, unknown>,
  fecha: (r.found_at as Date).toISOString(),
  publicado_el: (r.created_at as Date).toISOString(),
  convertido: r.converted_to
    ? { a: r.converted_to as (typeof CONVERSIONES)[number], id: (r.converted_id ?? null) as string | null, por: (r.status_by ?? null) as string | null, el: r.status_at ? (r.status_at as Date).toISOString() : null }
    : null,
  actualizado_el: stamp(r.updated_at),
})

async function item(db: Db, itemId: string, userId: string) {
  const r = (await db.query(`${SELECT('$2')} WHERE f.id = $1`, [itemId, userId])).rows[0]
  if (!r) throw new HttpError(404, 'Ítem del feed no encontrado')
  return itemOut(r)
}

// ---------- listar ----------
/** Estado visto por el socio: convertido (global) manda; si no, el suyo (sin fila = nuevo). */
const MI_ESTADO = `CASE WHEN f.status = 'convertido' THEN 'convertido' ELSE COALESCE(mu.status, 'nuevo') END`
const joinMi = (u: string) => `LEFT JOIN feed_item_usuarios mu ON mu.item_id = f.id AND mu.user_id = ${u}`

export const feedListar = op(
  z.strictObject({
    tipo: tipo.optional(),
    estado: estado.optional(), // el que ve este socio: nuevo | revisado | descartado | convertido
    fuente: fuente.optional(),
    categoria: z.union([categoria, z.literal('sin_categoria')]).optional(),
    guardado: boolFlag.optional(), // true: solo los que este socio guardó
    q: z.string().trim().min(1).max(100).optional(), // busca en título y resumen
    ...pageShape,
  }),
  async (actor, i) => {
    const g = filters()
    if (i.tipo) g.add('f.kind = ?', i.tipo)
    if (i.estado) g.add(`${MI_ESTADO} = ?`, i.estado)
    if (i.fuente) g.add('f.source = ?', i.fuente)
    if (i.categoria) i.categoria === 'sin_categoria' ? g.raw('f.category IS NULL') : g.add('f.category = ?', i.categoria)
    if (i.guardado !== undefined) g.raw(i.guardado === true || i.guardado === 'true' ? 'COALESCE(mu.saved, false)' : 'NOT COALESCE(mu.saved, false)')
    if (i.q) g.add(`fold(f.title || ' ' || COALESCE(f.summary, '')) LIKE '%' || fold(?) || '%'`, i.q)
    const n = g.params().length
    const me = `$${n + 1}` // el socio que mira: siempre el parámetro siguiente a los de los filtros
    const [total, rows, porEstado, porTipo, fuentes, categorias, extra] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM feed_items f ${joinMi(me)} ${g.where()}`, [...g.params(), actor.id]),
      pool.query(`${SELECT(me)} ${g.where()} ORDER BY f.found_at DESC, f.created_at DESC, f.id LIMIT $${n + 2} OFFSET $${n + 3}`, [...g.params(), actor.id, i.per_page, (i.page - 1) * i.per_page]),
      // Contadores (no dependen del filtro; son los de este socio): sirven para el "N nuevos" y para armar los filtros.
      pool.query(`SELECT ${MI_ESTADO} AS e, count(*)::int AS n FROM feed_items f ${joinMi('$1')} GROUP BY 1`, [actor.id]),
      pool.query(`SELECT f.kind, count(*)::int AS n, count(*) FILTER (WHERE ${MI_ESTADO} = 'nuevo')::int AS nuevos FROM feed_items f ${joinMi('$1')} GROUP BY f.kind`, [actor.id]),
      pool.query(`SELECT f.source, count(*)::int AS n, count(*) FILTER (WHERE ${MI_ESTADO} = 'nuevo')::int AS nuevos FROM feed_items f ${joinMi('$1')} GROUP BY f.source ORDER BY 3 DESC, 2 DESC, 1`, [actor.id]),
      pool.query(`SELECT f.category, count(*)::int AS n FROM feed_items f WHERE f.category IS NOT NULL GROUP BY f.category ORDER BY 2 DESC, 1`),
      pool.query(`SELECT count(*) FILTER (WHERE COALESCE(mu.saved, false))::int AS guardados, count(*) FILTER (WHERE f.category IS NULL)::int AS sin_categoria FROM feed_items f ${joinMi('$1')}`, [actor.id]),
    ])
    const por_estado = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<string, number>
    for (const r of porEstado.rows) por_estado[r.e] = r.n
    const por_tipo = Object.fromEntries(TIPOS.map((t) => [t, { total: 0, nuevos: 0 }])) as Record<string, { total: number; nuevos: number }>
    for (const r of porTipo.rows) por_tipo[r.kind] = { total: r.n, nuevos: r.nuevos }
    return paged(rows.rows.map(itemOut), total.rows[0].n, i.page, i.per_page, {
      nuevos: por_estado.nuevo,
      guardados: extra.rows[0].guardados as number,
      por_estado,
      por_tipo,
      fuentes: fuentes.rows.map((r) => ({ fuente: r.source as string, total: r.n as number, nuevos: r.nuevos as number })),
      categorias: categorias.rows.map((r) => ({ categoria: r.category as string, total: r.n as number })),
      sin_categoria: extra.rows[0].sin_categoria as number,
    })
  },
)

export const feedVer = op(z.strictObject({ id }), (actor, i) => item(pool, i.id, actor.id))

// ---------- publicar ----------
const PLURAL: Record<(typeof TIPOS)[number], [string, string]> = {
  idea: ['idea nueva', 'ideas nuevas'],
  prospecto: ['prospecto nuevo', 'prospectos nuevos'],
  alerta: ['alerta nueva', 'alertas nuevas'],
  noticia: ['noticia nueva', 'noticias nuevas'],
  oportunidad: ['oportunidad nueva', 'oportunidades nuevas'],
  proyecto: ['proyecto nuevo', 'proyectos nuevos'],
}

type Resultado = { item: ReturnType<typeof itemOut>; creado: boolean }

/** Inserta un ítem (o devuelve el que ya existía con esa fuente y clave). No avisa: avisar es cosa de quien publicó el lote completo. */
async function insertar(c: Db, actor: Actor, b: Item): Promise<Resultado> {
  const ins = await c.query(
    `INSERT INTO feed_items (title, summary, kind, source, external_key, published_by, data, found_at, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()), $9)
     ON CONFLICT (source, external_key) WHERE external_key IS NOT NULL DO NOTHING RETURNING id`,
    [b.titulo, b.resumen ?? null, b.tipo, b.fuente, b.clave_externa ?? null, actor.id, JSON.stringify(b.datos ?? {}), b.fecha ?? null, b.categoria ?? null],
  )
  if (ins.rowCount) return { item: await item(c, ins.rows[0].id, actor.id), creado: true }
  const ya = (await c.query('SELECT id FROM feed_items WHERE source = $1 AND external_key = $2', [b.fuente, b.clave_externa])).rows[0]
  // Volver a publicar lo mismo no duplica; solo le pone la categoría si todavía no tenía (así se completan los ya publicados).
  if (b.categoria) await c.query('UPDATE feed_items SET category = $2 WHERE id = $1 AND category IS NULL', [ya.id, b.categoria])
  return { item: await item(c, ya.id, actor.id), creado: false }
}

/**
 * Aviso en vivo (y en la campana) de lo recién publicado: solo alerta, noticia y prospecto, y UNO por (fuente, tipo) y lote.
 * Si esa fuente ya avisó de ese tipo hace unos minutos, no se repite: una siembra de 20 prospectos no inunda a nadie.
 */
async function avisar(c: Db, actor: Actor, nuevos: { tipo: (typeof TIPOS)[number]; fuente: string; titulo: string; antes: number }[]) {
  const grupos = new Map<string, { tipo: (typeof TIPOS)[number]; fuente: string; titulos: string[]; antes: number }>()
  for (const n of nuevos) {
    if (!(TIPOS_AVISO as readonly string[]).includes(n.tipo)) continue
    const g = grupos.get(`${n.fuente}|${n.tipo}`) ?? { tipo: n.tipo, fuente: n.fuente, titulos: [], antes: n.antes }
    g.titulos.push(n.titulo)
    grupos.set(`${n.fuente}|${n.tipo}`, g)
  }
  for (const g of grupos.values()) {
    if (g.antes > 0) continue // esa fuente ya avisó de este tipo hace poco
    const [uno, varios] = PLURAL[g.tipo]
    const subject = g.titulos.length === 1 ? `${uno}: ${g.titulos[0]}` : `${g.titulos.length} ${varios} de ${g.fuente}`
    await recordActivity(c, { kind: 'feed_nuevo', actorId: actor.id, subject: subject.length > 160 ? `${subject.slice(0, 157)}...` : subject, detail: g.tipo, via: actor.via })
  }
}

export const feedPublicar = op(
  z
    .strictObject({
      ...Object.fromEntries(Object.entries(itemShape).map(([k, v]) => [k, (v as z.ZodType).optional()])),
      // Varios de una vez (hasta 50): cada uno con la misma forma que uno solo. No se mezcla con los campos sueltos.
      items: z.array(itemSchema, 'items debe ser una lista').min(1, 'items no puede estar vacío').max(50, 'Máximo 50 ítems por envío').optional(),
    } as { [K in keyof typeof itemShape]: z.ZodOptional<(typeof itemShape)[K]> } & { items: z.ZodOptional<z.ZodArray<typeof itemSchema>> })
    .refine(
      (v) => {
        const suelto = [v.titulo, v.tipo, v.fuente, v.resumen, v.clave_externa, v.categoria, v.datos, v.fecha].some((x) => x !== undefined)
        return v.items !== undefined ? !suelto : v.titulo !== undefined && v.tipo !== undefined && v.fuente !== undefined
      },
      'Envía un ítem (titulo, tipo y fuente son obligatorios) o una lista en items, no las dos cosas',
    ),
  async (actor, b) => {
    const lista: Item[] = b.items ?? [itemSchema.parse({ titulo: b.titulo, resumen: b.resumen, tipo: b.tipo, fuente: b.fuente, clave_externa: b.clave_externa, categoria: b.categoria, datos: b.datos, fecha: b.fecha })]
    const resultados = await tx(async (c) => {
      // Cuántos de cada (fuente, tipo) hubo ya hace poco: decide si este lote vuelve a avisar.
      const previos = new Map<string, number>()
      for (const it of lista) {
        const k = `${it.fuente}|${it.tipo}`
        if (!previos.has(k))
          previos.set(
            k,
            (await c.query(`SELECT count(*)::int AS n FROM feed_items WHERE source = $1 AND kind = $2 AND created_at > now() - make_interval(mins => $3)`, [it.fuente, it.tipo, AVISO_AGRUPA_MIN])).rows[0].n,
          )
      }
      const out: Resultado[] = []
      for (const it of lista) out.push(await insertar(c, actor, it))
      await avisar(
        c,
        actor,
        out.flatMap((r, i) => (r.creado ? [{ tipo: lista[i].tipo, fuente: lista[i].fuente, titulo: lista[i].titulo, antes: previos.get(`${lista[i].fuente}|${lista[i].tipo}`) ?? 0 }] : [])),
      )
      return out
    })
    // Un ítem: el ítem y si se creó. Varios: el resumen del lote y el resultado de cada uno, en el orden enviado.
    if (!b.items) return { ...resultados[0].item, creado: resultados[0].creado }
    return {
      recibidos: resultados.length,
      creados: resultados.filter((r) => r.creado).length,
      duplicados: resultados.filter((r) => !r.creado).length,
      data: resultados.map((r) => ({ ...r.item, creado: r.creado })),
    }
  },
)

// ---------- estado personal ----------
/** Revisar, descartar o volver a «nuevo» lo que ve ESTE socio; a los demás no les cambia nada. */
export const feedMarcar = op(
  z.strictObject({
    id,
    estado: z.enum(['nuevo', 'revisado', 'descartado'], 'Estado inválido (nuevo, revisado o descartado; convertido se logra con convertir)'),
    motivo: text(200).nullish(), // solo al descartar
  }),
  async (actor, b) => {
    if (b.motivo && b.estado !== 'descartado') throw new HttpError(400, 'motivo solo aplica al descartar')
    await tx(async (c) => {
      const cur = (await c.query('SELECT status FROM feed_items WHERE id = $1 FOR SHARE', [b.id])).rows[0]
      if (!cur) throw new HttpError(404, 'Ítem del feed no encontrado')
      if (cur.status === 'convertido') throw new HttpError(409, 'Este ítem ya se convirtió en algo real: no cambia de estado')
      await c.query(
        `INSERT INTO feed_item_usuarios (item_id, user_id, status, discard_reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (item_id, user_id) DO UPDATE SET status = EXCLUDED.status, discard_reason = EXCLUDED.discard_reason, updated_at = now()`,
        [b.id, actor.id, b.estado === 'nuevo' ? null : b.estado, b.estado === 'descartado' ? (b.motivo ?? null) : null],
      )
    })
    return item(pool, b.id, actor.id)
  },
)

/** Guardar (o quitar de guardados) un ítem: es un marcador personal, sirve también en los ya convertidos. */
export const feedGuardar = op(z.strictObject({ id, guardado: z.boolean('guardado debe ser true o false').default(true) }), async (actor, b) => {
  await tx(async (c) => {
    if (!(await c.query('SELECT 1 FROM feed_items WHERE id = $1 FOR SHARE', [b.id])).rowCount) throw new HttpError(404, 'Ítem del feed no encontrado')
    await c.query(
      `INSERT INTO feed_item_usuarios (item_id, user_id, saved) VALUES ($1, $2, $3)
       ON CONFLICT (item_id, user_id) DO UPDATE SET saved = EXCLUDED.saved, updated_at = now()`,
      [b.id, actor.id, b.guardado],
    )
  })
  return item(pool, b.id, actor.id)
})

// ---------- convertir ----------
const linea = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? null : `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [])
const nombreDe = (d: Record<string, unknown>): string | undefined => {
  const n = d.negocio
  if (typeof n === 'string') return str(n)
  if (n && typeof n === 'object') return str((n as Record<string, unknown>).nombre) ?? str((n as Record<string, unknown>).name)
  return str(d.nombre)
}

/** Texto de contexto con lo que trae el ítem (resumen, fuente, fugas, guion, enlaces, métricas): lo que se pre-llena en notas o descripción. */
function contexto(f: ReturnType<typeof itemOut>, max: number): string {
  const d = f.datos
  const partes = [
    `Del feed de oportunidades (${f.fuente}, ${f.fecha.slice(0, 10)}): ${f.titulo}`,
    f.resumen,
    ...(lista(d.fugas).length ? ['Fugas detectadas:', ...lista(d.fugas).map((x) => `- ${x}`)] : []),
    str(d.guion) ? `Guion: ${str(d.guion)}` : null,
    ...(lista(d.urls).length ? ['Enlaces:', ...lista(d.urls).map((x) => `- ${x}`)] : []),
    d.metricas && typeof d.metricas === 'object' ? linea('Métricas', d.metricas) : null,
  ].filter((x): x is string => !!x)
  const t = partes.join('\n')
  return cortar(t, max)
}

/** Recorta a `max` caracteres sin partir una palabra (si la primera palabra ya no cabe, corta ahí). */
export const cortar = (s: string, max: number) => {
  if (s.length <= max) return s
  const base = s.slice(0, max - 1)
  const sp = base.lastIndexOf(' ')
  return `${(sp > max * 0.4 ? base.slice(0, sp) : base).trimEnd().replace(/[,;:.\-–—]+$/, '')}…`
}

const convertirShape = z.strictObject({
  id,
  a: z.enum(CONVERSIONES, `a inválido (${CONVERSIONES.join(', ')})`),
  // posible_cliente (todo opcional: se pre-llena con el ítem)
  nombre: text(80).optional(),
  origen: z.enum(SOURCES, `Origen inválido (${SOURCES.join(', ')})`).optional(),
  notas: text(4000).optional(),
  telefono: fichaShape.telefono,
  email: fichaShape.email,
  valor_estimado: fichaShape.valor_estimado,
  // tarea
  titulo: text(160).optional(),
  proyecto_id: id.optional(), // sin él, la tarea va al proyecto interno de HAYAI
  vence: z.iso.date('Fecha inválida (usa AAAA-MM-DD)').optional(),
  // tarea y proyecto
  responsable: text(80).optional(),
  // proyecto
  cliente_id: id.optional(),
  descripcion: text(4000).optional(),
})

/** El proyecto interno de HAYAI donde caen las tareas sin proyecto: el más antiguo activo sin cliente; si no hay, se crea. */
async function proyectoInterno(actor: Actor): Promise<string> {
  const r = (
    await pool.query(
      `SELECT id FROM projects WHERE client_id IS NULL AND archived_at IS NULL AND status IN ('activo', 'entrega', 'planeacion') ORDER BY (status = 'activo') DESC, created_at, id LIMIT 1`,
    )
  ).rows[0]
  if (r) return r.id as string
  const p = (await exec(proyectoCrear, actor, { nombre: 'HAYAI interno', icono: 'box', estado: 'activo', descripcion: 'Tareas y trabajo interno de la empresa.' })) as { id: string }
  return p.id
}

export const feedConvertir = op(convertirShape, async (actor, b) => {
  // Se reclama el ítem ANTES de crear nada: dos socios tocando "Convertir" a la vez no duplican el cliente o la tarea.
  const antes = await tx(async (c) => {
    const cur = (await c.query('SELECT status, converted_to FROM feed_items WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
    if (!cur) throw new HttpError(404, 'Ítem del feed no encontrado')
    if (cur.status === 'convertido') throw new HttpError(409, `Este ítem ya se convirtió (${String(cur.converted_to).replace('_', ' ')}): no se convierte dos veces`)
    await c.query(`UPDATE feed_items SET status = 'convertido', converted_to = $2, discard_reason = NULL, status_by = $3, status_at = now() WHERE id = $1`, [b.id, b.a, actor.id])
    return cur.status as string
  })
  const f = await item(pool, b.id, actor.id)
  try {
    let creado: { id: string; [k: string]: unknown }
    if (b.a === 'posible_cliente') {
      const d = f.datos
      const deItem = str(d.origen)
      const origen: (typeof SOURCES)[number] = b.origen ?? (deItem && (SOURCES as readonly string[]).includes(deItem) ? (deItem as (typeof SOURCES)[number]) : 'otro')
      // El teléfono y el correo del ítem solo se usan si valen (no se rompe la conversión por un dato sucio de la fuente).
      const tel = b.telefono ?? (fichaShape.telefono.safeParse(str(d.telefono)).success ? str(d.telefono) : undefined)
      const mail = b.email ?? (fichaShape.email.safeParse(str(d.email)).success ? str(d.email) : undefined)
      creado = (await exec(clienteCrear, actor, {
        nombre: cortar(b.nombre ?? nombreDe(d) ?? f.titulo, 80),
        estado: 'posible',
        origen,
        notas: b.notas ?? contexto(f, 4000),
        ...(tel ? { telefono: tel } : {}),
        ...(mail ? { email: mail } : {}),
        ...(b.valor_estimado !== undefined ? { valor_estimado: b.valor_estimado } : {}),
      })) as { id: string }
      // Queda escrito en la bitácora del cliente de dónde salió.
      await exec(interaccionRegistrar, actor, { cliente_id: creado.id, tipo: 'nota', resumen: cortar(`Llegó del feed de oportunidades (${f.fuente}): ${f.titulo}`, 2000) })
    } else if (b.a === 'tarea') {
      const proyecto_id = b.proyecto_id ?? (await proyectoInterno(actor))
      creado = (await exec(tareaCrear, actor, {
        titulo: cortar(b.titulo ?? f.titulo, 160),
        proyecto_id,
        ...(b.vence ? { vence: b.vence } : {}),
        // sin responsable, la tarea es de quien la crea (el titular de la cuenta o de la llave)
        responsable: b.responsable ?? actor.name,
      })) as { id: string }
    } else {
      creado = (await exec(proyectoCrear, actor, {
        nombre: cortar(b.nombre ?? f.titulo, 80),
        descripcion: b.descripcion ?? contexto(f, 4000),
        ...(b.cliente_id ? { cliente_id: b.cliente_id } : {}),
        ...(b.responsable ? { responsable: b.responsable } : {}),
      })) as { id: string }
    }
    await pool.query('UPDATE feed_items SET converted_id = $2 WHERE id = $1', [b.id, creado.id])
    return { item: await item(pool, b.id, actor.id), creado: { tipo: b.a, id: creado.id, detalle: creado } }
  } catch (e) {
    // No se pudo crear (validación, 404...): el ítem vuelve a como estaba para poder reintentar con otros datos.
    await pool.query(`UPDATE feed_items SET status = $2, converted_to = NULL, converted_id = NULL, status_by = NULL, status_at = NULL WHERE id = $1`, [b.id, antes])
    throw e
  }
})

/** Para el hub: cuántos hay nuevos PARA ESE SOCIO (el feed completo se consulta con feedListar). */
export async function feedResumen(userId: string) {
  const r = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE f.status <> 'convertido' AND mu.status IS NULL)::int AS nuevos, count(*)::int AS total
       FROM feed_items f LEFT JOIN feed_item_usuarios mu ON mu.item_id = f.id AND mu.user_id = $1`,
      [userId],
    )
  ).rows[0]
  return { nuevos: r.nuevos as number, total: r.total as number }
}

/** Alertas derivadas de la campana de ese socio: ítems nuevos de alerta, noticia o prospecto que aún no revisó ni descartó (junto, por fuente y día, si son varios). */
export async function feedAlertas(userId: string): Promise<{ clave: string; fecha: string; titulo: string; detalle: string; cantidad: number; tipo: (typeof TIPOS)[number]; fuente: string; item_id: string | null }[]> {
  const { rows } = await pool.query(
    `SELECT f.id, f.title, f.kind, f.source, f.found_at, f.created_at, to_char(f.created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS dia
     FROM feed_items f LEFT JOIN feed_item_usuarios mu ON mu.item_id = f.id AND mu.user_id = $4
     WHERE f.status = 'nuevo' AND mu.status IS NULL AND f.kind = ANY($2::text[]) AND f.created_at > now() - make_interval(days => $3) ORDER BY f.created_at DESC, f.id`,
    [TZ, TIPOS_AVISO, AVISO_DIAS, userId],
  )
  const grupos = new Map<string, typeof rows>()
  for (const r of rows) grupos.set(`${r.kind}|${r.source}|${r.dia}`, [...(grupos.get(`${r.kind}|${r.source}|${r.dia}`) ?? []), r])
  return [...grupos.values()].map((g) => {
    const r = g[0]
    const t = r.kind as (typeof TIPOS)[number]
    const [uno, varios] = PLURAL[t]
    // Un solo ítem: su propia alerta. Varios del mismo origen y día: una sola, con la cuenta en la clave (si llegan más, vuelve a salir sin leer).
    return g.length === 1
      ? { clave: `feed:${r.id}`, fecha: r.dia as string, titulo: `${uno[0].toUpperCase()}${uno.slice(1)}: ${r.title}`, detalle: `Feed · ${r.source}`, cantidad: 1, tipo: t, fuente: r.source as string, item_id: r.id as string }
      : { clave: `feed:${r.kind}:${r.source}:${r.dia}:${g.length}`, fecha: r.dia as string, titulo: `${g.length} ${varios} en el feed`, detalle: `Feed · ${r.source}`, cantidad: g.length, tipo: t, fuente: r.source as string, item_id: null }
  })
}
