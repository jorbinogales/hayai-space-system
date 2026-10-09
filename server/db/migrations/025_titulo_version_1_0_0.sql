-- La 1.0.0 vuelve a titularse «Versión de Mierda» (dato, no esquema: solo se renombra esa entrada, el resto del log queda igual).
UPDATE app_versions SET title = 'Versión de Mierda' WHERE version = '1.0.0';
