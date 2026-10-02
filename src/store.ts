import { api } from './api'
import { createList } from './cache'

export interface Item {
  id: string
  concept: string
  amount: number
}
export interface Movement {
  id: string
  /** YYYY-MM-DD */
  date: string
  concept: string
  amount: number
  kind: 'inicial' | 'pago'
  status: 'cobrado' | 'pendiente'
}
export interface Client {
  id: string
  name: string
  /** semilla del avatar blob */
  avatar: string
  /** desglose de la inicial */
  items: Item[]
  movements: Movement[]
}

const clients = createList<Client>()
export const useClients = clients.use
export const loadClients = async () => clients.set(await api.get<Client[]>('/clients'))
export const resetClients = () => clients.set([])

export const avatarOf = (c: Client) => c.avatar ?? c.id

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const fmtDate = (s: string, year = false) => {
  const [y, m, d] = s.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ''}`
}
export const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
export const todayISO = () => {
  const t = new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

export interface Draft {
  name: string
  avatar: string
  /** fecha en que se cobro la inicial */
  initialDate: string
  items: { concept: string; amount: number }[]
  /** cobros programados */
  charges: { date: string; amount: number; concept: string }[]
}

/** Crea el cliente (con su inicial y cobros) en el servidor y lo agrega a la lista. */
export async function addClient(d: Draft): Promise<Client> {
  const c = await api.post<Client>('/clients', d)
  clients.update((cur) => [...cur, c])
  return c
}

export function stats(c: Client) {
  let cobrado = 0
  let pendiente = 0
  let pagos = 0
  let porCobrar = 0
  for (const m of c.movements) {
    if (m.status === 'cobrado') (cobrado += m.amount, pagos++)
    else (pendiente += m.amount, porCobrar++)
  }
  return { cobrado, pendiente, pagos, porCobrar }
}

export function summary(list: Client[]) {
  return list.reduce(
    (a, c) => {
      const s = stats(c)
      return { activos: a.activos + 1, recaudado: a.recaudado + s.cobrado, porCobrar: a.porCobrar + s.porCobrar }
    },
    { activos: 0, recaudado: 0, porCobrar: 0 },
  )
}

export interface Upcoming {
  id: string
  clientId: string
  date: string
  amount: number
  concept: string
}
/** Cobros pendientes de todos los clientes, por fecha. */
export function upcoming(list: Client[]): Upcoming[] {
  return list
    .flatMap((c) => c.movements.filter((m) => m.status === 'pendiente').map((m) => ({ id: m.id, clientId: c.id, date: m.date, amount: m.amount, concept: m.concept })))
    .sort((a, b) => a.date.localeCompare(b.date))
}
