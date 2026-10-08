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
import { SOURCES, esquemaCobro, fichaShape } from '../crm.ts'
import { pool, tx, type Db } from '../db.ts'
import { HttpError, id, text } from '../util.ts'
import { boolFlag, exec, filters, op, pageShape, paged, TZ, type Actor } from './common.ts'
import { VINCULO_TABLA, type Vinculo } from '../feedLinks.ts'
import { sendToTrash } from '../trash.ts'
import { insertContenido } from '../mkContenido.ts'
import { userByName } from '../socios.ts'
import { clienteActualizar, clienteCrear } from './clientes.ts'
import { interaccionRegistrar } from './interacciones.ts'
import { proyectoCrear } from './proyectos.ts'
import { tareaCrear } from './tareas.ts'

export const TIPOS = ['idea', 'prospecto', 'alerta', 'noticia', 'oportunidad', 'proyecto'] as const
export const ESTADOS = ['nuevo', 'revisado', 'descartado', 'convertido'] as const
/** Los tipos que avisan en la campana al publicarse (el resto se ve en el feed sin interrumpir). */
export const TIPOS_AVISO = ['alerta', 'noticia', 'prospecto'] as const
export const CONVERSIONES = ['posible_cliente', 'cliente', 'tarea', 'proyecto', 'seguimiento', 'contenido'] as const
/** Cuánto dura la opción de «Deshacer» lo que se creó desde un ítem. */
const DESHACER_SEG = 120
/** Cuántos días sigue en la campana el aviso de un ítem nuevo que nadie ha revisado. */
export const AVISO_DIAS = 14
/** Si una fuente ya avisó de un tipo hace menos de esto, la siguiente publicación no repite el aviso en vivo (una siembra de 20 es UN aviso). */
const AVISO_AGRUPA_MIN = 10

const tipo = z.enum(TIPOS, `Tipo inválido (${TIPOS.join(', ')})`)
const estado = z.enum(ESTADOS, `Estado inválido (${ESTADOS.join(', ')})`)
/** Nombre anterior de lo que hoy es Growi: si algún flujo viejo sigue publicando con él, cae en `growi` (misma clave externa = no se duplica). */
const FUENTES_ANTIGUAS: Record<string, string> = { 'gumloop-video-auditorias': 'growi' }
export const fuente = z
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
  /** Con qué cliente está vinculado el ítem (lo calcula `enriquecer`). */
  vinculo: { estado: 'sin_vinculo', cliente_id: null, cliente: null, origen: null } as Vinculado,
  /** Lo que ya se creó desde el ítem, una de cada clase (global, lo ve todo el equipo). */
  creados: {} as Creados,
  actualizado_el: stamp(r.updated_at),
})

type Vinculado = { estado: 'sin_vinculo' | 'posible_cliente' | 'cliente'; cliente_id: string | null; cliente: string | null; origen: 'conversion' | 'datos' | 'nombre' | null }
type Creados = Partial<Record<Vinculo, { id: string; por: string; el: string }>>
type ItemOut = ReturnType<typeof itemOut>

const plano = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Le pone a cada ítem su vínculo con un cliente y lo ya creado. El vínculo sale, en este orden, de: lo convertido desde el ítem; `datos.cliente_id`;
 * `datos.cliente` (nombre que coincide con UN solo cliente no archivado). Lo creado que ya no existe (papelera) no cuenta.
 */
