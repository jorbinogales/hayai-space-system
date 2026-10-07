// Aviso de actualización y guardarraíles. Tres piezas, todas en memoria salvo los borradores:
//  1) versión: la que cargó esta pestaña frente a la más alta que anuncia el servidor (cabecera X-Hayai-Version, evento en vivo
//     `version_nueva`, /version al arrancar). Si la del servidor es mayor, el banner pide recargar. NUNCA se recarga solo.
//  2) formularios con cambios sin guardar: se registran aquí; recargar con alguno abierto pide confirmación y nombra qué se perdería.
//  3) borradores: los formularios guardan en localStorage cada pocos segundos mientras se editan; al volver a abrirlos se ofrece
//     restaurar («Recuperamos tu borrador»). Se borran al guardar. Nunca se restauran solos.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, isConflict, watchServerVersion } from './api'

// ---------- estado ----------
export interface DirtyEntry {
  id: string
  /** "Cliente · Repostería Dulce", "Nuevo gasto" */
  label: string
  /** campos cambiados, ya en texto ("teléfono", "próxima acción") */
  fields: string[]
}
export interface ConflictRow {
  label: string
  mine: string
  theirs: string
}
export interface ConflictRequest {
  title: string
  /** instante ISO en que se guardó la versión que ganó */
  savedAt: string
  rows: ConflictRow[]
  resolve: (choice: 'theirs' | 'mine') => void
}
interface State {
  /** versión con la que cargó esta pestaña (null hasta que el servidor la diga) */
  running: string | null
  /** la más alta que se ha visto anunciada */
  latest: string | null
  dirty: DirtyEntry[]
  /** el diálogo «Tienes cambios sin guardar» está abierto */
  reloadAsk: boolean
  changelog: { open: boolean; version: string | null }
  conflict: ConflictRequest | null
}

let state: State = { running: null, latest: null, dirty: [], reloadAsk: false, changelog: { open: false, version: null }, conflict: null }
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export const useUpdates = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  )

// ---------- versión ----------
const parts = (v: string) => v.split('.').map(Number)
/** ¿a es una versión posterior a b? (comparación numérica: 1.10.0 es posterior a 1.9.0) */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
/** Hay una versión más nueva que la que cargó esta pestaña. */
export const updateAvailable = (s: State) => s.running !== null && s.latest !== null && isNewer(s.latest, s.running)

/** Una versión vista en cualquier fuente (cabecera de respuesta, evento en vivo, consulta). La primera es la de esta pestaña. */
export function noteVersion(v: string | null | undefined) {
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) return
  if (state.running === null) return set({ running: v, latest: v })
  if (state.latest === null || isNewer(v, state.latest)) set({ latest: v })
}

let started = false
/** Arranca la vigilancia de versión y el aviso nativo al cerrar con cambios. Se llama al entrar con sesión. */
export function startUpdates() {
  if (started) return
  started = true
  watchServerVersion(noteVersion)
  window.addEventListener('beforeunload', onBeforeUnload)
  // La versión de esta pestaña es la que el servidor decía cuando cargó: se fija con la primera consulta.
  void api
    .get<{ version: string }>('/version')
    .then((r) => noteVersion(r.version))
    .catch(() => {})
}
export function stopUpdates() {
  started = false
  watchServerVersion(null)
  window.removeEventListener('beforeunload', onBeforeUnload)
  dirty.clear()
  set({ running: null, latest: null, dirty: [], reloadAsk: false, changelog: { open: false, version: null }, conflict: null })
}

// ---------- recargar ----------
/** «Recargar página»: con cambios sin guardar pide confirmación; si no, recarga. */
export function requestReload() {
  if (state.dirty.length) return set({ reloadAsk: true })
  location.reload()
}
export const cancelReload = () => set({ reloadAsk: false })
export const confirmReload = () => location.reload()

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!state.dirty.length) return
  e.preventDefault()
  e.returnValue = '' // el navegador pone su propio texto
}

// ---------- historial de versiones ----------
/** Abre el historial de versiones (opcionalmente resaltando una versión: el botón «Ver cambios»). */
export const openChangelog = (version: string | null = null) => set({ changelog: { open: true, version } })
export const closeChangelog = () => set({ changelog: { open: false, version: null } })

// ---------- formularios con cambios ----------
const dirty = new Map<string, DirtyEntry>()
function syncDirty() {
  set({ dirty: [...dirty.values()] })
}
const sameFields = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Marca un formulario como «con cambios» mientras `fields` no esté vacío. */
export function useDirty(id: string, label: string, fields: string[]) {
  useEffect(() => {
    const cur = dirty.get(id)
    if (!fields.length) {
      if (cur) {
        dirty.delete(id)
        syncDirty()
      }
      return
    }
    if (!cur || cur.label !== label || !sameFields(cur.fields, fields)) {
      dirty.set(id, { id, label, fields })
      syncDirty()
    }
  })
  // al cerrarse el formulario deja de contar
  useEffect(
    () => () => {
      if (dirty.delete(id)) syncDirty()
    },
    [id],
  )
}

