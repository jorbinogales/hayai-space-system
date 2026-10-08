import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { loadAll } from './data'
import { archiveProject, useAllProjects } from './projectData'
import { archiveClient, useAllClients } from './store'
import { daysLeft, ago } from './time'
import { Icon, type IconName } from './ui'

interface TrashItem {
  id: string
  entity: 'cliente' | 'proyecto' | 'pago' | 'gasto' | 'tarea' | 'interaccion' | 'hito' | 'checklist_item' | 'mensaje'
  label: string
  detail: string | null
  via: string
  deletedBy: string
  deletedAt: string
  expiresAt: string
}

const KIND: Record<TrashItem['entity'], { label: string; icon: IconName }> = {
  cliente: { label: 'Cliente', icon: 'users' },
  proyecto: { label: 'Proyecto', icon: 'folder' },
  pago: { label: 'Cobro', icon: 'wallet' },
  gasto: { label: 'Gasto', icon: 'receipt' },
  tarea: { label: 'Tarea', icon: 'check' },
  interaccion: { label: 'Bitácora', icon: 'edit' },
  hito: { label: 'Hito', icon: 'check' },
  checklist_item: { label: 'Checklist', icon: 'check' },
  mensaje: { label: 'Mensaje', icon: 'chat' },
}

/** Papelera y archivo: lo borrado se restaura 30 días; lo archivado se recupera cuando quieras. Nada se pierde por un descuido. */
export default function Vault({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'papelera' | 'archivo'>('papelera')
  const [trash, setTrash] = useState<TrashItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sure, setSure] = useState<string | null>(null) // elemento cuyo borrado definitivo espera confirmación
  const clients = useAllClients().filter((c) => c.archived)
  const projects = useAllProjects().filter((p) => p.archived)

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const load = () =>
    api
      .get<TrashItem[]>('/trash')
      .then(setTrash)
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar la papelera.'))
  useEffect(() => void load(), [])

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la acción.')
    } finally {
      setBusy(null)
      setSure(null)
    }
  }

  // restaurar vuelve a meter filas en la base: se recargan todas las listas para que la web las vea
  const restore = (t: TrashItem) =>
    run(t.id, async () => {
      await api.post(`/trash/${t.id}/restore`)
      await Promise.all([loadAll(), load()])
    })
  const purge = (t: TrashItem) =>
    run(t.id, async () => {
      await api.del(`/trash/${t.id}`)
      await load()
    })

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet vt-sheet" role="dialog" aria-modal="true" aria-labelledby="vt-title">
        <header>
          <h2 id="vt-title">Papelera y archivo</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="vt-tabs">
          <div className="seg" role="tablist" aria-label="Sección">
            <button type="button" role="tab" aria-selected={tab === 'papelera'} className={tab === 'papelera' ? 'is-on' : ''} onClick={() => setTab('papelera')}>
              <Icon name="trash" size={15} />
              Papelera{trash && trash.length > 0 ? ` · ${trash.length}` : ''}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'archivo'} className={tab === 'archivo' ? 'is-on' : ''} onClick={() => setTab('archivo')}>
              <Icon name="archive" size={15} />
              Archivo{clients.length + projects.length > 0 ? ` · ${clients.length + projects.length}` : ''}
            </button>
          </div>
        </div>

        <div className="sheet-body" role="tabpanel">
          {tab === 'papelera' ? (
            <>
              <p className="ig-lede">Lo que se borra viene aquí y se puede restaurar durante 30 días, también lo que borre un agente con su llave.</p>
              {trash === null && !error && <p className="none">Cargando…</p>}
              {trash?.length === 0 && <p className="vt-empty">La papelera está vacía. Lo que borres aparecerá aquí, con quién lo hizo.</p>}
              <ul className="vt-list">
                {trash?.map((t) => {
                  const k = KIND[t.entity]
                  const left = daysLeft(t.expiresAt)
                  return (
                    <li key={t.id}>
                      <span className="vt-ico" aria-hidden="true">
                        <Icon name={k.icon} size={18} />
                      </span>
                      <div className="vt-main">
                        <strong>{t.label}</strong>
                        <small>
                          {k.label}
                          {t.detail ? ` · ${t.detail}` : ''}
                        </small>
                        <small>
                          Borrado {ago(t.deletedAt)} por {t.deletedBy}
                          {t.via.startsWith('api:') ? ` (agente ${t.via.slice(4)})` : ''} · se elimina para siempre en {left} {left === 1 ? 'día' : 'días'}
                        </small>
                      </div>
                      <div className="vt-act">
                        <button type="button" className="primary" disabled={busy === t.id} onClick={() => void restore(t)}>
                          Restaurar
                        </button>
                        {sure === t.id ? (
                          <button type="button" className="ghost danger" disabled={busy === t.id} onClick={() => void purge(t)}>
                            Confirmar: eliminar ya
                          </button>
                        ) : (
                          <button type="button" className="ghost" onClick={() => setSure(t.id)} aria-label={`Eliminar definitivamente ${t.label}`}>
                            Eliminar definitivamente
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <>
              <p className="ig-lede">Lo archivado se oculta, pero sigue contando en Finanzas.</p>
              {clients.length + projects.length === 0 && <p className="vt-empty">Nada archivado. Archiva a un cliente o proyecto que ya terminó para despejar tus pantallas.</p>}
              <ul className="vt-list">
                {clients.map((c) => (
                  <li key={c.id}>
                    <span className="vt-ico" aria-hidden="true">
                      <Icon name="users" size={18} />
                    </span>
                    <div className="vt-main">
                      <strong>{c.name}</strong>
                      <small>Cliente · {c.movements.length} movimientos</small>
                    </div>
                    <div className="vt-act">
                      <button type="button" className="ghost" disabled={busy === c.id} onClick={() => void run(c.id, () => archiveClient(c.id, false))}>
                        Desarchivar
                      </button>
                    </div>
                  </li>
                ))}
                {projects.map((p) => (
                  <li key={p.id}>
                    <span className="vt-ico" aria-hidden="true">
                      <Icon name={p.icon} size={18} />
                    </span>
                    <div className="vt-main">
                      <strong>{p.name}</strong>
                      <small>Proyecto de {p.client}</small>
                    </div>
                    <div className="vt-act">
                      <button type="button" className="ghost" disabled={busy === p.id} onClick={() => void run(p.id, () => archiveProject(p.id, false))}>
                        Desarchivar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer>
          <p className={error ? 'err' : 'none'} role="alert">
            {error}
          </p>
          <button type="button" className="primary" onClick={onClose}>
            Listo
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
