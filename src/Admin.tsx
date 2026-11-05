import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { AVATAR_SEEDS, Blobvatar } from './blob'
import { MODULES, MODULE_LABEL, type ModuleKey } from './tenant'
import { ago } from './time'
import { Icon } from './ui'
import './admin.css'

interface AdminTenant {
  id: string
  name: string
  slug: string
  active: boolean
  members: number
  createdAt: string
}
interface AdminUser {
  id: string
  name: string
  avatar: string
  role: 'ADMIN' | 'SOCIO'
  active: boolean
  mustChangePin: boolean
  createdAt: string
  tenants: { tenantId: string; name: string; slug: string; active: boolean; modules: ModuleKey[] }[]
}
/** Accesos de un socio: tenant -> modulos (la presencia de la clave es «entra a ese tenant»; [] = entra sin ver nada). */
type Access = Record<string, ModuleKey[]>

const INITIAL_PIN_NOTICE = 'El socio entra con su nombre y el código inicial 000000. Al iniciar sesión por primera vez definirá su propio código de 6 dígitos; hasta entonces no puede usar nada más.'
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const accessOf = (u: AdminUser): Access => Object.fromEntries(u.tenants.map((t) => [t.tenantId, [...t.modules]]))
const sameMods = (a: ModuleKey[], b: ModuleKey[]) => a.length === b.length && a.every((m) => b.includes(m))
const sameAccess = (a: Access, b: Access) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameMods(a[k], b[k]))
}

