// Redacta el guión de un potencial en PAS + BAB, a partir de lo que de verdad se encontró de su negocio (datos.fugas). Función pura, sin red
// y sin IA: mismo dato, mismo texto, y nunca aparece nada que no esté en las fugas.
//
//   Problema       un dato REAL de sus fugas ("noté esto: …")
//   Agitación      qué pierde por eso, sin cifras inventadas ni culpar al dueño
//   Transformación («After» del BAB) cómo se ve cuando está resuelto
//   Solución + CTA qué hace HAYAI y UN solo cierre suave: «¿te mando la muestra gratis?»
//
// Reglas: menos de 600 caracteres, 5 líneas cortas, tuteo venezolano coloquial, sin promesas absolutas ni jerga («gurú», «disruptivo»,
// «revolucionario»…). Si el ítem no trae ninguna fuga no se inventa un problema: devuelve null y alguien lo escribe a mano.

export const GUION_PAS_MAX = 600

export type EntradaPAS = { negocio: string | null; fugas: string[] }

type Tema = { id: string; re: RegExp; agitacion: string; despues: string }
const sinTildes = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// El orden importa: lo más concreto primero («sin catálogo en WhatsApp» es de catálogo, no de mensajes).
const TEMAS: Tema[] = [
  {
    id: 'catalogo',
    re: /\b(catalogo|menu|carta|precios?|productos?|portafolio|vitrina|fotos?|lista de)\b/,
    agitacion: 'Cuando el cliente no ve qué vendes ni cuánto cuesta, pregunta menos y compra donde sí lo ve.',
    despues: 'Imagina un catálogo ordenado, con tus productos y precios, que mandas por WhatsApp en un toque.',
  },
  {
    id: 'pedidos',
    re: /\b(pedidos?|reservas?|citas?|agenda|encargos?|comandas?|cuaderno|libreta|papel|excel|a mano|manual(es|mente)?|delivery|domicilios?)\b/,
    agitacion: 'Llevar todo a mano roba tiempo y es fácil que se te pase alguno.',
    despues: 'Imagina cada pedido anotado solo, ordenado y a la vista hasta que se entrega.',
  },
  {
    id: 'inventario',
    re: /\b(inventario|stock|existencias?|merma|cierre de caja|caja)\b/,
    agitacion: 'Cuadrar caja e inventario a mano te quita la noche y deja dudas al cerrar.',
    despues: 'Imagina cerrar el día con las cuentas listas y saber qué te queda sin ponerte a contar.',
  },
  {
    id: 'cobros',
    re: /\b(pagos?|cobros?|transferencias?|pago movil|divisas?|facturas?|fiado|deudas?|cuentas por cobrar)\b/,
    agitacion: 'Cuadrar los pagos a mano deja huecos que se notan cuando ya es tarde.',
    despues: 'Imagina cada pago registrado en el momento, con lo que te deben siempre a la vista.',
  },
  {
    id: 'google',
    re: /\b(google|maps|mapas?|ubicacion|direccion|horarios?|resenas?|calificaciones?|opiniones)\b/,
    agitacion: 'Si no te encuentran o no ven tu horario, el cliente se va al que sí aparece primero.',
    despues: 'Imagina tu ubicación, tu horario y tus fotos al día, y que el cliente llegue sin tener que preguntar.',
  },
  {
    id: 'web',
    re: /\b(web|pagina|sitio|dominio|landing)\b/,
    agitacion: 'Sin un sitio propio dependes solo de las redes para que te conozcan, y no siempre alcanza.',
    despues: 'Imagina una página sencilla donde tus clientes ven lo que vendes y te escriben directo.',
  },
  {
    id: 'seguimiento',
    re: /\b(seguimiento|recompra|fidelizacion|fideliz\w*|base de clientes|clientes recurrentes|promociones?|campanas?|difusion)\b/,
    agitacion: 'Un cliente que te compró una vez y no vuelve a saber de ti tiene pocas razones para regresar.',
    despues: 'Imagina que cada cliente recibe un mensaje a tiempo y vuelve sin que tengas que acordarte.',
  },
  {
    id: 'mensajes',
    re: /\b(dms?|mensajes?|responde\w*|respuestas?|contest\w*|whatsapp|wasap|chat|inbox|atencion|visto)\b/,
    agitacion: 'Cada mensaje que se queda esperando es un cliente que termina escribiéndole a otro.',
    despues: 'Imagina que cada mensaje se contesta al momento, con precios y horarios al día, y tú entras cuando el cliente ya quiere comprar.',
  },
  {
    id: 'redes',
    re: /\b(instagram|facebook|tiktok|redes|publicaciones?|posteos?|contenido|perfil|biografia|bio|seguidores|actividad)\b/,
    agitacion: 'Una cuenta sin movimiento le dice al cliente que el negocio está quieto, aunque tengas trabajo de sobra.',
    despues: 'Imagina tus redes al día sin que tengas que sentarte a publicar.',
  },
]
const GENERAL: Tema = {
  id: 'general',
  re: /$^/,
  agitacion: 'Eso, repetido cada día, se come tiempo y ventas que ya eran tuyas.',
  despues: 'Imagina que ese trabajo se hace solo y tú te dedicas a atender y a vender.',
}

