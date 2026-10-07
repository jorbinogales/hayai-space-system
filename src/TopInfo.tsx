// Bloque de la derecha de la barra superior: fecha / versión / tasa BCV con su fecha (la hora ya no va).
// La tasa la consulta el servidor (nunca el navegador) y se guarda: sin red se sigue mostrando la última, siempre con su día.
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { openChangelog, useUpdates } from './updates'

interface Info {
  version: string
  hoy: string
  bcv: { tasa: number; fecha: string; es_de_hoy: boolean; fuente: string; actualizada_el: string } | null
}

const REFRESH_MS = 10 * 60_000
const STALE_DAYS = 3

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const dayLabel = (iso: string, hoy: string) => {
  const d = new Date(`${iso}T12:00:00`)
  const short = d.toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace('.', '')
  return iso === hoy ? short : `${d.toLocaleDateString('es', { weekday: 'short' }).replace('.', '')} ${short}`
}
const bs = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function useInfo(): Info | null {
  const [info, setInfo] = useState<Info | null>(null)
  const { latest } = useUpdates()
  const load = () =>
    api
      .get<Info>('/version')
      .then(setInfo)
      .catch(() => {}) // sin red: se queda lo último que se vio
  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), REFRESH_MS)
    const vis = () => !document.hidden && void load()
    document.addEventListener('visibilitychange', vis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [])
  // una versión nueva publicada: la barra la refleja al recargar, no antes; aquí solo se refresca la tasa/versión del servidor
  useEffect(() => {
    if (latest) void load()
  }, [latest])
  return info
}

export function ClockBlock() {
  const info = useInfo()
  const { running } = useUpdates() // la versión de ESTA pestaña: cambia al recargar, no cuando el servidor publica
  const [now, setNow] = useState(() => new Date())
  const [tip, setTip] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (!tip) return
    const out = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setTip(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setTip(false)
    document.addEventListener('pointerdown', out)
    window.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', esc)
    }
  }, [tip])

  const weekday = now.toLocaleDateString('es', { weekday: 'short' }).replace('.', '')
  const date = now.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '')
  const b = info?.bcv ?? null
  const stale = b && info ? days(b.fecha, info.hoy) > STALE_DAYS : false
  return (
    <div className="clock" ref={wrap}>
      <time dateTime={now.toISOString()}>
        <span className="cap">{weekday}</span> {date}
      </time>
      <button type="button" className="clock-ver" onClick={() => openChangelog()} aria-label={running ?? info?.version ? `Versión ${running ?? info?.version}. Abrir el historial de versiones` : 'Historial de versiones'}>
        {running ?? info?.version ? `v${running ?? info?.version}` : 'v—'}
      </button>
      <button type="button" className={`clock-bcv${stale ? ' is-stale' : ''}`} aria-expanded={tip} onClick={() => setTip((t) => !t)}>
        {b && info ? `BCV Bs. ${bs(b.tasa)} · ${dayLabel(b.fecha, info.hoy)}` : 'BCV Bs. —'}
      </button>
      {tip && (
        <div className="clock-tip" role="dialog" aria-label="Tasa BCV">
          {b ? (
            <>
              <b>Tasa oficial del BCV</b>
              <span>
                Bs. {bs(b.tasa)} por dólar, del {dayLabel(b.fecha, info!.hoy)}.{!b.es_de_hoy && ' Es la última publicada.'}
              </span>
              <small>
                Fuente: {b.fuente}. Actualizada {new Date(b.actualizada_el).toLocaleString('es', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.
              </small>
              {stale && <small className="warn">Tiene más de {STALE_DAYS} días: la fuente no responde.</small>}
            </>
          ) : (
            <>
              <b>Sin tasa todavía</b>
              <span>El servidor aún no pudo consultar la fuente. Se reintenta solo.</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
