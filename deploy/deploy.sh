#!/bin/sh
# Corre en el VPS: es el comando forzado (command="...") de la llave de deploy en authorized_keys:
#   restrict,command="sh /srv/hayai/deploy/deploy.sh" ssh-ed25519 AAAA...
# Recibe por stdin los KEY=VALUE que manda el workflow, actualiza el repo, los aplica al .env
# y levanta los contenedores.
set -eu

# Todo dentro de main(): sh lee la función completa antes de ejecutarla, así el `git pull`
# puede actualizar este mismo archivo sin romper la corrida en curso.
main() {
  cd "$(dirname "$0")/.."
  vars=$(mktemp)
  trap 'rm -f "$vars"' EXIT
  cat > "$vars"  # stdin primero: que no lo consuma ningún otro comando

  git pull --ff-only < /dev/null
  sh deploy/apply-env.sh .env < "$vars"
  docker compose -f docker-compose.prod.yml up -d --build < /dev/null
}

main "$@"
exit
