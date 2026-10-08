// Feed de oportunidades (planeta HAYAI / Hub): lo que las máquinas y los agentes ENCONTRARON. No es la bitácora (lo que el equipo
// HIZO): aquí cada hallazgo es una tarjeta que se convierte en algo (posible cliente, tarea, proyecto), se revisa, se descarta o se guarda.
//
// Dos piezas: `FeedEntry` (la tarjeta compacta que vive en la página del Hub) y `FeedScreen` (la vista propia del feed, #hub/feed).
// Revisar, descartar y guardar son PERSONALES; convertir es GLOBAL (lo ve todo el equipo).
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from './api'
import { refreshAlerts } from './live'
import { SOURCE_LABEL } from './clientLog'
import {
  FEED_ESTADO_LABEL,
  FEED_TIPOS,
  FEED_TIPO_LABEL,
  accionPrincipal,
  accionesDe,
  categoriaLabel,
  closeFeed,
  conGuion,
  conceptoDe,
  contactoDe,
  convertFeed,
  conversionDe,
  cortar,
  destinoCobro,
  fmtN,
  fuenteLabel,
  isGrowi,
  isRec,
  loadFeed,
  loadFeedItem,
  markFeed,
  onFeedFocus,
  openFeed,
  origenUrl,
  publishFeed,
  publishNuevos,
  safeUrl,
  saveFeed,
  takeFeedFocus,
  undoFeed,
  urlLabel,
  useFeedTick,
  useKnownNuevos,
  vistaDe,
  yaCreada,
  notifyFeed,
  type AccionId,
  type ConvertBody,
  type CreadoKind,
  type EnlaceContacto,
  type FeedConversion,
  type FeedEstado,
  type FeedFilters,
  type FeedFocus,
  type FeedItem,
  type FeedMeta,
  type FeedTipo,
  type MiEstado,
} from './feedData'
import { go, requestFicha } from './nav'
import { loadProjects, useProjects } from './projectData'
import { loadProposals, openProposal } from './proposalData'
import { pushToast } from './toast'
import { useSession } from './session'
import { addDays, fmtDate, loadClients, money, todayISO } from './store'
import { loadTasks, taskNow } from './taskData'
import { ago } from './time'
import { Icon } from './ui'
import './feed.css'

const PER_PAGE = 20
/** cuántas páginas ya cargadas se vuelven a pedir en una recarga (el resto se conserva tal cual) */
const REFRESH_PAGES = 5
const SOURCES = ['referido', 'instagram', 'whatsapp', 'facebook', 'meta_ads', 'web', 'visita_frio', 'evento', 'otro']
const STAGE_LABEL: Record<string, string> = { prospecto: 'Prospecto captado', visita_agendada: 'Visita agendada', visita_realizada: 'Visita realizada', propuesta_en_armado: 'Propuesta en armado', propuesta_presentada: 'Segunda visita' }

// ---------- helpers de presentación ----------
const plural = (n: number, one: string, many: string) => `${fmtN(n)} ${n === 1 ? one : many}`
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const fullDate = (iso: string) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'long', timeStyle: 'short' })
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const scalar = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? fmtN(v) : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : null)
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(scalar).filter((x): x is string => !!x) : scalar(v) ? [scalar(v)!] : [])
const keyLabel = (k: string) => k.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

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
  const origen = scalar(d.origen)
  const out = { negocio: negocioOf(d), fugas: listOf(d.fugas), guion: scalar(d.guion), urls, metricas, origen }
  const any = !!out.negocio || out.fugas.length > 0 || !!out.guion || urls.length > 0 || metricas.length > 0 || !!origen
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
  return <Svg d={TIPO_PATH[tipo]} size={size} />
}
const PATH = {
  bookmark: 'M6.5 3h11a1.5 1.5 0 0 1 1.5 1.5V21l-7-4.4L5 21V4.5A1.5 1.5 0 0 1 6.5 3Z',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM3.5 6.5 12 13l8.5-6.5',
  phone: 'M5 3.5h3.2l1.6 4.2-2 1.3a11 11 0 0 0 5.2 5.2l1.3-2 4.2 1.6V17a2.5 2.5 0 0 1-2.5 2.5A14.5 14.5 0 0 1 2.5 6 2.5 2.5 0 0 1 5 3.5Z',
  whatsapp: 'M20 11.6A8.1 8.1 0 0 1 8 18.7L4 20l1.3-3.9A8.1 8.1 0 1 1 20 11.6ZM9.3 8.6c.2 3 2.7 5.6 5.8 6l1.2-1.4-2-1-.9.6a4.4 4.4 0 0 1-2.3-2.3l.6-.9-1-2Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z',
  instagram: 'M7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9A4.5 4.5 0 0 1 7.5 3ZM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6ZM17.2 6.8h.01',
  facebook: 'M14.5 21v-7.5H17l.5-3h-3V8.8c0-.9.3-1.5 1.6-1.5H17.6V4.6c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.1H9v3h2.5V21',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
} as const
function Svg({ d, size = 14, fill = false }: { d: string; size?: number; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  )
}
const LINK_ICON: Record<EnlaceContacto['tipo'], string> = { web: PATH.globe, instagram: PATH.instagram, facebook: PATH.facebook, enlace: PATH.link }

/** Sello de Growi: el castor paciente y el tejón valiente, reducidos a una estampa sobria (aro, franjas de tejón y un punto de miel). */
function GrowiSeal() {
  return (
    <span className="fd-growi" title="Lo encontró Growi">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9.6" />
        <path d="M9.2 4.6v6M14.8 4.6v6" strokeWidth="2.4" />
        <path d="M8.6 14.2h.01M15.4 14.2h.01" strokeWidth="2.6" />
        <path d="M10.4 17.4h3.2" />
      </svg>
      Growi
    </span>
  )
}

const CONVERSION_LABEL: Record<CreadoKind, string> = { posible_cliente: 'posible cliente', cliente: 'cliente', tarea: 'tarea', seguimiento: 'seguimiento', proyecto: 'proyecto', propuesta: 'propuesta' }
/** Destinos del panel «Con ajustes» (el seguimiento y la propuesta tienen su propio botón). */
type Dest = 'posible_cliente' | 'cliente' | 'tarea' | 'proyecto'
const DEST_LABEL: Record<Dest, string> = { posible_cliente: 'Posible cliente', cliente: 'Cliente', tarea: 'Tarea', proyecto: 'Proyecto' }
/** Convertir en (posible) cliente según el vínculo —solo prospectos y oportunidades—, más tarea y proyecto. */
const destinosDe = (it: FeedItem): Dest[] => {
  const c = conversionDe(it)
  return c ? [c, 'tarea', 'proyecto'] : ['tarea', 'proyecto']
}
const HECHO_LABEL: Record<Exclude<CreadoKind, 'cliente' | 'posible_cliente'>, string> = { tarea: 'Tarea', seguimiento: 'Seguimiento', proyecto: 'Proyecto', propuesta: 'Propuesta' }
const LISTO: Record<FeedConversion, string> = { posible_cliente: 'Posible cliente creado', cliente: 'Cliente activado', tarea: 'Tarea creada', seguimiento: 'Seguimiento creado', proyecto: 'Proyecto creado' }

