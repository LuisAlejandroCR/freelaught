import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pullAll } from "../lib/api-client.js";
import { isMain } from "../lib/is-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, "..", "..", "raw");

const SOURCES = [
  { platform: "boom", resource: "profile", file: "boom_profile.json" },
  { platform: "freeticket", resource: "events", file: "ft_events.json" },
  { platform: "freeticket", resource: "sales", file: "ft_sales.json" },
  { platform: "freeticket", resource: "tickets", file: "ft_tickets.json" },
];

export async function fetchAll({ useCache = true } = {}) {
  mkdirSync(RAW_DIR, { recursive: true });

  const results = await Promise.all(
    SOURCES.map(async ({ platform, resource, file }) => {
      const path = join(RAW_DIR, file);
      if (useCache && existsSync(path)) {
        console.log(`[fetch] ${platform}/${resource} — cached (${path})`);
        return [file.replace(".json", ""), JSON.parse(readFileSync(path, "utf-8"))];
      }
      console.log(`[fetch] ${platform}/${resource} — pulling…`);
      const rows = await pullAll(platform, resource);
      writeFileSync(path, JSON.stringify(rows, null, 2), "utf-8");
      console.log(`[fetch] ${platform}/${resource} — ${rows.length} rows -> ${path}`);
      return [file.replace(".json", ""), rows];
    })
  );

  return Object.fromEntries(results);
}

if (isMain(import.meta.url)) {
  fetchAll({ useCache: !process.argv.includes("--fresh") }).then((data) => {
    for (const [key, rows] of Object.entries(data)) {
      console.log(`${key}: ${rows.length} rows`);
    }
  });
}
