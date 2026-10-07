import { useMemo } from 'react'
import { Blobvatar } from './blob'
import { Icon } from './ui'
import type { InvoiceData } from './Invoice'
import { addDays, avatarOf, fmtDate, money, todayISO, weekdayShort, type Client } from './store'
import type { Project } from './projectData'
import type { Task } from './taskData'

export interface DayItem {
  id: string
  kind: 'pago' | 'visita'
  clientId: string
  date: string
  title: string
  sub: string
  amount?: number
}

/** Cobros pendientes y tareas agendadas (visitas) de todos los clientes, listos para ubicarse por dia. */
export function dayItems(clients: Client[], tasks: Task[], projects: Project[], moveLabel: (m: Client['movements'][number]) => string): DayItem[] {
  const pay = clients.flatMap((c) =>
    c.movements.filter((m) => m.status === 'pendiente').map((m): DayItem => ({ id: m.id, kind: 'pago', clientId: c.id, date: m.date, title: c.name, sub: moveLabel(m), amount: m.amount })),
  )
  const visits = tasks
    .filter((t) => t.due && !t.done)
    .flatMap((t): DayItem[] => {
      const p = projects.find((x) => x.id === t.projectId)
      return p?.clientId ? [{ id: `t-${t.id}`, kind: 'visita', clientId: p.clientId, date: t.due!, title: clients.find((c) => c.id === p.clientId)?.name ?? p.client ?? '', sub: t.title }] : []
    })
  return [...pay, ...visits]
}

const DAYS = 30

/**
 * Linea de tiempo por DIAS: arranca en `start` (hoy, o el dia al que se haya movido) y muestra 30 dias seguidos, con o sin eventos;
 * los dias sin nada quedan vacios. Los cobros vencidos (antes de hoy) van en una primera columna "Vencidos".
 */
export default function DayTrack({
  items,
  clients,
  start,
  selected,
  live,
  onPick,
  onInvoice,
}: {
  items: DayItem[]
  clients: Client[]
  start: string
  selected: string | null
  live?: string
  onPick: (clientId: string) => void
  onInvoice: (d: InvoiceData) => void
}) {
  const today = todayISO()
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start])
  const byDay = useMemo(() => {
    const m = new Map<string, DayItem[]>()
    for (const it of items) m.set(it.date, [...(m.get(it.date) ?? []), it])
    return m
  }, [items])
  const overdue = useMemo(() => items.filter((i) => i.kind === 'pago' && i.date < today).sort((a, b) => a.date.localeCompare(b.date)), [items, today])

  // la factura es del MES del pago: todos los cobros pendientes de ese cliente en ese mes
  const monthInvoice = (p: DayItem, client: string, phone?: string | null): InvoiceData => {
    const month = p.date.slice(0, 7)
    const lines = items
      .filter((i) => i.kind === 'pago' && i.clientId === p.clientId && i.date.startsWith(month))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((i) => ({ id: i.id, date: i.date, concept: i.sub, amount: i.amount ?? 0 }))
    return { clientId: p.clientId, client, month, lines, phone }
  }

  const card = (p: DayItem) => {
    const cl = clients.find((x) => x.id === p.clientId)
    if (!cl) return null
    const late = p.date < today
    const label = `${fmtDate(p.date)}: ${cl.name}, ${p.kind === 'pago' ? `${money(p.amount ?? 0)}, ` : 'visita, '}${p.sub}${late ? ', vencido' : ''}`
    return (
      <div key={p.id} className="pay-wrap">
        <button className={`pay${p.kind === 'visita' ? ' visit' : ''}${late ? ' late' : ''}${selected === p.clientId ? ' is-sel' : ''}${live === p.id ? ' is-live' : ''}${p.kind === 'pago' ? ' has-inv' : ''}`} aria-pressed={selected === p.clientId} aria-label={label} onClick={() => onPick(p.clientId)}>
          <span className="av">
            <Blobvatar seed={avatarOf(cl)} size={36} />
          </span>
          <span className="pay-txt">
            <span className="pay-name">{cl.name}</span>
            {p.amount != null && <span className="pay-amt">{money(p.amount)}</span>}
            <span className="pay-concept">{p.kind === 'visita' && !/^visita/i.test(p.sub) ? `Visita · ${p.sub}` : p.sub}</span>
          </span>
        </button>
        {p.kind === 'pago' && (
          <button type="button" className="inv" title="Factura" aria-label={`Factura de ${cl.name}, ${money(p.amount ?? 0)}`} onClick={() => onInvoice(monthInvoice(p, cl.name, cl.phone))}>
            <Icon name="receipt" size={14} />
          </button>
        )}
      </div>
    )
  }

  // Altura fija de UNA tarjeta: si un dia tiene varias, se desplazan dentro de su columna y el timeline no crece.
  const stack = (list: DayItem[]) => (
    <div className="stack" data-more={list.length > 1 ? `+${list.length - 1}` : undefined}>
      {list.map(card)}
    </div>
  )

  return (
    <ol className="track days">
      {overdue.length > 0 && (
        <li className="day has overdue">
          <span className="d-label">
            <b>Vencidos</b>
          </span>
          <i className="dot" />
          {stack(overdue)}
        </li>
      )}
      {days.map((d, i) => {
        const list = byDay.get(d) ?? []
        const day = Number(d.slice(8))
        const first = i === 0 || day === 1
        return (
          <li key={d} className={`day${list.length ? ' has' : ''}${d === today ? ' is-today' : ''}`} data-date={d}>
            <span className="d-label">
              <b>{day}</b>
              <small>
                {weekdayShort(d)}
                {first ? ` ${fmtDate(d).split(' ')[1]}` : ''}
              </small>
            </span>
            <i className="dot" />
            {list.length > 0 && stack(list)}
          </li>
        )
      })}
    </ol>
  )
}
