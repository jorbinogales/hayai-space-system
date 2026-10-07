import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api } from './api'
import { Blobvatar } from './blob'
import Cobro from './Cobro'
import { KIND_LABEL, KINDS, SOURCE_LABEL, addInteraction, crmOf, useClientLog, useStages, type Interaction, type Kind, type Stage } from './clientLog'
import { useDragScroll } from './drag'
import { Icon } from './ui'
import { avatarOf, fmtDate, money, moveLabel, stats, todayISO, type Client, type Movement } from './store'
import { STATUS_LABEL, avatarFor, useAllProjects, type Project } from './projectData'
import type { Task } from './taskData'
import { ago } from './time'
import { useFormGuard } from './updates'
import { DraftBar } from './UpdateUI'
import './ficha.css'

type Tab = 'ficha' | 'bitacora' | 'cobros' | 'proyectos'
const TABS: { key: Tab; label: string }[] = [
  { key: 'ficha', label: 'Ficha' },
  { key: 'bitacora', label: 'Bitácora' },
  { key: 'cobros', label: 'Cobros' },
  { key: 'proyectos', label: 'Proyectos' },
]

const msgOf = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const dayOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const stageName = (stages: Stage[], key: string | null | undefined) => (key ? (stages.find((s) => s.etapa === key)?.nombre ?? key) : null)
const joinNames = (n: string[]) => (n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`)

/** Dato de la ficha: etiqueta pequeña y valor; vacío no se pinta (la ficha no se llena de guiones). */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fx-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// ---------- Ficha ----------
function FichaPanel({ c, stages, project, visit, onConvert }: { c: Client; stages: Stage[]; project?: Project | null; visit?: Task | null; onConvert?: (id: string) => void }) {
  const st = stats(c)
  const crm = crmOf(c)
  const today = todayISO()
  const initial = c.items.reduce((s, i) => s + i.amount, 0)
  const sold = st.cobrado + st.pendiente
  const pct = sold > 0 ? Math.round((st.cobrado / sold) * 100) : 0
  const stage = stageName(stages, crm.stage)
  const prob = crm.probability ?? stages.find((s) => s.etapa === crm.stage)?.probabilidad
  const lateAction = !!crm.nextActionDate && crm.nextActionDate < today
  const hasContact = !!(crm.contactName || c.phone || crm.email || crm.address || crm.source)
  const hasFollow = !!(stage || crm.estValue != null || crm.expectedClose || crm.nextAction || crm.lastContactAt)

  return (
    <>
      {c.prospect && (
        <div className="prospect-box">
          <section>
            <h3>Posible proyecto</h3>
            {project ? (
              <p className="pb-line">
                <b>{project.name}</b>
                <small>
                  {STATUS_LABEL[project.status]} · responsable <Blobvatar seed={avatarFor(project.owner)} size={20} /> {project.owner}
                </small>
              </p>
            ) : (
              <p className="none">Sin proyecto asociado.</p>
            )}
          </section>
          <section>
            <h3>Visita</h3>
            {visit ? (
              <p className="pb-line">
                <b>{visit.title}</b>
                <small>{visit.due ? `Agendada para el ${fmtDate(visit.due, true)}` : 'Sin fecha agendada'}</small>
              </p>
            ) : (
              <p className="none">Sin visita agendada.</p>
            )}
          </section>
          {onConvert && (
            <button className="primary" onClick={() => onConvert(c.id)}>
              Convertir en cliente
            </button>
          )}
        </div>
      )}

      {(!c.prospect || c.movements.length > 0) && (
        <dl className="totals fx-totals">
          <div>
            <dt>Cobrado</dt>
            <dd className="ok">{money(st.cobrado)}</dd>
          </div>
          <div>
            <dt>Por cobrar</dt>
            <dd>{money(st.pendiente)}</dd>
          </div>
        </dl>
      )}

      {hasFollow && (
        <section className="fx-card" aria-label="Seguimiento">
          <h3>Seguimiento</h3>
          <dl className="fx-list">
            {stage && (
              <Row label="Etapa">
                {stage}
                {prob != null ? <small> · {prob} %</small> : null}
              </Row>
            )}
            {crm.estValue != null && <Row label="Valor estimado">{money(crm.estValue)}</Row>}
            {crm.expectedClose && <Row label="Cierre previsto">{fmtDate(crm.expectedClose, true)}</Row>}
            {crm.nextAction && (
              <Row label="Próxima acción">
                {crm.nextAction}
                {crm.nextActionDate && (
                  <small className={lateAction ? 'is-late' : undefined}>
                    {' '}
                    · {lateAction ? 'venció el ' : ''}
                    {fmtDate(crm.nextActionDate, true)}
                  </small>
                )}
              </Row>
            )}
            {crm.lastContactAt && <Row label="Último contacto">{ago(crm.lastContactAt)}</Row>}
            {crm.lostReason && <Row label="Motivo de pérdida">{crm.lostReason}</Row>}
          </dl>
        </section>
      )}

      <section className="fx-card" aria-label="Contacto">
        <h3>Contacto</h3>
        {hasContact ? (
          <dl className="fx-list">
            {crm.contactName && (
              <Row label="Persona">
                {crm.contactName}
                {crm.contactRole && <small> · {crm.contactRole}</small>}
              </Row>
            )}
            {c.phone && <Row label="WhatsApp / teléfono">{c.phone}</Row>}
            {crm.email && <Row label="Correo">{crm.email}</Row>}
            {crm.address && <Row label="Dirección">{crm.address}</Row>}
            {crm.source && <Row label="Origen">{SOURCE_LABEL[crm.source] ?? crm.source}</Row>}
            {crm.createdAt && <Row label={c.prospect ? 'Registrado' : 'Cliente desde'}>{fmtDate(dayOf(crm.createdAt), true)}</Row>}
          </dl>
        ) : (
          <p className="none">Aún no hay datos de contacto.</p>
        )}
      </section>

      {c.items.length > 0 && (
        <section className="fx-card is-dark" aria-label="Qué se le vendió">
          <h3>Inicial</h3>
          <ul className="items">
            {c.items.map((i) => (
              <li key={i.id}>
                <span>{i.concept}</span>
                <span>{money(i.amount)}</span>
              </li>
            ))}
            <li className="sum">
              <span>Total inicial</span>
              <span>{money(initial)}</span>
            </li>
          </ul>
          {sold > 0 && (
            <>
              <div className="fx-bar" role="img" aria-label={`Cobrado ${pct} % de ${money(sold)}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <p className="fx-bar-note">
                <span>Cobrado {money(st.cobrado)}</span>
                <span>Por cobrar {money(st.pendiente)}</span>
              </p>
            </>
          )}
        </section>
      )}

      {((crm.tags?.length ?? 0) > 0 || crm.notes) && (
        <section className="fx-card" aria-label="Etiquetas y notas">
          {(crm.tags?.length ?? 0) > 0 && (
            <>
              <h3>Etiquetas</h3>
              <p className="fx-tags">
                {crm.tags!.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </p>
            </>
          )}
          {crm.notes && (
            <>
              <h3>Notas</h3>
              <p className="fx-notes">{crm.notes}</p>
            </>
          )}
        </section>
      )}
    </>
  )
}

