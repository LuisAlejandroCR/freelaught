import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  normalizePhone,
  phonesNearMatch,
  normalizeName,
  scoreEmailMatch,
  scorePhoneMatch,
  scoreNameMatch,
} from "../src/lib/normalize.js";
import { matchSales } from "../src/pipeline/02-match.js";
import { buildForecastContext, forecastEvent, computeTicketTypeBaseRates } from "../src/pipeline/03-forecast.js";
import { deriveProductLayer } from "../src/pipeline/04-derive.js";

const N = 3000;
const SEED = 0xC0FFEE;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (min, max) => min + Math.floor(rng() * (max - min + 1));

const RANDOM_FRAGMENTS = [
  "a", "Z", "0", "9", " ", "@", ".", "+", "-", "_", ",", "'", "\"", "\n", "\r",
  "\u00e9", "\u00ed", "\u00f1", "\u00c1", "\u0301", "\u0300", "ñ", "é", "ü",
  "😀", "\ud83d\ude00", "\u0000", "\ufffd", "(", ")", "/", "\\", "*", "#",
  "hotmail", "gmail", "gmial", "hotmial", "yahoo.comm", "gmail.com", "outlook.com", "icloud.com",
  "3001234567", "+57", "57", "0", "sábado", "miércoles", "Pérez", "MARIA", "juan perez",
];
const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const TICKET_TYPES = ["General", "VIP", "Cortesía", "Preferencial", "Palco", "Taller", "Entrada"];

function randString() {
  if (rng() < 0.1) return rng() < 0.5 ? null : undefined;
  const len = int(0, 40);
  let s = "";
  for (let i = 0; i < len; i++) s += pick(RANDOM_FRAGMENTS);
  return s;
}

test("fuzz: normalize* never throws and satisfies output contracts", () => {
  for (let i = 0; i < N; i++) {
    const raw = randString();
    const email = normalizeEmail(raw);
    if (email) {
      assert.equal(email.normalized, email.normalized.toLowerCase(), `email lowercase: ${JSON.stringify(raw)}`);
      assert.ok(email.normalized.includes("@"), `email has @: ${JSON.stringify(raw)}`);
      assert.equal(email.normalized, `${email.localPart}@${email.domain}`, `normalized = localPart@domain: ${JSON.stringify(raw)}`);
      if (email.domainCorrected) {
        assert.ok(["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com"].includes(email.domain));
      }
    }
    const phone = normalizePhone(raw);
    if (phone) assert.match(phone, /^\d{7,10}$/, `phone keeps 7-10 digits: ${JSON.stringify(raw)}`);
    const name = normalizeName(raw);
    if (name) {
      for (const token of name.tokens) assert.match(token, /^[a-z0-9]+$/, `token clean: ${JSON.stringify(raw)}`);
      assert.equal(name.signature, [...name.tokens].sort().join(" "), `signature sorted: ${JSON.stringify(raw)}`);
    }
  }
});

test("fuzz: score functions stay in bounds and are symmetric", () => {
  for (let i = 0; i < N; i++) {
    const a = normalizeEmail(randString());
    const b = normalizeEmail(randString());
    assert.ok(scoreEmailMatch(a, b) >= 0 && scoreEmailMatch(a, b) <= 0.75);
    assert.equal(scoreEmailMatch(a, b), scoreEmailMatch(b, a));
    const pa = normalizePhone(randString());
    const pb = normalizePhone(randString());
    assert.ok(scorePhoneMatch(pa, pb) >= 0 && scorePhoneMatch(pa, pb) <= 0.55);
    assert.equal(phonesNearMatch(pa, pb), phonesNearMatch(pb, pa));
    const na = normalizeName(randString());
    const nb = normalizeName(randString());
    assert.ok(scoreNameMatch(na, nb) >= 0 && scoreNameMatch(na, nb) <= 0.5);
    assert.equal(scoreNameMatch(na, nb), scoreNameMatch(nb, na));
  }
});

function randBoomUser(id) {
  return {
    boom_user_id: id,
    email: randString(),
    phone: randString(),
    first_name: randString(),
    last_name: randString(),
    points: int(0, 5000),
    use_rate: pick([null, rng(), 0, 1, 0.5]),
  };
}

test("fuzz: matchSales on random populations only emits valid matches", () => {
  for (let i = 0; i < 200; i++) {
    const boom = Array.from({ length: int(1, 8) }, (_, k) => randBoomUser(`u${k}`));
    const ids = new Set(boom.map((u) => u.boom_user_id));
    const sales = Array.from({ length: int(1, 15) }, (_, k) => ({
      sale_id: `s${k}`,
      buyer_email: randString(),
      buyer_phone: randString(),
      buyer_name: randString(),
    }));
    const { matches, stats } = matchSales(boom, sales);
    for (const m of matches) {
      assert.ok(ids.has(m.boom_user_id), "boom_user_id exists in population");
      assert.ok(m.confidence >= 0.45 && m.confidence <= 1, "confidence in [0.45, 1]");
      assert.ok(sales.some((s) => s.sale_id === m.sale_id), "sale_id exists in sales");
    }
    assert.equal(stats.high + stats.medium, matches.length, "stats consistent with matches");
    assert.ok(matches.length <= sales.length, "never more matches than sales");
  }
});

