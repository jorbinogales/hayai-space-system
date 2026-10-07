import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './orbital.css'
import type { Loaded, PipelineStage } from './hubData'
import { fmtDate, money, stats, type Client } from './store'
import { ago } from './time'
import { useDragScroll } from './drag'
import { Icon } from './ui'
import { reduced } from './warp'

// Vistas alternativas de Clientes: «Orbital» (SVG 2D, sin WebGL) y «Pipeline» (columnas). Las etapas, sus nombres y sus
// probabilidades salen SIEMPRE de GET /pipeline/stages (hubData.loadStages): aqui no hay ni un nombre de etapa escrito.

export type ViewMode = 'planeta' | 'orbital' | 'pipeline'
const VIEW_KEY = 'hayai:clientes:vista'
const VIEWS: { id: ViewMode; label: string }[] = [
  { id: 'planeta', label: 'Planeta' },
  { id: 'orbital', label: 'Orbital' },
  { id: 'pipeline', label: 'Pipeline' },
]

/** La vista elegida se recuerda en este navegador (un extra: si el almacenamiento falla, arranca en el planeta). */
export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      return v === 'orbital' || v === 'pipeline' ? v : 'planeta'
    } catch {
      return 'planeta'
    }
  })
  const set = (v: ViewMode) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* sin almacenamiento: la vista simplemente no se recuerda */
    }
  }
  return [view, set]
}

