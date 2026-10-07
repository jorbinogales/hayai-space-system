// Enlaces dentro de la app. El hash ya decide la pantalla (#clientes, #tareas...); `#clientes/<id>` abre ademas el cajon de ese cliente.
export type Target = { screen: 'clientes' | 'proyectos' | 'tareas' | 'finanzas'; clientId?: string | null }

/** Id de cliente del hash actual (`#clientes/<id>`), o null. */
export const hashClientId = (): string | null => {
  const [screen, id] = location.hash.slice(1).split('/')
  return screen === 'clientes' && id ? id : null
}

/** Lleva a una pantalla; con clientId abre el cajon de ese cliente (tambien si ya se esta en Clientes con ese mismo enlace). */
export function go(t: Target) {
  const h = t.clientId && t.screen === 'clientes' ? `clientes/${t.clientId}` : t.screen
  if (location.hash.slice(1) === h) window.dispatchEvent(new Event('hayai:open-client'))
  else location.hash = h
}
