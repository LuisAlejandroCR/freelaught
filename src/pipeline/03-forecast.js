import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeCsv, readCsv } from "../lib/csv.js";
import { isMain } from "../lib/is-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");

// Fallback used only when a ticket type has too few July samples to trust an
// empirical rate (brief-provided priors).
const FALLBACK_RATES = { General: 0.94, Preferencial: 0.94, VIP: 0.94, "Cortesía": 0.42 };
const MIN_SAMPLES_FOR_EMPIRICAL_RATE = 30;
const RESIDENCY_SHRINKAGE_K = 2;
// Backtested against July: ticket-type composition (p_ticket) is the
// dominant, accurate signal — residency siblings vary a lot in attendance
// rate *within the same residency* (driven by that show's own type mix, not
// "is this a residency"), so a heavy residency weight (tried 0.65) roughly
// doubled mean absolute error vs a light one. 0.15 is the best-performing
// small nudge, not the dominant term. See NOTAS.md.
const RESIDENCY_WEIGHT = 0.15;
const MONTE_CARLO_DRAWS = 2000;

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor((p / 100) * (sortedArr.length - 1))));
  return sortedArr[idx];
}

export function computeTicketTypeBaseRates(julyTickets) {
  const byType = new Map();
  for (const t of julyTickets) {
    if (!byType.has(t.ticket_type)) byType.set(t.ticket_type, { checkedIn: 0, total: 0 });
    const bucket = byType.get(t.ticket_type);
    bucket.total++;
    if (t.checked_in) bucket.checkedIn++;
  }
  const rates = {};
  for (const [type, { checkedIn, total }] of byType) {
    rates[type] = total >= MIN_SAMPLES_FOR_EMPIRICAL_RATE ? checkedIn / total : (FALLBACK_RATES[type] ?? 0.7);
  }
  for (const [type, rate] of Object.entries(FALLBACK_RATES)) {
    if (!(type in rates)) rates[type] = rate;
  }
  return rates;
}

// Builds everything both the August forecast and the July backtest share, so
// the two never drift into two different formulas.
export function buildForecastContext({ boomProfiles, events, sales, tickets, matches }) {
  const julyEvents = events.filter((e) => e.month === "julio");
  const eventsById = new Map(events.map((e) => [e.event_id, e]));
  const julyTicketRows = tickets.filter((t) => eventsById.get(t.event_id)?.month === "julio");
  const baseRates = computeTicketTypeBaseRates(julyTicketRows);
  const globalJulyMean = julyEvents.reduce((s, e) => s + e.attendance_rate, 0) / julyEvents.length;

  const saleToBoomUser = new Map(matches.map((m) => [m.sale_id, m.boom_user_id]));
  const boomByUserId = new Map(boomProfiles.map((u) => [u.boom_user_id, u]));
  const saleById = new Map(sales.map((s) => [s.sale_id, s]));

  const ticketsByEvent = new Map();
  for (const t of tickets) {
    if (!ticketsByEvent.has(t.event_id)) ticketsByEvent.set(t.event_id, []);
    ticketsByEvent.get(t.event_id).push(t);
  }

  return { julyEvents, baseRates, globalJulyMean, saleToBoomUser, boomByUserId, saleById, ticketsByEvent };
}

function findResidencySiblings(event, siblingPool) {
  if (!event.is_residency) return [];
  return siblingPool.filter(
    (e) =>
      e.event_id !== event.event_id &&
      e.artist_id === event.artist_id &&
      e.residency_venue === event.residency_venue &&
      e.weekday === event.weekday &&
      e.attendance_rate !== null &&
      e.attendance_rate !== undefined
  );
}

