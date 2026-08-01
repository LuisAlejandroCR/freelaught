import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { computeTicketTypeBaseRates, buildForecastContext, forecastEvent, computeForecast } from "../src/pipeline/03-forecast.js";
import { deriveProductLayer } from "../src/pipeline/04-derive.js";
import { writeCsv, readCsv } from "../src/lib/csv.js";

test("normalizeEmail: lowercase, trim, plus-alias strip", () => {
  const e = normalizeEmail("  Foo+Promo@GMail.COM  ");
  assert.equal(e.normalized, "foo@gmail.com");
  assert.equal(e.localPart, "foo");
  assert.equal(e.domain, "gmail.com");
  assert.equal(e.domainCorrected, false);
});

test("normalizeEmail: corrects unambiguous domain typos", () => {
  const e1 = normalizeEmail("foo@gmial.com");
  assert.equal(e1.domain, "gmail.com");
  assert.equal(e1.domainCorrected, true);
  const e2 = normalizeEmail("foo@hotmial.com");
  assert.equal(e2.domain, "hotmail.com");
});

test("normalizeEmail: never corrects ambiguous or unknown domains", () => {
  const e1 = normalizeEmail("foo@xyz.com"); // distance >2 from every whitelist entry
  assert.equal(e1.domain, "xyz.com");
  assert.equal(e1.domainCorrected, false);
  const e2 = normalizeEmail("foo@corp.example");
  assert.equal(e2.domain, "corp.example");
  assert.equal(e2.domainCorrected, false);
});

test("normalizeEmail: invalid inputs return null", () => {
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail("no-at-sign"), null);
});

test("normalizePhone: strips non-digits, keeps last 10", () => {
  assert.equal(normalizePhone("+57 (300) 123-4567"), "3001234567");
  assert.equal(normalizePhone("573001234567"), "3001234567"); // country code dropped
  assert.equal(normalizePhone("30012345678901"), "2345678901");
});

