import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import CalendarView, { type CalEvent } from './Calendar'
import { avatarOf, todayISO, useClients } from './store'

/** Calendario completo de cobros de todos los clientes, en el mismo estilo oscuro de los formularios. */
export default function CalendarModal({ onClose }: { onClose: () => void }) {
  const clients = useClients()
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const events = useMemo<CalEvent[]>(() => {
    const today = todayISO()
    return clients.flatMap((c) =>
      c.movements.map((m) => ({
        id: m.id,
        date: m.date,
        title: c.name,
        sub: m.concept,
        amount: m.amount,
        tone: m.status === 'cobrado' ? ('ok' as const) : m.date < today ? ('late' as const) : ('due' as const),
        avatar: avatarOf(c),
      })),
    )
  }, [clients])

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet cal-sheet" role="dialog" aria-modal="true" aria-labelledby="cal-title">
        <header>
          <h2 id="cal-title">Calendario de pagos</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <CalendarView events={events} noun="pagos" />
      </div>
    </div>,
    document.body,
  )
}
