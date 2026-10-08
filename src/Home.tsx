import { useEffect, useRef, type CSSProperties } from 'react'
import * as THREE from 'three'
import { toScreen } from './scene'
import { money, summary, useAllClients, useClients } from './store'
import { projectCounts, useProjects } from './projectData'
import { useExpenses } from './expenseData'
import { owedTotal, yearFinance } from './finance'
import { taskCounts, useTasks } from './taskData'
import { Icon, ZoomControls } from './ui'
import type { Screen } from './App'
import { loadFunnel, loadHub, useLoaded } from './hubData'
import { CORE_R, PLANETS, type PlanetKey } from './world'
import { useCosmos } from './Cosmos'
import { setInternal } from './nav'
import './hub.css'

/** Líneas de la tarjeta de Marketing, del embudo de los últimos 90 días (mientras carga, un texto neutro). */
function marketingLines(f: ReturnType<typeof loadFunnel> extends Promise<infer T> ? T | null : never): string[] {
  if (!f) return ['Embudo comercial', 'Últimos 90 días']
  const abiertos = f.etapas.reduce((a, e) => a + e.posibles, 0)
  const ponderado = f.etapas.reduce((a, e) => a + e.valor_ponderado, 0)
  return [`${abiertos} ${abiertos === 1 ? 'posible abierto' : 'posibles abiertos'}`, `${money(ponderado)} ponderado`, f.cierres.tasa_cierre == null ? 'Sin cierres aún' : `${f.cierres.tasa_cierre.toLocaleString('es-VE', { maximumFractionDigits: 1 })} % de cierre`]
}

/** Capa HTML del Home: tarjetas de cada planeta + marca del nucleo, que siguen a los objetos 3D. Solo se ve con `shown`. */
export default function Home({ shown, onOpen }: { shown: boolean; onOpen: (s: Screen) => void }) {
  const { world, hot, setHot } = useCosmos()
  const cards = useRef<(HTMLElement | null)[]>([])
  const mark = useRef<HTMLButtonElement | null>(null)
  const coreCard = useRef<HTMLDivElement | null>(null)
  const sm = summary(useClients())
  const pc = projectCounts(useProjects())
  const expenses = useExpenses()
  const funnel = useLoaded(() => loadFunnel(90), []).data
  const hubData = useLoaded(loadHub, []).data
  const tk = taskCounts(useTasks())
  const allClients = useAllClients()
  const fin = yearFinance(allClients, expenses)
  const porCobrar = owedTotal(allClients)

  useEffect(() => {
    const v = new THREE.Vector3()
    const lastR: number[] = []
    let lastCoreR = -1
    let lastCoreCard = -1

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
      const cc = coreCard.current
      if (cc) {
        cc.style.transform = `translate3d(${c0.x}px,${c0.y}px,0)`
        if (Math.abs(coreR - lastCoreCard) > 0.4) {
          cc.style.setProperty('--r', `${coreR}px`)
          lastCoreCard = coreR
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

  // al volver al core (o entrar desde el core) no queda ningun filtro interno pegado de los atajos del Hub
  useEffect(() => {
    if (shown) setInternal(false)
  }, [shown])

  const open = (k: PlanetKey) => {
    if (!shown || false) return
    setHot(null)
    setInternal(false)
    onOpen(k)
  }

  const openHub = () => {
    if (!shown) return
    setHot(null)
    setInternal(false)
    onOpen('hub')
  }
  const coreLines = hubData
    ? [
        `${hubData.feed.nuevos} por revisar`,
        `${hubData.pulso.tareas_internas.pendientes} ${hubData.pulso.tareas_internas.pendientes === 1 ? 'tarea interna' : 'tareas internas'}`,
        `${hubData.acuerdos.por_estado.abierto} ${hubData.acuerdos.por_estado.abierto === 1 ? 'acuerdo' : 'acuerdos'}`,
      ]
    : ['Centro de HAYAI', 'Lo interno']

  return (
    <main className={`screen layer home${shown ? '' : ' warping'}`}>
      <div className="overlay">
        <div className={`pcard right core-card${hot === 'hub' ? ' is-hot' : ''}`} ref={coreCard}>
          <button
            className="card"
            style={{ '--k': -0.15, '--ico': '#16110b' } as CSSProperties}
            aria-label={`Hub central: ${coreLines.join(', ')}`}
            tabIndex={shown ? 0 : -1}
            onClick={openHub}
            onPointerEnter={() => shown && setHot('hub')}
            onPointerLeave={() => setHot(null)}
            onFocus={() => setHot('hub')}
            onBlur={() => setHot(null)}
          >
            <span className="ico">
              <Icon name="radar" size={17} />
            </span>
            <span className="card-head">
              <span className="card-title">Hub</span>
              <Icon name="arrow" size={17} />
            </span>
            {coreLines.map((l) => (
              <span key={l} className="card-line">
                {l}
              </span>
            ))}
          </button>
        </div>
        <button
          type="button"
          className={`core-mark${hot === 'hub' ? ' is-hot' : ''}`}
          ref={mark}
          aria-label="Hub central"
          title="Hub central"
          tabIndex={shown ? 0 : -1}
          onPointerEnter={() => shown && setHot('hub')}
          onPointerLeave={() => setHot(null)}
          onFocus={() => setHot('hub')}
          onBlur={() => setHot(null)}
          onClick={openHub}
        >
          HAYAI
        </button>
        {PLANETS.map((p, i) => {
          const d =
            p.key === 'clientes'
              ? { title: 'Clientes', lines: [`${sm.activos} activos`, `${money(sm.recaudado)} recaudado`, `${money(porCobrar)} por cobrar`] }
              : p.key === 'proyectos'
                ? { title: 'Proyectos', lines: [`${pc.activo} activos`, `${pc.entrega} en entrega`, `${pc.planeacion} por visitar`] }
                : p.key === 'marketing'
                  ? { title: 'Marketing', lines: marketingLines(funnel) }
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
