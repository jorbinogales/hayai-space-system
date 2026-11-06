// Tablero (kanban): estado en memoria + llamadas a /api/board. El orden es el de los arrays (nunca se manda `position`).
// Escribir = cambio optimista al instante y, si el servidor falla, se vuelve a como estaba y se re-lee el tablero.
// Un re-leer (aviso SSE «tablero») no pisa un arrastre en curso ni una escritura en vuelo: espera a que terminen.
import { useSyncExternalStore } from 'react'
import { api, type WriteOptions } from './api'
import { can } from './tenant'
import { todayISO } from './store'

export const PRIORITIES = ['baja', 'media', 'alta', 'urgente'] as const
export type Priority = (typeof PRIORITIES)[number]
export const PRIORITY_LABEL: Record<Priority, string> = { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' }

/** Fecha límite ya pasada (YYYY-MM-DD compara bien como texto). */
export const isLate = (c: { dueDate: string | null }) => !!c.dueDate && c.dueDate < todayISO()

export interface Person {
  id: string
  name: string
  avatar: string
}
export interface Card {
  id: string
  columnId: string
  position: number
  title: string
  description: string | null
  priority: Priority
  dueDate: string | null
  archivedAt: string | null
  assignee: Person | null
  client: { id: string; name: string } | null
  comments: number
  createdBy: { id: string; name: string }
  createdAt: string
  /** version del CONTENIDO: se manda como If-Match al editar (mover, reordenar y archivar no la cambian) */
  updatedAt: string
}
export interface Column {
  id: string
  name: string
  position: number
  cards: Card[]
}
export interface Board {
  id: string
  name: string
  columns: Column[]
}
export interface Comment {
  id: string
  cardId: string
  author: Person
  body: string
  editedAt: string | null
  createdAt: string
}
export interface CardPatch {
  title?: string
  description?: string | null
  priority?: Priority
  assigneeId?: string | null
  clientId?: string | null
  dueDate?: string | null
}

interface State {
  board: Board | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  members: Person[] | null
}
const EMPTY: State = { board: null, status: 'idle', error: '', members: null }
let state: State = EMPTY
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export const useBoard = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  )
export const boardNow = () => state.board

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

// ---------- lectura ----------
let seq = 0 // una escritura invalida las lecturas que ya volaban: su foto es anterior a ella
let busy = 0 // escrituras en vuelo
let hold = 0 // arrastres en curso
let want = false // hay un re-leer pendiente
let timer = 0

const norm = (b: Board): Board => ({ ...b, columns: b.columns.map((c) => ({ ...c, cards: c.cards ?? [] })) })

/** Lee el tablero. Sin tablero todavia pasa por «cargando»; si falla con algo ya en pantalla, lo deja como esta. */
export async function loadBoard(): Promise<void> {
  if (!can('tablero')) return
  const mine = ++seq
  if (!state.board) set({ status: 'loading', error: '' })
  try {
    const b = await api.get<Board>('/board')
    if (mine === seq) set({ board: norm(b), status: 'ready', error: '' })
  } catch (e) {
    if (mine !== seq) return
    if (!state.board) set({ status: 'error', error: msg(e, 'No se pudo cargar el tablero.') })
    throw e
  }
}
const flush = () => {
  if (busy || hold || !want) return
  want = false
  void loadBoard().catch(() => {})
}
/** Pide re-leer el tablero en cuanto no haya un arrastre ni una escritura en curso. */
export function refreshBoard() {
  want = true
  flush()
}
/** Mientras se arrastra, los avisos en vivo no tocan el tablero. */
export function holdBoard(on: boolean) {
  hold = Math.max(0, hold + (on ? 1 : -1))
  flush()
}
export const resetBoard = () => {
  window.clearTimeout(timer)
  timer = 0
  seq++
  busy = hold = 0
  want = false
  cardListeners.clear()
  state = EMPTY
  subs.forEach((f) => f())
}

export async function loadMembers(): Promise<Person[]> {
  if (state.members) return state.members
  const m = await api.get<Person[]>('/board/members')
  set({ members: m })
  return m
}

