import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, ZoomControls } from './ui'
import { Blobvatar } from './blob'
import { useCosmos } from './Cosmos'
import { useDragScroll } from './drag'
import { avatarFor, useProjects, STATUS_LABEL } from './projectData'
import { addTask, removeTask, taskCounts, toggleTask, useTasks, type Task } from './taskData'
import { reduced } from './warp'

/** Pantalla Tareas: el planeta a un costado y, a la derecha, un tablero "Por hacer / Completadas" para el proyecto elegido. */
export default function Tasks({ onBack }: { onBack: () => void }) {
  const { world } = useCosmos()
  const projects = useProjects()
  const tasks = useTasks()
  const [sel, setSel] = useState(projects[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [exiting, setExiting] = useState(false)
  const rail = useRef<HTMLDivElement>(null)
  const todoCol = useRef<HTMLDivElement>(null)
  const doneCol = useRef<HTMLDivElement>(null)
  useDragScroll(rail, 'y')
  useDragScroll(todoCol, 'y', [sel])
  useDragScroll(doneCol, 'y', [sel])
  useEffect(() => {
    world.screenRate = null // gira a la velocidad propia del planeta
  }, [world])

  const back = () => {
    setExiting(true)
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }

  const project = projects.find((p) => p.id === sel) ?? projects[0]
  const mine = useMemo(() => tasks.filter((x) => x.projectId === project?.id), [tasks, project])
  const todo = mine.filter((x) => !x.done)
  const done = mine.filter((x) => x.done)
  const total = taskCounts(tasks)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !project) return
    void addTask(project.id, title)
    setTitle('')
  }

  const card = (x: Task) => (
    <li key={x.id} className={`task${x.done ? ' is-done' : ''}`}>
      <button className="task-check" role="checkbox" aria-checked={x.done} aria-label={x.done ? `Marcar "${x.title}" como pendiente` : `Completar "${x.title}"`} onClick={() => toggleTask(x.id)}>
        <Icon name="check" size={15} />
      </button>
      <span className="task-title">{x.title}</span>
      <Blobvatar seed={avatarFor(x.owner)} size={26} />
      <button className="task-x" aria-label={`Eliminar "${x.title}"`} onClick={() => removeTask(x.id)}>
        <Icon name="close" size={14} />
      </button>
    </li>
  )

  return (
    <main className={`screen layer tasks arriving${exiting ? ' exiting' : ''}`}>
      <div className="overlay">
        <div className="clients-left">
          <button className="back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>
        </div>

        <section className="plist tk" aria-label="Tareas por proyecto">
          <header className="plist-head">
            <h1>Tareas</h1>
            <div className="plist-side">
              <p>
                <span>
                  <b>{total.pendientes}</b> por hacer
                </span>
                <span>
                  <b>{total.completadas}</b> completadas
                </span>
              </p>
            </div>
          </header>

          <div className="tk-body">
            <nav className="tk-rail" aria-label="Proyectos" ref={rail}>
              {projects.length === 0 && <p className="empty-note">No hay proyectos todavía. Crea uno en el planeta Proyectos para empezar a anotar tareas.</p>}
              {projects.map((p) => {
                const c = taskCounts(tasks.filter((x) => x.projectId === p.id))
                const all = c.pendientes + c.completadas
                return (
                  <button key={p.id} className={`tk-proj${p.id === project?.id ? ' is-on' : ''}`} aria-pressed={p.id === project?.id} onClick={() => setSel(p.id)}>
                    <span className="p-ico" aria-hidden="true">
                      <Icon name={p.icon} size={18} />
                    </span>
                    <span className="tk-pname">
                      {p.name}
                      <small>
                        {c.completadas}/{all} completadas
                      </small>
                      <i className="tk-prog" aria-hidden="true">
                        <b style={{ width: `${all ? (c.completadas / all) * 100 : 0}%` }} />
                      </i>
                    </span>
                  </button>
                )
              })}
            </nav>

            {project && (
              <div className="tk-board" key={project.id}>
                <header className="tk-head">
                  <span className="p-ico" aria-hidden="true">
                    <Icon name={project.icon} size={22} />
                  </span>
                  <div>
                    <h2>{project.name}</h2>
                    <p>
                      {project.client} · {STATUS_LABEL[project.status]}
                    </p>
                  </div>
                  <Blobvatar seed={avatarFor(project.owner)} size={34} />
                </header>

                <form className="tk-add" onSubmit={submit}>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nueva tarea para este proyecto…" aria-label="Nueva tarea" autoComplete="off" />
                  <button type="submit" className="new" disabled={!title.trim()}>
                    <Icon name="plus" size={16} />
                    Agregar
                  </button>
                </form>

                <div className="tk-cols">
                  <section className="tk-col" aria-label="Por hacer">
                    <h3>
                      Por hacer <em>{todo.length}</em>
                    </h3>
                    <div className="tk-list" ref={todoCol}>
                      {todo.length === 0 ? <p className="none">Todo al día.</p> : <ul>{todo.map(card)}</ul>}
                    </div>
                  </section>
                  <section className="tk-col is-done" aria-label="Completadas">
                    <h3>
                      Completadas <em>{done.length}</em>
                    </h3>
                    <div className="tk-list" ref={doneCol}>
                      {done.length === 0 ? <p className="none">Aún no hay tareas completadas.</p> : <ul>{done.map(card)}</ul>}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        </section>

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>
    </main>
  )
}
