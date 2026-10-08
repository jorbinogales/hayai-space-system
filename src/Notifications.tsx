import { useEffect, useRef, useState } from 'react'
import { Blobvatar } from './blob'
import { ALERT_BACKED, dismissToast, markActivitySeen, markAlerts, settleSeen, unreadTotal, useLive, type Activity, type Alert } from './live'
import { go } from './nav'
import { openFeed, type FeedTipo } from './feedData'
import { ago } from './time'
import { openChangelog } from './updates'
import { Icon } from './ui'

/** "Leandro añadió…" con el nombre del socio en negrita (el servidor siempre empieza el texto por el nombre). */
function Said({ e }: { e: Activity }) {
  const n = e.actor.nombre
  return e.texto.startsWith(n) ? (
    <>
      <b>{n}</b>
      {e.texto.slice(n.length)}
    </>
  ) : (
    <>{e.texto}</>
  )
}

const openActivity = (e: Activity) =>
  e.tipo === 'version_nueva'
    ? openChangelog(e.sujeto)
    : e.tipo === 'feed_nuevo'
      ? openFeed({ filters: { estado: 'nuevo', ...(e.detalle ? { tipo: e.detalle as FeedTipo } : {}) } })
      : e.tipo === 'tarea_nueva' || e.tipo === 'tarea_completada'
        ? go({ screen: 'tareas' })
        : go({ screen: 'clientes', clientId: e.cliente_id })

const openAlert = (a: Alert) =>
  a.tipo === 'actualizacion'
    ? openChangelog(a.version ?? null)
    : a.tipo === 'feed'
      ? // uno solo: su tarjeta; varios del mismo origen: el feed filtrado por ese tipo y esa fuente
        openFeed(a.feed?.item_id ? { itemId: a.feed.item_id } : { filters: { estado: 'nuevo', tipo: a.feed?.tipo as FeedTipo, fuente: a.feed?.fuente } })
      : go({ screen: 'clientes', clientId: a.cliente_id })

const ALERT_ICON = { cuota_vencida: 'wallet', seguimiento: 'calendar', actualizacion: 'code', feed: 'radar' } as const

type Tab = 'alertas' | 'equipo'

