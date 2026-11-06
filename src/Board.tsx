import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, ZoomControls } from './ui'
import { Blobvatar } from './blob'
import { useCosmos } from './Cosmos'
import { reduced } from './warp'
import { fmtDate } from './store'
import { useModal } from './useModal'
import {
  PRIORITY_LABEL,
  boardNow,
  createCard,
  createColumn,
  deleteColumn,
  holdBoard,
  isLate,
  loadArchived,
  loadBoard,
  moveCard,
  moveColumn,
  archiveCard,
  renameColumn,
  useBoard,
  type Card,
  type Column,
} from './boardData'
import CardEditor from './CardEditor'
import './board.css'

type Drag = { kind: 'card' | 'col'; id: string }
type DropAt = { kind: 'card'; colId: string; afterId: string | null } | { kind: 'col'; afterId: string | null }

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** Id de la tarjeta tras la que caeria algo soltado a la altura `y` en esa lista (null = arriba). La tarjeta arrastrada no cuenta. */
function cardAfter(list: HTMLElement, y: number, dragId: string): string | null {
  let after: string | null = null
  for (const el of list.querySelectorAll<HTMLElement>('[data-card-id]')) {
    if (el.dataset.cardId === dragId) continue
    const r = el.getBoundingClientRect()
    if (y > r.top + r.height / 2) after = el.dataset.cardId ?? null
    else break
  }
  return after
}
/** Lo mismo para columnas, por la horizontal. */
function colAfter(scroller: HTMLElement, x: number, dragId: string): string | null {
  let after: string | null = null
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-col-id]')) {
    if (el.dataset.colId === dragId) continue
    const r = el.getBoundingClientRect()
    if (x > r.left + r.width / 2) after = el.dataset.colId ?? null
    else break
  }
  return after
}

/** Tarjeta dentro de una columna: título, prioridad, responsable, cliente, fecha límite y comentarios. */
function CardView({ card, onOpen, onDragStart, onDragEnd, onKeyMove, dragging }: { card: Card; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void; onKeyMove: (dir: 'left' | 'right' | 'up' | 'down') => void; dragging: boolean }) {
  const late = isLate(card)
  return (
    <li>
      <div
        className={`bd-card${dragging ? ' is-dragging' : ''}`}
        data-card-id={card.id}
        role="button"
        tabIndex={0}
        draggable
        aria-label={`Tarjeta: ${card.title}. Prioridad ${PRIORITY_LABEL[card.priority].toLowerCase()}${card.assignee ? `, responsable ${card.assignee.name}` : ''}${card.dueDate ? `, vence el ${fmtDate(card.dueDate, true)}${late ? ' (vencida)' : ''}` : ''}. Enter para abrir; Alt y flechas para moverla.`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          } else if (e.altKey && e.key.startsWith('Arrow')) {
            e.preventDefault()
            onKeyMove(e.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down')
          }
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', card.id)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <span className="bd-card-title">{card.title}</span>
        <span className="bd-card-meta">
          <span className={`bd-prio p-${card.priority}`}>{PRIORITY_LABEL[card.priority]}</span>
          {card.client && (
            <span className="bd-client" title={`Cliente: ${card.client.name}`}>
              {card.client.name}
            </span>
          )}
          {card.dueDate && (
            <span className={`bd-due${late ? ' late' : ''}`} title={late ? 'Fecha límite vencida' : 'Fecha límite'}>
              <Icon name="calendar" size={12} />
              {fmtDate(card.dueDate, true)}
            </span>
          )}
          {card.comments > 0 && (
            <span className="bd-cm" title={`${card.comments} ${card.comments === 1 ? 'comentario' : 'comentarios'}`}>
              <Icon name="chat" size={12} />
              {card.comments}
            </span>
          )}
          {card.assignee && (
            <span className="bd-who" title={`Responsable: ${card.assignee.name}`}>
              <Blobvatar seed={card.assignee.avatar} size={24} />
            </span>
          )}
        </span>
      </div>
    </li>
  )
}

/** Campo en línea para escribir un nombre/título: Enter guarda, Escape cancela. */
function Inline({ placeholder, label, max, open, setOpen, onSubmit, cta }: { placeholder: string; label: string; max: number; open: boolean; setOpen: (v: boolean) => void; onSubmit: (v: string) => Promise<void>; cta: string }) {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  if (!open)
    return (
      <button type="button" className="bd-add" onClick={() => setOpen(true)}>
        <Icon name="plus" size={15} />
        {cta}
      </button>
    )
  const submit = async () => {
    const t = v.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onSubmit(t)
      setV('')
    } catch {
      /* el aviso de error lo muestra la pantalla; el texto se conserva para reintentar */
    } finally {
      setBusy(false)
      window.setTimeout(() => input.current?.focus(), 0) // el campo estaba deshabilitado mientras se guardaba: se recupera el foco tras el repintado
    }
  }
  return (
    <form
      className="bd-inline"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        ref={input}
        value={v}
        maxLength={max}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        disabled={busy}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            setV('')
            setOpen(false)
          }
        }}
      />
      <span>
        <button type="submit" className="primary" disabled={busy || !v.trim()}>
          Añadir
        </button>
        <button
          type="button"
          className="bd-x"
          aria-label="Cancelar"
          onClick={() => {
            setV('')
            setOpen(false)
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </span>
    </form>
  )
}