// ---------- borradores (localStorage) ----------
const DRAFT_PREFIX = 'hayai:draft:'
const DRAFT_MS = 3000
const DRAFT_TTL = 7 * 86_400_000
let owner = ''
/** Los borradores son de quien los escribió: se separan por socio y se borran al cerrar sesión. */
export const setDraftOwner = (id: string) => void (owner = id)
const draftKey = (key: string) => `${DRAFT_PREFIX}${owner}:${key}`
const read = (key: string): { at: number; values: unknown } | null => {
  try {
    const raw = localStorage.getItem(draftKey(key))
    if (!raw) return null
    const d = JSON.parse(raw) as { at: number; values: unknown }
    if (typeof d.at !== 'number' || Date.now() - d.at > DRAFT_TTL) {
      localStorage.removeItem(draftKey(key))
      return null
    }
    return d
  } catch {
    return null
  }
}
const write = (key: string, values: unknown) => {
  try {
    localStorage.setItem(draftKey(key), JSON.stringify({ at: Date.now(), values }))
  } catch {
    /* sin espacio o modo privado: el borrador es un extra, no se rompe nada */
  }
}
const remove = (key: string) => {
  try {
    localStorage.removeItem(draftKey(key))
  } catch {
    /* igual */
  }
}
/** Cierre de sesión: ningún borrador queda en un navegador compartido. */
export function clearAllDrafts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k)
  } catch {
    /* igual */
  }
}

export interface Guard {
  /** campos que ya no coinciden con lo guardado, en texto */
  changed: string[]
  /** borrador recuperado de una sesión anterior (null = no hay, o ya se resolvió) */
  draft: { at: number } | null
  restore: () => void
  discard: () => void
  /** se guardó: el formulario queda limpio y su borrador se borra */
  saved: () => void
}

/**
 * Guardarraíles de un formulario: lo registra como «con cambios» (confirmación al recargar), guarda un borrador cada pocos
 * segundos y ofrece restaurarlo al volver. `labels` dice qué campos vigilar y cómo se llaman en los avisos.
 * `initial` son los valores guardados (los del servidor); `values`, los que se ven en pantalla ahora.
 */
export function useFormGuard<T extends Record<string, unknown>>(opts: {
  /** identidad estable del formulario: «cliente:<id>», «gasto:nuevo» */
  id: string
  /** cómo se muestra: «Cliente · Repostería Dulce» */
  label: string
  values: T
  initial: T
  labels: { [K in keyof T]?: string }
  apply: (v: T) => void
}): Guard {
  const { id, label, values, initial, labels, apply } = opts
  const changed = (Object.keys(labels) as (keyof T)[]).filter((k) => JSON.stringify(values[k] ?? '') !== JSON.stringify(initial[k] ?? '')).map((k) => labels[k] as string)
  useDirty(id, label, changed)

  const [draft, setDraft] = useState<{ at: number; values: T } | null>(() => (read(id) as { at: number; values: T } | null) ?? null)
  const latest = useRef({ values, changed })
  latest.current = { values, changed }
  const live = useRef(true)

  const persist = useCallback(() => {
    if (!live.current) return
    if (latest.current.changed.length) write(id, latest.current.values)
    else remove(id)
  }, [id])
  useEffect(() => {
    live.current = true
    const t = window.setInterval(persist, DRAFT_MS)
    const hide = () => document.hidden && persist()
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', persist)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', persist)
    }
  }, [persist])

  return {
    changed,
    draft: draft ? { at: draft.at } : null,
    restore: () => {
      if (draft) apply(draft.values)
      remove(id)
      setDraft(null)
    },
    discard: () => {
      remove(id)
      setDraft(null)
    },
    saved: () => {
      live.current = false // un último intervalo no debe reescribir lo recién guardado
      remove(id)
      setDraft(null)
    },
  }
}

// ---------- conflictos al guardar ----------
/** Muestra el diálogo de conflicto y devuelve lo que eligió quien editaba. Solo uno a la vez; Esc = usar la guardada (no pisa nada). */
export function askConflict(req: Omit<ConflictRequest, 'resolve'>): Promise<'theirs' | 'mine'> {
  return new Promise((resolve) => {
    state.conflict?.resolve('theirs')
    set({
      conflict: {
        ...req,
        resolve: (c) => {
          set({ conflict: null })
          resolve(c)
        },
      },
    })
  })
}

/** Texto corto de un valor para el diálogo de conflicto. */
export const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v))

export type Saved<T> = { kind: 'saved'; value: T } | { kind: 'adopted'; values: Record<string, unknown>; stamp: string | undefined }

/**
 * Guarda mandando la marca que vio quien edita (If-Match). Si alguien guardó antes (409), trae lo guardado, muestra solo los campos
 * que difieren y deja elegir; nunca pisa en silencio. «Mantener lo mío» vuelve a guardar con la marca actual; «Usar la guardada»
 * devuelve sus valores para que el formulario los adopte.
 */
export async function saveGuarded<T>(o: {
  title: string
  base: string | undefined
  save: (ifMatch: string | undefined) => Promise<T>
  /** vuelve a leer el registro guardado: su marca y sus valores */
  fresh: () => Promise<{ stamp: string | undefined; values: Record<string, unknown> }>
  mine: Record<string, unknown>
  /** campo → nombre en el diálogo */
  labels: Record<string, string>
}): Promise<Saved<T>> {
  let base = o.base
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { kind: 'saved', value: await o.save(base) }
    } catch (e) {
      if (!isConflict(e)) throw e
      const fresh = await o.fresh()
      const rows = Object.keys(o.labels)
        .filter((k) => show(o.mine[k]) !== show(fresh.values[k]))
        .map((k) => ({ label: o.labels[k], mine: show(o.mine[k]), theirs: show(fresh.values[k]) }))
      const choice = await askConflict({ title: o.title, savedAt: e.data.actualizado_el, rows })
      if (choice === 'theirs') return { kind: 'adopted', values: fresh.values, stamp: fresh.stamp }
      base = fresh.stamp // lo mío, sobre lo último guardado
    }
  }
  throw new Error('El registro sigue cambiando; inténtalo de nuevo en un momento.')
}
