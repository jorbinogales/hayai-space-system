import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { dismissToast, useToasts, type Toast } from './toast'
import './toast.css'

/** Un aviso: «Listo ✓», lo creado y (si se puede) «Deshacer». Se cierra solo; con el ratón o el foco encima se queda quieto. */
function ToastItem({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const left = useRef(t.ms)
  const since = useRef(0)
  useEffect(() => {
    if (paused || busy) return
    since.current = Date.now()
    const timer = window.setTimeout(() => dismissToast(t.id), Math.max(left.current, 0))
    return () => {
      window.clearTimeout(timer)
      left.current -= Date.now() - since.current
    }
  }, [paused, busy, t.id])

  const undo = async () => {
    if (!t.undo || busy) return
    setBusy(true)
    setErr('')
    try {
      await t.undo()
      dismissToast(t.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo deshacer.')
      setBusy(false)
      left.current = 6000
    }
  }

  return (
    <li
      className={`tst is-${t.tone}${busy ? ' is-busy' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="tst-ico" aria-hidden="true">
        <Icon name="check" size={16} />
      </span>
      <p>
        <b>{t.text}</b>
        {t.detail && <small>{t.detail}</small>}
        {err && (
          <small className="tst-err" role="alert">
            {err}
          </small>
        )}
      </p>
      {t.undo && (
        <button type="button" className="tst-undo" disabled={busy} onClick={() => void undo()}>
          {busy ? 'Deshaciendo…' : 'Deshacer'}
        </button>
      )}
      <button type="button" className="tst-x" aria-label="Cerrar el aviso" onClick={() => dismissToast(t.id)}>
        <Icon name="close" size={14} />
      </button>
      <i className="tst-bar" aria-hidden="true" style={{ animationDuration: `${t.ms}ms`, animationPlayState: paused || busy ? 'paused' : 'running' }} />
    </li>
  )
}

/** Avisos flotantes de toda la app (abajo al centro). Un solo lugar, montado una vez en App. */
export default function ToastHost() {
  const list = useToasts()
  if (list.length === 0) return null
  return createPortal(
    <ul className="tst-host" role="status" aria-live="polite" aria-label="Avisos">
      {list.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </ul>,
    document.body,
  )
}