interface ColProps {
  col: Column
  dropAt: DropAt | null
  /** una columna arrastrada caería justo antes de esta */
  dropBefore: boolean
  drag: Drag | null
  onFail: (m: string) => void
  onOpen: (id: string) => void
  startDrag: (d: Drag) => void
  endDrag: () => void
  overCard: (colId: string, e: React.DragEvent<HTMLElement>) => void
  dropCard: (colId: string, e: React.DragEvent<HTMLElement>) => void
  keyMove: (card: Card, dir: 'left' | 'right' | 'up' | 'down') => void
}

function ColumnView({ col, dropAt, dropBefore, drag, onFail, onOpen, startDrag, endDrag, overCard, dropCard, keyMove }: ColProps) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(col.name)
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const menuWrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const out = (e: PointerEvent) => !menuWrap.current?.contains(e.target as Node) && setMenu(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('pointerdown', out)
    window.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const commitName = () => {
    const t = name.trim()
    setRenaming(false)
    if (!t || t === col.name) return setName(col.name)
    renameColumn(col.id, t).catch((e) => {
      setName(col.name)
      onFail(msg(e, 'No se pudo renombrar la columna.'))
    })
  }
  const remove = () => {
    setMenu(false)
    const n = col.cards.length
    if (
      !window.confirm(
        `¿Eliminar la columna "${col.name}"?\n\nIrá a la papelera junto con ${n === 0 ? 'sus tarjetas archivadas, si las tiene' : n === 1 ? 'su tarjeta' : `sus ${n} tarjetas`} (también las archivadas) y sus comentarios. Podrás restaurarla desde «Papelera y archivo».`,
      )
    )
      return
    deleteColumn(col.id).catch((e) => onFail(msg(e, 'No se pudo eliminar la columna.')))
  }
  const slotHere = dropAt?.kind === 'card' && dropAt.colId === col.id ? dropAt : null

  return (
    <section
      className={`bd-col${drag?.kind === 'col' && drag.id === col.id ? ' is-dragging' : ''}${slotHere ? ' is-over' : ''}${dropBefore ? ' drop-before' : ''}`}
      data-col-id={col.id}
      aria-label={`Columna ${col.name}, ${col.cards.length} ${col.cards.length === 1 ? 'tarjeta' : 'tarjetas'}`}
      onDragOver={(e) => drag?.kind === 'card' && overCard(col.id, e)}
      onDrop={(e) => drag?.kind === 'card' && dropCard(col.id, e)}
    >
      <header
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', col.id)
          startDrag({ kind: 'col', id: col.id })
        }}
        onDragEnd={endDrag}
        title="Arrastra la cabecera para mover la columna"
      >
        {renaming ? (
          <input
            className="bd-rename"
            value={name}
            maxLength={60}
            autoFocus
            aria-label="Nombre de la columna"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.stopPropagation()
                setName(col.name)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="bd-col-name"
            title="Clic para renombrar"
            onClick={() => {
              setName(col.name)
              setRenaming(true)
            }}
          >
            {col.name}
          </button>
        )}
        <em>{col.cards.length}</em>
        <div className="bd-menu" ref={menuWrap}>
          <button type="button" className="bd-x" aria-haspopup="menu" aria-expanded={menu} aria-label={`Opciones de la columna ${col.name}`} onClick={() => setMenu((m) => !m)}>
            <span aria-hidden="true">⋯</span>
          </button>
          {menu && (
            <div className="bd-pop" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false)
                  setName(col.name)
                  setRenaming(true)
                }}
              >
                Renombrar
              </button>
              <button type="button" role="menuitem" className="danger" onClick={remove}>
                Eliminar columna…
              </button>
            </div>
          )}
        </div>
      </header>

      <ul className="bd-list" data-list={col.id}>
        {slotHere && slotHere.afterId === null && <li className="bd-drop" aria-hidden="true" />}
        {col.cards.map((c) => (
          <Fragment key={c.id}>
            <CardView
              card={c}
              dragging={drag?.kind === 'card' && drag.id === c.id}
              onOpen={() => onOpen(c.id)}
              onDragStart={() => startDrag({ kind: 'card', id: c.id })}
              onDragEnd={endDrag}
              onKeyMove={(d) => keyMove(c, d)}
            />
            {slotHere && slotHere.afterId === c.id && <li className="bd-drop" aria-hidden="true" />}
          </Fragment>
        ))}
      </ul>

      <footer>
        <Inline
          open={adding}
          setOpen={setAdding}
          placeholder="Título de la tarjeta…"
          label={`Título de la nueva tarjeta en ${col.name}`}
          max={200}
          cta="Añadir tarjeta"
          onSubmit={async (t) => {
            try {
              await createCard({ columnId: col.id, title: t })
            } catch (e) {
              onFail(msg(e, 'No se pudo crear la tarjeta.'))
              throw e
            }
          }}
        />
      </footer>
    </section>
  )
}

