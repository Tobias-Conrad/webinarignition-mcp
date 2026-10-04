import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { lookup } from "node:dns/promises";

// ── Browser-Kopfzeilen fuer die Adress-Probe (Tobias 2026-09-11) ──────────
// Manche Hoster (z. B. byethost) beantworten Nicht-Browser-Anfragen mit einer JS-Schranke —
// auch dann, wenn dort WordPress laeuft. Der eigene Name "WebinarIgnition-Connector/1.0" war
// das erste Ausschlusskriterium. assessWp() fragt deshalb wie ein gewoehnlicher Browser.
// Geaendert wird nur die Verkleidung der Anfrage: guardedFetch (SSRF-Schutz, Redirect-Grenze)
// und alle geprueften Merkmale bleiben unveraendert; Cookies/Login werden nie mitgeschickt.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
};
// JSON-Abrufe (der REST-Index und der MCP-Endpunkt) fragen eine Schnittstelle, keine Seite:
// `Accept: text/html` ist dort die falsche Anrede und kann an einer Bot-Schranke scheitern
// (Prueferbefund 2026-09-11, N3). Der HTML-Seitenabruf bleibt bei BROWSER_HEADERS.
const BROWSER_JSON_HEADERS = { ...BROWSER_HEADERS, Accept: "application/json" };

/**
 * Traegt die genannte Adresse selbst einen WordPress-Pfad? (Tobias 2026-09-11)
 *
 * DER BELEGTE FALL: `https://…/wp/` — dort IST WordPress, aber der Host beantwortet
 * Nicht-Browser-Anfragen mit einer JS-Schranke (`/aes.js`, keine WP-Marker). assessWp() kann
 * die Seite dann nicht lesen. Ohne diesen Hinweis galt sie als "kein WordPress" und der Host
 * bekam "hol dir WordPress", obwohl er richtig getippt hatte.
 *
 * Geprueft werden AUSSCHLIESSLICH Pfad-Segmente: `/wp`, `/wp-admin`, `/wp-login.php`,
 * `/wp-json`, `/wp-content`, `/wp-includes`. Der Hostname zaehlt bewusst nicht — `wi.domain.de`
 * oder `wp.example.com` sind kein WP-Pfad-Beweis.
 */
function urlLooksLikeWp(raw) {
  let v = String(raw || "").trim();
  if (!v) return false;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  let path = "";
  try {
    path = new URL(v).pathname || "";
  } catch {
    return false;
  }
  const markers = new Set(["wp", "wp-admin", "wp-login.php", "wp-json", "wp-content", "wp-includes"]);
  return path
    .split("/")
    .filter(Boolean)
    .some((seg) => markers.has(seg.toLowerCase()));
}

// Technische Endstuecke: ab dem ersten Vorkommen faellt der Pfad weg — samt dem, was danach
// kommt. Genau dieselbe Liste fuehrt das Plugin (wi_prompter_typed_base_from_url im PHP und
// wipSanitizeInputForProbe im JS, Prueferbefund 2026-09-11). Sie wird an DREI Stellen
// gebraucht (Adress-Probe, Handoff-Ziel, wpconnect normaliseSite) und steht deshalb genau
// einmal hier — sonst schneidet die eine Seite anders als die andere.
const WP_PATH_CUT = [
  "wp-admin", "wp-login.php", "wp-json", "wp-content", "wp-includes", "index.php",
  "xmlrpc.php", "wp-cron.php", "wp-activate.php", "wp-signup.php", "wp-trackback.php", "feed",
];

/**
 * Eine Adresse auf die WordPress-Basis zurueckschneiden (Prueferbefund 2026-09-11, M3).
 *
 * Vorher schnitt nur `replace(/\/wp-admin\/?.*$/i, …)` — `wp-login.php`, `wp-json`,
 * `wp-content`, `wp-includes`, `index.php` blieben stehen und wanderten dann als
 * `checked_url` in den Verbinden-Schritt, wo sie als Seitenwurzel falsch sind. Jetzt gilt
 * dieselbe Regel wie im Plugin: Schema + Host + hoechstens DREI Unterordner, nur harmlose
 * Zeichen, alles ab dem ersten technischen Endstueck weg. Ist eine behaltene Ebene unerlaubt
 * beschrieben, faellt der GANZE Pfad (die Wurzel bleibt) — exakt wie PHP und JS es tun, damit
 * alle drei Seiten denselben Kandidaten sehen.
 *
 * Prozent-Codierung und echte UTF-8-Unterordner (Prueferbefund 2026-09-12, N1): die enge
 * Zeichenregel liess nur `[A-Za-z0-9._~-]` zu, also fiel `https://example.com/caf%C3%A9`
 * oder ein Umlaut-Ordner still auf die Wurzel zurueck — der Pfad war weg. Jetzt wird jedes
 * Segment zuerst dekodiert (`%C3%A9` -> `é`), dann greift die strukturelle Regel: `.`/`..`
 * werden weiter verworfen, Verwaltungs-Endstuecke schneiden ab, hoechstens drei Ebenen, und
 * der Inhalt muss harmlos sein (ASCII-Satz ODER gueltige UTF-8-Zeichen; kein Steuerzeichen,
 * kein `/ \ ? # % :`). Beim Bauen wird jedes Segment wieder prozent-codiert, damit im Link
 * nie ein Query/Fragment, kein `..` und nichts Halbes steht.
 *
 * Erwartet eine Adresse MIT Schema und arbeitet rein auf Zeichen — kein Netz, keine DNS-Frage.
 * Bei ungültiger Eingabe kommt sie unveraendert zurueck.
 *
 * @param {string} raw Adresse (mit http(s)://).
 * @returns {string} Basis wie `https://example.com` oder `https://example.com/unterordner`.
 */
export function normaliseWpBase(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  let url;
  try {
    url = new URL(v);
  } catch {
    return v;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return v;
  const segs = (url.pathname || "").split("/").filter(Boolean);
  const keep = [];
  for (const rawSeg of segs) {
    // Prozent-Codierung aufloesen, damit `%C3%A9`, `%2E%2E` und `wp-login%2Ephp` genauso
    // behandelt werden wie ihre Klartext-Form. Kaputtes Escaping ist kein Unterordner:
    // dann faellt der ganze Pfad auf die Wurzel zurueck (wie bei einem unerlaubten Zeichen).
    let seg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return url.origin;
    }
    // B1: `.` und `..` sind keine Unterordner. WHATWG loest sie im Pfad bereits auf; die
    // prozent-codierte Form erreicht uns aber unaufgeloest, deshalb bleibt diese Regel.
    if (seg === ".") continue;
    if (seg === "..") {
      keep.pop();
      continue;
    }
    if (WP_PATH_CUT.includes(seg.toLowerCase())) break;
    if (!isSafePathSegment(seg)) return url.origin;
    keep.push(seg);
    // Mehr als drei Ebenen sind kein WordPress-Unterordner mehr, sondern eine Seite.
    if (keep.length >= 3) break;
  }
  if (!keep.length) return url.origin;
  let encoded;
  try {
    encoded = keep.map((seg) => encodeURIComponent(seg)).join("/");
  } catch {
    // Einzelne Surrogatzeichen sind kein gueltiges UTF-8 — dann bleibt nur die Wurzel.
    return url.origin;
  }
  return `${url.origin}/${encoded}`;
}

/**
 * Traegt ein Pfadsegment nur Harmloses fuer einen Link, den ein Mensch anklickt?
 *
 * Dieselbe enge Idee wie im Plugin (`wi_prompter_typed_base_from_url`), erweitert um
 * gueltige UTF-8-Zeichen. Der Aufrufer hat das Segment bereits prozent-dekodiert, deshalb
 * schuetzt die Pruefung gegen Zeichen, die aus dem Pfad ausbrechen koennten (`/ \ ? # % :`)
 * und gegen Steuerzeichen. Alles andere — ASCII-Satz oder echte Umlaute/Akzente/CJK — darf
 * bleiben und wird beim Bauen wieder prozent-codiert.
 *
 * @param {string} seg Dekodiertes Pfadsegment (nicht leer).
 * @returns {boolean}
 */
