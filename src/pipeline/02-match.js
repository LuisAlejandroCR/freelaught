import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeEmail, normalizePhone, normalizeName, scoreEmailMatch, scorePhoneMatch, scoreNameMatch } from "../lib/normalize.js";
import { writeCsv } from "../lib/csv.js";
import { isMain } from "../lib/is-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "raw");

const HIGH_THRESHOLD = 0.75;
const REJECT_THRESHOLD = 0.45; // below this: no match written — inventing one is worse than none
const AMBIGUOUS_GAP = 0.1; // top-2 candidates closer than this, with top < 0.9, are treated as ambiguous

function addToIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildBoomIndices(boomProfiles) {
  const byEmailNormalized = new Map();
  const byLocalPart = new Map();
  const byPhone = new Map();
  const byNameSignature = new Map();
  const byNameToken = new Map();
  const enriched = boomProfiles.map((user, idx) => {
    const email = normalizeEmail(user.email);
    const phone = normalizePhone(user.phone);
    const name = normalizeName(`${user.first_name ?? ""} ${user.last_name ?? ""}`);
    addToIndex(byEmailNormalized, email?.normalized, idx);
    addToIndex(byLocalPart, email?.localPart, idx);
    addToIndex(byPhone, phone, idx);
    addToIndex(byNameSignature, name?.signature, idx);
    for (const token of name?.tokens ?? []) {
      if (token.length >= 2) addToIndex(byNameToken, token, idx);
    }
    return { user, email, phone, name };
  });
  return { enriched, byEmailNormalized, byLocalPart, byPhone, byNameSignature, byNameToken };
}

function candidateIndices(indices, email, phone, name) {
  const candidates = new Set();
  const add = (list) => list?.forEach((i) => candidates.add(i));
  if (email) {
    add(indices.byEmailNormalized.get(email.normalized));
    add(indices.byLocalPart.get(email.localPart));
  }
  if (phone) add(indices.byPhone.get(phone));
  if (name) {
    add(indices.byNameSignature.get(name.signature));
    for (const token of name.tokens) {
      if (token.length >= 2) add(indices.byNameToken.get(token));
    }
  }
  return candidates;
}

function scoreCandidate(boomEntry, email, phone, name) {
  const emailPoints = scoreEmailMatch(email, boomEntry.email);
  const phonePoints = scorePhoneMatch(phone, boomEntry.phone);
  const namePoints = scoreNameMatch(name, boomEntry.name);
  const bestSignal = Math.max(emailPoints, phonePoints, namePoints);
  const values = [emailPoints, phonePoints, namePoints];
  const maxIdx = values.indexOf(bestSignal);
  const otherFieldsPresent = values.filter((v, i) => i !== maxIdx && v > 0).length;
  const corroborationBonus = otherFieldsPresent === 2 ? 0.25 : otherFieldsPresent === 1 ? 0.15 : 0;
  const score = Math.min(1, bestSignal + corroborationBonus);
  return { score, emailPoints, phonePoints, namePoints };
}

