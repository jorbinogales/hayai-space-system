import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './projectDetail.css'
import { api } from './api'
import { Blobvatar } from './blob'
import { useLoaded } from './hubData'
import { go } from './nav'
import { useSession } from './session'
import { fmtDate, todayISO, useClients } from './store'
import { addTask, removeTask, toggleTask, useTasks } from './taskData'
import { Icon } from './ui'
import { DraftBar } from './UpdateUI'
import { saveGuarded, useFormGuard } from './updates'
import {
  archiveProject,
  astronautNames,
  entregaVencida,
  avatarFor,
  loadProjects,
  projectNow,
  PROJECT_ICONS,
  removeProject,
  STATUS_LABEL,
  updateProject,
  useAllProjects,
  type Project,
  type ProjectStatus,
} from './projectData'

// Detalle de proyecto: responsable real (project.owner), cliente, estado, entrega, hoja de ruta por hitos, pendientes y tareas.
// Hitos y pendientes viven en /projects/:id/detail (sin deteccion de conflictos: ultimo guardado gana); el proyecto se edita con
// If-Match (updatedAt) y el dialogo de conflicto de updates.ts; alternar una tarea sigue siendo sin If-Match (asi esta en el servidor).

type MilestoneState = 'pendiente' | 'en_curso' | 'hecho'
const M_LABEL: Record<MilestoneState, string> = { pendiente: 'Pendiente', en_curso: 'En curso', hecho: 'Hecho' }
const M_ORDER: MilestoneState[] = ['pendiente', 'en_curso', 'hecho']

interface Milestone {
  id: string
  titulo: string
  vence: string | null
  estado: MilestoneState
  posicion: number
}
interface CheckItem {
  id: string
  texto: string
  hecho: boolean
  hecho_el: string | null
  posicion: number
}
interface Detail {
  hitos: Milestone[]
  checklist: CheckItem[]
}

const ICON_LABEL: Record<string, string> = { globe: 'Web', phone: 'App móvil', chart: 'Panel / datos', cart: 'Tienda', palette: 'Diseño', box: 'Sistema', code: 'Desarrollo' }
const STATUSES: ProjectStatus[] = ['planeacion', 'activo', 'entrega', 'pausado', 'completado', 'entregado']
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const dayOf = (iso: string) => iso.slice(0, 10)

