import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCsv } from "../src/lib/csv.js";
import { matchSales } from "../src/pipeline/02-match.js";
import { computeForecast } from "../src/pipeline/03-forecast.js";
import { deriveProductLayer } from "../src/pipeline/04-derive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RAW_DIR = join(ROOT, "raw");

const boomProfiles = JSON.parse(readFileSync(join(RAW_DIR, "boom_profile.json"), "utf-8"));
const events = JSON.parse(readFileSync(join(RAW_DIR, "ft_events.json"), "utf-8"));
const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));
const matches = readCsv(join(ROOT, "matches.csv")).map((m) => ({ ...m, confidence: Number(m.confidence) }));
const forecast = readCsv(join(ROOT, "forecast.csv")).map((r) => ({
  event_id: r.event_id,
  expected_attendance: Number(r.expected_attendance),
  p10: Number(r.p10),
  p90: Number(r.p90),
}));
const derived = JSON.parse(readFileSync(join(RAW_DIR, "derived.json"), "utf-8"));

const augustEvents = events.filter((e) => e.month === "agosto" || e.is_upcoming);
const augustIds = new Set(augustEvents.map((e) => e.event_id));
const profileIds = new Set(boomProfiles.map((u) => u.boom_user_id));
const saleIds = new Set(sales.map((s) => s.sale_id));
const eventIds = new Set(events.map((e) => e.event_id));

test("invariant: matches.csv referential integrity", () => {
  assert.ok(matches.length > 0, "matches.csv is not empty");
  const seen = new Set();
  for (const m of matches) {
    assert.ok(saleIds.has(m.sale_id), `sale_id ${m.sale_id} exists in ft_sales.json`);
    assert.ok(profileIds.has(m.boom_user_id), `boom_user_id ${m.boom_user_id} exists in boom_profile.json`);
    assert.ok(!seen.has(m.sale_id), `sale_id ${m.sale_id} is unique`);
    seen.add(m.sale_id);
    assert.ok(m.confidence >= 0.45 && m.confidence <= 1, `confidence in [0.45, 1]: ${m.confidence}`);
  }
});

test("invariant: every matched sale resolves to an event that exists", () => {
  const saleByEvent = new Map(sales.map((s) => [s.sale_id, s.event_id]));
  for (const m of matches) {
    const evId = saleByEvent.get(m.sale_id);
    assert.ok(evId && eventIds.has(evId), `sale ${m.sale_id} maps to a real event`);
  }
});

test("invariant: re-running the matcher reproduces matches.csv exactly", () => {
  const { matches: fresh } = matchSales(boomProfiles, sales);
  const normalized = fresh.map((m) => ({ ...m, confidence: Number(m.confidence) }));
  assert.deepEqual(normalized, matches);
});

test("invariant: forecast.csv is well-formed and within band bounds", () => {
  assert.equal(forecast.length, augustEvents.length, "one row per August event");
  for (const row of forecast) {
    assert.ok(augustIds.has(row.event_id), `event_id ${row.event_id} is an August event`);
    assert.ok(Number.isInteger(row.expected_attendance) && row.expected_attendance >= 0);
    assert.ok(Number.isInteger(row.p10) && row.p10 >= 0, `p10 sane: ${row.p10}`);
    assert.ok(Number.isInteger(row.p90), `p90 integer: ${row.p90}`);
    assert.ok(row.p10 <= row.expected_attendance, `p10 <= expected for ${row.event_id}`);
    assert.ok(row.expected_attendance <= row.p90, `expected <= p90 for ${row.event_id}`);
  }
});

test("invariant: deterministic re-forecast matches stored expected_attendance", () => {
  const { forecastRows } = computeForecast({ boomProfiles, events, sales, tickets, matches });
  const storedByEvent = new Map(forecast.map((f) => [f.event_id, f]));
  assert.equal(forecastRows.length, forecast.length);
  for (const row of forecastRows) {
    const stored = storedByEvent.get(row.event_id);
    assert.ok(stored, `stored row exists for ${row.event_id}`);
    assert.equal(row.expected_attendance, stored.expected_attendance, `expected matches for ${row.event_id}`);
  }
});

