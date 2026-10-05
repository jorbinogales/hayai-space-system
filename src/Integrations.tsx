import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError } from './api'
import { ago } from './time'
import { Icon } from './ui'

type Scope = 'read' | 'write' | 'delete'
interface ApiKey {
  id: string
  name: string
  prefix: string
  scopes: Scope[]
  createdAt: string
  lastUsedAt: string | null
}

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'read', label: 'Lectura', hint: 'Consultar clientes, cobros, proyectos, gastos, tareas y finanzas.' },
  { id: 'write', label: 'Escritura', hint: 'Crear y editar, archivar y restaurar de la papelera.' },
  { id: 'delete', label: 'Borrado', hint: 'Mandar a la papelera (se recupera 30 días). Nunca borra para siempre.' },
]
const LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label])) as Record<Scope, string>

/** Botón que copia un texto y avisa un instante. */
function Copy({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  const t = useRef(0)
  useEffect(() => () => clearTimeout(t.current), [])
  return (
    <button
      type="button"
      className="ig-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          clearTimeout(t.current)
          t.current = window.setTimeout(() => setDone(false), 1800)
        } catch {
          /* sin permiso del portapapeles: el texto sigue visible para copiarlo a mano */
        }
      }}
    >
      {done ? 'Copiado' : label}
    </button>
  )
}

