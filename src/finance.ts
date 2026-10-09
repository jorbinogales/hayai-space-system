import { stats, todayISO, type Client } from './store'
import type { Expense } from './expenseData'
import type { Project } from './projectData'

export type Period = 'mes' | 'anio' | 'todo'

const inPeriod = (date: string, p: Period) => {
  const t = todayISO()
  return p === 'todo' || (p === 'mes' ? date.startsWith(t.slice(0, 7)) : date.startsWith(t.slice(0, 4)))
}

/** Ingresos (cobrado) y gastos del AÑO en curso (enero a diciembre): los que muestra la tarjeta del Home. */
export function yearFinance(clients: Client[], expenses: Expense[]) {
  const pre = todayISO().slice(0, 4)
  const ingresos = clients.reduce((s, c) => s + c.movements.filter((m) => m.status === 'cobrado' && m.date.startsWith(pre)).reduce((a, m) => a + m.amount, 0), 0)
  const gastos = expenses.filter((x) => x.date.startsWith(pre)).reduce((s, x) => s + x.amount, 0)
  return { ingresos, gastos }
}

/** Lo que un cliente debe hoy (cobros pendientes, de cualquier fecha). */
export const owed = (c: Client) => c.movements.filter((m) => m.status === 'pendiente').reduce((s, m) => s + m.amount, 0)
/** Lo que se debe en total: el «por cobrar» de Finanzas y del planeta Clientes salen de aquí. */
export const owedTotal = (clients: Client[]) => clients.reduce((s, c) => s + owed(c), 0)
/** Cuantos cobros pendientes hay (la cantidad, no el monto): mismo universo de clientes que `owedTotal`. */
export const owedCount = (clients: Client[]) => clients.reduce((s, c) => s + c.movements.filter((m) => m.status === 'pendiente').length, 0)

export interface ClientRow {
  id: string
  name: string
  avatar: string
  recaudado: number
  gastos: number
  pendiente: number
  utilidad: number
}

/**
 * Resumen del periodo: lo recaudado por cada cliente, los gastos que se le imputan (directos o por sus proyectos)
 * y los gastos generales de HAYAI, que no pertenecen a ningun cliente.
 */
export function dashboard(clients: Client[], expenses: Expense[], projects: Project[], period: Period) {
  const projectClient = new Map(projects.map((p) => [p.name, p.client]))
  const rows: ClientRow[] = clients.map((c) => {
    const recaudado = c.movements.filter((m) => m.status === 'cobrado' && inPeriod(m.date, period)).reduce((s, m) => s + m.amount, 0)
    const pendiente = owed(c) // lo que se debe hoy no depende del periodo: es el mismo número del planeta Clientes
    const gastos = expenses
      .filter((x) => inPeriod(x.date, period) && ((x.scope === 'cliente' && x.ref === c.name) || (x.scope === 'proyecto' && x.ref && projectClient.get(x.ref) === c.name)))
      .reduce((s, x) => s + x.amount, 0)
    return { id: c.id, name: c.name, avatar: c.avatar ?? c.id, recaudado, gastos, pendiente, utilidad: recaudado - gastos }
  })
  rows.sort((a, b) => b.recaudado - a.recaudado)
  const names = new Set(clients.map((c) => c.name))
  const generales = expenses
    .filter((x) => inPeriod(x.date, period) && !((x.scope === 'cliente' && x.ref && names.has(x.ref)) || (x.scope === 'proyecto' && x.ref && names.has(projectClient.get(x.ref) ?? ''))))
    .reduce((s, x) => s + x.amount, 0)
  const recaudado = rows.reduce((s, r) => s + r.recaudado, 0)
  const gastosClientes = rows.reduce((s, r) => s + r.gastos, 0)
  const gastos = gastosClientes + generales
  const pendiente = rows.reduce((s, r) => s + r.pendiente, 0)
  return { rows, generales, recaudado, gastos, pendiente, balance: recaudado - gastos }
}

/** Ingresos y gastos de los ultimos `n` meses (terminando en el actual), para la grafica. */
export function series(clients: Client[], expenses: Expense[], n = 6) {
  const t = new Date()
  const out: { key: string; label: string; ingresos: number; gastos: number }[] = []
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({
      key,
      label: MESES[d.getMonth()],
      ingresos: clients.reduce((s, c) => s + c.movements.filter((m) => m.status === 'cobrado' && m.date.startsWith(key)).reduce((a, m) => a + m.amount, 0), 0),
      gastos: expenses.filter((x) => x.date.startsWith(key)).reduce((s, x) => s + x.amount, 0),
    })
  }
  return out
}

export { stats }
