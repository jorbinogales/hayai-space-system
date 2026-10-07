import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import { useClients } from './store'
import { useSession } from './session'
import { DraftBar } from './UpdateUI'
import { saveGuarded, useFormGuard } from './updates'
import { addProject, archiveProject, loadProjects, projectNow, removeProject, updateProject, astronautNames, avatarFor, PROJECT_ICONS, STATUS_LABEL, type Project, type ProjectStatus } from './projectData'

const STATUSES: ProjectStatus[] = ['planeacion', 'activo', 'entrega']
const ICON_LABEL: Record<string, string> = { globe: 'Web', phone: 'App móvil', chart: 'Panel / datos', cart: 'Tienda', palette: 'Diseño', box: 'Sistema', code: 'Desarrollo' }

/** Alta de proyecto: nombre, icono representativo, cliente, astronauta responsable y estado. Mismo estilo que "Nuevo cliente". */
export default function NewProject({ onClose, onCreate, project }: { onClose: () => void; onCreate: (p: Project) => void; /** si viene, el formulario edita ese proyecto */ project?: Project }) {
  const clients = useClients()
  const session = useSession()
  const owners = astronautNames()
  const [name, setName] = useState(project?.name ?? '')
  const [icon, setIcon] = useState(project?.icon ?? PROJECT_ICONS[0])
  const [client, setClient] = useState(project?.clientId ?? '')
  const [owner, setOwner] = useState(() => {
    if (project) return project.owner
    const me = session?.name // por defecto, el astronauta que tiene la sesión
    return owners.find((o) => o.toLowerCase() === me?.toLowerCase()) ?? owners[0]
  })
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'planeacion')
  const [due, setDue] = useState(project?.due ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  // la marca del proyecto que se vio al abrir (o al guardar): se manda como If-Match al editar
  const base = useRef(project?.updatedAt)
  const start = useRef({ name, icon: icon as string, client, owner, status: status as string, due })
  const guard = useFormGuard({
    id: `proyecto:${project?.id ?? 'nuevo'}`,
    label: project ? `Proyecto · ${project.name}` : 'Nuevo proyecto',
    values: { name, icon: icon as string, client, owner, status: status as string, due },
    initial: start.current,
    labels: { name: 'nombre', icon: 'icono', client: 'cliente', owner: 'responsable', status: 'estado', due: 'fecha de entrega' },
    apply: (v) => {
      setName(v.name)
      setIcon(v.icon as typeof icon)
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del proyecto.')
    if (!client) return setError('Elige el cliente del proyecto.')
    if (!due && !project) return setError('Indica la fecha de entrega.') // al editar (p.ej. un posible proyecto) puede quedar sin fecha
    setBusy(true)
    try {
      if (!project) {
        const p = await addProject({ name, icon, clientId: client, owner, status, due })
        guard.saved()
        return onCreate(p)
      }
      const patch = { name: name.trim(), icon, clientId: client, owner, status, due: due || null }
      const r = await saveGuarded({
        title: 'Alguien cambió este proyecto mientras lo editabas',
        base: base.current,
        save: (ifMatch) => updateProject(project.id, patch, ifMatch),
        fresh: async () => {
          await loadProjects()
          const f = projectNow(project.id)
          return { stamp: f?.updatedAt, values: { name: f?.name, owner: f?.owner, client: f?.client, status: f?.status && STATUS_LABEL[f.status], due: f?.due } }
        },
        mine: { name: patch.name, owner, client: clients.find((c) => c.id === client)?.name, status: STATUS_LABEL[status], due: patch.due },
        labels: { name: 'Nombre', owner: 'Responsable', client: 'Cliente', status: 'Estado', due: 'Entrega' },
      })
      guard.saved()
      if (r.kind === 'saved') return onCreate(r.value)
      // eligió la versión guardada: el proyecto ya está al día en la lista; se cierra sin tocarlo
      base.current = r.stamp
      setBusy(false)
      onClose()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el proyecto.')
    }
  }

  const remove = async () => {
    if (!project || !window.confirm(`¿Eliminar el proyecto "${project.name}" con sus tareas y gastos?\n\nIrá a la papelera y podrás restaurarlo durante 30 días.`)) return
    setBusy(true)
    try {
      await removeProject(project.id)
      onClose()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo eliminar el proyecto.')
    }
  }

  const archive = async () => {
    if (!project) return
    setBusy(true)
    try {
      await archiveProject(project.id, true)
      onClose()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo archivar el proyecto.')
    }
  }

  // en un portal: la pantalla que lo contiene crea su propio contexto de apilado y quedaba bajo el oscurecido del viaje
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="np-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="np-title">{project ? 'Editar proyecto' : 'Nuevo proyecto'}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <DraftBar guard={guard} />
        <div className="sheet-body">
          <label className="field">
            <span>Nombre</span>
            <input ref={first} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Portal de clientes" autoComplete="off" />
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
              <option value="">Selecciona un cliente</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Astronauta responsable</span>
            <div className="chips" role="radiogroup" aria-label="Astronauta responsable">
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
          {project && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void archive()} title="Lo oculta de las pantallas de trabajo; sus gastos siguen contando en Finanzas">
              Archivar
            </button>
          )}
          {project && (
            <button type="button" className="ghost danger" disabled={busy} onClick={() => void remove()}>
              Eliminar
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {project ? 'Guardar cambios' : 'Guardar proyecto'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
