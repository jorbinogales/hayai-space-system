# HAYAI: una sola imagen con la API (Express) y la web compilada (Vite). Postgres va en su propio contenedor.

# 1) Compila la web (necesita las dependencias de desarrollo: typescript, vite)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) Solo las dependencias de produccion (sin embedded-postgres, concurrently, etc.)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 3) Imagen final
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
USER node
EXPOSE 3001
# Aplica las migraciones pendientes y arranca la API (que tambien sirve ./dist). La primera vez crea los 3 usuarios iniciales.
CMD ["sh", "-c", "node server/db/migrate.mjs && node_modules/.bin/tsx server/src/index.ts"]