test("fuzz: forecastEvent invariants on random shows", () => {
  const makeWorld = () => {
    const boomUsers = Array.from({ length: int(0, 3) }, (_, k) => randBoomUser(`u${k}`));
    const events = Array.from({ length: int(1, 4) }, (_, k) => ({
      event_id: `evt_${k}`,
      month: pick(["julio", "agosto"]),
      is_residency: rng() < 0.3,
      artist_id: `art_${int(0, 2)}`,
      residency_venue: `venue_${int(0, 2)}`,
      weekday: pick(WEEKDAYS),
      attendance_rate: pick([null, rng(), 0, 1]),
      capacity: int(10, 500),
    }));
    const sales = Array.from({ length: int(0, 6) }, (_, k) => ({
      sale_id: `sale_${k}`,
      event_id: pick(events.map((e) => e.event_id)),
      subtotal: int(0, 200000),
      buyer_email: randString(),
      buyer_phone: randString(),
      buyer_name: randString(),
    }));
    const tickets = Array.from({ length: int(0, 10) }, (_, k) => ({
      ticket_id: `t_${k}`,
      event_id: pick(events.map((e) => e.event_id)),
      sale_id: pick([null, ...sales.map((s) => s.sale_id)]),
      ticket_type: pick(TICKET_TYPES),
      checked_in: pick([null, true, false]),
    }));
    const matches = sales
      .filter(() => rng() < 0.5)
      .map((s) => ({ sale_id: s.sale_id, boom_user_id: pick(boomUsers.map((u) => u.boom_user_id)) }));
    return { boomUsers, events, sales, tickets, matches };
  };

  for (let i = 0; i < 300; i++) {
    const world = makeWorld();
    const ctx = buildForecastContext({ boomProfiles: world.boomUsers, events: world.events, sales: world.sales, tickets: world.tickets, matches: world.matches });
    for (const rate of Object.values(ctx.baseRates)) {
      assert.ok(rate >= 0 && rate <= 1, `base rate in [0,1]: ${rate}`);
    }
    for (const event of world.events) {
      const r = forecastEvent(event, ctx);
      const ticketsSold = ctx.ticketsByEvent.get(event.event_id)?.length ?? 0;
      assert.ok(Number.isFinite(r.expectedAttendance), "expected is finite");
      assert.ok(Number.isInteger(r.expectedAttendance), "expected is integer");
      assert.ok(r.expectedAttendance >= 0 && r.expectedAttendance <= ticketsSold, `expected in [0, ticketsSold]`);
      assert.ok(r.p10 <= r.expectedAttendance, "p10 <= expected");
      assert.ok(r.expectedAttendance <= r.p90, "expected <= p90");
      assert.ok(r.p90 <= ticketsSold, "p90 <= ticketsSold");
      assert.ok(r.p10 >= 0, "p10 >= 0");
      if (event.is_residency && r.hasResidencySiblings) {
        assert.ok(r.residencyRate >= 0 && r.residencyRate <= 1, "residency rate in [0,1]");
      }
    }
  }
});

test("fuzz: computeTicketTypeBaseRates never leaves [0,1]", () => {
  for (let i = 0; i < 100; i++) {
    const tickets = Array.from({ length: int(0, 80) }, (_, k) => ({
      ticket_id: `t${k}`,
      event_id: "j1",
      ticket_type: pick(TICKET_TYPES),
      checked_in: pick([null, true, false]),
    }));
    const rates = computeTicketTypeBaseRates(tickets);
    for (const rate of Object.values(rates)) {
      assert.ok(Number.isFinite(rate) && rate >= 0 && rate <= 1);
    }
  }
});

test("fuzz: deriveProductLayer invariants on random worlds", () => {
  for (let i = 0; i < 150; i++) {
    const boomUsers = Array.from({ length: int(0, 6) }, (_, k) => ({
      boom_user_id: `u${k}`,
      points: int(0, 1000),
      use_rate: pick([null, rng()]),
      first_name: randString(),
      last_name: randString(),
    }));
    const events = Array.from({ length: int(1, 4) }, (_, k) => ({
      event_id: `evt_${k}`,
      weekday: pick(WEEKDAYS),
      title: randString(),
    }));
    const eventIds = events.map((e) => e.event_id);
    const sales = Array.from({ length: int(0, 8) }, (_, k) => ({
      sale_id: `sale_${k}`,
      event_id: pick(eventIds),
      subtotal: int(0, 100000),
    }));
    const matches = sales
      .filter(() => rng() < 0.7)
      .map((s) => ({ sale_id: s.sale_id, boom_user_id: pick(boomUsers.map((u) => u.boom_user_id)) }));

    const d = deriveProductLayer({ boomProfiles: boomUsers, events, sales, tickets: [], matches });
    assert.equal(d.matchedGuestCount, d.guests.length, "guest count consistent");
    const guestIds = new Set(d.guests.map((g) => g.boom_user_id));
    for (const vip of d.vipGuests) {
      assert.ok(guestIds.has(vip.boom_user_id), "vip is a guest");
    }
    assert.ok(d.vipCount <= d.guests.length, "vip count <= guests");
    for (let k = 1; k < d.guests.length; k++) {
      assert.ok(d.guests[k - 1].revenue >= d.guests[k].revenue, "guests sorted desc by revenue");
    }
    assert.ok(d.vipRevenueSharePct >= 0 && d.vipRevenueSharePct <= 100, "share in [0,100]");
    for (const g of d.guests) {
      assert.ok(g.revenue >= 0, "revenue >= 0");
      assert.ok(g.points >= 0, "points >= 0");
      assert.ok(g.events_attended >= 1, "at least one event");
      assert.ok(
        ["datos insuficientes", "sin patrón claro", ...WEEKDAYS].includes(g.weekday_affinity),
        `valid affinity label: ${g.weekday_affinity}`
      );
      for (const evId of g.event_ids) assert.ok(eventIds.includes(evId), "event ids exist");
    }
    if (d.totalMatchedRevenue > 0) {
      const sum = d.guests.reduce((s, g) => s + g.revenue, 0);
      assert.equal(sum, d.totalMatchedRevenue, "revenue sums to total");
    }
  }
});
