import { useEffect, useId, useRef, useState } from 'react'
import { api } from './api'
import { go } from './nav'
import { Icon } from './ui'

interface Hit {
  key: string
  group: 'Clientes' | 'Proyectos' | 'Tareas'
  title: string
  sub: string
  open: () => void
}
interface Found {
  clientes: { id: string; nombre: string; estado: string; etapa: string | null; telefono: string | null; etiquetas: string[] }[]
  proyectos: { id: string; nombre: string; cliente: string; estado: string }[]
  tareas: { id: string; titulo: string; proyecto: string; estado: string }[]
}

const STAGE: Record<string, string> = {
  prospecto: 'Prospecto',
  visita_agendada: 'Visita agendada',
  visita_realizada: 'Visita realizada',
  propuesta_en_armado: 'Propuesta en armado',
  propuesta_presentada: 'Propuesta presentada',
  ganado: 'Ganado',
  perdido: 'Perdido',
}

function toHits(f: Found): Hit[] {
  return [
    ...f.clientes.map((c): Hit => ({
      key: `c${c.id}`,
      group: 'Clientes',
      title: c.nombre,
      sub: [c.estado === 'posible' ? `Posible · ${STAGE[c.etapa ?? ''] ?? 'Prospecto'}` : 'Cliente', c.telefono].filter(Boolean).join(' · '),
      open: () => go({ screen: 'clientes', clientId: c.id }),
    })),
    ...f.proyectos.map((p): Hit => ({ key: `p${p.id}`, group: 'Proyectos', title: p.nombre, sub: p.cliente, open: () => go({ screen: 'proyectos' }) })),
    ...f.tareas.map((t): Hit => ({
      key: `t${t.id}`,
      group: 'Tareas',
      title: t.titulo,
      sub: `${t.proyecto}${t.estado === 'completada' ? ' · completada' : ''}`,
      open: () => go({ screen: 'tareas' }),
    })),
  ]
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** Boton de la lupa + paleta de busqueda (Ctrl/Cmd+K, o "/" fuera de un campo de texto). */
export function Search() {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !editable(e.target) && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  return (
    <>
      <button ref={btn} className="round" aria-label="Buscar" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K /" onClick={() => setOpen(true)}>
        <Icon name="search" />
      </button>
      {open && (
        <Palette
          onClose={() => {
            setOpen(false)
            btn.current?.focus()
          }}
        />
      )}
    </>
  )
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  const listId = useId()
  const term = q.trim()

  useEffect(() => {
    if (term.length < 2) {
      seq.current++
      setHits([])
      setState('idle')
      return
    }
    setState('loading')
    const mine = ++seq.current
    const id = window.setTimeout(() => {
      api
        .get<Found>(`/search?q=${encodeURIComponent(term)}&limite=6`)
        .then((f) => {
          if (mine !== seq.current) return // llego una respuesta vieja: ya se escribio otra cosa
          setHits(toHits(f))
          setActive(0)
          setState('done')
        })
        .catch(() => mine === seq.current && setState('error'))
    }, 180)
    return () => window.clearTimeout(id)
  }, [term])

  const choose = (h: Hit | undefined) => {
    if (!h) return
    onClose()
    h.open()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation() // que no cierre tambien el cajon de Clientes que hay debajo
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (hits.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(hits[active])
    }
  }
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  let lastGroup = ''
  return (
    <div className="srch-veil" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="srch" role="dialog" aria-modal="true" aria-label="Buscar" onKeyDown={onKey}>
        <label className="srch-field">
          <Icon name="search" size={18} />
          <input
            autoFocus
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={hits.length ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            placeholder="Cliente, teléfono, proyecto o tarea…"
            maxLength={80}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="srch-body">
          {state === 'idle' && <p className="srch-note">Escribe al menos dos letras. No importan los acentos ni las mayúsculas.</p>}
          {state === 'loading' && hits.length === 0 && <p className="srch-note">Buscando…</p>}
          {state === 'error' && <p className="srch-note">No se pudo buscar. Revisa tu conexión e inténtalo otra vez.</p>}
          {state === 'done' && hits.length === 0 && (
            <p className="srch-note">
              <b>Nada con «{term}».</b>
              Prueba con menos palabras o con parte del teléfono.
            </p>
          )}
          {hits.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Resultados">
              {hits.map((h, i) => {
                const head = h.group !== lastGroup
                lastGroup = h.group
                return (
                  <li key={h.key} role="presentation">
                    {head && <p className="srch-group">{h.group}</p>}
                    <button id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'is-on' : undefined} tabIndex={-1} onPointerMove={() => setActive(i)} onClick={() => choose(h)}>
                      <span className="srch-title">{h.title}</span>
                      <small>{h.sub}</small>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
