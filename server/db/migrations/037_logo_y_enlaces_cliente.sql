-- 037_logo_y_enlaces_cliente: el logo del cliente (la imagen vive en la BD, igual que los
-- comprobantes de cobro) y los enlaces a los sistemas que el cliente usa (p. ej. su panel).
ALTER TABLE clients ADD COLUMN system_links jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE client_logos (
  client_id   uuid PRIMARY KEY REFERENCES clients (id) ON DELETE CASCADE,
  filename    text NOT NULL CHECK (btrim(filename) <> ''),
  mime        text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  size        integer NOT NULL CHECK (size > 0 AND size <= 4194304),
  data        bytea NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
