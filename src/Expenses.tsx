import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, ZoomControls } from './ui'
import { Blobvatar } from './blob'
import { useCosmos } from './Cosmos'
import CalendarView, { type CalEvent } from './Calendar'
import NewExpense from './NewExpense'
import { useDragScroll } from './drag'
import { fmtDate, money, todayISO } from './store'
import { avatarFor, useAllProjects } from './projectData'
import { isInternalExpense, useInternalFilter } from './nav'
import { InternalChip } from './InternalChip'
import { monthSummary, removeExpense, useExpenses, type Expense } from './expenseData'
import { reduced, useDive } from './warp'

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** Pantalla Gastos: el planeta a un costado y, a la derecha, el calendario de gastos del mes (o del anio) y el historico en linea de tiempo. */
export default function Expenses({ onBack }: { onBack: () => void }) {
  const { world, setDeep } = useCosmos()
  const allExpenses = useExpenses()
  const allProjects = useAllProjects()
  // atajo interno del Hub: solo gastos generales o de proyectos sin cliente
  const internal = useInternalFilter()
  const expenses = useMemo(() => (internal ? allExpenses.filter((x) => isInternalExpense(x, allProjects)) : allExpenses), [internal, allExpenses, allProjects])
  const [tab, setTab] = useState<'cal' | 'hist'>('cal')
  const [form, setForm] = useState(false)
  const [exiting, setExiting] = useState(false)
  const hist = useRef<HTMLDivElement>(null)
  useDragScroll(hist, 'y', [tab])
  useDive(form)
  useEffect(() => {
    setDeep(form)
    return () => setDeep(false)
  }, [form, setDeep])
  useEffect(() => {
    world.screenRate = null // gira a la velocidad propia del planeta
  }, [world])

  const back = () => {
    setExiting(true)
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }
  const sm = monthSummary(expenses)
  const today = todayISO()

  const events = useMemo<CalEvent[]>(
    () =>
      expenses.map((x) => ({
        id: x.id,
        date: x.date,
        title: x.concept,
        sub: `${x.category}${x.ref ? ` · ${x.ref}` : ''}`,
        amount: x.amount,
        tone: 'due' as const, // un gasto es un gasto: un solo color (ambar), sin estados
        avatar: avatarFor(x.owner),
      })),
    [expenses, today],
  )

  // historico: de lo mas reciente a lo mas antiguo, agrupado por mes
  const groups = useMemo(() => {
    const m = new Map<string, Expense[]>()
    ;[...expenses].sort((a, b) => b.date.localeCompare(a.date)).forEach((x) => m.set(x.date.slice(0, 7), [...(m.get(x.date.slice(0, 7)) ?? []), x]))
    return [...m.entries()]
  }, [expenses])

  return (
    <main className={`screen layer expenses arriving${form ? ' deep' : ''}${exiting ? ' exiting' : ''}`}>
      <div className="overlay">
        <div className="clients-left">
          <button className="back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>
        </div>

        <section className="plist gpanel" aria-label="Gastos">
          <header className="plist-head">
            <h1>Gastos</h1>
            <div className="plist-side">
              {internal && <InternalChip label="Solo internos" />}
              <p>
                <span>
                  <b>{money(sm.total)}</b> este mes
                </span>
                <span>
                  <b>{sm.cantidad}</b> {sm.cantidad === 1 ? 'gasto' : 'gastos'}
                </span>
              </p>
              <button className="new" onClick={() => setForm(true)}>
                <Icon name="plus" size={16} />
                Nuevo gasto
              </button>
            </div>
          </header>

          <div className="gcard">
            <div className="seg g-tabs" role="tablist" aria-label="Vista de gastos">
              <button role="tab" aria-selected={tab === 'cal'} className={tab === 'cal' ? 'is-on' : ''} onClick={() => setTab('cal')}>
                <Icon name="calendar" size={15} />
                Calendario
              </button>
              <button role="tab" aria-selected={tab === 'hist'} className={tab === 'hist' ? 'is-on' : ''} onClick={() => setTab('hist')}>
                <Icon name="chart" size={15} />
                Histórico
              </button>
            </div>

            {tab === 'cal' ? (
              <div className="g-body" key="cal">
                <CalendarView events={events} noun="gastos" />
              </div>
            ) : (
              <div className="g-body g-hist" key="hist" ref={hist}>
                {groups.length === 0 && <p className="empty-note dark">{internal ? 'No hay gastos internos todavía. Quita el filtro para ver los gastos de los clientes.' : 'Aún no hay gastos registrados.'}</p>}
                {groups.map(([ym, list]) => (
                  <section key={ym}>
                    <h3>
                      {MONTHS[+ym.slice(5) - 1]} {ym.slice(0, 4)}
                      <em>{money(list.reduce((s, x) => s + x.amount, 0))}</em>
                    </h3>
                    <ol className="moves g-moves">
                      {list.map((x) => (
                        <li key={x.id} className="due">
                          <i aria-hidden="true" />
                          <div>
                            <p className="m-concept">{x.concept}</p>
                            <p className="m-date">
                              {fmtDate(x.date, true)} · {x.category}
                              {x.ref ? ` · ${x.ref}` : ''}
                            </p>
                          </div>
                          <Blobvatar seed={avatarFor(x.owner)} size={26} />
                          <div className="m-right">
                            <p className="m-amt">{money(x.amount)}</p>
                          </div>
                          <button className="rm" aria-label={`Eliminar ${x.concept}`} title="Eliminar" onClick={() => window.confirm(`¿Eliminar el gasto "${x.concept}"? Irá a la papelera y podrás restaurarlo durante 30 días.`) && void removeExpense(x.id).catch((e) => window.alert(e instanceof Error ? e.message : 'No se pudo eliminar.'))}>
                            <Icon name="close" size={15} />
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </div>
        </section>

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>

      {form && (
        <NewExpense
          onClose={() => setForm(false)}
          onCreate={() => {
            setForm(false)
            setTab('hist')
          }}
        />
      )}
    </main>
  )
}