export async function enriquecer(db: Db, items: ItemOut[]): Promise<ItemOut[]> {
  if (!items.length) return items
  const links = (
    await db.query(
      `SELECT l.item_id, l.kind, l.ref_id, l.created_at, u.name AS por FROM feed_item_vinculos l JOIN users u ON u.id = l.created_by WHERE l.item_id = ANY($1::uuid[]) AND l.ref_id IS NOT NULL`,
      [items.map((i) => i.id)],
    )
  ).rows
  const existe = new Set<string>()
  for (const tabla of new Set(Object.values(VINCULO_TABLA))) {
    const refs = [...new Set(links.filter((l) => VINCULO_TABLA[l.kind as Vinculo] === tabla).map((l) => l.ref_id as string))]
    if (refs.length) for (const r of (await db.query(`SELECT id FROM ${tabla} WHERE id = ANY($1::uuid[])`, [refs])).rows) existe.add(r.id as string)
  }
  const vivos = links.filter((l) => existe.has(l.ref_id as string))
  const idDatos = (i: ItemOut) => (typeof i.datos.cliente_id === 'string' && UUID.test(i.datos.cliente_id) ? i.datos.cliente_id : null)
  const nombreDatos = (i: ItemOut) => str(i.datos.cliente) ?? str(i.datos.cliente_nombre) ?? null
  const ids = [...new Set([...vivos.filter((l) => l.kind === 'posible_cliente' || l.kind === 'cliente').map((l) => l.ref_id as string), ...items.flatMap((i) => idDatos(i) ?? [])])]
  const nombres = [...new Set(items.flatMap((i) => nombreDatos(i) ?? []).map(plano))]
  const cl = (
    await db.query(
      `SELECT id, name, is_prospect, archived_at FROM clients WHERE id = ANY($1::uuid[]) OR (archived_at IS NULL AND fold(name) = ANY(SELECT fold(x) FROM unnest($2::text[]) x))`,
      [ids, nombres],
    )
  ).rows
  const porId = new Map(cl.map((c) => [c.id as string, c]))
  return items.map((it) => {
    const mios = vivos.filter((l) => l.item_id === it.id)
    const creados: Creados = {}
    for (const l of mios) creados[l.kind as Vinculo] = { id: l.ref_id as string, por: l.por as string, el: (l.created_at as Date).toISOString() }
    const deConv = mios.find((l) => l.kind === 'cliente') ?? mios.find((l) => l.kind === 'posible_cliente')
    let c = deConv ? porId.get(deConv.ref_id as string) : undefined
    let origen: Vinculado['origen'] = c ? 'conversion' : null
    if (!c && idDatos(it)) (c = porId.get(idDatos(it)!)), (origen = c ? 'datos' : null)
    if (!c && nombreDatos(it)) {
      const hit = cl.filter((x) => !x.archived_at && plano(x.name as string) === plano(nombreDatos(it)!))
      if (hit.length === 1) (c = hit[0]), (origen = 'nombre')
    }
    const vinculo: Vinculado = c ? { estado: c.is_prospect ? 'posible_cliente' : 'cliente', cliente_id: c.id as string, cliente: c.name as string, origen } : { estado: 'sin_vinculo', cliente_id: null, cliente: null, origen: null }
    return { ...it, vinculo, creados }
  })
}

