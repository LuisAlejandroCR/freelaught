const $ = (sel) => document.querySelector(sel);

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${path}`);
  return res.json();
}

const fmtInt = (n) => (n ?? 0).toLocaleString("es-CO");
const fmtCOP = (n) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n ?? 0);

const fmtDay = (iso) => {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
};

function bar(pct, color) {
  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = "bar-fill" + (color ? ` ${color}` : "");
  fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
  track.appendChild(fill);
  return track;
}

function badge(label, tone) {
  const b = document.createElement("span");
  b.className = `badge ${tone}`;
  b.textContent = label;
  return b;
}

function makeSortable(table) {
  const state = { key: null, dir: 1 };
  table.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      const type = th.dataset.type || "string";
      state.dir = state.key === key ? -state.dir : 1;
      state.key = key;
      const tbody = table.tBodies[0];
      const rows = [...tbody.rows];
      rows.sort((a, b) => {
        const av = a.dataset[key];
        const bv = b.dataset[key];
        const cmp = type === "num" ? Number(av) - Number(bv) : String(av).localeCompare(String(bv), "es");
        return cmp * state.dir;
      });
      rows.forEach((r) => tbody.appendChild(r));
      table.querySelectorAll("thead th").forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(state.dir === 1 ? "sort-asc" : "sort-desc");
    });
  });
}

function renderError(container, err) {
  container.innerHTML = `<div class="error">No se pudo cargar la información: ${String(err.message || err)}. ¿Corrió <code>npm run web</code>?</div>`;
}

const SHARE_TTL_MS = 3 * 3600 * 1000;

function shareState() {
  const m = location.hash.match(/g=(\d+)/);
  const gen = m ? Number(m[1]) : Date.now();
  const left = SHARE_TTL_MS - (Date.now() - gen);
  return { expired: left <= 0, left: Math.max(0, left) };
}

function fmtLeft(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function waShareUrl(text, pageUrl) {
  const msg = pageUrl ? `${text}\n${pageUrl}` : text;
  return `https://wa.me/?text=${encodeURIComponent(msg)}`;
}