function isSafePathSegment(seg) {
  if (!seg) return false;
  if (/[\u0000-\u001F\u007F/\\?#%:]/.test(seg)) return false;
  return /^[A-Za-z0-9._~\-\u0080-\u{10FFFF}]+$/u.test(seg);
}

// ── SSRF-Haertung (R3, 2026-08-26) ────────────────────────────────────────
// assessWp() holt eine fremde Adresse server-seitig ab. Damit kein Blind-SSRF moeglich ist
// (Metadaten unter 169.254.169.254, localhost, interne Netze), wird jede Adresse vor dem
// Abruf gegen private/Link-Local/Metadata-Bereiche geprueft — dieselbe Grenze wie
// wi_prompter_target_host_is_blocked() im Prompter (10/8, 172.16/12, 192.168/16, 127/8,
// 169.254/16, 100.64/10) plus IPv6-Loopback/Link-Local/Unique-Local.
function ipIsBlocked(ip) {
  // IPv4-mapped-IPv6 (::ffff:a.b.c.d ODER ::ffff:7f00:1 hex-normalisiert). Node
  // normalisiert "[::ffff:127.0.0.1]" zu "[::ffff:7f00:1]" — beide Formen muessen
  // auf die eingebettete IPv4 zurueckgefuehrt werden, sonst ist der Metadata-Endpoint
  // (169.254.169.254) ueber diesen Weg erreichbar (gemessen: ::ffff:7f00:1 -> 200).
  const mapped = /^::ffff:([0-9a-f.:]+)$/i.exec(ip);
  if (mapped) {
    const inner = mapped[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(inner)) {
      return ipIsBlockedV4(inner);
    }
    // Hex-Form: 7f00:1 -> 127.0.0.1, a9fe:a9fe -> 169.254.169.254
    const hex = inner.replace(/:/g, "");
    if (hex.length === 8) {
      const o = [];
      for (let i = 0; i < 8; i += 2) o.push(parseInt(hex.slice(i, i + 2), 16));
      return ipIsBlockedV4(o.join("."));
    }
    return true; // ungewöhnliche ::ffff:-Form — als verdächtig blocken
  }
  return ipIsBlockedV4(ip);
}

function ipIsBlockedV4(target) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
    const o = target.split(".").map(Number);
    const a = o[0], b = o[1];
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 10) return true;                       // 10/8
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local + 169.254.169.254 (Metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;         // 192.168/16
    return false;
  }
  const lower = String(target).toLowerCase();
  if (lower === "::1" || lower === "::") return true;   // IPv6-Loopback / unspecified
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  return false;
}

/**
 * Prueft einen Hostnamen gegen private/Link-Local/Metadata-Adressen.
 *
 * @param {string} host Hostname (oder Literal-IP) aus der URL.
 * @returns {Promise<"ok"|"private"|"dns">} "ok" = oeffentlich erreichbar, "private" = darf
 *   nicht abgerufen werden, "dns" = laesst sich nicht aufloesen (nichts pruefbar).
 */
export async function resolveHostStatus(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!h) return "dns";
  if (h === "localhost" || h.endsWith(".localhost")) return "private";
  // Rohe IP (IPv4 oder IPv6) in der URL: direkt pruefen, kein DNS noetig.
  if (h.includes(":")) return ipIsBlocked(h) ? "private" : "ok";
  try {
    const addrs = await lookup(h, { all: true });
    if (!addrs || !addrs.length) return "dns";
    return addrs.some((a) => ipIsBlocked(String(a.address))) ? "private" : "ok";
  } catch {
    return "dns";
  }
}

/** Discovery, registration, token exchange — short questions, short answers. */
const FETCH_TIMEOUT_MS = 15e3;

/** How many hops a redirect chain may take before we stop following it. */
const MAX_REDIRECTS = 3;

/**
 * A fetch that cannot hang and cannot be pointed at the inside of our own network.
 *
 * **Redirects are followed by hand, one hop at a time, and every hop is checked again.**
 * That is the whole point of this function and it was wrong in the first version: with
 * `redirect: "follow"` the built-in fetch checks nothing after the first address, so a
 * site could answer "302 → http://127.0.0.1/…" and use this process as a doorbell for
 * addresses it cannot reach itself. Measured, not theorised: a review reproduced exactly
 * that and reached a local port through this function. On a host with a metadata service
 * (169.254.169.254) the same trick reads credentials.
 *
 * The Authorization header is dropped the moment a hop leaves the original origin. A
 * bearer token for the host's WordPress has no business travelling to a third address,
 * however that address ended up in the chain.
 *
 * @param {string} url    Absolute http(s) URL.
 * @param {object} [init] fetch options.
 * @param {number} [hop]  Internal: how deep we already are.
 * @returns {Promise<Response>}
 */
