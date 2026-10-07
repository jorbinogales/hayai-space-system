import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Cobro from './Cobro'
import { Icon } from './ui'
import { fmtDate, money, todayISO } from './store'

export interface InvoiceLine {
  /** id del cobro (pago) de la línea: con él se abre el detalle del cobro; las líneas agregadas a mano no lo tienen */
  id?: string
  /** YYYY-MM-DD */
  date: string
  concept: string
  amount: number
}

/** Factura MENSUAL de un cliente: todos sus pagos pendientes del mes. */
export interface InvoiceData {
  clientId: string
  client: string
  /** YYYY-MM */
  month: string
  lines: InvoiceLine[]
  /** telefono guardado en la ficha del cliente: si existe, WhatsApp abre directo su chat */
  phone?: string | null
}

/** Solo digitos con codigo de pais, listo para wa.me. '+58 414…' queda igual; '0414…' o '414…' (Venezuela) se completa con 58. null si no sirve. */
export function waNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const plus = raw.trim().startsWith('+')
  let d = raw.replace(/\D/g, '')
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2)
    else if (d.startsWith('0') && d.length === 11) d = `58${d.slice(1)}`
    else if (d.length === 10 && !d.startsWith('0')) d = `58${d}`
  }
  return d.length >= 10 && d.length <= 15 ? d : null
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const monthName = (m: string) => `${MESES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`
const total = (d: InvoiceData) => d.lines.reduce((s, l) => s + l.amount, 0)

const LOGO = `${import.meta.env.BASE_URL}hayai-logo.png`
const number = (d: InvoiceData) => `HY-${d.clientId.replace(/\W/g, '').slice(-4).toUpperCase()}-${d.month.replace('-', '')}`

/** Texto de la factura (para WhatsApp cuando no se puede compartir la imagen). */
const asText = (d: InvoiceData) =>
  [`*HAYAI · Factura ${number(d)}*`, `Cliente: ${d.client}`, `Mes: ${monthName(d.month)}`, ...d.lines.map((l) => `• ${fmtDate(l.date)} · ${l.concept}: ${money(l.amount)}`), `*Total del mes: ${money(total(d))}*`].join('\n')

/** Dibuja la factura en un canvas (mismo contenido que la vista) y la devuelve como PNG. */
async function toPng(d: InvoiceData): Promise<Blob> {
  const logo = new Image()
  logo.src = LOGO
  await logo.decode()
  const W = 720
  const ROW = 64
  const top = 440 // donde empieza la lista de pagos
  const H = top + d.lines.length * ROW + 220
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
  row(320, 'Cliente', d.client.length > 22 ? `${d.client.slice(0, 21)}…` : d.client)
  g.fillStyle = '#8a7c6a'
  font(600, 18)
  g.textAlign = 'right'
  g.fillText('MES', W - 48, 320)
  g.fillStyle = '#16110b'
  font(500, 28)
  g.fillText(monthName(d.month), W - 48, 356)
  g.textAlign = 'left'
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, top - 34, W - 96, 2)
  d.lines.forEach((l, i) => {
    const y = top + i * ROW + 14
    g.fillStyle = '#8a7c6a'
    font(600, 18)
    g.fillText(fmtDate(l.date, true).toUpperCase(), 48, y)
    g.fillStyle = '#16110b'
    font(500, 24)
    g.fillText(l.concept.length > 24 ? `${l.concept.slice(0, 23)}…` : l.concept, 200, y)
    g.textAlign = 'right'
    font(700, 24)
    g.fillText(money(l.amount), W - 48, y)
    g.textAlign = 'left'
  })
  const by = top + d.lines.length * ROW + 10
  g.fillStyle = '#fbeed6'
  g.fillRect(48, by, W - 96, 130)
  row(by + 36, 'Total del mes', money(total(d)), true)
  g.fillStyle = '#8a7c6a'
  font(500, 18)
  g.textAlign = 'center'
  g.fillText('Gracias por confiar en Hayai', W / 2, H - 40)
  return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'))
}

