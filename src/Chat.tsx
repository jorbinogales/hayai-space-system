import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { isConflict } from './api'
import { Blobvatar } from './blob'
import {
  deleteChat,
  dismissChatToast,
  editChat,
  loadOlder,
  refreshChatCounters,
  reloadMessage,
  sendChat,
  setChatOpen,
  setChatUser,
  useChat,
  type ChatMessage,
} from './chatData'
import { useSession } from './session'
import { useUsers, type User } from './users'
import { Icon } from './ui'
import './chat.css'

const MAX = 4000
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** «14:32» si es de hoy; «8 oct, 14:32» si no. */
function hora(iso: string): string {
  const d = new Date(iso)
  const hoy = d.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat('es', hoy ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
}
const completa = (iso: string) => new Intl.DateTimeFormat('es', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso))

/** El texto con cada @Nombre de las menciones resaltado (más fuerte si me nombran a mí). El servidor ya decidió quién cuenta como mencionado. */
function Body({ m, meId }: { m: ChatMessage; meId: string | undefined }) {
  if (!m.menciones.length) return <>{m.cuerpo}</>
  const by = new Map(m.menciones.map((x) => [x.nombre.toLowerCase(), x.id]))
  const names = [...by.keys()].sort((a, b) => b.length - a.length).map(escapeRe)
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@(?:${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const out: React.ReactNode[] = []
  let last = 0
  for (const hit of m.cuerpo.matchAll(re)) {
    const at = hit.index
    if (at > last) out.push(m.cuerpo.slice(last, at))
    const mine = by.get(hit[0].slice(1).toLowerCase()) === meId
    out.push(
      <mark key={at} className={`chat-mention${mine ? ' is-me' : ''}`}>
        {hit[0]}
      </mark>,
    )
    last = at + hit[0].length
  }
  if (last < m.cuerpo.length) out.push(m.cuerpo.slice(last))
  return <>{out}</>
}

/** Caja de texto con selector de astronautas al escribir @ (patrón combobox: flechas, Enter o Tab eligen, Esc cierra). Enter envía; Shift+Enter, salto de línea. */
function MentionInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  users,
  label,
  placeholder,
  disabled,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel?: () => void
  users: User[]
  label: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
}) {
  const uid = useId()
  const ta = useRef<HTMLTextAreaElement>(null)
  const nextCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const tok = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]*)$/u.exec(value.slice(0, caret))
  const query = tok ? tok[2] : null
  const options = query === null ? [] : users.filter((u) => fold(u.name).startsWith(fold(query)))
  const open = options.length > 0 && !dismissed
  const cur = Math.min(active, Math.max(0, options.length - 1))

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current)
      nextCaret.current = null
    }
  }, [value])
  useEffect(() => {
    if (autoFocus) ta.current?.focus()
  }, [autoFocus])

  const pick = (u: User) => {
    if (query === null) return
    const start = caret - query.length - 1
    const next = `${value.slice(0, start)}@${u.name} ${value.slice(caret)}`
    const pos = start + u.name.length + 2
    nextCaret.current = pos
    setCaret(pos)
    setDismissed(false)
    onChange(next)
    ta.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((cur + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        pick(options[cur])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="chat-input">
      {open && (
        <ul className="chat-suggest" id={`${uid}-list`} role="listbox" aria-label="Astronautas">
          {options.map((u, i) => (
            <li key={u.id} id={`${uid}-o${i}`} role="option" aria-selected={i === cur} className={i === cur ? 'is-on' : undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(u)}>
              <Blobvatar seed={u.avatar} size={24} />
              <span>{u.name}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={value}
        maxLength={MAX}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${uid}-list` : undefined}
        aria-activedescendant={open ? `${uid}-o${cur}` : undefined}
        data-esc-own={open || onCancel ? '' : undefined}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
          setDismissed(false)
          setActive(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
      />
      {value.length > MAX - 400 && (
        <small className="chat-count" aria-live="polite">
          {value.length}/{MAX}
        </small>
      )}
    </div>
  )
}

function Message({ m, meId, admin, isNew, users }: { m: ChatMessage; meId: string | undefined; admin: boolean; isNew: boolean; users: User[] }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.cuerpo)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const [err, setErr] = useState('')
  const mine = m.autor.id === meId
  const avatar = users.find((u) => u.id === m.autor.id)?.avatar ?? m.autor.nombre
  const mentioned = !!meId && m.menciones.some((x) => x.id === meId)

  const save = async () => {
    const text = draft.trim()
    if (!text || busy) return
    if (text === m.cuerpo) return setEditing(false)
    setBusy(true)
    setErr('')
    try {
      await editChat(m, text)
      setEditing(false)
    } catch (e) {
      if (isConflict(e)) {
        setErr('Este mensaje cambió mientras lo editabas. Ya se actualizó: revisa y guarda de nuevo.')
        void reloadMessage(m.id).catch(() => {})
      } else setErr((e as Error).message || 'No se pudo guardar.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    setErr('')
    try {
      await deleteChat(m)
    } catch (e) {
      setErr((e as Error).message || 'No se pudo borrar.')
      setBusy(false)
      setSure(false)
    }
  }

  return (
    <li className={`chat-msg${mine ? ' is-mine' : ''}${mentioned ? ' is-mention' : ''}${isNew ? ' is-new' : ''}${mine || admin ? ' has-actions' : ''}`}>
      <span className="notif-av" aria-hidden="true">
        <Blobvatar seed={avatar} size={30} />
      </span>
      <div className="chat-bubble">
        <p className="chat-meta">
          <b>{m.autor.nombre}</b>
          <time dateTime={m.creado_el} title={completa(m.creado_el)}>
            {hora(m.creado_el)}
          </time>
          {m.editado_el && <i title={`Editado ${completa(m.editado_el)}`}>(editado)</i>}
          {m.fuente !== 'manual' && <span className="chat-src">vía {m.fuente}</span>}
        </p>
        {editing ? (
          <div className="chat-edit">
            <MentionInput value={draft} onChange={setDraft} onSubmit={() => void save()} onCancel={() => (setEditing(false), setErr(''))} users={users.filter((u) => u.id !== meId)} label="Editar mensaje" autoFocus disabled={busy} />
            <div className="chat-actions is-open">
              <button type="button" className="chat-btn primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
                Guardar
              </button>
              <button type="button" className="chat-btn" disabled={busy} onClick={() => (setEditing(false), setErr(''))}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <p className="chat-text">
            <Body m={m} meId={meId} />
          </p>
        )}
        {err && (
          <p className="chat-err" role="alert">
            {err}
          </p>
        )}
        {!editing && (mine || admin) && (
          <div className={`chat-actions${sure ? ' is-open' : ''}`}>
            {sure ? (
              <>
                <span className="chat-ask">¿Mandar a la papelera?</span>
                <button type="button" className="chat-btn danger" disabled={busy} onClick={() => void remove()}>
                  Sí, borrar
                </button>
                <button type="button" className="chat-btn" disabled={busy} onClick={() => setSure(false)}>
                  No
                </button>
              </>
            ) : (
              <>
                {mine && (
                  <button type="button" className="chat-icon" aria-label={`Editar mi mensaje de ${hora(m.creado_el)}`} onClick={() => (setDraft(m.cuerpo), setEditing(true))}>
                    <Icon name="edit" size={14} />
                  </button>
                )}
                <button type="button" className="chat-icon" aria-label={`Borrar el mensaje de ${m.autor.nombre} de ${hora(m.creado_el)}`} onClick={() => setSure(true)}>
                  <Icon name="trash" size={14} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

const TOAST_MS = 6000

/** Icono de mensajes junto a la campana: contador de no leídos (distinto si alguien te mencionó) y el panel del canal del equipo. */
export function Chat() {
  const s = useChat()
  const session = useSession()
  const users = useUsers()
  const open = s.open
  const meId = session?.id
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // la lista sigue pegada al último mensaje mientras no subas a leer
  const prevHeight = useRef<number | null>(null) // al cargar anteriores, para no perder el lugar

  useEffect(() => {
    if (!meId) return
    setChatUser(meId)
    void refreshChatCounters().catch(() => {})
  }, [meId])

  const close = () => {
    void setChatOpen(false)
    btn.current?.focus()
  }
  const toggle = () => {
    if (open) return close()
    setError('')
    void setChatOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && void setChatOpen(false)
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Un selector de @ abierto o un mensaje en edición atienden su propio Esc.
      if ((e.target as HTMLElement | null)?.closest?.('[data-esc-own]')) return
      e.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', out)
    window.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', out)
      window.removeEventListener('keydown', esc, true)
    }
  })

  useLayoutEffect(() => {
    if (open) stick.current = true // al abrir, abajo del todo (lo último)
  }, [open])
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [s.messages, open])

  const more = () => {
    prevHeight.current = list.current?.scrollHeight ?? null
    void loadOlder().catch(() => (prevHeight.current = null))
  }
  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      stick.current = true
      await sendChat(text)
      setDraft('')
    } catch (e) {
      setError((e as Error).message || 'No se pudo enviar. Reintenta.')
    } finally {
      setSending(false)
    }
  }

  const unread = s.sinLeer
  const hasMention = s.mencionesSinLeer > 0
  const label = hasMention
    ? `Mensajes, ${unread} sin leer, ${s.mencionesSinLeer} te ${s.mencionesSinLeer === 1 ? 'menciona' : 'mencionan'}`
    : unread
      ? `Mensajes, ${unread} sin leer`
      : 'Mensajes'
  const others = users.filter((u) => u.id !== meId)
  const seenUpTo = s.seenUpTo
  const firstNew = seenUpTo === null ? undefined : s.messages.find((m) => m.creado_el > seenUpTo && m.autor.id !== meId)

  return (
    <>
      <div className="notif chat" ref={wrap}>
        <button ref={btn} className={`round${hasMention ? ' has-mention' : ''}`} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          <Icon name="chat" />
          {unread > 0 && (
            <span className={`badge count${hasMention ? ' is-mention' : ''}`} aria-hidden="true">
              {hasMention ? '@' : ''}
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
        {open && (
          <section className="notif-panel chat-panel" role="dialog" aria-label="Mensajes del equipo">
            <header className="chat-head">
              <div>
                <b>Canal del equipo</b>
                <small>Notas entre astronautas. Escribe @ para mencionar a alguien.</small>
              </div>
              <button type="button" className="chat-icon" aria-label="Cerrar mensajes" onClick={close}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div
              ref={list}
              className="chat-list"
              role="log"
              aria-label="Mensajes"
              aria-live="polite"
              aria-relevant="additions"
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {s.error ? (
                <p className="notif-empty">
                  <b>No se pudo abrir el canal.</b>
                  Revisa tu conexión e inténtalo de nuevo.
                  <button type="button" className="chat-btn primary" onClick={() => void setChatOpen(true)}>
                    Reintentar
                  </button>
                </p>
              ) : !s.loaded ? (
                <p className="notif-empty" role="status">
                  Cargando notas…
                </p>
              ) : s.messages.length === 0 ? (
                <p className="notif-empty">
                  <b>Aún no hay notas, astronauta.</b>
                  Escribe la primera: todo el equipo la ve al instante.
                </p>
              ) : (
                <>
                  {s.hayMas && (
                    <button type="button" className="chat-older" disabled={s.loading} onClick={more}>
                      {s.loading ? 'Cargando…' : 'Cargar anteriores'}
                    </button>
                  )}
                  <ul>
                    {s.messages.map((m) => (
                      <WithSeparator key={m.id} sep={firstNew?.id === m.id}>
                        <Message m={m} meId={meId} admin={session?.role === 'ADMIN'} isNew={seenUpTo !== null && m.creado_el > seenUpTo && m.autor.id !== meId} users={users} />
                      </WithSeparator>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <form
              className="chat-compose"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              {error && (
                <p className="chat-err" role="alert">
                  {error}
                </p>
              )}
              <div className="chat-row">
                <MentionInput value={draft} onChange={setDraft} onSubmit={() => void send()} users={others} label="Escribir un mensaje al equipo" placeholder="Escribe una nota…" disabled={sending} />
                <button type="submit" className="chat-send" aria-label="Enviar mensaje" disabled={sending || !draft.trim()}>
                  <Icon name="arrow" size={18} />
                </button>
              </div>
            </form>
          </section>
        )}
      </div>
      <ChatToast hidden={open} />
    </>
  )
}

/** Separador «Nuevos» antes del primer mensaje que no habías visto. */
function WithSeparator({ sep, children }: { sep: boolean; children: React.ReactNode }) {
  return (
    <>
      {sep && (
        <li className="chat-sep" role="separator" aria-label="Mensajes nuevos">
          <span>Nuevos</span>
        </li>
      )}
      {children}
    </>
  )
}

/** Aviso lateral cuando alguien te menciona y no tienes el chat abierto. */
function ChatToast({ hidden }: { hidden: boolean }) {
  const { toast } = useChat()
  const users = useUsers()
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (!toast || paused) return
    const id = window.setTimeout(dismissChatToast, TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast, paused])
  if (!toast || hidden) return null
  const m = toast.message
  const avatar = users.find((u) => u.id === m.autor.id)?.avatar ?? m.autor.nombre
  const text = m.cuerpo.length > 120 ? `${m.cuerpo.slice(0, 119)}…` : m.cuerpo
  return (
    <div className="toasts chat-toasts" role="status" aria-live="polite">
      <div className="toast" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <button
          className="toast-main"
          onClick={() => {
            dismissChatToast()
            void setChatOpen(true)
          }}
        >
          <span className="notif-av" aria-hidden="true">
            <Blobvatar seed={avatar} size={34} />
          </span>
          <span className="notif-body">
            <span className="notif-text">
              <b>{m.autor.nombre}</b> te mencionó: {text}
            </span>
            <small>ahora</small>
          </span>
        </button>
        <button className="toast-x" aria-label="Cerrar aviso" onClick={dismissChatToast}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  )
}