/** Integraciones: cada astronauta crea y revoca sus llaves de API, con nombre y permisos, y ve cómo conectar un agente por MCP. */
export default function Integrations({ onClose }: { onClose: () => void }) {
  const origin = window.location.origin
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['read'])
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<(ApiKey & { key: string }) | null>(null)
  const [sure, setSure] = useState<string | null>(null) // llave cuya revocación espera confirmación
  const [tab, setTab] = useState<'mcp' | 'rest'>('mcp')
  const first = useRef<HTMLInputElement>(null)

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const load = () =>
    api
      .get<ApiKey[]>('/keys')
      .then(setKeys)
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudieron cargar las llaves.'))
  useEffect(() => void load(), [])

  const toggle = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Ponle un nombre: te dirá para qué sirve (p. ej. “Growi”).')
    if (scopes.length === 0) return setError('Elige al menos un permiso.')
    if (!/^\d{6}$/.test(pin)) return setError('Confirma con tu clave de 6 dígitos.')
    setBusy(true)
    setError('')
    try {
      const k = await api.post<ApiKey & { key: string }>('/keys', { name: name.trim(), scopes, pin })
      setFresh(k)
      setName('')
      setPin('')
      setScopes(['read'])
      await load()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'La clave es incorrecta.' : err instanceof Error ? err.message : 'No se pudo crear la llave.')
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (k: ApiKey) => {
    setError('')
    try {
      await api.del(`/keys/${k.id}`)
      setSure(null)
      if (fresh?.id === k.id) setFresh(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo revocar la llave.')
    }
  }

  const shown = fresh?.key ?? 'hy_tu_llave'
  const mcpJson = JSON.stringify({ mcpServers: { 'hayai-space': { type: 'http', url: `${origin}/mcp`, headers: { 'X-API-Key': shown } } } }, null, 2)
  const curl = `curl -H "X-API-Key: ${shown}" ${origin}/api/v1/me`

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet ig-sheet" role="dialog" aria-modal="true" aria-labelledby="ig-title">
        <header>
          <h2 id="ig-title">Integraciones</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet-body">
          <p className="ig-lede">
            Una llave deja que un agente (Growi, Claude u otro) use HAYAI Space <em>como tú</em>: todo lo que haga queda a tu nombre. Tú decides qué puede hacer.
          </p>

          {fresh && (
            <section className="ig-fresh" aria-live="polite">
              <p className="ig-fresh-t">Llave “{fresh.name}” creada. Cópiala ahora: no se vuelve a mostrar.</p>
              <div className="ig-key">
                <code>{fresh.key}</code>
                <Copy text={fresh.key} />
              </div>
            </section>
          )}

          <fieldset>
            <legend>Mis llaves</legend>
            {keys === null && <p className="none">Cargando…</p>}
            {keys?.length === 0 && <p className="none">Aún no tienes llaves. Crea la primera abajo.</p>}
            <ul className="ig-list">
              {keys?.map((k) => (
                <li key={k.id}>
                  <div className="ig-k">
                    <strong>{k.name}</strong>
                    <code>{k.prefix}…</code>
                    <span className="ig-scopes">
                      {k.scopes.map((s) => (
                        <i key={s} className={`ig-s ig-${s}`}>
                          {LABEL[s]}
                        </i>
                      ))}
                    </span>
                    <small>
                      Creada {ago(k.createdAt)} · {k.lastUsedAt ? `último uso ${ago(k.lastUsedAt)}` : 'sin usar'}
                    </small>
                  </div>
                  {sure === k.id ? (
                    <span className="ig-sure">
                      <button type="button" className="ghost danger" onClick={() => void revoke(k)}>
                        Sí, revocar
                      </button>
                      <button type="button" className="ghost" onClick={() => setSure(null)}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="ghost" onClick={() => setSure(k.id)} aria-label={`Revocar la llave ${k.name}`}>
                      Revocar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>

          <form onSubmit={create} noValidate>
            <fieldset>
              <legend>Nueva llave</legend>
              <label className="field">
                <span>Nombre</span>
                <input ref={first} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="p. ej. Growi" autoComplete="off" />
              </label>
              <div className="field">
                <span id="ig-perm">Permisos</span>
                <div className="ig-perms" role="group" aria-labelledby="ig-perm">
                  {SCOPES.map((s) => (
                    <button key={s.id} type="button" className={`ig-perm${scopes.includes(s.id) ? ' is-on' : ''}`} aria-pressed={scopes.includes(s.id)} onClick={() => toggle(s.id)}>
                      <b>{s.label}</b>
                      <small>{s.hint}</small>
                    </button>
                  ))}
                </div>
              </div>
              <label className="field ig-pin">
                <span>Tu clave, para confirmar</span>
                <input type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
              </label>
              <div className="row-foot">
                <p className={error ? 'err' : 'none'} role="alert">
                  {error || 'La llave actúa con tu usuario.'}
                </p>
                <button type="submit" className="primary" disabled={busy}>
                  Crear llave
                </button>
              </div>
            </fieldset>
          </form>

          <fieldset>
            <legend>Conectar un agente</legend>
            <div className="seg" role="tablist" aria-label="Forma de conexión">
              <button type="button" role="tab" aria-selected={tab === 'mcp'} className={tab === 'mcp' ? 'is-on' : ''} onClick={() => setTab('mcp')}>
                MCP
              </button>
              <button type="button" role="tab" aria-selected={tab === 'rest'} className={tab === 'rest' ? 'is-on' : ''} onClick={() => setTab('rest')}>
                API REST
              </button>
            </div>
            {tab === 'mcp' ? (
              <div className="ig-how">
                <p>
                  En el agente, añade un servidor MCP remoto (en Growi: <b>conector personalizado</b>) con esta dirección y el encabezado <code>X-API-Key</code> con tu llave.
                </p>
                <div className="ig-key">
                  <code>{origin}/mcp</code>
                  <Copy text={`${origin}/mcp`} />
                </div>
                <p>
                  O pega esta configuración{fresh ? '' : ' (cambia hy_tu_llave por la tuya)'}:
                </p>
                <div className="ig-pre">
                  <pre>{mcpJson}</pre>
                  <Copy text={mcpJson} />
                </div>
                <p className="ig-note">El agente solo ve las herramientas que los permisos de su llave permiten. Para probar, pídele el resumen de finanzas.</p>
              </div>
            ) : (
              <div className="ig-how">
                <p>
                  Base: <code>{origin}/api/v1</code>. Envía <code>X-API-Key</code> en cada petición. Lectura = <code>GET</code>, escritura = <code>POST</code>/<code>PATCH</code>, borrado = <code>DELETE</code>.
                </p>
                <div className="ig-pre">
                  <pre>{curl}</pre>
                  <Copy text={curl} />
                </div>
              </div>
            )}
          </fieldset>
        </div>

        <footer>
          <button type="button" className="primary" onClick={onClose}>
            Listo
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
