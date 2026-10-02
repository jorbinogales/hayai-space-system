import { api } from './api'
import { createList } from './cache'
import { loadProjects } from './projectData'
import { loadTasks } from './taskData'

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
  /** si el cobro es parte de un pago mensual recurrente: posicion en la serie */
  series?: { id: string; index: number; total: number } | null
}

/** Texto del movimiento: el concepto y, si es recurrente, su posicion ("Pago mensual 3/12"). */
export const moveLabel = (m: { concept: string; series?: { index: number; total: number } | null }) => (m.series ? `${m.concept} ${m.series.index}/${m.series.total}` : m.concept)
export interface Client {
  id: string
  name: string
  /** posible cliente: aun no firmo (puede no tener inicial ni cobros) */
  prospect?: boolean
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
  charges: { date: string; amount: number; concept: string; /** repetir cada mes, el mismo dia, durante N meses (2-36) */ repeatMonths?: number }[]
}

/** Crea el cliente (con su inicial y cobros) en el servidor y lo agrega a la lista. */
export async function addClient(d: Draft): Promise<Client> {
  const c = await api.post<Client>('/clients', d)
  clients.update((cur) => [...cur, c])
  return c
}

/** Reemplaza en la lista el cliente que devuelve el servidor tras una edicion. */
const put = (c: Client) => clients.update((cur) => cur.map((x) => (x.id === c.id ? c : x)))

export async function updateClient(id: string, d: { name: string; avatar: string }): Promise<Client> {
  const c = await api.patch<Client>(`/clients/${id}`, d)
  put(c)
  return c
}
/** Reemplaza el desglose de la inicial (y su fecha); sin items la inicial desaparece. */
export async function saveInitial(id: string, d: { date: string; items: { concept: string; amount: number }[] }): Promise<Client> {
  const c = await api.put<Client>(`/clients/${id}/initial`, d)
  put(c)
  return c
}
export interface ProspectDraft {
  name: string
  avatar: string
  project: { name: string; icon: string; owner: string; due?: string | null }
  visit: { date?: string | null; title?: string }
}
/** Registra un posible cliente con su posible proyecto ("Por visitar") y una tarea de visita ligada a ese proyecto. */
export async function addProspect(d: ProspectDraft): Promise<Client> {
  const r = await api.post<{ client: Client }>('/prospects', d)
  clients.update((cur) => [...cur, r.client])
  await Promise.all([loadProjects(), loadTasks()]) // el proyecto y la tarea nuevos tambien aparecen en sus pantallas
  return r.client
}
/** El posible cliente firmo: pasa a ser cliente (conserva su proyecto). */
export async function convertClient(id: string): Promise<Client> {
  const c = await api.post<Client>(`/clients/${id}/convert`)
  put(c)
  return c
}

export interface PaymentDraft {
  date: string
  amount: number
  concept: string
  status?: 'pendiente' | 'cobrado'
  /** repetir cada mes (solo pendientes) */
  repeatMonths?: number
}
export async function addPayment(clientId: string, d: PaymentDraft): Promise<Client> {
  const c = await api.post<Client>(`/clients/${clientId}/payments`, d)
  put(c)
  return c
}
export async function updatePayment(id: string, d: Partial<Pick<PaymentDraft, 'date' | 'amount' | 'concept' | 'status'>>): Promise<Client> {
  const c = await api.patch<Client>(`/payments/${id}`, d)
  put(c)
  return c
}
export async function deletePayment(id: string): Promise<Client> {
  const c = await api.del<Client>(`/payments/${id}`)
  put(c)
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
      if (c.prospect) return { ...a, posibles: a.posibles + 1 }
      const s = stats(c)
      return { ...a, activos: a.activos + 1, recaudado: a.recaudado + s.cobrado, porCobrar: a.porCobrar + s.porCobrar }
    },
    { activos: 0, posibles: 0, recaudado: 0, porCobrar: 0 },
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
    .flatMap((c) => c.movements.filter((m) => m.status === 'pendiente').map((m) => ({ id: m.id, clientId: c.id, date: m.date, amount: m.amount, concept: moveLabel(m) })))
    .sort((a, b) => a.date.localeCompare(b.date))
}
