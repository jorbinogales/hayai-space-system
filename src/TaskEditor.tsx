import { useState } from 'react'
import { Blobvatar } from './blob'
import { useSession } from './session'
import { updateTask, type Task } from './taskData'
import { astronautNames, avatarFor } from './users'

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** Quien lleva una tarea: el asignado y, sin asignar, el responsable del proyecto.
 * El avatar y el nombre son del responsable, no del creador (antes la pantalla mostraba
 * al creador como si fuera quien la llevaba). */
export function TaskResp({ task, projectOwner }: { task: Task; projectOwner: string }) {
  const session = useSession()
  const name = task.responsable ?? projectOwner
  const mine = !!session && session.name.toLowerCase() === name.toLowerCase()
  return (
    <span className="task-resp" title={task.asignada ? `La lleva ${name}` : `Sin asignar: la lleva el responsable del proyecto (${projectOwner})`}>
      <Blobvatar seed={avatarFor(name)} size={26} />
      <span>
        {name}
        {mine && <em> (tú)</em>}
        {!task.asignada && <small> · del proyecto</small>}
      </span>
    </span>
  )
}

/** Selector de responsable para crear o editar una tarea. Valor '' = sin asignar:
 * la lleva el responsable del proyecto. Las opciones salen de la lista de socios. */
export function ResponsableSelect({ value, projectOwner, onChange, label }: { value: string; projectOwner: string; onChange: (v: string) => void; label: string }) {
  return (
    <select className="task-resp-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={label}>
      <option value="">{`Responsable del proyecto (${projectOwner})`}</option>
      {astronautNames().map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

/** Editor en línea de una tarea, compartido por la pantalla Tareas y el detalle de
 * Proyecto: título, fecha y responsable. Guarda por la única vía de edición
 * (updateTask), así que lo editado en un lado se ve en el otro sin duplicar estado. */
export function TaskEditForm({ task, projectOwner, onDone, onError }: { task: Task; projectOwner: string; onDone: () => void; onError: (s: string) => void }) {
  const [title, setTitle] = useState(task.title)
  const [due, setDue] = useState(task.due ?? '')
  const [resp, setResp] = useState(task.asignada ? (task.responsable ?? '') : '')
  const [busy, setBusy] = useState(false)
  const dirty =
    title.trim() !== task.title || (due || null) !== (task.due ?? null) || (resp === '' ? !task.asignada : resp !== task.responsable)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !dirty || busy) return
    setBusy(true)
    onError('')
    try {
      await updateTask(task.id, {
        ...(title.trim() !== task.title ? { titulo: title.trim() } : {}),
        ...((due || null) !== (task.due ?? null) ? { due: due || null } : {}),
        ...(resp === '' ? (!task.asignada ? {} : { responsable: null }) : resp !== task.responsable ? { responsable: resp } : {}),
      })
      onDone()
    } catch (err) {
      onError(msg(err, 'No se pudo guardar la tarea.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="task-edit" onSubmit={save}>
      <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Título de la tarea" aria-label="Título de la tarea" autoComplete="off" />
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Fecha de la tarea (opcional)" title="Fecha (opcional)" />
      <ResponsableSelect value={resp} projectOwner={projectOwner} onChange={setResp} label="Responsable de la tarea" />
      <button type="submit" className="new" disabled={busy || !title.trim() || !dirty}>
        Guardar
      </button>
      <button type="button" className="task-edit-cancel" onClick={onDone} disabled={busy}>
        Cancelar
      </button>
    </form>
  )
}
