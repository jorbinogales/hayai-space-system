import { createContext, useContext } from 'react'
import type { Session } from './auth'

const Ctx = createContext<Session | null>(null)
export const SessionProvider = Ctx.Provider
/** Astronauta con la sesion abierta (null en la pantalla de acceso). */
export const useSession = () => useContext(Ctx)