export function matchSales(boomProfiles, sales) {
  const indices = buildBoomIndices(boomProfiles);
  const matches = [];
  const reviewSample = [];
  const stats = { high: 0, medium: 0, rejected: 0, ambiguous: 0, noCandidates: 0 };

  for (const sale of sales) {
    const email = normalizeEmail(sale.buyer_email);
    const phone = normalizePhone(sale.buyer_phone);
    const name = normalizeName(sale.buyer_name);
    const candidateSet = candidateIndices(indices, email, phone, name);

    if (candidateSet.size === 0) {
      stats.noCandidates++;
      continue;
    }

    const scored = [...candidateSet]
      .map((idx) => ({ idx, ...scoreCandidate(indices.enriched[idx], email, phone, name) }))
      .sort((a, b) => b.score - a.score);

    const top = scored[0];
    const second = scored[1];

    if (top.score < REJECT_THRESHOLD) {
      stats.rejected++;
      continue;
    }
    // Ambiguity only matters once the top candidate would otherwise qualify —
    // below-threshold near-ties are just blocking noise (e.g. two people
    // sharing a common surname), already handled by the reject check above.
    const ambiguous = second && second.score >= REJECT_THRESHOLD && top.score < 0.9 && top.score - second.score < AMBIGUOUS_GAP;
    if (ambiguous) {
      stats.ambiguous++;
      continue;
    }

    const boomUser = indices.enriched[top.idx].user;
    const confidence = Math.round(top.score * 100) / 100;
    matches.push({ sale_id: sale.sale_id, boom_user_id: boomUser.boom_user_id, confidence });
    if (confidence >= HIGH_THRESHOLD) stats.high++;
    else stats.medium++;

    if (reviewSample.length < 40 && Math.random() < 0.02) {
      reviewSample.push({
        sale_id: sale.sale_id,
        confidence,
        sale_name: sale.buyer_name,
        sale_email: sale.buyer_email,
        sale_phone: sale.buyer_phone,
        boom_name: `${boomUser.first_name} ${boomUser.last_name}`,
        boom_email: boomUser.email,
        boom_phone: boomUser.phone,
      });
    }
  }

  return { matches, reviewSample, stats, totalSales: sales.length };
}

function checkMaxTwoTicketsInvariant(matches, tickets) {
  const saleToBoomUser = new Map(matches.map((m) => [m.sale_id, m.boom_user_id]));
  const counts = new Map(); // "event_id|boom_user_id" -> count
  for (const ticket of tickets) {
    const boomUserId = saleToBoomUser.get(ticket.sale_id);
    if (!boomUserId) continue;
    const key = `${ticket.event_id}|${boomUserId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const violations = [...counts.entries()].filter(([, count]) => count > 2);
  return { violationCount: violations.length, examples: violations.slice(0, 5) };
}

export function runMatch() {
  const boomProfiles = JSON.parse(readFileSync(join(RAW_DIR, "boom_profile.json"), "utf-8"));
  const sales = JSON.parse(readFileSync(join(RAW_DIR, "ft_sales.json"), "utf-8"));
  const tickets = JSON.parse(readFileSync(join(RAW_DIR, "ft_tickets.json"), "utf-8"));

  const { matches, reviewSample, stats, totalSales } = matchSales(boomProfiles, sales);

  writeCsv(join(ROOT, "matches.csv"), ["sale_id", "boom_user_id", "confidence"], matches);

  mkdirSync(RAW_DIR, { recursive: true });
  writeCsv(
    join(RAW_DIR, "match-review-sample.csv"),
    ["sale_id", "confidence", "sale_name", "sale_email", "sale_phone", "boom_name", "boom_email", "boom_phone"],
    reviewSample
  );

  const invariant = checkMaxTwoTicketsInvariant(matches, tickets);

  console.log("=== Matching summary ===");
  console.log(`Total sales: ${totalSales}`);
  console.log(`Matched: ${matches.length} (${((matches.length / totalSales) * 100).toFixed(1)}%)`);
  console.log(`  HIGH (>=${HIGH_THRESHOLD}): ${stats.high}`);
  console.log(`  MEDIUM: ${stats.medium}`);
  console.log(`Rejected (score < ${REJECT_THRESHOLD}): ${stats.rejected}`);
  console.log(`Ambiguous (close top-2 candidates): ${stats.ambiguous}`);
  console.log(`No candidates found (likely new customer, not in Boom): ${stats.noCandidates}`);
  console.log(`Review sample: raw/match-review-sample.csv (${reviewSample.length} rows)`);
  console.log(
    `Max-2-tickets-per-event invariant: ${invariant.violationCount} violations` +
      (invariant.violationCount ? ` — e.g. ${JSON.stringify(invariant.examples[0])}` : " (clean)")
  );

  return { matches, stats, invariant };
}

if (isMain(import.meta.url)) {
  runMatch();
}
