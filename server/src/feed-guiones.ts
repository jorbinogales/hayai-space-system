// Reescribe los guiones de los potenciales del feed al formato PAS + BAB (Problema → Agitación → Transformación → Solución + CTA suave,
// menos de 600 caracteres). Parte SIEMPRE de las fugas reales de cada negocio: sin fugas no inventa nada y lo deja para escribirlo a mano.
//
//   npm run feed:guiones                  -> ENSAYO (por defecto): muestra cómo quedaría cada guión y no cambia nada
//   npm run feed:guiones -- --aplicar     -> lo aplica: el texto anterior queda como versión 0 y el nuevo es el original
//   npm run feed:guiones -- --id <uuid>   -> solo ese ítem (útil para revisar uno antes de aplicar todos)
//   npm run feed:guiones -- --limite N
//
// No toca los guiones que alguien ya editó ni los ya reescritos (se puede correr las veces que haga falta). Usa DATABASE_URL como el servidor.
import { pool } from './db.ts'
import { reescribirOriginales } from './feedGuion.ts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const val = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const limite = val('limite') ? Number(val('limite')) : undefined
if (limite !== undefined && (!Number.isInteger(limite) || limite < 1)) {
  console.error('--limite debe ser un entero positivo')
  process.exit(2)
}
const aplicar = flag('aplicar')
console.log(aplicar ? 'APLICANDO la reescritura (el texto anterior queda como versión 0)\n' : 'ENSAYO: no se cambia nada (usa --aplicar para aplicarlo)\n')
const r = await reescribirOriginales({
  aplicar,
  id: val('id'),
  limite,
  progreso: (id, titulo, res, nuevo) => {
    console.log(`${res.padEnd(13)} ${titulo.slice(0, 60)}  (${id})`)
    if (nuevo) console.log(nuevo.split('\n').map((l) => `    ${l}`).join('\n') + `\n    [${nuevo.length} caracteres]\n`)
  },
})
console.log(`\nRevisados: ${r.revisados} · ${aplicar ? 'reescritos' : 'se reescribirían'}: ${r.reescrito} · sin fugas (a mano): ${r.sin_fugas} · ya editados por alguien: ${r.editado} · ya reescritos: ${r.ya_reescrito} · sin cambio: ${r.igual}`)
await pool.end()