// ---------- Bitácora ----------
function LogEntry({ e, stages }: { e: Interaction; stages: Stage[] }) {
  const stageText =
    e.cambio &&
    (e.cambio.de ? `Pasó de ${stageName(stages, e.cambio.de)} a ${stageName(stages, e.cambio.a)}` : `Entró a ${stageName(stages, e.cambio.a)}`) +
      (e.cambio.propuesta_version ? ` · propuesta v${e.cambio.propuesta_version}` : '')
  return (
    <li className={`fx-entry k-${e.tipo}`}>
      <i aria-hidden="true" />
      <div>
        <p className="fx-entry-head">
          <span className="fx-kind">{KIND_LABEL[e.tipo] ?? e.tipo}</span>
          <time dateTime={e.fecha} title={new Date(e.fecha).toLocaleString('es')}>
            {fmtDate(dayOf(e.fecha), true)} · {ago(e.fecha)}
          </time>
        </p>
        <p className="fx-entry-text">{stageText ?? e.resumen}</p>
        {e.cambio?.motivo && <p className="fx-entry-sub">Motivo: {e.cambio.motivo}</p>}
        {!e.automatica && <p className="fx-entry-sub">{e.registrada_por}</p>}
        {e.automatica && stageText && e.resumen && e.resumen !== stageText && <p className="fx-entry-sub">{e.resumen}</p>}
      </div>
    </li>
  )
}

