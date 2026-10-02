import { api } from './api'
import { createList } from './cache'

export interface User {
  id: string
  name: string
  avatar: string
}

const users = createList<User>()
export const useUsers = users.use
export const loadUsers = async () => users.set(await api.get<User[]>('/users'))
export const resetUsers = () => users.set([])

/** Avatar del astronauta (por nombre); si aun no cargo la lista, usa el nombre como semilla. */
export const avatarFor = (name: string) => users.get().find((u) => u.name === name)?.avatar ?? name
export const astronautNames = () => users.get().map((u) => u.name)
