-- Datos reales del comprobante del cobro de Super Miga (7 oct 2026): los campos del detalle existen desde la 010, pero este cobro se
-- registró antes y quedó vacío. Es un dato, no un esquema: se rellena UNA vez, sin pisar nada.
--   $75 | Bs. 65.540,25 | tasa 873,87 | ref 071026007463 | Bancrecer ****8017 -> Mercantil | recibido por Elis | transferencia
-- Prudente a propósito: solo actúa si encuentra exactamente UN cobro de ese cliente (cobrado, 75 USD, de octubre de 2026) que aún
-- no tiene ningún dato del detalle, y si la referencia no está en otro cobro. Si no hay uno solo, avisa y no toca nada (la migración
-- no falla: ni el despliegue ni otro ambiente, como desarrollo o las pruebas, dependen de que ese cliente exista).
DO $$
DECLARE
  hit   uuid[];
  elis  uuid;
BEGIN
  SELECT array_agg(p.id) INTO hit
  FROM payments p JOIN clients c ON c.id = p.client_id
  WHERE c.name ~* 'super\s*migas?'
    AND p.status = 'cobrado' AND p.amount = 75 AND p.date >= DATE '2026-10-01' AND p.date <= DATE '2026-10-31'
    AND p.amount_bs IS NULL AND p.exchange_rate IS NULL AND p.rate_date IS NULL AND p.bank_reference IS NULL AND p.bank_origin IS NULL
    AND p.origin_last4 IS NULL AND p.bank_destination IS NULL AND p.received_by IS NULL AND p.method IS NULL;

  IF hit IS NULL OR array_length(hit, 1) <> 1 THEN
    RAISE NOTICE '015: no hay exactamente un cobro de Super Miga por rellenar (%); no se toca nada', coalesce(array_length(hit, 1), 0);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE lower(bank_reference) = '071026007463') THEN
    RAISE NOTICE '015: la referencia 071026007463 ya está en otro cobro; no se toca nada';
    RETURN;
  END IF;
  SELECT id INTO elis FROM users WHERE lower(name) = 'elis';
  IF elis IS NULL THEN
    RAISE NOTICE '015: no existe el socio Elis; no se toca nada';
    RETURN;
  END IF;

  UPDATE payments SET
    amount_bs = 65540.25, exchange_rate = 873.87, rate_date = date,
    bank_reference = '071026007463',
    bank_origin = 'Bancrecer', origin_last4 = '8017', bank_destination = 'Mercantil',
    received_by = elis, received_by_source = 'manual',
    method = 'transferencia'
  WHERE id = hit[1];
END $$;