function LogPanel({ c, log, stages }: { c: Client; log: ReturnType<typeof useClientLog>; stages: Stage[] }) {
  const today = todayISO()
  const blank = { tipo: 'nota' as Kind, resumen: '', fecha: today }
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const guard = useFormGuard({
    id: `bitacora:${c.id}`,
    label: `Bitácora · ${c.name}`,
    values: form,
    initial: blank,
    labels: { tipo: 'tipo', resumen: 'registro de la bitácora', fecha: 'fecha' },
    apply: (v) => setForm(v),
  })

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    const resumen = form.resumen.trim()
    if (resumen.length < 2) return setErr('Cuenta en una línea qué pasó.')
    if (form.fecha > today) return setErr('La fecha no puede ser futura: lo que viene va como próxima acción.')
    setBusy(true)
    setErr('')
    try {
      await addInteraction(c.id, { tipo: form.tipo, resumen, ...(form.fecha && form.fecha !== today ? { fecha: form.fecha } : {}) })
      guard.discard()
      setForm({ ...blank, tipo: form.tipo })
      await log.reload()
    } catch (x) {
      setErr(msgOf(x, 'No se pudo guardar el registro.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DraftBar guard={guard} />
      <form className="fx-form" onSubmit={(e) => void submit(e)} aria-label="Registrar en la bitácora">
        <div className="fx-kinds" role="radiogroup" aria-label="Tipo de registro">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={form.tipo === k} className={form.tipo === k ? 'is-on' : ''} onClick={() => setForm((f) => ({ ...f, tipo: k }))}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="fx-lbl">
          <span className="sr">Qué pasó</span>
          <textarea rows={2} maxLength={2000} value={form.resumen} onChange={(e) => setForm((f) => ({ ...f, resumen: e.target.value }))} placeholder="Qué pasó, en una o dos líneas" />
        </label>
        <div className="fx-form-foot">
          <label className="fx-lbl fx-date">
            <span>Fecha</span>
            <input type="date" max={today} value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value || today }))} />
          </label>
          <button type="submit" className="primary" disabled={busy || form.resumen.trim().length < 2}>
            {busy ? 'Guardando…' : 'Registrar'}
          </button>
        </div>
        {err && (
          <p className="fx-err" role="alert">
            {err}
          </p>
        )}
      </form>

      {log.phase === 'loading' && (
        <p className="none fx-state" role="status">
          Cargando la bitácora…
        </p>
      )}
      {log.phase === 'error' && (
        <p className="fx-err fx-state" role="alert">
          {log.error}{' '}
          <button type="button" className="fx-link" onClick={() => void log.reload()}>
            Reintentar
          </button>
        </p>
      )}
      {log.phase === 'ok' && log.items.length === 0 && <p className="none fx-state">Aún no hay nada en la bitácora. Registra la primera llamada, visita o nota arriba.</p>}
      {log.items.length > 0 && (
        <ol className="fx-log" aria-label={`Bitácora de ${c.name}`}>
          {log.items.map((e) => (
            <LogEntry key={e.id} e={e} stages={stages} />
          ))}
        </ol>
      )}
      {log.total > log.items.length && <p className="none fx-state">Se muestran los {log.items.length} registros más recientes de {log.total}.</p>}
    </>
  )
}

// ---------- Cobros ----------
function PayRow({ m, late, onOpen }: { m: Movement; late?: boolean; onOpen: (id: string) => void }) {
  const done = m.status === 'cobrado'
  const state = done ? 'Cobrado' : late ? 'Vencido' : 'Por cobrar'
  return (
    <li className={done ? 'done' : late ? 'late' : 'due'}>
      <i aria-hidden="true" />
      <button type="button" className="fx-pay" onClick={() => onOpen(m.id)} aria-label={`${moveLabel(m)}, ${money(m.amount)}, ${state.toLowerCase()}, ${fmtDate(m.date, true)}. Abrir el detalle del cobro`}>
        <span className="fx-pay-l">
          <span className="m-concept">{moveLabel(m)}</span>
          <span className="m-date">{fmtDate(m.date, true)}</span>
        </span>
        <span className="m-right">
          <span className="m-amt">{money(m.amount)}</span>
          <span className="m-state">{state}</span>
        </span>
        <Icon name="arrow" size={14} />
      </button>
    </li>
  )
}

