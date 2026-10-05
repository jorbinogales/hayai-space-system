-- 005_api_keys: llaves de API para integraciones (agentes como Growi, MCP). Una llave siempre pertenece a un socio:
-- las escrituras exigen created_by (FK NOT NULL a users), asi que lo que haga una llave queda atribuido a su dueño.
-- Solo se guarda el sha256 de la llave (si se filtra la tabla, las llaves no sirven); la llave en claro se muestra una
-- unica vez al crearla (npm run apikey -- create --user Leandro --name growi).
-- Se revocan (revoked_at), no se borran: quedan como rastro de quien hizo que. ON DELETE RESTRICT por la misma razon.

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name         text NOT NULL CHECK (name = btrim(name) AND name <> ''),   -- para que sirve ("growi")
  prefix       text NOT NULL,                                            -- primeros caracteres, para reconocerla sin exponerla
  key_hash     text NOT NULL UNIQUE,                                     -- el UNIQUE es el indice de busqueda por llave
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);
