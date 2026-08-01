import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCsv } from "../lib/csv.js";
import { isMain } from "../lib/is-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");

const PARETO_SHARE = 0.2;
const MIN_EVENTS_FOR_AFFINITY = 2;
const AFFINITY_THRESHOLD = 0.5;

// Real Puntos Colombia national redemption categories — not invented.
// Sources: Valora Analitik (entrevista CPO Steven Páez) + reportes oficiales
// Puntos Colombia 2025-2026, El Colombiano 2024. Documentado con detalle en
// docs/plan.md ("Redención — contexto real"). Shares no suman 100%: sales
// de metodologías de medición distintas, no una sola torta — se muestran tal
// como se reportaron, sin normalizar.
// Lo que SÍ es mock: no hay integración con la API de Puntos Colombia (no es
// pública) — esto es contexto de mercado real, no una función de canje real.
const PUNTOS_COLOMBIA_CATEGORIES = [
  { category: "Retail / Mercado", partner: "Grupo Éxito", sharePct: 60, note: "La categoría más redimida a nivel país", venueRelevant: false },
  { category: "Movilidad", partner: "Gasolina, peajes, SOAT", sharePct: 20, note: ">40% de usuarios redimieron · +21% vs año anterior", venueRelevant: false },
  { category: "Viajes", partner: "85% vuelos", sharePct: 10, note: "Top: Medellín, Bogotá, Cartagena, Barranquilla", venueRelevant: false },
  { category: "Marketplace", partner: "Tienda Online", sharePct: 10, note: "Canje directo por productos", venueRelevant: false },
  { category: "Gastronomía", partner: "Preferencia declarada", sharePct: 7.5, note: "7–8% — la categoría donde el venue compite directo", venueRelevant: true },
  { category: "Moda", partner: "Preferencia declarada", sharePct: 7.5, note: "7–8%", venueRelevant: false },
  { category: "Bienestar", partner: "Preferencia declarada", sharePct: 7.5, note: "7–8%", venueRelevant: false },
];

// FreeTicket's own venue rewards — not researched market data like the list
// above. This mirrors a redemption mechanism that already exists live in
// FreeTicket (per the product team), just not currently surfaced on the
// public appfreeticket.com/comunidades page — we expose it here using the
// guest's real Boom points, independent of any external alliance like
// Puntos Colombia.
const FREETICKET_REWARDS = [
  { item: "Combo comida", costPoints: 50, detail: "Snack + bebida en cualquier show", icon: "🍟" },
  { item: "Souvenir de la noche", costPoints: 120, detail: "Poster o merch del show que estás viendo", icon: "🎁" },
  { item: "Upgrade a Preferencial", costPoints: 200, detail: "Silla preferencial en tu próximo show", icon: "🎟️" },
];

function computeWeekdayAffinity(weekdayCounts, totalEvents) {
  if (totalEvents < MIN_EVENTS_FOR_AFFINITY) return { weekday: null, share: null, label: "datos insuficientes" };
  let bestDay = null;
  let bestCount = 0;
  for (const [day, count] of weekdayCounts) {
    if (count > bestCount) {
      bestDay = day;
      bestCount = count;
    }
  }
  const share = bestCount / totalEvents;
  if (share >= AFFINITY_THRESHOLD) return { weekday: bestDay, share, label: bestDay };
  return { weekday: null, share, label: "sin patrón claro" };
}

