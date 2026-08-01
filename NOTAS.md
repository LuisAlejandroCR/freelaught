# NOTAS — Freelaught

Media página, como pide el brief. La vista completa del proyecto (qué es, cómo correrlo, números) está en [README.md](README.md); esto es solo lo que el brief pide puntualmente.

## Qué asumí

- **Inventar un match es peor que no tener match.** Umbral de rechazo en 0.45; candidatos ambiguos (top-2 dentro de 0.10, top<0.9) se descartan en vez de adivinar. Resultado: 60% matched (HIGH+MEDIUM), 35% ambiguo, 5% rechazado — el 35% ambiguo no es ruido de datos sucios, es colisión real de nombres (varios "Diana Castro" en 6.000 personas) sin email/teléfono que desempate.
- El "80/20" es sobre el **cohorte identificado**, no sobre todos los compradores: Boom no tiene ningún campo de dinero, así que el ingreso solo se puede calcular con `sales.subtotal` de las ventas que sí matchearon. Con eso, el top 20% (544 de 2.719 invitados identificados) concentra **59.3%** del ingreso matcheado — fuerte, pero menos que el 80/20 clásico; lo digo así en vez de forzar el número.
- La regla "máximo 2 tickets por evento" está marcada como "v2" en el brief — la trato como advertencia (785 casos detectados), no como filtro, porque descartarla hubiera tirado matches válidos de compras grupales legítimas (`sales.qty` > 1).
- Puntos = el campo `boom.points` que ya existe, no una moneda nueva. La redención vía "Puntos Colombia" es un concepto de producto, no una integración real (no hay API pública para eso en 4 horas); el mock usa sus categorías reales (retail ~60%, movilidad ~20%, viajes ~10%, marketplace ~10% de las redenciones, Colombia, reportes 2024–2026).

## Qué señal pesó más

La **mezcla de tipos de ticket** (pagado ~94%, cortesía ~39% empírico) domina la proyección, no la residencia. Probé pesar la residencia al 65% y el error promedio subió de 9.2 a 12.2 asistentes/show — los "hermanos" de una misma residencia varían mucho entre sí (ej. Mala Hora: 85%, 58%, 93% en tres viernes seguidos), porque lo que cambia semana a semana es la mezcla de tipos, no si es residencia o no. Bajé el peso de residencia a 0.15 y el error volvió a 9.2, con 72% de cobertura real en el intervalo p10–p90 sobre los 32 shows de julio (backtest en `src/pipeline/backtest.js`, reusa literalmente la misma función que genera `forecast.csv`).

## Qué haría con 4 horas más

1. Integración real de redención (Puntos Colombia u otro aliado) en vez del panel mock.
2. Revisar a mano una muestra más grande de los 2.209 casos "ambiguos" para ver si un cuarto campo (ej. ciudad) ayuda a desempatar sin arriesgar falsos positivos.
3. Publicar el `/events/:id` en una URL real (Vercel) para que el link efímero de WhatsApp funcione fuera de localhost.
4. Curva de llegada (hora de check-in, no solo cuántos) — quedó fuera de alcance esta vez.
