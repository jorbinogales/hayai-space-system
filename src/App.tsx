import { useEffect, useMemo, useRef, useState } from 'react'
import Cosmos from './Cosmos'
import Home from './Home'
import Clients from './Clients'
import Projects from './Projects'
import Finances from './Finances'
import Tasks from './Tasks'
import Hub from './Hub'
import Marketing from './Marketing'
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
import { startLive, stopLive } from './live'
import { clearAllDrafts, setDraftOwner, startUpdates, stopUpdates } from './updates'
import { UpdateHost } from './UpdateUI'
import { setFinanceView } from './nav'
import Versions from './Versions'
import ToastHost from './Toast'

export type Screen = 'home' | 'clientes' | 'proyectos' | 'finanzas' | 'tareas' | 'hub' | 'marketing'
/** A dónde se puede navegar: «gastos» ya no es una pantalla, es la vista Gastos dentro de Finanzas. */
export type NavTarget = Screen | 'gastos'
/** Pantallas planas: se montan encima del cosmos sin viaje 3D (el mundo se queda en el Home, tapado por la pantalla). Marketing ya no: es un planeta que viaja y se ancla a la izquierda, como Finanzas. */
export const isFlat = (s: Screen) => s === 'hub'
const fromHash = (): Screen => {
  const h = location.hash.slice(1).split('/')[0]
  if (h === 'gastos') return 'finanzas' // enlace viejo: Gastos vive dentro de Finanzas
  return h === 'clientes' || h === 'proyectos' || h === 'finanzas' || h === 'tareas' || h === 'hub' || h === 'marketing' ? h : 'home'
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
  const world = useMemo(() => createWorld(route === 'home' || isFlat(route) ? null : (route as Exclude<Screen, 'home' | 'hub'>)), [])

  // la pantalla actual y si al llegar al Home hay que mostrar el Hub (volver a él desde un planeta que se abrió desde el Hub)
  const routeRef = useRef(route)
  routeRef.current = route
  const arriveHub = useRef(false)
  useEffect(() => {
    world.onArrive = (at) => {
      if (arriveHub.current && at === 'home') {
        arriveHub.current = false
        setUi('hub')
      } else if (routeRef.current === 'hub') {
        // el Hub es plano: solo su vista Feed ancla el núcleo, y esas llegadas/salidas no cambian la capa mostrada
      } else setUi(at)
    }
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

  // con sesion: avisos del equipo en vivo (stream + alertas); sin sesion: todo apagado y vaciado
  useEffect(() => {
    if (!session) return
    startLive()
    return stopLive
  }, [session])

  // con sesion: vigilancia de version (banner «Recargar página») y borradores de formularios de este socio
  useEffect(() => {
    if (!session) return
    setDraftOwner(session.id)
    startUpdates()
    return stopUpdates
  }, [session])

  // sesion vencida o revocada en el servidor: vuelve al acceso
  useEffect(() => {
    const out = () => {
      resetAll()
      setSession(null)
    }
    window.addEventListener('hayai:unauthorized', out)
    return () => window.removeEventListener('hayai:unauthorized', out)
  }, [])

  // desde dónde se abrió Marketing (su flecha de regreso vuelve ahí: al Hub o al Home)
  const marketingFrom = useRef<'home' | 'hub'>('home')
  const navigate = (target: NavTarget, setHash = true) => {
    // Gastos vive dentro de Finanzas: «gastos» abre Finanzas en esa vista; «finanzas» a secas, en el resumen
    const s: Screen = target === 'gastos' ? 'finanzas' : target
    if (target === 'gastos') setFinanceView('gastos', false)
    else if (s === 'finanzas') setFinanceView(setHash || location.hash.split('/')[1] !== 'gastos' ? 'resumen' : 'gastos', false) // por enlace (#finanzas/gastos) se respeta la vista del hash
    if (world.busy() || s === route) return
    if (s === 'marketing') marketingFrom.current = route === 'hub' ? 'hub' : 'home'
    if (setHash) location.hash = s === 'home' ? '' : s === 'finanzas' && target === 'gastos' ? 'finanzas/gastos' : s
    // el Feed del Hub deja el núcleo anclado a la izquierda: si se sale de él sin volver al Hub, el mundo regresa al Home de golpe
    if (route === 'hub' && s !== 'hub' && world.key === 'hub') world.snapHome()
    // de un planeta de vuelta al Hub (Marketing abierto desde el Hub): el planeta viaja de regreso y al llegar se muestra el Hub
    if (s === 'hub' && route !== 'home' && !isFlat(route)) {
      arriveHub.current = true
      setRoute('hub')
      setUi(null)
      world.go(null)
      return
    }
    // las pantallas planas (hub) no viajan: se muestran al instante sobre el cosmos
    if (isFlat(s) || (isFlat(route) && s === 'home')) {
      setRoute(s)
      setUi(s)
      return
    }
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
        {ui === 'finanzas' && <Finances onBack={() => navigate('home')} />}
        {ui === 'tareas' && <Tasks onBack={() => navigate('home')} />}
        {ui === 'hub' && <Hub onBack={() => navigate('home')} onOpen={navigate} />}
        {ui === 'marketing' && <Marketing from={marketingFrom.current} onBack={() => navigate(marketingFrom.current)} />}
      </Cosmos>
      {session && (
        <Topbar
          user={session}
          onProfile={() => setProfile(true)}
          onIntegrations={() => setIntegrations(true)}
          onVault={() => setVault(true)}
          onLogout={() => {
            void logout()
            clearAllDrafts() // un navegador compartido no debe conservar lo que escribió este socio
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
      {session && <Versions />}
      {session && <UpdateHost />}
      {session && <ToastHost />}
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
