# hayai-space-system

Sistema interno de HAYAI: interfaz espacial (React + Three.js), API Express y Postgres.

## Desarrollo

```bash
npm install
npm run dev:all   # base de datos embebida + API (:3001) + web (:5173)
```

Usuarios iniciales: **Elis**, **Jorbi** y **Leandro**, todos con PIN `000000` (el sistema obliga a crear uno nuevo al entrar).

## Despliegue en un VPS con Docker

Requisitos: Docker con el plugin Compose, un dominio apuntando a la IP del VPS y los puertos 80 y 443 abiertos.

```bash
git clone https://github.com/jorbinogales/hayai-space-system.git && cd hayai-space-system
cp .env.production.example .env   # edita POSTGRES_PASSWORD (openssl rand -hex 24) y DOMAIN
docker compose -f docker-compose.prod.yml up -d --build
```

Levanta tres contenedores: `db` (Postgres 16, con volumen), `app` (API + web; aplica las migraciones al arrancar) y `caddy` (HTTPS automatico). Postgres no se expone a internet.

Cambia los tres PIN iniciales de inmediato: mientras sigan en `000000`, cualquiera con la URL puede entrar.

Actualizar: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

Copia de seguridad: `docker compose -f docker-compose.prod.yml exec db pg_dump -U hayai hayai > backup-$(date +%F).sql`.
