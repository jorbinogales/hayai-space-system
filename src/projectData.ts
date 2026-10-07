import { useMemo } from 'react'
import type { IconName } from './ui'
import { api } from './api'
import { createList } from './cache'
import { loadExpenses } from './expenseData'
import { loadTasks } from './taskData'

export type ProjectStatus = 'activo' | 'entrega' | 'planeacion'
export const STATUS_LABEL: Record<ProjectStatus, string> = { activo: 'Activo', entrega: 'En entrega', planeacion: 'Por visitar' }

export interface Project {
  id: string
  /** version del registro: se manda como If-Match al editar */
  updatedAt?: string
  name: string
  /** icono representativo del proyecto */
  icon: IconName
  /** astronauta responsable (nombre) */
  owner: string
  /** cliente (nombre e id) */
  client: string
  clientId: string
  status: ProjectStatus
  /** fecha de entrega, YYYY-MM-DD */
  due?: string | null
  /** archivado: oculto de las pantallas de trabajo */
  archived?: boolean
  /** su cliente está archivado (el proyecto se oculta con él) */
  clientArchived?: boolean
}

const projects = createList<Project>()
/** Todos los proyectos, ocultos incluidos: para Finanzas (cruza gastos con clientes) y el Archivo. */
export const useAllProjects = projects.use
/** Los proyectos de trabajo: sin los archivados ni los de un cliente archivado. */
export const useProjects = () => {
  const all = projects.use()
  return useMemo(() => all.filter((p) => !p.archived && !p.clientArchived), [all])
}
/** Lectura puntual (fuera de React) de un proyecto: para comparar con lo recien recargado. */
export const projectNow = (id: string) => projects.get().find((p) => p.id === id)
export const loadProjects = async () => projects.set(await api.get<Project[]>('/projects'))
export const resetProjects = () => projects.set([])

export interface ProjectDraft {
  name: string
  icon: IconName
  clientId: string
  /** nombre del astronauta responsable */
  owner: string
  status: ProjectStatus
  due: string
}
export async function addProject(d: ProjectDraft): Promise<Project> {
  const p = await api.post<Project>('/projects', d)
  projects.update((cur) => [...cur, p])
  return p
}

export type ProjectPatch = Partial<Omit<ProjectDraft, 'due'>> & { due?: string | null }
/** Edita un proyecto (nombre, icono, cliente, responsable, estado, fecha de entrega). */
export async function updateProject(id: string, d: ProjectPatch, ifMatch?: string): Promise<Project> {
  const p = await api.patch<Project>(`/projects/${id}`, d, { ifMatch })
  projects.update((cur) => cur.map((x) => (x.id === id ? p : x)))
  return p
}

/** Archiva o desarchiva un proyecto (sus tareas se ocultan con él). */
export async function archiveProject(id: string, archived: boolean): Promise<Project> {
  const p = await api.post<Project>(`/projects/${id}/${archived ? 'archive' : 'unarchive'}`)
  projects.update((cur) => cur.map((x) => (x.id === id ? p : x)))
  await loadTasks()
  return p
}

/** Manda el proyecto (con sus tareas y gastos) a la papelera; refresca tareas y gastos. */
export async function removeProject(id: string): Promise<void> {
  await api.del(`/projects/${id}`)
  projects.update((cur) => cur.filter((x) => x.id !== id))
  await Promise.all([loadTasks(), loadExpenses()])
}

export const projectCounts = (list: Project[]) => ({
  activo: list.filter((p) => p.status === 'activo').length,
  entrega: list.filter((p) => p.status === 'entrega').length,
  planeacion: list.filter((p) => p.status === 'planeacion').length,
})

export const PROJECT_ICONS: IconName[] = ['globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code']
export { avatarFor, astronautNames } from './users'
