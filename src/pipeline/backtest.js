import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCsv } from "../lib/csv.js";
import { buildForecastContext, forecastEvent } from "./03-forecast.js";
import { isMain } from "../lib/is-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");

// Re-applies the *exact same* forecastEvent() used for forecast.csv to July
// (which has real outcomes) — free validation using data the brief calls the
// "labeled training set." Not an approximation of the real formula: the
// literal same function, imported.
export function backtest() {
  const boomProfiles = JSON.parse(readFileSync(join(RAW_DIR, "boom_profile.json"), "utf-8"));
  const events = JSON.parse(readFileSync(join(RAW_DIR, "ft_events.json"), "utf-8"));
  const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
  const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));
  const matches = readCsv(join(ROOT, "matches.csv")).map((m) => ({ ...m, confidence: Number(m.confidence) }));

  const ctx = buildForecastContext({ boomProfiles, events, sales, tickets, matches });

  let withinBand = 0;
  let totalAbsError = 0;
  const rows = [];

  for (const event of ctx.julyEvents) {
    const r = forecastEvent(event, ctx);
    const actual = event.checked_in_count;
    const inBand = actual >= r.p10 && actual <= r.p90;
    if (inBand) withinBand++;
    totalAbsError += Math.abs(r.expectedAttendance - actual);
    rows.push({ event_id: event.event_id, expected: r.expectedAttendance, actual, p10: r.p10, p90: r.p90, inBand });
  }

  const total = ctx.julyEvents.length;
  console.log("=== Backtest vs July ground truth ===");
  console.log(`Events: ${total}`);
  console.log(`Actual attendance within [p10,p90]: ${withinBand}/${total} (${((withinBand / total) * 100).toFixed(0)}%)`);
  console.log(`Mean absolute error: ${(totalAbsError / total).toFixed(1)} attendees/event`);
  console.log("Worst 5 by error:");
  rows
    .sort((a, b) => Math.abs(b.expected - b.actual) - Math.abs(a.expected - a.actual))
    .slice(0, 5)
    .forEach((r) => console.log(`  ${r.event_id}: expected=${r.expected} actual=${r.actual} band=[${r.p10},${r.p90}] inBand=${r.inBand}`));

  return { withinBand, total, meanAbsError: totalAbsError / total };
}

if (isMain(import.meta.url)) {
  backtest();
}