/** Factura mensual de un cliente (sus pagos pendientes del mes): se imprime (o guarda como PDF) y se comparte por WhatsApp. */
export default function Invoice({ data: initial, onClose }: { data: InvoiceData; onClose: () => void }) {
  // los datos se pueden corregir antes de imprimir o compartir; los cambios son solo de esta factura, no tocan los cobros
  const [data, setData] = useState(initial)
  const [edit, setEdit] = useState(false)
  const [cobroId, setCobroId] = useState<string | null>(null)
  const setLine = (i: number, patch: Partial<InvoiceLine>) => setData((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const whatsapp = async () => {
    // Con el telefono de la ficha el chat se abre directo con el cliente (wa.me/<numero>). Sin el, se comparte la imagen como antes.
    const to = waNumber(data.phone)
    if (to) {
      window.open(`https://wa.me/${to}?text=${encodeURIComponent(asText(data))}`, '_blank', 'noopener')
      return
    }
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
            {edit ? (
              <div className="inv-edit">
                <label>
                  Cliente
                  <input value={data.client} onChange={(e) => setData({ ...data, client: e.target.value })} />
                </label>
                <label>
                  Mes
                  <input type="month" value={data.month} onChange={(e) => e.target.value && setData({ ...data, month: e.target.value })} />
                </label>
                {data.lines.map((l, i) => (
                  <div className="inv-eline" key={i}>
                    <input type="date" aria-label="Fecha" value={l.date} onChange={(e) => e.target.value && setLine(i, { date: e.target.value })} />
                    <input aria-label="Concepto" value={l.concept} onChange={(e) => setLine(i, { concept: e.target.value })} />
                    <input type="number" min="0" step="0.01" inputMode="decimal" aria-label="Monto" value={l.amount} onChange={(e) => setLine(i, { amount: Math.max(0, Number(e.target.value) || 0) })} />
                    <button type="button" aria-label="Quitar línea" onClick={() => setData({ ...data, lines: data.lines.filter((_, j) => j !== i) })}>
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
                <button type="button" className="inv-add" onClick={() => setData({ ...data, lines: [...data.lines, { date: `${data.month}-01`, concept: 'Pago', amount: 0 }] })}>
                  <Icon name="plus" size={14} /> Agregar línea
                </button>
              </div>
            ) : (
              <>
                <dl>
                  <dt>Cliente</dt>
                  <dd>{data.client}</dd>
                  <dt>Mes</dt>
                  <dd className="cap">{monthName(data.month)}</dd>
                </dl>
                <ul className="inv-lines">
                  {data.lines.map((l, i) => (
                    <li key={i}>
                      <span className="inv-date">{fmtDate(l.date)}</span>
                      <span className="inv-concept">{l.concept}</span>
                      <b>{money(l.amount)}</b>
                      {l.id && (
                        <button type="button" className="inv-open" onClick={() => setCobroId(l.id!)} aria-label={`Ver el detalle del cobro ${l.concept}`} title="Ver el detalle del cobro">
                          <Icon name="arrow" size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="inv-total">
              <small>Total del mes</small>
              {money(total(data))}
            </p>
            <p className="inv-thanks">Gracias por confiar en Hayai</p>
          </article>
        </div>
        <footer>
          <button type="button" className="ghost" onClick={() => setEdit((v) => !v)} aria-pressed={edit}>
            <Icon name="edit" size={16} /> {edit ? 'Listo' : 'Editar'}
          </button>
          <button type="button" className="ghost" onClick={() => window.print()}>
            <Icon name="print" size={16} /> Imprimir
          </button>
          <button type="button" className="primary" title={waNumber(data.phone) ? 'Abre el chat de WhatsApp del cliente' : 'Comparte la factura por WhatsApp'} onClick={() => void whatsapp()}>
            <Icon name="share" size={16} /> WhatsApp
          </button>
        </footer>
      </div>
      {cobroId && <Cobro id={cobroId} onClose={() => setCobroId(null)} />}
    </div>,
    document.body,
  )
}
