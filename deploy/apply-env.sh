#!/bin/sh
# Corre en el VPS, llamado desde el script "deploy" ANTES de `docker compose up`:
#   sh deploy/apply-env.sh /ruta/al/.env
# Lee KEY=VALUE por stdin (lo que manda el workflow) y los inserta/actualiza en el .env.
# Solo toca las claves recibidas; el resto del .env queda igual.
set -eu
f=$1; new=$(mktemp); tmp=$(mktemp)
cat > "$new"
[ -s "$new" ] || { rm -f "$new" "$tmp"; exit 0; }  # nada recibido: no tocar
touch "$f"; cp "$f" "$tmp"
for k in $(cut -d= -f1 "$new"); do grep -v "^$k=" "$tmp" > "$tmp.2" || true; mv "$tmp.2" "$tmp"; done
cat "$new" >> "$tmp"
install -m 600 "$tmp" "$f"; rm -f "$new" "$tmp"
