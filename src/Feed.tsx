// Feed de oportunidades (planeta HAYAI / Hub): lo que las máquinas y los agentes ENCONTRARON. No es la bitácora (lo que el equipo
// HIZO): aquí cada hallazgo es una tarjeta que se convierte en algo (posible cliente, tarea, proyecto), se revisa o se descarta.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, isConflict } from './api'
import { SOURCE_LABEL } from './clientLog'
import {
  FEED_ESTADO_LABEL,
  FEED_TIPOS,
  FEED_TIPO_LABEL,
  convertFeed,
  loadFeed,
  loadFeedItem,
  markFeed,
  onFeedFocus,
  publishFeed,
  takeFeedFocus,
  useFeedTick,
  type ConvertBody,
  type FeedConversion,
  type FeedEstado,
  type FeedFilters,
  type FeedFocus,
  type FeedItem,
  type FeedMeta,
  type FeedTipo,
} from './feedData'
import { go } from './nav'
import { loadProjects, useProjects } from './projectData'
import { loadClients } from './store'
import { loadTasks } from './taskData'
import { ago } from './time'
import { Icon } from './ui'
import './feed.css'

const PER_PAGE = 20
/** cuántas páginas ya cargadas se vuelven a pedir en una recarga en vivo (el resto se conserva tal cual) */
const REFRESH_PAGES = 5
const SOURCES = ['referido', 'instagram', 'whatsapp', 'facebook', 'meta_ads', 'web', 'visita_frio', 'evento', 'otro']
const STAGE_LABEL: Record<string, string> = { prospecto: 'Prospecto captado', visita_agendada: 'Visita agendada', visita_realizada: 'Visita realizada', propuesta_en_armado: 'Propuesta en armado', propuesta_presentada: 'Segunda visita' }

