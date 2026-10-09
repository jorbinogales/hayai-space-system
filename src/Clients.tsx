import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { clientsBar, toScreen } from './scene'
import type { World } from './world'
import { useCosmos } from './Cosmos'
import CalendarModal from './CalendarModal'
import Invoice, { type InvoiceData } from './Invoice'
import { useDragScroll } from './drag'
import { addDays, avatarOf, convertClient, moveLabel, stats, summary, useAllClients, useClients, money, fmtDate, todayISO, type Client } from './store'
import NewClient from './NewClient'
import DayTrack, { dayItems } from './DayTrack'
import { nextActionOf } from './nextAction'
import { owedCount, owedTotal } from './finance'
import NewProspect from './NewProspect'
import EditClient from './EditClient'
import { useProjects } from './projectData'
import { useTasks } from './taskData'
import History from './History'
import { Blobvatar } from './blob'
import { Icon, ZoomControls } from './ui'
import { reduced, useDive } from './warp'
import { go, hashClientId } from './nav'
import { loadStages, useLoaded } from './hubData'
import { FlatFrame, OrbitalView, PipelineView, ViewSwitch, useViewMode, type Lead } from './orbital'

const ANCHOR_LON = -0.5 // longitud (rad) de la posicion destacada, a la izquierda del meridiano central
const LATS = [0.12, 0.5, 0.22, -0.4, 0.42, -0.04, -0.52, 0.28, -0.26]
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

interface Bridge {
  nodes: (HTMLElement | null)[]
  link: SVGPathElement | null
  overlay: HTMLElement | null
  panel: HTMLElement | null
  bar: HTMLElement | null
  sum: HTMLElement | null
  clients: Client[]
  drawer: boolean
  selected: string | null
  shown: string
  setAuto: (id: string) => void
  /** arrastre del planeta con el raton */
  dragging: boolean
  vel: number
}

