import { useEffect, useState } from 'react'
import { Blobvatar } from './blob'
import { Pin } from './Boot'
import { changePin, type Session } from './auth'
import { ApiError } from './api'
import { reduced } from './warp'

type Phase = 'home' | 'current' | 'new' | 'confirm' | 'done'

const TITLE: Record<Phase, string> = {
  home: 'Perfil del astronauta',
  current: 'Ingresa tu clave actual',
  new: 'Crea tu nueva clave',
  confirm: 'Confirma tu nueva clave',
  done: 'Clave actualizada',
}

/** Perfil del astronauta, con la misma interfaz de nave del acceso: permite cambiar la clave de 6 digitos. */
export default function Profile({ user, onClose }: { user: Session; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('home')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [shake, setShake] = useState(0)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const close = () => {
    setLeaving(true)
    window.setTimeout(onClose, reduced() ? 50 : 350)
  }

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const fail = (msg: string, back?: Phase) => {
    setError(msg)
    setShake((n) => n + 1)
    if (back) setPhase(back)
  }
  const reset = () => {
    setCurrent('')
    setNext('')
    setError('')
    setPhase('home')
  }

  const onPin = async (pin: string) => {
    if (busy) return
    setError('')
    if (phase === 'current') {
      // el servidor verifica la clave actual al guardar; aqui solo se recoge
      setCurrent(pin)
      return setPhase('new')
    }
    if (phase === 'new') {
      if (pin === current) return fail('La nueva clave debe ser distinta de la actual.')
      if (pin === '000000') return fail('La nueva clave no puede ser 000000.')
      setNext(pin)
      return setPhase('confirm')
    }
    if (pin !== next) {
      setNext('')
      return fail('Las claves no coinciden. Crea la nueva clave otra vez.', 'new')
    }
    setBusy(true)
    try {
      await changePin(current, pin)
      setCurrent('')
      setNext('')
      setPhase('done')
    } catch (e) {
      // 403: la clave actual era incorrecta -> se vuelve a pedirla
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) fail('La clave actual es incorrecta.', 'current')
      else if (e instanceof ApiError && e.status === 423) fail('Cuenta bloqueada por demasiados intentos. Intenta más tarde.', 'home')
      else fail(e instanceof ApiError ? e.message : 'No se pudo guardar la clave.', 'home')
      setCurrent('')
      setNext('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`boot profile${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label="Perfil del astronauta">
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
        <button className="boot-x" onClick={close} aria-label="Volver a la nave">
          Volver a la nave ✕
        </button>
      </header>

      <main className="boot-core">
        <h1 className="boot-title">HAYAI</h1>
        <div className="boot-who center">
          <Blobvatar seed={user.avatar} size={phase === 'home' ? 84 : 56} />
          <p>
            <small>Astronauta</small>
            <strong>{user.name}</strong>
          </p>
        </div>
        <p className="boot-sub" aria-live="polite">
          {TITLE[phase]}
        </p>

        {phase === 'home' && (
          <div className="boot-form">
            <p className="boot-err" role="alert">
              {error}
            </p>
            <button className="boot-btn" onClick={() => setPhase('current')}>
              Cambiar clave
            </button>
            <button type="button" className="boot-link" onClick={close}>
              Volver a la nave
            </button>
          </div>
        )}

        {(phase === 'current' || phase === 'new' || phase === 'confirm') && (
          <div className="boot-form">
            <Pin key={`${phase}-${shake}`} onComplete={onPin} disabled={busy} shake={shake > 0 && !!error} label={TITLE[phase]} />
            <p className="boot-err" role="alert">
              {error}
            </p>
            <button type="button" className="boot-link" onClick={reset}>
              Cancelar
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="boot-form granted" aria-live="polite">
            <p className="boot-ok">Listo</p>
            <p className="boot-sub">Tu nueva clave ya está activa</p>
            <button className="boot-btn" onClick={close}>
              Volver a la nave
            </button>
          </div>
        )}
      </main>

      <footer className="boot-bot">
        <span>ENLACE SEGURO</span>
        <span>TODO ESTÁ CONECTADO</span>
      </footer>
    </div>
  )
}
