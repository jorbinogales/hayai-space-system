import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { fmtDate, money, todayISO } from './store'

export interface InvoiceData {
  id: string
  client: string
  concept: string
  amount: number
  /** fecha del pago, YYYY-MM-DD */
  date: string
}

const LOGO = `${import.meta.env.BASE_URL}hayai-logo.png`
const number = (d: InvoiceData) => `HY-${d.id.replace(/\W/g, '').slice(-6).toUpperCase()}`

/** Texto de la factura (para WhatsApp cuando no se puede compartir la imagen). */
const asText = (d: InvoiceData) =>
  [`*HAYAI · Factura ${number(d)}*`, `Cliente: ${d.client}`, `Concepto: ${d.concept}`, `Monto: ${money(d.amount)}`, `Fecha de pago: ${fmtDate(d.date, true)}`, `Estado: pendiente de pago`].join('\n')

/** Dibuja la factura en un canvas (mismo contenido que la vista) y la devuelve como PNG. */
async function toPng(d: InvoiceData): Promise<Blob> {
  const logo = new Image()
  logo.src = LOGO
  await logo.decode()
  const W = 720
  const H = 900
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  g.fillStyle = '#fffdf8'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#ef9d25'
  g.fillRect(0, 0, W, 14)
  const lh = 190
  g.drawImage(logo, 48, 48, lh * (logo.width / logo.height), lh)

  const font = (w: number, s: number) => (g.font = `${w} ${s}px 'Space Grotesk', system-ui, 'Segoe UI', sans-serif`)
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#16110b'
  g.textAlign = 'right'
  font(700, 38)
  g.fillText('FACTURA', W - 48, 110)
  font(500, 22)
  g.fillStyle = '#4a3f33'
  g.fillText(number(d), W - 48, 148)
  g.fillText(`Emitida: ${fmtDate(todayISO(), true)}`, W - 48, 180)

  g.textAlign = 'left'
  const row = (y: number, label: string, value: string, big = false) => {
    g.fillStyle = '#8a7c6a'
    font(600, 18)
    g.fillText(label.toUpperCase(), 48, y)
    g.fillStyle = '#16110b'
    font(big ? 700 : 500, big ? 54 : 28)
    g.fillText(value.length > 34 ? `${value.slice(0, 33)}…` : value, 48, y + (big ? 58 : 36))
  }
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, 270, W - 96, 2)
  row(320, 'Cliente', d.client)
  row(425, 'Concepto', d.concept)
  row(530, 'Fecha de pago', fmtDate(d.date, true))
  g.fillStyle = '#fbeed6'
  g.fillRect(48, 650, W - 96, 150)
  row(690, 'Monto a pagar', money(d.amount), true)
  g.fillStyle = '#8a7c6a'
  font(500, 18)
  g.textAlign = 'center'
  g.fillText('Gracias por confiar en Hayai', W / 2, H - 40)
  return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'))
}

/** Factura de un pago pendiente: se imprime (o guarda como PDF) y se comparte por WhatsApp. */
export default function Invoice({ data, onClose }: { data: InvoiceData; onClose: () => void }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const whatsapp = async () => {
    try {
      const file = new File([await toPng(data)], `factura-${number(data)}.png`, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: asText(data) })
        return
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // el usuario cerro el menu de compartir
    }
    // ponytail: sin Web Share de archivos (p. ej. escritorio) WhatsApp solo recibe texto; adjuntar la imagen a mano
    window.open(`https://wa.me/?text=${encodeURIComponent(asText(data))}`, '_blank', 'noopener')
  }

  return createPortal(
    <div className="modal invoice-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet invoice-sheet" role="dialog" aria-modal="true" aria-labelledby="inv-title">
        <header>
          <h2 id="inv-title">Factura {number(data)}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="invoice-body">
          <article className="invoice-paper">
            <div className="inv-top">
              <img src={LOGO} alt="Hayai" />
              <div>
                <strong>FACTURA</strong>
                <span>{number(data)}</span>
                <span>Emitida: {fmtDate(todayISO(), true)}</span>
              </div>
            </div>
            <dl>
              <dt>Cliente</dt>
              <dd>{data.client}</dd>
              <dt>Concepto</dt>
              <dd>{data.concept}</dd>
              <dt>Fecha de pago</dt>
              <dd>{fmtDate(data.date, true)}</dd>
            </dl>
            <p className="inv-total">
              <small>Monto a pagar</small>
              {money(data.amount)}
            </p>
            <p className="inv-thanks">Gracias por confiar en Hayai</p>
          </article>
        </div>
        <footer>
          <button type="button" className="ghost" onClick={() => window.print()}>
            <Icon name="print" size={16} /> Imprimir
          </button>
          <button type="button" className="primary" onClick={() => void whatsapp()}>
            <Icon name="share" size={16} /> WhatsApp
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
