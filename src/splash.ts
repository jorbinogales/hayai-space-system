/** Retira la pantalla de carga que vive en index.html (se pinta antes que el JS). Idempotente. */
export function hideSplash() {
  const el = document.getElementById('splash')
  if (!el || el.classList.contains('is-out')) return
  el.classList.add('is-out')
  const drop = () => el.remove()
  el.addEventListener('transitionend', drop, { once: true })
  window.setTimeout(drop, 1200) // por si la transicion no corre (pestaña oculta, movimiento reducido)
}
