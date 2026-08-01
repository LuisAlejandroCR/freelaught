# Freelaught — ¿Cuánta gente entra realmente?

Se venden 500 tickets a un show. ¿Entran 500, 380 o 240? Hoy nadie lo sabe, y la puerta se dimensiona a ojo.

Este repo hace dos cosas:

1. **Cruza** compradores de la tiquetera (FreeTicket) con usuarios de la plataforma de membresías (Boom) — sin ID compartido, con emails mal escritos, teléfonos en cinco formatos y nombres en cualquier orden — y **proyecta** cuánta gente entra realmente a cada show de agosto, con rango de incertidumbre.
2. Convierte esa proyección en un **producto**: identifica a los invitados recurrentes que más aportan (Pareto), detecta su día favorito de la semana, y arma un panel de puntos/redención sobre eso — la puerta deja de operarse a ojo y el negocio gana una palanca de fidelización sobre datos reales.

## Resultados clave

| Qué | Número |
|---|---|
| Ventas cruzadas contra Boom con confianza suficiente | 3.841 / 6.383 (60.2%) |
| Shows de agosto proyectados | 30 |
| Cobertura real del rango p10–p90 (backtest contra julio) | 23/32 shows (72%) |
| Error promedio del backtest | 9.2 asistentes/show |
| Invitados identificados (cohorte matcheado) | 2.719 |
| Ese ingreso lo concentra el 20% top de invitados VIP en | 59.3% |

Los supuestos, qué señal pesó más, y qué se haría con 4 horas más están en [NOTAS.md](NOTAS.md) — ese archivo es el entregable técnico corto que pide el hackathon; este README es la vista completa del proyecto.

## Cómo correr esto

```bash
npm run run-all   # fetch -> match -> forecast -> derive -> backtest, un solo comando
npm run web       # levanta la capa de producto en http://localhost:3000
```

Necesita un token del hackathon en `.ft-hack.json` (no incluido, es personal — `npx github:LucasLeguizamo/hackathon-freeticket setup tu-nombre`).

## Qué genera

- `matches.csv` — `sale_id, boom_user_id, confidence`
- `forecast.csv` — `event_id, expected_attendance, p10, p90` (agosto)
- `raw/derived.json` — VIP/Pareto, día favorito por invitado, puntos (consumido por la capa web)
- Capa web: `/` (los 30 shows), `/events/:id` (detalle + link efímero para la puerta), `/vip` (Pareto + puntos)

## Stack

Node puro (ESM nativo, `fetch` nativo, cero dependencias de runtime) — tanto el pipeline de datos como el servidor web. Sin frameworks, sin build step: el volumen de datos es chico y el camino crítico no depende de `npm install` en wifi de café internet.

## Estructura

```
src/
├── lib/            # api-client (fuerza una plataforma por consulta), normalize (matching), csv
├── pipeline/        # 01-fetch, 02-match, 03-forecast, 04-derive, backtest, run-all
└── web/              # servidor node:http + páginas estáticas
matches.csv, forecast.csv, NOTAS.md   # entregables del hackathon
```