/** Campana de la barra superior: alertas (cuotas vencidas, seguimientos) y lo que hace el equipo. Los popups laterales viven aqui también. */
export function Notifications() {
  const live = useLive()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('alertas')
  const wrap = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const total = unreadTotal(live)
  // La pestaña Equipo es lo que HICIERON los demás; la versión nueva y el feed ya tienen su alerta en la otra pestaña.
  const team = live.activity.filter((e) => !ALERT_BACKED.includes(e.tipo))

  const close = () => {
    setOpen(false)
    settleSeen()
    if (live.activityUnread) void markActivitySeen().catch(() => {})
    bell.current?.focus()
  }
  const toggle = () => {
    if (open) return close()
    // Se abre donde hay algo nuevo: si solo hay novedades del equipo, ahi.
    const next: Tab = live.alertsUnread === 0 && live.activityUnread > 0 ? 'equipo' : tab
    setTab(next)
    setOpen(true)
    if (next === 'equipo') void markActivitySeen().catch(() => {})
  }
  const pick = (t: Tab) => {
    setTab(t)
    if (t === 'equipo') void markActivitySeen().catch(() => {})
  }

  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', out)
    window.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', esc, true)
    }
  })

  return (
    <>
      <div className="notif" ref={wrap}>
        <button ref={bell} className="round" aria-label={total ? `Notificaciones, ${total} sin leer` : 'Notificaciones'} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          <Icon name="bell" />
          {total > 0 && (
            <span className="badge count" aria-hidden="true">
              {total > 99 ? '99+' : total}
            </span>
          )}
        </button>
        {open && (
          <section className="notif-panel" role="dialog" aria-label="Notificaciones">
            <div className="notif-tabs" role="tablist">
              <button role="tab" id="nt-alertas" aria-selected={tab === 'alertas'} aria-controls="np-alertas" onClick={() => pick('alertas')}>
                Alertas{live.alertsUnread > 0 && <i>{live.alertsUnread}</i>}
              </button>
              <button role="tab" id="nt-equipo" aria-selected={tab === 'equipo'} aria-controls="np-equipo" onClick={() => pick('equipo')}>
                Equipo{live.activityUnread > 0 && <i>{live.activityUnread}</i>}
              </button>
            </div>
            {tab === 'alertas' ? (
              <div role="tabpanel" id="np-alertas" aria-labelledby="nt-alertas" className="notif-list">
                {live.alerts.length === 0 ? (
                  <p className="notif-empty">
                    <b>Todo en orden, astronauta.</b>
                    Ninguna cuota vencida ni seguimiento pendiente.
                  </p>
                ) : (
                  <>
                    {live.alertsUnread > 0 && (
                      <button className="notif-all" onClick={() => void markAlerts('todas').catch(() => {})}>
                        Marcar todo como leído
                      </button>
                    )}
                    <ul>
                      {live.alerts.map((a) => (
                        <li key={a.clave}>
                          <button
                            className={`notif-item${a.leida ? '' : ' is-new'}`}
                            onClick={() => {
                              if (!a.leida) void markAlerts([a.clave]).catch(() => {})
                              setOpen(false)
                              openAlert(a)
                            }}
                          >
                            <span className={`notif-ico ${a.tipo}`} aria-hidden="true">
                              <Icon name={ALERT_ICON[a.tipo]} size={16} />
                            </span>
                            <span className="notif-body">
                              <span className="notif-text">{a.titulo}</span>
                              <small>{a.detalle}</small>
                            </span>
                            {!a.leida && <span className="notif-dot" aria-label="Sin leer" />}
                          </button>
                          {a.tipo === 'actualizacion' && (
                            <button
                              className="notif-cta"
                              onClick={() => {
                                if (!a.leida) void markAlerts([a.clave]).catch(() => {})
                                setOpen(false)
                                openAlert(a)
                              }}
                            >
                              Ver cambios
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <div role="tabpanel" id="np-equipo" aria-labelledby="nt-equipo" className="notif-list">
                {team.length === 0 ? (
                  <p className="notif-empty">
                    <b>Aún no hay movimientos del equipo.</b>
                    Aquí verás cuando alguien añada un cliente o una tarea, o la complete.
                  </p>
                ) : (
                  <ul>
                    {team.map((e) => (
                      <li key={e.id}>
                        <button
                          className={`notif-item${!e.propia && e.id > live.seenUpTo ? ' is-new' : ''}`}
                          onClick={() => {
                            setOpen(false)
                            openActivity(e)
                          }}
                        >
                          <span className="notif-av" aria-hidden="true">
                            <Blobvatar seed={e.actor.avatar} size={30} />
                          </span>
                          <span className="notif-body">
                            <span className="notif-text">
                              <Said e={e} />
                            </span>
                            <small>{ago(e.fecha)}</small>
                          </span>
                          {!e.propia && e.id > live.seenUpTo && <span className="notif-dot" aria-label="Nuevo" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!live.online && <p className="notif-off">Reconectando con la nave…</p>}
          </section>
        )}
      </div>
      <Toasts hidden={open} />
    </>
  )
}

const TOAST_MS = 6000

function ToastItem({ t }: { t: { key: number; event: Activity } }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const id = window.setTimeout(() => dismissToast(t.key), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [paused, t.key])
  const e = t.event
  return (
    <div className="toast" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <button
        className="toast-main"
        onClick={() => {
          dismissToast(t.key)
          openActivity(e)
        }}
      >
        <span className="notif-av" aria-hidden="true">
          <Blobvatar seed={e.actor.avatar} size={34} />
        </span>
        <span className="notif-body">
          <span className="notif-text">
            <Said e={e} />
          </span>
          <small>ahora</small>
        </span>
      </button>
      <button className="toast-x" aria-label="Cerrar aviso" onClick={() => dismissToast(t.key)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

/** Popups laterales: aparecen cuando OTRO socio hace algo mientras estás en el sistema. Máximo 3, 6 s, se pausan con el cursor. */
function Toasts({ hidden }: { hidden: boolean }) {
  const { toasts } = useLive()
  return (
    <div className="toasts" role="status" aria-live="polite" aria-atomic="false" hidden={hidden}>
      {toasts.map((t) => (
        <ToastItem key={t.key} t={t} />
      ))}
    </div>
  )
}
