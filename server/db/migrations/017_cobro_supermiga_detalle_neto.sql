-- Detalle del comprobante del cobro de Super Miga (7 oct 2026), segunda parte: la 015 buscaba el cobro de $75 y no lo encontró, porque en
-- producción quedó registrado por lo NETO que entró (US$ 64,20, convertido a Binance; los $75 eran a tasa BCV). El monto se queda en
-- $64,20: aquí SOLO se rellenan los campos de detalle del comprobante, sin tocar el monto, el estado, la fecha ni las notas.
--   Bs. 65.540,25 | tasa 873,87 | ref 071026007463 | Bancrecer ****8017 -> Mercantil | recibido por Elis | transferencia
-- Condicional y sin fallar: solo actúa si hay exactamente UN cobro de Super Miga (cobrado, 64,20, octubre de 2026) sin ningún dato del
-- detalle y la referencia no está en otro cobro. Si no, avisa y no toca nada (ni el despliegue ni otro ambiente dependen de ese cliente).
DO $$
DECLARE
  hit   uuid[];
  elis  uuid;
BEGIN
  SELECT array_agg(p.id) INTO hit
  FROM payments p JOIN clients c ON c.id = p.client_id
  WHERE c.name ~* 'super\s*migas?'
    AND p.status = 'cobrado' AND p.amount = 64.20 AND p.date >= DATE '2026-10-01' AND p.date <= DATE '2026-10-31'
    AND p.amount_bs IS NULL AND p.exchange_rate IS NULL AND p.rate_date IS NULL AND p.bank_reference IS NULL AND p.bank_origin IS NULL
    AND p.origin_last4 IS NULL AND p.bank_destination IS NULL AND p.received_by IS NULL AND p.method IS NULL;

  IF hit IS NULL OR array_length(hit, 1) <> 1 THEN
    RAISE NOTICE '017: no hay exactamente un cobro de Super Miga de 64,20 por rellenar (%); no se toca nada', coalesce(array_length(hit, 1), 0);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE lower(bank_reference) = '071026007463') THEN
    RAISE NOTICE '017: la referencia 071026007463 ya está en otro cobro; no se toca nada';
    RETURN;
  END IF;
  SELECT id INTO elis FROM users WHERE lower(name) = 'elis';
  IF elis IS NULL THEN
    RAISE NOTICE '017: no existe el socio Elis; no se toca nada';
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
