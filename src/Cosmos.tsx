import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { mountScene, type Mounted } from './scene'
import { buildWorld, WORLD_TEXTURES, type HotKey, type World } from './world'
import type { Screen } from './App'

interface Cosmic {
  world: World
  hot: HotKey | null
  setHot: (k: HotKey | null) => void
  /** los formularios ocultan el planeta y su entorno mientras estan abiertos */
  setDeep: (on: boolean) => void
}
const Ctx = createContext<Cosmic>(null!)
export const useCosmos = () => useContext(Ctx)

/**
 * Contenedor unico: UN canvas, UNA escena. Las pantallas (Home, Clientes, Proyectos) son capas HTML que se montan encima;
 * cambiar de pantalla mueve objetos dentro de la misma escena, sin recargar nada.
 */
export default function Cosmos({
  world,
  route,
  ui,
  onOpen,
  onReady,
  children,
}: {
  world: World
  route: Screen
  /** capa mostrada (ya asentada); null mientras se viaja */
  ui: Screen | null
  onOpen: (s: Screen) => void
  /** el primer frame real del mundo ya esta pintado */
  onReady?: () => void
  children: ReactNode
}) {
  const stage = useRef<HTMLDivElement>(null)
  const mounted = useRef<Mounted | null>(null)
  const [hot, setHot] = useState<HotKey | null>(null)
  const [deep, setDeep] = useState(false)
  world.hot = hot
  const ready = useRef(onReady)
  ready.current = onReady

  useEffect(() => {
    const m = mountScene(stage.current!, WORLD_TEXTURES, (ctx, tex) => buildWorld(ctx, tex, world), () => ready.current?.())
    mounted.current = m
    world.zoomBy = m.zoomBy
    if (import.meta.env.DEV) (window as unknown as { __world: World }).__world = world // depuracion: permite pausar el viaje en un punto
    return m.dispose
  }, [world])

  const value = useMemo<Cosmic>(() => ({ world, hot, setHot, setDeep }), [world, hot])
  const down = useRef<{ x: number; y: number } | null>(null)

  return (
    <Ctx.Provider value={value}>
      <div className={`cosmos${route !== 'home' ? ' is-deep' : ''}${deep ? ' deep' : ''}`}>
        <div className="bg bg-a" aria-hidden="true" />
        <div className="bg bg-b" aria-hidden="true" />
        <div
          ref={stage}
          className="stage"
          style={{ cursor: ui === 'home' && hot ? 'pointer' : 'default' }}
          onPointerMove={(e) => (ui === 'home' ? setHot(world.pick(e.clientX, e.clientY)) : world.stagePointer?.('move', e))}
          onPointerLeave={() => ui === 'home' && setHot(null)}
          onPointerDown={(e) => {
            if (ui === 'home' || !world.stagePointer || e.button !== 0) return
            down.current = { x: e.clientX, y: e.clientY }
            e.currentTarget.setPointerCapture(e.pointerId)
            world.stagePointer('down', e)
          }}
          onPointerUp={(e) => world.stagePointer?.('up', e)}
          onPointerCancel={(e) => world.stagePointer?.('up', e)}
          onClick={(e) => {
            if (ui === 'home') {
              const k = world.pick(e.clientX, e.clientY)
              if (k) onOpen(k)
            } else if (!down.current || Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) < 5) world.stageClick?.() // un arrastre no cuenta como clic
          }}
          aria-hidden="true"
        />
        {children}
      </div>
    </Ctx.Provider>
  )
}
