import { api } from './api'
import { createList } from './cache'

export interface Task {
  id: string
  projectId: string
  title: string
  done: boolean
  /** fecha agendada (YYYY-MM-DD), p.ej. la visita al cliente */
  due?: string | null
  /** astronauta que la creo (nombre) */
  owner: string
}

const tasks = createList<Task>()
export const useTasks = tasks.use
export const loadTasks = async () => tasks.set(await api.get<Task[]>('/tasks'))
export const resetTasks = () => tasks.set([])

export async function addTask(projectId: string, title: string, due?: string): Promise<Task> {
  const t = await api.post<Task>('/tasks', { projectId, title, ...(due ? { due } : {}) })
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

export const taskCounts = (list: Task[]) => ({ pendientes: list.filter((x) => !x.done).length, completadas: list.filter((x) => x.done).length })
