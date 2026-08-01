import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", ".ft-hack.json");
const PLATFORMS = new Set(["boom", "freeticket"]);

let cachedConfig;
function loadConfig() {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }
  return cachedConfig;
}

// Enforced structurally: a single call can only ever address one platform.
// The hackathon rule is "one query touches one platform" — there is no
// server-side join, so this client never accepts both at once.
export async function getPage(platform, resource, params = {}) {
  if (!PLATFORMS.has(platform)) {
    throw new Error(`Invalid platform "${platform}" — must be "boom" or "freeticket"`);
  }
  const { api, token } = loadConfig();
  const url = new URL(`/api/${platform}`, api);
  url.searchParams.set("resource", resource);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${platform}/${resource} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res.json();
}

export async function pullAll(platform, resource, params = {}) {
  const limit = params.limit ?? 1000;
  let offset = 0;
  let count = Infinity;
  const rows = [];
  while (offset < count) {
    const page = await getPage(platform, resource, { ...params, limit, offset });
    rows.push(...page.rows);
    count = page.count;
    offset += limit;
    if (page.rows.length === 0) break;
  }
  return rows;
}