export async function guardedFetch(url, init = {}, hop = 0) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Only http and https are allowed, not ${u.protocol}`);
  }
  const status = await resolveHostStatus(u.hostname);
  if (status === "private") {
    throw new Error(`${u.hostname} is not reachable from the open internet.`);
  }
  if (status === "dns") {
    throw new Error(`${u.hostname} could not be looked up.`);
  }

  const { timeoutMs, ...fetchInit } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...fetchInit, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }

  if (![301, 302, 303, 307, 308].includes(res.status)) return res;

  const location = res.headers.get("location");
  if (!location) return res;
  if (hop >= MAX_REDIRECTS) throw new Error("That address redirects too many times.");

  const next = new URL(location, url);
  const nextInit = { ...init };

  // Leaving the origin: the Authorization header does not come along.
  if (next.origin !== u.origin && nextInit.headers) {
    const headers = { ...nextInit.headers };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    nextInit.headers = headers;
  }

  // 303 always becomes GET; 301/302 after a POST do too, as every client has done since
  // long before it was written down.
  const method = String(nextInit.method || "GET").toUpperCase();
  if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
    nextInit.method = "GET";
    delete nextInit.body;
  }

  return guardedFetch(next.toString(), nextInit, hop + 1);
}

const CONFIG_DIR = join(homedir(), ".wi-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const API_BASE_DEFAULT = "https://webinarignition.com/wp-json/wi-prompter/v1/mcp";

function loadConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    // The public mirror is self-contained: no first-run consent step, the hosted
    // API endpoint is the default. This is what makes `npm start` work out of the
    // box (and what directory install validators, e.g. LobeHub, check).
    const mirrorConsent = process.env.WI_MCP_CONSENT_GRANTED !== "false";
    const cfg = {
      client_id: crypto.randomUUID(),
      consent_granted: mirrorConsent,
      consent_version: mirrorConsent ? "public-mirror" : "",
      consent_granted_at: mirrorConsent ? Math.floor(Date.now() / 1000) : 0,
      api_base: process.env.WI_MCP_API_BASE || API_BASE_DEFAULT,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.api_base) cfg.api_base = process.env.WI_MCP_API_BASE || API_BASE_DEFAULT;
  return cfg;
}

// ── Funnel sessions ───────────────────────────────────────────────────────
// A session is one webinar conversation: history, collected facts, language.
// It MUST survive a deploy or a restart — a host halfway through describing their
// webinar should never be told "session expired". So it lives in memory for speed
// and on disk for survival. WI_MCP_STATE_DIR points at a Fly volume in production.
const SESSION_TTL_MS = 24 * 3600e3;
const STATE_DIR = process.env.WI_MCP_STATE_DIR || CONFIG_DIR;
const SESSION_PATH = join(STATE_DIR, "sessions.json");

const sessions = new Map();

function loadSessions() {
  try {
    if (!existsSync(SESSION_PATH)) return;
    const raw = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
    const now = Date.now();
    let restored = 0;
    for (const [id, s] of Object.entries(raw)) {
      if (s && now - (s.lastActivity || 0) < SESSION_TTL_MS) { sessions.set(id, s); restored++; }
    }
    if (restored) console.error(`[engine] ${restored} session(s) restored from disk`);
  } catch (e) {
    console.error(`[engine] could not read sessions: ${e.message}`);
  }
}

let saveTimer = null;
function saveSessions() {
  // Debounced: a burst of turns writes once, not five times.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(SESSION_PATH, JSON.stringify(Object.fromEntries(sessions)));
    } catch (e) {
      console.error(`[engine] could not persist sessions: ${e.message}`);
    }
  }, 1000);
}

loadSessions();

setInterval(() => {
  const now = Date.now();
  let dropped = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) { sessions.delete(id); dropped++; }
  }
  if (dropped) saveSessions();
  // Relay-Jobs aufraeumen: abgeschlossen/fehlgeschlagen, aelter als eine Stunde. Aktive
  // (writing) Jobs bleiben, bis sie fertig sind — sonst wuerde der Client mit "gone" enden.
  for (const [id, j] of relayJobs) {
    if (j.status !== "writing" && now - (j.at || 0) > 3600e3) relayJobs.delete(id);
  }
}, 60000);

async function wiApi(config, method, path, body) {
  const url = `${config.api_base}${path}`;
  const payload = {
    ...(body || {}),
    client_id: config.client_id,
    consent_granted: config.consent_granted,
    consent_version: config.consent_version || "",
    consent_granted_at: config.consent_granted_at || 0,
  };
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data.message || data.code || `API error ${res.status}`);
  return data;
}

function checkConsent(config) {
  if (!config.consent_granted) throw new Error("Consent not granted. Run node src/setup.js --consent");
}

// ── Lange Texterzeugung direkt am Relay (Fly→Fly) ───────────────────────
//
// Lange Typen (list/invites/plan/starter/refine) laufen beim Relay 86–121 s — ueber die
// ~120-s-Wand von webinarignition.com kommt kein synchroner Ruf. Deshalb holt sich der
// MCP-Server die fertigen messages + Relay-Parameter aus EINER Quelle (Prompter,
// /mcp/prompt-render — der baut den Prompt, wir bauen ihn nicht nach), startet dann den
// Relay-Aufruf ALS LOKALEN HINTERGRUND-JOB und gibt dem Client sofort status=writing mit
// job_id zurueck. Der Client fragt mit generateStatus nach. Kein WordPress-Hintergrund-
// Worker, keine FPM-Wand.
//
// Der Relay-Key kommt NICHT aus dem Code: er ist ein Fly-Secret (WI_NODE_API_KEY) auf der
// wi-mcp-server-App und wird nur als Header `x-wi-api-key` mitgegeben. site_key/plan_slug
// liefert der Prompter (er kennt Lizenz + Site), nicht wir.
const RELAY_BASE_URL = process.env.WI_NODE_RELAY_BASE_URL || "https://wi-node-ai-relay.fly.dev";
const SHORT_INVITE_TYPES = new Set(["personal", "facebook", "whatsapp", "instagram", "linkedin", "telegram", "youtube"]);

// Der Prompter unterscheidet kurz/lang ueber die Erzeugungssorte. Aus Sicht des MCP-Funnels
// ist die Einladung genau dann kurz, wenn eine der Einzelpost-Plattformen gewaehlt ist
// (die 8-Kanal-Achse, 2026-08-25); alles andere (list/invites/plan/starter/refine) ist lang
// und geht den neuen Weg.
function isLongFunnelType(type, invite) {
  return !SHORT_INVITE_TYPES.has(String(invite || ""));
}

// In-Memory-Jobs der langen Relay-Generierung. Ueberleben keinen Restart — konsistent mit
// dem WordPress-Auftragspfad, der bei einem Server-Neustart ebenfalls verloren ginge. Der
// Client bekommt dann bei generateStatus ein ehrliches failed und startet neu.
const relayJobs = new Map();

function parseSseContent(raw) {
  let content = "";
  let error = "";
  for (const block of String(raw).split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const data = JSON.parse(json);
        if (data && data.error) error = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
        if (data && data.choices && data.choices[0] && data.choices[0].delta && typeof data.choices[0].delta.content === "string") {
          content += data.choices[0].delta.content;
        }
      } catch { /* kein JSON-Chunk — ignorieren */ }
    }
  }
  return { content, error };
}

async function relayChatStream(relay, messages) {
  const apiKey = process.env.WI_NODE_API_KEY || "";
  const url = `${RELAY_BASE_URL}/wi-ai/chat/stream`;
  const controller = new AbortController();
  const timeoutMs = (relay && relay.timeout ? parseInt(relay.timeout, 10) : 200) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wi-api-key": apiKey,
      },
      body: JSON.stringify({
        task: relay.task || "webinar_content",
        plan_slug: relay.plan_slug || "free",
        site_key: relay.site_key || "",
        site_url: relay.site_url || "",
        max_tokens: relay.max_tokens || 2000,
        thinking: relay.thinking || "disabled",
        units_estimate: relay.units_estimate || 40,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`relay HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.text();
    return parseSseContent(raw);
  } finally {
    clearTimeout(timer);
  }
}

// ── Quellen selbst ernten (Hybrid, 2026-08-26, Umbau Bc) ────────────────
//
// Der Funnel soll eine vom Host genannte Quelle (facts.reference_url) SELBST ernten,
// statt zu warten, dass das Client-Modell sie liest. Dafuer nutzen wir den vorhandenen
// Harvest-Weg des Relays: task "host_harvest_select" -> Perplexity sonar-pro (siehe
// wi-node-ai-relay/src/model-matrix.js WEB_TASKS + resolveRoute).
//
// WICHTIG (geprueft 2026-08-26): Perplexity kann NICHT streamen. Der Relay lehnt den
// Stream-Endpunkt /wi-ai/chat/stream fuer Nicht-DeepSeek-Provider ab ("stream not
// supported"). Deshalb hier ein eigener, NICHT-streamender Aufruf auf /wi-ai/chat —
// der Stream-Weg (relayChatStream) ist nur fuer lange DeepSeek-Texte gedacht.
//
// Schlaegt die Ernte fehl oder liefert nichts, bleibt die vorhandene Regel im Prompt
// aktiv, die das Client-Modell bittet, die Quelle selbst zu lesen (REFERENZ MATERIAL /
// ZIELGRUPPE in agent-chat-extension.txt) — das ist der zweite Teil des Hybrids.
const SOURCE_HARVEST_TASK = "host_harvest_select";

