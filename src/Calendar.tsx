import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import { money, todayISO } from './store'
import { useDragScroll } from './drag'

export interface CalEvent {
  id: string
  /** YYYY-MM-DD */
  date: string
  title: string
  sub?: string
  /** sin monto (p.ej. una visita agendada) */
  amount?: number
  /** ok = cobrado/pagado, due = pendiente, late = vencido */
  tone: 'ok' | 'due' | 'late'
  avatar?: string
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const WEEK = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
const offset = (y: number, m: number) => (new Date(y, m, 1).getDay() + 6) % 7 // lunes primero
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/** Calendario completo: vista por mes (con los movimientos de cada dia) o por anio; arrastrable con el raton y navegable con flechas. */
export default function CalendarView({ events, noun = 'pagos', nounOne = 'pago' }: { events: CalEvent[]; noun?: string; nounOne?: string }) {
  const today = todayISO()
  const [view, setView] = useState<'month' | 'year'>('month')
  const [cur, setCur] = useState(() => ({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 }))
  const [sel, setSel] = useState<string | null>(today)
  const [dir, setDir] = useState(1)
  const scroll = useRef<HTMLDivElement>(null)
  useDragScroll(scroll, 'y', [view])

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e])
    return m
  }, [events])

  const monthTotal = useMemo(() => {
    const pre = `${cur.y}-${pad(cur.m + 1)}`
    return events.filter((e) => e.date.startsWith(pre)).reduce((s, e) => s + (e.amount ?? 0), 0)
  }, [events, cur])
  const yearTotal = useMemo(() => events.filter((e) => e.date.startsWith(String(cur.y))).reduce((s, e) => s + (e.amount ?? 0), 0), [events, cur.y])

  const step = (n: number) => {
    setDir(n)
    setCur((c) => {
      if (view === 'year') return { y: c.y + n, m: c.m }
      const t = c.y * 12 + c.m + n
      return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 }
    })
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const goToday = () => {
    setDir(1)
    setCur({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 })
    setSel(today)
  }

  const tone = (list: CalEvent[]) => (list.some((e) => e.tone === 'late') ? 'late' : list.some((e) => e.tone === 'due') ? 'due' : 'ok')

  const rows = Math.ceil((offset(cur.y, cur.m) + daysIn(cur.y, cur.m)) / 7) // sin filas vacias al final
  const cells = Array.from({ length: rows * 7 }, (_, i) => {
    const d = i - offset(cur.y, cur.m) + 1
    return d >= 1 && d <= daysIn(cur.y, cur.m) ? d : 0
  })
  const selList = sel ? (byDay.get(sel) ?? []) : []

  return (
    <div className="cal">
      <header className="cal-head">
        <div className="cal-nav">
          <button className="cal-btn" onClick={() => step(-1)} aria-label={view === 'year' ? 'Año anterior' : 'Mes anterior'}>
            <Icon name="back" size={18} />
          </button>
          <h3 aria-live="polite">{view === 'year' ? cur.y : `${cap(MONTHS[cur.m])} ${cur.y}`}</h3>
          <button className="cal-btn next" onClick={() => step(1)} aria-label={view === 'year' ? 'Año siguiente' : 'Mes siguiente'}>
            <Icon name="back" size={18} />
          </button>
          <button className="cal-today" onClick={goToday}>
            Hoy
          </button>
        </div>
        <div className="cal-tools">
          <p className="cal-total">
            <small>{view === 'year' ? `Total ${cur.y}` : `Total del mes`}</small>
            {money(view === 'year' ? yearTotal : monthTotal)}
          </p>
          <div className="seg" role="tablist" aria-label="Vista del calendario">
            {(['month', 'year'] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'is-on' : ''} onClick={() => setView(v)}>
                {v === 'month' ? 'Mes' : 'Año'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="cal-scroll" ref={scroll}>
        {view === 'month' ? (
          <div key={`m${cur.y}-${cur.m}`} className={`cal-month ${dir > 0 ? 'from-r' : 'from-l'}`}>
            <div className="cal-week">
              {WEEK.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="cal-grid">
              {cells.map((d, i) => {
                if (!d) return <i key={i} className="cal-empty" />
                const date = iso(cur.y, cur.m, d)
                const list = byDay.get(date) ?? []
                return (
                  <button key={i} className={`cal-day${date === today ? ' is-today' : ''}${date === sel ? ' is-sel' : ''}${list.length ? ' has' : ''}`} onClick={() => setSel(date)} aria-label={`${d} de ${MONTHS[cur.m]}: ${list.length} ${list.length === 1 ? nounOne : noun}`} aria-pressed={date === sel}>
                    <b>{d}</b>
                    {list.slice(0, 2).map((e) => (
                      <span key={e.id} className={`chip t-${e.tone}`}>
                        <span className="ct">{e.title}</span>
                        {e.amount != null && <em>{money(e.amount)}</em>}
                      </span>
                    ))}
                    {list.length > 2 && <span className="more">+{list.length - 2} más</span>}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div key={`y${cur.y}`} className={`cal-year ${dir > 0 ? 'from-r' : 'from-l'}`}>
            {MONTHS.map((name, m) => {
              const pre = `${cur.y}-${pad(m + 1)}`
              const total = events.filter((e) => e.date.startsWith(pre)).reduce((s, e) => s + (e.amount ?? 0), 0)
              return (
                <section key={name} className={`mini${m === cur.m ? ' is-cur' : ''}`}>
                  <button
                    className="mini-title"
                    onClick={() => {
                      setCur({ y: cur.y, m })
                      setView('month')
                    }}
                    aria-label={`Ver ${name} ${cur.y}`}
                  >
                    <span>{cap(name)}</span>
                    <em>{total ? money(total) : ''}</em>
                  </button>
                  <div className="mini-week">
                    {WEEK.map((w) => (
                      <span key={w}>{w[0]}</span>
                    ))}
                  </div>
                  <div className="mini-grid">
                    {Array.from({ length: 42 }, (_, i) => {
                      const d = i - offset(cur.y, m) + 1
                      if (d < 1 || d > daysIn(cur.y, m)) return <i key={i} />
                      const date = iso(cur.y, m, d)
                      const list = byDay.get(date)
                      return (
                        <button
                          key={i}
                          className={`md${list ? ` has t-${tone(list)}` : ''}${date === today ? ' is-today' : ''}`}
                          onClick={() => {
                            setCur({ y: cur.y, m })
                            setSel(date)
                            setView('month')
                          }}
                          aria-label={`${d} de ${name}`}
                          tabIndex={-1}
                        >
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      {view === 'month' && (
        <footer className="cal-detail" aria-live="polite">
          <h4>{sel ? `${+sel.slice(8)} de ${MONTHS[+sel.slice(5, 7) - 1]} ${sel.slice(0, 4)}` : 'Selecciona un día'}</h4>
          {selList.length === 0 ? (
            <p className="none">Sin {noun} este día.</p>
          ) : (
            <ul>
              {selList.map((e) => (
                <li key={e.id} className={`t-${e.tone}`}>
                  {e.avatar && <Blobvatar seed={e.avatar} size={28} />}
                  <span>
                    <b>{e.title}</b>
                    {e.sub && <small>{e.sub}</small>}
                  </span>
                  {e.amount != null && <strong>{money(e.amount)}</strong>}
                </li>
              ))}
            </ul>
          )}
        </footer>
      )}
    </div>
  )
}
