import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCsv } from "../lib/csv.js";
import { HIGH_THRESHOLD } from "../pipeline/02-match.js";
import { backtest } from "../pipeline/backtest.js";

// Framework-agnostic: returns plain data, no req/res. Both the local dev
// server (src/web/server.js, node:http) and the Vercel serverless functions
// (api/*.js) call into this — one source of truth for the response shapes.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");

const STAFF_PER_GUESTS = 40;
const BASE_CREW = 2;

function loadData() {
  const events = JSON.parse(readFileSync(join(RAW_DIR, "ft_events.json"), "utf-8"));
  const forecast = readCsv(join(ROOT, "forecast.csv")).map((r) => ({
    event_id: r.event_id,
    expected_attendance: Number(r.expected_attendance),
    p10: Number(r.p10),
    p90: Number(r.p90),
  }));
  const forecastByEvent = new Map(forecast.map((f) => [f.event_id, f]));
  const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));
  const derived = existsSync(join(RAW_DIR, "derived.json"))
    ? JSON.parse(readFileSync(join(RAW_DIR, "derived.json"), "utf-8"))
    : { guests: [], vipGuests: [], vipByEvent: {}, puntosColombiaCategories: [], matchedGuestCount: 0, vipRevenueSharePct: 0 };

  const augustEvents = events.filter((e) => e.month === "agosto" || e.is_upcoming);
  const ticketsByEvent = new Map();
  for (const t of tickets) {
    if (!ticketsByEvent.has(t.event_id)) ticketsByEvent.set(t.event_id, []);
    ticketsByEvent.get(t.event_id).push(t);
  }

  return { events, augustEvents, forecastByEvent, ticketsByEvent, derived };
}

function eventSummary(event, data) {
  const f = data.forecastByEvent.get(event.event_id);
  const expected = f?.expected_attendance ?? 0;
  const suggestedStaff = Math.ceil(expected / STAFF_PER_GUESTS) + BASE_CREW;
  return {
    event_id: event.event_id,
    title: event.title,
    artist_name: event.artist_name,
    venue: event.venue,
    city: event.city,
    weekday: event.weekday,
    starts_at: event.starts_at,
    capacity: event.capacity,
    is_residency: event.is_residency,
    tickets_sold: event.tickets_sold,
    expected_attendance: expected,
    p10: f?.p10 ?? null,
    p90: f?.p90 ?? null,
    fill_rate_expected: event.capacity ? Math.min(1, expected / event.capacity) : null,
    suggested_staff: suggestedStaff,
  };
}

function eventDetail(event, data) {
  const summary = eventSummary(event, data);
  const tickets = data.ticketsByEvent.get(event.event_id) ?? [];
  const typeMix = {};
  for (const t of tickets) typeMix[t.ticket_type] = (typeMix[t.ticket_type] || 0) + 1;
  const vipAttending = data.derived.vipByEvent[event.event_id] ?? [];
  return { ...summary, ticket_type_mix: typeMix, vip_guests: vipAttending };
}

export function getEventsSummaries() {
  const data = loadData();
  return data.augustEvents.map((e) => eventSummary(e, data));
}

export function getEventDetail(id) {
  const data = loadData();
  const event = data.augustEvents.find((e) => e.event_id === id);
  return event ? eventDetail(event, data) : null;
}

export function getVipData() {
  const data = loadData();
  return {
    matchedGuestCount: data.derived.matchedGuestCount,
    totalMatchedRevenue: data.derived.totalMatchedRevenue,
    vipRevenueSharePct: data.derived.vipRevenueSharePct,
    vipGuests: data.derived.vipGuests,
    puntosColombiaCategories: data.derived.puntosColombiaCategories,
  };
}

// Pipeline-wide stats (match rate, backtest) that don't belong to a single
// event or guest — the pitch deck reads this instead of baking numbers into
// its HTML, so it always reflects whatever matches.csv/forecast.csv currently
// say instead of going stale the moment the pipeline is re-run.
export function getStats() {
  const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
  const matches = readCsv(join(ROOT, "matches.csv")).map((m) => ({ ...m, confidence: Number(m.confidence) }));
  const high = matches.filter((m) => m.confidence >= HIGH_THRESHOLD).length;
  const medium = matches.length - high;
  const bt = backtest();

  return {
    totalSales: sales.length,
    matched: matches.length,
    matchRatePct: sales.length ? (matches.length / sales.length) * 100 : 0,
    high,
    medium,
    backtest: {
      withinBand: bt.withinBand,
      total: bt.total,
      coveragePct: bt.total ? (bt.withinBand / bt.total) * 100 : 0,
      meanAbsError: bt.meanAbsError,
    },
  };
}