// ---------- editar proyecto ----------
/** Hoja de edicion del proyecto: nombre, descripcion, icono, cliente (o interno), responsable, estado y entrega. Guarda con If-Match. */
export function EditProject({ projectId, onClose, onGone }: { projectId: string; onClose: () => void; onGone?: () => void }) {
  const project = useAllProjects().find((p) => p.id === projectId)
  const clients = useClients()
  const owners = astronautNames() // los responsables salen de la lista de socios de la API
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [icon, setIcon] = useState<string>(project?.icon ?? PROJECT_ICONS[0])
  const [client, setClient] = useState(project?.clientId ?? '')
  const [owner, setOwner] = useState(project?.owner ?? owners[0] ?? '')
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'planeacion')
  const [due, setDue] = useState(project?.due ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  // la marca del proyecto que se vio al abrir (o al guardar): se manda como If-Match
  const base = useRef(project?.updatedAt)
  const start = useRef({ name, description, icon, client, owner, status: status as string, due })
  const guard = useFormGuard({
    id: `proyecto-detalle:${projectId}`,
    label: `Proyecto · ${project?.name ?? ''}`,
    values: { name, description, icon, client, owner, status: status as string, due },
    initial: start.current,
    labels: { name: 'nombre', description: 'descripción', icon: 'icono', client: 'cliente', owner: 'responsable', status: 'estado', due: 'fecha de entrega' },
    apply: (v) => {
      setName(v.name)
      setDescription(v.description)
      setIcon(v.icon)
      setClient(v.client)
      setOwner(v.owner)
      setStatus(v.status as ProjectStatus)
      setDue(v.due)
    },
  })

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  if (!project) return null

  const clientName = (id: string) => (id ? (clients.find((c) => c.id === id)?.name ?? project.client ?? '') : 'Interno de HAYAI')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del proyecto.')
    if (!owner) return setError('Elige quién es el responsable.')
    setBusy(true)
    setError('')
    try {
      const patch = {
        name: name.trim(),
        description: description.trim() || null,
        icon: icon as Project['icon'],
        clientId: client || null,
        owner,
        status,
        due: due || null,
      }
      const r = await saveGuarded({
        title: 'Alguien cambió este proyecto mientras lo editabas',
        base: base.current,
        save: (ifMatch) => updateProject(project.id, patch, ifMatch),
        fresh: async () => {
          await loadProjects()
          const f = projectNow(project.id)
          return { stamp: f?.updatedAt, values: { name: f?.name, description: f?.description, owner: f?.owner, client: f ? (f.client ?? 'Interno de HAYAI') : undefined, status: f?.status && STATUS_LABEL[f.status], due: f?.due } }
        },
        mine: { name: patch.name, description: patch.description, owner, client: clientName(client), status: STATUS_LABEL[status], due: patch.due },
        labels: { name: 'Nombre', description: 'Descripción', owner: 'Responsable', client: 'Cliente', status: 'Estado', due: 'Entrega' },
      })
      guard.saved()
      if (r.kind === 'adopted') base.current = r.stamp // eligio la guardada: el proyecto ya esta al dia en pantalla
      onClose()
    } catch (err) {
      setBusy(false)
      setError(msg(err, 'No se pudo guardar el proyecto.'))
    }
  }

  const remove = async () => {
    if (!window.confirm(`¿Eliminar el proyecto "${project.name}" con sus tareas y gastos?\n\nIrá a la papelera y podrás restaurarlo durante 30 días.`)) return
    setBusy(true)
    try {
      await removeProject(project.id)
      onClose()
      onGone?.()
    } catch (err) {
      setBusy(false)
      setError(msg(err, 'No se pudo eliminar el proyecto.'))
    }
  }
  const archive = async () => {
    setBusy(true)
    try {
      await archiveProject(project.id, true)
      onClose()
      onGone?.()
    } catch (err) {
      setBusy(false)
      setError(msg(err, 'No se pudo archivar el proyecto.'))
    }
  }

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="ep-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="ep-title">Editar proyecto</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <DraftBar guard={guard} />
        <div className="sheet-body">
          <label className="field">
            <span>Nombre</span>
            <input ref={first} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} />
          </label>

          <label className="field">
            <span>Descripción</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={4000} placeholder="Qué se va a construir y para qué, en pocas líneas" />
          </label>

          <div className="field">
            <span>Icono del proyecto</span>
            <div className="icon-pick" role="radiogroup" aria-label="Icono del proyecto">
              {PROJECT_ICONS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={icon === k} aria-label={ICON_LABEL[k]} title={ICON_LABEL[k]} className={icon === k ? 'is-on' : ''} onClick={() => setIcon(k)}>
                  <Icon name={k} size={22} />
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Cliente</span>
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">Interno de HAYAI (sin cliente)</option>
              {project.clientId && !clients.some((c) => c.id === project.clientId) && <option value={project.clientId}>{project.client}</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Responsable</span>
            <div className="chips" role="radiogroup" aria-label="Responsable">
              {owners.map((o) => (
                <button key={o} type="button" role="radio" aria-checked={owner === o} className={owner === o ? 'is-on' : ''} onClick={() => setOwner(o)}>
                  <Blobvatar seed={avatarFor(o)} size={28} />
                  {o}
                </button>
              ))}
            </div>
          </div>

          <label className="field inline">
            <span>Fecha de entrega</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>

          <div className="field">
            <span>Estado</span>
            <div className="chips" role="radiogroup" aria-label="Estado">
              {STATUSES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={status === s} className={status === s ? 'is-on' : ''} onClick={() => setStatus(s)}>
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer>
          <p className="err" role="alert">
            {error}
          </p>
          <button type="button" className="ghost" disabled={busy} onClick={() => void archive()} title="Lo oculta de las pantallas de trabajo; sus gastos siguen contando en Finanzas">
            Archivar
          </button>
          <button type="button" className="ghost danger" disabled={busy} onClick={() => void remove()}>
            Eliminar
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}

// ---------- hoja de ruta ----------
function Mark({ state }: { state: MilestoneState }) {
  if (state === 'hecho')
    return (
      <span className="pd-node is-done" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    )
  return <span className={`pd-node ${state === 'en_curso' ? 'is-now' : 'is-todo'}`} aria-hidden="true">{state === 'en_curso' && <i />}</span>
}

function Roadmap({ projectId, items, reload, patch, onError }: { projectId: string; items: Milestone[]; reload: () => void; patch: (fn: (d: Detail) => Detail) => void; onError: (s: string) => void }) {
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const done = items.filter((m) => m.estado === 'hecho').length
  const cur = items.find((m) => m.id === sel) ?? null
  const reached = items.reduce((a, m, i) => (m.estado !== 'pendiente' ? i : a), -1) // el ultimo hito hecho o en curso: hasta ahi llega la linea
  const fill = items.length > 1 && reached > 0 ? `calc((100% - 24px) * ${reached / (items.length - 1)})` : '0px'

  const run = async (fn: () => Promise<unknown>) => {
    onError('')
    try {
      await fn()
    } catch (e) {
      onError(msg(e, 'No se pudo guardar el cambio.'))
    } finally {
      reload()
    }
  }

  return (
    <section className="pd-card is-dark" aria-labelledby="pd-roadmap">
      <header className="pd-ch">
        <h2 id="pd-roadmap">Hoja de ruta</h2>
        <span className="pd-count">{items.length ? `${done} de ${items.length} ${items.length === 1 ? 'hito' : 'hitos'}` : 'Sin hitos'}</span>
      </header>

      {items.length === 0 ? (
        <p className="pd-empty is-dark">Aún no hay hitos. Agrega el primero (p. ej. «Levantamiento») y de ahí sale el avance.</p>
      ) : (
        <div className="pd-road-scroll">
          <ol className="pd-road" style={{ ['--n' as string]: items.length }}>
            <li className="pd-line" aria-hidden="true" />
            <li className="pd-line is-fill" aria-hidden="true" style={{ width: fill }} />
            {items.map((m) => (
              <li key={m.id} className={`pd-stop is-${m.estado}${sel === m.id ? ' is-sel' : ''}`}>
                <button type="button" aria-pressed={sel === m.id} aria-label={`${m.titulo}, ${M_LABEL[m.estado]}${m.vence ? `, ${fmtDate(m.vence)}` : ''}. Editar hito`} onClick={() => setSel(sel === m.id ? null : m.id)}>
                  <Mark state={m.estado} />
                  <strong>{m.titulo}</strong>
                  <small>{m.vence ? (m.estado === 'en_curso' ? `hasta ${fmtDate(m.vence)}` : fmtDate(m.vence)) : M_LABEL[m.estado]}</small>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {cur && (
        <MilestoneEditor
          key={cur.id}
          m={cur}
          index={items.findIndex((x) => x.id === cur.id)}
          total={items.length}
          onClose={() => setSel(null)}
          onSave={(d) =>
            run(async () => {
              patch((x) => ({ ...x, hitos: x.hitos.map((h) => (h.id === cur.id ? { ...h, ...d } : h)) }))
              await api.patch(`/milestones/${cur.id}`, d)
            })
          }
          onMove={(dir) => {
            const ids = items.map((x) => x.id)
            const i = ids.indexOf(cur.id)
            const j = i + dir
            if (j < 0 || j >= ids.length) return
            ;[ids[i], ids[j]] = [ids[j], ids[i]]
            void run(async () => {
              patch((x) => ({ ...x, hitos: ids.map((id) => x.hitos.find((h) => h.id === id)!).filter(Boolean) }))
              await api.post(`/projects/${projectId}/milestones/order`, { ids })
            })
          }}
          onRemove={() => {
            if (!window.confirm(`¿Quitar el hito "${cur.titulo}"?\n\nIrá a la papelera y podrás restaurarlo durante 30 días.`)) return
            setSel(null)
            void run(async () => {
              patch((x) => ({ ...x, hitos: x.hitos.filter((h) => h.id !== cur.id) }))
              await api.del(`/milestones/${cur.id}`)
            })
          }}
        />
      )}

      {adding ? (
        <AddMilestone
          onCancel={() => setAdding(false)}
          onAdd={(d) =>
            run(async () => {
              const created = await api.post<Milestone>(`/projects/${projectId}/milestones`, d)
              setAdding(false)
              setSel(created.id)
            })
          }
        />
      ) : (
        <button type="button" className="pd-add is-dark" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} />
          Agregar hito
        </button>
      )}
    </section>
  )
}

function MilestoneEditor({ m, index, total, onSave, onMove, onRemove, onClose }: { m: Milestone; index: number; total: number; onSave: (d: { titulo?: string; vence?: string | null; estado?: MilestoneState }) => Promise<void>; onMove: (dir: -1 | 1) => void; onRemove: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(m.titulo)
  const [due, setDue] = useState(m.vence ?? '')
  const dirty = title.trim() !== m.titulo || (due || null) !== m.vence
  return (
    <form
      className="pd-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (!title.trim()) return
        void onSave({ titulo: title.trim(), vence: due || null })
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="pd-edit-row">
        <label>
          <span>Hito</span>
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>Fecha</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <div className="pd-edit-row is-actions">
        <div className="pd-seg" role="radiogroup" aria-label="Estado del hito">
          {M_ORDER.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={m.estado === s} className={m.estado === s ? 'is-on' : ''} onClick={() => void onSave({ estado: s })}>
              {M_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="pd-mini">
          <button type="button" className="pd-ibtn" aria-label="Mover antes" title="Mover antes" disabled={index === 0} onClick={() => onMove(-1)}>
            <Icon name="back" size={15} />
          </button>
          <button type="button" className="pd-ibtn is-next" aria-label="Mover después" title="Mover después" disabled={index === total - 1} onClick={() => onMove(1)}>
            <Icon name="back" size={15} />
          </button>
          <button type="button" className="pd-ibtn" aria-label="Quitar el hito" title="Quitar" onClick={onRemove}>
            <Icon name="trash" size={15} />
          </button>
          <button type="submit" className="pd-pill" disabled={!dirty || !title.trim()}>
            Guardar
          </button>
        </div>
      </div>
    </form>
  )
}

function AddMilestone({ onAdd, onCancel }: { onAdd: (d: { titulo: string; vence?: string }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <form
      className="pd-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim()) void onAdd({ titulo: title.trim(), ...(due ? { vence: due } : {}) })
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="pd-edit-row">
        <label>
          <span>Nuevo hito</span>
          <input ref={first} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Prueba con la clienta" />
        </label>
        <label>
          <span>Fecha (opcional)</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <div className="pd-edit-row is-actions">
        <span />
        <div className="pd-mini">
          <button type="button" className="pd-pill is-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="pd-pill" disabled={!title.trim()}>
            Agregar
          </button>
        </div>
      </div>
    </form>
  )
}

// ---------- lista de pendientes (checklist) ----------
function Checklist({ projectId, items, reload, patch, onError }: { projectId: string; items: CheckItem[]; reload: () => void; patch: (fn: (d: Detail) => Detail) => void; onError: (s: string) => void }) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const done = items.filter((i) => i.hecho).length

  const run = async (fn: () => Promise<unknown>) => {
    onError('')
    try {
      await fn()
    } catch (e) {
      onError(msg(e, 'No se pudo guardar el cambio.'))
    } finally {
      reload()
    }
  }
  const toggle = (i: CheckItem) =>
    void run(async () => {
      patch((d) => ({ ...d, checklist: d.checklist.map((x) => (x.id === i.id ? { ...x, hecho: !x.hecho, hecho_el: !x.hecho ? new Date().toISOString() : null } : x)) }))
      await api.patch(`/checklist/${i.id}`, { hecho: !i.hecho })
    })
  const rename = (i: CheckItem) => {
    setEditing(null)
    const t = draft.trim()
    if (!t || t === i.texto) return
    void run(async () => {
      patch((d) => ({ ...d, checklist: d.checklist.map((x) => (x.id === i.id ? { ...x, texto: t } : x)) }))
      await api.patch(`/checklist/${i.id}`, { texto: t })
    })
  }

  return (
    <section className="pd-card" aria-labelledby="pd-check">
      <header className="pd-ch">
        <h2 id="pd-check">Lista de pendientes</h2>
        <span className="pd-count">{items.length ? `${done} de ${items.length} ${done === 1 ? 'hecho' : 'hechos'}` : 'Vacía'}</span>
      </header>
      {items.length === 0 && <p className="pd-empty">Sin pendientes todavía. Escribe el primero abajo.</p>}
      <ul className="pd-list">
        {items.map((i) => (
          <li key={i.id} className={i.hecho ? 'is-done' : ''}>
            <button type="button" className="pd-box" role="checkbox" aria-checked={i.hecho} aria-label={`${i.texto}: ${i.hecho ? 'hecho' : 'pendiente'}`} onClick={() => toggle(i)}>
              {i.hecho && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              )}
            </button>
            {editing === i.id ? (
              <input
                className="pd-inline"
                autoFocus
                value={draft}
                maxLength={200}
                aria-label="Texto del pendiente"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => rename(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    setDraft(i.texto)
                    setEditing(null)
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="pd-text"
                title="Editar el texto"
                onClick={() => {
                  setDraft(i.texto)
                  setEditing(i.id)
                }}
              >
                {i.texto}
              </button>
            )}
            {i.hecho && i.hecho_el && <span className="pd-chip is-quiet">hecho {fmtDate(dayOf(i.hecho_el))}</span>}
            <button
              type="button"
              className="pd-ibtn is-faint"
              aria-label={`Quitar «${i.texto}»`}
              title="Quitar"
              onClick={() =>
                void run(async () => {
                  patch((d) => ({ ...d, checklist: d.checklist.filter((x) => x.id !== i.id) }))
                  await api.del(`/checklist/${i.id}`)
                })
              }
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="pd-new"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t) return
          setText('')
          void run(() => api.post(`/projects/${projectId}/checklist`, { texto: t }))
        }}
      >
        <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="Agregar un pendiente" aria-label="Nuevo pendiente" />
        <button type="submit" className="pd-pill" disabled={!text.trim()}>
          <Icon name="plus" size={14} />
          Agregar
        </button>
      </form>
    </section>
  )
}

// ---------- tareas ----------
function TaskBlock({ projectId, milestones, onError }: { projectId: string; milestones: Milestone[]; onError: (s: string) => void }) {
  const all = useTasks()
  const tasks = useMemo(() => all.filter((t) => t.projectId === projectId).sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999')), [all, projectId])
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const today = todayISO()
  const done = tasks.filter((t) => t.done).length
  const milestoneOf = (t: unknown) => {
    const id = (t as { milestoneId?: string | null }).milestoneId
    return id ? milestones.find((m) => m.id === id)?.titulo : undefined
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setBusy(true)
    onError('')
    try {
      await addTask(projectId, t, due || undefined)
      setTitle('')
      setDue('')
    } catch (err) {
      onError(msg(err, 'No se pudo agregar la tarea.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pd-card" aria-labelledby="pd-tasks">
      <header className="pd-ch">
        <h2 id="pd-tasks">Tareas</h2>
        <span className="pd-count">{tasks.length ? `${done} de ${tasks.length} ${done === 1 ? 'hecha' : 'hechas'}` : 'Sin tareas'}</span>
      </header>
      {tasks.length === 0 && <p className="pd-empty">Este proyecto no tiene tareas. Las tareas llevan fecha; para cosas sueltas usa la lista de pendientes.</p>}
      <ul className="pd-list">
        {tasks.map((t) => {
          const late = !t.done && !!t.due && t.due < today
          const ms = milestoneOf(t)
          return (
            <li key={t.id} className={t.done ? 'is-done' : ''}>
              <button type="button" className="pd-box" role="checkbox" aria-checked={t.done} aria-label={`${t.title}: ${t.done ? 'hecha' : 'pendiente'}`} onClick={() => void toggleTask(t.id)}>
                {t.done && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m5 12.5 4.5 4.5L19 7.5" />
                  </svg>
                )}
              </button>
              <span className="pd-text is-static">{t.title}</span>
              {ms && <span className="pd-chip is-quiet">{ms}</span>}
              {t.due && <span className={`pd-chip${late ? ' is-late' : ''}`}>{late ? 'Vencida · ' : ''}{fmtDate(t.due)}</span>}
              <button type="button" className="pd-ibtn is-faint" aria-label={`Quitar la tarea «${t.title}»`} title="Quitar" onClick={() => void removeTask(t.id)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          )
        })}
      </ul>
      <form className="pd-new" onSubmit={add}>
        <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Agregar una tarea" aria-label="Nueva tarea" />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Fecha de la tarea (opcional)" />
        <button type="submit" className="pd-pill" disabled={busy || !title.trim()}>
          <Icon name="plus" size={14} />
          Agregar
        </button>
      </form>
    </section>
  )
}

// ---------- pantalla ----------
/** Detalle del proyecto `id`: capa plana sobre el planeta de Proyectos. */
export default function ProjectDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const project = useAllProjects().find((p) => p.id === id)
  const detail = useLoaded(() => api.get<Detail>(`/projects/${id}/detail`), [id])
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const session = useSession()
  const today = todayISO()

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing && !(e.target instanceof HTMLInputElement) && !document.querySelector('.modal')) onBack()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [editing, onBack])

  if (!project)
    return (
      <div className="pd-flat">
        <div className="pd-scroll">
          <div className="pd-wrap">
            <button type="button" className="pd-back" onClick={onBack}>
              <Icon name="back" size={16} />
              Volver a proyectos
            </button>
            <p className="pd-empty">Este proyecto ya no está disponible: se archivó, se eliminó o no existe.</p>
          </div>
        </div>
      </div>
    )

  // «Marcar entregado»: estado terminal. Pide confirmación; el proyecto sigue visible y se puede reabrir desde «Editar proyecto».
  const markDelivered = async () => {
    if (!window.confirm(`¿Marcar «${project.name}» como entregado?\n\nSeguirá visible, pero ya no se marcará como vencido ni cuenta como en curso. Si te equivocas, lo cambias desde «Editar proyecto».`)) return
    setErr('')
    try {
      await updateProject(project.id, { status: 'entregado' })
    } catch (e) {
      setErr(msg(e, 'No se pudo marcar el proyecto como entregado.'))
    }
  }

  const d = detail.data
  const hitos = d?.hitos ?? []
  const done = hitos.filter((m) => m.estado === 'hecho').length
  const pct = hitos.length ? Math.round((done / hitos.length) * 100) : null
  const internal = !project.clientId
  const late = entregaVencida(project, today)

  return (
    <div className="pd-flat" role="region" aria-label={`Proyecto ${project.name}`}>
      <div className="pd-scroll">
        <div className="pd-wrap">
          <button type="button" className="pd-back" onClick={onBack}>
            <Icon name="back" size={16} />
            Volver a proyectos
          </button>

          <header className="pd-head">
            <div className="pd-title">
              <p className="pd-eyebrow">PLANETA PROYECTOS</p>
              <p className="pd-sub">
                <span>{internal ? 'Interno de HAYAI' : project.client} · responsable</span>
                <span className="pd-who">
                  <Blobvatar seed={avatarFor(project.owner)} size={22} />
                  <b>{project.owner}</b>
                  {session && session.name.toLowerCase() === project.owner.toLowerCase() && <em>(tú)</em>}
                </span>
              </p>
              <h1>{project.name}</h1>
            </div>
            <div className="pd-head-side">
              <span className={`pd-state st-${project.status}`}>{STATUS_LABEL[project.status]}</span>
              {project.status !== 'entregado' && (
                <button type="button" className="pd-pill" onClick={() => void markDelivered()}>
                  <Icon name="check" size={14} />
                  Marcar entregado
                </button>
              )}
              <button type="button" className="pd-pill is-ghost" onClick={() => setEditing(true)}>
                <Icon name="edit" size={14} />
                Editar proyecto
              </button>
            </div>
          </header>

          {(err || detail.error) && (
            <p className="pd-err" role="alert">
              {err || detail.error}
              {detail.error && !err && (
                <button type="button" className="pd-link" onClick={detail.reload}>
                  Reintentar
                </button>
              )}
            </p>
          )}

          <div className="pd-grid">
            <div className="pd-col">
              <section className="pd-card" aria-labelledby="pd-desc">
                <header className="pd-ch">
                  <h2 id="pd-desc">Descripción</h2>
                </header>
                {project.description ? (
                  <p className="pd-desc">{project.description}</p>
                ) : (
                  <p className="pd-empty">
                    Aún no tiene descripción.{' '}
                    <button type="button" className="pd-link" onClick={() => setEditing(true)}>
                      Escribirla
                    </button>
                  </p>
                )}
              </section>

              {d ? (
                <>
                  <Roadmap projectId={id} items={hitos} reload={detail.reload} patch={detail.patch} onError={setErr} />
                  <Checklist projectId={id} items={d.checklist} reload={detail.reload} patch={detail.patch} onError={setErr} />
                </>
              ) : (
                <div className="pd-skel" aria-busy="true" aria-label="Cargando el detalle">
                  <i />
                  <i />
                </div>
              )}
              <TaskBlock projectId={id} milestones={hitos} onError={setErr} />
            </div>

            <aside className="pd-col" aria-label="Datos del proyecto">
              <section className="pd-card" aria-labelledby="pd-data">
                <header className="pd-ch">
                  <h2 id="pd-data">Datos</h2>
                </header>
                <dl className="pd-dl">
                  <div>
                    <dt>Cliente</dt>
                    <dd>
                      {internal ? (
                        'Interno'
                      ) : (
                        <button type="button" className="pd-link is-strong" onClick={() => go({ screen: 'clientes', clientId: project.clientId })}>
                          {project.client}
                        </button>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Alcance</dt>
                    <dd>{internal ? 'Interno de HAYAI' : 'Para cliente'}</dd>
                  </div>
                  <div>
                    <dt>Responsable</dt>
                    <dd>{project.owner}</dd>
                  </div>
                  <div>
                    <dt>Estado</dt>
                    <dd>{STATUS_LABEL[project.status]}</dd>
                  </div>
                  <div>
                    <dt>Entrega prevista</dt>
                    <dd className={late ? 'is-late' : ''}>{project.due ? `${fmtDate(project.due, true)}${late ? ' · vencida' : ''}` : 'Sin fecha'}</dd>
                  </div>
                </dl>
              </section>

              <section className="pd-card is-dark" aria-labelledby="pd-prog">
                <header className="pd-ch">
                  <h2 id="pd-prog">Avance</h2>
                </header>
                <p className="pd-pct" aria-live="polite">
                  {pct === null ? '—' : `${pct} %`}
                </p>
                <div className="pd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-label="Avance del proyecto">
                  <i style={{ width: `${pct ?? 0}%` }} />
                </div>
                <p className="pd-note is-dark">{pct === null ? 'Agrega hitos a la hoja de ruta para medir el avance.' : 'Sale de los hitos cumplidos, no de la lista. Así un pendiente chico no mueve la barra.'}</p>
              </section>

              {internal && (
                <section className="pd-internal">
                  <strong>Proyecto interno</strong>
                  <span>Los que son de HAYAI muestran «Interno» en vez de cliente y no suman a lo que se cobra.</span>
                </section>
              )}
            </aside>
          </div>
        </div>
      </div>
      {editing && <EditProject projectId={id} onClose={() => setEditing(false)} onGone={onBack} />}
    </div>
  )
}