/** Selector de vista (Planeta · Orbital · Pipeline), el mismo en la pantalla del planeta y en las vistas planas. */
export function ViewSwitch({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="ob-switch" role="group" aria-label="Vista de clientes">
      {VIEWS.map((v) => (
        <button key={v.id} type="button" aria-pressed={view === v.id} className={view === v.id ? 'is-on' : ''} onClick={() => onChange(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  )
}

// ---------- datos ----------
/** Lo que /clients ya manda de cada cliente y que el tipo base del store aun no declara. */
export type Lead = Client & {
  stage?: string | null
  estValue?: number | null
  probability?: number | null
  expectedClose?: string | null
  lostReason?: string | null
  nextAction?: string | null
  nextActionDate?: string | null
  source?: string | null
  stageChangedAt?: string | null
  lastContactAt?: string | null
}

const SOURCE: Record<string, string> = {
  referido: 'Referido',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  meta_ads: 'Meta Ads',
  web: 'Web',
  visita_frio: 'Visita en frío',
  evento: 'Evento',
  otro: 'Otro',
}

export interface Model {
  /** las etapas abiertas (por posicion) y, al final, la ganada: de la orbita exterior a la interior */
  orbits: PipelineStage[]
  /** todas las etapas activas por posicion, con la perdida: para las columnas del pipeline */
  columns: PipelineStage[]
  lost: PipelineStage | null
  byStage: Map<string, Lead[]>
  /** posibles perdidos: solo viven en la columna del pipeline */
  lostLeads: Lead[]
}

const byValue = (a: Lead, b: Lead) => (b.estValue ?? -1) - (a.estValue ?? -1) || a.name.localeCompare(b.name, 'es')

/**
 * Reparte a cada cliente en la etapa que le toca. Un cliente de antes del pipeline (sin etapa) cuenta como ganado si ya firmo,
 * o como recien captado si es un posible. Una etapa desconocida cae en la primera abierta.
 */
export function buildModel(stages: PipelineStage[], clients: Lead[]): Model {
  const active = stages.filter((s) => s.activa).sort((a, b) => a.posicion - b.posicion)
  const open = active.filter((s) => s.tipo === 'abierta')
  const won = active.find((s) => s.tipo === 'ganada') ?? null
  const lost = active.find((s) => s.tipo === 'perdida') ?? null
  const orbits = [...open, ...(won ? [won] : [])]
  const byStage = new Map<string, Lead[]>(orbits.map((s) => [s.etapa, []]))
  const lostLeads: Lead[] = []
  for (const c of clients) {
    const key = c.stage ?? (c.prospect ? open[0]?.etapa : won?.etapa) ?? null
    if (key === null) continue
    if (lost && key === lost.etapa) lostLeads.push(c)
    else (byStage.get(key) ?? byStage.get(open[0]?.etapa ?? ''))?.push(c)
  }
  for (const l of byStage.values()) l.sort(byValue)
  lostLeads.sort(byValue)
  return { orbits, columns: active, lost, byStage, lostLeads }
}

/** Probabilidad que se muestra: la propia del cliente si la tiene; si no, la de su etapa. */
const probOf = (c: Lead, st?: PipelineStage) => c.probability ?? st?.probabilidad ?? null

// ---------- marco plano (cabecera + selector) ----------
/** Capa plana de las vistas orbital y pipeline: se monta sobre el planeta y deja el cajon History por encima. */
export function FlatFrame({
  view,
  onView,
  onBack,
  onNew,
  onProspect,
  eyebrow,
  title,
  children,
}: {
  view: ViewMode
  onView: (v: ViewMode) => void
  onBack: () => void
  onNew: () => void
  onProspect: () => void
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="ob-flat" data-view={view}>
     <div className="ob-scroll">
      <div className="ob-wrap">
        <button type="button" className="ob-back" onClick={onBack}>
          <Icon name="back" size={16} />
          Volver al core
        </button>
        <header className="ob-head">
          <div>
            <p className="ob-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
          </div>
          <div className="ob-head-side">
            <ViewSwitch view={view} onChange={onView} />
            <div className="ob-actions">
              <button type="button" className="ob-btn is-primary" onClick={onNew}>
                <Icon name="plus" size={15} />
                Nuevo cliente
              </button>
              <button type="button" className="ob-btn" onClick={onProspect}>
                <Icon name="plus" size={15} />
                Posible cliente
              </button>
            </div>
          </div>
        </header>
        {children}
      </div>
     </div>
    </div>
  )
}

/** Estado de la carga de etapas: mientras no llegan (o fallan) no se dibuja nada inventado. */
function StagesGate({ stages, children }: { stages: Loaded<PipelineStage[]>; children: (s: PipelineStage[]) => ReactNode }) {
  if (stages.data) return <>{children(stages.data)}</>
  if (stages.error)
    return (
      <div className="ob-note is-err" role="alert">
        <p>No se pudieron cargar las etapas del pipeline. {stages.error}</p>
        <button type="button" className="ob-btn" onClick={stages.reload}>
          Reintentar
        </button>
      </div>
    )
  return (
    <p className="ob-note" aria-busy="true">
      Cargando las etapas del pipeline…
    </p>
  )
}

// ---------- vista orbital ----------
const C = 370 // centro del lienzo (740 x 740)
const R_OUT = 352
const R_IN = 95
const rad = (i: number, n: number) => (n <= 1 ? R_IN : R_OUT - (i * (R_OUT - R_IN)) / (n - 1))
const OPEN_DOTS = 5
// tintes de los satelites (del diseno): de «recien captado» a «ganado»
const DOTS = [
  { fill: 'rgba(22,17,11,0.55)', stroke: 'none', r: 7 },
  { fill: 'rgba(22,17,11,0.75)', stroke: 'none', r: 8 },
  { fill: '#9a5b00', stroke: 'none', r: 9 },
  { fill: '#ef9d25', stroke: 'none', r: 10 },
  { fill: '#ef9d25', stroke: '#16110b', r: 11 },
  { fill: '#ffd27a', stroke: '#16110b', r: 12 },
]
const dotOf = (i: number, n: number, won: boolean) => {
  if (won && i === n - 1) return DOTS[5]
  const open = won ? n - 1 : n
  return DOTS[open <= 1 ? 0 : Math.min(OPEN_DOTS - 1, Math.round((i * (OPEN_DOTS - 1)) / (open - 1)))]
}
const MAX_LEADS = 40 // con mas leads que esto, las orbitas exteriores se agrupan en «+N»

interface Sat {
  lead: Lead
  x: number
  y: number
}
interface Ring {
  stage: PipelineStage
  r: number
  dot: (typeof DOTS)[number]
  leads: Lead[]
  sats: Sat[]
  /** lo que no cabe en la orbita («+N») */
  more: Lead[]
  moreAt: { x: number; y: number } | null
  idx: number
}

function layout(m: Model, active: string | null): Ring[] {
  const n = m.orbits.length
  const won = m.orbits.some((s) => s.tipo === 'ganada')
  const total = [...m.byStage.values()].reduce((s, l) => s + l.length, 0)
  return m.orbits.map((stage, i) => {
    const leads = m.byStage.get(stage.etapa) ?? []
    const isWon = stage.tipo === 'ganada'
    const cap = total <= MAX_LEADS ? Infinity : isWon ? 10 : i < n - 3 ? 5 : 8
    let shown = leads.slice(0, cap === Infinity ? leads.length : cap)
    // el cliente en foco siempre se ve: si quedo en el «+N», entra en lugar del ultimo
    const sel = leads.find((l) => l.id === active)
    if (sel && !shown.includes(sel) && shown.length) shown = [...shown.slice(0, -1), sel]
    const more = leads.filter((l) => !shown.includes(l))
    const count = shown.length + (more.length ? 1 : 0)
    const r = rad(i, n)
    const start = 28 + i * 37 // el hueco de arriba queda libre para el nombre de la orbita
    const at = (k: number) => {
      const a = ((start + (k * 360) / Math.max(1, count)) * Math.PI) / 180
      return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) }
    }
    return {
      stage,
      r,
      dot: dotOf(i, n, won),
      leads,
      sats: shown.map((lead, k) => ({ lead, ...at(k) })),
      more,
      moreAt: more.length ? at(shown.length) : null,
      idx: i,
    }
  })
}

/** El mas cerca de cerrar: el que va en la etapa mas avanzada y, a igual etapa, el de mas valor. */
const closest = (m: Model) => {
  for (let i = m.orbits.length - 1; i >= 0; i--) {
    if (m.orbits[i].tipo === 'ganada') continue
    const l = m.byStage.get(m.orbits[i].etapa)?.[0]
    if (l) return l
  }
  return null
}

function OrbitalBody({ model, clients, openId, onPick, onSwitch, onProspect }: { model: Model; clients: Lead[]; openId: string | null; onPick: (id: string) => void; onSwitch: (v: ViewMode) => void; onProspect: () => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [stageOpen, setStageOpen] = useState<string | null>(null) // etapa desplegada en la lista del lateral
  const leave = useRef(0)
  const rings = useRef<(SVGGElement | null)[]>([])
  const active = hover ?? focus ?? openId
  const paused = useRef(false)
  paused.current = active !== null

  const rows = useMemo(() => layout(model, active), [model, active])
  const stageOf = (l: Lead) => model.orbits.find((s) => (model.byStage.get(s.etapa) ?? []).includes(l))
  const everyone = model.orbits.flatMap((s) => model.byStage.get(s.etapa) ?? [])
  const lead = (active && everyone.find((l) => l.id === active)) || closest(model)
  const leadStage = lead ? stageOf(lead) : undefined
  const wonStage = model.orbits.find((s) => s.tipo === 'ganada')
  const wonCount = wonStage ? (model.byStage.get(wonStage.etapa)?.length ?? 0) : 0
  const openLeads = everyone.filter((l) => stageOf(l)?.tipo === 'abierta')
  const estimated = openLeads.reduce((s, l) => s + (l.estValue ?? 0), 0)
  const weighted = openLeads.reduce((s, l) => s + ((l.estValue ?? 0) * (probOf(l, stageOf(l)) ?? 0)) / 100, 0)

  // giro lento de cada orbita (de la exterior, mas lenta, a la interior). Quieto con prefers-reduced-motion y mientras hay un satelite en foco.
  useEffect(() => {
    if (reduced()) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!paused.current) acc += dt
      rings.current.forEach((g, i) => {
        if (!g) return
        const a = acc * (1.2 + i * 0.6) * (i % 2 ? -1 : 1)
        g.setAttribute('transform', `rotate(${a.toFixed(3)} ${C} ${C})`)
        g.querySelectorAll('.ob-sat-lbl').forEach((l) => l.setAttribute('transform', `rotate(${(-a).toFixed(3)})`))
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const hoverOn = (id: string) => {
    clearTimeout(leave.current)
    setHover(id)
  }
  const hoverOff = () => {
    clearTimeout(leave.current)
    leave.current = window.setTimeout(() => setHover(null), 120)
  }
  useEffect(() => () => clearTimeout(leave.current), [])

  const label = (l: Lead, st: PipelineStage) => {
    const v = st.tipo === 'ganada' ? `cobrado ${money(stats(l).cobrado)}` : l.estValue != null ? `valor ${money(l.estValue)}` : 'sin valor estimado'
    const p = probOf(l, st)
    return `${l.name}, ${st.nombre}${p != null ? `, ${p} %` : ''}, ${v}. Abrir ficha`
  }

  return (
    <div className="ob-orbital">
      <div className="ob-stage">
        <svg viewBox="0 0 740 740" className="ob-svg" role="group" aria-label={`Órbitas de ventas: ${model.orbits.map((s) => `${s.nombre} ${model.byStage.get(s.etapa)?.length ?? 0}`).join(', ')}`} onPointerLeave={hoverOff}>
          <defs>
            <radialGradient id="ob-planet" cx="40%" cy="35%" r="75%">
              <stop offset="0%" stopColor="#3a2d1d" />
              <stop offset="100%" stopColor="#16110b" />
            </radialGradient>
          </defs>

          {rows.map((o) => (
            <circle key={o.stage.etapa} className={`ob-ring${o.stage.tipo === 'ganada' ? ' is-won' : ''}${o.idx === rows.length - 2 ? ' is-near' : ''}${o.leads.length === 0 ? ' is-empty' : ''}`} cx={C} cy={C} r={o.r} />
          ))}

          <circle cx={C} cy={C} r="52" fill="url(#ob-planet)" />
          <text className="ob-core" x={C} y={C - 4} textAnchor="middle">
            HAYAI
          </text>
          {wonStage && (
            <text className="ob-core-n" x={C} y={C + 15} textAnchor="middle">
              {wonCount} {wonCount === 1 ? 'ganado' : 'ganados'}
            </text>
          )}

          {/* nombre de cada orbita, con su cuenta */}
          <g className="ob-olabels" aria-hidden="true">
            {rows
              .filter((o) => o.stage.tipo !== 'ganada')
              .map((o) => (
                <text key={o.stage.etapa} x={C} y={C - o.r + 16} textAnchor="middle" className={o.idx >= rows.length - 3 ? 'is-warm' : ''}>
                  {o.stage.nombre.toUpperCase()} · {o.leads.length}
                </text>
              ))}
          </g>

          {rows.map((o) => (
            <g key={o.stage.etapa} className="ob-orbit" ref={(el) => void (rings.current[o.idx] = el)}>
              {o.sats.map(({ lead: l, x, y }) => {
                const on = active === l.id
                return (
                  <g
                    key={l.id}
                    className={`ob-sat${on ? ' is-on' : ''}${openId === l.id ? ' is-open' : ''}${l.estValue == null && o.stage.tipo !== 'ganada' ? ' no-value' : ''}`}
                    transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
                    role="button"
                    tabIndex={0}
                    aria-label={label(l, o.stage)}
                    aria-pressed={openId === l.id}
                    onClick={() => onPick(l.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onPick(l.id)
                      }
                    }}
                    onPointerEnter={() => hoverOn(l.id)}
                    onPointerLeave={hoverOff}
                    onFocus={() => setFocus(l.id)}
                    onBlur={() => setFocus((f) => (f === l.id ? null : f))}
                  >
                    <circle className="ob-hit" r="22" />
                    <circle className="ob-sel" r={o.dot.r + 8} />
                    <circle className="ob-dot" r={o.dot.r} fill={o.dot.fill} stroke={o.dot.stroke} strokeWidth="2" />
                    {on && (
                      <g className="ob-sat-lbl">
                        <text x={o.dot.r + 12} y="4.5">
                          {l.name}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}
              {o.moreAt && (
                <g
                  className="ob-sat ob-more"
                  transform={`translate(${o.moreAt.x.toFixed(1)} ${o.moreAt.y.toFixed(1)})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${o.more.length} más en ${o.stage.nombre}. Ver la lista`}
                  onClick={() => setStageOpen(o.stage.etapa)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setStageOpen(o.stage.etapa)
                    }
                  }}
                >
                  <circle className="ob-hit" r="24" />
                  <circle className="ob-sel" r="21" />
                  <circle className="ob-dot" r="14" fill="#f6eee2" stroke="rgba(22,17,11,0.6)" strokeWidth="1.5" />
                  <text className="ob-more-t" y="4" textAnchor="middle">
                    +{o.more.length}
                  </text>
                </g>
              )}
            </g>
          ))}
        </svg>
      </div>

      <div className="ob-side">
        <p className="ob-lead">Cada punto es un posible cliente. Mientras más cerca del planeta, más cerca de ganarse. El centro son los clientes que ya son nuestros.</p>

        {lead && leadStage ? (
          <article className="ob-card" aria-live="polite">
            <header>
              <strong>{lead.name}</strong>
              <span className="ob-chip">{leadStage.nombre}</span>
            </header>
            <p className="ob-card-note">
              {active === null && leadStage.tipo !== 'ganada' ? 'El más cerca de cerrar. ' : ''}
              {lead.nextAction ? `Próxima acción: ${lead.nextAction}${lead.nextActionDate ? ` (${fmtDate(lead.nextActionDate)})` : ''}.` : leadStage.tipo === 'ganada' ? 'Ya es cliente.' : 'Sin próxima acción definida.'}
            </p>
            <dl className="ob-stats">
              <div>
                <dt>{leadStage.tipo === 'ganada' ? 'Cobrado' : 'Valor'}</dt>
                <dd className={leadStage.tipo !== 'ganada' && lead.estValue == null ? 'is-none' : 'is-gold'}>{leadStage.tipo === 'ganada' ? money(stats(lead).cobrado) : lead.estValue != null ? money(lead.estValue) : 'Sin valor'}</dd>
              </div>
              <div>
                <dt>Probabilidad</dt>
                <dd>{probOf(lead, leadStage) != null ? `${probOf(lead, leadStage)} %` : '—'}</dd>
              </div>
              <div>
                <dt>{lead.source ? 'Origen' : 'Último contacto'}</dt>
                <dd>{lead.source ? (SOURCE[lead.source] ?? lead.source) : lead.lastContactAt ? ago(lead.lastContactAt) : 'Sin contacto'}</dd>
              </div>
            </dl>
            <button type="button" className="ob-open" onClick={() => onPick(lead.id)}>
              {openId === lead.id ? 'Cerrar ficha' : 'Abrir ficha'}
              <Icon name="arrow" size={15} />
            </button>
          </article>
        ) : (
          <article className="ob-card is-empty">
            <strong>Todavía no hay a quién perseguir</strong>
            <p className="ob-card-note">Cuando registres un posible cliente aparecerá en la órbita de su etapa.</p>
            <button type="button" className="ob-open" onClick={onProspect}>
              Registrar un posible cliente
              <Icon name="plus" size={15} />
            </button>
          </article>
        )}

        <p className="ob-sum" aria-live="polite">
          <b>{openLeads.length}</b> {openLeads.length === 1 ? 'posible en juego' : 'posibles en juego'} · <b>{money(estimated)}</b> estimados · <b>{money(Math.round(weighted * 100) / 100)}</b> ponderados
        </p>

        {/* la leyenda es también la lista por etapa: cada fila se despliega con sus clientes (alternativa al dibujo) */}
        <ul className="ob-legend" aria-label="Etapas del pipeline">
          {[...rows].reverse().map((o) => {
            const open = stageOpen === o.stage.etapa
            return (
              <li key={o.stage.etapa}>
                <button type="button" className="ob-legend-row" aria-expanded={open} aria-controls={`ob-l-${o.stage.etapa}`} onClick={() => setStageOpen(open ? null : o.stage.etapa)}>
                  <span className="ob-key" style={{ background: o.dot.fill, boxShadow: o.dot.stroke !== 'none' ? `inset 0 0 0 2px ${o.dot.stroke}` : undefined }} aria-hidden="true" />
                  <span>
                    {o.stage.nombre} · {o.stage.probabilidad} %
                  </span>
                  <strong>{o.leads.length}</strong>
                </button>
                {open && (
                  <div id={`ob-l-${o.stage.etapa}`} className="ob-stage-list">
                    {o.leads.length === 0 ? (
                      <p className="ob-empty">Nadie en esta etapa por ahora.</p>
                    ) : (
                      <ul>
                        {o.leads.map((l) => (
                          <li key={l.id}>
                            <button type="button" aria-pressed={openId === l.id} onClick={() => onPick(l.id)} onPointerEnter={() => hoverOn(l.id)} onPointerLeave={hoverOff} onFocus={() => setFocus(l.id)} onBlur={() => setFocus((f) => (f === l.id ? null : f))}>
                              <span>{l.name}</span>
                              <em>{l.estValue != null ? money(l.estValue) : 'sin valor'}</em>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <p className="ob-foot">
          Tocar un punto abre su ficha. Las etapas son las del pipeline, con el mismo nombre. Los perdidos no aparecen aquí: están en el pipeline, en su columna
          {model.lostLeads.length > 0 && (
            <>
              {' '}
              (<button type="button" className="ob-link" onClick={() => onSwitch('pipeline')}>ver {model.lostLeads.length} {model.lostLeads.length === 1 ? 'perdido' : 'perdidos'}</button>)
            </>
          )}
          . Con más de {MAX_LEADS} posibles, las órbitas exteriores se agrupan en «+N».
        </p>
      </div>
      {clients.length === 0 && <span className="ob-sr">No hay clientes todavía.</span>}
    </div>
  )
}

export function OrbitalView({ clients, stages, openId, onPick, onSwitch, onProspect }: { clients: Lead[]; stages: Loaded<PipelineStage[]>; openId: string | null; onPick: (id: string) => void; onSwitch: (v: ViewMode) => void; onProspect: () => void }) {
  return (
    <StagesGate stages={stages}>
      {(s) => <OrbitalBodyWithModel stages={s} clients={clients} openId={openId} onPick={onPick} onSwitch={onSwitch} onProspect={onProspect} />}
    </StagesGate>
  )
}
function OrbitalBodyWithModel({ stages, clients, ...rest }: { stages: PipelineStage[]; clients: Lead[]; openId: string | null; onPick: (id: string) => void; onSwitch: (v: ViewMode) => void; onProspect: () => void }) {
  const model = useMemo(() => buildModel(stages, clients), [stages, clients])
  return <OrbitalBody model={model} clients={clients} {...rest} />
}

// ---------- pipeline en columnas ----------
function Column({ stage, leads, openId, onPick }: { stage: PipelineStage; leads: Lead[]; openId: string | null; onPick: (id: string) => void }) {
  const total = leads.reduce((s, l) => s + (l.estValue ?? 0), 0)
  return (
    <section className={`ob-col${stage.tipo === 'perdida' ? ' is-lost' : ''}${stage.tipo === 'ganada' ? ' is-won' : ''}`} aria-labelledby={`ob-c-${stage.etapa}`}>
      <header>
        <h2 id={`ob-c-${stage.etapa}`}>{stage.nombre}</h2>
        <span className="ob-col-n">{leads.length}</span>
        <p>
          {stage.probabilidad} %{total > 0 && <> · {money(total)}</>}
        </p>
      </header>
      {leads.length === 0 ? (
        <p className="ob-empty">Nadie en esta etapa por ahora.</p>
      ) : (
        <ul>
          {leads.map((l) => (
            <li key={l.id}>
              <button type="button" className={`ob-lcard${openId === l.id ? ' is-open' : ''}`} aria-pressed={openId === l.id} onClick={() => onPick(l.id)}>
                <strong>{l.name}</strong>
                <span className="ob-lval">
                  {l.estValue != null ? money(l.estValue) : <i>sin valor</i>}
                  {probOf(l, stage) != null && <small> · {probOf(l, stage)} %</small>}
                </span>
                {stage.tipo === 'perdida' && l.lostReason ? (
                  <span className="ob-lnote">{l.lostReason}</span>
                ) : l.nextAction ? (
                  <span className="ob-lnote">
                    {l.nextAction}
                    {l.nextActionDate && <> · {fmtDate(l.nextActionDate)}</>}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Pipeline en columnas: una por etapa activa (con Perdido al final), con los mismos nombres y probabilidades de la API. */
export function PipelineView({ clients, stages, openId, onPick }: { clients: Lead[]; stages: Loaded<PipelineStage[]>; openId: string | null; onPick: (id: string) => void }) {
  return (
    <StagesGate stages={stages}>
      {(s) => <PipelineColumns stages={s} clients={clients} openId={openId} onPick={onPick} />}
    </StagesGate>
  )
}
function PipelineColumns({ stages, clients, openId, onPick }: { stages: PipelineStage[]; clients: Lead[]; openId: string | null; onPick: (id: string) => void }) {
  const model = useMemo(() => buildModel(stages, clients), [stages, clients])
  const track = useRef<HTMLDivElement>(null)
  useDragScroll(track, 'x') // las columnas se arrastran con el raton (y la rueda las desplaza)
  return (
    <div className="ob-cols" ref={track} role="group" aria-label="Pipeline por etapas">
      {model.columns.map((s) => (
        <Column key={s.etapa} stage={s} leads={s.tipo === 'perdida' ? model.lostLeads : (model.byStage.get(s.etapa) ?? [])} openId={openId} onPick={onPick} />
      ))}
    </div>
  )
}
