# Freelaught — proyecto de FreeTicket

FreeTicket conoce a sus invitados: quién viene a cada show, quién es VIP y qué premio darle. Matching Boom × FreeTicket, forecast de asistencia con bandas de confianza y Pareto VIP con puntos — para que el operador del venue staffee, premie y venda mejor.

## Hackathon

- **Reto:** FreeTicket × Boom — conecta ambas plataformas vía la API `https://hackathon-freeticket.vercel.app`
- **Entregables:** `matches.csv` (3.841 matches), `forecast.csv` (30 shows de agosto con banda `[p10–p90]`), `NOTAS.md`, y la web en `src/web/`
- **Demo:** 3 minutos, terminal en mano — [TODO: fecha/hora oficial]

## Estado

| Componente | Estado |
|---|---|
| Pipeline (fetch → match → forecast → derive → backtest) | ✅ Funcional |
| `matches.csv` / `forecast.csv` / `NOTAS.md` | ✅ Generados |
| Web: `/` dashboard · `/events/:id` detalle · `/vip` Pareto · `/pitch` deck | ✅ Funcional |
| Tests (unit + fuzz + invariant) | ✅ 37/37 verde |

## Stack

Node.js ≥20, ESM, **cero dependencias**: pipeline con `node:fetch`/`node:fs`, tests con `node:test`, web con `node:http` + HTML/CSS/JS vanilla (palette de appfreeticket.com).

## Cómo correr

```bash
npm run run-all   # pipeline completo: 01-fetch → 02-match → 03-forecast → 04-derive
npm run backtest  # valida el forecast contra julio (23/32 shows dentro de la banda)
npm test          # 37 tests: unit + fuzz + invariant
npm run web       # http://localhost:3000 — dashboard, detalle, VIP, pitch
```
