import { pathToFileURL } from 'node:url'
import { hashPin, INITIAL_PIN } from './auth.ts'
import { pool } from './db.ts'

const PARTNERS = [
  { name: 'Elis', avatar: 'nova', role: 'Gerencia y administración', duties: 'Operación del negocio, relación con clientes, visitas en campo, cobranza y administración.' },
  { name: 'Jorbi', avatar: 'orion', role: 'Backend e IA', duties: 'Arquitectura y backend de los sistemas, automatización con IA, despliegues y servidores.' },
  { name: 'Leandro', avatar: 'vega', role: 'Marketing digital', duties: 'Vibe marketing: contenido, campañas de Meta Ads, embudo y comunicación de la marca.' },
]

/** Idempotente: crea solo los socios que falten (nunca toca PIN ni datos de los existentes). Cero datos de demo. */
export async function seed(): Promise<number> {
  let created = 0
  for (const p of PARTNERS) {
    const { rowCount } = await pool.query(
      `INSERT INTO users (name, avatar, role, pin_hash, must_change_pin, active, role_title, responsibilities)
       VALUES ($1, $2, 'SOCIO', $3, true, true, $4, $5) ON CONFLICT DO NOTHING`,
      [p.name, p.avatar, await hashPin(INITIAL_PIN), p.role, p.duties],
    )
    created += rowCount ?? 0
  }
  return created
}

export async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
  if (rows[0].n === 0) console.log(`seed: ${await seed()} socios creados (PIN inicial ${INITIAL_PIN})`)
}

// npm run db:seed
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`seed: ${await seed()} socios creados`)
  } finally {
    await pool.end()
  }
}