/** Matriz tenant × módulos: marca a qué espacios entra el socio y qué módulos ve en cada uno. */
function AccessMatrix({ tenants, value, onChange, disabled }: { tenants: AdminTenant[]; value: Access; onChange: (a: Access) => void; disabled?: boolean }) {
  if (tenants.length === 0) return <p className="none">Aún no hay espacios de trabajo. Crea uno en la pestaña «Espacios».</p>
  const toggleTenant = (id: string) => {
    const next = { ...value }
    if (id in next) delete next[id]
    else next[id] = []
    onChange(next)
  }
  const toggleModule = (id: string, m: ModuleKey) => {
    const cur = value[id] ?? []
    onChange({ ...value, [id]: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] })
  }
  return (
    <div className="ad-matrix">
      {tenants.map((t) => {
        const on = t.id in value
        const mods = value[t.id] ?? []
        return (
          <div key={t.id} className={`ad-ten${on ? ' is-on' : ''}`}>
            <label className="ad-ten-head">
              <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggleTenant(t.id)} />
              <b>{t.name}</b>
              {!t.active && <em>inactivo</em>}
            </label>
            {on && (
              <>
                <div className="ad-mods" role="group" aria-label={`Módulos en ${t.name}`}>
                  {MODULES.map((m) => (
                    <label key={m} className={`ad-mod${mods.includes(m) ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={mods.includes(m)} disabled={disabled} onChange={() => toggleModule(t.id, m)} />
                      <span>{MODULE_LABEL[m]}</span>
                    </label>
                  ))}
                </div>
                <div className="ad-quick">
                  <button type="button" className="ghost" disabled={disabled} onClick={() => onChange({ ...value, [t.id]: [...MODULES] })}>
                    Todos
                  </button>
                  <button type="button" className="ghost" disabled={disabled} onClick={() => onChange({ ...value, [t.id]: [] })}>
                    Ninguno
                  </button>
                  {mods.length === 0 && <small>Entra al espacio sin ver ningún módulo.</small>}
                  {mods.includes('feed') && !mods.includes('hub') && <small>El Feed se abre desde el Hub: sin el módulo Hub no tiene entrada.</small>}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Un socio de la lista: estado, acciones y sus accesos editables. */
function UserCard({ u, tenants, self, onReload, setNotice }: { u: AdminUser; tenants: AdminTenant[]; self: boolean; onReload: () => Promise<void>; setNotice: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const orig = accessOf(u)
  const [draft, setDraft] = useState<Access>(orig)
  const [sure, setSure] = useState<'reset' | 'off' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = !sameAccess(draft, orig)

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await onReload()
    } catch (e) {
      setError(msg(e, fallback))
    } finally {
      setBusy(false)
      setSure(null)
    }
  }
  const saveAccess = () =>
    run(async () => {
      for (const t of tenants) {
        const was = orig[t.id]
        const now = draft[t.id]
        if (now && (!was || !sameMods(was, now))) await api.put(`/admin/users/${u.id}/tenants/${t.id}`, { modules: now })
        else if (!now && was) await api.del(`/admin/users/${u.id}/tenants/${t.id}`)
      }
    }, 'No se pudieron guardar los accesos.')

  return (
    <li className={`ad-user${u.active ? '' : ' is-off'}`}>
      <div className="ad-user-top">
        <Blobvatar seed={u.avatar} size={44} />
        <div className="ad-user-id">
          <strong>{u.name}</strong>
          <span className="ad-chips">
            {u.role === 'ADMIN' && <i className="ad-chip is-admin">Administrador</i>}
            <i className={`ad-chip ${u.active ? 'is-ok' : 'is-bad'}`}>{u.active ? 'Activo' : 'Desactivado'}</i>
            {u.mustChangePin && <i className="ad-chip is-wait">Pendiente de definir su código</i>}
          </span>
          <small>
            {u.role === 'ADMIN' ? 'Entra a todos los espacios con todos los módulos' : u.tenants.length === 0 ? 'Sin acceso a ningún espacio' : u.tenants.map((t) => `${t.name} (${t.modules.length})`).join(' · ')}
          </small>
        </div>
        <div className="ad-actions">
          {u.role !== 'ADMIN' && (
            <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              Accesos
            </button>
          )}
          {sure === 'reset' ? (
            <span className="ig-sure">
              <button type="button" className="ghost danger" disabled={busy} onClick={() => void run(async () => (await api.post(`/admin/users/${u.id}/reset-pin`), setNotice(`Código de ${u.name} reiniciado a 000000. Definirá uno nuevo al entrar y sus sesiones abiertas se cerraron.`)), 'No se pudo reiniciar el código.')}>
                Sí, reiniciar
              </button>
              <button type="button" className="ghost" onClick={() => setSure(null)}>
                No
              </button>
            </span>
          ) : (
            <button type="button" className="ghost" disabled={busy} onClick={() => setSure('reset')} aria-label={`Reiniciar el código de ${u.name}`}>
              Reiniciar código
            </button>
          )}
          {!u.active ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => void run(async () => void (await api.patch(`/admin/users/${u.id}`, { active: true })), 'No se pudo activar.')}>
              Activar
            </button>
          ) : sure === 'off' ? (
            <span className="ig-sure">
              <button type="button" className="ghost danger" disabled={busy} onClick={() => void run(async () => void (await api.patch(`/admin/users/${u.id}`, { active: false })), 'No se pudo desactivar.')}>
                Sí, desactivar
              </button>
              <button type="button" className="ghost" onClick={() => setSure(null)}>
                No
              </button>
            </span>
          ) : (
            <button type="button" className="ghost" disabled={busy || self} title={self ? 'No puedes desactivarte a ti mismo' : undefined} onClick={() => setSure('off')} aria-label={`Desactivar a ${u.name}`}>
              Desactivar
            </button>
          )}
        </div>
      </div>
      {sure === 'off' && <p className="ad-warn">Se cierran sus sesiones al instante y no podrá volver a entrar hasta que lo actives.</p>}
      {sure === 'reset' && <p className="ad-warn">Vuelve al código 000000 y tendrá que definir uno nuevo. Sus sesiones abiertas se cierran.</p>}
      {open && u.role !== 'ADMIN' && (
        <div className="ad-access">
          <AccessMatrix tenants={tenants} value={draft} onChange={setDraft} disabled={busy} />
          <div className="row-foot">
            <p className={error ? 'err' : 'none'} role="alert">
              {error || (dirty ? 'Hay cambios sin guardar.' : 'Sin cambios.')}
            </p>
            <span className="ad-actions">
              <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => setDraft(orig)}>
                Descartar
              </button>
              <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void saveAccess()}>
                {busy ? 'Guardando…' : 'Guardar accesos'}
              </button>
            </span>
          </div>
        </div>
      )}
      {!open && error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function UsersPanel({ users, tenants, selfId, onReload }: { users: AdminUser[]; tenants: AdminTenant[]; selfId: string; onReload: () => Promise<void> }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(() => AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)])
  const [access, setAccess] = useState<Access>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) return setError('Escribe el nombre del socio (mínimo 2 letras).')
    setBusy(true)
    setError('')
    try {
      const u = await api.post<AdminUser>('/admin/users', { name: name.trim(), avatar, tenants: Object.entries(access).map(([tenantId, modules]) => ({ tenantId, modules })) })
      setFresh(u.name)
      setNotice('')
      setName('')
      setAccess({})
      setCreating(false)
      await onReload()
    } catch (err) {
      setError(msg(err, 'No se pudo crear el socio.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {fresh && (
        <section className="ig-fresh" aria-live="polite">
          <p className="ig-fresh-t">Socio «{fresh}» creado con el código inicial 000000.</p>
          <p className="ad-fresh-note">Al iniciar sesión por primera vez definirá su propio código de 6 dígitos. Avísale que entre con su nombre y 000000.</p>
        </section>
      )}
      {notice && (
        <section className="ig-fresh" aria-live="polite">
          <p className="ig-fresh-t">{notice}</p>
        </section>
      )}

      {creating ? (
        <form onSubmit={create} noValidate>
          <fieldset>
            <legend>Nuevo socio</legend>
            <label className="field">
              <span>Nombre</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Nombre con el que entrará" autoComplete="off" />
            </label>
            <div className="field">
              <span id="ad-av">Avatar</span>
              <div className="avatars" role="radiogroup" aria-labelledby="ad-av">
                {AVATAR_SEEDS.map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={avatar === s} aria-label={`Avatar ${s}`} className={avatar === s ? 'is-on' : ''} onClick={() => setAvatar(s)}>
                    <Blobvatar seed={s} size={38} />
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Accesos iniciales</span>
              <AccessMatrix tenants={tenants.filter((t) => t.active)} value={access} onChange={setAccess} disabled={busy} />
            </div>
            <p className="ad-pin-note">{INITIAL_PIN_NOTICE}</p>
            <div className="row-foot">
              <p className={error ? 'err' : 'none'} role="alert">
                {error}
              </p>
              <span className="ad-actions">
                <button type="button" className="ghost" onClick={() => (setCreating(false), setError(''))}>
                  Cancelar
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Creando…' : 'Crear socio'}
                </button>
              </span>
            </div>
          </fieldset>
        </form>
      ) : (
        <div className="row-foot">
          <p className="none">{users.length === 1 ? '1 socio' : `${users.length} socios`}</p>
          <button type="button" className="primary" onClick={() => (setCreating(true), setFresh(null), setNotice(''))}>
            <Icon name="plus" size={14} /> Nuevo socio
          </button>
        </div>
      )}

      {users.length === 0 ? (
        <p className="ad-empty">Aún no hay socios.</p>
      ) : (
        <ul className="ad-list">
          {users.map((u) => (
            <UserCard key={`${u.id}:${JSON.stringify(accessOf(u))}`} u={u} tenants={tenants} self={u.id === selfId} onReload={onReload} setNotice={(s) => (setNotice(s), setFresh(null))} />
          ))}
        </ul>
      )}
    </>
  )
}

function TenantRow({ t, onReload }: { t: AdminTenant; onReload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(t.name)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const patch = async (body: { name?: string; active?: boolean }, fallback: string) => {
    setBusy(true)
    setError('')
    try {
      await api.patch(`/admin/tenants/${t.id}`, body)
      setEditing(false)
      setSure(false)
      await onReload()
    } catch (e) {
      setError(msg(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`ad-tenant${t.active ? '' : ' is-off'}`}>
      <div className="ad-user-top">
        <div className="ad-user-id">
          {editing ? (
            <form
              className="ad-rename"
              onSubmit={(e) => {
                e.preventDefault()
                if (name.trim().length < 2) return setError('El nombre necesita al menos 2 letras.')
                void patch({ name: name.trim() }, 'No se pudo renombrar.')
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label={`Nuevo nombre para ${t.name}`} />
              <button type="submit" className="primary" disabled={busy}>
                Guardar
              </button>
              <button type="button" className="ghost" onClick={() => (setEditing(false), setName(t.name), setError(''))}>
                Cancelar
              </button>
            </form>
          ) : (
            <strong>{t.name}</strong>
          )}
          <span className="ad-chips">
            <i className={`ad-chip ${t.active ? 'is-ok' : 'is-bad'}`}>{t.active ? 'Activo' : 'Desactivado'}</i>
            <i className="ad-chip">{t.members === 1 ? '1 socio' : `${t.members} socios`}</i>
          </span>
          <small>
            {t.slug} · creado {ago(t.createdAt)}
          </small>
        </div>
        {!editing && (
          <div className="ad-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setEditing(true)} aria-label={`Renombrar ${t.name}`}>
              Renombrar
            </button>
            {!t.active ? (
              <button type="button" className="ghost" disabled={busy} onClick={() => void patch({ active: true }, 'No se pudo activar.')}>
                Activar
              </button>
            ) : sure ? (
              <span className="ig-sure">
                <button type="button" className="ghost danger" disabled={busy} onClick={() => void patch({ active: false }, 'No se pudo desactivar.')}>
                  Sí, desactivar
                </button>
                <button type="button" className="ghost" onClick={() => setSure(false)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className="ghost" disabled={busy} onClick={() => setSure(true)} aria-label={`Desactivar ${t.name}`}>
                Desactivar
              </button>
            )}
          </div>
        )}
      </div>
      {sure && <p className="ad-warn">Nadie podrá entrar a este espacio, tampoco los administradores. No se borra nada: puedes activarlo de nuevo.</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

function TenantsPanel({ tenants, onReload }: { tenants: AdminTenant[]; onReload: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) return setError('Ponle un nombre al espacio (mínimo 2 letras).')
    setBusy(true)
    setError('')
    try {
      await api.post('/admin/tenants', { name: name.trim() })
      setName('')
      await onReload()
    } catch (err) {
      setError(msg(err, 'No se pudo crear el espacio.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={create} noValidate>
        <fieldset>
          <legend>Nuevo espacio de trabajo</legend>
          <label className="field">
            <span>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="p. ej. Otra empresa" autoComplete="off" />
          </label>
          <div className="row-foot">
            <p className={error ? 'err' : 'none'} role="alert">
              {error || 'Cada espacio tiene sus propios clientes, proyectos, tareas y finanzas. Los administradores entran a todos.'}
            </p>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Creando…' : 'Crear espacio'}
            </button>
          </div>
        </fieldset>
      </form>
      {tenants.length === 0 ? (
        <p className="ad-empty">Aún no hay espacios de trabajo.</p>
      ) : (
        <ul className="ad-list">
          {tenants.map((t) => (
            <TenantRow key={`${t.id}:${t.name}:${t.active}`} t={t} onReload={onReload} />
          ))}
        </ul>
      )}
    </>
  )
}

/** Administración (solo ADMIN): espacios de trabajo, socios y qué módulos ve cada socio en cada espacio. */
export default function Admin({ selfId, onClose, onTenantsChanged }: { selfId: string; onClose: () => void; onTenantsChanged: () => void }) {
  const [tab, setTab] = useState<'socios' | 'espacios'>('socios')
  const [tenants, setTenants] = useState<AdminTenant[] | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState('')

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const changed = useRef(onTenantsChanged)
  changed.current = onTenantsChanged
  /** Recarga ambas listas; lo que cambia accesos o espacios avisa a la app para que refresque los espacios del propio administrador. */
  const reload = async () => {
    const [t, u] = await Promise.all([api.get<AdminTenant[]>('/admin/tenants'), api.get<AdminUser[]>('/admin/users')])
    setTenants(t)
    setUsers(u)
    setError('')
    changed.current()
  }
  const first = () => reload().catch((e) => setError(msg(e, 'No se pudo cargar la administración.')))
  useEffect(() => void first(), [])

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet ad-sheet" role="dialog" aria-modal="true" aria-labelledby="ad-title">
        <header>
          <h2 id="ad-title">Administración</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet-body">
          <p className="ig-lede">Crea espacios de trabajo, da de alta a los socios y decide a qué espacios entra cada uno y qué módulos ve en ellos.</p>

          <div className="seg" role="tablist" aria-label="Secciones de administración">
            <button type="button" role="tab" aria-selected={tab === 'socios'} className={tab === 'socios' ? 'is-on' : ''} onClick={() => setTab('socios')}>
              Socios
            </button>
            <button type="button" role="tab" aria-selected={tab === 'espacios'} className={tab === 'espacios' ? 'is-on' : ''} onClick={() => setTab('espacios')}>
              Espacios
            </button>
          </div>

          {error && (
            <div className="ad-alert" role="alert">
              <p>{error}</p>
              <button type="button" className="ghost" onClick={() => void first()}>
                Reintentar
              </button>
            </div>
          )}
          {(!tenants || !users) && !error && <p className="none">Cargando…</p>}
          {tenants && users && (tab === 'socios' ? <UsersPanel users={users} tenants={tenants} selfId={selfId} onReload={reload} /> : <TenantsPanel tenants={tenants} onReload={reload} />)}
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
