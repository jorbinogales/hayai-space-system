import { useEffect, useRef, useState } from 'react'
import { Blobvatar } from './blob'
import { changePin, login, lookup, type Known, type Session } from './auth'
import { ApiError } from './api'
import { loadAll } from './data'
import { reduced } from './warp'

type Phase = 'boot' | 'name' | 'pin' | 'newpin' | 'confirm' | 'granted'

const LOG = ['Iniciando núcleo HAYAI', 'Sistemas de navegación', 'Enlace de comunicaciones', 'Cargando carta estelar', 'Sincronizando clientes', 'Verificando escudos']
const INITIAL_PIN = '000000'

/** Mensaje legible para un fallo de acceso (PIN incorrecto, cuenta bloqueada, servidor caido). */
function loginError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 423) {
      const s = (e.data as { retryAfter?: number } | null)?.retryAfter
      return `Cuenta bloqueada por demasiados intentos${s ? `. Intenta de nuevo en ${Math.ceil(s / 60)} min` : ''}.`
    }
    if (e.status === 401) return 'Clave incorrecta. Intenta de nuevo.'
    if (e.status === 429) return 'Demasiados intentos. Espera un momento.'
    return e.message
  }
  return 'No se pudo conectar con el servidor.'
}

/**
 * Pantalla de carga/acceso estilo interfaz de nave: arranque de sistemas, identificacion del astronauta y clave de 6 digitos.
 * Aqui NO se crean usuarios: solo entran los astronautas que ya existen. Con la clave inicial (000000) se obliga a crear una nueva.
 */
