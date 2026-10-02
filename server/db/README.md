# Base de datos HAYAI

Postgres 16. Esquema en `migrations/` (SQL plano, aplicado en orden por `migrate.mjs`).

## Arrancar

```sh
cp .env.example .env        # DATABASE_URL=postgres://hayai:hayai@localhost:54329/hayai
npm run db:dev              # Postgres embebido (sin Docker); deja la terminal abierta, Ctrl+C lo detiene
# alternativa con Docker:   docker compose up -d   (mismo puerto y credenciales; no corras ambos)
```

## Migrar

```sh
npm run db:migrate          # aplica las migraciones pendientes y las registra en schema_migrations
```

Nunca edites una migración ya aplicada (el runner lo detecta por checksum y aborta): crea `002_lo_que_sea.sql`.

## Reiniciar desde cero

- Embebida: detén `npm run db:dev`, borra `server/.pgdata`, vuelve a arrancar y migrar.
- Docker: `docker compose down -v`, luego `docker compose up -d` y migrar.