/** Logica por frame de la pantalla Clientes: nodos pegados al planeta, card junto al cliente, conector y giro. */
function makeHook(world: World, br: Bridge) {
  // posicion de cada cliente en la esfera segun su indice (los nuevos siguen la espiral, sin recalcular los anteriores)
  const cache: THREE.Vector3[] = []
  const localOf = (i: number, R: number) => {
    if (!cache[i]) {
      const lon = i * 0.42
      const la = Math.max(-0.9, Math.min(0.9, LATS[i % LATS.length] + Math.floor(lon / (Math.PI * 2)) * 0.22))
      cache[i] = new THREE.Vector3(Math.cos(la) * Math.sin(lon), Math.sin(la), Math.cos(la) * Math.cos(lon)).multiplyScalar(R * 1.002)
    }
    return cache[i]
  }
  let side: 'left' | 'right' = 'left'
  let px = 0
  let py = 0
  let placed = false
  let lastY = 0
  let lastAuto = ''
  const wp = new THREE.Vector3()
  const n = new THREE.Vector3()
  const c = new THREE.Vector3()
  const v = new THREE.Vector3()

  return {
    resize() {
      const barH = br.bar?.offsetHeight ?? clientsBar.px
      clientsBar.px = barH
      br.overlay?.style.setProperty('--bar', `${barH + 30}px`)
    },
    update(dt: number) {
      const it = world.item('clientes')
      const ctx = world.ctx
      if (!it || !ctx || !br.overlay) return
      const { camera } = ctx
      const R = it.p.r
      it.pivot.getWorldPosition(c)

      const overlay = br.overlay.getBoundingClientRect()
      let best = -1
      let bestD = Infinity
      let shownPt: { x: number; y: number; vis: number } | null = null
      let selLon = 0
      let any = false

      br.clients.forEach((cl, i) => {
        wp.copy(localOf(i, R))
        it.body.localToWorld(wp)
        n.copy(wp).sub(c).normalize()
        v.copy(camera.position).sub(wp).normalize()
        const facing = n.dot(v)
        const vis = Math.min(1, Math.max(0, (facing - 0.02) / 0.2))
        const lon = Math.atan2(wp.x - c.x, wp.z - c.z)
        if (facing > 0.15 && Math.abs(wrap(lon - ANCHOR_LON)) < bestD) {
          bestD = Math.abs(wrap(lon - ANCHOR_LON))
          best = i
        }
        if (cl.id === br.selected) selLon = lon
        if (vis > 0.05) any = true
        const pt = toScreen(wp, camera, ctx.w, ctx.h)
        const el = br.nodes[i]
        if (el) {
          el.style.transform = `translate3d(${pt.x - 14}px,${pt.y - 14}px,0)`
          el.style.opacity = String(vis)
          el.style.visibility = vis > 0.02 ? 'visible' : 'hidden'
        }
        if (cl.id === br.shown) shownPt = { ...pt, vis }
      })

      if (best >= 0 && br.clients[best].id !== lastAuto) {
        lastAuto = br.clients[best].id
        br.setAuto(lastAuto)
      }

      // la card se coloca junto al cliente mostrado: a un lado u otro del planeta, a su altura
      const sp = shownPt as { x: number; y: number; vis: number } | null
      if (br.panel && ctx.w >= 600) {
        const pw = br.panel.offsetWidth
        const ph = br.panel.offsetHeight
        const cs = toScreen(c, camera, ctx.w, ctx.h)
        const rpx = toScreen(v.set(c.x + R * it.anchor.scale.x, c.y, c.z), camera, ctx.w, ctx.h).x - cs.x
        if (sp && sp.vis > 0.3) {
          if (sp.x < cs.x - rpx * 0.08) side = 'left'
          else if (sp.x > cs.x + rpx * 0.08) side = 'right'
          lastY = sp.y
        }
        const tx = Math.min(ctx.w - 86 - pw, Math.max(16, side === 'left' ? cs.x - rpx - 28 - pw : cs.x + rpx + 28))
        const top = side === 'left' && br.sum ? br.sum.getBoundingClientRect().bottom - overlay.top + 14 : 92
        const bottom = (br.bar?.getBoundingClientRect().top ?? ctx.h) - overlay.top - 12 - ph
        const ty = Math.min(Math.max(top, bottom), Math.max(top, lastY - ph * 0.2))
        const k = placed ? 1 - Math.exp(-dt * (ctx.motion < 1 ? 60 : 12)) : 1
        px += (tx - px) * k
        py += (ty - py) * k
        placed = true
        br.panel.style.transform = `translate3d(${px}px,${py}px,0)`
      } else if (br.panel) {
        br.panel.style.transform = ''
        placed = false
      }

      // conector curvo panel -> nodo
      if (br.link && br.panel) {
        const pr = br.panel.getBoundingClientRect()
        if (sp && sp.vis > 0.3 && !br.drawer) {
          if (ctx.w < 600) {
            // movil: el panel va abajo, la curva sale de su borde superior
            const x0 = pr.left + pr.width / 2 - overlay.left
            const y0 = pr.top - overlay.top
            const dy = y0 - sp.y
            br.link.setAttribute('d', `M${x0},${y0} C${x0},${y0 - dy * 0.5} ${sp.x},${sp.y + dy * 0.4} ${sp.x},${sp.y}`)
          } else {
            const x0 = (side === 'left' ? pr.right : pr.left) - overlay.left
            const y0 = pr.top + pr.height * 0.2 - overlay.top
            const dx = sp.x - x0
            br.link.setAttribute('d', `M${x0},${y0} C${x0 + dx * 0.5},${y0} ${sp.x - dx * 0.35},${sp.y} ${sp.x},${sp.y}`)
          }
          br.link.style.opacity = String(sp.vis)
        } else br.link.style.opacity = '0'
      }

      // giro: automatico, con el planeta en manos del usuario (arrastre + inercia), o llevando el nodo elegido a la posicion destacada
      if (!br.dragging) {
        it.body.rotation.y += br.vel * dt
        br.vel *= Math.exp(-dt * 2.5)
        if (br.selected) it.body.rotation.y += wrap(ANCHOR_LON - selLon) * (1 - Math.exp(-dt * (ctx.motion < 1 ? 40 : 3)))
      }
      world.screenRate = br.dragging || br.selected || Math.abs(br.vel) > 0.05 ? 0 : any ? 0.06 : 0.3
    },
  }
}

