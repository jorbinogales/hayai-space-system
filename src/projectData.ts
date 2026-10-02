import type { IconName } from './ui'
import { api } from './api'
import { createList } from './cache'

export type ProjectStatus = 'activo' | 'entrega' | 'planeacion'
export const STATUS_LABEL: Record<ProjectStatus, string> = { activo: 'Activo', entrega: 'En entrega', planeacion: 'Por visitar' }

export interface Project {
  id: string
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
}

const projects = createList<Project>()
export const useProjects = projects.use
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
export async function updateProject(id: string, d: ProjectPatch): Promise<Project> {
  const p = await api.patch<Project>(`/projects/${id}`, d)
  projects.update((cur) => cur.map((x) => (x.id === id ? p : x)))
  return p
}

export const projectCounts = (list: Project[]) => ({
  activo: list.filter((p) => p.status === 'activo').length,
  entrega: list.filter((p) => p.status === 'entrega').length,
  planeacion: list.filter((p) => p.status === 'planeacion').length,
})

export const PROJECT_ICONS: IconName[] = ['globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code']
export { avatarFor, astronautNames } from './users'
