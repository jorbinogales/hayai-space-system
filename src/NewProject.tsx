import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import { todayISO, useClients } from './store'
import { useSession } from './session'
import { addProject, astronautNames, avatarFor, PROJECT_ICONS, STATUS_LABEL, type Project, type ProjectStatus } from './projectData'

const STATUSES: ProjectStatus[] = ['planeacion', 'activo', 'entrega']
const ICON_LABEL: Record<string, string> = { globe: 'Web', phone: 'App móvil', chart: 'Panel / datos', cart: 'Tienda', palette: 'Diseño', box: 'Sistema', code: 'Desarrollo' }

/** Alta de proyecto: nombre, icono representativo, cliente, astronauta responsable y estado. Mismo estilo que "Nuevo cliente". */
export default function NewProject({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Project) => void }) {
  const clients = useClients()
  const session = useSession()
  const owners = astronautNames()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState(PROJECT_ICONS[0])
  const [client, setClient] = useState('')
  const [owner, setOwner] = useState(() => {
    const me = session?.name // por defecto, el astronauta que tiene la sesión
    return owners.find((o) => o.toLowerCase() === me?.toLowerCase()) ?? owners[0]
  })
  const [status, setStatus] = useState<ProjectStatus>('planeacion')
  const [due, setDue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)

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
    if (!due) return setError('Indica la fecha de entrega.')
    setBusy(true)
    try {
      onCreate(await addProject({ name, icon, clientId: client, owner, status, due }))
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el proyecto.')
    }
  }

  // en un portal: la pantalla que lo contiene crea su propio contexto de apilado y quedaba bajo el oscurecido del viaje
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="np-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="np-title">Nuevo proyecto</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

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
            <input type="date" value={due} min={todayISO()} onChange={(e) => setDue(e.target.value)} />
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
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Guardar proyecto
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