/** «Panadería La Espiga C.A.» → «Panadería La Espiga»; «PANADERÍA LA ESPIGA» → «Panadería La Espiga». */
export function nombreCorto(n: string | null | undefined): string | null {
  let t = (n ?? '').replace(/\s+/g, ' ').trim().replace(/[,;]?\s*\b(c\.?\s?a\.?|s\.?\s?a\.?|s\.?\s?r\.?\s?l\.?|f\.?p\.?)\s*$/i, '').trim()
  if (!t) return null
  if (t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(t)) t = t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
  return t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '') : t
}

/** La fuga lista para ir después de «noté esto:»: sin viñetas ni punto final, en minúscula (salvo siglas como DMs) y de largo razonable. */
export function fugaLimpia(f: string): string | null {
  let t = f.replace(/\s+/g, ' ').trim().replace(/^(?:[-•*·]+\s*|\d{1,2}[.)]\s+)/, '').replace(/[.;:,\s]+$/, '')
  if (!t) return null
  if (t.length > 130) t = t.slice(0, 130).replace(/[\s,;:]+\S*$/, '')
  // «No responde DMs» → «no responde DMs»; «DMs sin responder» y «WhatsApp sin catálogo» se quedan como están
  if (/^\p{Lu}\p{Ll}/u.test(t) && !/^(WhatsApp|Instagram|Facebook|TikTok|Google|Excel|Maps)\b/.test(t)) t = t[0].toLowerCase() + t.slice(1)
  return t
}

/** El tema de la primera fuga que se reconoce (en el orden en que vienen); si ninguna, la primera fuga con el tema general. */
export function elegirFuga(fugas: string[]): { fuga: string; tema: Tema } | null {
  const lista = fugas.map(fugaLimpia).filter((x): x is string => !!x)
  for (const f of lista) {
    const n = sinTildes(f)
    const t = TEMAS.find((x) => x.re.test(n))
    if (t) return { fuga: f, tema: t }
  }
  return lista[0] ? { fuga: lista[0], tema: GENERAL } : null
}

/** El guión PAS+BAB, o null si no hay un problema real del que partir. Siempre < 600 caracteres. */
export function guionPAS(e: EntradaPAS): string | null {
  const el = elegirFuga(e.fugas)
  if (!el) return null
  const nombre = nombreCorto(e.negocio)
  const variantes = [
    { saludo: 'Hola, ¿qué tal? Somos HAYAI, de aquí de Barquisimeto.', cierre: 'En HAYAI armamos ese sistema a tu medida, sin que cambies tu forma de trabajar. ¿Te mando la muestra gratis?' },
    { saludo: 'Hola, somos HAYAI, de Barquisimeto.', cierre: 'En HAYAI armamos ese sistema a tu medida. ¿Te mando la muestra gratis?' },
    { saludo: 'Hola, somos HAYAI.', cierre: 'Armamos ese sistema por ti. ¿Te mando la muestra gratis?' },
  ]
  for (const v of variantes) {
    const texto = [
      v.saludo,
      `Estuve viendo ${nombre ?? 'tu negocio'} y noté esto: ${el.fuga}.`,
      el.tema.agitacion,
      el.tema.despues,
      v.cierre,
    ].join('\n')
    if (texto.length < GUION_PAS_MAX) return texto
  }
  return null
}

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** De `datos` (forma libre) y el título del ítem a lo que necesita `guionPAS`. */
export function entradaDe(datos: Record<string, unknown>, titulo: string): EntradaPAS {
  const n = datos.negocio
  const negocio = txt(n) ?? (rec(n) ? (txt(n.nombre) ?? txt(n.name)) : null) ?? txt(datos.nombre) ?? txt(titulo)
  const lista = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(lista) : rec(v) ? lista(v.fuga ?? v.texto ?? v.descripcion ?? v.detalle ?? v.titulo) : txt(v) ? [txt(v)!] : [])
  return { negocio, fugas: lista(datos.fugas) }
}
