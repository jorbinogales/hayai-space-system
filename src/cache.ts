import { useSyncExternalStore } from 'react'

/** Lista en memoria con suscripcion para React: cada pantalla la lee con `use()` y se redibuja al cambiar. */
export function createList<T>() {
  let items: T[] = []
  const subs = new Set<() => void>()
  const emit = () => subs.forEach((f) => f())
  return {
    get: () => items,
    set(next: T[]) {
      items = next
      emit()
    },
    update(fn: (cur: T[]) => T[]) {
      items = fn(items)
      emit()
    },
    use: () =>
      useSyncExternalStore(
        (f) => (subs.add(f), () => void subs.delete(f)),
        () => items,
      ),
  }
}
