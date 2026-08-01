import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readCsv } from "../lib/csv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");
const PUBLIC_DIR = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const STAFF_PER_GUESTS = 40;
const BASE_CREW = 2;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

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
    : { guests: [], vipGuests: [], vipByEvent: {}, mockRedemptionPartners: [], matchedGuestCount: 0, vipRevenueSharePct: 0 };

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

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, path) {
  if (!existsSync(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = extname(path);
  res.writeHead(200, { "Content-Type": (MIME[ext] || "application/octet-stream") + "; charset=utf-8" });
  res.end(readFileSync(path));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/api/events") {
      const data = loadData();
      return sendJson(res, 200, data.augustEvents.map((e) => eventSummary(e, data)));
    }
    if (path.startsWith("/api/events/")) {
      const data = loadData();
      const id = path.split("/")[3];
      const event = data.augustEvents.find((e) => e.event_id === id);
      if (!event) return sendJson(res, 404, { error: "event not found" });
      return sendJson(res, 200, eventDetail(event, data));
    }
    if (path === "/api/vip") {
      const data = loadData();
      return sendJson(res, 200, {
        matchedGuestCount: data.derived.matchedGuestCount,
        totalMatchedRevenue: data.derived.totalMatchedRevenue,
        vipRevenueSharePct: data.derived.vipRevenueSharePct,
        vipGuests: data.derived.vipGuests,
        mockRedemptionPartners: data.derived.mockRedemptionPartners,
      });
    }

    if (path === "/" || path === "/index.html") return sendFile(res, join(PUBLIC_DIR, "index.html"));
    if (path.startsWith("/events/")) return sendFile(res, join(PUBLIC_DIR, "event.html"));
    if (path === "/vip") return sendFile(res, join(PUBLIC_DIR, "vip.html"));
    return sendFile(res, join(PUBLIC_DIR, path.slice(1)));
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`FreeTicket product layer running at http://localhost:${PORT}`);
  console.log(`  /       — 30 shows de agosto, asistencia esperada + rango + staffing`);
  console.log(`  /events/:id — detalle por show, invitados VIP, link efímero`);
  console.log(`  /vip    — Pareto de invitados identificados + puntos`);
});