test("normalizePhone: unusable lengths return null", () => {
  assert.equal(normalizePhone("123456"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

test("phonesNearMatch: transposition is one edit (Damerau-Levenshtein)", () => {
  assert.equal(phonesNearMatch("3001234567", "3001234576"), true);
  assert.equal(phonesNearMatch("3001234567", "3001234568"), true);
  assert.equal(phonesNearMatch("3001234567", "3007654321"), false);
  assert.equal(phonesNearMatch(null, "3001234567"), false);
  assert.equal(phonesNearMatch("", ""), false);
});

test("normalizeName: diacritics stripped, punctuation replaced, signature sorted", () => {
  const n = normalizeName("  María-José López ");
  assert.deepEqual(n.tokens, ["maria", "jose", "lopez"]);
  assert.equal(n.signature, "jose lopez maria");
  assert.equal(normalizeName(""), null);
  assert.equal(normalizeName(null), null);
});

test("scoreEmailMatch: exact 0.75, local-part 0.45, else 0", () => {
  const a = normalizeEmail("juan@hotmail.com");
  const b = normalizeEmail("Juan@Hotmail.COM");
  const c = normalizeEmail("juan@gmail.com");
  const d = normalizeEmail("jd@x.com");
  const e = normalizeEmail("jd@y.com");
  assert.equal(scoreEmailMatch(a, b), 0.75);
  assert.equal(scoreEmailMatch(a, c), 0.45);
  assert.equal(scoreEmailMatch(d, e), 0); // local part too short
  assert.equal(scoreEmailMatch(null, b), 0);
});

test("scorePhoneMatch: exact 0.55, near 0.35, else 0", () => {
  assert.equal(scorePhoneMatch("3001234567", "3001234567"), 0.55);
  assert.equal(scorePhoneMatch("3001234567", "3001234576"), 0.35);
  assert.equal(scorePhoneMatch("3001234567", "3007654321"), 0);
});

test("scoreNameMatch: signature 0.5, subset/initials 0.4, bigram tiers", () => {
  const jp1 = normalizeName("Juan Perez");
  const jp2 = normalizeName("Perez Juan");
  const jpg = normalizeName("Juan Perez Garcia");
  const ji = normalizeName("J. Perez");
  const ca = normalizeName("Camilo");
  const cb = normalizeName("Camila");
  const other = normalizeName("Pedro");
  assert.equal(scoreNameMatch(jp1, jp2), 0.5);
  assert.equal(scoreNameMatch(jp1, jpg), 0.4); // subset: Boom missing second surname
  assert.equal(scoreNameMatch(ji, jp1), 0.4); // initials rule
  assert.equal(scoreNameMatch(ca, cb), 0.3); // dice 0.8 -> 0.3
  assert.equal(scoreNameMatch(jp1, other), 0);
});

test("matchSales: exact email alone clears HIGH", () => {
  const boom = [
    { boom_user_id: "u1", email: "juan@mail.com", phone: "3001112222", first_name: "Juan", last_name: "Perez", points: 5, use_rate: 0.8 },
    { boom_user_id: "u2", email: "maria@mail.com", phone: "3001113333", first_name: "Maria", last_name: "Lopez", points: 3, use_rate: 0.5 },
  ];
  const sales = [{ sale_id: "s1", buyer_email: "JUAN@mail.com", buyer_phone: "", buyer_name: "Ignorado" }];
  const { matches, stats } = matchSales(boom, sales);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], { sale_id: "s1", boom_user_id: "u1", confidence: 0.75 });
  assert.equal(stats.high, 1);
});

test("matchSales: sibling scenario (same phone, near names) is rejected as ambiguous", () => {
  const boom = [
    { boom_user_id: "u1", email: "", phone: "3001112222", first_name: "Juan", last_name: "Perez", points: 0, use_rate: 0.8 },
    { boom_user_id: "u2", email: "", phone: "3001112222", first_name: "Juan", last_name: "Peres", points: 0, use_rate: 0.8 },
  ];
  const sales = [{ sale_id: "s2", buyer_email: "", buyer_phone: "3001112222", buyer_name: "Juan Peres" }];
  const { matches, stats } = matchSales(boom, sales);
  assert.equal(matches.length, 0);
  assert.equal(stats.ambiguous, 1);
});

test("matchSales: initials-only name match (0.4) is rejected, below 0.45", () => {
  const boom = [
    { boom_user_id: "u1", email: "", phone: "", first_name: "Carlos", last_name: "G.", points: 0, use_rate: 0.5 },
  ];
  const sales = [{ sale_id: "s3", buyer_email: "", buyer_phone: "", buyer_name: "Carlos Garcia" }];
  const { matches, stats } = matchSales(boom, sales);
  assert.equal(matches.length, 0);
  assert.equal(stats.rejected, 1);
});

test("computeTicketTypeBaseRates: empirical above 30 samples, fallback below", () => {
  const julyTickets = [];
  for (let i = 0; i < 40; i++) julyTickets.push({ ticket_type: "General", checked_in: i % 2 === 0 });
  for (let i = 0; i < 10; i++) julyTickets.push({ ticket_type: "Cortesía", checked_in: true });
  const rates = computeTicketTypeBaseRates(julyTickets);
  assert.equal(rates.General, 0.5); // 20/40
  assert.equal(rates.Cortesía, 0.42); // fallback: only 10 samples
  assert.equal(rates.Preferencial, 0.94); // fallback from brief
  assert.equal(rates.VIP, 0.94);
});

test("forecastEvent: expected = round of summed ticket probabilities", () => {
  const ticketsByEvent = new Map([["ev1", [
    { sale_id: "s1", ticket_type: "General" },
    { sale_id: "s2", ticket_type: "General" },
    { sale_id: "s3", ticket_type: "General" },
    { sale_id: "s4", ticket_type: "General" },
  ]]]);
  const ctx = {
    julyEvents: [],
    baseRates: { General: 0.5 },
    globalJulyMean: 0.5,
    saleToBoomUser: new Map(),
    boomByUserId: new Map(),
    saleById: new Map(),
    ticketsByEvent,
  };
  const event = { event_id: "ev1", is_residency: false };
  const r = forecastEvent(event, ctx);
  assert.equal(r.expectedAttendance, 2);
  assert.equal(r.ticketsSold, 4);
  assert.ok(r.p10 <= r.expectedAttendance);
  assert.ok(r.expectedAttendance <= r.p90);
  assert.ok(r.p10 >= 0 && r.p90 <= 4);
});

test("forecastEvent: sale with qty>1 counts each ticket, not the sale", () => {
  const ticketsByEvent = new Map([["ev1", [
    { sale_id: "s1", ticket_type: "General" },
    { sale_id: "s1", ticket_type: "General" },
  ]]]);
  const ctx = {
    julyEvents: [],
    baseRates: { General: 1 },
    globalJulyMean: 0.8,
    saleToBoomUser: new Map([["s1", "u1"]]),
    boomByUserId: new Map([["u1", { use_rate: 1 }]]),
    saleById: new Map([["s1", { sale_id: "s1", qty: 2 }]]),
    ticketsByEvent,
  };
  const r = forecastEvent({ event_id: "ev1", is_residency: false }, ctx);
  assert.equal(r.expectedAttendance, 2); // 2 tickets at p=1, not 1 sale
});

test("computeForecast: end-to-end fixture is deterministic and bounded", () => {
  const boomProfiles = [{ boom_user_id: "u1", use_rate: 1, points: 5, email: "", phone: "", first_name: "Ana", last_name: "Rios" }];
  const julyEvents = [{ event_id: "j1", month: "julio", attendance_rate: 0.5 }];
  const events = [
    ...julyEvents,
    { event_id: "a1", month: "agosto", is_residency: false, capacity: 100, title: "Show", venue: "V", weekday: "viernes", starts_at: "2026-08-01T20:00:00+00:00" },
  ];
  const sales = [{ sale_id: "s1", event_id: "a1", subtotal: 50, buyer_email: "", buyer_phone: "", buyer_name: "" }];
  const tickets = [];
  for (let i = 0; i < 40; i++) tickets.push({ ticket_id: `t${i}`, event_id: "j1", sale_id: null, ticket_type: "General", checked_in: true });
  for (let i = 0; i < 10; i++) tickets.push({ ticket_id: `a${i}`, event_id: "a1", sale_id: "s1", ticket_type: "General", checked_in: null });
  const matches = [{ sale_id: "s1", boom_user_id: "u1", confidence: 0.8 }];

  const { forecastRows } = computeForecast({ boomProfiles, events, sales, tickets, matches });
  assert.equal(forecastRows.length, 1);
  const row = forecastRows[0];
  assert.equal(row.event_id, "a1");
  assert.equal(row.expected_attendance, 10); // 10 tickets x (0.6*1 + 0.4*1)
  assert.ok(row.p10 <= row.expected_attendance && row.expected_attendance <= row.p90);
});

test("deriveProductLayer: VIP is top-20% by revenue, sorted, affinity computed", () => {
  const boomProfiles = [
    { boom_user_id: "u1", points: 100, first_name: "Ana", last_name: "Rios", use_rate: 0.9 },
    { boom_user_id: "u2", points: 50, first_name: "Luis", last_name: "Mora", use_rate: 0.7 },
    { boom_user_id: "u3", points: 25, first_name: "Sofi", last_name: "Diaz", use_rate: 0.5 },
  ];
  const events = [
    { event_id: "e1", weekday: "viernes" },
    { event_id: "e2", weekday: "sábado" },
    { event_id: "e3", weekday: "viernes" },
    { event_id: "e4", weekday: "viernes" },
  ];
  const sales = [
    { sale_id: "s1", event_id: "e1", subtotal: 100 },
    { sale_id: "s2", event_id: "e1", subtotal: 50 },
    { sale_id: "s3", event_id: "e2", subtotal: 40 },
    { sale_id: "s4", event_id: "e3", subtotal: 10 },
    { sale_id: "s5", event_id: "e4", subtotal: 10 },
  ];
  const matches = [
    { sale_id: "s1", boom_user_id: "u1" },
    { sale_id: "s2", boom_user_id: "u2" },
    { sale_id: "s3", boom_user_id: "u2" },
    { sale_id: "s4", boom_user_id: "u3" },
    { sale_id: "s5", boom_user_id: "u3" },
  ];

  const d = deriveProductLayer({ boomProfiles, events, sales, tickets: [], matches });
  assert.equal(d.matchedGuestCount, 3);
  assert.equal(d.totalMatchedRevenue, 210);
  assert.equal(d.vipCount, 1); // ceil(3 * 0.2)
  assert.equal(d.vipGuests.length, 1);
  assert.equal(d.vipGuests[0].boom_user_id, "u1");
  assert.equal(d.vipRevenueSharePct, 100 / 210 * 100);
  // guests sorted desc by revenue
  assert.deepEqual(d.guests.map((g) => g.boom_user_id), ["u1", "u2", "u3"]);
  // affinity: u3 has 2 events, both viernes
  const u3 = d.guests.find((g) => g.boom_user_id === "u3");
  assert.equal(u3.weekday_affinity, "viernes");
  // VIP per event
  assert.deepEqual(d.vipByEvent["e1"].map((v) => v.boom_user_id), ["u1"]);
  assert.equal(d.puntosColombiaCategories.length, 7);
  assert.equal(d.freeticketRewards.length, 3);
});

test("csv: writeCsv/readCsv round-trip with quoting and escapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-csv-"));
  try {
    const path = join(dir, "out.csv");
    const headers = ["a", "b", "c"];
    const rows = [
      { a: "plain", b: "has,comma", c: 'say "hi"' },
      { a: "field with space", b: "", c: 42 },
    ];
    writeCsv(path, headers, rows);
    const parsed = readCsv(path);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].a, "plain");
    assert.equal(parsed[0].b, "has,comma");
    assert.equal(parsed[0].c, 'say "hi"');
    assert.equal(parsed[1].a, "field with space");
    assert.equal(parsed[1].b, "");
    assert.equal(parsed[1].c, "42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("csv: readCsv handles empty file and CRLF", () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-csv2-"));
  try {
    const emptyPath = join(dir, "empty.csv");
    writeFileSync(emptyPath, "", "utf-8");
    assert.deepEqual(readCsv(emptyPath), []);
    const crlfPath = join(dir, "crlf.csv");
    writeFileSync(crlfPath, "a,b\r\n1,2\r\n3,4\r\n", "utf-8");
    assert.deepEqual(readCsv(crlfPath), [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildForecastContext: context helpers expose expected shapes", () => {
  const events = [
    { event_id: "j1", month: "julio", attendance_rate: 0.4 },
    { event_id: "j2", month: "julio", attendance_rate: 0.8 },
    { event_id: "a1", month: "agosto", attendance_rate: null },
  ];
  const tickets = [];
  for (let i = 0; i < 40; i++) tickets.push({ ticket_id: `t${i}`, event_id: "j1", ticket_type: "General", checked_in: i % 2 === 0 });
  const ctx = buildForecastContext({ boomProfiles: [], events, sales: [], tickets, matches: [] });
  assert.equal(ctx.julyEvents.length, 2);
  assert.ok(Math.abs(ctx.globalJulyMean - 0.6) < 1e-9, "global mean with float tolerance");
  assert.equal(ctx.baseRates.General, 0.5);
  assert.deepEqual(ctx.ticketsByEvent.get("j1"), tickets);
});
