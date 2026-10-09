import type { DayItem } from './DayTrack'
import { money } from './store'

/** Lo siguiente que hay que hacer con un cliente, calculado de lo que de verdad esta agendado. */
export interface NextAction {
  kind: 'visita' | 'pago' | 'manual'
  /** frase lista para mostrar ("Visita: mostrar propuesta", "Cobrar $120 · Pago mensual 3/12") */
  text: string
  date: string | null
  /** la fecha ya paso (cobro vencido o seguimiento atrasado) */
  late: boolean
}

const ORDER = { visita: 0, manual: 1, pago: 2 } as const

/**
 * Proxima accion de un cliente. Sale de las visitas agendadas y los cobros pendientes (los mismos que pinta el cronograma)
 * y de la accion escrita a mano en su ficha de seguimiento. Gana lo mas cercano desde hoy; si no queda nada hacia adelante,
 * se muestra lo vencido mas antiguo (marcado como atrasado); una accion manual sin fecha solo cuenta cuando no hay nada agendado.
 */
export function nextActionOf(clientId: string, rows: DayItem[], manual: { text?: string | null; date?: string | null } | null, today: string): NextAction | null {
  const all: NextAction[] = []
  for (const r of rows) {
    if (r.clientId !== clientId) continue
    all.push(
      r.kind === 'visita'
        ? { kind: 'visita', text: /^visita/i.test(r.sub) ? r.sub : `Visita: ${r.sub}`, date: r.date, late: r.date < today }
        : { kind: 'pago', text: `Cobrar ${money(r.amount ?? 0)} · ${r.sub}`, date: r.date, late: r.date < today },
    )
  }
  if (manual?.text) all.push({ kind: 'manual', text: manual.text, date: manual.date ?? null, late: !!manual.date && manual.date < today })

  const dated = all.filter((a) => a.date)
  const byDate = (a: NextAction, b: NextAction) => a.date!.localeCompare(b.date!) || ORDER[a.kind] - ORDER[b.kind]
  const ahead = dated.filter((a) => !a.late).sort(byDate)
  if (ahead[0]) return ahead[0]
  const behind = dated.filter((a) => a.late).sort(byDate)
  if (behind[0]) return behind[0]
  return all.find((a) => a.kind === 'manual') ?? null
}
