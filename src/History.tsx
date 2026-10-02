import { useRef } from 'react'
import { useDragScroll } from './drag'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import { avatarOf, fmtDate, money, moveLabel, stats, todayISO, type Client } from './store'

/** Cajon lateral con el historico de movimientos del cliente (inicial desglosada + cobros y pagos por fecha). */
export default function History({ client, onClose }: { client: Client | null; onClose: () => void }) {
  // se conserva el ultimo cliente para que el cajon se cierre con animacion sin vaciarse
  const last = useRef<Client | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useDragScroll(scroll, 'y', [client?.id]) // rueda o mantener pulsado y arrastrar
  if (client) last.current = client
  const c = last.current
  const today = todayISO()
  const st = c && stats(c)
  const list = c ? [...c.movements].sort((a, b) => b.date.localeCompare(a.date)) : []
  const initial = c ? c.items.reduce((s, i) => s + i.amount, 0) : 0

  return (
    <aside className={`history${client ? ' is-open' : ''}`} aria-label={c ? `Historial de ${c.name}` : 'Historial'} aria-hidden={!client}>
      {c && st && (
        <>
          <header>
            <span className="av">
              <Blobvatar seed={avatarOf(c)} size={44} />
            </span>
            <div>
              <p className="eyebrow">Historial de movimientos</p>
              <h2>{c.name}</h2>
            </div>
            <button className="x" onClick={onClose} aria-label="Cerrar historial">
              <Icon name="close" size={18} />
            </button>
          </header>

          <dl className="totals">
            <div>
              <dt>Cobrado</dt>
              <dd className="ok">{money(st.cobrado)}</dd>
            </div>
            <div>
              <dt>Pendiente</dt>
              <dd>{money(st.pendiente)}</dd>
            </div>
          </dl>

          <div className="h-scroll" ref={scroll}>
            {c.items.length > 0 && (
              <section>
                <h3>Inicial</h3>
                <ul className="items">
                  {c.items.map((i) => (
                    <li key={i.id}>
                      <span>{i.concept}</span>
                      <span>{money(i.amount)}</span>
                    </li>
                  ))}
                  <li className="sum">
                    <span>Total inicial</span>
                    <span>{money(initial)}</span>
                  </li>
                </ul>
              </section>
            )}

            <section>
              <h3>Movimientos</h3>
              {list.length === 0 ? (
                <p className="none">Aún no hay movimientos.</p>
              ) : (
                <ol className="moves">
                  {list.map((m) => {
                    const late = m.status === 'pendiente' && m.date < today
                    return (
                      <li key={m.id} className={m.status === 'cobrado' ? 'done' : late ? 'late' : 'due'}>
                        <i aria-hidden="true" />
                        <div>
                          <p className="m-concept">{moveLabel(m)}</p>
                          <p className="m-date">{fmtDate(m.date, true)}</p>
                        </div>
                        <div className="m-right">
                          <p className="m-amt">{money(m.amount)}</p>
                          <p className="m-state">{m.status === 'cobrado' ? 'Cobrado' : late ? 'Vencido' : 'Por cobrar'}</p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          </div>
        </>
      )}
    </aside>
  )
}