export default function Clients({ onBack }: { onBack: () => void }) {
  const { world, setDeep } = useCosmos()
  const clients = useClients()
  const allClients = useAllClients()
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [auto, setAuto] = useState(clients[0]?.id ?? '')
  const [open, setOpen] = useState<string | null>(null) // cliente cuyo historial esta desplegado
  const [form, setForm] = useState(false)
  const [cal, setCal] = useState(false)
  const [invoice, setInvoice] = useState<InvoiceData | null>(null)
  const [prosp, setProsp] = useState(false) // alta de posible cliente
  const [edit, setEdit] = useState<string | null>(null) // cliente que se esta editando
  const projects = useProjects()
  const tasks = useTasks()
  const [exiting, setExiting] = useState(false)
  const [view, setView] = useViewMode() // planeta (3D, el de siempre) · orbital · pipeline en columnas
  const stages = useLoaded(loadStages, []) // etapas del pipeline: nombres y probabilidades siempre de la API
  const flat = view !== 'planeta'
  const [off, setOff] = useState(0) // desplazamiento (dias) de la ventana de 30 dias de la linea de tiempo
  const deep = form || cal || prosp || edit !== null
  const back = () => {
    setExiting(true) // la interfaz se desvanece y queda solo el planeta
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }
  const shown = hover ?? selected ?? auto
  // al salir de un nodo se espera un instante: si la card se mueve y tapa el nodo, no parpadea
  const leave = useRef(0)
  const hoverOn = (id: string) => {
    clearTimeout(leave.current)
    setHover(id)
  }
  const hoverOff = () => {
    clearTimeout(leave.current)
    leave.current = window.setTimeout(() => setHover(null), 160)
  }
  const br = useRef<Bridge>({ nodes: [], link: null, overlay: null, panel: null, bar: null, sum: null, clients, drawer: false, selected: null, shown: '', setAuto, dragging: false, vel: 0 })
  br.current.clients = clients
  br.current.drawer = open !== null
  br.current.selected = selected
  br.current.shown = shown

  // la logica 3D vive en el mundo compartido; esta capa solo se engancha mientras esta visible
  useEffect(() => {
    const hook = makeHook(world, br.current)
    world.screenHook = hook.update
    world.screenResize = hook.resize
    hook.resize()

    // arrastrar el planeta con el raton: gira, y al soltar sigue con inercia
    let drag: { x: number; t: number } | null = null
    world.stagePointer = (type, e) => {
      const it = world.item('clientes')
      if (!it) return
      if (type === 'down') {
        drag = { x: e.clientX, t: performance.now() }
        br.current.dragging = true
        br.current.vel = 0
      } else if (type === 'move' && drag) {
        const now = performance.now()
        const d = (e.clientX - drag.x) * 0.006
        it.body.rotation.y += d
        br.current.vel = d / Math.max(0.008, (now - drag.t) / 1000)
        drag.x = e.clientX
        drag.t = now
        if (br.current.selected && Math.abs(d) > 0.002) setSelected(null) // el planeta queda en manos del usuario
      } else if (type === 'up' && drag) {
        drag = null
        br.current.dragging = false
        br.current.vel = Math.max(-4, Math.min(4, br.current.vel))
      }
    }
    world.stageClick = () => {
      setSelected(null)
      setOpen(null)
    }
    return () => {
      world.screenHook = null
      world.screenResize = null
      world.screenRate = null
      world.stagePointer = null
      world.stageClick = null
    }
  }, [world])

  useDive(deep) // al abrir un formulario o el calendario: ráfaga de velocidad luz y entorno oculto
  useEffect(() => {
    setDeep(deep)
    return () => setDeep(false)
  }, [deep, setDeep])

  useEffect(() => {
    if (deep) return // formulario y calendario manejan su propio Escape
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSelected(null)
      setOpen(null)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [deep])

  // enlace directo: `#clientes/<id>` (desde la busqueda o un aviso) abre el cajon de ese cliente
  const known = useRef(clients)
  known.current = clients
  const wasOpen = useRef<string | null>(null)
  useEffect(() => {
    const openFromHash = () => {
      const id = hashClientId()
      if (id && known.current.some((x) => x.id === id)) {
        setSelected(id)
        setOpen(id)
      }
    }
    openFromHash()
    window.addEventListener('hashchange', openFromHash)
    window.addEventListener('hayai:open-client', openFromHash)
    return () => {
      window.removeEventListener('hashchange', openFromHash)
      window.removeEventListener('hayai:open-client', openFromHash)
    }
  }, [])
  useEffect(() => {
    // al cerrar el cajon el enlace vuelve a #clientes (asi volver a tocar el mismo aviso lo abre otra vez)
    if (wasOpen.current && !open && hashClientId()) history.replaceState(null, '', '#clientes')
    wasOpen.current = open
  }, [open])

  const track = useRef<HTMLDivElement>(null)
  useDragScroll(track, 'x') // la linea de tiempo se arrastra con el raton (y la rueda la desplaza)

  const toggle = (id: string) => {
    setSelected((s) => (s === id ? null : id))
    if (open) setOpen(id)
  }
  // click en un punto: sujeta el planeta en ese cliente y despliega su historial (otro click lo cierra)
  const pick = (id: string) => {
    if (open === id) {
      setOpen(null)
      setSelected(null)
    } else {
      setSelected(id)
      setOpen(id)
    }
  }
  // en las vistas orbital y pipeline un clic abre el cajon por enlace (#clientes/<id>), igual que desde la busqueda o un aviso; otro clic lo cierra
  const pickLink = (id: string) => (open === id ? pick(id) : go({ screen: 'clientes', clientId: id }))
  const c = clients.find((x) => x.id === shown) ?? clients[0] // sin clientes: undefined, la card y el planeta quedan vacios
  const st = c ? stats(c) : null
  const sm = summary(clients)
  const dayRows = dayItems(clients, tasks, projects, moveLabel)
  const live = dayRows.find((p) => p.clientId === shown)?.id
  const today = todayISO()
  const nextOf = (id: string) => {
    const l = clients.find((x) => x.id === id) as Lead | undefined
    return nextActionOf(id, dayRows, { text: l?.nextAction, date: l?.nextActionDate }, today)
  }

  return (
    <main className={`screen layer clients arriving${open ? ' has-drawer' : ''}${deep ? ' deep' : ''}${exiting ? ' exiting' : ''}${flat ? ' view-flat' : ''}`}>
      <div className="overlay" ref={(el) => void (br.current.overlay = el)}>
        <svg className="link" aria-hidden="true">
          <path ref={(el) => void (br.current.link = el)} fill="none" />
        </svg>

        {clients.map((cl, i) => (
          <button
            key={cl.id}
            ref={(el) => void (br.current.nodes[i] = el)}
            className={`node${shown === cl.id ? ' is-on' : ''}${cl.prospect ? ' prospect' : ''}`}
            aria-label={`${cl.name}, ${money(stats(cl).cobrado)} recaudado. Ver historial`}
            aria-pressed={open === cl.id}
            onClick={() => pick(cl.id)}
            onPointerEnter={() => hoverOn(cl.id)}
            onPointerLeave={hoverOff}
            onFocus={() => hoverOn(cl.id)}
            onBlur={hoverOff}
          >
            <span className="node-dot" />
            <span className="node-label">{cl.name}{cl.prospect ? ' · posible' : ''}</span>
          </button>
        ))}

        <div className="clients-left">
          <div className="ob-topline">
            <button className="back" onClick={back}>
              <Icon name="back" size={16} />
              Volver al core
            </button>
            <ViewSwitch view={view} onChange={setView} />
          </div>
          <h1>Clientes</h1>
          <div ref={(el) => void (br.current.sum = el)}>
            <p className="summary">
              {sm.activos} activos
              {sm.posibles > 0 && (
                <>
                  <br />
                  {sm.posibles} {sm.posibles === 1 ? 'posible' : 'posibles'}
                </>
              )}
              <br />
              {money(sm.recaudado)} recaudado
              <br />
              {money(owedTotal(allClients))} por cobrar
              <br />
              {owedCount(allClients)} {owedCount(allClients) === 1 ? 'cobro pendiente' : 'cobros pendientes'}
            </p>
            <div className="new-row-btns">
              <button className="new" onClick={() => setForm(true)}>
                <Icon name="plus" size={16} />
                Nuevo cliente
              </button>
              <button className="new alt" onClick={() => setProsp(true)}>
                <Icon name="plus" size={16} />
                Posible cliente
              </button>
            </div>
          </div>
        </div>

        <aside className="cpanel" ref={(el) => void (br.current.panel = el)} hidden={!c}>
          {c && st && (
          <div key={c.id} className="cpanel-in">
            <span className="live-dot" aria-hidden="true" />
            <div className="cp-head">
              <Blobvatar seed={avatarOf(c)} size={34} />
              <h2>{c.name}</h2>
            </div>
            {c.prospect ? (
              <>
                <p className="lbl">Posible cliente</p>
                <p className="amt small">{projects.find((p) => p.clientId === c.id)?.name ?? 'Sin proyecto'}</p>
              </>
            ) : (
              <>
                <p className="lbl">Total recaudado</p>
                <p className="amt">{money(st.cobrado)}</p>
              </>
            )}
            <div className="cpanel-foot">
              <ul>
                {c.prospect ? (
                  (() => {
                    const pr = projects.find((p) => p.clientId === c.id)
                    const v = tasks.find((t) => t.projectId === pr?.id && !t.done && t.due)
                    const stage = stages.data?.find((x) => x.etapa === (c as Lead).stage)
                    return (
                      <>
                        <li>{stage?.nombre ?? 'Posible cliente'}</li>
                        <li>{v?.due ? `Visita el ${fmtDate(v.due)}` : 'Visita sin fecha'}</li>
                      </>
                    )
                  })()
                ) : (
                  <>
                    <li>
                      {c.items.length} {c.items.length === 1 ? 'ítem' : 'ítems'}
                    </li>
                    <li>
                      {st.pagos} {st.pagos === 1 ? 'pago completado' : 'pagos completados'}
                    </li>
                    <li>
                      {st.porCobrar} {st.porCobrar === 1 ? 'cobro pendiente' : 'cobros pendientes'}
                    </li>
                  </>
                )}
              </ul>
              <button className="go edit" aria-label={`Editar ${c.name}`} title="Editar" onClick={() => setEdit(c.id)}>
                <Icon name="edit" size={16} />
              </button>
              <button
                className="go"
                aria-label={`Ver historial de ${c.name}`}
                onClick={() => {
                  setSelected(c.id)
                  setOpen(c.id)
                }}
              >
                <Icon name="arrow" size={18} />
              </button>
            </div>
          </div>
          )}
        </aside>

        {clients.length === 0 && (
          <div className="empty-hint">
            <p>Aún no hay clientes.</p>
            <button className="new" onClick={() => setForm(true)}>
              <Icon name="plus" size={16} />
              Registrar el primero
            </button>
          </div>
        )}

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />

        <section className="timeline" ref={(el) => void (br.current.bar = el)} aria-labelledby="tl-title">
          <header>
            <h2 id="tl-title">
              Próximos pagos <Icon name="arrow" size={18} />
            </h2>
            <div className="tl-tools">
              <button className="tl-nav" aria-label="Retroceder 7 días" onClick={() => setOff((o) => o - 7)}>
                <Icon name="back" size={16} />
              </button>
              <button className="tl-today" onClick={() => setOff(0)} disabled={off === 0}>
                Hoy
              </button>
              <button className="tl-nav next" aria-label="Avanzar 7 días" onClick={() => setOff((o) => o + 7)}>
                <Icon name="back" size={16} />
              </button>
              <button className="pill" onClick={() => setCal(true)}>
                <Icon name="calendar" size={15} />
                Ver calendario
              </button>
            </div>
          </header>
          <div className="track-scroll" ref={track}>
            <DayTrack items={dayRows} clients={clients} start={addDays(today, off)} selected={selected} live={live} onPick={toggle} onInvoice={setInvoice} />
          </div>
        </section>

        {flat && (
          <FlatFrame
            view={view}
            onView={setView}
            onBack={back}
            onNew={() => setForm(true)}
            onProspect={() => setProsp(true)}
            eyebrow={view === 'orbital' ? 'PLANETA VENTAS · VISTA ORBITAL' : 'PLANETA VENTAS · PIPELINE'}
            title={view === 'orbital' ? 'Quién está cerca de cerrar' : 'El camino de cada posible cliente'}
          >
            {view === 'orbital' ? (
              <OrbitalView clients={clients as Lead[]} stages={stages} openId={open} onPick={pickLink} onSwitch={setView} onProspect={() => setProsp(true)} nextOf={nextOf} />
            ) : (
              <PipelineView clients={clients as Lead[]} stages={stages} openId={open} onPick={pickLink} nextOf={nextOf} />
            )}
          </FlatFrame>
        )}

        <History
          client={clients.find((x) => x.id === open) ?? null}
          onEdit={setEdit}
          onConvert={(id) => void convertClient(id)}
          project={projects.find((p) => p.clientId === open) ?? null}
          next={open ? nextOf(open) : null}
          visit={(() => {
            const pr = projects.find((p) => p.clientId === open)
            return tasks.find((t) => t.projectId === pr?.id && !t.done && t.due) ?? tasks.find((t) => t.projectId === pr?.id) ?? null
          })()}
          onClose={() => {
            setOpen(null)
            setSelected(null)
          }}
        />
      </div>

      {form && (
        <NewClient
          onClose={() => setForm(false)}
          onCreate={(n) => {
            setForm(false)
            setHover(null)
            setSelected(n.id)
            setOpen(n.id)
          }}
        />
      )}
      {prosp && (
        <NewProspect
          onClose={() => setProsp(false)}
          onCreate={(n) => {
            setProsp(false)
            setHover(null)
            setSelected(n.id)
            setOpen(n.id)
          }}
        />
      )}
      {edit && <EditClient clientId={edit} onClose={() => setEdit(null)} />}
      {cal && <CalendarModal onClose={() => setCal(false)} />}
      {invoice && <Invoice data={invoice} onClose={() => setInvoice(null)} />}
    </main>
  )
}
