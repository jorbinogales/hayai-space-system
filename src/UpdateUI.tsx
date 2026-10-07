// Piezas visibles del aviso de actualización y de los guardarraíles (la lógica vive en updates.ts):
// banner «Recargar página», confirmación al recargar con cambios, diálogo de conflicto y la barra «Recuperamos tu borrador».
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ago } from './time'
import { cancelReload, confirmReload, openChangelog, requestReload, updateAvailable, useUpdates, type Guard } from './updates'

/** Aviso fijo abajo: avisa que hay versión nueva, no tapa nada y no se puede ignorar sin más (se queda hasta recargar). */
export function UpdateBanner() {
  const u = useUpdates()
  if (!updateAvailable(u)) return null
  return (
    <div className="upd-banner" role="status" aria-live="polite">
      <span className="upd-dot" aria-hidden="true" />
      <div className="upd-text">
        <b>Hay una versión nueva (v{u.latest}).</b>
        {u.dirty.length > 0 ? <small>Si recargas ahora, cualquier cambio no guardado se perderá.</small> : <small>Recarga cuando te quede bien.</small>}
      </div>
      <button type="button" className="upd-link" onClick={() => openChangelog(u.latest)}>
        Ver cambios
      </button>
      <button type="button" className="primary" onClick={requestReload}>
        Recargar página
      </button>
    </div>
  )
}

/** Escape y foco inicial para los diálogos de aviso. */
function useDialog(onEscape: () => void) {
  const first = useRef<HTMLButtonElement>(null)
  const esc = useRef(onEscape)
  esc.current = onEscape
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    first.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      esc.current()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      prev?.focus?.()
    }
  }, [])
  return first
}

function ReloadDialog() {
  const u = useUpdates()
  const first = useDialog(cancelReload)
  return createPortal(
    <div className="modal upd-modal" onMouseDown={(e) => e.target === e.currentTarget && cancelReload()}>
      <div className="sheet upd-sheet" role="alertdialog" aria-modal="true" aria-labelledby="upd-title" aria-describedby="upd-desc">
        <div className="upd-body">
          <h2 id="upd-title">Tienes cambios sin guardar</h2>
          <p id="upd-desc">Si recargas ahora, esto se pierde:</p>
          <ul className="upd-list">
            {u.dirty.map((d) => (
              <li key={d.id}>
                <b>{d.label}</b>
                <small>{d.fields.join(', ')} sin guardar</small>
              </li>
            ))}
          </ul>
          <p className="upd-note">Guardamos un borrador en este navegador cada pocos segundos y te lo ofrecemos al volver, pero lo último que escribiste puede quedar fuera.</p>
        </div>
        <footer>
          <button type="button" className="ghost" onClick={confirmReload}>
            Recargar de todos modos
          </button>
          <button ref={first} type="button" className="primary" onClick={cancelReload}>
            Seguir editando
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function ConflictDialog() {
  const { conflict } = useUpdates()
  const first = useDialog(() => conflict?.resolve('theirs'))
  if (!conflict) return null
  const time = new Date(conflict.savedAt).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' })
  return createPortal(
    <div className="modal upd-modal">
      <div className="sheet upd-sheet" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" aria-describedby="cf-desc">
        <div className="upd-body">
          <h2 id="cf-title">{conflict.title}</h2>
          <p id="cf-desc">
            Guardado a las {time} ({ago(conflict.savedAt)}). No se sobrescribió nada.
          </p>
          {conflict.rows.length > 0 ? (
            <table className="cf-table">
              <thead>
                <tr>
                  <th scope="col">Campo</th>
                  <th scope="col">Tu versión</th>
                  <th scope="col">Guardada</th>
                </tr>
              </thead>
              <tbody>
                {conflict.rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td>{r.mine}</td>
                    <td>{r.theirs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="upd-note">Los campos que editaste coinciden con lo guardado; solo cambió otra parte del registro.</p>
          )}
          <p className="upd-note">Solo se listan los campos que difieren. Elegir una opción vuelve a guardar con la versión actual.</p>
        </div>
        <footer>
          <button type="button" className="ghost" onClick={() => conflict.resolve('mine')}>
            Mantener lo mío
          </button>
          <button ref={first} type="button" className="primary" onClick={() => conflict.resolve('theirs')}>
            Usar la guardada
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/** Un solo lugar para los diálogos globales; va una vez en App. */
export function UpdateHost() {
  const u = useUpdates()
  return (
    <>
      <UpdateBanner />
      {u.reloadAsk && u.dirty.length > 0 && <ReloadDialog />}
      {u.conflict && <ConflictDialog />}
    </>
  )
}

/** «Recuperamos tu borrador de hace 4 min» con Restaurar / Descartar. Va dentro del formulario, arriba. */
export function DraftBar({ guard }: { guard: Guard }) {
  if (!guard.draft) return null
  return (
    <div className="draft-bar" role="group" aria-label="Borrador recuperado">
      <p>
        <b>Recuperamos tu borrador</b> de {ago(new Date(guard.draft.at).toISOString())}.
      </p>
      <div>
        <button type="button" className="draft-restore" onClick={guard.restore}>
          Restaurar
        </button>
        <button type="button" className="draft-discard" onClick={guard.discard}>
          Descartar
        </button>
      </div>
    </div>
  )
}