/** Tarjetas archivadas: se pueden abrir o devolver a su sitio. */
function ArchivedSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useModal(ref, onClose)
  const [list, setList] = useState<Card[] | null>(null)
  const [err, setErr] = useState('')
  const load = () => {
    setErr('')
    loadArchived().then(setList, (e) => setErr(msg(e, 'No se pudieron cargar las tarjetas archivadas.')))
  }
  useEffect(load, [])
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet bd-sheet is-narrow" role="dialog" aria-modal="true" aria-labelledby="bd-arch-t" ref={ref} tabIndex={-1}>
        <header>
          <h2 id="bd-arch-t">Tarjetas archivadas</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sheet-body">
          {err ? (
            <p className="bd-state" role="alert">
              {err}{' '}
              <button type="button" className="ghost" onClick={load}>
                Reintentar
              </button>
            </p>
          ) : !list ? (
            <p className="bd-state" role="status">
              Cargando…
            </p>
          ) : list.length === 0 ? (
            <p className="bd-state">No hay tarjetas archivadas.</p>
          ) : (
            <ul className="bd-arch">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" className="bd-arch-t" onClick={() => onOpen(c.id)}>
                    {c.title}
                  </button>
                  <button
                    type="button"
                    className="add"
                    onClick={() =>
                      archiveCard(c.id, false).then(
                        () => setList((l) => l && l.filter((x) => x.id !== c.id)),
                        (e) => setErr(msg(e, 'No se pudo devolver la tarjeta.')),
                      )
                    }
                  >
                    Devolver al tablero
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Pantalla Tablero: kanban con columnas y tarjetas que se arrastran. El planeta se queda a un costado, como en Tareas. */
export default function Board({ onBack }: { onBack: () => void }) {
  const { world } = useCosmos()
  const { board, status, error } = useBoard()
  const [openId, setOpenId] = useState<string | null>(null)
  const [archived, setArchived] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [fail, setFail] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [addingCol, setAddingCol] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  const dropRef = useRef<DropAt | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const refocus = useRef<string | null>(null)

  useEffect(() => {
    world.screenRate = null // gira a la velocidad propia del planeta
  }, [world])
  useEffect(() => {
    if (!boardNow()) void loadBoard().catch(() => {})
  }, [])
  // soltar con el teclado mueve la tarjeta de columna: se le devuelve el foco donde quedó
  useEffect(() => {
    if (!refocus.current) return
    document.querySelector<HTMLElement>(`[data-card-id="${refocus.current}"]`)?.focus()
    refocus.current = null
  }, [board])
  useEffect(() => () => {
    if (dragRef.current) holdBoard(false) // se salió de la pantalla en pleno arrastre
  }, [])

  const back = () => {
    setExiting(true)
    window.setTimeout(onBack, reduced() ? 50 : 300)
  }
  const failWith = (m: string) => {
    setFail(m)
  }

  const setDrop = (d: DropAt | null) => {
    const p = dropRef.current
    if (p === d || (p && d && p.kind === d.kind && p.afterId === d.afterId && (p.kind === 'col' || (d.kind === 'card' && p.colId === d.colId)))) return
    dropRef.current = d
    setDropAt(d)
  }
  const startDrag = (d: Drag) => {
    if (dragRef.current) return
    dragRef.current = d
    holdBoard(true)
    window.setTimeout(() => dragRef.current && setDrag(dragRef.current), 0) // tocar el DOM en el propio dragstart puede cancelar el arrastre
  }
  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    dropRef.current = null
    setDrag(null)
    setDropAt(null)
    holdBoard(false)
  }

  const cols = board?.columns ?? []
  const allCards = useMemo(() => cols.flatMap((c) => c.cards), [cols])
  const late = allCards.filter(isLate).length

  const overCard = (colId: string, e: React.DragEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d || d.kind !== 'card') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const list = e.currentTarget.querySelector<HTMLElement>('[data-list]')
    if (list) setDrop({ kind: 'card', colId, afterId: cardAfter(list, e.clientY, d.id) })
  }
  const dropCard = (colId: string, e: React.DragEvent<HTMLElement>) => {
    const d = dragRef.current
    const at = dropRef.current
    if (!d || d.kind !== 'card') return
    e.preventDefault()
    endDrag()
    if (!at || at.kind !== 'card' || at.colId !== colId) return
    const col = cols.find((c) => c.id === colId)
    const ids = col?.cards.map((c) => c.id) ?? []
    const i = ids.indexOf(d.id)
    if (i >= 0 && (i === 0 ? null : ids[i - 1]) === at.afterId) return // soltada donde ya estaba
    moveCard(d.id, colId, at.afterId).catch((er) => failWith(msg(er, 'No se pudo mover la tarjeta.')))
  }

  // teclado: Alt + flechas mueve la tarjeta a la columna vecina (al final) o la sube/baja dentro de su columna
  const keyMove = (card: Card, dir: 'left' | 'right' | 'up' | 'down') => {
    const ci = cols.findIndex((c) => c.id === card.columnId)
    const col = cols[ci]
    if (!col) return
    const ids = col.cards.map((c) => c.id)
    const i = ids.indexOf(card.id)
    let p: Promise<void> | null = null
    if (dir === 'left' || dir === 'right') {
      const to = cols[ci + (dir === 'left' ? -1 : 1)]
      if (to) p = moveCard(card.id, to.id, to.cards.length ? to.cards[to.cards.length - 1].id : null)
    } else if (dir === 'up' && i > 0) p = moveCard(card.id, col.id, i >= 2 ? ids[i - 2] : null)
    else if (dir === 'down' && i < ids.length - 1) p = moveCard(card.id, col.id, ids[i + 1])
    if (!p) return
    refocus.current = card.id
    p.catch((er) => failWith(msg(er, 'No se pudo mover la tarjeta.')))
  }

  // arrastrar columnas + desplazamiento automático en los bordes
  const overScroller = (e: React.DragEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    if (e.clientX < r.left + 60) el.scrollLeft -= 18
    else if (e.clientX > r.right - 60) el.scrollLeft += 18
    if (d.kind === 'col') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDrop({ kind: 'col', afterId: colAfter(el, e.clientX, d.id) })
    }
  }
  const dropScroller = (e: React.DragEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const at = dropRef.current
    if (!d || d.kind !== 'col') return
    e.preventDefault()
    endDrag()
    if (!at || at.kind !== 'col') return
    const i = cols.findIndex((c) => c.id === d.id)
    if ((i <= 0 ? null : cols[i - 1].id) === at.afterId) return
    moveColumn(d.id, at.afterId).catch((er) => failWith(msg(er, 'No se pudo mover la columna.')))
  }

  // dónde caería una columna arrastrada: antes de qué columna (null = al final, junto a «Añadir columna»)
  let beforeId: string | null | undefined
  if (drag?.kind === 'col' && dropAt?.kind === 'col') {
    const rest = cols.filter((c) => c.id !== drag.id)
    beforeId = rest[dropAt.afterId === null ? 0 : rest.findIndex((c) => c.id === dropAt.afterId) + 1]?.id ?? null
  }

  return (
    <main className={`screen layer bd-screen arriving${exiting ? ' exiting' : ''}`}>
      <div className="overlay">
        <div className="clients-left">
          <button className="back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>
        </div>

        <section className="plist bd" aria-label="Tablero">
          <header className="plist-head">
            <h1>Tablero</h1>
            <div className="plist-side">
              {board && (
                <p>
                  <span>
                    <b>{allCards.length}</b> {allCards.length === 1 ? 'tarjeta' : 'tarjetas'}
                  </span>
                  {late > 0 && (
                    <span className="bd-late-count">
                      <b>{late}</b> {late === 1 ? 'vencida' : 'vencidas'}
                    </span>
                  )}
                </p>
              )}
              {board && (
                <button type="button" className="bd-link" onClick={() => setArchived(true)}>
                  <Icon name="archive" size={15} />
                  Archivadas
                </button>
              )}
            </div>
          </header>

          {fail && (
            <p className="bd-fail" role="alert">
              <span>{fail}</span>
              <button type="button" className="bd-x" aria-label="Cerrar aviso" onClick={() => setFail('')}>
                <Icon name="close" size={14} />
              </button>
            </p>
          )}

          {!board ? (
            <div className="bd-state" role={status === 'error' ? 'alert' : 'status'}>
              {status === 'error' ? (
                <>
                  <p>{error || 'No se pudo cargar el tablero.'}</p>
                  <button type="button" className="primary" onClick={() => void loadBoard().catch(() => {})}>
                    Reintentar
                  </button>
                </>
              ) : (
                <>
                  <i className="na-spin" aria-hidden="true" />
                  <p>Cargando el tablero…</p>
                </>
              )}
            </div>
          ) : (
            <>
              {allCards.length === 0 && cols.length > 0 && (
                <p className="bd-tip">
                  <b>El tablero está en blanco.</b> Pulsa «Añadir tarjeta» en cualquier columna para crear la primera; luego arrástrala entre columnas.
                </p>
              )}
              <div
                className={`bd-cols${drag ? ' is-drag' : ''}`}
                ref={scroller}
                role="group"
                aria-label="Columnas del tablero"
                onDragOver={overScroller}
                onDrop={dropScroller}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
                }}
              >
                {cols.map((c) => (
                  <ColumnView
                    key={c.id}
                    col={c}
                    dropAt={dropAt}
                    dropBefore={beforeId === c.id}
                    drag={drag}
                    onFail={failWith}
                    onOpen={setOpenId}
                    startDrag={startDrag}
                    endDrag={endDrag}
                    overCard={overCard}
                    dropCard={dropCard}
                    keyMove={keyMove}
                  />
                ))}
                <div className={`bd-newcol${beforeId === null ? ' is-drop' : ''}`}>
                  <Inline
                    open={addingCol}
                    setOpen={setAddingCol}
                    placeholder="Nombre de la columna…"
                    label="Nombre de la nueva columna"
                    max={60}
                    cta="Añadir columna"
                    onSubmit={async (t) => {
                      try {
                        await createColumn(t)
                        window.setTimeout(() => scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: reduced() ? 'auto' : 'smooth' }), 50)
                      } catch (e) {
                        failWith(msg(e, 'No se pudo crear la columna.'))
                        throw e
                      }
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </section>

        <ZoomControls onZoom={(f) => world.zoomBy(f)} />
      </div>
      {openId && <CardEditor cardId={openId} onClose={() => setOpenId(null)} />}
      {archived && (
        <ArchivedSheet
          onClose={() => setArchived(false)}
          onOpen={(id) => {
            setArchived(false)
            setOpenId(id)
          }}
        />
      )}
    </main>
  )
}