// The one true forecasting formula — used for both the August projection and
// the July backtest, so a backtest result is guaranteed to reflect what
// forecast.csv actually does, not an approximation of it.
export function forecastEvent(event, ctx) {
  const { julyEvents, baseRates, globalJulyMean, saleToBoomUser, boomByUserId, saleById, ticketsByEvent } = ctx;
  const eventTickets = ticketsByEvent.get(event.event_id) ?? [];
  const siblings = findResidencySiblings(event, julyEvents);
  const hasResidencySiblings = siblings.length > 0;
  const residencyRate = hasResidencySiblings
    ? (siblings.length * (siblings.reduce((s, e) => s + e.attendance_rate, 0) / siblings.length) +
        RESIDENCY_SHRINKAGE_K * globalJulyMean) /
      (siblings.length + RESIDENCY_SHRINKAGE_K)
    : null;

  const ticketProbs = eventTickets.map((ticket) => {
    const typeBaseRate = baseRates[ticket.ticket_type] ?? 0.7;
    const sale = saleById.get(ticket.sale_id);
    const boomUserId = sale ? saleToBoomUser.get(sale.sale_id) : undefined;
    const boomUser = boomUserId ? boomByUserId.get(boomUserId) : undefined;
    const pTicket = boomUser ? 0.6 * boomUser.use_rate + 0.4 * typeBaseRate : typeBaseRate;
    return hasResidencySiblings ? RESIDENCY_WEIGHT * residencyRate + (1 - RESIDENCY_WEIGHT) * pTicket : pTicket;
  });

  const expectedAttendance = Math.round(ticketProbs.reduce((s, p) => s + p, 0));

  const sigma = hasResidencySiblings ? 0.05 : 0.1;
  const totals = [];
  for (let draw = 0; draw < MONTE_CARLO_DRAWS; draw++) {
    const z = randomNormal() * sigma;
    let total = 0;
    for (const p of ticketProbs) {
      const pDraw = Math.min(1, Math.max(0, p + z));
      if (Math.random() < pDraw) total++;
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const p10 = percentile(totals, 10);
  const p90 = Math.max(percentile(totals, 90), expectedAttendance);

  return { expectedAttendance, p10, p90, hasResidencySiblings, siblingsCount: siblings.length, residencyRate, ticketsSold: eventTickets.length };
}

export function computeForecast({ boomProfiles, events, sales, tickets, matches }) {
  const ctx = buildForecastContext({ boomProfiles, events, sales, tickets, matches });
  const augustEvents = events.filter((e) => e.month === "agosto" || e.is_upcoming);

  const forecastRows = [];
  const debugRows = [];

  for (const event of augustEvents) {
    const r = forecastEvent(event, ctx);
    forecastRows.push({ event_id: event.event_id, expected_attendance: r.expectedAttendance, p10: r.p10, p90: r.p90 });
    debugRows.push({
      event_id: event.event_id,
      title: event.title,
      is_residency: event.is_residency,
      residency_siblings: r.siblingsCount,
      residency_rate: r.residencyRate !== null ? r.residencyRate.toFixed(3) : "",
      tickets_sold: r.ticketsSold,
      expected_attendance: r.expectedAttendance,
      p10: r.p10,
      p90: r.p90,
      fill_rate_expected: event.capacity ? (r.expectedAttendance / event.capacity).toFixed(2) : "",
    });
  }

  return { forecastRows, debugRows, baseRates: ctx.baseRates, globalJulyMean: ctx.globalJulyMean };
}

export function runForecast() {
  const boomProfiles = JSON.parse(readFileSync(join(RAW_DIR, "boom_profile.json"), "utf-8"));
  const events = JSON.parse(readFileSync(join(RAW_DIR, "ft_events.json"), "utf-8"));
  const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
  const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));
  const matches = readCsv(join(ROOT, "matches.csv")).map((m) => ({ ...m, confidence: Number(m.confidence) }));

  const { forecastRows, debugRows, baseRates, globalJulyMean } = computeForecast({
    boomProfiles,
    events,
    sales,
    tickets,
    matches,
  });

  writeCsv(join(ROOT, "forecast.csv"), ["event_id", "expected_attendance", "p10", "p90"], forecastRows);
  writeCsv(
    join(RAW_DIR, "forecast-debug.csv"),
    ["event_id", "title", "is_residency", "residency_siblings", "residency_rate", "tickets_sold", "expected_attendance", "p10", "p90", "fill_rate_expected"],
    debugRows
  );

  console.log("=== Forecast summary ===");
  console.log("Ticket-type base rates (empirical or fallback):", baseRates);
  console.log(`Global July attendance rate: ${(globalJulyMean * 100).toFixed(1)}%`);
  console.log(`August events forecasted: ${forecastRows.length}`);
  console.log(`Total expected attendance across August: ${forecastRows.reduce((s, r) => s + r.expected_attendance, 0)}`);
  console.log("Debug detail: raw/forecast-debug.csv");

  return { forecastRows, baseRates };
}

if (isMain(import.meta.url)) {
  runForecast();
}
