// «Brief del día» del Hub (v1.8.1): el resumen ejecutivo de la mañana para el socio de la sesión. Va debajo del botón del Feed.
// El servidor lo prepara una vez al día por socio (GET /api/hub/brief); si al abrir el Hub aún no existe, se redacta en ese momento y aquí
// se ve un estado de carga discreto. «Actualizar» lo vuelve a redactar (POST). Las cifras de arriba las calcula el servidor.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { money } from './store'
import { Icon, type IconName } from './ui'

type Tipo = 'cobro' | 'visita' | 'ayer' | 'pipeline' | 'tarea' | 'proyecto'
interface Punto {
  texto: string
  tipo: Tipo
  tuyo: boolean
}
interface Cuenta {
  n: number
  monto: number
}
export interface Brief {
  fecha: string
  para: string
  titular: string
  parrafo: string
  puntos: Punto[]
  cifras: { cobros_hoy: Cuenta; cobros_3_dias: Cuenta; cobros_vencidos: Cuenta; visitas: number; movimientos_ayer: number; estancados: number }
  ia: boolean
  generado_el: string
}

const TIPO: Record<Tipo, { label: string; icon: IconName }> = {
  cobro: { label: 'Cobro', icon: 'wallet' },
  visita: { label: 'Visita', icon: 'pin' },
  ayer: { label: 'Ayer', icon: 'chart' },
  pipeline: { label: 'Pipeline', icon: 'users' },
  tarea: { label: 'Tarea', icon: 'check' },
  proyecto: { label: 'Proyecto', icon: 'folder' },
}
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const fechaLarga = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit' })

export function BriefCard() {
  const [b, setB] = useState<Brief | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'cargar' | 'actualizar' | null>('cargar')
  const seq = useRef(0)

  const pedir = useCallback(async (actualizar: boolean) => {
    const mine = ++seq.current
    setBusy(actualizar ? 'actualizar' : 'cargar')
    setError('')
    try {
      const r = actualizar ? await api.post<Brief>('/hub/brief') : await api.get<Brief>('/hub/brief')
      if (mine === seq.current) setB(r)
    } catch (e) {
      if (mine === seq.current) setError(msg(e, 'No se pudo preparar el brief.'))
    } finally {
      if (mine === seq.current) setBusy(null)
    }
  }, [])
  useEffect(() => void pedir(false), [pedir])

  const c = b?.cifras
  const preparando = busy === 'cargar' && !b
  return (
    <section className="hb-brief" aria-labelledby="hb-brief-h" aria-busy={!!busy}>
      <header className="hb-brief-head">
        <div>
          <h2 id="hb-brief-h">Brief del día</h2>
          {b && <p className="hb-brief-date">{fechaLarga(b.fecha)}</p>}
        </div>
        <button type="button" className="hb-btn is-ghost" onClick={() => void pedir(true)} disabled={!!busy} aria-label="Actualizar el brief del día">
          <span className={busy === 'actualizar' ? 'hb-brief-spin' : undefined} aria-hidden="true">
            <Icon name="refresh" size={14} />
          </span>
          {busy === 'actualizar' ? 'Actualizando…' : 'Actualizar'}
        </button>
      </header>

      {preparando && (
        <div className="hb-brief-wait" role="status">
          <p>Preparando tu brief de hoy…</p>
          <div className="hb-skel" aria-hidden="true">
            <i />
            <i />
          </div>
        </div>
      )}

      {error && (
        <div className="hb-alert" role="alert">
          <p>
            {b ? 'No se pudo actualizar; ves el último brief.' : 'No se pudo preparar el brief de hoy.'} <small>{error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={() => void pedir(!!b)}>
            Reintentar
          </button>
        </div>
      )}

      {b && c && (
        <div className={`hb-brief-body${busy === 'actualizar' ? ' is-stale' : ''}`}>
          <p className="hb-brief-title">{b.titular}</p>
          {b.parrafo && <p className="hb-brief-lede">{b.parrafo}</p>}

          <ul className="hb-brief-stats" aria-label="Cifras del día">
            <li className={c.cobros_hoy.n ? 'is-hot' : ''}>
              <small>Cobros hoy</small>
              <strong>{c.cobros_hoy.n}</strong>
              <span>{money(c.cobros_hoy.monto)}</span>
            </li>
            <li>
              <small>Próximos 3 días</small>
              <strong>{c.cobros_3_dias.n}</strong>
              <span>{money(c.cobros_3_dias.monto)}</span>
            </li>
            {c.cobros_vencidos.n > 0 && (
              <li className="is-late">
                <small>Vencidos</small>
                <strong>{c.cobros_vencidos.n}</strong>
                <span>{money(c.cobros_vencidos.monto)}</span>
              </li>
            )}
            <li>
              <small>Visitas</small>
              <strong>{c.visitas}</strong>
              <span>próximos 7 días</span>
            </li>
            <li>
              <small>Ayer</small>
              <strong>{c.movimientos_ayer}</strong>
              <span>{c.movimientos_ayer === 1 ? 'movimiento' : 'movimientos'}</span>
            </li>
            <li>
              <small>Estancados</small>
              <strong>{c.estancados}</strong>
              <span>potenciales</span>
            </li>
          </ul>

          {b.puntos.length > 0 ? (
            <ol className="hb-brief-list">
              {b.puntos.map((p, i) => (
                <li key={i} className={p.tuyo ? 'is-mine' : undefined}>
                  <span className="hb-brief-ico" aria-hidden="true">
                    <Icon name={TIPO[p.tipo].icon} size={14} />
                  </span>
                  <p>
                    <span className="fd-sr">{TIPO[p.tipo].label}{p.tuyo ? ', tuyo' : ''}: </span>
                    {p.texto}
                  </p>
                  {p.tuyo && (
                    <span className="hb-brief-mine" aria-hidden="true">
                      Tuyo
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="hb-empty">Nada pendiente que destacar hoy.</p>
          )}
          <p className="hb-brief-foot">Preparado para {b.para} a las {hora(b.generado_el)}</p>
        </div>
      )}
    </section>
  )
}