function PaysPanel({ c, onOpen, onEdit }: { c: Client; onOpen: (id: string) => void; onEdit?: (id: string) => void }) {
  const today = todayISO()
  const st = stats(c)
  const list = c.movements.filter((m) => m.status === 'cobrado').sort((a, b) => b.date.localeCompare(a.date))
  const owed = c.movements.filter((m) => m.status === 'pendiente').sort((a, b) => a.date.localeCompare(b.date))
  if (c.movements.length === 0)
    return (
      <div className="fx-empty">
        <p>{c.prospect ? 'Un posible cliente aún no tiene cobros.' : 'Este cliente aún no tiene cobros.'}</p>
        {onEdit && !c.prospect && (
          <button type="button" className="primary" onClick={() => onEdit(c.id)}>
            Crear el primero
          </button>
        )}
      </div>
    )
  return (
    <>
      <section>
        <h3>Movimientos</h3>
        {list.length === 0 ? (
          <p className="none">Aún no hay pagos registrados.</p>
        ) : (
          <ol className="moves">
            {list.map((m) => (
              <PayRow key={m.id} m={m} onOpen={onOpen} />
            ))}
          </ol>
        )}
      </section>
      {owed.length > 0 && (
        <section>
          <h3>
            Cuentas por cobrar <em className="owed-total">{money(st.pendiente)}</em>
          </h3>
          <ol className="moves">
            {owed.map((m) => (
              <PayRow key={m.id} m={m} late={m.date < today} onOpen={onOpen} />
            ))}
          </ol>
        </section>
      )}
      <p className="fx-hint">Toca un cobro para ver los bolívares, la tasa, el banco, quién recibió y el comprobante.</p>
    </>
  )
}

// ---------- Proyectos ----------
interface Progress {
  hitos: { estado: string }[]
  checklist: { hecho: boolean }[]
  tareas: { total: number; completadas: number }
}
function progressOf(p?: Progress): { pct: number; label: string } | null {
  if (!p) return null
  const h = p.hitos.length
  const k = p.checklist.length
  const pct = (a: number, b: number) => Math.round((a / b) * 100)
  if (h) {
    const done = p.hitos.filter((x) => x.estado === 'hecho').length
    return { pct: pct(done, h), label: `${done} de ${h} ${h === 1 ? 'hito' : 'hitos'}` }
  }
  if (k) {
    const done = p.checklist.filter((x) => x.hecho).length
    return { pct: pct(done, k), label: `${done} de ${k} pendientes` }
  }
  if (p.tareas.total) return { pct: pct(p.tareas.completadas, p.tareas.total), label: `${p.tareas.completadas} de ${p.tareas.total} tareas` }
  return null
}

