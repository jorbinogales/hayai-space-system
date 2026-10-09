// Pestaña Campañas: SOLO LECTURA de Meta Ads (gasto, leads y costo por lead). Nada aquí crea, edita ni pausa campañas.
import { useState } from 'react'
import { useLoaded } from './hubData'
import { mk } from './mkData'
import { money } from './store'

const ESTADO: Record<string, string> = { ACTIVE: 'Activa', PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada', CAMPAIGN_PAUSED: 'Pausada', ADSET_PAUSED: 'Pausada', IN_PROCESS: 'En proceso', WITH_ISSUES: 'Con problemas', PENDING_REVIEW: 'En revisión', DISAPPROVED: 'Rechazada' }
const estado = (s: string) => ESTADO[s] ?? s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
const num = (n: number) => n.toLocaleString('es-VE')

export default function Campanas() {
  const [cuenta, setCuenta] = useState('')
  const r = useLoaded(() => mk.campanas(30, cuenta || undefined), [cuenta])
  const d = r.data
  const t = d?.totales
  const moneda = t?.moneda ?? d?.cuentas[0]?.moneda ?? 'USD'
  const fmt = (n: number) => (moneda === 'USD' ? money(n) : `${n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda}`)

  return (
    <section className="hb-block" aria-labelledby="cm-h" aria-busy={!d && !r.error}>
      <header className="hb-bh">
        <h2 id="cm-h">Campañas · 30 días</h2>
        <span className="hb-aside">Solo lectura</span>
      </header>

      {r.error && (
        <div className="hb-alert" role="alert">
          <p>
            No pudimos cargar las campañas. <small>{r.error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={r.reload}>
            Reintentar
          </button>
        </div>
      )}
      {!d && !r.error && <div className="hb-skel" aria-hidden="true"><i /><i /></div>}

      {d && !d.conectado && (
        <div className="mk-pend is-big">
          <span className="hb-pill is-idle">Pendiente de conexión</span>
          <p>{d.motivo ?? 'Meta Ads no está conectado en el servidor.'}</p>
        </div>
      )}

      {d?.conectado && d.error && (
        <div className="hb-alert" role="alert">
          <p>
            Meta no respondió. <small>{d.error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={r.reload}>
            Reintentar
          </button>
        </div>
      )}

      {d?.conectado && !d.error && (
        <>
          {(d.cuentas.length > 1 || cuenta) && (
            <label className="mk-acct">
              <span>Cuenta publicitaria</span>
              <select className="mk-sel" value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
                <option value="">Todas</option>
                {(d.cuentas.length > 1 ? d.cuentas : [{ id: cuenta, nombre: cuenta, moneda }]).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
          )}
          {t ? (
            <dl className="mk-meta mk-cards">
              <div>
                <dt>Gasto</dt>
                <dd>{fmt(t.gasto)}</dd>
              </div>
              <div>
                <dt>Leads</dt>
                <dd>{num(t.leads)}</dd>
              </div>
              <div>
                <dt>Costo por lead</dt>
                <dd>{t.cpl === null ? '—' : fmt(t.cpl)}</dd>
              </div>
            </dl>
          ) : (
            <p className="hb-note">Las cuentas están en monedas distintas: elige una para ver sus totales.</p>
          )}
          {d.campanas.length === 0 ? (
            <p className="hb-empty">Esta cuenta no tiene campañas.</p>
          ) : (
            <div className="mk-scroll">
              <table className="mk-table mk-camp">
                <thead>
                  <tr>
                    <th scope="col">Campaña</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className="mk-r">Gasto</th>
                    <th scope="col" className="mk-r">Leads</th>
                    <th scope="col" className="mk-r">CPL</th>
                  </tr>
                </thead>
                <tbody>
                  {d.campanas.map((c) => (
                    <tr key={`${c.cuenta_id}-${c.id}`}>
                      <th scope="row">{c.nombre}</th>
                      <td>
                        <span className={`hb-pill ${c.estado === 'ACTIVE' ? 'is-cumplido' : 'is-idle'}`}>{estado(c.estado)}</span>
                      </td>
                      <td className="mk-r mk-num">{fmt(c.gasto)}</td>
                      <td className="mk-r mk-num">{num(c.leads)}</td>
                      <td className="mk-r mk-num">{c.cpl === null ? '—' : fmt(c.cpl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hb-note">Solo lectura: desde Space no se crean, editan ni pausan campañas.</p>
        </>
      )}
    </section>
  )
}