// ---------- en vivo (SSE «tablero», sin datos; lo reparte live.ts) ----------
export interface BoardEvent {
  op: 'nuevo' | 'editado' | 'borrado'
  seccion: 'columnas' | 'tarjetas' | 'comentarios'
  id: string
}
const cardListeners = new Map<string, Set<() => void>>()
const cardPending = new Set<string>()
/** Una tarjeta abierta se entera de que ella o sus comentarios cambiaron (varios avisos seguidos = una sola llamada). */
export function subscribeCard(id: string, f: () => void): () => void {
  const s = cardListeners.get(id) ?? new Set()
  s.add(f)
  cardListeners.set(id, s)
  return () => {
    s.delete(f)
    if (!s.size && cardListeners.get(id) === s) cardListeners.delete(id)
  }
}
function settle() {
  timer = 0
  if (state.board) refreshBoard()
  for (const id of [...cardPending]) for (const f of [...(cardListeners.get(id) ?? [])]) f()
  cardPending.clear()
}
const queue = () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(settle, 200) // el renumerado manda un aviso por tarjeta
}
export function receiveBoard(e: Partial<BoardEvent> | null | undefined) {
  if (!e) return
  if ((e.seccion === 'tarjetas' || e.seccion === 'comentarios') && typeof e.id === 'string' && cardListeners.has(e.id)) cardPending.add(e.id)
  queue()
}
/** El stream volvio tras una caida: lo que paso no se reenvia; se re-lee todo. */
export function boardResync() {
  for (const id of cardListeners.keys()) cardPending.add(id)
  queue()
}

// ---------- escritura ----------
async function write<T>(fn: () => Promise<T>): Promise<T> {
  busy++
  seq++
  try {
    return await fn()
  } finally {
    busy--
    flush()
  }
}
/** Aplica `apply` al tablero ya; si `call` falla, restaura la foto previa, pide re-leer y repropaga el error. */
async function optimistic<T>(apply: (b: Board) => Board, call: () => Promise<T>): Promise<T> {
  const before = state.board
  if (!before) throw new Error('El tablero no está cargado.')
  set({ board: apply(before) })
  try {
    return await write(call)
  } catch (e) {
    set({ board: before })
    want = true
    throw e
  }
}

const mapCards = (b: Board, fn: (c: Card) => Card): Board => ({ ...b, columns: b.columns.map((col) => ({ ...col, cards: col.cards.map(fn) })) })
const dropCard = (b: Board, id: string): Board => ({ ...b, columns: b.columns.map((col) => ({ ...col, cards: col.cards.filter((c) => c.id !== id) })) })
/** Indice de insercion: null = arriba, undefined = al final, id = justo despues de ese. */
const slot = (ids: string[], afterId: string | null | undefined) => (afterId === undefined ? ids.length : afterId === null ? 0 : ids.indexOf(afterId) + 1)
const putCard = (b: Board, card: Card, afterId: string | null | undefined): Board => ({
  ...b,
  columns: b.columns.map((col) => {
    if (col.id !== card.columnId) return col
    const cards = col.cards.filter((c) => c.id !== card.id)
    cards.splice(slot(cards.map((c) => c.id), afterId), 0, card)
    return { ...col, cards }
  }),
})

export async function createColumn(name: string, afterId?: string | null): Promise<Column> {
  const col = await write(() => api.post<Column>('/board/columns', { name, ...(afterId !== undefined ? { afterId } : {}) }))
  const b = state.board
  if (b && !b.columns.some((c) => c.id === col.id)) {
    const cols = [...b.columns]
    cols.splice(slot(cols.map((c) => c.id), afterId), 0, { ...col, cards: col.cards ?? [] })
    set({ board: { ...b, columns: cols } })
  }
  return col
}
export const renameColumn = (id: string, name: string) =>
  optimistic(
    (b) => ({ ...b, columns: b.columns.map((c) => (c.id === id ? { ...c, name } : c)) }),
    () => api.patch<Column>(`/board/columns/${id}`, { name }),
  )
