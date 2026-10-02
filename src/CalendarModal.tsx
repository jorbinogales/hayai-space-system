import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import CalendarView, { type CalEvent } from './Calendar'
import { avatarOf, moveLabel, todayISO, useClients } from './store'
import { useTasks } from './taskData'
import { useProjects } from './projectData'

/** Calendario completo de cobros de todos los clientes, en el mismo estilo oscuro de los formularios. */
export default function CalendarModal({ onClose }: { onClose: () => void }) {
  const clients = useClients()
  const tasks = useTasks()
  const projects = useProjects()
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const events = useMemo<CalEvent[]>(() => {
    const today = todayISO()
    const pay: CalEvent[] = clients.flatMap((c) =>
      c.movements.map((m) => ({
        id: m.id,
        date: m.date,
        title: c.name,
        sub: moveLabel(m),
        amount: m.amount,
        tone: m.status === 'cobrado' ? ('ok' as const) : m.date < today ? ('late' as const) : ('due' as const),
        avatar: avatarOf(c),
      })),
    )
    // tareas agendadas (p.ej. visitas a posibles clientes), sin monto
    const visits: CalEvent[] = tasks
      .filter((t) => t.due)
      .map((t) => {
        const p = projects.find((x) => x.id === t.projectId)
        const cl = clients.find((x) => x.id === p?.clientId)
        return { id: `t-${t.id}`, date: t.due!, title: t.title, sub: p ? `Proyecto: ${p.name}` : undefined, tone: t.done ? ('ok' as const) : t.due! < today ? ('late' as const) : ('due' as const), avatar: cl ? avatarOf(cl) : undefined }
      })
    return [...pay, ...visits]
  }, [clients, tasks, projects])

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet cal-sheet" role="dialog" aria-modal="true" aria-labelledby="cal-title">
        <header>
          <h2 id="cal-title">Calendario de pagos y visitas</h2>
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
