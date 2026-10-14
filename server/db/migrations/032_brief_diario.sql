-- 032_brief_diario: el «Brief del día» del Hub. Uno por socio y por día (fecha de Caracas): se redacta una vez, se guarda aquí y se sirve
-- de aquí el resto del día; «Actualizar» lo vuelve a redactar y lo reemplaza. Al borrar un socio se van sus briefs.
CREATE TABLE briefs (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day          date NOT NULL,
  content      jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  -- con qué se redactó: el modelo de IA, o NULL si salió de la plantilla (sin IA configurada o si la IA falló)
  model        text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