export const moveColumn = (id: string, afterId: string | null) =>
  optimistic(
    (b) => {
      const col = b.columns.find((c) => c.id === id)
      if (!col) return b
      const cols = b.columns.filter((c) => c.id !== id)
      cols.splice(slot(cols.map((c) => c.id), afterId), 0, col)
      return { ...b, columns: cols }
    },
    () => api.patch<Column>(`/board/columns/${id}`, { afterId }),
  )
export const deleteColumn = (id: string) =>
  optimistic(
    (b) => ({ ...b, columns: b.columns.filter((c) => c.id !== id) }),
    () => api.del(`/board/columns/${id}`),
  )

export interface NewCard {
  columnId: string
  title: string
  priority?: Priority
  afterId?: string | null
}
export async function createCard(n: NewCard): Promise<Card> {
  const { afterId, ...body } = n
  const card = await write(() => api.post<Card>('/board/cards', { ...body, ...(afterId !== undefined ? { afterId } : {}) }))
  const b = state.board
  if (b && !b.columns.some((c) => c.cards.some((k) => k.id === card.id))) set({ board: putCard(b, card, afterId) })
  return card
}
/** Mueve (o reordena) una tarjeta: al instante en pantalla y luego en el servidor. */
export function moveCard(id: string, columnId: string, afterId: string | null | undefined): Promise<void> {
  const cur = state.board?.columns.flatMap((c) => c.cards).find((c) => c.id === id)
  if (!cur || afterId === id) return Promise.resolve()
  return optimistic(
    (b) => putCard(dropCard(b, id), { ...cur, columnId }, afterId),
    () => api.post<Card>(`/board/cards/${id}/move`, { columnId, ...(afterId !== undefined ? { afterId } : {}) }),
  ).then((saved) => {
    const b = state.board
    if (b) set({ board: mapCards(b, (c) => (c.id === id ? { ...c, ...saved } : c)) })
  })
}
export async function fetchCard(id: string): Promise<Card> {
  return api.get<Card>(`/board/cards/${id}`)
}
/** Guarda cambios de contenido con If-Match; el servidor responde 409 si alguien guardo antes. */
export async function updateCard(id: string, patch: CardPatch, opt?: WriteOptions): Promise<Card> {
  const saved = await write(() => api.patch<Card>(`/board/cards/${id}`, patch, opt))
  const b = state.board
  if (b) set({ board: mapCards(b, (c) => (c.id === id ? { ...c, ...saved } : c)) })
  return saved
}
export async function archiveCard(id: string, on: boolean): Promise<Card> {
  const saved = await write(() => api.post<Card>(`/board/cards/${id}/${on ? 'archive' : 'unarchive'}`))
  if (on) {
    if (state.board) set({ board: dropCard(state.board, id) })
  } else refreshBoard() // vuelve a su lugar: el servidor sabe cual
  return saved
}
export const deleteCard = (id: string) =>
  optimistic(
    (b) => dropCard(b, id),
    () => api.del(`/board/cards/${id}`),
  )
export const loadArchived = () => api.get<Card[]>('/board/cards/archived')

// ---------- comentarios (la lista vive en el editor; aqui solo las llamadas y el contador de la tarjeta) ----------
const bump = (cardId: string, n: number) => {
  const b = state.board
  if (b) set({ board: mapCards(b, (c) => (c.id === cardId ? { ...c, comments: Math.max(0, c.comments + n) } : c)) })
}
export const loadComments = (cardId: string) => api.get<Comment[]>(`/board/cards/${cardId}/comments`)
export async function addComment(cardId: string, body: string): Promise<Comment> {
  const c = await api.post<Comment>(`/board/cards/${cardId}/comments`, { body })
  bump(cardId, 1)
  return c
}
export const editComment = (id: string, body: string) => api.patch<Comment>(`/board/comments/${id}`, { body })
export async function removeComment(cardId: string, id: string): Promise<void> {
  await api.del(`/board/comments/${id}`)
  bump(cardId, -1)
}