// ---------- helpers de presentación ----------
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('es-VE')} ${n === 1 ? one : many}`
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const fullDate = (iso: string) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'long', timeStyle: 'short' })
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const FUENTES: Record<string, string> = {
  'radar-hayai': 'Radar HAYAI',
  'cazador-summit': 'Cazador Summit',
  'video-auditorias': 'Video-auditorías',
  'espia-pos': 'Espía POS',
  'leads-tibios': 'Leads tibios',
  'demo-first': 'Demo-first',
}
/** Nombre legible de la fuente (el slug que manda el servidor, humanizado). */
export function fuenteLabel(fuente: string, by?: { nombre: string }): string {
  if (FUENTES[fuente]) return FUENTES[fuente]
  if (fuente === 'manual') return by ? `Manual · ${by.nombre}` : 'Manual'
  const muse = /^muse-(.+)$/.exec(fuente)
  if (muse) return `Muse de ${cap(muse[1].replace(/[-_.]+/g, ' '))}`
  return cap(fuente.replace(/[-_.]+/g, ' ').trim())
}

// ---------- lectura tolerante de `datos` (forma libre: se muestra lo que haya y el resto se ignora) ----------
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('es-VE') : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : null)
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(scalar).filter((x): x is string => !!x) : scalar(v) ? [scalar(v)!] : [])
/** Solo enlaces http(s): lo demás (javascript:, data:...) nunca llega a un href. */
const safeUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return null
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
const urlLabel = (href: string) => href.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
const keyLabel = (k: string) => cap(k.replace(/[_-]+/g, ' '))

interface Negocio {
  nombre: string | null
  extra: [string, string][]
}
function negocioOf(d: Record<string, unknown>): Negocio | null {
  const n = d.negocio
  if (typeof n === 'string') return scalar(n) ? { nombre: n.trim(), extra: [] } : null
  if (isRec(n)) {
    const nombre = scalar(n.nombre) ?? scalar(n.name)
    const extra = Object.entries(n)
      .filter(([k]) => k !== 'nombre' && k !== 'name')
      .map(([k, v]) => [keyLabel(k), scalar(v)] as const)
      .filter((x): x is [string, string] => !!x[1])
    return nombre || extra.length ? { nombre, extra } : null
  }
  return null
}
const nombreSugerido = (it: FeedItem) => negocioOf(it.datos)?.nombre ?? it.titulo
function detailOf(it: FeedItem) {
  const d = it.datos
  const metricas = isRec(d.metricas)
    ? Object.entries(d.metricas)
        .map(([k, v]) => [keyLabel(k), scalar(v) ?? (v === null || v === undefined ? null : JSON.stringify(v).slice(0, 120))] as const)
        .filter((x): x is [string, string] => !!x[1])
    : []
  const urls = listOf(d.urls)
    .map(safeUrl)
    .filter((x): x is string => !!x)
  const contacto = [
    ['Teléfono', scalar(d.telefono)],
    ['Correo', scalar(d.email)],
    ['Origen', scalar(d.origen)],
  ].filter((x): x is [string, string] => !!x[1])
  const out = { negocio: negocioOf(d), fugas: listOf(d.fugas), guion: scalar(d.guion), urls, metricas, contacto }
  const any = !!out.negocio || out.fugas.length > 0 || !!out.guion || urls.length > 0 || metricas.length > 0 || contacto.length > 0
  return { ...out, any }
}

// ---------- iconos y etiquetas ----------
const TIPO_PATH: Record<FeedTipo, string> = {
  idea: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z',
  prospecto: 'M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8.5 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM19 8v6M22 11h-6',
  alerta: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  noticia: 'M4 4h13a1 1 0 0 1 1 1v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V4ZM18 8h3v11a2 2 0 0 1-2 2M7 8h7M7 12h7M7 16h4',
  oportunidad: 'm12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5l-5.3 2.9 1.2-6L3.4 9.3l6-.7L12 3Z',
  proyecto: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9',
}
function TipoIcon({ tipo, size = 14 }: { tipo: FeedTipo; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={TIPO_PATH[tipo]} />
    </svg>
  )
}
const CONVERSION_LABEL: Record<FeedConversion, string> = { posible_cliente: 'posible cliente', tarea: 'tarea', proyecto: 'proyecto' }
const OPEN_LABEL: Record<FeedConversion, string> = { posible_cliente: 'Abrir cliente', tarea: 'Abrir tareas', proyecto: 'Abrir proyectos' }
/** El tipo que mejor encaja con cada hallazgo marca la acción principal (las demás siguen a un toque). */
const PRIMARY: Record<FeedTipo, FeedConversion> = { prospecto: 'posible_cliente', alerta: 'tarea', noticia: 'tarea', idea: 'proyecto', oportunidad: 'proyecto', proyecto: 'proyecto' }

function openConverted(c: { a: FeedConversion; id: string | null }) {
  if (c.a === 'posible_cliente') go({ screen: 'clientes', clientId: c.id })
  else go({ screen: c.a === 'tarea' ? 'tareas' : 'proyectos' })
}

// ---------- copiar al portapapeles ----------
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const [st, setSt] = useState<'idle' | 'ok' | 'err'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    setSt((await copyText(text)) ? 'ok' : 'err')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSt('idle'), 2200)
  }
  return (
    <>
      <button type="button" className="fd-btn is-ghost" onClick={() => void copy()}>
        {st === 'ok' ? <Icon name="check" size={14} /> : null}
        {st === 'ok' ? 'Copiado' : st === 'err' ? 'No se pudo copiar' : label}
      </button>
      <span className="fd-sr" role="status">
        {st === 'ok' ? 'Copiado al portapapeles' : st === 'err' ? 'No se pudo copiar' : ''}
      </span>
    </>
  )
}

// ---------- detalle (datos) ----------
function Detalle({ it, d }: { it: FeedItem; d: ReturnType<typeof detailOf> }) {
  return (
    <div className="fd-detail">
      {d.negocio && (
        <div className="fd-biz">
          <span className="fd-lbl">Negocio</span>
          {d.negocio.nombre && <strong>{d.negocio.nombre}</strong>}
          {d.negocio.extra.length > 0 && (
            <dl className="fd-kv">
              {d.negocio.extra.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {d.fugas.length > 0 && (
        <div>
          <h4 className="fd-lbl">Fugas detectadas · {d.fugas.length}</h4>
          <ul className="fd-leaks">
            {d.fugas.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {d.guion && (
        <figure className="fd-script">
          <figcaption className="fd-lbl">Guion</figcaption>
          <blockquote>{d.guion}</blockquote>
          <CopyButton text={d.guion} label="Copiar guion" />
        </figure>
      )}
      {d.urls.length > 0 && (
        <div>
          <h4 className="fd-lbl">Enlaces</h4>
          <ul className="fd-links">
            {d.urls.map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noopener noreferrer">
                  {urlLabel(u)}
                  <span className="fd-sr"> (se abre en otra pestaña)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.metricas.length > 0 && (
        <div>
          <h4 className="fd-lbl">Métricas</h4>
          <dl className="fd-kv is-grid">
            {d.metricas.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {d.contacto.length > 0 && (
        <dl className="fd-kv is-grid">
          {d.contacto.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="fd-foot">
        Publicado por {it.publicado_por.nombre} · <time dateTime={it.publicado_el}>{fullDate(it.publicado_el)}</time>
      </p>
    </div>
  )
}

// ---------- resumen con "ver más" ----------
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const el = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const n = el.current
    if (!n) return
    const measure = () => {
      if (!open) setOver(n.scrollHeight > n.clientHeight + 1)
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(n)
    return () => ro?.disconnect()
  }, [text, open])
  return (
    <div className="fd-sum">
      <p ref={el} className={open ? 'is-open' : ''}>
        {text}
      </p>
      {(over || open) && (
        <button type="button" className="fd-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Ver menos' : 'Ver más'}
        </button>
      )}
    </div>
  )
}

// ---------- formularios en línea de una tarjeta ----------
interface PanelProps {
  busy: boolean
  onClose: () => void
}
const useFirstFocus = <T extends HTMLElement>() => {
  const r = useRef<T>(null)
  useEffect(() => r.current?.focus(), [])
  return r
}
const escape = (close: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

function AjustarForm({ it, busy, onClose, onSubmit, id }: PanelProps & { it: FeedItem; id: string; onSubmit: (b: ConvertBody) => void }) {
  const fromItem = typeof it.datos.origen === 'string' && SOURCES.includes(it.datos.origen) ? it.datos.origen : 'otro'
  const [nombre, setNombre] = useState(nombreSugerido(it).slice(0, 80))
  const [origen, setOrigen] = useState(fromItem)
  const [notas, setNotas] = useState('')
  const first = useFirstFocus<HTMLInputElement>()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!nombre.trim() || busy) return
    onSubmit({ a: 'posible_cliente', nombre: nombre.trim(), origen, ...(notas.trim() ? { notas: notas.trim() } : {}) })
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Ajustar el posible cliente">
      <fieldset disabled={busy}>
        <label>
          <span>Nombre del posible cliente</span>
          <input ref={first} value={nombre} maxLength={80} required onChange={(e) => setNombre(e.target.value)} />
        </label>
        <label>
          <span>¿Cómo llegó?</span>
          <select value={origen} onChange={(e) => setOrigen(e.target.value)}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Notas</span>
          <textarea value={notas} rows={3} maxLength={4000} onChange={(e) => setNotas(e.target.value)} />
          <small>Opcional. Si la dejas vacía se guardan el resumen del hallazgo, sus fugas y el guion.</small>
        </label>
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !nombre.trim()}>
          {busy ? 'Convirtiendo…' : 'Convertir en posible cliente'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function TareaForm({ it, busy, onClose, onSubmit, id }: PanelProps & { it: FeedItem; id: string; onSubmit: (b: ConvertBody, proyecto: string) => void }) {
  const projects = useProjects().filter((p) => p.status !== 'completado')
  const internos = projects.filter((p) => !p.clientId)
  const deClientes = projects.filter((p) => p.clientId)
  const [titulo, setTitulo] = useState(it.titulo.slice(0, 160))
  const [proyecto, setProyecto] = useState('')
  const [vence, setVence] = useState('')
  const first = useFirstFocus<HTMLInputElement>()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!titulo.trim() || busy) return
    const p = projects.find((x) => x.id === proyecto)
    onSubmit({ a: 'tarea', titulo: titulo.trim(), ...(proyecto ? { proyecto_id: proyecto } : {}), ...(vence ? { vence } : {}) }, p ? p.name : 'HAYAI interno')
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Crear una tarea">
      <fieldset disabled={busy}>
        <label>
          <span>Título de la tarea</span>
          <input ref={first} value={titulo} maxLength={160} required onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <div className="fd-two">
          <label>
            <span>Proyecto</span>
            <select value={proyecto} onChange={(e) => setProyecto(e.target.value)}>
              <option value="">HAYAI interno (sin cliente)</option>
              {internos.length > 0 && (
                <optgroup label="Proyectos internos de HAYAI">
                  {internos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {deClientes.length > 0 && (
                <optgroup label="Proyectos de clientes">
                  {deClientes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.client}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label>
            <span>Vence (opcional)</span>
            <input type="date" value={vence} onChange={(e) => setVence(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !titulo.trim()}>
          {busy ? 'Creando…' : 'Crear tarea'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function DescartarForm({ busy, onClose, onSubmit, id }: PanelProps & { id: string; onSubmit: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('')
  const first = useFirstFocus<HTMLInputElement>()
  const hint = `${id}-h`
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy) onSubmit(motivo.trim())
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Descartar este hallazgo">
      <fieldset disabled={busy}>
        <label>
          <span>Motivo (opcional)</span>
          <input ref={first} value={motivo} maxLength={200} aria-describedby={hint} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Ya lo trabajamos con otro canal" />
          <small id={hint}>{motivo.length}/200 · Queda en el hallazgo para que el equipo sepa por qué.</small>
        </label>
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-dark" disabled={busy}>
          {busy ? 'Descartando…' : 'Descartar'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

// ---------- tarjeta ----------
type Panel = 'ajustar' | 'tarea' | 'descartar' | null
type Busy = 'posible_cliente' | 'tarea' | 'proyecto' | 'revisado' | 'descartar' | 'nuevo' | null
interface Done {
  a: FeedConversion
  nombre?: string
  etapa?: string
  proyecto?: string
}
interface CardProps {
  it: FeedItem
  hit: boolean
  onItem: (it: FeedItem) => void
  onGone: (id: string) => void
}

const FeedCard = memo(function FeedCard({ it, hit, onItem, onGone }: CardProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  const [open, setOpen] = useState(false)
  const lock = useRef(false)
  const triggers = useRef<Partial<Record<Exclude<Panel, null>, HTMLButtonElement | null>>>({})
  const doneRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  const detail = detailOf(it)
  const converted = it.estado === 'convertido'
  const pid = `fd-${it.id}`

  useEffect(() => {
    if (done) doneRef.current?.focus()
  }, [done])
  useEffect(() => {
    if (note?.tone === 'ok') noteRef.current?.focus()
  }, [note])

  const closePanel = (back = true) => {
    const was = panel
    setPanel(null)
    if (back && was) requestAnimationFrame(() => triggers.current[was]?.focus())
  }
  const toggle = (p: Exclude<Panel, null>) => {
    setErr('')
    setPanel((cur) => (cur === p ? null : p))
  }

  const refetch = async () => {
    try {
      onItem(await loadFeedItem(it.id))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone(it.id)
    }
  }
  /** Una sola petición a la vez por tarjeta (el candado evita el doble toque aunque React aún no haya repintado). */
  const act = async (kind: Exclude<Busy, null>, fn: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(kind)
    setErr('')
    setNote(null)
    try {
      await fn()
    } catch (e) {
      if (isConflict(e)) {
        setNote({ tone: 'warn', text: 'Este hallazgo cambió mientras lo mirabas. Ya lo actualicé; revísalo y vuelve a intentarlo.' })
        setPanel(null)
        await refetch()
      } else if (e instanceof ApiError && e.status === 409) {
        setNote({ tone: 'warn', text: 'Alguien ya lo convirtió. Te muestro en qué quedó.' })
        setPanel(null)
        await refetch()
      } else if (e instanceof ApiError && e.status === 404) {
        setErr('Este hallazgo ya no existe.')
        onGone(it.id)
      } else {
        setErr(msg(e, 'No se pudo completar la acción. Intenta de nuevo.'))
      }
    } finally {
      lock.current = false
      setBusy(null)
    }
  }

  const convert = (kind: FeedConversion, body: ConvertBody, proyecto?: string) =>
    act(kind, async () => {
      const r = await convertFeed(it, body)
      const det = r.creado.detalle
      const etapa = typeof det.etapa === 'string' ? (STAGE_LABEL[det.etapa] ?? 'Prospecto captado') : 'Prospecto captado'
      setPanel(null)
      setDone({ a: kind, nombre: typeof det.nombre === 'string' ? det.nombre : undefined, etapa, proyecto: typeof det.proyecto === 'string' ? det.proyecto : proyecto })
      onItem(r.item)
      // lo recién creado ya existe en el servidor: las pantallas de trabajo lo vuelven a leer
      const refresh = kind === 'posible_cliente' ? [loadClients()] : kind === 'tarea' ? [loadTasks(), loadProjects()] : [loadProjects()]
      void Promise.allSettled(refresh)
    })

  const mark = (estado: 'nuevo' | 'revisado' | 'descartado', motivo?: string) =>
    act(estado === 'descartado' ? 'descartar' : estado, async () => {
      const n = await markFeed(it, estado, motivo)
      setPanel(null)
      setNote({ tone: 'ok', text: estado === 'nuevo' ? 'Volvió a nuevo.' : estado === 'revisado' ? 'Marcado como revisado.' : 'Descartado.' })
      onItem(n)
    })

  const primary = PRIMARY[it.tipo]
  const isBusy = busy !== null
  const btn = (kind: FeedConversion) => `fd-btn${primary === kind ? ' is-primary' : ''}`

  return (
    <li id={`fd-item-${it.id}`} className={`fd-card is-${it.estado} t-${it.tipo}${hit ? ' is-hit' : ''}`}>
      <article aria-labelledby={`fd-t-${it.id}`} aria-busy={isBusy}>
        <header className="fd-ch">
          <span className={`fd-badge t-${it.tipo}`}>
            <TipoIcon tipo={it.tipo} />
            {FEED_TIPO_LABEL[it.tipo]}
          </span>
          <span className={`fd-state is-${it.estado}`}>
            {it.estado === 'nuevo' && <i aria-hidden="true" />}
            {it.estado === 'revisado' && <Icon name="check" size={12} />}
            {FEED_ESTADO_LABEL[it.estado]}
          </span>
        </header>

        <h3 id={`fd-t-${it.id}`} className="fd-title" tabIndex={-1}>
          {it.titulo}
        </h3>
        <p className="fd-meta">
          <span className="fd-src">{fuenteLabel(it.fuente, it.publicado_por)}</span>
          <span aria-hidden="true"> · </span>
          <time dateTime={it.fecha} title={fullDate(it.fecha)}>
            {ago(it.fecha)}
          </time>
        </p>

        {it.resumen && <Summary text={it.resumen} />}
        {it.estado === 'descartado' && (
          <p className="fd-why">
            <b>Descartado{it.revisado_por ? ` por ${it.revisado_por}` : ''}</b>
            {it.motivo_descarte ? `: ${it.motivo_descarte}` : '. Sin motivo anotado.'}
          </p>
        )}

        {detail.any && (
          <>
            <button type="button" className="fd-link fd-toggle" aria-expanded={open} aria-controls={`${pid}-d`} onClick={() => setOpen((o) => !o)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={open ? 'is-up' : ''}>
                <path d="m6 9 6 6 6-6" />
              </svg>
              {open ? 'Ocultar detalle' : 'Detalle'}
            </button>
            {open && (
              <div id={`${pid}-d`}>
                <Detalle it={it} d={detail} />
              </div>
            )}
          </>
        )}

        {note && (
          <p ref={noteRef} tabIndex={-1} className={`fd-note is-${note.tone}`} role={note.tone === 'warn' ? 'alert' : 'status'}>
            {note.text}
          </p>
        )}
        {err && (
          <p className="hb-err fd-err" role="alert">
            {err}
          </p>
        )}

        {converted ? (
          <div ref={doneRef} tabIndex={-1} className="fd-done" role="status">
            <span className="fd-done-ico" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <p>
              {done ? (
                <>
                  <b>Quedó como {CONVERSION_LABEL[done.a]}</b>
                  {done.a === 'posible_cliente' && <> en «{done.etapa}»</>}
                  {done.a === 'tarea' && done.proyecto && <> en «{done.proyecto}»</>}
                  {done.a === 'proyecto' && done.nombre && <> «{done.nombre}»</>}
                </>
              ) : (
                <>
                  <b>Convertido en {it.convertido ? CONVERSION_LABEL[it.convertido.a] : 'algo real'}</b>
                  {it.revisado_por && (
                    <small>
                      {it.revisado_por}
                      {it.revisado_el ? ` · ${ago(it.revisado_el)}` : ''}
                    </small>
                  )}
                </>
              )}
            </p>
            {it.convertido && (
              <button type="button" className="fd-btn is-ghost" onClick={() => openConverted(it.convertido!)}>
                {OPEN_LABEL[it.convertido.a]} <Icon name="arrow" size={14} />
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="fd-acts" role="group" aria-label={`Convertir: ${it.titulo}`}>
              <div className="fd-split">
                <button type="button" className={btn('posible_cliente')} disabled={isBusy} onClick={() => void convert('posible_cliente', { a: 'posible_cliente' })}>
                  {busy === 'posible_cliente' ? 'Convirtiendo…' : 'Convertir en posible cliente'}
                </button>
                <button
                  type="button"
                  className="fd-adjust"
                  ref={(n) => void (triggers.current.ajustar = n)}
                  disabled={isBusy}
                  aria-expanded={panel === 'ajustar'}
                  aria-controls={`${pid}-aj`}
                  aria-label={`Ajustar antes de convertir en posible cliente: ${it.titulo}`}
                  onClick={() => toggle('ajustar')}
                >
                  Ajustar…
                </button>
              </div>
              <button
                type="button"
                className={btn('tarea')}
                ref={(n) => void (triggers.current.tarea = n)}
                disabled={isBusy}
                aria-expanded={panel === 'tarea'}
                aria-controls={`${pid}-ta`}
                onClick={() => toggle('tarea')}
              >
                <Icon name="check" size={14} /> Crear tarea
              </button>
              <button type="button" className={btn('proyecto')} disabled={isBusy} onClick={() => void convert('proyecto', { a: 'proyecto' })}>
                <Icon name="folder" size={14} /> {busy === 'proyecto' ? 'Creando…' : 'Crear proyecto'}
              </button>
            </div>

            {panel === 'ajustar' && <AjustarForm it={it} id={`${pid}-aj`} busy={busy === 'posible_cliente'} onClose={() => closePanel()} onSubmit={(b) => void convert('posible_cliente', b)} />}
            {panel === 'tarea' && <TareaForm it={it} id={`${pid}-ta`} busy={busy === 'tarea'} onClose={() => closePanel()} onSubmit={(b, p) => void convert('tarea', b, p)} />}
            {panel === 'descartar' && <DescartarForm id={`${pid}-de`} busy={busy === 'descartar'} onClose={() => closePanel()} onSubmit={(m) => void mark('descartado', m)} />}

            <div className="fd-triage" role="group" aria-label={`Revisar: ${it.titulo}`}>
              {it.estado === 'nuevo' && (
                <button type="button" className="fd-quiet" disabled={isBusy} onClick={() => void mark('revisado')}>
                  {busy === 'revisado' ? 'Marcando…' : 'Marcar revisado'}
                </button>
              )}
              {it.estado !== 'nuevo' && (
                <button type="button" className="fd-quiet" disabled={isBusy} onClick={() => void mark('nuevo')}>
                  {busy === 'nuevo' ? 'Volviendo…' : 'Volver a nuevo'}
                </button>
              )}
              {it.estado !== 'descartado' && (
                <button
                  type="button"
                  className="fd-quiet"
                  ref={(n) => void (triggers.current.descartar = n)}
                  disabled={isBusy}
                  aria-expanded={panel === 'descartar'}
                  aria-controls={`${pid}-de`}
                  onClick={() => toggle('descartar')}
                >
                  Descartar
                </button>
              )}
            </div>
          </>
        )}
      </article>
    </li>
  )
})

// ---------- proponer algo ----------
function Proponer({ onClose, onPublished }: { onClose: () => void; onPublished: (it: FeedItem) => void }) {
  const [titulo, setTitulo] = useState('')
  const [tipo, setTipo] = useState<FeedTipo>('idea')
  const [resumen, setResumen] = useState('')
  const [enlace, setEnlace] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [linkErr, setLinkErr] = useState('')
  const first = useFirstFocus<HTMLInputElement>()
  const lock = useRef(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (lock.current) return
    setErr('')
    if (!titulo.trim()) return setErr('Escribe un título.')
    const link = enlace.trim() ? safeUrl(enlace) : null
    if (enlace.trim() && !link) return setLinkErr('El enlace debe empezar por http:// o https://')
    setLinkErr('')
    lock.current = true
    setBusy(true)
    try {
      const r = await publishFeed({ titulo: titulo.trim(), tipo, ...(resumen.trim() ? { resumen: resumen.trim() } : {}), ...(link ? { datos: { urls: [link] } } : {}) })
      onPublished(r)
    } catch (x) {
      setErr(msg(x, 'No se pudo publicar.'))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <form className="fd-form fd-propose" id="fd-propose" onSubmit={(e) => void submit(e)} onKeyDown={escape(onClose)} aria-labelledby="fd-propose-h" noValidate>
      <h3 id="fd-propose-h">Proponer algo al feed</h3>
      <p className="fd-form-lede">Una idea, un negocio que viste o una noticia que le sirve al equipo. Queda publicada con tu nombre.</p>
      <fieldset disabled={busy}>
        <label>
          <span>Título</span>
          <input ref={first} value={titulo} maxLength={160} required onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <div className="fd-two">
          <label>
            <span>Tipo</span>
            <select value={tipo} onChange={(e) => setTipo(e.target.value as FeedTipo)}>
              {FEED_TIPOS.map((t) => (
                <option key={t} value={t}>
                  {FEED_TIPO_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Enlace (opcional)</span>
            <input value={enlace} inputMode="url" placeholder="https://" aria-invalid={!!linkErr} aria-describedby={linkErr ? 'fd-propose-le' : undefined} onChange={(e) => setEnlace(e.target.value)} />
            {linkErr && (
              <small id="fd-propose-le" className="is-err">
                {linkErr}
              </small>
            )}
          </label>
        </div>
        <label>
          <span>Resumen (opcional)</span>
          <textarea value={resumen} rows={3} maxLength={2000} onChange={(e) => setResumen(e.target.value)} />
        </label>
      </fieldset>
      {err && (
        <p className="hb-err" role="alert">
          {err}
        </p>
      )}
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !titulo.trim()}>
          {busy ? 'Publicando…' : 'Publicar en el feed'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

// ---------- filtros ----------
type EstadoSel = FeedEstado | 'todos'
interface Filters {
  estado: EstadoSel
  tipo: FeedTipo | ''
  fuente: string
  q: string
}
const DEFAULTS: Filters = { estado: 'nuevo', tipo: '', fuente: '', q: '' }
const ESTADO_TABS: { key: EstadoSel; label: string }[] = [
  { key: 'nuevo', label: 'Nuevos' },
  { key: 'revisado', label: 'Revisados' },
  { key: 'descartado', label: 'Descartados' },
  { key: 'convertido', label: 'Convertidos' },
  { key: 'todos', label: 'Todos' },
]
const sameFilters = (a: Filters, b: Filters) => a.estado === b.estado && a.tipo === b.tipo && a.fuente === b.fuente && a.q === b.q
const toQuery = (f: Filters): FeedFilters => ({ ...(f.estado !== 'todos' ? { estado: f.estado } : {}), ...(f.tipo ? { tipo: f.tipo } : {}), ...(f.fuente ? { fuente: f.fuente } : {}), ...(f.q ? { q: f.q } : {}) })

/** Une lo recién pedido con lo que ya se veía: lo nuevo manda, y lo que el usuario tocó o aún no se recargó se queda donde estaba. */
function merge(prev: FeedItem[], fresh: FeedItem[], covered: number, kept: Map<string, FeedItem>): FeedItem[] {
  const seen = new Set(fresh.map((x) => x.id))
  const out = [...fresh]
  const tail: FeedItem[] = []
  prev.forEach((x, i) => {
    if (seen.has(x.id)) return
    if (kept.has(x.id)) {
      // lo que el usuario tocó y el filtro ya no devuelve se queda en su sitio cronológico (el feed va del hallazgo más reciente al más viejo)
      const k = kept.get(x.id)!
      const at = out.findIndex((y) => y.fecha < k.fecha)
      out.splice(at === -1 ? out.length : at, 0, k)
    } else if (i >= covered) tail.push(x)
  })
  return [...out, ...tail]
}
function Skeleton() {
  return (
    <div className="fd-skel" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="fd-skel-card">
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>
  )
}

// ---------- el bloque ----------
export default function Feed({ seed }: { seed?: { nuevos: number; total: number } }) {
  const [f, setF] = useState<Filters>(DEFAULTS)
  const [qInput, setQInput] = useState('')
  const [items, setItems] = useState<FeedItem[]>([])
  const [meta, setMeta] = useState<FeedMeta | null>(null)
  const [pinned, setPinned] = useState<FeedItem | null>(null)
  const [loadedPages, setLoadedPages] = useState(1)
  const [firstLoad, setFirstLoad] = useState(true) // aún no llegó la primera respuesta
  const [fetching, setFetching] = useState(false) // hay una petición de la primera página en vuelo
  const [moreBusy, setMoreBusy] = useState(false)
  const [error, setError] = useState('')
  const [moreErr, setMoreErr] = useState('')
  const [proposing, setProposing] = useState(false)
  const [hit, setHit] = useState<string | null>(null)
  const [lost, setLost] = useState(false)

  const seq = useRef(0)
  const fRef = useRef(f)
  fRef.current = f
  const itemsRef = useRef(items)
  itemsRef.current = items
  const pagesRef = useRef(loadedPages)
  pagesRef.current = loadedPages
  const kept = useRef(new Map<string, FeedItem>())
  const focusId = useRef<string | null>(null)
  const focusNew = useRef<string | null>(null) // primera tarjeta que trajo «Cargar más»: recibe el foco
  const hitTimer = useRef(0)
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const proposeBtn = useRef<HTMLButtonElement>(null)

  /** Pide la primera página (con 'refresh', también las que ya estaban cargadas) sin vaciar lo que se ve. */
  const fetchFirst = useCallback((mode: 'filters' | 'refresh') => {
    const mine = ++seq.current
    const q = toQuery(fRef.current)
    const pages = mode === 'refresh' ? Math.min(REFRESH_PAGES, Math.max(1, pagesRef.current)) : 1
    setFetching(true)
    Promise.all(Array.from({ length: pages }, (_, i) => loadFeed({ ...q, page: i + 1, per_page: PER_PAGE })))
      .then((rs) => {
        if (mine !== seq.current) return
        const fresh = rs.flatMap((r) => r.data)
        setMeta(rs[0].meta)
        setItems((prev) => (mode === 'refresh' ? merge(prev, fresh, pages * PER_PAGE, kept.current) : fresh))
        setPinned((p) => (p ? (fresh.find((x) => x.id === p.id) ?? p) : p))
        if (mode === 'filters') setLoadedPages(1)
        setError('')
        setMoreErr('')
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(msg(e, 'No se pudo cargar el feed.'))
      })
      .finally(() => {
        if (mine !== seq.current) return
        setFetching(false)
        setFirstLoad(false)
      })
  }, [])
  const refresh = useCallback(() => fetchFirst('refresh'), [fetchFirst])

  // filtros: cada cambio vuelve a pedir la primera página (lo anterior sigue a la vista hasta que llegue)
  useEffect(() => {
    kept.current.clear()
    fetchFirst('filters')
  }, [f.estado, f.tipo, f.fuente, f.q, fetchFirst])

  // búsqueda con retardo
  useEffect(() => {
    const t = window.setTimeout(() => setF((cur) => (cur.q === qInput.trim() ? cur : { ...cur, q: qInput.trim() })), 300)
    return () => window.clearTimeout(t)
  }, [qInput])

  // en vivo: llegó algo al feed -> se vuelve a pedir (el scroll y los formularios abiertos no se tocan: nada se vuelve a montar)
  const tick = useFeedTick()
  const lastTick = useRef(tick)
  useEffect(() => {
    if (tick === lastTick.current) return
    lastTick.current = tick
    const t = window.setTimeout(refresh, 700)
    return () => window.clearTimeout(t)
  }, [tick, refresh])

  const applyFilters = useCallback(
    (next: Filters) => {
      setPinned(null)
      setQInput(next.q)
      if (sameFilters(next, fRef.current)) refresh()
      else setF(next)
    },
    [refresh],
  )

  /** Muestra una tarjeta concreta: filtra por su estado, la fija arriba si no entra en la primera página y la resalta. */
  const reveal = useCallback(
    (it: FeedItem) => {
      focusId.current = it.id
      setLost(false)
      setPinned(it)
      setQInput('')
      const next: Filters = { ...DEFAULTS, estado: it.estado }
      if (sameFilters(next, fRef.current)) refresh()
      else setF(next)
    },
    [refresh],
  )

  // la campana: al montar y estando ya en el Hub
  useEffect(() => {
    const apply = (fc: FeedFocus | null) => {
      if (!fc) return
      section.current?.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
      if (fc.itemId) {
        const id = fc.itemId
        loadFeedItem(id)
          .then(reveal)
          .catch(() => {
            setLost(true)
            applyFilters(DEFAULTS)
          })
      } else {
        applyFilters({ estado: fc.filters?.estado ?? 'nuevo', tipo: fc.filters?.tipo ?? '', fuente: fc.filters?.fuente ?? '', q: '' })
        heading.current?.focus({ preventScroll: true })
      }
    }
    apply(takeFeedFocus())
    return onFeedFocus(() => apply(takeFeedFocus()))
  }, [reveal, applyFilters])

  const shown = pinned && !items.some((x) => x.id === pinned.id) ? [pinned, ...items] : items

  // tras cargar: baja hasta la tarjeta pedida, la resalta ~2,5 s y deja el foco en su título
  useEffect(() => {
    const id = focusId.current
    if (!id || fetching || firstLoad) return
    const el = document.getElementById(`fd-item-${id}`)
    if (!el) return
    focusId.current = null
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' })
      document.getElementById(`fd-t-${id}`)?.focus({ preventScroll: true })
    })
    setHit(id)
    window.clearTimeout(hitTimer.current)
    hitTimer.current = window.setTimeout(() => setHit(null), 2500)
  }, [shown, fetching, firstLoad])
  useEffect(() => () => window.clearTimeout(hitTimer.current), [])
  useEffect(() => {
    const id = focusNew.current
    if (!id) return
    const el = document.getElementById(`fd-t-${id}`)
    if (!el) return
    focusNew.current = null
    el.focus({ preventScroll: true })
  }, [items])

  const replaceItem = useCallback(
    (it: FeedItem) => {
      kept.current.set(it.id, it)
      setItems((l) => l.map((x) => (x.id === it.id ? it : x)))
      setPinned((p) => (p && p.id === it.id ? it : p))
      refresh() // los contadores (nuevos, por tipo, por estado) salen del servidor
    },
    [refresh],
  )
  const gone = useCallback(
    (id: string) => {
      kept.current.delete(id)
      setItems((l) => l.filter((x) => x.id !== id))
      setPinned((p) => (p && p.id === id ? null : p))
      refresh()
    },
    [refresh],
  )

  const nextPage = loadedPages + 1
  const hasMore = !!meta && nextPage <= Math.ceil(meta.total / PER_PAGE)
  const more = async () => {
    if (moreBusy || !meta) return
    const mine = seq.current
    const page = nextPage
    setMoreBusy(true)
    setMoreErr('')
    try {
      const r = await loadFeed({ ...toQuery(f), page, per_page: PER_PAGE })
      if (mine !== seq.current) return
      const have = new Set(itemsRef.current.map((x) => x.id))
      const add = r.data.filter((x) => !have.has(x.id))
      setItems((l) => [...l, ...add])
      setMeta(r.meta)
      setLoadedPages(page)
      if (add[0]) focusNew.current = add[0].id
    } catch (e) {
      setMoreErr(msg(e, 'No se pudieron cargar más.'))
    } finally {
      setMoreBusy(false)
    }
  }

  // ---- derivados ----
  const nuevos = meta?.nuevos ?? seed?.nuevos ?? null
  const totalAll = meta ? Object.values(meta.por_estado).reduce((a, b) => a + b, 0) : (seed?.total ?? null)
  const extra = !!(f.tipo || f.fuente || f.q)
  const fuentes = meta ? (f.fuente && !meta.fuentes.some((x) => x.fuente === f.fuente) ? [...meta.fuentes, { fuente: f.fuente, total: 0, nuevos: 0 }] : meta.fuentes) : []
  const results = !meta ? '' : shown.length === 0 ? 'Sin resultados' : shown.length < meta.total ? `${shown.length.toLocaleString('es-VE')} de ${plural(meta.total, 'resultado', 'resultados')}` : plural(meta.total, 'resultado', 'resultados')

  const empty = !firstLoad && !error && shown.length === 0
  const showFilters = !(totalAll === 0 && !extra && !firstLoad && !error)

  return (
    <section ref={section} className="hb-block fd-block" aria-labelledby="hb-feed" aria-busy={firstLoad}>
      <header className="hb-bh fd-head">
        <div className="fd-head-main">
          <h2 id="hb-feed" ref={heading} tabIndex={-1}>
            <Icon name="radar" size={16} /> Feed de oportunidades
          </h2>
          <p className="fd-lede">Lo que encontraron las máquinas y los agentes. Lo que hizo el equipo está en la bitácora.</p>
        </div>
        <div className="fd-head-side">
          <p className={`fd-count${nuevos === 0 ? ' is-clear' : ''}`} aria-label={nuevos === null ? 'Contando nuevos' : nuevos === 0 ? 'Al día, no hay nuevos' : plural(nuevos, 'nuevo', 'nuevos')}>
            {nuevos === null ? (
              <span className="fd-count-skel" aria-hidden="true" />
            ) : nuevos === 0 ? (
              <>
                <Icon name="check" size={15} /> <span>Al día</span>
              </>
            ) : (
              <>
                <strong>{nuevos.toLocaleString('es-VE')}</strong> <span>{nuevos === 1 ? 'nuevo' : 'nuevos'}</span>
              </>
            )}
          </p>
          <button type="button" ref={proposeBtn} className="fd-btn is-dark" aria-expanded={proposing} aria-controls="fd-propose" onClick={() => setProposing((p) => !p)}>
            <Icon name="plus" size={14} /> Proponer algo
          </button>
        </div>
      </header>

      <div className={`fd-bar${fetching && !firstLoad ? ' is-on' : ''}`} aria-hidden="true" />

      {proposing && (
        <Proponer
          onClose={() => {
            setProposing(false)
            requestAnimationFrame(() => proposeBtn.current?.focus())
          }}
          onPublished={(it) => {
            setProposing(false)
            reveal(it)
          }}
        />
      )}

      {lost && (
        <p className="fd-note is-warn" role="status">
          No encontramos esa tarjeta; puede que ya no exista. Te dejo el feed completo.
        </p>
      )}

      {showFilters && (
        <div className="fd-filters" role="group" aria-label="Filtros del feed">
          <div className="fd-seg" role="group" aria-label="Estado">
            {ESTADO_TABS.map((t) => {
              const n = meta ? (t.key === 'todos' ? Object.values(meta.por_estado).reduce((a, b) => a + b, 0) : meta.por_estado[t.key]) : null
              return (
                <button key={t.key} type="button" className={f.estado === t.key ? 'is-on' : ''} aria-pressed={f.estado === t.key} onClick={() => setF((c) => ({ ...c, estado: t.key }))}>
                  {t.label} {n !== null && <em>{n.toLocaleString('es-VE')}</em>}
                </button>
              )
            })}
          </div>
          <div className="fd-chips" role="group" aria-label="Tipo de hallazgo">
            <button type="button" className={`fd-chip${f.tipo === '' ? ' is-on' : ''}`} aria-pressed={f.tipo === ''} aria-label={`Todos los tipos${meta ? `, ${plural(meta.nuevos, 'nuevo', 'nuevos')}` : ''}`} onClick={() => setF((c) => ({ ...c, tipo: '' }))}>
              Todos {meta && <em className={meta.nuevos === 0 ? 'is-zero' : ''}>{meta.nuevos.toLocaleString('es-VE')}</em>}
            </button>
            {FEED_TIPOS.map((t) => {
              const n = meta?.por_tipo[t]?.nuevos
              return (
                <button key={t} type="button" className={`fd-chip t-${t}${f.tipo === t ? ' is-on' : ''}`} aria-pressed={f.tipo === t} aria-label={`${FEED_TIPO_LABEL[t]}${n !== undefined ? `, ${plural(n, 'nuevo', 'nuevos')}` : ''}`} onClick={() => setF((c) => ({ ...c, tipo: c.tipo === t ? '' : t }))}>
                  <TipoIcon tipo={t} size={13} />
                  {FEED_TIPO_LABEL[t]} {n !== undefined && <em className={n === 0 ? 'is-zero' : ''}>{n.toLocaleString('es-VE')}</em>}
                </button>
              )
            })}
          </div>
          <div className="fd-find">
            <label className="fd-field">
              <span className="fd-sr">Fuente</span>
              <select value={f.fuente} onChange={(e) => setF((c) => ({ ...c, fuente: e.target.value }))}>
                <option value="">Todas las fuentes</option>
                {fuentes.map((x) => (
                  <option key={x.fuente} value={x.fuente}>
                    {fuenteLabel(x.fuente)} · {plural(x.nuevos, 'nuevo', 'nuevos')}
                  </option>
                ))}
              </select>
            </label>
            <label className="fd-field fd-search">
              <span className="fd-sr">Buscar en título y resumen</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5" />
              </svg>
              <input type="search" value={qInput} maxLength={100} placeholder="Buscar en título y resumen" onChange={(e) => setQInput(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      <p className={`fd-results${empty ? ' fd-sr' : ''}`} role="status" aria-live="polite">
        {results}
      </p>

      {error && (
        <div className="hb-alert fd-alert" role="alert">
          <p>
            {meta ? 'No pudimos actualizar el feed; ves lo último que cargó.' : 'No pudimos cargar el feed.'} <small>{error}</small>
          </p>
          <button type="button" className="fd-btn is-ghost" onClick={() => (meta ? refresh() : fetchFirst('filters'))}>
            Reintentar
          </button>
        </div>
      )}

      {firstLoad && !error && <Skeleton />}

      {empty && <Empty f={f} extra={extra} initial={totalAll === 0} onPropose={() => setProposing(true)} onFilters={setF} onClear={() => applyFilters({ ...f, tipo: '', fuente: '', q: '' })} />}

      {shown.length > 0 && (
        <ul className="fd-list">
          {shown.map((it) => (
            <FeedCard key={it.id} it={it} hit={hit === it.id} onItem={replaceItem} onGone={gone} />
          ))}
        </ul>
      )}

      {hasMore && shown.length > 0 && (
        <div className="fd-more">
          <button type="button" className="fd-btn" onClick={() => void more()} disabled={moreBusy}>
            {moreBusy ? 'Cargando…' : `Cargar más · ${plural(Math.max(0, (meta?.total ?? 0) - items.length), 'restante', 'restantes')}`}
          </button>
          {moreErr && (
            <p className="hb-err" role="alert">
              {moreErr}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---------- vacíos ----------
function Empty({ f, extra, initial, onPropose, onFilters, onClear }: { f: Filters; extra: boolean; initial: boolean; onPropose: () => void; onFilters: (fn: (c: Filters) => Filters) => void; onClear: () => void }): ReactNode {
  if (initial)
    return (
      <div className="fd-empty is-initial">
        <h3>Todavía no ha llegado nada al feed</h3>
        <p>Aquí aparece lo que se encuentra por fuera del equipo. Llega por tres caminos:</p>
        <ul>
          <li>
            <b>Growi</b> publica después de cada corrida de Gumloop (radar, cazador, video-auditorías).
          </li>
          <li>
            El <b>Muse de cada socio</b> puede enviar lo que encuentre mientras trabaja.
          </li>
          <li>
            Tú mismo, con <b>«Proponer algo»</b>.
          </li>
        </ul>
        <button type="button" className="fd-btn is-primary" onClick={onPropose}>
          <Icon name="plus" size={14} /> Proponer algo
        </button>
      </div>
    )
  if (extra)
    return (
      <div className="fd-empty">
        <h3>Nada coincide con esos filtros</h3>
        <p>
          No hay {f.estado === 'todos' ? 'hallazgos' : `hallazgos ${FEED_ESTADO_LABEL[f.estado].toLowerCase()}s`} con esa combinación de tipo, fuente y búsqueda.
        </p>
        <button type="button" className="fd-btn is-primary" onClick={onClear}>
          Quitar filtros
        </button>
      </div>
    )
  if (f.estado === 'nuevo')
    return (
      <div className="fd-empty is-clear">
        <h3>
          <Icon name="check" size={18} /> Estás al día
        </h3>
        <p>No hay nada nuevo. Mira los revisados o lo descartado.</p>
        <div className="fd-actions">
          <button type="button" className="fd-btn" onClick={() => onFilters((c) => ({ ...c, estado: 'revisado' }))}>
            Ver revisados
          </button>
          <button type="button" className="fd-btn" onClick={() => onFilters((c) => ({ ...c, estado: 'descartado' }))}>
            Ver descartados
          </button>
        </div>
      </div>
    )
  return (
    <div className="fd-empty">
      <h3>Aquí no hay nada {f.estado === 'todos' ? 'todavía' : `${FEED_ESTADO_LABEL[f.estado].toLowerCase()}`}</h3>
      <p>{f.estado === 'revisado' ? 'Lo que marques como revisado queda aquí.' : f.estado === 'descartado' ? 'Lo que descartes queda aquí, con su motivo.' : 'Lo que conviertas en cliente, tarea o proyecto queda aquí.'}</p>
      <button type="button" className="fd-btn" onClick={() => onFilters((c) => ({ ...c, estado: 'todos' }))}>
        Ver todo el feed
      </button>
    </div>
  )
}