export function deriveProductLayer({ boomProfiles, events, sales, tickets, matches }) {
  const eventsById = new Map(events.map((e) => [e.event_id, e]));
  const boomByUserId = new Map(boomProfiles.map((u) => [u.boom_user_id, u]));
  const saleById = new Map(sales.map((s) => [s.sale_id, s]));

  // guest_id -> aggregated purchase history, built only from matched sales —
  // this cohort is "invitados identificados", not the full buyer base (see
  // NOTAS.md: Boom has no revenue field, and a large share of buyers never
  // matched, so this Pareto is necessarily scoped to the matched cohort).
  const guestData = new Map();

  for (const match of matches) {
    const sale = saleById.get(match.sale_id);
    if (!sale) continue;
    const event = eventsById.get(sale.event_id);
    if (!event) continue;

    if (!guestData.has(match.boom_user_id)) {
      guestData.set(match.boom_user_id, { revenue: 0, events: new Map(), weekdayCounts: new Map(), salesCount: 0 });
    }
    const guest = guestData.get(match.boom_user_id);
    guest.revenue += Number(sale.subtotal) || 0;
    guest.salesCount += 1;
    if (!guest.events.has(event.event_id)) {
      guest.events.set(event.event_id, true);
      guest.weekdayCounts.set(event.weekday, (guest.weekdayCounts.get(event.weekday) || 0) + 1);
    }
  }

  const guests = [...guestData.entries()].map(([boomUserId, guest]) => {
    const boomUser = boomByUserId.get(boomUserId);
    const affinity = computeWeekdayAffinity(guest.weekdayCounts, guest.events.size);
    return {
      boom_user_id: boomUserId,
      name: boomUser ? `${boomUser.first_name} ${boomUser.last_name}` : boomUserId,
      revenue: guest.revenue,
      events_attended: guest.events.size,
      sales_count: guest.salesCount,
      points: boomUser?.points ?? 0,
      use_rate: boomUser?.use_rate ?? null,
      weekday_affinity: affinity.label,
      event_ids: [...guest.events.keys()],
    };
  });

  guests.sort((a, b) => b.revenue - a.revenue);

  const totalMatchedRevenue = guests.reduce((s, g) => s + g.revenue, 0);
  const vipCount = Math.ceil(guests.length * PARETO_SHARE);
  const vipGuests = guests.slice(0, vipCount);
  const vipRevenue = vipGuests.reduce((s, g) => s + g.revenue, 0);
  const vipRevenueSharePct = totalMatchedRevenue > 0 ? (vipRevenue / totalMatchedRevenue) * 100 : 0;

  const vipByEvent = new Map();
  for (const guest of vipGuests) {
    for (const eventId of guest.event_ids) {
      if (!vipByEvent.has(eventId)) vipByEvent.set(eventId, []);
      vipByEvent.get(eventId).push({ boom_user_id: guest.boom_user_id, name: guest.name, weekday_affinity: guest.weekday_affinity, points: guest.points });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    matchedGuestCount: guests.length,
    totalMatchedRevenue,
    vipCount,
    vipRevenueSharePct,
    guests,
    vipGuests,
    vipByEvent: Object.fromEntries(vipByEvent),
    puntosColombiaCategories: PUNTOS_COLOMBIA_CATEGORIES,
    freeticketRewards: FREETICKET_REWARDS,
  };
}

export function runDerive() {
  const boomProfiles = JSON.parse(readFileSync(join(RAW_DIR, "boom_profile.json"), "utf-8"));
  const events = JSON.parse(readFileSync(join(RAW_DIR, "ft_events.json"), "utf-8"));
  const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
  const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));
  const matches = readCsv(join(ROOT, "matches.csv")).map((m) => ({ ...m, confidence: Number(m.confidence) }));

  const derived = deriveProductLayer({ boomProfiles, events, sales, tickets, matches });
  writeFileSync(join(RAW_DIR, "derived.json"), JSON.stringify(derived, null, 2), "utf-8");

  console.log("=== Product layer summary ===");
  console.log(`Invitados identificados (matched cohort): ${derived.matchedGuestCount}`);
  console.log(`VIP (top 20% por ingreso del cohorte matcheado): ${derived.vipCount}`);
  console.log(`Ese ${derived.vipCount}/${derived.matchedGuestCount} concentra ${derived.vipRevenueSharePct.toFixed(1)}% del ingreso matcheado`);
  console.log(`Guardado en raw/derived.json`);

  return derived;
}

if (isMain(import.meta.url)) {
  runDerive();
}
