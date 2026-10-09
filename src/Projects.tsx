import { useEffect, useRef, useState } from 'react'
import { Icon, ZoomControls } from './ui'
import { Blobvatar } from './blob'
import { avatarFor, entregaVencida, projectCounts, STATUS_LABEL, useProjects } from './projectData'
import { reduced, useDive } from './warp'
import { fmtDate, todayISO, useClients } from './store'
import { useCosmos } from './Cosmos'
import { useDragScroll } from './drag'
import NewProject from './NewProject'
import ProjectDetail, { EditProject } from './projectDetail'

/** Id de proyecto del hash actual (`#proyectos/<id>`), o null. */
const hashProjectId = (): string | null => {
  const [screen, id] = location.hash.slice(1).split('/')
  return screen === 'proyectos' && id ? id : null
}

/** Pantalla Proyectos: el planeta (del mundo compartido) queda a la izquierda, medio escondido, y a la derecha la lista de proyectos. */
export default function Projects({ onBack }: { onBack: () => void }) {
  const { world, setDeep } = useCosmos()
  const projects = useProjects()
  const clients = useClients()
  const pc = projectCounts(projects)
  const [form, setForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(hashProjectId) // proyecto abierto en su detalle: enlace `#proyectos/<id>`
  const [exiting, setExiting] = useState(false)
  const today = todayISO()
  const scroller = useRef<HTMLDivElement>(null)
  useDragScroll(scroller, 'y') // la lista se desplaza con la rueda o manteniendo pulsado y arrastrando
  useDive(form || editing !== null) // al abrir "Nuevo proyecto": ráfaga de velocidad luz y entorno oculto
  useEffect(() => {
    setDeep(form || editing !== null)
    return () => setDeep(false)
  }, [form, editing, setDeep])
  useEffect(() => {
    const onHash = () => setDetail(hashProjectId())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const openDetail = (id: string) => void (location.hash = `proyectos/${id}`)
  const closeDetail = () => void (location.hash = 'proyectos')
  useEffect(() => {
    world.screenRate = null // gira a la velocidad propia del planeta
  }, [world])

  const back = () => {
    setExiting(true)
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }

  return (
    <main className={`screen layer projects arriving${form || editing ? ' deep' : ''}${exiting ? ' exiting' : ''}${detail ? ' has-detail' : ''}`}>
      <div className="overlay">
        <div className="clients-left">
          <button className="back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>
        </div>

        <section className="plist" aria-label="Lista de proyectos">
          <header className="plist-head">
            <h1>Proyectos</h1>
            <div className="plist-side">
              <p>
                <span>
                  <b>{pc.activo}</b> activos
                </span>
                <span>
                  <b>{pc.entrega}</b> en entrega
                </span>
                <span>
                  <b>{pc.planeacion}</b> por visitar
                </span>
              </p>
              <button className="new" onClick={() => setForm(true)}>
                <Icon name="plus" size={16} />
                Nuevo proyecto
              </button>
            </div>
          </header>
          <div className="plist-scroll" ref={scroller}>
            {projects.length === 0 && (
              <p className="empty-note">
                Aún no hay proyectos. {clients.length === 0 ? 'Primero registra un cliente en el planeta Clientes y luego crea su proyecto aquí.' : 'Crea el primero con “Nuevo proyecto”.'}
              </p>
            )}
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <article className={`pcard-p st-${p.status}`}>
                    <header>
                      <span className="p-ico" aria-hidden="true">
                        <Icon name={p.icon} size={22} />
                      </span>
                      <span className="p-right">
                        <span className="p-state">{STATUS_LABEL[p.status]}</span>
                        <button className="p-edit" aria-label={`Editar ${p.name}`} title="Editar" onClick={() => setEditing(p.id)}>
                          <Icon name="edit" size={15} />
                        </button>
                      </span>
                    </header>
                    <h2>
                      <button type="button" className="p-open" onClick={() => openDetail(p.id)} aria-label={`Abrir el detalle de ${p.name}`}>
                        {p.name}
                      </button>
                    </h2>
                    <p className="p-client">{p.client ?? 'Interno de HAYAI'}</p>
                    {p.due && (
                      <p className={`p-due${entregaVencida(p, today) ? ' late' : ''}`}>
                        <Icon name="calendar" size={14} />
                        Entrega {fmtDate(p.due, true)}
                      </p>
                    )}
                    <footer>
                      <Blobvatar seed={avatarFor(p.owner)} size={32} />
                      <p>
                        <small>Responsable</small>
                        {p.owner}
                      </p>
                    </footer>
                  </article>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>

      {detail && <ProjectDetail key={detail} id={detail} onBack={closeDetail} />}
      {editing && projects.find((p) => p.id === editing) && <EditProject projectId={editing} onClose={() => setEditing(null)} />}
      {form && (
        <NewProject
          onClose={() => setForm(false)}
          onCreate={() => {
            setForm(false)
            // el proyecto nuevo queda al final de la lista: se lleva a la vista cuando regresa la pantalla
            window.setTimeout(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }), 500)
          }}
        />
      )}
    </main>
  )
}
