// Central de marketing (v1.7.5): keywords, competidores, contenido (kanban) y campañas. Un servicio para la web, la API v1 y el MCP.
// Reglas de fondo:
//  - Una keyword no se guarda dos veces (llave: texto sin acentos ni mayúsculas).
//  - El SERP (Brightdata) gasta saldo: nunca corre sin `confirmar_costo: true`; antes se pide el aviso con el costo estimado.
//  - Publicar una pieza de contenido exige dónde se publicó y el enlace.
//  - Campañas: SOLO LECTURA. Nada de aquí crea, edita ni pausa campañas en Meta.
import { z } from 'zod'
import { stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { campanasMeta, brightdataListo, dominioDe, investigarSemilla, metaCampanasListo, metaCampanasMotivo, norm, serpCostoUSD, serpGoogle, type SerpFila } from '../marketingExterno.ts'
import { insertContenido } from '../mkContenido.ts'
import { userByName } from '../socios.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { archivadosParam, boolFlag, exec, filters, op, pageShape, paged, r2, todayISO, type Actor } from './common.ts'
import { feedPublicar } from './feed.ts'

const yes = (v: boolean | 'true' | 'false') => v === true || v === 'true'

type Db = { query: typeof pool.query }

// ======================================================================================================================
// Keywords
// ======================================================================================================================
export const INTENCIONES = ['informacional', 'comercial', 'local', 'marca'] as const
export const ESTADOS_KW = ['por_atacar', 'en_contenido', 'posicionada', 'descartada'] as const
export const FUENTES_KW = ['autocompletado', 'serp', 'manual'] as const
const intencion = z.enum(INTENCIONES, `Intención inválida (${INTENCIONES.join(', ')})`)
const estadoKw = z.enum(ESTADOS_KW, `Estado inválido (${ESTADOS_KW.join(', ')})`)
const fuenteKw = z.enum(FUENTES_KW, `Fuente inválida (${FUENTES_KW.join(', ')})`)

const LUGARES = /\b(barquisimeto|lara|cabudare|caracas|valencia|maracaibo|venezuela|cerca de mi|cerca de mí|en mi zona|portuguesa|guanare|acarigua)\b/
const COMERCIAL = /\b(precio|precios|costo|costos|cuanto cuesta|cuánto cuesta|comprar|contratar|cotizacion|cotización|presupuesto|oferta|ofertas|mejor|mejores|agencia|empresa|servicio|servicios|software|plataforma|herramienta|herramientas|alternativa|alternativas|vs|tarifa|tarifas|planes)\b/

/** Intención sugerida por reglas simples (nada de APIs): marca > local > comercial > informacional. Se puede corregir a mano. */
export function clasificarIntencion(t: string): (typeof INTENCIONES)[number] {
  const n = norm(t)
  if (/\bhayai\b/.test(n)) return 'marca'
  if (LUGARES.test(n)) return 'local'
  if (COMERCIAL.test(n)) return 'comercial'
  return 'informacional'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kwOut = (r: any) => ({
  id: r.id as string,
  texto: r.texto as string,
  intencion: r.intencion as (typeof INTENCIONES)[number],
  estado: r.estado as (typeof ESTADOS_KW)[number],
  fuente: r.fuente as (typeof FUENTES_KW)[number],
  semilla: (r.semilla ?? null) as string | null,
  guardada_el: (r.created_at as Date).toISOString(),
  guardada_por: (r.creador ?? null) as string | null,
  idea_item_id: (r.idea_item_id ?? null) as string | null,
  serp_consultado_el: r.serp_el ? (r.serp_el as Date).toISOString() : null,
  contenidos: Number(r.contenidos ?? 0),
  actualizado_el: stamp(r.updated_at),
})

const KW_SELECT = `SELECT k.*, u.name AS creador,
    (SELECT max(s.consultado_el) FROM mk_serp s WHERE s.keyword_id = k.id) AS serp_el,
    (SELECT count(*)::int FROM mk_contenidos m WHERE m.keyword_id = k.id AND m.archived_at IS NULL) AS contenidos
  FROM mk_keywords k JOIN users u ON u.id = k.created_by`

async function kwFila(c: Db, kwId: string) {
  const r = (await c.query(`${KW_SELECT} WHERE k.id = $1`, [kwId])).rows[0]
  if (!r) throw new HttpError(404, 'Keyword no encontrada')
  return r
}

export const kwInvestigar = op(
  z.strictObject({ semilla: text(80) }),
  async (_a, b) => {
    const r = await investigarSemilla(b.semilla)
    const normas = r.sugerencias.map((s) => norm(s.texto))
    const guardadas = normas.length ? (await pool.query('SELECT id, texto_norm FROM mk_keywords WHERE texto_norm = ANY($1)', [normas])).rows : []
    const porNorm = new Map<string, string>(guardadas.map((g) => [g.texto_norm as string, g.id as string]))
    return {
      semilla: b.semilla,
      consultas: r.consultas,
      fallidas: r.fallidas,
      sugerencias: r.sugerencias.map((s) => ({
        texto: s.texto,
        tipo: s.tipo,
        intencion_sugerida: clasificarIntencion(s.texto),
        guardada: porNorm.has(norm(s.texto)),
        keyword_id: porNorm.get(norm(s.texto)) ?? null,
      })),
    }
  },
)

const kwItem = z.strictObject({ texto: text(120), intencion: intencion.optional(), fuente: fuenteKw.optional(), semilla: text(120).nullish() })

export const kwGuardar = op(
  z
    .strictObject({
      texto: text(120).optional(),
      intencion: intencion.optional(),
      fuente: fuenteKw.optional(),
      semilla: text(120).nullish(),
      // varios de una vez (hasta 100): cada uno con la misma forma que uno solo
      items: z.array(kwItem, 'items debe ser una lista').min(1, 'items no puede estar vacío').max(100, 'Máximo 100 keywords por envío').optional(),
    })
    .refine((v) => (v.items !== undefined ? v.texto === undefined && v.intencion === undefined && v.fuente === undefined && v.semilla === undefined : v.texto !== undefined), 'Envía una keyword (texto) o una lista en items, no las dos cosas'),
  async (actor, b) => {
    const lista = b.items ?? [{ texto: b.texto!, intencion: b.intencion, fuente: b.fuente, semilla: b.semilla }]
    const res = await tx(async (c) => {
      const out: { id: string; creada: boolean }[] = []
      const vistas = new Set<string>()
      for (const it of lista) {
        const n = norm(it.texto)
        if (!n) throw new HttpError(400, 'texto: Es obligatorio')
        const ya = vistas.has(n) ? (await c.query('SELECT id FROM mk_keywords WHERE texto_norm = $1', [n])).rows[0] : null
        if (ya) {
          out.push({ id: ya.id, creada: false })
          continue
        }
        vistas.add(n)
        const ins = await c.query(
          `INSERT INTO mk_keywords (texto, texto_norm, intencion, fuente, semilla, created_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (texto_norm) DO NOTHING RETURNING id`,
          [it.texto.replace(/\s+/g, ' '), n, it.intencion ?? clasificarIntencion(it.texto), it.fuente ?? 'manual', it.semilla ?? null, actor.id],
        )
        if (ins.rows[0]) out.push({ id: ins.rows[0].id, creada: true })
        else out.push({ id: (await c.query('SELECT id FROM mk_keywords WHERE texto_norm = $1', [n])).rows[0].id, creada: false })
      }
      const rows = (await c.query(`${KW_SELECT} WHERE k.id = ANY($1)`, [out.map((o) => o.id)])).rows
      const porId = new Map(rows.map((r) => [r.id as string, r]))
      return out.map((o) => ({ ...kwOut(porId.get(o.id)), creada: o.creada }))
    })
    if (!b.items) return res[0]
    return { recibidas: res.length, creadas: res.filter((r) => r.creada).length, duplicadas: res.filter((r) => !r.creada).length, data: res }
  },
)

export const kwListar = op(
  z.strictObject({
    q: text(80).optional(),
    intencion: intencion.optional(),
    estado: estadoKw.optional(),
    fuente: fuenteKw.optional(),
    ...pageShape,
  }),
  async (_a, b) => {
    const f = filters()
    if (b.q) f.add(`k.texto_norm LIKE ?`, `%${norm(b.q).replace(/[\\%_]/g, '\\$&')}%`)
    if (b.intencion) f.add('k.intencion = ?', b.intencion)
    if (b.estado) f.add('k.estado = ?', b.estado)
    if (b.fuente) f.add('k.fuente = ?', b.fuente)
    const total = (await pool.query(`SELECT count(*)::int AS n FROM mk_keywords k ${f.where()}`, f.params())).rows[0].n as number
    const rows = (
      await pool.query(`${KW_SELECT} ${f.where()} ORDER BY k.created_at DESC, k.texto LIMIT ${b.per_page} OFFSET ${(b.page - 1) * b.per_page}`, f.params())
    ).rows
    const porEstado = (await pool.query('SELECT estado, count(*)::int AS n FROM mk_keywords GROUP BY estado')).rows
    return paged(rows.map(kwOut), total, b.page, b.per_page, { por_estado: Object.fromEntries(porEstado.map((r) => [r.estado, r.n])) })
  },
)

async function serpDe(c: Db, kwId: string) {
  const r = (await c.query('SELECT s.consultado_el, s.costo_estimado, s.resultados, u.name AS por FROM mk_serp s JOIN users u ON u.id = s.consultado_por WHERE s.keyword_id = $1 ORDER BY s.consultado_el DESC LIMIT 1', [kwId])).rows[0]
  if (!r) return null
  const comps = await competidoresActivos(c)
  return {
    consultado_el: (r.consultado_el as Date).toISOString(),
    consultado_por: r.por as string,
    costo_estimado_usd: Number(r.costo_estimado),
    resultados: (r.resultados as SerpFila[]).map((x) => ({ ...x, competidor: competidorDe(comps, x) })),
  }
}

export const kwVer = op(z.strictObject({ id }), async (_a, b) => {
  const k = kwOut(await kwFila(pool, b.id))
  const contenidos = (await pool.query(`${CT_SELECT} WHERE m.keyword_id = $1 AND m.archived_at IS NULL ORDER BY m.created_at DESC`, [b.id])).rows.map(ctOut)
  return { ...k, serp: await serpDe(pool, b.id), contenidos_vinculados: contenidos }
})

export const kwActualizar = op(
  z.strictObject({ id, estado: estadoKw.optional(), intencion: intencion.optional(), texto: text(120).optional() }).refine((v) => v.estado !== undefined || v.intencion !== undefined || v.texto !== undefined, 'Nada que cambiar'),
  async (_a, b) => {
    await tx(async (c) => {
      await kwFila(c, b.id)
      if (b.texto !== undefined) {
        const n = norm(b.texto)
        const otra = (await c.query('SELECT 1 FROM mk_keywords WHERE texto_norm = $1 AND id <> $2', [n, b.id])).rows[0]
        if (otra) throw new HttpError(409, 'Ya existe una keyword igual. ✓ Guardada')
        await c.query('UPDATE mk_keywords SET texto = $2, texto_norm = $3 WHERE id = $1', [b.id, b.texto.replace(/\s+/g, ' '), n])
      }
      if (b.estado !== undefined) await c.query('UPDATE mk_keywords SET estado = $2 WHERE id = $1', [b.id, b.estado])
      if (b.intencion !== undefined) await c.query('UPDATE mk_keywords SET intencion = $2 WHERE id = $1', [b.id, b.intencion])
      await c.query('UPDATE mk_keywords SET updated_at = now() WHERE id = $1', [b.id])
    })
    return kwOut(await kwFila(pool, b.id))
  },
)

/** El aviso de costo que se muestra ANTES de gastar saldo de Brightdata. */
export const kwSerpAviso = op(z.strictObject({ id }), async (_a, b) => {
  const k = await kwFila(pool, b.id)
  const costo = serpCostoUSD()
  return {
    keyword: k.texto as string,
    conectado: brightdataListo(),
    costo_estimado_usd: costo,
    mensaje: `Esta consulta consume saldo de tu cuenta de Brightdata (costo estimado: US$ ${costo.toLocaleString('es-VE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}).`,
    motivo: brightdataListo() ? null : 'Brightdata no está configurado en el servidor.',
    ultimo_serp: await serpDe(pool, b.id),
  }
})

export const kwSerp = op(z.strictObject({ id, confirmar_costo: boolFlag.optional() }), async (actor, b) => {
  const k = await kwFila(pool, b.id)
  const costo = serpCostoUSD()
  if (b.confirmar_costo === undefined || !yes(b.confirmar_costo))
    throw new HttpError(409, `Esta consulta consume saldo de tu cuenta de Brightdata (costo estimado: US$ ${costo}). Confírmala con confirmar_costo: true.`, { requiere_confirmacion: true, costo_estimado_usd: costo })
  const filas = await serpGoogle(k.texto as string) // 503 si no está configurado; 502 si falla (no se guarda nada)
  await pool.query('INSERT INTO mk_serp (keyword_id, consultado_por, costo_estimado, resultados) VALUES ($1, $2, $3, $4::jsonb)', [b.id, actor.id, costo, JSON.stringify(filas)])
  return { keyword: k.texto as string, ...(await serpDe(pool, b.id)) }
})

/** «Crear idea de contenido»: publica una idea en el feed (firmada por quien la crea) vinculada a la keyword. Una sola por keyword. */
export const kwIdea = op(z.strictObject({ id }), async (actor, b) => {
  const k = await kwFila(pool, b.id)
  if (k.idea_item_id) return { creada: false, keyword: kwOut(k), item_id: k.idea_item_id as string }
  const it = (await exec(feedPublicar, actor, {
    titulo: `Contenido sobre «${k.texto}»`.slice(0, 160),
    resumen: `Idea creada desde la keyword «${k.texto}» (intención ${k.intencion}).`,
    tipo: 'idea',
    fuente: 'marketing',
    clave_externa: `kw:${b.id}`,
    categoria: 'contenido',
    datos: { keyword_id: b.id, keyword: k.texto, intencion: k.intencion },
  })) as { id: string }
  await pool.query('UPDATE mk_keywords SET idea_item_id = $2, updated_at = now() WHERE id = $1 AND idea_item_id IS NULL', [b.id, it.id])
  return { creada: true, keyword: kwOut(await kwFila(pool, b.id)), item_id: it.id }
})

/** «Mover a contenido» desde una keyword: crea la pieza (en Idea) y marca la keyword como «En contenido». */
export const kwContenido = op(
  z.strictObject({ id, titulo: text(160).optional(), responsable: text(40).optional(), fecha_objetivo: isoDate.optional(), notas: text(4000).optional() }),
  async (actor, b) => {
    const res = await tx(async (c) => {
      const k = (await c.query('SELECT * FROM mk_keywords WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
      if (!k) throw new HttpError(404, 'Keyword no encontrada')
      const ya = (await c.query("SELECT id FROM mk_contenidos WHERE keyword_id = $1 AND archived_at IS NULL AND estado <> 'publicado' ORDER BY created_at LIMIT 1", [b.id])).rows[0]
      if (ya) return { creado: false, contenido_id: ya.id as string }
      const resp = b.responsable ? await userByName(c, b.responsable) : { id: actor.id }
      const cid = await insertContenido(c, {
        titulo: b.titulo ?? (k.texto as string).charAt(0).toUpperCase() + (k.texto as string).slice(1),
        keyword_id: b.id,
        responsable_id: resp.id,
        fecha_objetivo: b.fecha_objetivo,
        notas: b.notas,
        feed_item_id: k.idea_item_id,
        created_by: actor.id,
      })
      if (k.estado === 'por_atacar') await c.query("UPDATE mk_keywords SET estado = 'en_contenido', updated_at = now() WHERE id = $1", [b.id])
      return { creado: true, contenido_id: cid }
    })
    return { ...res, contenido: await contenidoUno(res.contenido_id), keyword: kwOut(await kwFila(pool, b.id)) }
  },
)

// ======================================================================================================================
// Competidores
// ======================================================================================================================
type Comp = { id: string; nombre: string; nombre_norm: string; web: string | null; instagram: string | null }

const handleIg = (v: string | null) => (v ? v.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase() : '')
const dominioWeb = (v: string | null) => (v ? dominioDe(/^https?:\/\//i.test(v) ? v : `https://${v}`) : '')

async function competidoresActivos(c: Db): Promise<Comp[]> {
  return (await c.query('SELECT id, nombre, nombre_norm, web, instagram FROM mk_competidores WHERE archived_at IS NULL')).rows as Comp[]
}

/** A cuál competidor pertenece un resultado del SERP: por su dominio (web) o por su usuario de Instagram. Null si ninguno. */
function competidorDe(comps: Comp[], fila: SerpFila): { id: string; nombre: string } | null {
  for (const k of comps) {
    const d = dominioWeb(k.web)
    if (d && (fila.dominio === d || fila.dominio.endsWith(`.${d}`))) return { id: k.id, nombre: k.nombre }
    const ig = handleIg(k.instagram)
    if (ig && /(^|\.)instagram\.com$/.test(fila.dominio) && (() => { try { return new URL(fila.url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() === ig } catch { return false } })()) return { id: k.id, nombre: k.nombre }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const compOut = (r: any) => ({
  id: r.id as string,
  nombre: r.nombre as string,
  web: (r.web ?? null) as string | null,
  instagram: (r.instagram ?? null) as string | null,
  notas: (r.notas ?? null) as string | null,
  fecha_alta: (r.created_at as Date).toISOString(),
  creado_por: (r.creador ?? null) as string | null,
  archivado: r.archived_at !== null && r.archived_at !== undefined,
  actualizado_el: stamp(r.updated_at),
})
const COMP_SELECT = 'SELECT k.*, u.name AS creador FROM mk_competidores k JOIN users u ON u.id = k.created_by'

async function compFila(c: Db, cid: string) {
  const r = (await c.query(`${COMP_SELECT} WHERE k.id = $1`, [cid])).rows[0]
  if (!r) throw new HttpError(404, 'Competidor no encontrado')
  return r
}

const nombreComp = text(120)
const urlLibre = text(300)
const igLibre = text(120)
const notasComp = text(4000)

export const competidoresListar = op(z.strictObject({ q: text(80).optional(), archivados: archivadosParam, ...pageShape }), async (_a, b) => {
  const f = filters()
  if (b.q) f.add('k.nombre_norm LIKE ?', `%${norm(b.q).replace(/[\\%_]/g, '\\$&')}%`)
  if (b.archivados === 'excluir') f.raw('k.archived_at IS NULL')
  if (b.archivados === 'solo') f.raw('k.archived_at IS NOT NULL')
  const total = (await pool.query(`SELECT count(*)::int AS n FROM mk_competidores k ${f.where()}`, f.params())).rows[0].n as number
  const rows = (await pool.query(`${COMP_SELECT} ${f.where()} ORDER BY k.nombre LIMIT ${b.per_page} OFFSET ${(b.page - 1) * b.per_page}`, f.params())).rows
  return paged(rows.map(compOut), total, b.page, b.per_page)
})

/** Hallazgos del espía de anuncios (feed, fuentes «espia…») cuyo texto menciona al competidor. Solo lo que ya existe: no inventa nada. */
async function hallazgosDe(nombre: string) {
  const n = norm(nombre)
  if (n.length < 3) return []
  const rows = (
    await pool.query(
      `SELECT id, title, summary, kind, source, data, found_at FROM feed_items WHERE source ILIKE 'espia%' ORDER BY found_at DESC LIMIT 500`,
    )
  ).rows
  const out = []
  for (const r of rows) {
    const hay = norm(`${r.title} ${r.summary ?? ''} ${typeof r.data?.negocio === 'string' ? r.data.negocio : ''} ${typeof r.data?.anunciante === 'string' ? r.data.anunciante : ''}`)
    if (!hay.includes(n)) continue
    out.push({ id: r.id as string, titulo: r.title as string, resumen: (r.summary ?? null) as string | null, tipo: r.kind as string, fuente: r.source as string, fecha: (r.found_at as Date).toISOString() })
    if (out.length >= 20) break
  }
  return out
}

export const competidorVer = op(z.strictObject({ id }), async (_a, b) => {
  const k = await compFila(pool, b.id)
  return { ...compOut(k), hallazgos: await hallazgosDe(k.nombre as string) }
})

export const competidorCrear = op(
  z.strictObject({ nombre: nombreComp, web: urlLibre.nullish(), instagram: igLibre.nullish(), notas: notasComp.nullish() }),
  async (actor, b) => {
    const n = norm(b.nombre)
    const ya = (await pool.query('SELECT id, nombre FROM mk_competidores WHERE nombre_norm = $1 AND archived_at IS NULL', [n])).rows[0]
    if (ya) throw new HttpError(409, `Ya tienes un competidor llamado «${ya.nombre}»`)
    const r = await pool.query(
      `INSERT INTO mk_competidores (nombre, nombre_norm, web, instagram, notas, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.nombre, n, b.web ?? null, b.instagram ?? null, b.notas ?? null, actor.id],
    )
    const k = await compFila(pool, r.rows[0].id)
    return { ...compOut(k), hallazgos: await hallazgosDe(k.nombre as string) }
  },
)

export const competidorActualizar = op(
  z
    .strictObject({ id, nombre: nombreComp.optional(), web: urlLibre.nullish(), instagram: igLibre.nullish(), notas: notasComp.nullish(), archivado: boolFlag.optional() })
    .refine((v) => Object.keys(v).length > 1, 'Nada que cambiar'),
  async (_a, b) => {
    await tx(async (c) => {
      const k = await compFila(c, b.id)
      const sets: string[] = []
      const params: unknown[] = [b.id]
      const set = (col: string, v: unknown) => {
        params.push(v)
        sets.push(`${col} = $${params.length}`)
      }
      if (b.nombre !== undefined) {
        const n = norm(b.nombre)
        const otro = (await c.query('SELECT 1 FROM mk_competidores WHERE nombre_norm = $1 AND id <> $2 AND archived_at IS NULL', [n, b.id])).rows[0]
        if (otro) throw new HttpError(409, 'Ya tienes un competidor con ese nombre')
        set('nombre', b.nombre)
        set('nombre_norm', n)
      }
      if (b.web !== undefined) set('web', b.web)
      if (b.instagram !== undefined) set('instagram', b.instagram)
      if (b.notas !== undefined) set('notas', b.notas)
      if (b.archivado !== undefined) {
        if (!yes(b.archivado)) {
          const otro = (await c.query('SELECT 1 FROM mk_competidores WHERE nombre_norm = $1 AND id <> $2 AND archived_at IS NULL', [k.nombre_norm, b.id])).rows[0]
          if (otro) throw new HttpError(409, 'Ya hay un competidor activo con ese nombre')
        }
        sets.push(`archived_at = ${yes(b.archivado) ? 'COALESCE(archived_at, now())' : 'NULL'}`)
      }
      sets.push('updated_at = now()')
      await c.query(`UPDATE mk_competidores SET ${sets.join(', ')} WHERE id = $1`, params)
    })
    const k = await compFila(pool, b.id)
    return { ...compOut(k), hallazgos: await hallazgosDe(k.nombre as string) }
  },
)

/** «Ver en qué keywords aparece»: cruza los SERP YA consultados (último de cada keyword). No consulta nada nuevo ni gasta saldo. */
export const competidorKeywords = op(z.strictObject({ id }), async (_a, b) => {
  const k = await compFila(pool, b.id)
  const comp: Comp = { id: k.id, nombre: k.nombre, nombre_norm: k.nombre_norm, web: k.web, instagram: k.instagram }
  const rows = (
    await pool.query(
      `SELECT DISTINCT ON (s.keyword_id) s.keyword_id, s.consultado_el, s.resultados, kw.texto
         FROM mk_serp s JOIN mk_keywords kw ON kw.id = s.keyword_id ORDER BY s.keyword_id, s.consultado_el DESC`,
    )
  ).rows
  const apariciones = []
  for (const r of rows)
    for (const x of r.resultados as SerpFila[]) {
      if (competidorDe([comp], x)?.id !== comp.id) continue
      apariciones.push({ keyword_id: r.keyword_id as string, keyword: r.texto as string, posicion: x.posicion, titulo: x.titulo, url: x.url, consultado_el: (r.consultado_el as Date).toISOString() })
    }
  apariciones.sort((a, c) => a.posicion - c.posicion)
  return {
    competidor: comp.nombre,
    serp_revisados: rows.length,
    sin_datos_para_cruzar: !comp.web && !comp.instagram ? 'Agrega la web o el Instagram del competidor para poder encontrarlo en los SERP.' : null,
    apariciones,
  }
})

// ======================================================================================================================
// Contenido (kanban)
// ======================================================================================================================
export const ESTADOS_CT = ['idea', 'produccion', 'publicado'] as const
const estadoCt = z.enum(ESTADOS_CT, `Estado inválido (${ESTADOS_CT.join(', ')})`)
/** Cuántos días antes de la fecha objetivo la pieza pasa a «próxima». */
const PROXIMA_DIAS = 3

const CT_SELECT = `SELECT m.*, k.texto AS kw_texto, ru.name AS resp_name, cu.name AS creador
  FROM mk_contenidos m LEFT JOIN mk_keywords k ON k.id = m.keyword_id JOIN users ru ON ru.id = m.responsable_id JOIN users cu ON cu.id = m.created_by`

const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/** vencida | proxima | en_plazo | null (sin fecha o ya publicada). */
export function semaforo(estado: string, fecha: string | null, hoy = todayISO()): 'vencida' | 'proxima' | 'en_plazo' | null {
  if (!fecha || estado === 'publicado') return null
  const d = dias(hoy, fecha)
  return d < 0 ? 'vencida' : d <= PROXIMA_DIAS ? 'proxima' : 'en_plazo'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctOut = (r: any) => {
  const fecha = r.fecha_objetivo ? (r.fecha_objetivo instanceof Date ? r.fecha_objetivo.toISOString().slice(0, 10) : String(r.fecha_objetivo).slice(0, 10)) : null
  return {
    id: r.id as string,
    titulo: r.titulo as string,
    estado: r.estado as (typeof ESTADOS_CT)[number],
    keyword: r.keyword_id ? { id: r.keyword_id as string, texto: (r.kw_texto ?? '') as string } : null,
    responsable: { id: r.responsable_id as string, nombre: r.resp_name as string },
    fecha_objetivo: fecha,
    semaforo: semaforo(r.estado, fecha),
    notas: (r.notas ?? null) as string | null,
    publicado_en: (r.publicado_en ?? null) as string | null,
    enlace: (r.enlace ?? null) as string | null,
    publicado_el: r.publicado_el ? (r.publicado_el as Date).toISOString() : null,
    feed_item_id: (r.feed_item_id ?? null) as string | null,
    creado_por: r.creador as string,
    creado_el: (r.created_at as Date).toISOString(),
    archivado: !!r.archived_at,
    actualizado_el: stamp(r.updated_at),
  }
}

async function contenidoUno(cid: string, c: Db = pool) {
  const r = (await c.query(`${CT_SELECT} WHERE m.id = $1`, [cid])).rows[0]
  if (!r) throw new HttpError(404, 'Pieza de contenido no encontrada')
  return ctOut(r)
}

const enlace = z.string('Enlace inválido').trim().max(500, 'Máximo 500 caracteres').refine((v) => /^https?:\/\/\S+\.\S+/i.test(v), 'El enlace debe empezar por http:// o https://')

export const contenidosListar = op(
  z.strictObject({ estado: estadoCt.optional(), responsable: text(40).optional(), keyword_id: id.optional(), archivados: archivadosParam }),
  async (_a, b) => {
    const f = filters()
    if (b.estado) f.add('m.estado = ?', b.estado)
    if (b.keyword_id) f.add('m.keyword_id = ?', b.keyword_id)
    if (b.responsable) f.add('lower(ru.name) = ?', b.responsable.trim().toLowerCase())
    if (b.archivados === 'excluir') f.raw('m.archived_at IS NULL')
    if (b.archivados === 'solo') f.raw('m.archived_at IS NOT NULL')
    const rows = (await pool.query(`${CT_SELECT} ${f.where()} ORDER BY m.fecha_objetivo NULLS LAST, m.created_at DESC LIMIT 500`, f.params())).rows
    const data = rows.map(ctOut)
    const col = (e: string) => data.filter((x) => x.estado === e)
    return { data, columnas: { idea: col('idea').length, produccion: col('produccion').length, publicado: col('publicado').length }, meta: { total: data.length } }
  },
)

export const contenidoVer = op(z.strictObject({ id }), async (_a, b) => contenidoUno(b.id))

export const contenidoCrear = op(
  z.strictObject({ titulo: text(160), keyword_id: id.nullish(), responsable: text(40).optional(), fecha_objetivo: isoDate.nullish(), notas: text(4000).nullish() }),
  async (actor, b) => {
    const cid = await tx(async (c) => {
      if (b.keyword_id && !(await c.query('SELECT 1 FROM mk_keywords WHERE id = $1', [b.keyword_id])).rows[0]) throw new HttpError(404, 'Keyword no encontrada')
      const resp = b.responsable ? await userByName(c, b.responsable) : { id: actor.id }
      return insertContenido(c, { titulo: b.titulo, keyword_id: b.keyword_id, responsable_id: resp.id, fecha_objetivo: b.fecha_objetivo, notas: b.notas, created_by: actor.id })
    })
    return contenidoUno(cid)
  },
)

export const contenidoActualizar = op(
  z
    .strictObject({
      id,
      titulo: text(160).optional(),
      keyword_id: id.nullish(),
      responsable: text(40).optional(),
      fecha_objetivo: isoDate.nullish(),
      notas: text(4000).nullish(),
      publicado_en: text(120).nullish(),
      enlace: enlace.nullish(),
      archivado: boolFlag.optional(),
    })
    .refine((v) => Object.keys(v).length > 1, 'Nada que cambiar'),
  async (_a, b) => {
    await tx(async (c) => {
      const m = (await c.query('SELECT * FROM mk_contenidos WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
      if (!m) throw new HttpError(404, 'Pieza de contenido no encontrada')
      const sets: string[] = []
      const params: unknown[] = [b.id]
      const set = (col: string, v: unknown, cast = '') => {
        params.push(v)
        sets.push(`${col} = $${params.length}${cast}`)
      }
      if (b.titulo !== undefined) set('titulo', b.titulo)
      if (b.keyword_id !== undefined) {
        if (b.keyword_id && !(await c.query('SELECT 1 FROM mk_keywords WHERE id = $1', [b.keyword_id])).rows[0]) throw new HttpError(404, 'Keyword no encontrada')
        set('keyword_id', b.keyword_id)
      }
      if (b.responsable !== undefined) set('responsable_id', (await userByName(c, b.responsable)).id)
      if (b.fecha_objetivo !== undefined) set('fecha_objetivo', b.fecha_objetivo, '::date')
      if (b.notas !== undefined) set('notas', b.notas)
      // dónde/enlace de una pieza publicada se pueden corregir, pero no quedar vacíos
      if (m.estado === 'publicado') {
        if (b.publicado_en === null || b.enlace === null) throw new HttpError(400, 'Una pieza publicada necesita dónde se publicó y el enlace')
        if (b.publicado_en !== undefined) set('publicado_en', b.publicado_en)
        if (b.enlace !== undefined) set('enlace', b.enlace)
      } else if (b.publicado_en !== undefined || b.enlace !== undefined) throw new HttpError(400, 'Dónde se publicó y el enlace se piden al mover la pieza a Publicado')
      if (b.archivado !== undefined) sets.push(`archived_at = ${yes(b.archivado) ? 'COALESCE(archived_at, now())' : 'NULL'}`)
      sets.push('updated_at = now()')
      await c.query(`UPDATE mk_contenidos SET ${sets.join(', ')} WHERE id = $1`, params)
    })
    return contenidoUno(b.id)
  },
)

/** Mover en el tablero. A Publicado se exige dónde se publicó y el enlace; al salir de Publicado se limpian. */
export const contenidoMover = op(
  z.strictObject({ id, estado: estadoCt, publicado_en: text(120).optional(), enlace: enlace.optional() }),
  async (_a, b) => {
    await tx(async (c) => {
      const m = (await c.query('SELECT * FROM mk_contenidos WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
      if (!m) throw new HttpError(404, 'Pieza de contenido no encontrada')
      if (m.archived_at) throw new HttpError(409, 'La pieza está archivada')
      if (b.estado === 'publicado') {
        const donde = b.publicado_en ?? m.publicado_en
        const link = b.enlace ?? m.enlace
        if (!donde || !link) throw new HttpError(400, 'Para publicar indica dónde se publicó (publicado_en) y el enlace (enlace)', { faltan: [!donde && 'publicado_en', !link && 'enlace'].filter(Boolean) })
        await c.query(`UPDATE mk_contenidos SET estado = 'publicado', publicado_en = $2, enlace = $3, publicado_el = COALESCE(publicado_el, now()), updated_at = now() WHERE id = $1`, [b.id, donde, link])
        // la keyword ya tiene su pieza publicada: pasa a «En contenido» si seguía por atacar
        if (m.keyword_id) await c.query("UPDATE mk_keywords SET estado = 'en_contenido', updated_at = now() WHERE id = $1 AND estado = 'por_atacar'", [m.keyword_id])
      } else {
        await c.query('UPDATE mk_contenidos SET estado = $2, publicado_en = NULL, enlace = NULL, publicado_el = NULL, updated_at = now() WHERE id = $1', [b.id, b.estado])
      }
    })
    return contenidoUno(b.id)
  },
)

// ======================================================================================================================
// Campañas (Meta, solo lectura)
// ======================================================================================================================
export const campanasVer = op(
  z.strictObject({ dias: z.number('dias debe ser un número').int().min(7, 'dias: entre 7 y 90').max(90, 'dias: entre 7 y 90').default(30), cuenta: text(40).optional() }),
  async (_a, b) => {
    const base = { dias: b.dias, solo_lectura: true as const }
    if (!metaCampanasListo()) return { ...base, conectado: false, motivo: metaCampanasMotivo(), error: null as string | null, cuentas: [], campanas: [], totales: null }
    try {
      const r = await campanasMeta(b.dias, b.cuenta)
      const monedas = new Set(r.cuentas.map((c) => c.moneda))
      const gasto = r2(r.campanas.reduce((s, c) => s + c.gasto, 0))
      const leads = r.campanas.reduce((s, c) => s + c.leads, 0)
      // sumar gasto de cuentas en monedas distintas no tiene sentido: sin totales en ese caso
      const totales = monedas.size <= 1 ? { moneda: [...monedas][0] ?? 'USD', gasto, leads, cpl: leads > 0 ? r2(gasto / leads) : null } : null
      return { ...base, conectado: true, motivo: null, error: null as string | null, cuentas: r.cuentas, campanas: r.campanas, totales }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      return { ...base, conectado: true, motivo: null, error: e.message, cuentas: [], campanas: [], totales: null }
    }
  },
)

export type { Actor }
