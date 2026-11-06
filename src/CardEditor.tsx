import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { Blobvatar } from './blob'
import { useModal } from './useModal'
import { useSession } from './session'
import { useClients } from './store'
import { isConflict } from './api'
import { ago } from './time'
import {
  PRIORITIES,
  PRIORITY_LABEL,
  addComment,
  archiveCard,
  deleteCard,
  editComment,
  fetchCard,
  loadComments,
  loadMembers,
  moveCard,
  removeComment,
  subscribeCard,
  updateCard,
  useBoard,
  type Card,
  type CardPatch,
  type Comment,
  type Priority,
} from './boardData'

interface Draft {
  title: string
  description: string
  priority: Priority
  assigneeId: string
  clientId: string
  dueDate: string
}
const draftOf = (c: Card | null | undefined): Draft => ({
  title: c?.title ?? '',
  description: c?.description ?? '',
  priority: c?.priority ?? 'media',
  assigneeId: c?.assignee?.id ?? '',
  clientId: c?.client?.id ?? '',
  dueDate: c?.dueDate ?? '',
})
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** Detalle de una tarjeta (modal): datos editables con If-Match, mover a otra columna, archivar, eliminar y comentarios. */
export default function CardEditor({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useModal(ref, onClose)
  const session = useSession()
  const { board, members } = useBoard()
  const clients = useClients()
  const onBoard = useMemo(() => board?.columns.flatMap((c) => c.cards).find((c) => c.id === cardId), [board, cardId])
  const [card, setCard] = useState<Card | null>(onBoard ?? null) // ultima version del servidor que vio este editor
  const [f, setF] = useState<Draft>(() => draftOf(onBoard))
  const [loadErr, setLoadErr] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [cq, setCq] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const base = useRef(onBoard?.updatedAt) // la marca de contenido que se vio: va como If-Match
  const dirtyRef = useRef(false)
  const close = useRef(onClose)
  close.current = onClose

  const dirty = !!card && JSON.stringify(f) !== JSON.stringify(draftOf(card))
  dirtyRef.current = dirty

  const apply = (c: Card) => {
    setCard(c)
    setF(draftOf(c))
    base.current = c.updatedAt
  }
  const refresh = () =>
    fetchCard(cardId).then(
      (c) => {
        setLoadErr('')
        if (dirtyRef.current) {
          setCard(c)
          setNote('Esta tarjeta cambió mientras la editabas. Si guardas, se te avisará del conflicto.')
        } else {
          apply(c)
          setNote('')
        }
      },
      (e) => {
        if ((e as { status?: number }).status === 404) close.current() // la borraron
        else setLoadErr(msg(e, 'No se pudo cargar la tarjeta.'))
      },
    )

  // comentarios
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [cErr, setCErr] = useState('')
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const loadC = () =>
    loadComments(cardId).then(
      (l) => {
        setComments(l)
        setCErr('')
      },
      (e) => setCErr(msg(e, 'No se pudieron cargar los comentarios.')),
    )

  useEffect(() => {
    void refresh()
    void loadC()
    loadMembers().catch(() => {})
    return subscribeCard(cardId, () => {
      void refresh()
      void loadC()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((d) => ({ ...d, [k]: v }))

  const save = async () => {
    if (!card || busy || !dirty) return
    const title = f.title.trim()
    if (!title) return setErr('La tarjeta necesita un título.')
    const was = draftOf(card)
    const patch: CardPatch = {}
    if (title !== was.title) patch.title = title
    if (f.description !== was.description) patch.description = f.description
    if (f.priority !== was.priority) patch.priority = f.priority
    if (f.assigneeId !== was.assigneeId) patch.assigneeId = f.assigneeId || null
    if (f.clientId !== was.clientId) patch.clientId = f.clientId || null
    if (f.dueDate !== was.dueDate) patch.dueDate = f.dueDate || null
    setBusy(true)
    setErr('')
    try {
      apply(await updateCard(card.id, patch, { ifMatch: base.current }))
      setNote('')
    } catch (e) {
      if (isConflict(e)) {
        setErr('Alguien cambió esta tarjeta mientras la editabas. Se recargó con la versión actual: revisa y vuelve a aplicar tus cambios.')
        await refreshForce()
      } else setErr(msg(e, 'No se pudo guardar la tarjeta.'))
    } finally {
      setBusy(false)
    }
  }
  // tras un conflicto la version del servidor sustituye a los borradores
  const refreshForce = () => fetchCard(cardId).then(apply, () => {})

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr(msg(e, fallback))
    } finally {
      setBusy(false)
    }
  }
  const archived = !!card?.archivedAt
  const toggleArchive = () =>
    run(async () => {
      const saved = await archiveCard(cardId, !archived)
      if (!archived) close.current()
      else apply(saved)
    }, 'No se pudo archivar la tarjeta.')
  const remove = () => {
    if (!card) return
    if (!window.confirm(`¿Eliminar la tarjeta "${card.title}"?\n\nIrá a la papelera junto con sus comentarios y podrás restaurarla desde «Papelera y archivo».`)) return
    void run(async () => {
      await deleteCard(cardId)
      close.current()
    }, 'No se pudo eliminar la tarjeta.')
  }

  const columnId = onBoard?.columnId ?? card?.columnId ?? ''
  const cols = board?.columns ?? []

  const postComment = async () => {
    const t = body.trim()
    if (!t || posting) return
    setPosting(true)
    setCErr('')
    try {
      const c = await addComment(cardId, t)
      setComments((l) => (l && l.some((x) => x.id === c.id) ? l : [...(l ?? []), c]))
      setBody('')
    } catch (e) {
      setCErr(msg(e, 'No se pudo enviar el comentario.'))
    } finally {
      setPosting(false)
    }
  }
  const saveComment = async () => {
    if (!editing || !editing.body.trim()) return
    try {
      const c = await editComment(editing.id, editing.body.trim())
      setComments((l) => l && l.map((x) => (x.id === c.id ? c : x)))
      setEditing(null)
      setCErr('')
    } catch (e) {
      setCErr(msg(e, 'No se pudo guardar el comentario.'))
    }
  }
  const dropComment = async (c: Comment) => {
    if (!window.confirm('¿Eliminar este comentario?\n\nEs definitivo: no pasa por la papelera.')) return
    try {
      await removeComment(cardId, c.id)
      setComments((l) => l && l.filter((x) => x.id !== c.id))
      setCErr('')
    } catch (e) {
      setCErr(msg(e, 'No se pudo eliminar el comentario.'))
    }
  }

  const people = useMemo(() => {
    const list = members ? [...members] : []
    if (card?.assignee && !list.some((p) => p.id === card.assignee!.id)) list.push(card.assignee) // quien ya la lleva aunque ya no figure en la lista
    return list
  }, [members, card?.assignee])
  const clientName = f.clientId ? (clients.find((c) => c.id === f.clientId)?.name ?? (card?.client?.id === f.clientId ? card.client.name : 'Cliente')) : ''
  const results = useMemo(() => {
    const q = cq.trim().toLowerCase()
    return clients.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [clients, cq])

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet bd-sheet" role="dialog" aria-modal="true" aria-labelledby="bc-title" ref={ref} tabIndex={-1}>
        <header>
          <h2 id="bc-title">{archived ? 'Tarjeta archivada' : 'Tarjeta'}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        {!card ? (
          <div className="sheet-body">
            {loadErr ? (
              <p className="bd-state" role="alert">
                {loadErr}{' '}
                <button type="button" className="ghost" onClick={() => void refresh()}>
                  Reintentar
                </button>
              </p>
            ) : (
              <p className="bd-state" role="status">
                <i className="na-spin" aria-hidden="true" /> Cargando la tarjeta…
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="sheet-body">
              {note && (
                <p className="bd-note" role="status">
                  {note}
                </p>
              )}
              <label className="field">
                <span>Título</span>
                <input value={f.title} maxLength={200} onChange={(e) => set('title', e.target.value)} autoComplete="off" />
              </label>
              <label className="field">
                <span>Descripción</span>
                <textarea value={f.description} maxLength={4000} rows={4} onChange={(e) => set('description', e.target.value)} placeholder="Detalles, enlaces, acuerdos…" />
              </label>

              <div className="bd-grid">
                <label className="field">
                  <span>Prioridad</span>
                  <select value={f.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Responsable</span>
                  <select value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
                    <option value="">Sin responsable</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Fecha límite</span>
                  <input type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
                </label>
                <label className="field">
                  <span>Mover a…</span>
                  <select
                    value={columnId}
                    disabled={archived || busy}
                    onChange={(e) => {
                      if (e.target.value && e.target.value !== columnId) void run(() => moveCard(cardId, e.target.value, undefined), 'No se pudo mover la tarjeta.')
                    }}
                  >
                    {!cols.some((c) => c.id === columnId) && <option value={columnId}>—</option>}
                    {cols.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field">
                <span id="bc-client">Cliente (opcional)</span>
                {f.clientId ? (
                  <div className="bd-chosen">
                    <span>{clientName}</span>
                    <button type="button" className="bd-x" aria-label="Quitar el cliente" onClick={() => set('clientId', '')}>
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="bd-pick">
                    <input
                      type="search"
                      value={cq}
                      placeholder="Buscar cliente…"
                      aria-labelledby="bc-client"
                      autoComplete="off"
                      onChange={(e) => {
                        setCq(e.target.value)
                        setPickOpen(true)
                      }}
                      onFocus={() => setPickOpen(true)}
                      onBlur={() => setPickOpen(false)}
                    />
                    {pickOpen && (
                      <ul role="listbox" aria-label="Clientes">
                        {results.length === 0 ? (
                          <li className="none">{clients.length === 0 ? 'No hay clientes disponibles.' : 'Sin resultados.'}</li>
                        ) : (
                          results.map((c) => (
                            <li key={c.id} role="option" aria-selected={false}>
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  set('clientId', c.id)
                                  setCq('')
                                  setPickOpen(false)
                                }}
                              >
                                {c.name}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <p className="bd-by">
                Creada por {card.createdBy.name} {ago(card.createdAt)}
              </p>

              <section className="bd-comments" aria-labelledby="bc-cm">
                <h3 id="bc-cm">
                  Comentarios {comments && <em>{comments.length}</em>}
                </h3>
                {cErr && (
                  <p className="err" role="alert">
                    {cErr}
                  </p>
                )}
                {!comments ? (
                  <p className="none" role="status">
                    Cargando comentarios…
                  </p>
                ) : comments.length === 0 ? (
                  <p className="none">Aún no hay comentarios.</p>
                ) : (
                  <ul>
                    {comments.map((c) => {
                      const mine = !!session && c.author.id === session.id
                      const canDelete = mine || session?.role === 'ADMIN'
                      return (
                        <li key={c.id}>
                          <Blobvatar seed={c.author.avatar} size={30} />
                          <div>
                            <p className="bd-cm-head">
                              <b>{c.author.name}</b>
                              <time dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString('es-VE')}>
                                {ago(c.createdAt)}
                              </time>
                              {c.editedAt && <em>(editado)</em>}
                            </p>
                            {editing?.id === c.id ? (
                              <>
                                <textarea
                                  value={editing.body}
                                  maxLength={4000}
                                  rows={3}
                                  aria-label="Editar comentario"
                                  autoFocus
                                  onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      e.stopPropagation()
                                      setEditing(null)
                                    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveComment()
                                  }}
                                />
                                <span className="bd-cm-actions">
                                  <button type="button" className="add" disabled={!editing.body.trim()} onClick={() => void saveComment()}>
                                    Guardar
                                  </button>
                                  <button type="button" className="add" onClick={() => setEditing(null)}>
                                    Cancelar
                                  </button>
                                </span>
                              </>
                            ) : (
                              <>
                                <p className="bd-cm-body">{c.body}</p>
                                {(mine || canDelete) && (
                                  <span className="bd-cm-actions">
                                    {mine && (
                                      <button type="button" className="add" onClick={() => setEditing({ id: c.id, body: c.body })}>
                                        Editar
                                      </button>
                                    )}
                                    {canDelete && (
                                      <button type="button" className="add" onClick={() => void dropComment(c)}>
                                        Eliminar
                                      </button>
                                    )}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <div className="bd-cm-new">
                  <textarea
                    value={body}
                    maxLength={4000}
                    rows={2}
                    placeholder="Escribe un comentario… (Ctrl+Enter para enviar)"
                    aria-label="Nuevo comentario"
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault()
                        void postComment()
                      }
                    }}
                  />
                  <button type="button" className="primary" disabled={posting || !body.trim()} onClick={() => void postComment()}>
                    Comentar
                  </button>
                </div>
              </section>
            </div>

            <footer>
              {err ? (
                <p className="err" role="alert">
                  {err}
                </p>
              ) : (
                <span className="bd-grow" />
              )}
              <button type="button" className="ghost" disabled={busy} onClick={toggleArchive}>
                {archived ? 'Desarchivar' : 'Archivar'}
              </button>
              <button type="button" className="ghost danger" disabled={busy} onClick={remove}>
                Eliminar
              </button>
              <button type="button" className="primary" disabled={busy || !dirty || !f.title.trim()} onClick={() => void save()}>
                Guardar cambios
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