async function item(db: Db, itemId: string, userId: string) {
  const r = (await db.query(`${SELECT('$2')} WHERE f.id = $1`, [itemId, userId])).rows[0]
  if (!r) throw new HttpError(404, 'Ítem del feed no encontrado')
  return (await enriquecer(db, [itemOut(r)]))[0]
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
    return paged(await enriquecer(pool, rows.rows.map(itemOut)), total.rows[0].n, i.page, i.per_page, {
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

const CONTACTOS: [string, string[]][] = [
  ['Teléfono', ['telefono', 'phone']],
  ['WhatsApp', ['whatsapp']],
  ['Correo', ['correo', 'email']],
  ['Web', ['web', 'sitio']],
  ['Instagram', ['instagram']],
  ['Facebook', ['facebook']],
]
/** Los datos de contacto que trae el ítem, ya ordenados (de `datos.contacto` y, si no, de `datos.telefono` / `datos.email`). */
function contactoDe(d: Record<string, unknown>): [string, string][] {
  const c = d.contacto && typeof d.contacto === 'object' && !Array.isArray(d.contacto) ? (d.contacto as Record<string, unknown>) : {}
  const out: [string, string][] = []
  for (const [etiqueta, claves] of CONTACTOS) {
    const v = claves.map((k) => str(c[k]) ?? str(d[k])).find(Boolean)
    if (v) out.push([etiqueta, cortar(v, 200)])
  }
  return out
}

/**
 * La nota que queda en la ficha al convertir en posible cliente: ordenada y corta (no se vuelca todo el hallazgo).
 * «Del feed: fuente · fecha» + enlace al ítem original (ahí siguen las fugas, el guion y los enlaces), un resumen breve y el contacto en líneas.
 */
export function notaDeConversion(f: ReturnType<typeof itemOut>): string {
  const fecha = new Intl.DateTimeFormat('es', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(f.fecha)).replace(/\./g, '')
  const resumen = (f.resumen ?? '').replace(/\s+/g, ' ').trim()
  const contacto = contactoDe(f.datos)
  return [
    `Del feed: ${f.fuente} · ${fecha}\nÍtem original: #hub/feed/${f.id}`,
    resumen ? `Resumen\n${cortar(resumen, 280)}` : null,
    contacto.length ? `Contacto\n${contacto.map(([k, v]) => `${k}: ${v}`).join('\n')}` : null,
  ]
    .filter((x): x is string => !!x)
    .join('\n\n')
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
  // cliente (promover al posible cliente vinculado): día de implementación (hoy por defecto) y, si tiene propuesta vigente, el esquema de cobro
  fecha_implementacion: z.iso.date('Fecha inválida (usa AAAA-MM-DD)').optional(),
  esquema_cobro: esquemaCobro.optional(),
  // tarea y seguimiento
  titulo: text(160).optional(),
  proyecto_id: id.optional(), // sin él: un proyecto del cliente vinculado o, si no hay, el proyecto interno de HAYAI
  vence: z.iso.date('Fecha inválida (usa AAAA-MM-DD)').optional(), // el seguimiento la trae puesta (3 días)
  // tarea, seguimiento y proyecto
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

/** Dónde cae la tarea de un ítem: el proyecto activo del cliente vinculado; sin cliente (o sin proyecto), el interno de HAYAI. */
async function proyectoDeLaTarea(actor: Actor, clienteId: string | null): Promise<string> {
  if (clienteId) {
    const r = (
      await pool.query(
        `SELECT id FROM projects WHERE client_id = $1 AND archived_at IS NULL AND status IN ('activo', 'entrega', 'planeacion') ORDER BY (status = 'activo') DESC, created_at, id LIMIT 1`,
        [clienteId],
      )
    ).rows[0]
    if (r) return r.id as string
  }
  return proyectoInterno(actor)
}

const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const masDias = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const ETIQUETA: Record<Vinculo, string> = { posible_cliente: 'el posible cliente', cliente: 'el cliente', tarea: 'la tarea', proyecto: 'el proyecto', propuesta: 'la propuesta', seguimiento: 'el seguimiento', contenido: 'la pieza de contenido' }

export const feedConvertir = op(convertirShape, async (actor, b) => {
  // Se reclama la clase ANTES de crear nada: dos socios tocando "Convertir" a la vez no duplican el cliente o la tarea.
  const antes = await tx(async (c) => {
    const cur = (await c.query('SELECT status FROM feed_items WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
    if (!cur) throw new HttpError(404, 'Ítem del feed no encontrado')
    const prev = (await c.query('SELECT ref_id, created_at FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2', [b.id, b.a])).rows[0]
    if (prev) {
      const viva = prev.ref_id ? (await c.query(`SELECT 1 FROM ${VINCULO_TABLA[b.a]} WHERE id = $1`, [prev.ref_id])).rowCount : Date.now() - (prev.created_at as Date).getTime() < 120_000
      if (viva) throw new HttpError(409, `Ya se creó ${ETIQUETA[b.a]} desde este ítem`)
      await c.query('DELETE FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2', [b.id, b.a]) // lo creado ya no existe (papelera) o el intento quedó a medias
    }
    await c.query('INSERT INTO feed_item_vinculos (item_id, kind, created_by) VALUES ($1, $2, $3)', [b.id, b.a, actor.id])
    if (cur.status !== 'convertido')
      await c.query(`UPDATE feed_items SET status = 'convertido', converted_to = $2, discard_reason = NULL, status_by = $3, status_at = now() WHERE id = $1`, [b.id, b.a, actor.id])
    return cur.status as string
  })
  const f = await item(pool, b.id, actor.id)
  try {
    let creado: { id: string; [k: string]: unknown }
    const v = f.vinculo
    if (b.a === 'posible_cliente') {
      if (v.estado !== 'sin_vinculo') throw new HttpError(409, `Este ítem ya está vinculado a ${v.cliente}`)
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
        notas: b.notas ?? notaDeConversion(f),
        ...(tel ? { telefono: tel } : {}),
        ...(mail ? { email: mail } : {}),
        ...(b.valor_estimado !== undefined ? { valor_estimado: b.valor_estimado } : {}),
      })) as { id: string }
      // Queda escrito en la bitácora del cliente de dónde salió.
      await exec(interaccionRegistrar, actor, { cliente_id: creado.id, tipo: 'nota', resumen: cortar(`Llegó del feed de oportunidades (${f.fuente}): ${f.titulo}`, 2000) })
    } else if (b.a === 'cliente') {
      if (v.estado === 'sin_vinculo') throw new HttpError(409, 'Primero conviértelo en posible cliente (o vincúlalo a uno con datos.cliente_id)')
      if (v.estado === 'cliente') throw new HttpError(409, `${v.cliente} ya es cliente`)
      // Promover = ganar el posible cliente: el día de implementación es hoy salvo que se diga otro; con propuesta vigente hace falta el esquema de cobro.
      creado = (await exec(clienteActualizar, actor, {
        id: v.cliente_id!,
        estado: 'activo',
        fecha_implementacion: b.fecha_implementacion ?? hoyISO(),
        ...(b.esquema_cobro ? { esquema_cobro: b.esquema_cobro } : {}),
      })) as { id: string }
    } else if (b.a === 'tarea' || b.a === 'seguimiento') {
      const proyecto_id = b.proyecto_id ?? (await proyectoDeLaTarea(actor, v.cliente_id))
      const vence = b.vence ?? (b.a === 'seguimiento' ? masDias(hoyISO(), 3) : undefined)
      creado = (await exec(tareaCrear, actor, {
        titulo: cortar(b.titulo ?? (b.a === 'seguimiento' ? `Seguimiento: ${f.titulo}` : f.titulo), 160),
        proyecto_id,
        ...(vence ? { vence } : {}),
        // sin responsable, la tarea es de quien la crea (el titular de la cuenta o de la llave)
        responsable: b.responsable ?? actor.name,
      })) as { id: string }
    } else if (b.a === 'contenido') {
      // Una idea del feed pasa al tablero de Contenido (columna «Idea»). Si salió de una keyword, la pieza hereda su keyword.
      const kw = str(f.datos.keyword_id)
      const keywordId = kw && z.uuid().safeParse(kw).success && (await pool.query('SELECT 1 FROM mk_keywords WHERE id = $1', [kw])).rowCount ? kw : null
      const resp = b.responsable ? await userByName(pool, b.responsable) : { id: actor.id }
      const nuevo = await insertContenido(pool, {
        titulo: cortar(b.titulo ?? f.titulo, 160),
        keyword_id: keywordId,
        responsable_id: resp.id,
        fecha_objetivo: b.vence ?? null,
        notas: b.descripcion ?? (f.resumen ? cortar(f.resumen, 4000) : null),
        feed_item_id: b.id,
        created_by: actor.id,
      })
      if (keywordId) await pool.query(`UPDATE mk_keywords SET estado = 'en_contenido', updated_at = now() WHERE id = $1 AND estado = 'por_atacar'`, [keywordId])
      creado = { id: nuevo }
    } else {
      creado = (await exec(proyectoCrear, actor, {
        nombre: cortar(b.nombre ?? f.titulo, 80),
        descripcion: b.descripcion ?? contexto(f, 4000),
        ...((b.cliente_id ?? v.cliente_id) ? { cliente_id: (b.cliente_id ?? v.cliente_id)! } : {}),
        ...(b.responsable ? { responsable: b.responsable } : {}),
      })) as { id: string }
    }
    await pool.query('UPDATE feed_item_vinculos SET ref_id = $3, created_at = now() WHERE item_id = $1 AND kind = $2', [b.id, b.a, creado.id])
    await pool.query('UPDATE feed_items SET converted_id = $2 WHERE id = $1 AND converted_to = $3', [b.id, creado.id, b.a])
    return { item: await item(pool, b.id, actor.id), creado: { tipo: b.a, id: creado.id, detalle: creado } }
  } catch (e) {
    // No se pudo crear (validación, 404...): el ítem vuelve a como estaba para poder reintentar con otros datos.
    await tx(async (c) => {
      await c.query('DELETE FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2 AND ref_id IS NULL', [b.id, b.a])
      if (antes !== 'convertido' && !(await c.query('SELECT 1 FROM feed_item_vinculos WHERE item_id = $1', [b.id])).rowCount)
        await c.query(`UPDATE feed_items SET status = $2, converted_to = NULL, converted_id = NULL, status_by = NULL, status_at = NULL WHERE id = $1`, [b.id, antes])
    })
    throw e
  }
})

/**
 * Deshacer lo que se creó desde el ítem (el «Deshacer» del aviso «Listo ✓»): solo quien lo creó y dentro de unos minutos. Lo creado va a la
 * papelera (se puede restaurar) y el ítem vuelve a como estaba. Un cliente promovido vuelve a posible cliente (si no cerró una propuesta).
 */
export const feedDeshacer = op(
  z.strictObject({
    id,
    a: z.enum(CONVERSIONES, `a inválido (${CONVERSIONES.join(', ')})`),
    // «Devolver al feed» (la red de seguridad de la ficha): sin el límite de tiempo y para cualquier socio. Solo posible_cliente que siga siendo posible.
    devolver: z.boolean('devolver debe ser true o false').optional(),
  }),
  async (actor, b) => {
  const l = (await pool.query('SELECT ref_id, created_by, created_at FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2', [b.id, b.a])).rows[0]
  if (!l || !l.ref_id) throw new HttpError(404, 'No hay nada que deshacer en este ítem')
  if (b.devolver) {
    if (b.a !== 'posible_cliente') throw new HttpError(400, 'Solo se puede devolver al feed un posible cliente')
    const c = (await pool.query('SELECT is_prospect FROM clients WHERE id = $1', [l.ref_id])).rows[0]
    if (!c) throw new HttpError(404, 'Ese posible cliente ya no existe')
    if (!c.is_prospect) throw new HttpError(409, 'Ya es cliente: no se puede devolver al feed')
  } else {
    if (l.created_by !== actor.id) throw new HttpError(403, 'Solo quien lo creó puede deshacerlo')
    if (Date.now() - (l.created_at as Date).getTime() > DESHACER_SEG * 1000) throw new HttpError(409, 'Ya pasó el tiempo para deshacer: elimínalo desde su pantalla')
  }
  if (b.a === 'posible_cliente' && (await pool.query(`SELECT 1 FROM feed_item_vinculos WHERE item_id = $1 AND kind = 'cliente'`, [b.id])).rowCount)
    throw new HttpError(409, 'Primero deshaz la promoción a cliente')
  const via = actor.via ?? 'web'
  if (b.a === 'posible_cliente') await sendToTrash('cliente', l.ref_id, actor.id, via)
  else if (b.a === 'cliente') {
    if ((await pool.query(`SELECT 1 FROM proposals WHERE client_id = $1 AND status = 'aceptada'`, [l.ref_id])).rowCount)
      throw new HttpError(409, 'Esa promoción cerró una propuesta y generó cobros: se revierte desde el cliente')
    await exec(clienteActualizar, actor, { id: l.ref_id, estado: 'posible' })
  } else if (b.a === 'tarea' || b.a === 'seguimiento') await sendToTrash('tarea', l.ref_id, actor.id, via)
  else if (b.a === 'contenido') await pool.query('UPDATE mk_contenidos SET archived_at = now(), updated_at = now() WHERE id = $1', [l.ref_id]) // el tablero no usa la papelera: se archiva
  else await sendToTrash('proyecto', l.ref_id, actor.id, via)
  await tx(async (c) => {
    await c.query('SELECT 1 FROM feed_items WHERE id = $1 FOR UPDATE', [b.id])
    await c.query('DELETE FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2', [b.id, b.a])
    if (b.devolver) {
      // El posible cliente se llevó a la papelera sus proyectos, tareas y propuestas: esos vínculos del ítem ya no apuntan a nada.
      for (const v of (await c.query('SELECT kind, ref_id FROM feed_item_vinculos WHERE item_id = $1 AND ref_id IS NOT NULL', [b.id])).rows)
        if (!(await c.query(`SELECT 1 FROM ${VINCULO_TABLA[v.kind as Vinculo]} WHERE id = $1`, [v.ref_id])).rowCount) await c.query('DELETE FROM feed_item_vinculos WHERE item_id = $1 AND kind = $2', [b.id, v.kind])
    }
    const otro = (await c.query('SELECT kind, ref_id FROM feed_item_vinculos WHERE item_id = $1 AND ref_id IS NOT NULL ORDER BY created_at, kind LIMIT 1', [b.id])).rows[0]
    if (otro) await c.query(`UPDATE feed_items SET converted_to = $2, converted_id = $3 WHERE id = $1`, [b.id, otro.kind, otro.ref_id])
    else await c.query(`UPDATE feed_items SET status = 'nuevo', converted_to = NULL, converted_id = NULL, status_by = NULL, status_at = NULL WHERE id = $1`, [b.id])
  })
  return { item: await item(pool, b.id, actor.id), deshecho: b.a }
  },
)

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