async function relayChatSync(relay, messages) {
  const apiKey = process.env.WI_NODE_API_KEY || "";
  const url = `${RELAY_BASE_URL}/wi-ai/chat`;
  const controller = new AbortController();
  const timeoutMs = (relay && relay.timeout ? parseInt(relay.timeout, 10) : 120) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wi-api-key": apiKey },
      body: JSON.stringify({
        task: relay.task || "webinar_content",
        plan_slug: relay.plan_slug || "free",
        site_key: relay.site_key || "",
        site_url: relay.site_url || "",
        max_tokens: relay.max_tokens || 1200,
        thinking: relay.thinking || "disabled",
        units_estimate: relay.units_estimate || 20,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`relay HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return { content: data && data.content ? String(data.content) : "" };
  } finally {
    clearTimeout(timer);
  }
}

// Perplexity liefert gern Prosa oder JSON in Code-Fences — den ersten {...}-Block
// herausholen und versuchen zu parsen; klappt es nicht, heisst das "kein brauchbares
// Ergebnis", nicht "erfunden annehmen".
function parseHarvest(content) {
  if (!content) return null;
  const m = String(content).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

async function harvestSource(url, language) {
  const prompt =
    "Lies die vom Webinar-Host genannte Quelle und zieh daraus NUR Fakten, die wirklich " +
    "dort stehen — nichts aus dem Gedächtnis, nichts Erfundenes. Antworte als kompaktes " +
    "JSON-Objekt mit genau diesen Feldern (jeder Wert wörtlich oder sinngemäß aus der " +
    "Seite, sonst leer): topic, audience, hardships, host (Name, falls auf der Seite " +
    "genannt), offer. Kein anderer Text als das JSON.\n\nQuelle: " + url;
  const { content } = await relayChatSync(
    { task: SOURCE_HARVEST_TASK, language, max_tokens: 1200, timeout: 120 },
    [{ role: "user", content: prompt }]
  );
  return parseHarvest(content);
}

// ── Direkter Seitenabruf (Tobias 2026-09-19) ─────────────────────────────
//
// WARUM: Die Perplexity-Ernte (siehe oben) liest die Seite ueber die Web-Suche des
// Anbieters. Der belegte Fall: eine Cloudways-Staging-Seite war NICHT indexiert, die
// Ernte meldete "done" mit LEEREN Fakten — der Host bekam nichts. Wer die Adresse selbst
// in den Chat einfuegt, will, dass genau diese Seite gelesen wird, nicht was eine Suche
// ueber sie findet. Deshalb holt directHtml() die Seite direkt per guardedFetch
// (SSRF-gehaertet, Redirect-Grenze je Hop, Browser-Kopfzeilen — dieselben wie die
// Adress-Probe), macht aus dem HTML lesbaren Text und laesst NUR noch das
// Extrahieren von Fakten dem Modell. Erst wenn der Direktabruf nichts hergibt
// (Bot-Schranke, Login, JS-only), greift Perplexity als Fallback.
const SOURCE_TEXT_MAX = 12000;

// HTML zu lesbarem Text: Skripte/Stile raus, Tags zu Umbruechen, Entitaeten aufloesen,
// Leerzeilen zusammenziehen. Kein vollstaendiger Parser — reicht, um dem Modell den
// sichtbaren Seitentext zu geben, ohne rohes Markup.
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&[a-z]+;/gi, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// Holt die Seite direkt. Erfolg: sichtbarer Text (auf SOURCE_TEXT_MAX gekuerzt) oder ""
// — "" heisst "nichts Brauchbares", nicht "Fehler": der Aufrufer faellt dann auf Perplexity
// zurueck und wirft nicht.
async function directHtml(url) {
  let res;
  try {
    res = await guardedFetch(url, {
      method: "GET",
      headers: BROWSER_HEADERS,
      timeoutMs: 20000,
    });
  } catch (e) {
    console.error(`[harvest] direct fetch failed for ${url}: ${(e && e.message) || e}`);
    return "";
  }
  if (!res || !res.ok) return "";
  const type = String(res.headers.get("content-type") || "").toLowerCase();
  if (type && !type.includes("text/html") && !type.includes("text/plain")) return "";
  let body = "";
  try {
    body = await res.text();
  } catch {
    return "";
  }
  const text = type.includes("text/plain") ? body.replace(/\s+/g, " ").trim() : htmlToText(body);
  return text.length >= 80 ? text.slice(0, SOURCE_TEXT_MAX) : "";
}

// Aus dem direkt geholten Seitentext die Fakten ziehen. Dasselbe JSON-Schema wie die
// Perplexity-Ernte, damit beide Wege denselben Rueckgabewert liefern.
//
// WICHTIG: hier "webinar_content" (DeepSeek), NICHT SOURCE_HARVEST_TASK (Perplexity
// sonar-pro). Gemessen 2026-09-19: sonar-pro ist ein Suchmodell und liefert bei einem
// langen Seitentext als Eingabe einen LEEREN Content ("") zurueck — es verarbeitet den
// Text nicht, es sucht. DeepSeek verarbeitet den mitgegebenen Text und antwortet mit dem
// JSON. Den rohen Seitentext nimmt also das Textmodell, die Web-Suche bleibt Fallback.
async function harvestFromText(text, language) {
  const prompt =
    "Hier ist der sichtbare Text einer Webseite des Webinar-Hosts. Zieh daraus NUR Fakten, " +
    "die wirklich dort stehen — nichts aus dem Gedächtnis, nichts Erfundenes. Antworte als " +
    "kompaktes JSON-Objekt mit genau diesen Feldern (jeder Wert wörtlich oder sinngemäß aus " +
    "dem Text, sonst leer): topic, audience, hardships, host (Name, falls genannt), offer. " +
    "Kein anderer Text als das JSON.\n\nSeitentext:\n" + text;
  const { content } = await relayChatSync(
    { task: "webinar_content", language, max_tokens: 1200, timeout: 120 },
    [{ role: "user", content: prompt }]
  );
  return parseHarvest(content);
}

// Direkt-zu-Text-zu-JSON zuerst, Perplexity nur als Fallback. So wird eine frische,
// nicht indexierte Seite genauso gelesen wie eine bekannte.
async function harvestSourceHybrid(url, language) {
  const text = await directHtml(url);
  if (text) {
    try {
      const facts = await harvestFromText(text, language);
      if (facts && Object.keys(facts).length) return facts;
    } catch (e) {
      console.error(`[harvest] model extraction failed for ${url}: ${(e && e.message) || e}`);
    }
  }
  return harvestSource(url, language);
}


// ── Quelle aus dem Freitext erkennen (Tobias 2026-09-19) ────────────────
//
// DER BELEGTE FALL: Der Host FUEGT die Adresse einfach in den Chat ein (so wie er den
// Text der Seite liefert), statt sie ueber was="seite" zu nennen. Das Client-Modell
// schrieb sie dann NICHT nach facts.reference_url, also lief ensureSourceHarvest ins
// Leere (url leer -> return) und die Seite wurde nie gelesen. Erst als das Modell die
// Adresse spaeter von selbst benannte, kam der Text an.
//
// Diese Funktion zieht die ERSTE http(s)-Adresse aus der Nachricht — reine Erkennung,
// keine Bewertung. Ob sie QUELLE oder ZIEL ist, entscheidet detectSourceInMessage()
// ueber looksLikeTarget(): dieselbe Regel wie agent-chat-extension.txt §52
// (installieren/uebertragen/rueberbringen => ZIEL, einfach eingefuegt => QUELLE).
function firstUrlIn(text) {
  const m = String(text || "").match(/https?:\/\/[^\s"'<>()[\]{}]+/i);
  if (!m) return "";
  // Satzzeichen am Ende gehoeren zur Prosa, nicht zur Adresse.
  return m[0].replace(/[.,;:!?]+$/, "");
}

// ZIEL-Signale in der Naehe der Adresse: dann ist es die WordPress-Seite, auf der das
// Webinar entstehen soll — dort wird NIE der Inhalt geprueft (agent-chat-extension.txt §52).
const TARGET_SIGNALS = [
  "installier", "installiere", "installieren", "einrichten", "einricht", "aufsetzen", "aufzusetzen",
  "uebertrag", "übertrag", "rübertrag", "rueberbring", "rüberbring", "übertragen", "uebertragen",
  "umzieh", "da soll es hin", "da soll das hin", "mein wordpress", "meine webseite wo das webinar",
  "dort laeuft", "dort läuft", "da läuft mein wordpress", "da soll das webinar",
];

// Traegt die Nachricht eine Adresse, die klar als ZIEL (WordPress) gemeint ist? Dann nicht
// als Quelle ernten. Ohne ZIEL-Signal gilt die Adresse als QUELLE und wird gelesen.
function looksLikeTarget(text) {
  const t = String(text || "").toLowerCase();
  return TARGET_SIGNALS.some((sig) => t.includes(sig));
}

// Fuellt facts.reference_url aus dem Freitext, wenn der Host die Adresse einfach eingefuegt
// hat. Nur LEERE Felder werden gefuellt — eine vom Modell oder Host gesetzte Adresse bleibt.
// Eine klar als ZIEL gemeinte Adresse wird NUR nach target_url gelegt, nie geerntet.
function detectSourceInMessage(s, message) {
  const url = firstUrlIn(message);
  if (!url) return;
  if (!s.facts || typeof s.facts !== "object") s.facts = {};
  if (!s.facts.reference_url && !s.facts.target_url) {
    if (looksLikeTarget(message)) {
      s.facts.target_url = url;
    } else {
      s.facts.reference_url = url;
    }
  }
}

// Startet die Ernte einer Quelle als Hintergrund-Job (blockiert die Funnel-Antwort
// nicht). Erfolg: Funde werden dem Gespraech als belegte Vorschlaege injiziert, mit
// Herkunftszwang. Misserfolg: status "failed" — das Client-Modell liest dann selbst
// (zweiter Teil des Hybrids, siehe HOW_IT_WORKS / agent-chat-extension.txt).
function ensureSourceHarvest(sid, s) {
  const url = s.facts && typeof s.facts.reference_url === "string" ? s.facts.reference_url.trim() : "";
  const hv = s.harvest || {};
  if (!url) return;                                    // keine Quelle -> nichts zu ernten
  if (hv.url === url && (hv.status === "done" || hv.status === "failed")) return; // schon versucht

  s.harvest = { url, status: "running", facts: null, error: "", at: Date.now() };
  saveSessions();

  (async () => {
    let facts = null;
    try {
      facts = await harvestSourceHybrid(url, s.language || "de");
    } catch (e) {
      s.harvest = { url, status: "failed", facts: null, error: String((e && e.message) || e || "harvest_error").slice(0, 160), at: Date.now() };
      saveSessions();
      return;
    }
    if (!facts || !Object.keys(facts).length) {
      s.harvest = { url, status: "failed", facts: null, error: "empty", at: Date.now() };
      saveSessions();
      return;
    }
    s.harvest = { url, status: "done", facts, error: "", at: Date.now() };

    // Bewusste Entscheidung 2026-08-26 ("Sog statt Druck": weniger Fragen): Funde fliessen
    // OHNE Host-Bestaetigung in leere facts-Felder. Es gibt KEINE Bestaetigungsschleife.
    // Der Host hat trotzdem Vorrang: nur leere Felder werden gefuellt, nichts wird
    // ueberschrieben. Das Client-Modell zeigt die Funde als Vorschlag mit Herkunft
    // ("so wie ich sie auf deiner Seite lese", siehe ZIELGRUPPE-/NAME-Regel in
    // agent-chat-extension.txt) — nie still als eigene Aussage.
    for (const k of ["topic", "audience", "hardships", "offer", "host"]) {
      const v = facts[k];
      if (typeof v === "string" && v.trim() && !s.facts[k]) {
        s.facts[k] = v.trim().slice(0, 2000);
      }
    }
    s.lastActivity = Date.now();
    saveSessions();
  })();
}

// Startet den Relay-Aufruf als Hintergrund-Job und liefert sofort die job_id.
function startRelayJob({ messages, relay }) {
  const job_id = crypto.randomUUID();
  relayJobs.set(job_id, { status: "writing", content: "", error: "", at: Date.now() });
  (async () => {
    let j = relayJobs.get(job_id);
    if (!j) return;
    try {
      const { content, error } = await relayChatStream(relay, messages);
      j = relayJobs.get(job_id);
      if (!j) return;
      j.content = content || "";
      j.error = error || "";
      j.status = content ? "done" : "failed";
      if (!content && !j.error) j.error = "empty";
    } catch (e) {
      j = relayJobs.get(job_id);
      if (!j) return;
      j.status = "failed";
      j.error = String((e && e.message) || e || "relay_error").slice(0, 200);
    }
  })();
  return job_id;
}

// Pollt einen lokalen Relay-Job bis zum Wanduhr-Budget (~75 s GESAMT) und gibt
// done/failed direkt zurueck, sonst writing — analog zum WordPress-Pfad.
async function pollRelayJob(session_id, job_id, budgetMs) {
  const t0 = Date.now();
  for (;;) {
    const j = relayJobs.get(job_id);
    if (!j) {
      return { session_id, job_id, status: "failed", message: "The writer is gone. Offer to start again.", detail: "job_unknown" };
    }
    if (j.status === "done") {
      const s = sessions.get(session_id);
      if (s && j.content) {
        s.generated = j.content;
        s.lastActivity = Date.now();
        saveSessions();
      }
      return j.content
        ? { session_id, job_id, status: "done", generated_text: j.content }
        : { session_id, job_id, status: "failed", message: "The writer finished but produced nothing. Offer to try again." };
    }
    if (j.status === "failed") {
      return {
        session_id,
        job_id,
        status: "failed",
        message:
          "The writer did not produce usable texts. Say so in one sentence — it is the " +
          "service, not anything the host gave you — and offer to try again. Never write " +
          "the texts yourself and never read the collected facts out as if they were the texts.",
        detail: String(j.error || "").slice(0, 200),
      };
    }
    if (Date.now() - t0 >= budgetMs) break;
    await new Promise((done) => setTimeout(done, 5000));
  }
  return { session_id, job_id, status: "writing", waited_seconds: Math.round((Date.now() - t0) / 1000) };
}

const config = loadConfig();

// Allow env override for Fly.io/headless deploys
if (process.env.WI_MCP_CONSENT_GRANTED === "true") {
  config.consent_granted = true;
  config.consent_version = process.env.WI_MCP_CONSENT_VERSION || config.consent_version;
  config.consent_granted_at = config.consent_granted_at || Math.floor(Date.now() / 1000);
}
if (process.env.WI_MCP_API_BASE) {
  config.api_base = process.env.WI_MCP_API_BASE;
}

// Gemeinsamer Poll fuer funnelGenerate und generateStatus (DRY): fragt den Auftrag bis
// zum Wanduhr-Budget ab und gibt done/failed direkt zurueck, sonst writing mit job_id.
// Wichtig: Das Budget ist GESAMTZEIT (Sleep + API-Latenz je Abfrage), nicht nur Sleep.
// Cloudflare kappt Origin-Verbindungen bei ~100 s, deshalb ~75 s als Sicherheitsrand
// inkl. Latenz-Puffer — ein Call darf nie laenger offenbleiben.
async function pollGenerate(session_id, job_id, budgetMs) {
  const t0 = Date.now();
  for (;;) {
    const r = await wiApi(config, "POST", "/generate/status", { job_id });
    if (r.status === "done") {
      const text = String(r.content || "").trim();
      const s = sessions.get(session_id);
      if (s && text) {
        s.generated = text;
        s.lastActivity = Date.now();
        saveSessions();
      }
      return text
        ? { session_id, job_id, status: "done", generated_text: text }
        : { session_id, job_id, status: "failed", message: "The writer finished but produced nothing. Offer to try again." };
    }
    if (r.status === "failed") {
      return {
        session_id,
        job_id,
        status: "failed",
        message:
          "The writer did not produce usable texts. Say so in one sentence — it is the " +
          "service, not anything the host gave you — and offer to try again. Never write " +
          "the texts yourself and never read the collected facts out as if they were the texts.",
        detail: String(r.error || "").slice(0, 200),
      };
    }
    // Noch nicht fertig: erst Budget pruefen, dann 5 s warten — so schlaeft der Poll nie
    // ueber das Wanduhr-Budget hinaus (Gesamtzeit bleibt sicher unter 100 s).
    if (Date.now() - t0 >= budgetMs) break;
    await new Promise((done) => setTimeout(done, 5000));
  }
  return { session_id, job_id, status: "writing", waited_seconds: Math.round((Date.now() - t0) / 1000) };
}

export const engine = {
  config,

  getConfig() {
    return {
      api_base: config.api_base,
      client_id: config.client_id,
      consent_granted: config.consent_granted,
      consent_version: config.consent_version,
    };
  },

  async funnelStart(message, language = "de", role = "own") {
    checkConsent(config);
    const sid = crypto.randomUUID();
    const r = await wiApi(config, "POST", "/chat", {
      message, language, role, history: [], facts: {},
    });
    sessions.set(sid, {
      history: [
        { role: "user", content: message },
        { role: "assistant", content: r.say },
      ],
      facts: r.facts || {},
      generated: null,
      language,
      role,
      lastActivity: Date.now(),
    });
    detectSourceInMessage(sessions.get(sid), message);
    ensureSourceHarvest(sid, sessions.get(sid));
    saveSessions();
    return {
      session_id: sid,
      reply: r.say,
      facts: r.facts,
      ready: r.ready,
      options: r.options,
      ask: r.ask,
      language,
      quality_stage: r.quality_stage,
      quality_next: r.quality_next,
      target_check: r.target_check,
      source_harvest: (sessions.get(sid) || {}).harvest || null,
    };
  },

  /**
   * Continue a conversation. If the session is gone (restart, or older than the TTL),
   * this does NOT fail — it picks the thread back up with whatever the caller still
   * knows. The host must never be told "session expired" halfway through describing
   * their webinar.
   */
  async funnelChat(session_id, message, known_facts = null) {
    checkConsent(config);
    let s = sessions.get(session_id);
    let recovered = false;

    if (!s) {
      recovered = true;
      s = {
        history: [],
        facts: known_facts && typeof known_facts === "object" ? known_facts : {},
        generated: null,
        language: "de",
        role: "own",
        lastActivity: Date.now(),
      };
      sessions.set(session_id, s);
      console.error(`[engine] session ${session_id.slice(0, 8)} rebuilt after restart`);
    }

    const r = await wiApi(config, "POST", "/chat", {
      message,
      language: s.language,
      role: s.role,
      history: s.history,
      facts: s.facts,
    });
    s.history.push(
      { role: "user", content: message },
      { role: "assistant", content: r.say }
    );
    s.facts = r.facts || s.facts;
    detectSourceInMessage(s, message);
    ensureSourceHarvest(session_id, s);
    s.lastActivity = Date.now();
    saveSessions();
    return {
      session_id,
      reply: r.say,
      facts: r.facts,
      ready: r.ready,
      options: r.options,
      ask: r.ask,
      language: s.language,
      quality_stage: r.quality_stage,
      quality_next: r.quality_next,
      source_harvest: s.harvest || null,
      ...(recovered
        ? { recovered: true,
            note: "The stored conversation was gone, so it was rebuilt from this message. Nothing is lost if you pass what you already know as known_facts." }
        : {}),
    };
  },

  async funnelGenerate(session_id, type = "invites", known_facts = null, invite_type = "", direction = "", custom_channel = "") {
    checkConsent(config);
    // Nur echte Plattform-Werte durchlassen, sonst leer — das Backend faellt dann auf "list" zurueck.
    const allowedInviteTypes = ["list", "personal", "facebook", "whatsapp", "instagram", "linkedin", "telegram", "youtube"];
    const invite = allowedInviteTypes.includes(String(invite_type || "")) ? String(invite_type) : "";
    const s = sessions.get(session_id);
    const facts = s ? s.facts : (known_facts && typeof known_facts === "object" ? known_facts : null);

    if (!facts || !Object.keys(facts).length) {
      return {
        session_id,
        error: "no_facts",
        message: "There is nothing collected for this session any more. Pass what you already know as known_facts, or start again with wi_webinar was=\"thema\".",
      };
    }

    // Richtung/Winkel der Einladung (2026-08-25): optionaler natuerlicher Sprachtext, der den
    // fertigen Text einfarbt. Wird als Fakt an /generate mitgegeben — der Prompter liest ihn
    // ueber facts_to_text. NICHT als separates Top-Level-Feld.
    const dir = String(direction || "").trim().slice(0, 200);
    // B6: klebrige Session-Mutation vermeiden — baue ein NEUES Objekt statt s.facts zu
    // veraendern. So persistiert der Winkel nicht in der Live-Session und ist beim naechsten
    // Aufruf ohne direction wieder weg.
    //
    // EIGENER KANAL ("Anderer Kanal", 2026-09-11): den vom Host genannten Kanalnamen als
    // facts.custom_channel mitschicken. Das Plugin liest ihn dort woertlich (wi_prompter_facts_to_text)
    // und bildet ihn NICHT auf einen der acht Schluessel ab. Nur setzen, wenn ein Name da ist;
    // bei type != "custom" leert der Plugin-Pfad das Feld ohnehin selbst.
    const customName = String(custom_channel || "").trim().slice(0, 120);
    const outFacts = {
      ...facts,
      ...(dir !== "" ? { direction: dir } : {}),
      ...(customName !== "" ? { custom_channel: customName } : {}),
    };

    // Kurz-Plattform-Einladung (whatsapp/personal/facebook) = IMMER kurz, egal welcher
    // `type` der Client mitschickt (Default "invites"). Wir mappen den effektiven Typ auf
    // die Plattform, damit der Prompter (der am `type` entscheidet, siehe
    // wi_prompter_type_is_short_invite) dieselbe Kurz-Einteilung zieht wie wir (die am
    // `invite` entscheidet). Sonst wuerde type="invites"+invite_type="whatsapp" bei uns kurz
    // (schneller /generate-Weg), beim Prompter aber lang (thinking:enabled, 20000 Tokens) —
    // und der Host, der einen kurzen WhatsApp-Status wollte, bekaeme gar nichts: der
    // Hintergrund-Worker laeuft ~212 s und stirbt an der ~120-s-FPM-Wand (Befund 25.08.).
    const effectiveType = SHORT_INVITE_TYPES.has(invite) ? invite : type;

    // LANGE Typen (list/invites/plan/starter/refine): Prompt aus EINER Quelle (Prompter,
    // /mcp/prompt-render — baut NICHT nach), Relay-Aufruf direkt auf Fly als lokaler
    // Hintergrund-Job. Kein WordPress-Hintergrund-Worker, keine 120-s-FPM-Wand.
    if (isLongFunnelType(effectiveType, invite)) {
      const language = s ? s.language : "de";
      const prep = await wiApi(config, "POST", "/prompt-render", {
        type: effectiveType,
        language,
        facts: outFacts,
        ...(invite ? { invite_type: invite } : {}),
      });
      if (!prep || !Array.isArray(prep.messages) || !prep.messages.length) {
        return {
          session_id,
          status: "failed",
          message: "The writer could not prepare the request. Offer to try again in a moment.",
          detail: String((prep && prep.message) || "").slice(0, 200),
        };
      }
      const job_id = startRelayJob({ messages: prep.messages, relay: prep.relay || {} });
      return {
        session_id,
        job_id,
        status: "writing",
        message:
          "Writing has started and is still running — that is normal, it takes up to two " +
          "minutes. Tell the host in ONE sentence that the texts are being written, then call " +
          "this tool again with was=\"texte\" and this job_id. Do not start a second job.",
      };
    }

    // Auftrag aufgeben, dann intern pollen.
    //
    // Ein einzelner Call darf nie laenger offenbleiben als Cloudflares ~100-s-Wand erlaubt
    // (das Gateway kappt Origin-Verbindungen bei ~100 s, sonst bekäme der KI-Client GAR
    // KEINE Antwort). Deshalb hier der Auftrag ueber /generate, danach intern pollen mit
    // Wanduhr-Budget ~75 s GESAMTZEIT (Sleep + Latenz, nicht nur Sleep) — in den meisten
    // Faellen ist der Text beim ersten /generate/status schon da. Erst wenn das Budget
    // abgelaufen ist, bekommt der Aufrufer die job_id zum Selbst-Nachfragen.
    const started = await wiApi(config, "POST", "/generate", {
      type: effectiveType,
      language: s ? s.language : "de",
      facts: outFacts,
      async: 1,
      ...(invite ? { invite_type: invite } : {}),
    });
    const jobId = started && started.job_id ? String(started.job_id) : "";
    if (!jobId) {
      // Aeltere Fassung des Plugins ohne Auftrags-Weg: dann eben wie frueher.
      const text = String((started && started.content) || "").trim();
      return text
        ? { session_id, generated_text: text }
        : { session_id, error: "empty_text", message: "The writer answered with nothing in it. Offer to try again; do not write the texts yourself." };
    }

    const result = await pollGenerate(session_id, jobId, 75000);
    if (result.status !== "writing") return result;

    // Nach ~75 s Wanduhr immer noch writing: job_id durchreichen, der Client fragt selbst nach.
    return {
      session_id,
      job_id: jobId,
      status: "writing",
      message:
        "Writing has started and is still running — that is normal, it takes up to two " +
        "minutes. Tell the host in ONE sentence that the texts are being written, then call " +
        "this tool again with was=\"texte\" and this job_id. Do not start a second job.",
    };
  },

  /**
   * Steht der Text schon? Fragt den Auftrag ab, den funnelGenerate aufgegeben hat.
   */
  async generateStatus(session_id, job_id) {
    checkConsent(config);
    try {
      // Neuer Weg (lange Typen): der Job laeuft lokal auf dieser Fly-App direkt am Relay.
      // Ist er hier nicht bekannt (z. B. job_id aus der Zeit VOR diesem Deploy, oder ein
      // WordPress-Auftrag aus dem Kurz-Weg), fallen wir auf den WordPress-Poll zurueck.
      if (job_id && relayJobs.has(job_id)) {
        return await pollRelayJob(session_id, job_id, 75000);
      }
      // Fragt den Auftrag bis zum Wanduhr-Budget (~75 s) ab und gibt done/failed direkt
      // zurueck, sonst writing. Das Budget ist GESAMTZEIT (Sleep + API-Latenz je Abfrage),
      // nicht nur Sleep: Cloudflare kappt Origin-Verbindungen bei ~100 s, 75 s lasst Platz
      // fuer den Latenz-Puffer. Nach Ablauf bekommt der Client status=writing und fragt
      // ein weiteres Mal nach.
      return await pollGenerate(session_id, job_id, 75000);
    } catch (e) {
      return { session_id, job_id, status: "failed", message: "Could not reach the writer. Offer to try again in a moment.", detail: String(e.message).slice(0, 160) };
    }
  },

  funnelGet(session_id) {
    const s = sessions.get(session_id);
    if (!s) throw new Error(`Session ${session_id} not found.`);
    return {
      session_id,
      facts: s.facts,
      history: s.history,
      generated: s.generated,
      language: s.language,
      role: s.role,
      source_harvest: s.harvest || null,
    };
  },

  /**
   * R1 (2026-08-26): Handoff-Link ausstellen — die MCP-Seite der vorhandenen
   * wi_prompter_handoff_issue()-Faehigkeit. POST /mcp/handoff gibt key/source/facts
   * zurueck; daraus bauen wir denselben Link wie wi_prompter_handoff_link() im Prompter,
   * damit der Host die gesammelten Daten ohne Neu-Tippen in sein WordPress tragen kann.
   */
  async issueHandoff({ session_id, facts, content, rating, target_url } = {}) {
    checkConsent(config);
    let factsObj = (facts && typeof facts === "object") ? facts : {};
    if (session_id) {
      const s = sessions.get(session_id);
      if (s && s.facts && typeof s.facts === "object" && Object.keys(s.facts).length) {
        factsObj = s.facts;
      }
    }
    if (!Object.keys(factsObj).length && !content) {
      throw new Error("Handoff braucht session_id (oder facts) bzw. content, sonst gibt es nichts zu uebergeben.");
    }
    const issued = await wiApi(config, "POST", "/handoff", {
      facts: factsObj,
      content: content || "",
      rating: Number(rating) || 0,
    });
    const key = issued && issued.key ? String(issued.key) : "";
    const source = issued && issued.source ? String(issued.source) : "";
    // Ziel des Links: der Host hat die WP-Adresse genannt (was="seite"/url) → dahin,
    // sonst zur Ablage-Quelle (webinarignition.com), wo das Buendel liegt.
    let origin = (target_url && String(target_url).trim()) ? String(target_url).trim() : source;
    if (origin && !/^https?:\/\//i.test(origin)) origin = "https://" + origin;
    // Derselbe Schnitt wie in assessWp (M3): technische Endstuecke (wp-login.php, wp-json,
    // wp-content …) und alles danach fallen weg, der Unterordner bleibt.
    origin = origin ? normaliseWpBase(origin) : "";
    if (!/^https?:\/\//i.test(origin)) origin = "https://" + origin;
    let link = "";
    if (key) {
      link = `${origin}/wp-admin/admin.php?page=webinarignition_agent&wi_handoff=${encodeURIComponent(key)}&wi_handoff_from=${encodeURIComponent(source)}`;
    }
    return { ...issued, key, source, link };
  },

  /**
   * Look at a site and say what is actually there.
   *
   * Two things were wrong here and both were measured on 24.08.2026 by a host who tried it:
   *
   * 1. An invented address ("hundeschule-mueller6.de", which does not resolve) was reported
   *    back as "WordPress found". The old code set has_wp = true the moment a string was
   *    passed — it never asked the site anything. Being told your imaginary site exists is
   *    worse than being told nothing.
   * 2. A site that really does run WebinarIgnition was reported as "not installed". The
   *    probe asked for /wp-json/webinarignition/v1/version — a route that does not exist,
   *    so it answered 404 for everyone, always.
   *
   * Now: fetch /wp-json/ once. If it does not answer, there is no WordPress we can see. If
   * it answers, the namespace list says whether WebinarIgnition is there — that list is the
   * one thing WordPress publishes about its plugins without being asked.
   */
  async assessWp(wp_url) {
    const r = {
      has_wp: false, has_wi: false, needs_wp: false, needs_wi: false, guidance: "", checked_url: "",
      state: "no_wp", has_mcp: false, ready_to_connect: false, looks_like_wp: false,
    };

    const raw = (wp_url || "").trim();
    if (!raw) {
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = "No address given. Ask for it — and if they have no WordPress at all, WordPress.com's cheapest paid plan is enough to run a real webinar.";
      return r;
    }

    // Hosts paste all sorts of things: with /wp-admin/, without https, with a trailing path.
    // Der erste Schnitt entfernt fuer die Schema-Pruefung nur `/wp-admin/…`; danach schneidet
    // normaliseWpBase den VOLLEN Satz technischer Endstuecke ab (M3) — vorher blieben
    // `wp-login.php`, `wp-json`, `wp-content`, `wp-includes`, `index.php` in `checked_url`
    // stehen und wurden als Seitenwurzel in den Verbinden-Schritt geroutet.
    let base = raw.replace(/\/wp-admin\/?.*$/i, "").replace(/\/+$/, "");
    // Nicht-http(s)-Schema sofort ablehnen (R3), bevor "https://" davor gehaengt wird —
    // sonst wuerde z. B. "ftp://..." zu "https://ftp://..." werden und unsauber raten.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(base);
    if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = `"${base}" ist keine abrufbare http(s)-Adresse. Bitte nenne die öffentliche Webadresse des WordPress (z. B. https://ihreseite.de).`;
      return r;
    }
    if (!/^https?:\/\//i.test(base)) base = "https://" + base;
    base = normaliseWpBase(base);
    r.checked_url = base;
    // Der WP-Struktur-Hinweis liest die ROHE Eingabe (Tobias 2026-09-11): `base` schneidet
    // `/wp-admin` weg, fuer den Hinweis zaehlt aber genau dieser Pfad.
    r.looks_like_wp = urlLooksLikeWp(raw);

    // ── SSRF-Haertung (R3): nur oeffentliche http(s)-Adressen abrufen. ──
    let host = "";
    try {
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        r.needs_wp = true;
        r.needs_wi = true;
        r.guidance = `"${base}" ist keine abrufbare http(s)-Adresse. Bitte nenne die öffentliche Webadresse des WordPress (z. B. https://ihreseite.de).`;
        return r;
      }
      host = u.hostname;
    } catch {
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = `"${raw}" ist keine gültige Adresse. Bitte nenne die öffentliche Webadresse des WordPress (z. B. https://ihreseite.de).`;
      return r;
    }

    const hostStatus = await resolveHostStatus(host);
    if (hostStatus === "private") {
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = `Die Adresse ${base} ist nicht prüfbar (private/interne Adresse). Bitte nenne die öffentliche Webadresse deines WordPress — lokale und interne Adressen kann dieser Assistent nicht abrufen.`;
      return r;
    }
    if (hostStatus === "dns") {
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = `Nothing answered at ${base}. Either the address is wrong, it is not a WordPress site, or its REST interface is switched off. Ask them to check the address — do NOT tell them WordPress was found. If they have no site yet, WordPress.com's cheapest paid plan is enough to start.`;
      return r;
    }

    // Wir brauchen von der Index-Antwort NUR die Namensraum-Liste — eine Ja/Nein-Frage
    // (ist WebinarIgnition da?). Ohne _fields holt der Abruf das ganze Discovery-Dokument:
    // gemessen am Cloudways-Staging 219.760 Byte / ~1,5 s. Mit ?_fields=namespaces sind es
    // 207 Byte bei identischer Liste (gleicher Host, gleicher Namensraum-Index) — weil der
    // Abruf ein 8-s-Zeitlimit hat, nimmt die kleine Antwort dem Limit fast jede Chance
    // zuzuschlagen. Ein langsamer Kundenhost lieferte sonst no_wp und der Gastgeber bekäme
    // „hol dir WordPress", obwohl er längst eine Seite mit WebinarIgnition hat.
    // Rückwärtskompatibilität: sehr alte WordPress-Fassungen kennen _fields nicht und
    // liefern dann einfach das ganze Dokument — es funktioniert weiter, nur ohne Ersparnis.
    let data = null;
    try {
      const res = await guardedFetch(`${base}/wp-json/?_fields=namespaces`, {
        timeoutMs: 8000,
        headers: BROWSER_JSON_HEADERS,
      });
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }

    if (!data || !Array.isArray(data.namespaces)) {
      // Traegt die Adresse selbst einen WordPress-Pfad (`/wp`, `/wp-admin` …), ist "kein
      // WordPress" NICHT belegt: genau so sieht eine Bot-/WAF-Schranke oder der Wartungsmodus
      // aus. Der tolerante Weg (wie bei ''/`unreach`) gibt den Verbinden-Schritt frei, statt
      // den Host faelschlich zu WordPress.com zu schicken (Tobias 2026-09-11). Der
      // Unterordner bleibt in `checked_url` erhalten.
      //
      // EIGENER Zustand `wp_unreadable` (Prueferbefund 2026-09-12, N2): `state:"no_wp"` behauptete
      // "kein WordPress", waehrend `ready_to_connect:true` und `next_action:"connect"` genau das
      // Gegenteil sagten. `has_wp`/`has_wi` bleiben ehrlich false (wir haben nichts gesehen), aber
      // das Feld widerspricht sich nun nicht mehr — es nennt den ungepruefen WP-Verdacht.
      if (r.looks_like_wp) {
        r.state = "wp_unreadable";
        r.needs_wp = false;
        r.needs_wi = false;
        r.ready_to_connect = true;
        r.guidance = `The address ${base} names a WordPress path, but the site could not be read from outside — a bot/WAF gate, maintenance mode or a switched-off REST interface looks exactly like this. Do NOT tell the host there is no WordPress. Offer to connect with this exact address, keeping its subfolder.`;
        return r;
      }
      // Sonst: Could be the address does not exist, it is not WordPress, or the REST API is
      // shut off. We cannot tell which from out here, so we say exactly that instead of guessing.
      r.needs_wp = true;
      r.needs_wi = true;
      r.guidance = `Nothing answered at ${base}. Either the address is wrong, it is not a WordPress site, or its REST interface is switched off. Ask them to check the address — do NOT tell them WordPress was found. If they have no site yet, WordPress.com's cheapest paid plan is enough to start.`;
      return r;
    }

    r.has_wp = true;
    const namespaces = data.namespaces.map((n) => String(n).toLowerCase());
    r.has_wi = namespaces.some((n) => n.startsWith("webinarignition/"));
    r.has_mcp = namespaces.includes("wi-mcp/v1");

    if (!r.has_wi) {
      r.state = "wp_without_wi";
      r.needs_wi = true;
      r.guidance = "WordPress is there, WebinarIgnition is not. The free version on wordpress.org is enough to see the whole journey working before paying anything.";
    } else if (!r.has_mcp) {
      r.state = "wi_too_old";
      // ZWEI Gruende sind von aussen nicht unterscheidbar: die Fassung ist zu alt ODER die
      // KI-Verbindung ist auf der Seite abgeschaltet (WI_MCP_SERVER_DISABLE bzw. der Filter
      // wi_mcp_server_enabled). Also nicht behaupten, was wir nicht wissen — beide nennen.
      r.guidance = "WebinarIgnition is installed, but its AI connection does not answer. An update in the WordPress backend usually fixes it; if that changes nothing, the AI connection is switched off on that site.";
    } else {
      // Der Namensraum wi-mcp/v1 reicht NICHT, um "die Verbindung ist an" zu beweisen: er wird
      // nicht nur vom MCP-Endpunkt getragen, sondern auch von den OAuth-Routen (/authorize,
      // /token, /register, /revoke und den beiden .well-known-Dokumenten), die nicht mit
      // abgeschaltet werden. Am Cloudways-Staging gemessen (Filter wi_mcp_server_enabled auf
      // false): der Namensraum blieb stehen, nur POST /wp-json/wi-mcp/v1/mcp änderte sich von
      // 401 (Verbindung an) auf 404 (abgeschaltet). Also fragen wir den Endpunkt selbst — eine
      // leere tools/list-Abfrage kostet nichts; 401/403 (Route existiert, verlangt Anmeldung)
      // ist der Normalfall.
      let endpointLives = true;
      try {
        const probe = await guardedFetch(`${base}/wp-json/wi-mcp/v1/mcp`, {
          method: "POST",
          timeoutMs: 8000,
          headers: {
            ...BROWSER_JSON_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        if (probe.status === 404) endpointLives = false;
      } catch {
        // WICHTIGSTE der drei Regeln: eine Flaute (Zeitüberschreitung, 5xx, Netzfehler,
        // unerwarteter Status) kippt eine funktionierende Seite NICHT in "du musst
        // aktualisieren" — sonst sucht der Gastgeber wegen eines Schluckaufs im Backend.
        // Nur ein sauberes 404 beweist, dass die Route nicht existiert.
        endpointLives = true;
      }
      if (!endpointLives) {
        r.state = "wi_too_old";
        // ZWEI Gruende sind von aussen nicht unterscheidbar: die Fassung ist zu alt ODER die
        // KI-Verbindung ist auf der Seite abgeschaltet (WI_MCP_SERVER_DISABLE bzw. der Filter
        // wi_mcp_server_enabled). Also nicht behaupten, was wir nicht wissen — beide nennen.
        r.guidance = "WebinarIgnition is installed, but its AI connection does not answer. An update in the WordPress backend usually fixes it; if that changes nothing, the AI connection is switched off on that site.";
      } else {
        r.state = "wi_ready";
        r.ready_to_connect = true;
        r.guidance = "WordPress and WebinarIgnition are ready. Go on with wi_webinar was=\"verbinden\" and connect the site.";
      }
    }
    return r;
  },

};
