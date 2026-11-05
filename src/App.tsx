import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
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
import Admin from './Admin'
import Vault from './Vault'
import { createWorld } from './world'
import { adopt, logout, me, type Session } from './auth'
import { activeTenant, canOpen, clearTenants, selectTenant, useTenants } from './tenant'
import { loadAll, resetAll } from './data'
import { SessionProvider } from './session'
import { startLive, stopLive } from './live'
import { clearAllDrafts, setDraftOwner, startUpdates, stopUpdates } from './updates'
import { UpdateHost } from './UpdateUI'
import { setFinanceView } from './nav'
import Versions from './Versions'
import ToastHost from './Toast'
import { hideSplash } from './splash'

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
  const [sceneReady, setSceneReady] = useState(false) // primer frame 3D pintado
  const [integrations, setIntegrations] = useState(false)
  const [vault, setVault] = useState(false)
  const [admin, setAdmin] = useState(false)
  // espacio de trabajo (tenant) activo y sus módulos: todo lo que se ve depende de ellos
  const tn = useTenants()
  const active = tn.tenants.find((t) => t.id === tn.activeId) ?? null
  const scope = `${tn.activeId ?? 'none'}:${active?.modules.join(',') ?? ''}` // cambia con el espacio o sus permisos: las pantallas se montan de cero
  const [entering, setEntering] = useState(false) // pidiendo los datos del espacio activo
  const [enterError, setEnterError] = useState('')
  const loadSeq = useRef(0)
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
        if (s && !s.mustChangePin && adopt(s)) await loadAll() // sin ningún espacio no hay nada que pedir: se muestra «sin acceso»
        if (alive) setSession(s && !s.mustChangePin ? s : null)
      })
      .catch(() => alive && setSession(null))
    return () => {
      alive = false
    }
  }, [])

  // la pantalla de carga (index.html) se retira cuando ya se sabe si hay sesion y, con sesion, el mundo 3D tiene su primer frame; si algo no llega, a los 12 s se retira igual
  useEffect(() => {
    if (session === undefined) return
    if (session === null || sceneReady) {
      hideSplash()
      return
    }
    const t = window.setTimeout(hideSplash, 12000)
    return () => clearTimeout(t)
  }, [session, sceneReady])

  // con sesion y espacio: avisos del equipo en vivo (stream + alertas) de ESE espacio; al cambiar de espacio se cierra y se abre otro
  useEffect(() => {
    if (!session || !tn.activeId) return
    startLive()
    return stopLive
  }, [session, tn.activeId])

  // pide los datos del espacio activo; mientras llegan se muestra «entrando» y si falla, un reintento
  const enter = async () => {
    const seq = ++loadSeq.current
    setEntering(true)
    setEnterError('')
    try {
      await loadAll()
    } catch (e) {
      if (seq === loadSeq.current) setEnterError(e instanceof Error ? e.message : 'No se pudieron cargar los datos.')
    } finally {
      if (seq === loadSeq.current) setEntering(false)
    }
  }

  // cambiar de espacio: la cabecera ya apunta al nuevo, se vacía TODO lo del anterior, se vuelve al Home y se piden los datos nuevos
  const changeTenant = (id: string) => {
    selectTenant(id)
    resetAll()
    setIntegrations(false)
    setVault(false)
    navigate('home')
    void enter()
  }

  // el servidor dijo que el espacio (o el módulo) ya no es de este socio, o un administrador cambió accesos: se piden de nuevo y,
  // si cambió el espacio activo o sus módulos, se vacía todo y se vuelve a cargar (si ya no queda ninguno, «sin acceso»)
  const refreshing = useRef(false)
  const refreshAccess = async () => {
    if (!session || refreshing.current) return
    refreshing.current = true
    try {
      const s = await me()
      if (!s || s.mustChangePin) return void window.dispatchEvent(new Event('hayai:unauthorized'))
      const before = activeTenant()
      const id = adopt(s)
      const now = activeTenant()
      setSession((cur) => (cur ? { ...cur, role: s.role, name: s.name, avatar: s.avatar } : cur))
      if (before?.id === now?.id && before?.modules.join() === now?.modules.join()) return
      resetAll()
      loadSeq.current++ // lo que estuviera cargando es del estado anterior
      if (id) void enter()
      else setEntering(false)
    } catch {
      /* sin red: el siguiente 403 vuelve a intentarlo */
    } finally {
      refreshing.current = false
    }
  }
  const refreshRef = useRef(refreshAccess)
  refreshRef.current = refreshAccess
  useEffect(() => {
    const on = () => void refreshRef.current()
    // al volver a la pestaña también se revisan los accesos: un administrador pudo cambiarlos mientras estaba en segundo plano
    const back = () => !document.hidden && void refreshRef.current()
    window.addEventListener('hayai:tenant-denied', on)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('hayai:tenant-denied', on)
      document.removeEventListener('visibilitychange', back)
    }
  }, [])

  // las pantallas que el socio no tiene en este espacio: su planeta no se ve ni se puede tocar en el Home, y si estaba en una, vuelve al Home
  useEffect(() => {
    world.locked = new Set((['clientes', 'proyectos', 'tareas', 'finanzas', 'marketing', 'hub'] as const).filter((k) => !canOpen(k)))
    if (session && active && !canOpen(route)) navigate('home')
  }, [world, session, scope])

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
      clearTenants()
      setSession(null)
    }
    window.addEventListener('hayai:unauthorized', out)
    return () => window.removeEventListener('hayai:unauthorized', out)
  }, [])

  // desde dónde se abrió Marketing (su flecha de regreso vuelve ahí: al Hub o al Home)
  const marketingFrom = useRef<'home' | 'hub'>('home')
  const navigate = (target: NavTarget, setHash = true) => {
    // un módulo que el socio no tiene en este espacio no se abre, ni por menú, ni por enlace (#clientes), ni por un atajo
    if (!canOpen(target)) {
      if (!setHash) history.replaceState(null, '', route === 'home' ? location.pathname + location.search : `#${route}`)
      return
    }
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
      <Cosmos world={world} route={route} ui={ui} onOpen={navigate} onReady={() => setSceneReady(true)}>
        {/* clave por espacio y permisos: al cambiar, ninguna pantalla conserva estado del espacio anterior */}
        <Fragment key={scope}>
          <Home shown={ui === 'home'} onOpen={navigate} />
          {ui === 'clientes' && canOpen('clientes') && <Clients onBack={() => navigate('home')} />}
          {ui === 'proyectos' && canOpen('proyectos') && <Projects onBack={() => navigate('home')} />}
          {ui === 'finanzas' && canOpen('finanzas') && <Finances onBack={() => navigate('home')} />}
          {ui === 'tareas' && canOpen('tareas') && <Tasks onBack={() => navigate('home')} />}
          {ui === 'hub' && canOpen('hub') && <Hub onBack={() => navigate('home')} onOpen={navigate} />}
          {ui === 'marketing' && canOpen('marketing') && <Marketing from={marketingFrom.current} onBack={() => navigate(marketingFrom.current)} />}
        </Fragment>
      </Cosmos>
      {session && (
        <Topbar
          key={`bar:${scope}`}
          user={session}
          onTenant={changeTenant}
          onProfile={() => setProfile(true)}
          onIntegrations={() => setIntegrations(true)}
          onVault={() => setVault(true)}
          onAdmin={() => setAdmin(true)}
          onLogout={() => {
            void logout()
            clearAllDrafts() // un navegador compartido no debe conservar lo que escribió este socio
            resetAll()
            clearTenants()
            setProfile(false)
            setIntegrations(false)
            setVault(false)
            setAdmin(false)
            setSession(null)
            if (route !== 'home') navigate('home')
          }}
        />
      )}
      <Warp />
      {session && profile && <Profile user={session} onClose={() => setProfile(false)} />}
      {session && integrations && active && <Integrations key={`ig:${scope}`} onClose={() => setIntegrations(false)} />}
      {session && vault && active && <Vault key={`vt:${scope}`} onClose={() => setVault(false)} />}
      {session?.role === 'ADMIN' && admin && <Admin selfId={session.id} onClose={() => setAdmin(false)} onTenantsChanged={() => void refreshAccess()} />}
      {session && <Versions key={`ver:${scope}`} />}
      {session && <UpdateHost key={`upd:${scope}`} />}
      {session && <ToastHost key={`toast:${scope}`} />}
      {session && (entering || enterError || !active || active.modules.length === 0) && (
        <div className={`na${entering && !enterError && active ? ' is-load' : ''}`} role={entering && !enterError ? 'status' : 'alert'}>
          <div>
            {entering && !enterError && active ? (
              <>
                <i className="na-spin" aria-hidden="true" />
                <h2>Entrando a «{active.name}»</h2>
                <p>Cargando los datos de este espacio de trabajo…</p>
              </>
            ) : enterError ? (
              <>
                <h2>No se pudieron cargar los datos</h2>
                <p>{enterError}</p>
                <div className="na-actions">
                  <button type="button" className="primary" onClick={() => void enter()}>
                    Reintentar
                  </button>
                </div>
              </>
            ) : !active ? (
              <>
                <h2>Sin acceso</h2>
                <p>Tu cuenta no tiene acceso a ningún espacio de trabajo. Pide a un administrador que te asigne uno y vuelve a revisar.</p>
                <div className="na-actions">
                  <button type="button" className="primary" onClick={() => void refreshAccess()}>
                    Revisar de nuevo
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Sin módulos habilitados</h2>
                <p>
                  Tienes acceso a «{active.name}», pero todavía no tienes ningún módulo en este espacio.
                  {tn.tenants.length > 1 ? ' Cambia de espacio desde el menú de arriba o pide a un administrador que te habilite alguno.' : ' Pide a un administrador que te habilite alguno.'}
                </p>
                <div className="na-actions">
                  <button type="button" className="primary" onClick={() => void refreshAccess()}>
                    Revisar de nuevo
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
