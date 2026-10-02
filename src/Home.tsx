import { useEffect, useRef, type CSSProperties } from 'react'
import * as THREE from 'three'
import { toScreen } from './scene'
import { money, summary, useClients } from './store'
import { projectCounts, useProjects } from './projectData'
import { monthSummary, useExpenses } from './expenseData'
import { monthFinance } from './finance'
import { taskCounts, useTasks } from './taskData'
import { Icon, ZoomControls } from './ui'
import type { Screen } from './App'
import { CORE_R, PLANETS, type PlanetKey } from './world'
import { useCosmos } from './Cosmos'

/** Capa HTML del Home: tarjetas de cada planeta + marca del nucleo, que siguen a los objetos 3D. Solo se ve con `shown`. */
export default function Home({ shown, onOpen }: { shown: boolean; onOpen: (s: Screen) => void }) {
  const { world, hot, setHot } = useCosmos()
  const cards = useRef<(HTMLElement | null)[]>([])
  const mark = useRef<HTMLParagraphElement | null>(null)
  const sm = summary(useClients())
  const pc = projectCounts(useProjects())
  const expenses = useExpenses()
  const gx = monthSummary(expenses)
  const tk = taskCounts(useTasks())
  const fin = monthFinance(useClients(), expenses)

  useEffect(() => {
    const v = new THREE.Vector3()
    const lastR: number[] = []
    let lastCoreR = -1

    world.homeResize = () => {
      const ctx = world.ctx
      if (!ctx) return
      // escala: que las tarjetas (px) de los extremos queden dentro de la pantalla
      const cw = cards.current[0]?.querySelector<HTMLElement>('.card')?.offsetWidth ?? 176
      const phone = ctx.w < 600
      const u = phone
        ? (ctx.w - 32) / 13
        : Math.max(20, Math.min((ctx.w / 2 - 28 - cw) / 6.27, (ctx.w / 2 - 16 - cw - (ctx.w < 1200 ? 30 : 38)) / 6.47))
      ctx.setView(Math.max(10.72, ctx.h / u), phone ? 0.27 : 0.4516)
    }
    world.homeSync = () => {
      const ctx = world.ctx
      if (!ctx) return
      const { camera } = ctx
      const c0 = toScreen(v.set(0, 0, 0), camera, ctx.w, ctx.h)
      const coreR = toScreen(v.set(CORE_R, 0, 0), camera, ctx.w, ctx.h).x - c0.x
      const mk = mark.current
      if (mk) {
        mk.style.transform = `translate3d(${c0.x}px,${c0.y}px,0) translate(-50%,-50%)`
        if (Math.abs(coreR - lastCoreR) > 0.5) {
          mk.style.fontSize = `${coreR * 0.17}px`
          lastCoreR = coreR
        }
      }
      world.items.forEach((it, i) => {
        const el = cards.current[i]
        if (!el) return
        const pt = toScreen(it.anchor.position, camera, ctx.w, ctx.h)
        const r = toScreen(v.set(it.anchor.position.x + it.p.r, it.anchor.position.y, 0), camera, ctx.w, ctx.h).x - pt.x
        el.style.transform = `translate3d(${pt.x}px,${pt.y}px,0)`
        if (Math.abs(r - (lastR[i] ?? -1)) > 0.4) {
          el.style.setProperty('--r', `${r}px`)
          lastR[i] = r
        }
      })
    }
    world.homeResize()
    return () => {
      world.homeSync = null
      world.homeResize = null
    }
  }, [world])

  const open = (k: PlanetKey) => {
    if (!shown || false) return
    setHot(null)
    onOpen(k)
  }

  return (
    <main className={`screen layer home${shown ? '' : ' warping'}`}>
      <div className="overlay">
        <p className="core-mark" ref={mark} aria-label="HAYAI">
          HAYAI
        </p>
        {PLANETS.map((p, i) => {
          const d =
            p.key === 'clientes'
              ? { title: 'Clientes', lines: [`${sm.activos} activos`, `${money(sm.recaudado)} recaudado`, `${sm.porCobrar} por cobrar`] }
              : p.key === 'proyectos'
                ? { title: 'Proyectos', lines: [`${pc.activo} activos`, `${pc.entrega} en entrega`, `${pc.planeacion} por visitar`] }
                : p.key === 'gastos'
                  ? { title: 'Gastos', lines: [`${money(gx.total)} este mes`, `${gx.cantidad} ${gx.cantidad === 1 ? 'gasto' : 'gastos'}`] }
                  : p.key === 'finanzas'
                    ? { title: 'Finanzas', lines: [`${money(fin.ingresos)} ingresos`, `${money(fin.gastos)} gastos`, `${money(fin.ingresos - fin.gastos)} balance`] }
                    : { title: 'Tareas', lines: [`${tk.pendientes} por hacer`, `${tk.completadas} completadas`] }
          return (
            <div
              key={p.key}
              className={`pcard ${p.side}${hot === p.key ? ' is-hot' : ''}`}
              // las tarjetas reaparecen una a una, cuando su planeta ya esta en su sitio
              style={{ transitionDelay: shown ? `${i * 110}ms` : '0ms' }}
              ref={(el) => void (cards.current[i] = el)}
            >
              <button
                className="card"
                style={{ '--k': p.dy, '--ico': p.iconBg } as CSSProperties}
                aria-label={`${d.title}: ${d.lines.join(', ')}`}
                tabIndex={shown ? 0 : -1}
                onClick={() => open(p.key)}
                onPointerEnter={() => shown && setHot(p.key)}
                onPointerLeave={() => setHot(null)}
                onFocus={() => setHot(p.key)}
                onBlur={() => setHot(null)}
              >
                <span className="ico">
                  <Icon name={p.icon} size={17} />
                </span>
                <span className="card-head">
                  <span className="card-title">{d.title}</span>
                  <Icon name="arrow" size={17} />
                </span>
                {d.lines.map((l) => (
                  <span key={l} className="card-line">
                    {l}
                  </span>
                ))}
              </button>
            </div>
          )
        })}
        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>
    </main>
  )
}