export default function Boot({ onDone }: { onDone: (s: Session) => void }) {
  const [phase, setPhase] = useState<Phase>('boot')
  const [progress, setProgress] = useState(0)
  const [name, setName] = useState('')
  const [known, setKnown] = useState<Known | null>(null)
  const [oldPin, setOldPin] = useState('') // clave con la que se inicio sesion (la inicial), para cambiarla
  const [first, setFirst] = useState('') // clave nueva, pendiente de confirmar
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [shake, setShake] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [curtain, setCurtain] = useState(true) // cortinas de la animacion de entrada

  // la entrada: franjas que se deslizan y dejan ver la interfaz con un fundido
  useEffect(() => {
    const t = window.setTimeout(() => setCurtain(false), reduced() ? 60 : 1500)
    return () => clearTimeout(t)
  }, [])

  // arranque de sistemas
  useEffect(() => {
    if (phase !== 'boot') return
    const total = reduced() ? 900 : 3400
    const t0 = performance.now()
    const id = window.setInterval(() => {
      const p = Math.min(100, ((performance.now() - t0) / total) * 100)
      setProgress(p)
      if (p >= 100) {
        clearInterval(id)
        window.setTimeout(() => setPhase('name'), 350)
      }
    }, 40)
    return () => clearInterval(id)
  }, [phase])

  const finish = async (s: Session) => {
    setSession(s)
    setBusy(true)
    try {
      await loadAll() // los datos ya estan cargados cuando se abre la nave
    } catch {
      setBusy(false)
      return fail('No se pudieron cargar los datos. Intenta de nuevo.', 'name')
    }
    setBusy(false)
    setPhase('granted')
    window.setTimeout(() => setLeaving(true), reduced() ? 300 : 1100)
    window.setTimeout(() => onDone(s), reduced() ? 400 : 1600)
  }

  const fail = (msg: string, back?: Phase) => {
    setError(msg)
    setShake((n) => n + 1)
    if (back) setPhase(back)
  }

  const onPin = async (pin: string) => {
    if (busy || !known) return
    setError('')
    if (phase === 'pin') {
      setBusy(true)
      try {
        const s = await login(known.name, pin)
        setBusy(false)
        if (s.mustChangePin) {
          // primera vez (clave inicial): debe crear una nueva antes de entrar
          setOldPin(pin)
          setPhase('newpin')
        } else await finish(s)
      } catch (e) {
        setBusy(false)
        fail(loginError(e))
      }
      return
    }
    if (phase === 'newpin') {
      if (pin === INITIAL_PIN) return fail('La nueva clave no puede ser 000000.')
      setFirst(pin)
      return setPhase('confirm')
    }
    // confirm
    if (pin !== first) {
      setFirst('')
      return fail('Las claves no coinciden. Crea la nueva clave otra vez.', 'newpin')
    }
    setBusy(true)
    try {
      const s = await changePin(oldPin, pin)
      setBusy(false)
      await finish(s)
    } catch (e) {
      setBusy(false)
      fail(e instanceof ApiError ? e.message : 'No se pudo guardar la clave.', 'newpin')
    }
  }

  const submitName = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (name.trim().length < 2) return setError('Escribe el nombre del astronauta.')
    setError('')
    setBusy(true)
    try {
      const k = await lookup(name)
      if (!k) return fail('Astronauta no registrado. Solo pueden entrar los astronautas de la nave.')
      setKnown(k)
      setPhase('pin')
    } catch {
      fail('No se pudo conectar con el servidor.')
    } finally {
      setBusy(false)
    }
  }

  const step = phase === 'boot' ? 1 : phase === 'name' ? 2 : phase === 'granted' ? 4 : 3
  const title = phase === 'confirm' ? 'Confirma tu nueva clave' : phase === 'newpin' ? 'Crea tu nueva clave de 6 dígitos' : 'Ingresa tu clave'

  return (
    <div className={`boot slice-in${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label="Acceso a la nave HAYAI">
      <div className="boot-stars" aria-hidden="true" />
      <div className="boot-sweep" aria-hidden="true" />
      <svg className="boot-rings" viewBox="0 0 800 800" aria-hidden="true">
        <circle cx="400" cy="400" r="390" />
        <circle cx="400" cy="400" r="330" className="dash" />
        <circle cx="400" cy="400" r="270" />
        <circle cx="400" cy="400" r="210" className="dash r" />
      </svg>
      <div className="boot-scan" aria-hidden="true" />
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />

      <header className="boot-top">
        <span>HAYAI · NÚCLEO DE MANDO</span>
        <span>FASE {step} / 4</span>
      </header>

      <main className="boot-core">
        <h1 className="boot-title sl" style={{ '--i': 0 } as React.CSSProperties}>
          HAYAI
        </h1>

        {phase === 'boot' && (
          <section aria-live="polite" key="boot">
            <p className="boot-sub sl" style={{ '--i': 1 } as React.CSSProperties}>
              Arranque de sistemas
            </p>
            <div className="boot-bar sl" style={{ '--i': 2 } as React.CSSProperties} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
              <i style={{ width: `${progress}%` }} />
            </div>
            <p className="boot-pct sl" style={{ '--i': 3 } as React.CSSProperties}>
              {Math.round(progress)}%
            </p>
            <ul className="boot-log">
              {LOG.map((l, i) => {
                const done = progress >= ((i + 1) / LOG.length) * 100 - 6
                return (
                  <li key={l} className={`sl ${done ? 'ok' : progress > (i / LOG.length) * 100 ? 'run' : ''}`} style={{ '--i': 4 + i } as React.CSSProperties}>
                    <span>{l}</span>
                    <b>{done ? 'OK' : progress > (i / LOG.length) * 100 ? '···' : ''}</b>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {phase === 'name' && (
          <form onSubmit={submitName} className="boot-form" key="name">
            <p className="boot-sub sl" style={{ '--i': 1 } as React.CSSProperties}>
              Identifica al astronauta
            </p>
            <label className="boot-field sl" style={{ '--i': 2 } as React.CSSProperties}>
              <span>Nombre</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoComplete="off" maxLength={24} />
            </label>
            <p className="boot-err" role="alert">
              {error}
            </p>
            <button type="submit" className="boot-btn sl" style={{ '--i': 3 } as React.CSSProperties} disabled={busy}>
              {busy ? 'Verificando…' : 'Continuar'}
            </button>
          </form>
        )}

        {(phase === 'pin' || phase === 'newpin' || phase === 'confirm') && known && (
          <div className="boot-form" key={phase}>
            <div className="boot-who sl" style={{ '--i': 1 } as React.CSSProperties}>
              <Blobvatar seed={known.avatar} size={64} />
              <p>
                <small>Astronauta</small>
                <strong>{known.name}</strong>
              </p>
            </div>
            {phase === 'newpin' && (
              <p className="boot-note sl" style={{ '--i': 2 } as React.CSSProperties}>
                Entraste con la clave inicial. Por seguridad, crea una clave nueva para continuar.
              </p>
            )}
            <p className="boot-sub sl" style={{ '--i': 3 } as React.CSSProperties}>
              {title}
            </p>
            <Pin key={`${phase}-${shake}`} onComplete={onPin} disabled={busy} shake={shake > 0 && !!error} label={title} />
            <p className="boot-err" role="alert">
              {error}
            </p>
            <button
              type="button"
              className="boot-link"
              onClick={() => {
                setError('')
                setFirst('')
                setOldPin('')
                setKnown(null)
                setPhase('name')
              }}
            >
              Cambiar de astronauta
            </button>
          </div>
        )}

        {phase === 'granted' && known && (
          <div className="boot-form granted" aria-live="polite" key="granted">
            <Blobvatar seed={session?.avatar ?? known.avatar} size={84} />
            <p className="boot-ok">Acceso concedido</p>
            <p className="boot-sub">Bienvenido a bordo, {session?.name ?? known.name}</p>
          </div>
        )}
      </main>

      <footer className="boot-bot">
        <span>ENLACE SEGURO</span>
        <span>TODO ESTÁ CONECTADO</span>
      </footer>

      {curtain && (
        <div className="boot-curtain" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <i key={i} style={{ '--i': i } as React.CSSProperties} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 6 casillas numericas: al teclear un digito pasa a la siguiente; admite borrar, flechas y pegar. */
export function Pin({ onComplete, disabled, shake, label }: { onComplete: (pin: string) => void; disabled: boolean; shake: boolean; label: string }) {
  const [d, setD] = useState<string[]>(Array(6).fill(''))
  const refs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    refs.current[0]?.focus()
  }, [])

  const commit = (next: string[]) => {
    setD(next)
    if (next.every(Boolean)) onComplete(next.join(''))
  }

  return (
    <div className={`pin${shake ? ' shake' : ''}`} role="group" aria-label={label}>
      {d.map((v, i) => (
        <input
          key={i}
          ref={(el) => void (refs.current[i] = el)}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={1}
          value={v}
          disabled={disabled}
          aria-label={`${label}, dígito ${i + 1} de 6`}
          className={v ? 'filled' : ''}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const ch = e.target.value.replace(/\D/g, '').slice(-1)
            if (!ch) return
            const next = [...d]
            next[i] = ch
            commit(next)
            if (i < 5) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault()
              const next = [...d]
              if (next[i]) next[i] = ''
              else if (i > 0) {
                next[i - 1] = ''
                refs.current[i - 1]?.focus()
              }
              setD(next)
            } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
            else if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus()
          }}
          onPaste={(e) => {
            const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
            if (!digits) return
            e.preventDefault()
            const next = Array.from({ length: 6 }, (_, k) => digits[k] ?? '')
            commit(next)
            refs.current[Math.min(digits.length, 5)]?.focus()
          }}
        />
      ))}
    </div>
  )
}
