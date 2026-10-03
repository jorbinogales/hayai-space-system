import { api } from './api'
import { createList } from './cache'
import { todayISO } from './store'

export type ExpenseScope = 'general' | 'cliente' | 'proyecto'
export const EXPENSE_CATEGORIES = ['Herramientas', 'Infraestructura', 'Operación', 'Marketing', 'Equipos', 'Otros']
export const SCOPE_LABEL: Record<ExpenseScope, string> = { general: 'HAYAI general', cliente: 'Cliente', proyecto: 'Proyecto' }

export interface Expense {
  id: string
  /** YYYY-MM-DD */
  date: string
  concept: string
  amount: number
  category: string
  scope: ExpenseScope
  /** nombre del cliente o proyecto al que se imputa (si scope no es general) */
  ref?: string | null
  refId?: string | null
  /** astronauta que lo registro (nombre) */
  owner: string
}

const expenses = createList<Expense>()
export const useExpenses = expenses.use
export const loadExpenses = async () => expenses.set(await api.get<Expense[]>('/expenses'))
export const resetExpenses = () => expenses.set([])

export interface ExpenseDraft {
  date: string
  concept: string
  amount: number
  category: string
  scope: ExpenseScope
  /** id del cliente o proyecto */
  refId?: string
}
export async function addExpense(d: ExpenseDraft): Promise<Expense> {
  const x = await api.post<Expense>('/expenses', d)
  expenses.update((cur) => [...cur, x])
  return x
}

export async function removeExpense(id: string): Promise<void> {
  await api.del(`/expenses/${id}`)
  expenses.update((cur) => cur.filter((x) => x.id !== id))
}

/** Gastos del mes actual: total y cuantos fueron. */
export function monthSummary(list: Expense[]) {
  const pre = todayISO().slice(0, 7)
  const m = list.filter((x) => x.date.startsWith(pre))
  return { total: m.reduce((s, x) => s + x.amount, 0), cantidad: m.length }
}
