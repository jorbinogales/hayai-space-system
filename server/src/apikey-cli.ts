// Gestion de llaves de API desde la terminal.
//   npm run apikey -- create --user Leandro --name growi [--scopes read,write,delete]   (por defecto: read,write)
//   npm run apikey -- list
//   npm run apikey -- revoke <prefijo|id>
// En el VPS:  docker compose -f docker-compose.prod.yml exec app node_modules/.bin/tsx server/src/apikey-cli.ts create --user Leandro --name growi
import { pool } from './db.ts'
import { generateApiKey, SCOPES, type Scope } from './v1/apiKey.ts'

const [cmd, ...rest] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

const usage = () => {
  console.error(
    'Uso:\n  apikey create --user <socio> --name <para-que-sirve> [--scopes read,write,delete]\n  apikey list\n  apikey revoke <prefijo|id>',
  )
  process.exitCode = 1
}

try {
  if (cmd === 'create') {
    const user = flag('user')?.trim()
    const name = flag('name')?.trim()
    const scopes = (flag('scopes') ?? 'read,write').split(',').map((x) => x.trim()).filter(Boolean) as Scope[]
    if (!user || !name) {
      usage()
    } else if (!scopes.length || scopes.some((x) => !SCOPES.includes(x))) {
      console.error(`Permisos inválidos. Usa una lista de: ${SCOPES.join(', ')}`)
      process.exitCode = 1
    } else {
      const u = (await pool.query('SELECT id, name FROM users WHERE lower(name) = lower($1) AND active', [user])).rows[0]
      if (!u) {
        console.error(`No existe un socio activo llamado "${user}".`)
        process.exitCode = 1
      } else {
        const k = generateApiKey()
        await pool.query('INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5)', [
          u.id,
          name,
          k.prefix,
          k.hash,
          scopes,
        ])
        console.log(`Llave creada para ${u.name} (${name}) con permisos: ${scopes.join(', ')}. Lo que haga con ella queda atribuido a ${u.name}.\n`)
        console.log(`  ${k.key}\n`)
        console.log('Guárdala ahora: no se vuelve a mostrar (en la BD solo queda su hash).')
      }
    }
  } else if (cmd === 'list') {
    const { rows } = await pool.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, u.name AS socio, k.created_at, k.last_used_at, k.revoked_at
       FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at`,
    )
    if (!rows.length) console.log('Sin llaves.')
    for (const r of rows)
      console.log(
        `${r.revoked_at ? '[revocada]' : '[activa]  '} ${r.prefix}…  ${r.name}  [${r.scopes.join(',')}]  (${r.socio})  creada ${r.created_at.toISOString().slice(0, 10)}  último uso ${r.last_used_at?.toISOString().slice(0, 16) ?? 'nunca'}  id ${r.id}`,
      )
  } else if (cmd === 'revoke') {
    const ref = rest[0]?.trim()
    if (!ref) {
      usage()
    } else {
      const { rows } = await pool.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE revoked_at IS NULL AND (prefix = $1 OR id::text = $1) RETURNING prefix, name`,
        [ref],
      )
      if (!rows.length) {
        console.error('No hay una llave activa con ese prefijo o id.')
        process.exitCode = 1
      } else console.log(`Revocada: ${rows[0].prefix}… (${rows[0].name})`)
    }
  } else {
    usage()
  }
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
