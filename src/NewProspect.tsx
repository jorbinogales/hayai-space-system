import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { Blobvatar, AVATAR_SEEDS, AvatarPicker } from './blob'
import { addProspect, todayISO, type Client } from './store'
import { astronautNames, avatarFor, PROJECT_ICONS } from './projectData'
import { useSession } from './session'
import { DraftBar } from './UpdateUI'
import { useFormGuard } from './updates'

/** Orígenes de un lead (los siete de siempre primero). «Otro» es el valor por defecto: un lead nuevo no queda sin origen. */
export const ORIGEN_OPCIONES: [string, string][] = [
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['meta_ads', 'Meta Ads'],
  ['referido', 'Referido'],
  ['web', 'Web'],
  ['visita_frio', 'Visita en frío'],
  ['evento', 'Evento'],
  ['otro', 'Otro'],
]

const ICON_LABEL: Record<string, string> = { globe: 'Web', phone: 'App móvil', chart: 'Panel / datos', cart: 'Tienda', palette: 'Diseño', box: 'Sistema', code: 'Desarrollo' }

/** Alta de un cliente potencial: su posible proyecto y la visita agendada (una tarea del proyecto). Sin pagos ni mensualidades. */
export default function NewProspect({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Client) => void }) {
  const session = useSession()
  const owners = astronautNames()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(() => AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)])
  const [project, setProject] = useState('')
  const [icon, setIcon] = useState(PROJECT_ICONS[0])
  const [owner, setOwner] = useState(() => owners.find((o) => o.toLowerCase() === session?.name.toLowerCase()) ?? owners[0] ?? '')
  const [visitDate, setVisitDate] = useState('')
  const [visitTitle, setVisitTitle] = useState('')
  const [source, setSource] = useState('otro')
  const [utm, setUtm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  const guard = useFormGuard({
    id: 'posible:nuevo',
    label: 'Cliente potencial',
    values: { name, project, visitDate, visitTitle, source, utm },
    initial: { name: '', project: '', visitDate: '', visitTitle: '', source: 'otro', utm: '' },
    labels: { name: 'nombre', project: 'proyecto', visitDate: 'fecha de la visita', visitTitle: 'título de la visita', source: 'origen', utm: 'utm_source' },
    apply: (v) => {
      setName(v.name)
      setProject(v.project)
      setVisitDate(v.visitDate)
      setVisitTitle(v.visitTitle)
      setSource(v.source || 'otro')
      setUtm(v.utm ?? '')
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
    if (!name.trim()) return setError('Escribe el nombre del cliente potencial.')
    if (!project.trim()) return setError('Indica el posible proyecto.')
    if (!owner) return setError('Elige quién será el responsable.')
    setBusy(true)
    try {
      const c = await addProspect({ name: name.trim(), avatar, project: { name: project.trim(), icon, owner, due: null }, visit: { date: visitDate || null, title: visitTitle.trim() || undefined }, source, utmSource: utm.trim() || null })
      guard.saved()
      onCreate(c)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el cliente potencial.')
    }
  }

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="np2-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="np2-title">Cliente potencial</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <DraftBar guard={guard} />
        <div className="sheet-body">
          <label className="field">
            <span>Nombre</span>
            <input ref={first} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Panadería La Estrella" autoComplete="off" />
          </label>

          <div className="two">
            <label className="field">
              <span>¿De dónde llegó?</span>
              <select value={source} onChange={(e) => setSource(e.target.value)} required>
                {ORIGEN_OPCIONES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>utm_source (opcional)</span>
              <input value={utm} maxLength={80} onChange={(e) => setUtm(e.target.value)} placeholder="Ej. bio_link" autoComplete="off" />
            </label>
          </div>

          <div className="field">
            <span>Icono del cliente potencial</span>
            <AvatarPicker value={avatar} onChange={setAvatar} label="Icono del cliente potencial" />
          </div>

          <fieldset>
            <legend>Posible proyecto</legend>
            <label className="field">
              <span>Nombre del proyecto</span>
              <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Ej. Sistema de pedidos" autoComplete="off" />
            </label>
            <div className="field" style={{ marginTop: 12 }}>
              <span>Icono</span>
              <div className="icon-pick" role="radiogroup" aria-label="Icono del proyecto">
                {PROJECT_ICONS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={icon === k} aria-label={ICON_LABEL[k]} title={ICON_LABEL[k]} className={icon === k ? 'is-on' : ''} onClick={() => setIcon(k)}>
                    <Icon name={k} size={22} />
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
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
          </fieldset>

          <fieldset>
            <legend>Visita al cliente</legend>
            <div className="two">
              <label className="field">
                <span>Fecha de la visita</span>
                <input type="date" value={visitDate} min={todayISO()} onChange={(e) => setVisitDate(e.target.value)} />
              </label>
              <label className="field">
                <span>Tarea (opcional)</span>
                <input value={visitTitle} onChange={(e) => setVisitTitle(e.target.value)} placeholder={name.trim() ? `Visita a ${name.trim()}` : 'Visita al cliente'} autoComplete="off" />
              </label>
            </div>
            <p className="hint">Se crea como tarea del proyecto, en la pantalla Tareas. Puedes dejar la fecha vacía y agendarla después.</p>
          </fieldset>
        </div>

        <footer>
          <p className="err" role="alert">
            {error}
          </p>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Guardar cliente potencial
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
