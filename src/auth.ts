import { api, ApiError } from './api'

// Acceso real contra el backend: el servidor valida el PIN (scrypt), aplica el bloqueo por intentos y fija la cookie de sesion.
// No se pueden crear usuarios desde el login: los astronautas los da de alta el sistema.

export interface Session {
  id: string
  name: string
  avatar: string
  role: 'ADMIN' | 'SOCIO'
  /** true mientras siga con el PIN inicial: debe crear uno nuevo antes de entrar */
  mustChangePin?: boolean
}

export interface Known {
  name: string
  avatar: string
}

/** Busca al astronauta por nombre: null si no esta registrado. */
export async function lookup(name: string): Promise<Known | null> {
  try {
    return await api.post<Known>('/auth/lookup', { name })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export const login = (name: string, pin: string) => api.post<Session>('/auth/login', { name, pin })
export const changePin = (currentPin: string, newPin: string) => api.post<Session>('/auth/change-pin', { currentPin, newPin })
export const logout = () => api.post<null>('/auth/logout').catch(() => null)

/** Sesion vigente (cookie) o null. */
export async function me(): Promise<Session | null> {
  try {
    return await api.get<Session>('/auth/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}