/** Abre lo que ya se creó desde el ítem: el detalle de la tarea (su proyecto), el proyecto, o la ficha del cliente (propuesta, cliente). */
function openCreated(kind: CreadoKind, id: string | null, it: FeedItem) {
  if (kind === 'posible_cliente' || kind === 'cliente' || kind === 'propuesta') {
    const cid = it.vinculo.cliente_id ?? (kind === 'propuesta' ? null : id)
    if (cid) return go({ screen: 'clientes', clientId: cid })
    return go({ screen: 'clientes' })
  }
  if (kind === 'proyecto' && id) return void (location.hash = `proyectos/${id}`)
  const t = id ? taskNow(id) : undefined
  if (t) return void (location.hash = `proyectos/${t.projectId}`)
  go({ screen: 'tareas' })
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
          <h4 className="fd-lbl">Fugas detectadas · {fmtN(d.fugas.length)}</h4>
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
      {d.origen && (
        <dl className="fd-kv is-grid">
          <div>
            <dt>Origen</dt>
            <dd>{d.origen}</dd>
          </div>
        </dl>
      )}
      <p className="fd-foot">
        Publicado por {it.publicado_por.nombre} · <time dateTime={it.publicado_el}>{fullDate(it.publicado_el)}</time>
      </p>
    </div>
  )
}

