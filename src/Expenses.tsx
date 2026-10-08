import { useMemo, useRef, useState } from 'react'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import CalendarView, { type CalEvent } from './Calendar'
import NewExpense from './NewExpense'
import { useDragScroll } from './drag'
import { fmtDate, money, todayISO } from './store'
import { avatarFor, useAllProjects } from './projectData'
import { isInternalExpense, useInternalFilter } from './nav'
import { removeExpense, useExpenses, type Expense } from './expenseData'
import type { Period } from './finance'
import { useDive } from './warp'

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/**
 * Gastos: ya no es un planeta, vive dentro de Finanzas (vista «Gastos»). Resumen del mes + «Nuevo gasto», y debajo el calendario
 * del mes (o del año) y el histórico en línea de tiempo. `form`/`setForm` los maneja Finanzas (para oscurecer la pantalla al abrir el formulario).
 */
export function ExpensesPanel({ form, setForm, period }: { form: boolean; setForm: (v: boolean) => void; period: Period }) {
  const allExpenses = useExpenses()
  const allProjects = useAllProjects()
  // atajo interno del Hub: solo gastos generales o de proyectos sin cliente
  const internal = useInternalFilter()
  const today = todayISO()
  const base = useMemo(() => (internal ? allExpenses.filter((x) => isInternalExpense(x, allProjects)) : allExpenses), [internal, allExpenses, allProjects])
  // el periodo (Este mes / Este año / Todo) recorta el resumen y el histórico; el calendario conserva todo para poder navegar entre meses
  const expenses = useMemo(() => (period === 'todo' ? base : base.filter((x) => x.date.startsWith(period === 'mes' ? today.slice(0, 7) : today.slice(0, 4)))), [base, period, today])
  const [tab, setTab] = useState<'cal' | 'hist'>('cal')
  const hist = useRef<HTMLDivElement>(null)
  useDragScroll(hist, 'y', [tab])
  useDive(form)
  const sm = { total: expenses.reduce((a, x) => a + x.amount, 0), cantidad: expenses.length }
  const cuando = period === 'mes' ? 'este mes' : period === 'anio' ? 'este año' : 'en total'

  const events = useMemo<CalEvent[]>(
    () =>
      base.map((x) => ({
        id: x.id,
        date: x.date,
        title: x.concept,
        sub: `${x.category}${x.ref ? ` · ${x.ref}` : ''}`,
        amount: x.amount,
        tone: 'due' as const, // un gasto es un gasto: un solo color (ambar), sin estados
        avatar: avatarFor(x.owner),
      })),
    [base],
  )

  // historico: de lo mas reciente a lo mas antiguo, agrupado por mes
  const groups = useMemo(() => {
    const m = new Map<string, Expense[]>()
    ;[...expenses].sort((a, b) => b.date.localeCompare(a.date)).forEach((x) => m.set(x.date.slice(0, 7), [...(m.get(x.date.slice(0, 7)) ?? []), x]))
    return [...m.entries()]
  }, [expenses])


  return (
    <div className="g-panel">
      <div className="g-sum">
        <p>
          <span>
            <b>{money(sm.total)}</b> {cuando}
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
          <CalendarView events={events} noun="gastos" nounOne="gasto" />
        </div>
      ) : (
        <div className="g-body g-hist" key="hist" ref={hist}>
          {groups.length === 0 && <p className="empty-note dark">{internal ? 'Sin gastos internos en este periodo. Quita el filtro para ver los de los clientes.' : period === 'todo' ? 'Aún no hay gastos registrados.' : 'Sin gastos en este periodo.'}</p>}
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

      {form && (
        <NewExpense
          onClose={() => setForm(false)}
          onCreate={() => {
            setForm(false)
            setTab('hist')
          }}
        />
      )}
    </div>
  )
}
