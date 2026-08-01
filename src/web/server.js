import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { getEventsSummaries, getEventDetail, getVipData, getStats } from "./handlers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = process.env.PORT || 3000;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

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
      return sendJson(res, 200, getEventsSummaries());
    }
    if (path.startsWith("/api/events/")) {
      const id = path.split("/")[3];
      const detail = getEventDetail(id);
      if (!detail) return sendJson(res, 404, { error: "event not found" });
      return sendJson(res, 200, detail);
    }
    if (path === "/api/stats") {
      return sendJson(res, 200, getStats());
    }
    if (path === "/api/vip") {
      return sendJson(res, 200, getVipData());
    }

    if (path === "/" || path === "/index.html") return sendFile(res, join(PUBLIC_DIR, "index.html"));
    if (path === "/pitch") return sendFile(res, join(PUBLIC_DIR, "pitch.html"));
    if (path.startsWith("/events/")) return sendFile(res, join(PUBLIC_DIR, "event.html"));
    if (path === "/vip") return sendFile(res, join(PUBLIC_DIR, "vip.html"));
    return sendFile(res, join(PUBLIC_DIR, path.slice(1)));
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Freelaught product layer running at http://localhost:${PORT}`);
  console.log(`  /       — 30 shows de agosto, asistencia esperada + rango + staffing`);
  console.log(`  /events/:id — detalle por show, invitados VIP, link efímero`);
  console.log(`  /vip    — Pareto de invitados identificados + puntos`);
});