// ---------- contacto ----------
const external = { target: '_blank', rel: 'noopener noreferrer' } as const
/** Las otras maneras de llegar al negocio (más teléfonos, correos, redes). El botón principal (WhatsApp/Llamar) vive en la barra de acciones. */
function Contacto({ it }: { it: FeedItem }) {
  const c = useMemo(() => contactoDe(it.datos), [it.datos])
  const main = accionPrincipal(c)
  // lo que el botón principal ya muestra no se repite abajo
  const otherTels = c.tels.filter((t) => t.display !== main?.detalle)
  const mails = c.correos.filter((m) => main?.tipo !== 'email' || m !== main.detalle)
  const links = c.enlaces.slice(0, 4)
  if (otherTels.length + mails.length + links.length === 0) return null
  return (
    <div className="fd-contact" role="group" aria-label={`Contacto: ${it.titulo}`}>
      <ul className="fd-reach">
        {otherTels.map((t) => (
          <li key={t.tel}>
            <a href={t.tel} aria-label={`Llamar al ${t.display}`}>
              <Svg d={PATH.phone} size={13} />
              {t.display}
            </a>
          </li>
        ))}
        {mails.map((m) => (
          <li key={m}>
            <a href={`mailto:${m}`} aria-label={`Enviar correo a ${m}`}>
              <Svg d={PATH.mail} size={13} />
              <span>{m}</span>
            </a>
          </li>
        ))}
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} {...external}>
              <Svg d={LINK_ICON[l.tipo]} size={13} />
              <span>{l.label}</span>
              <span className="fd-sr"> (se abre en otra pestaña)</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- resumen cortado en palabra completa, con "ver más" ----------
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const c = useMemo(() => cortar(text), [text])
  return (
    <div className="fd-sum">
      <p>{open || !c.cortado ? text : c.texto}</p>
      {c.cortado && (
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

/** Responsable: los socios (nombres que llegan del Hub); por defecto, quien tiene la sesión. */
function ResponsableField({ owners, me, value, onChange }: { owners: string[]; me: string; value: string; onChange: (v: string) => void }) {
  const opts = useMemo(() => [...new Set([me, ...owners].filter(Boolean))], [me, owners])
  return (
    <label>
      <span>Responsable</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map((n) => (
          <option key={n} value={n}>
            {n === me ? `${n} (tú)` : n}
          </option>
        ))}
      </select>
    </label>
  )
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
          <span>Nombre</span>
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
          <span>Notas (opcional)</span>
          <textarea value={notas} rows={3} maxLength={4000} onChange={(e) => setNotas(e.target.value)} />
        </label>
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !nombre.trim()}>
          {busy ? 'Convirtiendo…' : 'Convertir'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function TareaForm({ it, owners, me, busy, onClose, onSubmit, id }: PanelProps & { it: FeedItem; owners: string[]; me: string; id: string; onSubmit: (b: ConvertBody, proyecto: string) => void }) {
  const projects = useProjects().filter((p) => p.status !== 'completado')
  const internos = projects.filter((p) => !p.clientId)
  const deClientes = projects.filter((p) => p.clientId)
  const [titulo, setTitulo] = useState(it.titulo.slice(0, 160))
  const [proyecto, setProyecto] = useState('')
  const [vence, setVence] = useState('')
  const [resp, setResp] = useState(me || owners[0] || '')
  const first = useFirstFocus<HTMLInputElement>()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!titulo.trim() || busy) return
    const p = projects.find((x) => x.id === proyecto)
    onSubmit({ a: 'tarea', titulo: titulo.trim(), ...(resp ? { responsable: resp } : {}), ...(proyecto ? { proyecto_id: proyecto } : {}), ...(vence ? { vence } : {}) }, p ? p.name : 'HAYAI interno')
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Ajustar la tarea">
      <fieldset disabled={busy}>
        <label>
          <span>Título</span>
          <input ref={first} value={titulo} maxLength={160} required onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <div className="fd-two">
          <ResponsableField owners={owners} me={me} value={resp} onChange={setResp} />
          <label>
            <span>Vence (opcional)</span>
            <input type="date" value={vence} onChange={(e) => setVence(e.target.value)} />
          </label>
        </div>
        <label>
          <span>Proyecto</span>
          <select value={proyecto} onChange={(e) => setProyecto(e.target.value)}>
            <option value="">{it.vinculo.cliente_id ? `Proyecto de ${it.vinculo.cliente ?? 'su cliente'} (o HAYAI interno)` : 'HAYAI interno (sin cliente)'}</option>
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
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !titulo.trim()}>
          {busy ? 'Creando…' : 'Convertir'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function ProyectoForm({ it, owners, me, busy, onClose, onSubmit, id }: PanelProps & { it: FeedItem; owners: string[]; me: string; id: string; onSubmit: (b: ConvertBody) => void }) {
  const [nombre, setNombre] = useState(nombreSugerido(it).slice(0, 80))
  const [resp, setResp] = useState(me || owners[0] || '')
  const [descripcion, setDescripcion] = useState('')
  const first = useFirstFocus<HTMLInputElement>()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!nombre.trim() || busy) return
    onSubmit({ a: 'proyecto', nombre: nombre.trim(), ...(resp ? { responsable: resp } : {}), ...(descripcion.trim() ? { descripcion: descripcion.trim() } : {}) })
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Ajustar el proyecto">
      <fieldset disabled={busy}>
        <div className="fd-two">
          <label>
            <span>Nombre</span>
            <input ref={first} value={nombre} maxLength={80} required onChange={(e) => setNombre(e.target.value)} />
          </label>
          <ResponsableField owners={owners} me={me} value={resp} onChange={setResp} />
        </div>
        <label>
          <span>Descripción (opcional)</span>
          <textarea value={descripcion} rows={3} maxLength={4000} placeholder="Si la dejas vacía se llena con el resumen y los datos del hallazgo." onChange={(e) => setDescripcion(e.target.value)} />
        </label>
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || !nombre.trim()}>
          {busy ? 'Creando…' : 'Convertir'}
        </button>
        <button type="button" className="fd-btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

/** Promover al posible cliente vinculado: día de implementación y, si tiene una propuesta vigente, cómo se le cobra (se generan los cobros). */
function ClienteForm({ it, busy, onClose, onSubmit, id }: PanelProps & { it: FeedItem; id: string; onSubmit: (b: ConvertBody) => void }) {
  const hoy = todayISO()
  const [impl, setImpl] = useState(hoy)
  const [inicio, setInicio] = useState(addDays(hoy, 30))
  const [meses, setMeses] = useState('12')
  const [unicos, setUnicos] = useState(false)
  const [vigente, setVigente] = useState<{ version: number; mensual: number; unico: number } | null | undefined>(undefined) // undefined: consultando
  const first = useFirstFocus<HTMLInputElement>()
  useEffect(() => {
    let live = true
    const cid = it.vinculo.cliente_id
    if (!cid) return setVigente(null)
    void loadProposals(cid)
      .then((l) => {
        const p = l.find((x) => x.estado === 'borrador' || x.estado === 'presentada')
        if (live) setVigente(p ? { version: p.version, mensual: p.totales.mensual, unico: p.totales.unico } : null)
      })
      .catch(() => live && setVigente(null))
    return () => {
      live = false
    }
  }, [it.vinculo.cliente_id])
  const m = Number(meses)
  const mesesOk = Number.isInteger(m) && m >= 2 && m <= 36
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy || !impl || (vigente && (!inicio || !mesesOk))) return
    onSubmit({ a: 'cliente', fecha_implementacion: impl, ...(vigente ? { esquema_cobro: { inicio_cobro: inicio, meses: m, unicos_cobrados: unicos } } : {}) })
  }
  return (
    <form className="fd-form" id={id} onSubmit={submit} onKeyDown={escape(onClose)} aria-label="Convertir en cliente">
      <fieldset disabled={busy}>
        <label>
          <span>Día de implementación</span>
          <input ref={first} type="date" value={impl} required onChange={(e) => setImpl(e.target.value)} />
        </label>
        {vigente === undefined && <p className="fd-hint">Revisando si tiene una propuesta vigente…</p>}
        {vigente && (
          <>
            <p className="fd-hint">
              Tiene la propuesta v{vigente.version} vigente ({money(vigente.mensual)} por mes{vigente.unico > 0 ? ` + ${money(vigente.unico)} único` : ''}): al aceptarla se generan las mensualidades.
            </p>
            <div className="fd-two">
              <label>
                <span>Primera mensualidad</span>
                <input type="date" value={inicio} required onChange={(e) => setInicio(e.target.value)} />
              </label>
              <label>
                <span>Meses (2 a 36)</span>
                <input inputMode="numeric" value={meses} onChange={(e) => setMeses(e.target.value)} aria-invalid={!mesesOk} />
              </label>
            </div>
            {vigente.unico > 0 && (
              <label className="fd-check">
                <input type="checkbox" checked={unicos} onChange={(e) => setUnicos(e.target.checked)} />
                <span>Los pagos únicos ya están cobrados</span>
              </label>
            )}
          </>
        )}
      </fieldset>
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy || vigente === undefined || !impl || (!!vigente && (!inicio || !mesesOk))}>
          {busy ? 'Convirtiendo…' : 'Convertir en cliente'}
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
          <input ref={first} value={motivo} maxLength={200} aria-describedby={hint} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Ya lo trabajamos por otro canal" />
          <small id={hint}>{motivo.length}/200</small>
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
type Panel = 'ajustar' | 'descartar' | null
type Busy = 'convertir' | 'revisado' | 'descartar' | 'nuevo' | 'guardar' | null
interface Done {
  a: FeedConversion
  nombre?: string
  etapa?: string
  proyecto?: string
  vence?: string
}
interface CardProps {
  it: FeedItem
  hit: boolean
  owners: string[]
  me: string
  onItem: (it: FeedItem) => void
  onGone: (id: string) => void
}

const FeedCard = memo(function FeedCard({ it, hit, owners, me, onItem, onGone }: CardProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const acciones = useMemo(() => accionesDe(it), [it])
  const contacto = useMemo(() => accionPrincipal(contactoDe(it.datos)), [it.datos])
  const [dest, setDest] = useState<Dest>(() => (acciones.principal === 'posible_cliente' || acciones.principal === 'cliente' || acciones.principal === 'tarea' || acciones.principal === 'proyecto' ? acciones.principal : (conversionDe(it) ?? 'tarea')))
  const [flash, setFlash] = useState<FeedConversion | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  const [open, setOpen] = useState(false)
  const [said, setSaid] = useState('')
  const lock = useRef(false)
  const triggers = useRef<Partial<Record<Exclude<Panel, null>, HTMLButtonElement | null>>>({})
  const doneRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  const detail = detailOf(it)
  const converted = it.estado === 'convertido'
  const vista = vistaDe(it)
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
      void refreshAlerts().catch(() => {}) // revisar, descartar o convertir cambia lo que la campana avisa
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNote({ tone: 'warn', text: `${e.message}. Te muestro cómo quedó.` })
        setPanel(null)
        await refetch()
      } else if (e instanceof ApiError && e.status === 400 && /esquema_cobro/i.test(e.message)) {
        // promover un posible cliente con propuesta vigente pide el esquema de cobro: se abre el formulario
        setDest('cliente')
        setPanel('ajustar')
        setErr('Tiene una propuesta vigente: indica cómo se le cobra.')
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
    act('convertir', async () => {
      const r = await convertFeed(it, body)
      const det = r.creado.detalle
      const etapa = typeof det.etapa === 'string' ? (STAGE_LABEL[det.etapa] ?? 'Prospecto captado') : 'Prospecto captado'
      const nombre = typeof det.nombre === 'string' ? det.nombre : typeof det.titulo === 'string' ? det.titulo : undefined
      const vence = typeof det.vence === 'string' ? det.vence : undefined
      setPanel(null)
      setDone({ a: kind, nombre, etapa, proyecto: typeof det.proyecto === 'string' ? det.proyecto : proyecto, vence })
      onItem(r.item)
      // confirmación: el botón y la tarjeta hacen un pulso breve (sin movimiento si el socio lo tiene desactivado)
      setFlash(kind)
      window.setTimeout(() => setFlash(null), 1400)
      // lo recién creado ya existe en el servidor: las pantallas de trabajo lo vuelven a leer
      const refresh = () => Promise.allSettled(kind === 'posible_cliente' || kind === 'cliente' ? [loadClients(), loadProjects(), loadTasks()] : kind === 'proyecto' ? [loadProjects()] : [loadTasks(), loadProjects()])
      void refresh()
      // «Listo ✓» flotante con «Deshacer»: revierte esa conversión (lo creado va a la papelera) y el feed se vuelve a leer
      pushToast({
        text: `Listo ✓ ${LISTO[kind]}`,
        detail: [nombre ? `«${nombre}»` : null, kind === 'seguimiento' && vence ? `vence el ${fmtDate(vence, true)}` : null].filter(Boolean).join(' · ') || undefined,
        undo: async () => {
          await undoFeed(it, kind)
          await refresh()
          notifyFeed()
          void refreshAlerts().catch(() => {})
          pushToast({ text: 'Deshecho', detail: 'El hallazgo volvió a como estaba.', tone: 'info', ms: 3500 })
        },
      })
    })
  const body = (a: FeedConversion): ConvertBody => (a === 'tarea' || a === 'seguimiento' ? { a, ...(me ? { responsable: me } : {}) } : { a })
  /** Un toque, con lo pre-llenado: título, resumen y vínculo del ítem (la tarea queda a nombre de quien la crea). */
  const quick = (a: FeedConversion) => void convert(a, body(a), a === 'tarea' || a === 'seguimiento' ? (it.vinculo.cliente ? `el proyecto de ${it.vinculo.cliente}` : 'HAYAI interno') : undefined)
  /** «Crear propuesta»: abre la ficha del cliente con el formulario ya prellenado con lo del ítem. */
  const proponer = () => {
    const cid = it.vinculo.cliente_id
    if (!cid) return
    openProposal({
      clientId: cid,
      feedItemId: it.id,
      ...(conceptoDe(it.datos) ? { concepto: conceptoDe(it.datos)! } : {}),
      notas: cortar(`Hallazgo del feed: ${it.titulo}${it.resumen ? ` — ${it.resumen}` : ''}`, 1000).texto,
    })
    go({ screen: 'clientes', clientId: cid })
  }
  const registrarCobro = () => {
    const d = destinoCobro(it)
    if (!d) return
    if (d.clienteId) {
      requestFicha({ clientId: d.clienteId, tab: 'cobros', cobroId: d.cobroId })
      go({ screen: 'clientes', clientId: d.clienteId })
    } else go({ screen: 'finanzas' })
  }

  const mark = (estado: MiEstado, motivo?: string) =>
    act(estado === 'descartado' ? 'descartar' : estado === 'revisado' ? 'revisado' : 'nuevo', async () => {
      const n = await markFeed(it, estado, motivo)
      setPanel(null)
      setNote({ tone: 'ok', text: estado === 'nuevo' ? 'Volvió a nuevo.' : estado === 'revisado' ? 'Marcado como revisado.' : 'Descartado.' })
      onItem(n)
    })

  const save = () =>
    act('guardar', async () => {
      const n = await saveFeed(it, !it.guardado)
      setSaid(n.guardado ? 'Guardado' : 'Quitado de guardados')
      onItem(n)
    })

  const isBusy = busy !== null

  /** Un botón de la barra. El principal va lleno (una sola por tarjeta); lo que ya se creó dice «✓ Creada» y abre su detalle. */
  const renderAccion = (a: AccionId, primary: boolean): ReactNode => {
    const cls = `fd-btn${primary ? ' is-primary' : ' fd-sm'}`
    const just = (k: FeedConversion) => (flash === k ? ' is-just' : '')
    if (a === 'contacto' && contacto) {
      const wa = contacto.tipo === 'whatsapp'
      return (
        <a
          className={`fd-btn ${primary ? 'is-contact' : 'is-contact-soft fd-sm'}`}
          href={wa ? conGuion(contacto.href, it.datos) : contacto.href}
          {...(wa ? external : {})}
          aria-label={`${wa ? 'Escribir por WhatsApp a' : contacto.tipo === 'llamar' ? 'Llamar al' : 'Enviar correo a'} ${contacto.detalle}${wa && typeof it.datos.guion === 'string' ? ' con el guion ya escrito' : ''}`}
        >
          <Svg d={wa ? PATH.whatsapp : contacto.tipo === 'llamar' ? PATH.phone : PATH.mail} size={primary ? 16 : 14} />
          {contacto.label}
          <span className="fd-btn-sub">{contacto.detalle}</span>
        </a>
      )
    }
    if (a === 'origen') {
      const href = origenUrl(it.datos)
      if (!href) return null
      return (
        <a className={cls} href={href} {...external}>
          Ver origen <Svg d={PATH.external} size={13} />
          <span className="fd-sr"> (se abre en otra pestaña)</span>
        </a>
      )
    }
    if (a === 'cobro') return <button type="button" className={cls} disabled={isBusy} onClick={registrarCobro}>Registrar cobro</button>
    if (a === 'posible_cliente' || a === 'cliente') {
      return (
        <button type="button" className={`${cls}${just(a)}`} disabled={isBusy} onClick={() => quick(a)}>
          {busy === 'convertir' ? 'Convirtiendo…' : a === 'cliente' ? 'Convertir en cliente' : 'Convertir en posible cliente'}
        </button>
      )
    }
    if (a === 'propuesta' || a === 'tarea' || a === 'seguimiento' || a === 'proyecto') {
      if (yaCreada(it, a)) {
        const c = it.creados[a]!
        return (
          <button
            type="button"
            className={`fd-btn fd-sm fd-is-done${just(a === 'propuesta' ? 'tarea' : a)}`}
            onClick={() => openCreated(a, c.id, it)}
            aria-label={`${HECHO_LABEL[a]} ya creada${c.por ? ` por ${c.por}` : ''}: abrir`}
            title={c.por ? `Creada por ${c.por}` : undefined}
          >
            ✓ Creada
            <span className="fd-btn-sub">{HECHO_LABEL[a]}</span>
          </button>
        )
      }
      if (a === 'propuesta') return <button type="button" className={cls} disabled={isBusy} onClick={proponer}>Crear propuesta</button>
      const labels = { tarea: 'Crear tarea', seguimiento: 'Seguimiento en 3 días', proyecto: 'Crear proyecto' } as const
      const doing = { tarea: 'Creando…', seguimiento: 'Creando…', proyecto: 'Creando…' } as const
      return (
        <button type="button" className={`${cls}${just(a)}`} disabled={isBusy} onClick={() => quick(a)}>
          {busy === 'convertir' ? doing[a] : labels[a]}
        </button>
      )
    }
    return null
  }

  return (
    <li id={`fd-item-${it.id}`} className={`fd-card is-${vista} t-${it.tipo}${hit ? ' is-hit' : ''}${flash ? ' is-flash' : ''}`}>
      <article aria-labelledby={`fd-t-${it.id}`} aria-busy={isBusy}>
        <header className="fd-ch">
          <div className="fd-ch-l">
            <span className={`fd-badge t-${it.tipo}`}>
              <TipoIcon tipo={it.tipo} />
              {FEED_TIPO_LABEL[it.tipo]}
            </span>
            {it.categoria && <span className="fd-cat">{categoriaLabel(it.categoria)}</span>}
          </div>
          <div className="fd-ch-r">
            <span className={`fd-state is-${vista}`} title={vista === 'revisado' || vista === 'descartado' ? 'Solo tú lo ves así' : undefined}>
              {vista === 'nuevo' && <i aria-hidden="true" />}
              {vista === 'revisado' && <Icon name="check" size={12} />}
              {FEED_ESTADO_LABEL[vista]}
            </span>
            <button type="button" className={`fd-save${it.guardado ? ' is-on' : ''}`} aria-pressed={it.guardado} aria-label={`Guardar: ${it.titulo}`} title={it.guardado ? 'Quitar de guardados (solo tú lo ves)' : 'Guardar (solo tú lo ves)'} disabled={busy === 'guardar'} onClick={() => void save()}>
              <Svg d={PATH.bookmark} size={18} fill={it.guardado} />
            </button>
          </div>
        </header>

        <h3 id={`fd-t-${it.id}`} className="fd-title" tabIndex={-1}>
          {it.titulo}
        </h3>
        <p className="fd-meta">
          {isGrowi(it.fuente) ? <GrowiSeal /> : <span className="fd-src">{fuenteLabel(it.fuente, it.publicado_por)}</span>}
          <span aria-hidden="true"> · </span>
          <time dateTime={it.fecha} title={fullDate(it.fecha)}>
            {ago(it.fecha)}
          </time>
        </p>

        {it.resumen && <Summary text={it.resumen} />}
        {vista === 'descartado' && (
          <p className="fd-why">
            <b>Lo descartaste</b>
            {it.motivo_descarte ? `: ${it.motivo_descarte}` : '.'}
          </p>
        )}

        <Contacto it={it} />

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
        <span className="fd-sr" role="status">
          {said}
        </span>

        {converted && (
          <div ref={doneRef} tabIndex={-1} className="fd-done" role="status">
            <span className="fd-done-ico" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <p>
              <span>
                <b>Convertido{it.convertido ? ` en ${CONVERSION_LABEL[it.convertido.a]}` : ''}</b>
                {it.convertido?.por && <> por {it.convertido.por}</>}
                {it.convertido?.el && (
                  <>
                    {' · '}
                    <time dateTime={it.convertido.el} title={fullDate(it.convertido.el)}>
                      {ago(it.convertido.el)}
                    </time>
                  </>
                )}
              </span>
              {done && (
                <small>
                  {done.a === 'posible_cliente' && <>Quedó en «{done.etapa}»</>}
                  {(done.a === 'tarea' || done.a === 'seguimiento') && done.proyecto && <>Quedó en «{done.proyecto}»</>}
                  {done.a === 'proyecto' && done.nombre && <>Quedó como «{done.nombre}»</>}
                  {done.a === 'cliente' && <>Ya es cliente activo</>}
                </small>
              )}
            </p>
          </div>
        )}

        <div className="fd-bar2" role="group" aria-label={`Acciones: ${it.titulo}`}>
          {acciones.principal && <div className="fd-main">{renderAccion(acciones.principal, true)}</div>}
          <div className="fd-sec">
            {acciones.secundarias.map((a) => (
              <span key={a} className="fd-sec-i">
                {renderAccion(a, false)}
              </span>
            ))}
            {it.vinculo.estado !== 'sin_vinculo' && it.vinculo.cliente_id && (
              <button type="button" className="fd-btn fd-sm" onClick={() => go({ screen: 'clientes', clientId: it.vinculo.cliente_id })}>
                Ficha de {it.vinculo.cliente}
                <span className="fd-btn-sub">{it.vinculo.estado === 'cliente' ? 'Cliente' : 'Posible cliente'}</span>
              </button>
            )}
            <button
              type="button"
              className="fd-btn fd-sm fd-adj"
              ref={(n) => void (triggers.current.ajustar = n)}
              disabled={isBusy}
              aria-expanded={panel === 'ajustar'}
              aria-controls={`${pid}-aj`}
              onClick={() => toggle('ajustar')}
            >
              Con ajustes…
            </button>
          </div>
        </div>

        {panel === 'ajustar' && (
          <div className="fd-adjust" id={`${pid}-aj`}>
            <div className="fd-dest" role="radiogroup" aria-label="Crear con ajustes">
              <span className="fd-dest-l" aria-hidden="true">
                Crear con ajustes
              </span>
              {destinosDe(it).map((k) => (
                <label key={k} className={dest === k ? 'is-on' : ''}>
                  <input type="radio" name={`${pid}-dest`} value={k} checked={dest === k} disabled={isBusy} onChange={() => setDest(k)} />
                  <span>{DEST_LABEL[k]}</span>
                </label>
              ))}
            </div>
            {dest === 'posible_cliente' && <AjustarForm it={it} id={`${pid}-aj-f`} busy={busy === 'convertir'} onClose={() => closePanel()} onSubmit={(b) => void convert('posible_cliente', b)} />}
            {dest === 'cliente' && <ClienteForm it={it} id={`${pid}-aj-f`} busy={busy === 'convertir'} onClose={() => closePanel()} onSubmit={(b) => void convert('cliente', b)} />}
            {dest === 'tarea' && <TareaForm it={it} owners={owners} me={me} id={`${pid}-aj-f`} busy={busy === 'convertir'} onClose={() => closePanel()} onSubmit={(b, p) => void convert('tarea', b, p)} />}
            {dest === 'proyecto' && <ProyectoForm it={it} owners={owners} me={me} id={`${pid}-aj-f`} busy={busy === 'convertir'} onClose={() => closePanel()} onSubmit={(b) => void convert('proyecto', b)} />}
          </div>
        )}
        {panel === 'descartar' && <DescartarForm id={`${pid}-de`} busy={busy === 'descartar'} onClose={() => closePanel()} onSubmit={(m) => void mark('descartado', m)} />}

        {!converted && (
          <div className="fd-triage" role="group" aria-label={`Revisar: ${it.titulo}`}>
            {it.mi_estado === 'nuevo' && (
              <button type="button" className="fd-quiet" disabled={isBusy} onClick={() => void mark('revisado')}>
                {busy === 'revisado' ? 'Marcando…' : 'Marcar revisado'}
              </button>
            )}
            {it.mi_estado !== 'nuevo' && (
              <button type="button" className="fd-quiet" disabled={isBusy} onClick={() => void mark('nuevo')}>
                {busy === 'nuevo' ? 'Volviendo…' : 'Volver a nuevo'}
              </button>
            )}
            {it.mi_estado !== 'descartado' && (
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
            <span className="fd-mine">
              <Svg d={PATH.eye} size={12} /> Solo tú lo ves así
            </span>
          </div>
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
    if (enlace.trim() && !link) return setLinkErr('Debe empezar por http:// o https://')
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
      <h3 id="fd-propose-h">Proponer algo</h3>
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
          {busy ? 'Publicando…' : 'Publicar'}
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
  /** '' = todas, 'sin_categoria' o el nombre de la categoría */
  categoria: string
  guardado: boolean
  q: string
}
const DEFAULTS: Filters = { estado: 'nuevo', tipo: '', fuente: '', categoria: '', guardado: false, q: '' }
const ESTADO_TABS: { key: EstadoSel; label: string }[] = [
  { key: 'nuevo', label: 'Nuevos' },
  { key: 'revisado', label: 'Revisados' },
  { key: 'descartado', label: 'Descartados' },
  { key: 'convertido', label: 'Convertidos' },
  { key: 'todos', label: 'Todos' },
]
const sameFilters = (a: Filters, b: Filters) => a.estado === b.estado && a.tipo === b.tipo && a.fuente === b.fuente && a.categoria === b.categoria && a.guardado === b.guardado && a.q === b.q
const toQuery = (f: Filters): FeedFilters => ({
  ...(f.estado !== 'todos' ? { estado: f.estado } : {}),
  ...(f.tipo ? { tipo: f.tipo } : {}),
  ...(f.fuente ? { fuente: f.fuente } : {}),
  ...(f.categoria ? { categoria: f.categoria } : {}),
  ...(f.guardado ? { guardado: true } : {}),
  ...(f.q ? { q: f.q } : {}),
})

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

/** Avisa cuando el centinela está a la vista dentro del contenedor que se desplaza (el scroll de la pantalla), con un colchón para cargar antes de llegar. */
function useSentinel(onHit: () => void, enabled: boolean, version: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onHit)
  cb.current = onHit
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    if (typeof IntersectionObserver !== 'function') return void cb.current()
    // se vuelve a observar tras cada carga: si el centinela sigue a la vista (lista corta), dispara otra vez
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && cb.current(), { root: el.closest('.hb-scroll'), rootMargin: '0px 0px 520px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [enabled, version])
  return ref
}

// ---------- la vista del feed ----------
export function FeedScreen({ owners }: { owners: string[] }) {
  const me = useSession()?.name ?? ''
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
  const [loadedMsg, setLoadedMsg] = useState('')

  const seq = useRef(0)
  const fRef = useRef(f)
  fRef.current = f
  const itemsRef = useRef(items)
  itemsRef.current = items
  const pagesRef = useRef(loadedPages)
  pagesRef.current = loadedPages
  const metaRef = useRef(meta)
  metaRef.current = meta
  const kept = useRef(new Map<string, FeedItem>())
  const focusId = useRef<string | null>(null)
  const moreLock = useRef(false)
  const hitTimer = useRef(0)
  const refreshTimer = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const filtersEl = useRef<HTMLDivElement>(null)
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
        const prevTotal = metaRef.current?.total ?? 0
        setMeta(rs[0].meta)
        publishNuevos(rs[0].meta.nuevos)
        setItems((prev) => (mode === 'refresh' ? merge(prev, fresh, pages * PER_PAGE, kept.current) : fresh))
        setPinned((p) => (p ? (fresh.find((x) => x.id === p.id) ?? p) : p))
        if (mode === 'filters') setLoadedPages(1)
        // si la lista del servidor encogió y hay páginas más allá de lo refrescado, la siguiente página se pide un poco antes (se repite en vez de saltarse)
        else if (pagesRef.current > pages && rs[0].meta.total < prevTotal) setLoadedPages((p) => Math.max(pages, p - Math.ceil((prevTotal - rs[0].meta.total) / PER_PAGE)))
        setError('')
        setMoreErr('')
        // un filtro nuevo vuelve al inicio de la lista (salvo que se esté llevando a una tarjeta concreta)
        if (mode === 'filters' && !focusId.current) {
          const top = filtersEl.current
          if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start', behavior: 'auto' })
        }
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
  /** Varios cambios seguidos (guardar, revisar...) se juntan en una sola recarga. */
  const refreshSoon = useCallback(() => {
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(refresh, 350)
  }, [refresh])
  useEffect(() => () => window.clearTimeout(refreshTimer.current), [])

  // filtros: cada cambio vuelve a pedir la primera página (lo anterior sigue a la vista hasta que llegue)
  useEffect(() => {
    kept.current.clear()
    fetchFirst('filters')
  }, [f.estado, f.tipo, f.fuente, f.categoria, f.guardado, f.q, fetchFirst])

  // búsqueda con retardo
  useEffect(() => {
    const t = window.setTimeout(() => setF((cur) => (cur.q === qInput.trim() ? cur : { ...cur, q: qInput.trim() })), 300)
    return () => window.clearTimeout(t)
  }, [qInput])

  // en vivo: llegó algo al feed -> se vuelve a pedir lo cargado hasta ahora (el scroll y los formularios abiertos no se tocan: nada se vuelve a montar)
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
      const next: Filters = { ...DEFAULTS, estado: vistaDe(it) }
      if (sameFilters(next, fRef.current)) refresh()
      else setF(next)
    },
    [refresh],
  )

  // lo que pidió la campana: al abrir la vista y estando ya en ella
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    const apply = (fc: FeedFocus | null) => {
      if (!fc) return
      if (fc.itemId) {
        const id = fc.itemId
        loadFeedItem(id)
          .then(reveal)
          .catch(() => {
            setLost(true)
            applyFilters(DEFAULTS)
          })
      } else {
        applyFilters({ ...DEFAULTS, estado: fc.filters?.estado ?? 'nuevo', tipo: fc.filters?.tipo ?? '', fuente: fc.filters?.fuente ?? '' })
        heading.current?.focus({ preventScroll: true })
      }
    }
    // enlace directo (#hub/feed/<id>), como el de las notas de conversión: si nadie pidió otra cosa, se enfoca ese ítem
    const linked = location.hash.match(/^#hub\/feed\/([0-9a-f-]{36})\/?$/i)?.[1]
    apply(takeFeedFocus() ?? (linked ? { itemId: linked } : null))
    return onFeedFocus(() => apply(takeFeedFocus()))
  }, [reveal, applyFilters])

  // al salir de la vista, el foco vuelve a la tarjeta de acceso del Hub
  useEffect(
    () => () => {
      requestAnimationFrame(() => document.getElementById('fd-entry')?.focus({ preventScroll: true }))
    },
    [],
  )

  const shown = useMemo(() => (pinned && !items.some((x) => x.id === pinned.id) ? [pinned, ...items] : items), [pinned, items])

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

  const replaceItem = useCallback(
    (it: FeedItem) => {
      kept.current.set(it.id, it)
      setItems((l) => l.map((x) => (x.id === it.id ? it : x)))
      setPinned((p) => (p && p.id === it.id ? it : p))
      refreshSoon() // los contadores (nuevos, guardados, por tipo, por estado) salen del servidor
    },
    [refreshSoon],
  )
  const gone = useCallback(
    (id: string) => {
      kept.current.delete(id)
      setItems((l) => l.filter((x) => x.id !== id))
      setPinned((p) => (p && p.id === id ? null : p))
      refreshSoon()
    },
    [refreshSoon],
  )

  // ---- scroll infinito: páginas de 20, lo ya cargado no se vuelve a pedir ----
  const nextPage = loadedPages + 1
  const hasMore = !!meta && loadedPages * PER_PAGE < meta.total
  const more = useCallback(async () => {
    const m = metaRef.current
    if (moreLock.current || !m) return
    const mine = seq.current
    const page = pagesRef.current + 1
    if ((page - 1) * PER_PAGE >= m.total) return
    moreLock.current = true
    setMoreBusy(true)
    setMoreErr('')
    try {
      const r = await loadFeed({ ...toQuery(fRef.current), page, per_page: PER_PAGE })
      if (mine !== seq.current) return
      // los avisos en vivo corren la lista: lo que ya estaba cargado no se duplica
      const have = new Set(itemsRef.current.map((x) => x.id))
      const add = r.data.filter((x) => !have.has(x.id))
      setItems((l) => {
        const ids = new Set(l.map((x) => x.id))
        return [...l, ...add.filter((x) => !ids.has(x.id))]
      })
      setMeta(r.meta)
      publishNuevos(r.meta.nuevos)
      setLoadedPages(page)
      if (add.length) setLoadedMsg(`${plural(add.length, 'hallazgo más', 'hallazgos más')}`)
    } catch (e) {
      setMoreErr(msg(e, 'No se pudieron cargar más.'))
    } finally {
      moreLock.current = false
      setMoreBusy(false)
    }
  }, [])
  const sentinel = useSentinel(() => void more(), hasMore && !firstLoad && !fetching && !moreErr && shown.length > 0, `${items.length}:${loadedPages}:${moreBusy}`)

  // ---- derivados ----
  const nuevos = meta?.nuevos ?? null
  const totalAll = meta ? Object.values(meta.por_estado).reduce((a, b) => a + b, 0) : null
  const extra = !!(f.tipo || f.fuente || f.categoria || f.q)
  const fuentes = meta ? (f.fuente && !meta.fuentes.some((x) => x.fuente === f.fuente) ? [...meta.fuentes, { fuente: f.fuente, total: 0, nuevos: 0 }] : meta.fuentes) : []
  const categorias = meta?.categorias ?? []
  const showCat = !!meta && (categorias.length > 0 || !!f.categoria)
  const results = !meta ? '' : shown.length === 0 ? 'Sin resultados' : shown.length < meta.total ? `${fmtN(shown.length)} de ${plural(meta.total, 'resultado', 'resultados')}` : plural(meta.total, 'resultado', 'resultados')

  const empty = !firstLoad && !error && shown.length === 0
  const showFilters = !(totalAll === 0 && !extra && !f.guardado && !firstLoad && !error)
  const end = !hasMore && !firstLoad && !error && shown.length > 0

  const toggleSaved = () =>
    setF((c) => {
      const on = !c.guardado
      // al mirar guardados se ven todos (también los ya revisados); al soltarlo vuelve a «Nuevos»
      return { ...c, guardado: on, estado: on ? 'todos' : c.estado === 'todos' ? 'nuevo' : c.estado }
    })

  return (
    <main className="screen layer hub-screen fd-screen" aria-label="Feed de oportunidades">
      <div className="hb-scroll">
        <div className="hb-wrap">
          <button className="hb-back" onClick={closeFeed}>
            <Icon name="back" size={16} />
            Volver al Hub
          </button>

          <header className="hb-head fd-phead">
            <div>
              <p className="hb-eyebrow">Planeta HAYAI · Feed</p>
              <h1 id="hb-feed" ref={heading} tabIndex={-1}>
                Feed de oportunidades
              </h1>
              <p className="fd-lede">Revisar, descartar y guardar: solo tú lo ves. Lo convertido lo ve todo el equipo.</p>
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
                    <strong>{fmtN(nuevos)}</strong> <span>{nuevos === 1 ? 'nuevo' : 'nuevos'}</span>
                  </>
                )}
              </p>
              <button type="button" ref={proposeBtn} className="fd-btn is-dark" aria-expanded={proposing} aria-controls="fd-propose" onClick={() => setProposing((p) => !p)}>
                <Icon name="plus" size={14} /> Proponer algo
              </button>
            </div>
          </header>

          <section className="hb-block fd-block" aria-labelledby="hb-feed" aria-busy={firstLoad}>
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
                Esa tarjeta ya no existe. Te dejo el feed completo.
              </p>
            )}

            {showFilters && (
              <div className="fd-filters" role="group" aria-label="Filtros del feed" ref={filtersEl}>
                <div className="fd-row">
                  <div className="fd-seg" role="group" aria-label="Estado">
                    {ESTADO_TABS.map((t) => {
                      const n = meta ? (t.key === 'todos' ? Object.values(meta.por_estado).reduce((a, b) => a + b, 0) : meta.por_estado[t.key]) : null
                      return (
                        <button key={t.key} type="button" className={f.estado === t.key ? 'is-on' : ''} aria-pressed={f.estado === t.key} onClick={() => setF((c) => ({ ...c, estado: t.key }))}>
                          {t.label} {n !== null && <em>{fmtN(n)}</em>}
                        </button>
                      )
                    })}
                  </div>
                  <button type="button" className={`fd-chip fd-saved${f.guardado ? ' is-on' : ''}`} aria-pressed={f.guardado} onClick={toggleSaved}>
                    <Svg d={PATH.bookmark} size={14} fill={f.guardado} />
                    Guardados {meta && <em className={meta.guardados === 0 ? 'is-zero' : ''}>{fmtN(meta.guardados)}</em>}
                  </button>
                </div>
                <div className="fd-chips" role="group" aria-label="Tipo de hallazgo">
                  <button type="button" className={`fd-chip${f.tipo === '' ? ' is-on' : ''}`} aria-pressed={f.tipo === ''} aria-label={`Todos los tipos${meta ? `, ${plural(meta.nuevos, 'nuevo', 'nuevos')}` : ''}`} onClick={() => setF((c) => ({ ...c, tipo: '' }))}>
                    Todos {meta && <em className={meta.nuevos === 0 ? 'is-zero' : ''}>{fmtN(meta.nuevos)}</em>}
                  </button>
                  {FEED_TIPOS.map((t) => {
                    const n = meta?.por_tipo[t]?.nuevos
                    return (
                      <button key={t} type="button" className={`fd-chip t-${t}${f.tipo === t ? ' is-on' : ''}`} aria-pressed={f.tipo === t} aria-label={`${FEED_TIPO_LABEL[t]}${n !== undefined ? `, ${plural(n, 'nuevo', 'nuevos')}` : ''}`} onClick={() => setF((c) => ({ ...c, tipo: c.tipo === t ? '' : t }))}>
                        <TipoIcon tipo={t} size={13} />
                        {FEED_TIPO_LABEL[t]} {n !== undefined && <em className={n === 0 ? 'is-zero' : ''}>{fmtN(n)}</em>}
                      </button>
                    )
                  })}
                </div>
                <div className={`fd-find${showCat ? ' has-cat' : ''}`}>
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
                  {showCat && (
                    <label className="fd-field">
                      <span className="fd-sr">Categoría</span>
                      <select value={f.categoria} onChange={(e) => setF((c) => ({ ...c, categoria: e.target.value }))}>
                        <option value="">Todas las categorías</option>
                        {categorias.map((x) => (
                          <option key={x.categoria} value={x.categoria}>
                            {categoriaLabel(x.categoria)} · {fmtN(x.total)}
                          </option>
                        ))}
                        {(meta?.sin_categoria ?? 0) > 0 && <option value="sin_categoria">Sin categoría · {fmtN(meta!.sin_categoria)}</option>}
                      </select>
                    </label>
                  )}
                  <label className="fd-field fd-search">
                    <span className="fd-sr">Buscar en título y resumen</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5" />
                    </svg>
                    <input type="search" value={qInput} maxLength={100} placeholder="Buscar" onChange={(e) => setQInput(e.target.value)} />
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

            {empty && <Empty f={f} extra={extra} initial={totalAll === 0} onPropose={() => setProposing(true)} onFilters={setF} onClear={() => applyFilters({ ...f, tipo: '', fuente: '', categoria: '', guardado: false, q: '' })} />}

            {shown.length > 0 && (
              <ul className="fd-list">
                {shown.map((it) => (
                  <FeedCard key={it.id} it={it} hit={hit === it.id} owners={owners} me={me} onItem={replaceItem} onGone={gone} />
                ))}
              </ul>
            )}

            {shown.length > 0 && (
              <div className="fd-end">
                {hasMore && <div ref={sentinel} className="fd-sentinel" aria-hidden="true" data-next={nextPage} />}
                {moreBusy && (
                  <p className="fd-loading">
                    <span className="fd-spin" aria-hidden="true" /> Cargando más…
                  </p>
                )}
                {moreErr && (
                  <div className="fd-more-err" role="alert">
                    <p className="hb-err">{moreErr}</p>
                    <button type="button" className="fd-btn" onClick={() => void more()}>
                      Reintentar
                    </button>
                  </div>
                )}
                {end && (
                  <p className="fd-done-list">
                    Hasta aquí llegamos <span aria-hidden="true">🚀</span>
                  </p>
                )}
                <span className="fd-sr" role="status">
                  {loadedMsg}
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

// ---------- vacíos ----------
function Empty({ f, extra, initial, onPropose, onFilters, onClear }: { f: Filters; extra: boolean; initial: boolean; onPropose: () => void; onFilters: (fn: (c: Filters) => Filters) => void; onClear: () => void }): ReactNode {
  if (initial)
    return (
      <div className="fd-empty is-initial">
        <h3>Aún no llega nada</h3>
        <p>Aquí caen los hallazgos de Growi, de los Muse y los que propongas.</p>
        <button type="button" className="fd-btn is-primary" onClick={onPropose}>
          <Icon name="plus" size={14} /> Proponer algo
        </button>
      </div>
    )
  if (f.guardado || extra)
    return (
      <div className="fd-empty">
        <h3>{f.guardado && !extra ? 'Nada guardado' : 'Nada coincide'}</h3>
        <p>{f.guardado && !extra ? 'Toca el marcador de una tarjeta para guardarla.' : 'Prueba con otros filtros.'}</p>
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
        <p>No queda nada nuevo.</p>
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
      <h3>Aquí no hay nada {f.estado === 'todos' ? 'todavía' : `${FEED_ESTADO_LABEL[f.estado as FeedEstado].toLowerCase()}`}</h3>
      <p>{f.estado === 'revisado' ? 'Lo que marques como revisado queda aquí.' : f.estado === 'descartado' ? 'Lo que descartes queda aquí.' : 'Lo que se convierta en cliente, tarea o proyecto queda aquí.'}</p>
      <button type="button" className="fd-btn" onClick={() => onFilters((c) => ({ ...c, estado: 'todos' }))}>
        Ver todo
      </button>
    </div>
  )
}

// ---------- la tarjeta de acceso (vive en la página del Hub) ----------
export function FeedEntry({ seed }: { seed?: { nuevos: number; total: number } }) {
  const known = useKnownNuevos()
  const nuevos = known ?? seed?.nuevos ?? null
  const tick = useFeedTick()
  const first = useRef(true)
  // llegó algo en vivo: se actualiza el contador (barato: una página de un solo ítem)
  useEffect(() => {
    if (first.current) return void (first.current = false)
    const t = window.setTimeout(() => {
      loadFeed({ per_page: 1, estado: 'nuevo' })
        .then((r) => publishNuevos(r.meta.nuevos))
        .catch(() => {})
    }, 900)
    return () => window.clearTimeout(t)
  }, [tick])
  return (
    <button type="button" id="fd-entry" className="fd-entry" onClick={() => openFeed()} aria-label={nuevos === null ? 'Feed de oportunidades' : `Feed de oportunidades, ${nuevos === 0 ? 'al día' : plural(nuevos, 'nuevo', 'nuevos')}`}>
      <span className="fd-entry-ico" aria-hidden="true">
        <Icon name="radar" size={22} />
      </span>
      <span className="fd-entry-txt">
        <strong>Feed de oportunidades</strong>
        <small>Hallazgos de los agentes, listos para revisar.</small>
      </span>
      <span className={`fd-entry-count${nuevos === 0 ? ' is-clear' : ''}`} aria-hidden="true">
        {nuevos === null ? (
          <i className="fd-count-skel" />
        ) : nuevos === 0 ? (
          <>
            <Icon name="check" size={14} /> Al día
          </>
        ) : (
          <>
            <b>{fmtN(nuevos)}</b> {nuevos === 1 ? 'nuevo' : 'nuevos'}
          </>
        )}
      </span>
      <span className="fd-entry-go" aria-hidden="true">
        <Icon name="arrow" size={16} />
      </span>
    </button>
  )
}

export default FeedEntry