test("invariant: derived.json consistency", () => {
  assert.equal(derived.matchedGuestCount, derived.guests.length, "guest count matches array");
  assert.ok(derived.vipCount <= derived.guests.length, "vip count within guests");
  assert.equal(derived.vipGuests.length, derived.vipCount, "vipGuests length matches vipCount");
  const guestIds = new Set(derived.guests.map((g) => g.boom_user_id));
  for (const vip of derived.vipGuests) {
    assert.ok(guestIds.has(vip.boom_user_id), "every vip is a guest");
    assert.ok(derived.guests.find((g) => g.boom_user_id === vip.boom_user_id).revenue >= 0);
  }
  for (let i = 1; i < derived.guests.length; i++) {
    assert.ok(
      derived.guests[i - 1].revenue >= derived.guests[i].revenue,
      "guests sorted desc by revenue"
    );
  }
  assert.ok(derived.vipRevenueSharePct >= 0 && derived.vipRevenueSharePct <= 100, "share in [0,100]");
  const sum = derived.guests.reduce((s, g) => s + g.revenue, 0);
  assert.equal(sum, derived.totalMatchedRevenue, "guest revenue sums to total");
  for (const g of derived.guests) {
    assert.ok(g.points >= 0, "points >= 0");
    for (const evId of g.event_ids) assert.ok(eventIds.has(evId), `event ${evId} exists`);
  }
  for (const evId of Object.keys(derived.vipByEvent)) {
    assert.ok(eventIds.has(evId), `vipByEvent key ${evId} is a real event`);
    for (const v of derived.vipByEvent[evId]) assert.ok(guestIds.has(v.boom_user_id), "vip per event is a guest");
  }
});

test("invariant: re-running the derive step reproduces derived.json", () => {
  const fresh = deriveProductLayer({ boomProfiles, events, sales, tickets, matches });
  assert.equal(fresh.matchedGuestCount, derived.matchedGuestCount);
  assert.equal(fresh.vipCount, derived.vipCount);
  assert.ok(Math.abs(fresh.vipRevenueSharePct - derived.vipRevenueSharePct) < 0.001, "share reproducible");
  assert.deepEqual(fresh.guests.map((g) => g.boom_user_id), derived.guests.map((g) => g.boom_user_id));
  assert.deepEqual(fresh.vipGuests.map((g) => g.boom_user_id), derived.vipGuests.map((g) => g.boom_user_id));
  assert.deepEqual(fresh.puntosColombiaCategories, derived.puntosColombiaCategories);
  assert.deepEqual(fresh.freeticketRewards, derived.freeticketRewards);
});

test("invariant: max-2-tickets-per-user-per-event is a soft warning (brief: not necessarily active)", () => {
  const saleToBoomUser = new Map(matches.map((m) => [m.sale_id, m.boom_user_id]));
  const counts = new Map();
  for (const ticket of tickets) {
    const boomUserId = saleToBoomUser.get(ticket.sale_id);
    if (!boomUserId) continue;
    const key = `${ticket.event_id}|${boomUserId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const violations = [...counts.values()].filter((c) => c > 2).length;
  console.log(`[soft] max-2-tickets violations: ${violations} — expected per brief, reported not enforced`);
  assert.ok(violations >= 0);
});

test("invariant: forecast never exceeds event capacity for headroom view", () => {
  const capacityById = new Map(augustEvents.map((e) => [e.event_id, e.capacity]));
  for (const row of forecast) {
    const cap = capacityById.get(row.event_id);
    if (cap && cap > 0) {
      assert.ok(row.p90 <= cap, `p90 within capacity for ${row.event_id}`);
    }
  }
});
