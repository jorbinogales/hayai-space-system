import { useMemo } from 'react'
import { api } from './api'
import { createList } from './cache'

export interface Task {
  id: string
  /** version del registro (la tarea se completa sin If-Match: marcar hecho es explicito y no pisa texto) */
  updatedAt?: string
  projectId: string
  title: string
  done: boolean
  /** fecha agendada (YYYY-MM-DD), p.ej. la visita al cliente */
  due?: string | null
  /** astronauta que la creo (nombre) — NO es quien la lleva */
  owner: string
  /** quien la lleva: el asignado y, sin asignar, el responsable del proyecto */
  responsable?: string | null
  /** true si se le asignó a mano a alguien distinto del responsable del proyecto */
  asignada?: boolean
  /** su proyecto (o el cliente de este) está archivado: no se muestra */
  hidden?: boolean
}

const tasks = createList<Task>()
/** Las tareas de trabajo: sin las de proyectos o clientes archivados. */
export const useTasks = () => {
  const all = tasks.use()
  return useMemo(() => all.filter((t) => !t.hidden), [all])
}
/** Lectura puntual (fuera de React) de una tarea: para llevar al proyecto donde quedó. */
export const taskNow = (id: string) => tasks.get().find((t) => t.id === id)
export const loadTasks = async () => tasks.set(await api.get<Task[]>('/tasks'))
export const resetTasks = () => tasks.set([])

export async function addTask(projectId: string, title: string, due?: string, responsable?: string): Promise<Task> {
  const t = await api.post<Task>('/tasks', { projectId, title, ...(due ? { due } : {}), ...(responsable ? { responsable } : {}) })
  tasks.update((cur) => [...cur, t])
  return t
}
/** Cambia el estado al instante y lo confirma en el servidor; si falla, lo deja como estaba. */
export async function toggleTask(id: string) {
  const before = tasks.get()
  const cur = before.find((x) => x.id === id)
  if (!cur) return
  tasks.update((l) => l.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))
  try {
    await api.patch(`/tasks/${id}`, { done: !cur.done })
  } catch {
    tasks.set(before)
  }
}
export async function removeTask(id: string) {
  const before = tasks.get()
  tasks.update((l) => l.filter((x) => x.id !== id))
  try {
    await api.del(`/tasks/${id}`)
  } catch {
    tasks.set(before)
  }
}

/** Parche de edición de una tarea (título, fecha, responsable). `responsable: null` la
 * devuelve al responsable del proyecto. Es la ÚNICA vía de edición en la web: tanto la
 * pantalla Tareas como el detalle de Proyecto la usan, así que lo que se edita en un
 * lado se ve en el otro sin duplicar estado en el frontend. */
export interface TaskPatch {
  titulo?: string
  due?: string | null
  responsable?: string | null
}
export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const before = tasks.get()
  const cur = before.find((x) => x.id === id)
  if (!cur) throw new Error('Tarea no encontrada')
  const next: Task = {
    ...cur,
    ...(patch.titulo !== undefined ? { title: patch.titulo } : {}),
    ...(patch.due !== undefined ? { due: patch.due } : {}),
    // El servidor devuelve el responsable real tras el cambio (el asignado o, sin
    // asignar, el del proyecto); aquí solo se anticipa el nombre elegido.
    ...(patch.responsable !== undefined ? { responsable: patch.responsable } : {}),
  }
  tasks.update((l) => l.map((x) => (x.id === id ? next : x)))
  try {
    const saved = await api.patch<Task>(`/tasks/${id}`, {
      ...(patch.titulo !== undefined ? { titulo: patch.titulo } : {}),
      ...(patch.due !== undefined ? { due: patch.due } : {}),
      ...(patch.responsable !== undefined ? { responsable: patch.responsable } : {}),
    })
    tasks.update((l) => l.map((x) => (x.id === id ? saved : x)))
    return saved
  } catch (err) {
    tasks.set(before)
    throw err
  }
}

export const taskCounts = (list: Task[]) => ({ pendientes: list.filter((x) => !x.done).length, completadas: list.filter((x) => x.done).length })
