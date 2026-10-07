import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, ZoomControls } from './ui'
import { Blobvatar } from './blob'
import { useCosmos } from './Cosmos'
import { useDragScroll } from './drag'
import { money, todayISO, useAllClients } from './store'
import { useAllProjects } from './projectData'
import { useExpenses } from './expenseData'
import { isInternalExpense, setFinanceView, useFinanceView, useInternalFilter } from './nav'
import { ExpensesPanel } from './Expenses'
import { InternalChip } from './InternalChip'
import { dashboard, series, type Period } from './finance'
import { reduced } from './warp'

const NO_CLIENTS: ReturnType<typeof useAllClients> = []
const PERIODS: { key: Period; label: string }[] = [
  { key: 'mes', label: 'Este mes' },
  { key: 'anio', label: 'Este año' },
  { key: 'todo', label: 'Todo' },
]

/** Pantalla Finanzas: el planeta a un costado y un dashboard con lo recaudado por cada cliente frente a los gastos. */
export default function Finances({ onBack }: { onBack: () => void }) {
  const { world, setDeep } = useCosmos()
  // Finanzas cuenta TODO, archivado o no: archivar oculta, no borra el historial.
  const clients = useAllClients()
  const projects = useAllProjects()
  const allExpenses = useExpenses()
  // atajo interno del Hub: enfoca los gastos generales de HAYAI (sin cliente) y deja fuera lo cobrado a clientes
  const internal = useInternalFilter()
  const expenses = useMemo(() => (internal ? allExpenses.filter((x) => isInternalExpense(x, projects)) : allExpenses), [internal, allExpenses, projects])
  const [period, setPeriod] = useState<Period>('mes')
  const [exiting, setExiting] = useState(false)
  const view = useFinanceView()
  const [form, setForm] = useState(false) // formulario «Nuevo gasto» (vista Gastos)
  const scroll = useRef<HTMLDivElement>(null)
  useDragScroll(scroll, 'y')
  useEffect(() => {
    world.screenRate = null // gira a la velocidad propia del planeta
  }, [world])
  useEffect(() => {
    setDeep(form)
    return () => setDeep(false)
  }, [form, setDeep])

  const back = () => {
    setExiting(true)
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }

  // en modo interno no entra ningun cliente: todo lo que queda son gastos generales
  const shownClients = internal ? NO_CLIENTS : clients
  const d = useMemo(() => dashboard(shownClients, expenses, projects, period), [shownClients, expenses, projects, period])
  const s = useMemo(() => series(shownClients, expenses, 6), [shownClients, expenses])
  const movs = useMemo(() => {
    const t = todayISO()
    return expenses.filter((x) => period === 'todo' || x.date.startsWith(period === 'mes' ? t.slice(0, 7) : t.slice(0, 4))).length
  }, [expenses, period])
  const max = Math.max(1, ...s.flatMap((m) => [m.ingresos, m.gastos]))
  const maxRow = Math.max(1, ...d.rows.map((r) => Math.max(r.recaudado, r.gastos)))

  // grafica: barras agrupadas por mes (SVG propio, sin librerias)
  const W = 640
  const H = 190
  const pad = { l: 8, r: 8, t: 14, b: 26 }
  const bw = (W - pad.l - pad.r) / s.length
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max)

  return (
    <main className={`screen layer finances arriving${form ? ' deep' : ''}${exiting ? ' exiting' : ''}`}>
      <div className="overlay">
        <div className="clients-left">
          <button className="back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>
        </div>

        <section className="plist fin" aria-label="Finanzas">
          <header className="plist-head">
            <h1>Finanzas</h1>
            <div className="plist-side">
              {internal && <InternalChip label="Solo internos" />}
              <div className="seg seg-light" role="tablist" aria-label="Vista de finanzas">
                <button role="tab" aria-selected={view === 'resumen'} className={view === 'resumen' ? 'is-on' : ''} onClick={() => setFinanceView('resumen')}>
                  Resumen
                </button>
                <button role="tab" aria-selected={view === 'gastos'} className={view === 'gastos' ? 'is-on' : ''} onClick={() => setFinanceView('gastos')}>
                  Gastos
                </button>
              </div>
              {view === 'resumen' && (
                <div className="seg seg-light" role="tablist" aria-label="Periodo">
                  {PERIODS.map((p) => (
                    <button key={p.key} role="tab" aria-selected={period === p.key} className={period === p.key ? 'is-on' : ''} onClick={() => setPeriod(p.key)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </header>

          {view === 'gastos' ? (
            <ExpensesPanel form={form} setForm={setForm} />
          ) : (
          <div className="plist-scroll" ref={scroll}>
            {internal ? (
              <div className="kpis">
                <article className="kpi">
                  <small>Gastos generales de HAYAI</small>
                  <strong>{money(d.generales)}</strong>
                </article>
                <article className="kpi">
                  <small>Movimientos</small>
                  <strong>{movs}</strong>
                </article>
              </div>
            ) : (
            <div className="kpis">
              <article className="kpi">
                <small>Recaudado</small>
                <strong className="ok">{money(d.recaudado)}</strong>
              </article>
              <article className="kpi">
                <small>Gastos</small>
                <strong>{money(d.gastos)}</strong>
              </article>
              <article className="kpi">
                <small>Balance</small>
                <strong className={d.balance >= 0 ? 'ok' : 'bad'}>{money(d.balance)}</strong>
              </article>
              <article className="kpi">
                <small>Por cobrar</small>
                <strong className="due">{money(d.pendiente)}</strong>
              </article>
            </div>
            )}

            <div className="gcard fcard">
              <h2>{internal ? 'Gastos generales · últimos 6 meses' : 'Ingresos y gastos · últimos 6 meses'}</h2>
              <div className="legend" aria-hidden="true">
                {!internal && <span className="lg-in">Recaudado</span>}
                <span className="lg-out">Gastos</span>
              </div>
              <svg className="fchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={internal ? `Gastos generales por mes: ${s.map((m) => `${m.label} ${money(m.gastos)}`).join('; ')}` : `Ingresos y gastos por mes: ${s.map((m) => `${m.label} ${money(m.ingresos)} recaudado, ${money(m.gastos)} gastos`).join('; ')}`}>
                {[0.25, 0.5, 0.75, 1].map((t) => (
                  <line key={t} x1={pad.l} x2={W - pad.r} y1={y(max * t)} y2={y(max * t)} className="grid" />
                ))}
                {s.map((m, i) => {
                  const x = pad.l + i * bw
                  const w = bw * 0.3
                  return (
                    <g key={m.key}>
                      <rect x={x + bw * 0.16} y={y(m.ingresos)} width={w} height={Math.max(0, H - pad.b - y(m.ingresos))} rx="3" className="bar-in">
                        <title>{`${m.label}: ${money(m.ingresos)} recaudado`}</title>
                      </rect>
                      <rect x={x + bw * 0.16 + w + 4} y={y(m.gastos)} width={w} height={Math.max(0, H - pad.b - y(m.gastos))} rx="3" className="bar-out">
                        <title>{`${m.label}: ${money(m.gastos)} gastos`}</title>
                      </rect>
                      <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis">
                        {m.label}
                      </text>
                    </g>
                  )
                })}
              </svg>

              <h2 className="ft-title">{internal ? 'Lo interno' : 'Por cliente'}</h2>
              <div className="ftable" role="table" aria-label="Recaudado y gastos por cliente">
                <div className="fr fh" role="row">
                  <span role="columnheader">Cliente</span>
                  <span role="columnheader">Recaudado</span>
                  <span role="columnheader">Gastos</span>
                  <span role="columnheader">Utilidad</span>
                  <span role="columnheader">Por cobrar</span>
                </div>
                {!internal && d.rows.length === 0 && <p className="empty-note dark">Cuando registres clientes y cobros, aquí verás lo recaudado por cada uno.</p>}
                {d.rows.map((r) => (
                  <div className="fr" role="row" key={r.id}>
                    <span className="fc-name" role="cell">
                      <Blobvatar seed={r.avatar} size={30} />
                      <span>
                        {r.name}
                        <i className="fbar" aria-hidden="true">
                          <b style={{ width: `${(r.recaudado / maxRow) * 100}%` }} />
                          <u style={{ width: `${(r.gastos / maxRow) * 100}%` }} />
                        </i>
                      </span>
                    </span>
                    <span role="cell" className="ok">
                      {money(r.recaudado)}
                    </span>
                    <span role="cell">{money(r.gastos)}</span>
                    <span role="cell" className={r.utilidad >= 0 ? 'ok' : 'bad'}>
                      {money(r.utilidad)}
                    </span>
                    <span role="cell" className="due">
                      {money(r.pendiente)}
                    </span>
                  </div>
                ))}
                <div className={`fr fgen${internal ? ' is-focus' : ''}`} role="row">
                  <span className="fc-name" role="cell">
                    <span className="fgen-ico" aria-hidden="true">
                      H
                    </span>
                    <span>Gastos generales de HAYAI</span>
                  </span>
                  <span role="cell">—</span>
                  <span role="cell">{money(d.generales)}</span>
                  <span role="cell" className="bad">
                    {money(-d.generales)}
                  </span>
                  <span role="cell">—</span>
                </div>
              </div>
            </div>
          </div>
          )}
        </section>

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>
    </main>
  )
}
