import { Icon } from './ui'
import { setInternal } from './nav'
import './hub.css'

/** Chip del filtro interno pre-aplicado desde el Hub: visible y se quita con un toque. */
export function InternalChip({ label }: { label: string }) {
  return (
    <button type="button" className="int-chip" onClick={() => setInternal(false)} aria-label={`Quitar el filtro «${label}» y ver todo`} title="Quitar el filtro">
      <span>{label}</span>
      <Icon name="close" size={13} />
    </button>
  )
}
