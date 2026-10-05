import { useEffect, useMemo, useState } from 'react'
import Cosmos from './Cosmos'
import Home from './Home'
import Clients from './Clients'
import Projects from './Projects'
import Expenses from './Expenses'
import Finances from './Finances'
import Tasks from './Tasks'
import { Topbar } from './ui'
import { Warp } from './warp'
import Boot from './Boot'
import Profile from './Profile'
import Integrations from './Integrations'
import Vault from './Vault'
import { createWorld } from './world'
import { logout, me, type Session } from './auth'
import { loadAll, resetAll } from './data'
import { SessionProvider } from './session'

export type Screen = 'home' | 'clientes' | 'proyectos' | 'gastos' | 'finanzas' | 'tareas'
const fromHash = (): Screen => {
  const h = location.hash.slice(1)
  return h === 'clientes' || h === 'proyectos' || h === 'gastos' || h === 'finanzas' || h === 'tareas' ? h : 'home'
}

export default function App() {
  // undefined = comprobando la sesion (cookie) con el servidor; null = sin sesion
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [route, setRoute] = useState<Screen>(fromHash)
  // capa mostrada: solo cuando el viaje ya llego (null mientras se viaja)
  const [ui, setUi] = useState<Screen | null>(route)
  const [profile, setProfile] = useState(false)
  const [integrations, setIntegrations] = useState(false)
  const [vault, setVault] = useState(false)
  // un unico mundo 3D para todas las pantallas: navegar mueve objetos dentro de la misma escena
  const world = useMemo(() => createWorld(route === 'home' ? null : route), [])

  useEffect(() => {
    world.onArrive = (at) => setUi(at)
  }, [world])

  // al abrir la app: si hay sesion vigente se cargan los datos y se entra; si no, pantalla de acceso
  useEffect(() => {
    let alive = true
    me()
      .then(async (s) => {
        if (s && !s.mustChangePin) await loadAll()
        if (alive) setSession(s && !s.mustChangePin ? s : null)
      })
      .catch(() => alive && setSession(null))
    return () => {
      alive = false
    }
  }, [])

  // sesion vencida o revocada en el servidor: vuelve al acceso
  useEffect(() => {
    const out = () => {
      resetAll()
      setSession(null)
    }
    window.addEventListener('hayai:unauthorized', out)
    return () => window.removeEventListener('hayai:unauthorized', out)
  }, [])

  const navigate = (s: Screen, setHash = true) => {
    if (world.busy() || s === route) return
    if (setHash) location.hash = s === 'home' ? '' : s
    setRoute(s)
    setUi(null)
    world.go(s === 'home' ? null : s)
  }

  useEffect(() => {
    const onHash = () => navigate(fromHash(), false)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })

  return (
    <SessionProvider value={session ?? null}>
    <div className="app">
      <Cosmos world={world} route={route} ui={ui} onOpen={navigate}>
        <Home shown={ui === 'home'} onOpen={navigate} />
        {ui === 'clientes' && <Clients onBack={() => navigate('home')} />}
        {ui === 'proyectos' && <Projects onBack={() => navigate('home')} />}
        {ui === 'gastos' && <Expenses onBack={() => navigate('home')} />}
        {ui === 'finanzas' && <Finances onBack={() => navigate('home')} />}
        {ui === 'tareas' && <Tasks onBack={() => navigate('home')} />}
      </Cosmos>
      {session && (
        <Topbar
          user={session}
          onProfile={() => setProfile(true)}
          onIntegrations={() => setIntegrations(true)}
          onVault={() => setVault(true)}
          onLogout={() => {
            void logout()
            resetAll()
            setProfile(false)
            setIntegrations(false)
            setVault(false)
            setSession(null)
            if (route !== 'home') navigate('home')
          }}
        />
      )}
      <Warp />
      {session && profile && <Profile user={session} onClose={() => setProfile(false)} />}
      {session && integrations && <Integrations onClose={() => setIntegrations(false)} />}
      {session && vault && <Vault onClose={() => setVault(false)} />}
      {session === undefined && <div className="boot-wait" aria-hidden="true" />}
      {session === null && (
        <Boot
          onDone={(s) => {
            setSession(s)
            navigate('home')
          }}
        />
      )}
    </div>
    </SessionProvider>
  )
}
