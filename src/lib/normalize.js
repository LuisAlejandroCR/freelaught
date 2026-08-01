// Kept deliberately small and fixed — an aggressive domain-typo matcher risks
// merging two different real people who each mistyped a different domain.
const EMAIL_DOMAIN_WHITELIST = ["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com"];

function damerauLevenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeEmail(raw) {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return null;

  let localPart = email.slice(0, atIdx);
  let domain = email.slice(atIdx + 1);

  const plusIdx = localPart.indexOf("+");
  if (plusIdx !== -1) localPart = localPart.slice(0, plusIdx);

  let domainCorrected = false;
  if (!EMAIL_DOMAIN_WHITELIST.includes(domain)) {
    const candidates = EMAIL_DOMAIN_WHITELIST.filter((w) => damerauLevenshtein(domain, w) <= 2);
    if (candidates.length === 1) {
      domain = candidates[0];
      domainCorrected = true;
    }
  }

  return { raw, normalized: `${localPart}@${domain}`, localPart, domain, domainCorrected };
}

export function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function phonesNearMatch(a, b) {
  if (!a || !b) return false;
  return a === b || damerauLevenshtein(a, b) <= 1;
}

export function normalizeName(raw) {
  if (!raw) return null;
  const cleaned = stripDiacritics(raw.trim().toLowerCase()).replace(/[^a-z0-9\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const signature = [...tokens].sort().join(" ");
  return { raw, tokens, signature };
}

function bigramDice(a, b) {
  if (!a || !b) return 0;
  const bigrams = (s) => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of ba) {
    if (bb.has(bg)) intersection += Math.min(count, bb.get(bg));
  }
  const totalA = [...ba.values()].reduce((s, c) => s + c, 0);
  const totalB = [...bb.values()].reduce((s, c) => s + c, 0);
  return totalA + totalB === 0 ? 0 : (2 * intersection) / (totalA + totalB);
}

function tokensMatch(t1, t2) {
  if (t1 === t2) return true;
  if (t1.length === 1) return t2[0] === t1;
  if (t2.length === 1) return t1[0] === t2;
  return false;
}

// Handles the "second surname Boom never recorded" case (subset) and the
// "just an initial" case (a token matches the first letter of a token in the
// other name) — checked in both directions since either side may be the one
// with fewer/initialed tokens.
function namesOverlap(a, b) {
  const covers = (small, big) =>
    small.tokens.length > 0 && small.tokens.every((t) => big.tokens.some((bt) => tokensMatch(t, bt)));
  return covers(a, b) || covers(b, a);
}

// Field-level confidence points. See docs/memoria.md for the rationale behind
// these weights (exact email alone clears HIGH; a lone phone/name needs
// corroboration since phones get shared within a household and names collide).
export function scoreEmailMatch(a, b) {
  if (!a || !b) return 0;
  if (a.normalized === b.normalized) return 0.75;
  if (a.localPart === b.localPart && a.localPart.length >= 3) return 0.45;
  return 0;
}

export function scorePhoneMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 0.55;
  if (phonesNearMatch(a, b)) return 0.35;
  return 0;
}

export function scoreNameMatch(a, b) {
  if (!a || !b) return 0;
  if (a.signature === b.signature) return 0.5;
  if (namesOverlap(a, b)) return 0.4;
  const dice = bigramDice(a.signature, b.signature);
  if (dice >= 0.7) return 0.3;
  if (dice >= 0.5) return 0.15;
  return 0;
}