function ProjectsPanel({ projects, active }: { projects: Project[]; active: boolean }) {
  const [prog, setProg] = useState<Record<string, Progress>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!active) return
    for (const p of projects) {
      if (asked.current.has(p.id)) continue
      asked.current.add(p.id)
      api
        .get<Progress>(`/projects/${p.id}/detail`)
        .then((d) => setProg((cur) => ({ ...cur, [p.id]: d })))
        .catch(() => asked.current.delete(p.id))
    }
  }, [active, projects])

  if (projects.length === 0)
    return (
      <div className="fx-empty">
        <p>Este cliente aún no tiene proyectos.</p>
      </div>
    )
  return (
    <ul className="fx-projects">
      {projects.map((p) => {
        const pr = progressOf(prog[p.id])
        return (
          <li key={p.id} className="fx-project">
            <span className="fx-pico" aria-hidden="true">
              <Icon name={p.icon} size={18} />
            </span>
            <div className="fx-pmain">
              <p className="fx-pname">
                {p.name}
                {p.archived && <em> · archivado</em>}
              </p>
              <p className="fx-psub">
                {STATUS_LABEL[p.status]}
                {p.due ? ` · entrega ${fmtDate(p.due, true)}` : ''}
              </p>
              {pr && (
                <>
                  <div className="fx-bar is-light" role="img" aria-label={`Avance ${pr.pct} %`}>
                    <i style={{ width: `${pr.pct}%` }} />
                  </div>
                  <p className="fx-psub">
                    {pr.label} · {pr.pct} %
                  </p>
                </>
              )}
            </div>
            <span className="fx-owner" title={`Responsable: ${p.owner}`}>
              <Blobvatar seed={avatarFor(p.owner)} size={26} />
              <small>{p.owner}</small>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// ---------- el cajón ----------
/** Cajon lateral del cliente: Ficha, Bitácora, Cobros y Proyectos en pestañas. */
export default function History({
  client,
  onClose,
  onEdit,
  onConvert,
  project,
  visit,
}: {
  client: Client | null
  onClose: () => void
  onEdit?: (id: string) => void
  /** posible cliente: pasa a ser cliente */
  onConvert?: (id: string) => void
  /** posible proyecto del prospecto y su tarea de visita */
  project?: Project | null
  visit?: Task | null
}) {
  // se conserva el ultimo cliente para que el cajon se cierre con animacion sin vaciarse
  const last = useRef<Client | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  if (client) last.current = client
  const c = last.current
  const [tab, setTab] = useState<Tab>('ficha')
  const [cobroId, setCobroId] = useState<string | null>(null)
  const tabs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const stages = useStages()
  const log = useClientLog(c?.id ?? null)
  const all = useAllProjects()
  const projects = useMemo(() => (c ? all.filter((p) => p.clientId === c.id) : []), [all, c])
  const owners = useMemo(() => [...new Set(projects.filter((p) => !p.archived).map((p) => p.owner))], [projects])
  useDragScroll(scroll, 'y', [c?.id, tab]) // rueda o mantener pulsado y arrastrar

  // al abrir otro cliente se empieza por la Ficha
  useEffect(() => {
    setTab('ficha')
    setCobroId(null)
  }, [client?.id])

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.key === tab)
    const to = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setTab(TABS[to].key)
    tabs.current[TABS[to].key]?.focus()
  }

  const st = c && stats(c)
  const crm = c ? crmOf(c) : null
  const stage = stageName(stages, crm?.stage)
  const count: Record<Tab, string | null> = {
    ficha: null,
    bitacora: log.phase === 'ok' ? String(log.total) : null,
    cobros: c ? String(c.movements.length) : null,
    proyectos: String(projects.length),
  }

  return (
    <>
      <aside className={`history${client ? ' is-open' : ''}`} aria-label={c ? `Ficha de ${c.name}` : 'Ficha del cliente'} aria-hidden={!client}>
        {c && st && (
          <>
            <header>
              <span className="av">
                <Blobvatar seed={avatarOf(c)} size={44} />
              </span>
              <div>
                <p className="eyebrow">{c.prospect ? 'Posible cliente' : 'Cliente'}</p>
                <h2>{c.name}</h2>
              </div>
              {onEdit && (
                <button className="x" onClick={() => onEdit(c.id)} aria-label={`Editar ${c.name}`} title="Editar">
                  <Icon name="edit" size={17} />
                </button>
              )}
              <button className="x" onClick={onClose} aria-label="Cerrar la ficha">
                <Icon name="close" size={18} />
              </button>
            </header>

            {(stage || owners.length > 0) && (
              <p className="fx-meta">
                {stage && <span className="fx-stage">{stage}</span>}
                {owners.length > 0 && (
                  <span className="fx-resp">
                    {owners.length > 1 ? 'Responsables' : 'Responsable'} <strong>{joinNames(owners)}</strong>
                  </span>
                )}
              </p>
            )}

            <div className="fx-tabs" role="tablist" aria-label="Secciones de la ficha">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  ref={(el) => void (tabs.current[t.key] = el)}
                  role="tab"
                  type="button"
                  id={`fx-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls={`fx-panel-${t.key}`}
                  tabIndex={tab === t.key ? 0 : -1}
                  onClick={() => setTab(t.key)}
                  onKeyDown={onKey}
                >
                  {t.label}
                  {count[t.key] != null && <span className="fx-count">{count[t.key]}</span>}
                </button>
              ))}
            </div>

            <div className="h-scroll" ref={scroll}>
              {TABS.map((t) => (
                <div key={t.key} role="tabpanel" id={`fx-panel-${t.key}`} aria-labelledby={`fx-tab-${t.key}`} hidden={tab !== t.key} tabIndex={0} className="fx-panel">
                  {t.key === 'ficha' && <FichaPanel c={c} stages={stages} project={project} visit={visit} onConvert={onConvert} />}
                  {t.key === 'bitacora' && <LogPanel c={c} log={log} stages={stages} />}
                  {t.key === 'cobros' && <PaysPanel c={c} onOpen={setCobroId} onEdit={onEdit} />}
                  {t.key === 'proyectos' && <ProjectsPanel projects={projects} active={tab === 'proyectos'} />}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
      {cobroId && <Cobro id={cobroId} onClose={() => setCobroId(null)} />}
    </>
  )
}
