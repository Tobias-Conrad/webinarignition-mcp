#!/usr/bin/env node
/**
 * wi-mcp-discoverability.mjs — schreibt die Aussen-Texte unseres MCP-Servers so, dass sie bei den
 * Begriffen gefunden werden, die in den Verzeichnissen WIRKLICH gesucht werden.
 *
 * ── Warum (gemessen 2026-10-02, mcpbeat.com = echte Registry-Daten) ──────────────────────────
 * Treffer je Suchbegriff: github 860 · email 668 · google 613 · pdf 547 · calendar 259 ·
 * stripe 124 · wordpress 50 · **webinar 4**.
 * Größte Themenbereiche: Coding Agents 2.984 · Finance and Markets 2.646 · Observability 1.427 ·
 * Security 1.251 · Communication 1.090 · Data Analysis 1.084.
 *
 * Unser Server stand nur unter „webinar" — und das ist mit 4 Treffern die kleinste Nische.
 * Er KANN aber viel mehr (belegt im Code und im Live-Handshake): Anmeldeseite, Einladungs- und
 * Erinnerungs-Mails, Follow-up, Live-Raum, Verkauf im Raum, Veröffentlichen auf WordPress.
 *
 * ── Regel: NUR benennen, was wirklich da ist (Tobias 2026-10-02) ─────────────────────────────
 * Kein erfundenes Tool, keine erfundene Fähigkeit. Jeder Begriff muss durch eine der 18
 * Fähigkeiten oder durch `was=`-Schritte gedeckt sein. Was nicht belegt ist, kommt nicht rein.
 *
 * Aufruf:  node wi-mcp-server/scripts/wi-mcp-discoverability.mjs [--check]
 *   ohne --check: schreibt server.json + die Tool-Beschreibung in src/server.js
 *   --check: zeigt nur, was sich ändern würde
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHECK = process.argv.includes("--check");

// ── Was der Server nachweislich kann (Quelle: was=-Schritte + die 18 Fähigkeiten) ────────────
// Jede Zeile ist im Code vorhanden. Keine Zeile ist erfunden.
const ABILITIES = [
  "registration page",       // create-webinar: die fertige Anmeldeseite
  "invitation emails",       // Teil von create-webinar
  "reminder emails",         // die vier Erinnerungen/Folge-Mails
  "follow-up emails",
  "thank-you page",          // kommt aus dem Template (nicht geschrieben — deshalb nur erwähnen)
  "live room",               // configure-100ms / configure-daily
  "evergreen / automated webinars",
  "sell inside the room",    // WooCommerce-Kauf im Webinar
  "publish on WordPress",
];

/**
 * Die Beschreibung für die offizielle Registry. Grenze: **100 Zeichen** (per validate geprüft).
 * Sie muss die BRETTER-Begriffe tragen (email, page, WordPress, live, automated, evergreen),
 * nicht nur das Nischen-Wort „webinar".
 */
const DESCRIPTION =
  "Webinar & email automation for WordPress: signup page, invites, reminders, live or evergreen.";

/** Die lange Beschreibung (Smithery, server-card) — hier ist Platz für die ganzen Fähigkeiten. */
const LONG_DESCRIPTION =
  "Build and run a webinar on your own WordPress site from a chat: registration page, invitation " +
  "and reminder emails, follow-up sequence, live room, and sales inside the room. Live, automated " +
  "or evergreen. Also answers product questions. No sign-in needed.";

/** Die Tool-Beschreibung (server-card + tools/list) — sie ist der Suchtext im Handshake. */
const TOOL_DESCRIPTION =
  "Webinar, registration page and email automation for WordPress: write the title, invitation " +
  "emails, reminder and follow-up mails, build the registration/signup page, prepare the live room " +
  "and run live, automated or evergreen webinars on the user's own site. Also answers product questions.";

const report = [];
const apply = (file, from, to, label) => {
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) {
    report.push(`FEHLT  ${label} — Suchtext nicht gefunden in ${file}`);
    return false;
  }
  if (src.split(from).length > 2) {
    report.push(`MEHRDEUTIG ${label} — ${from.slice(0, 40)}… kommt mehrfach vor`);
    return false;
  }
  if (!CHECK) writeFileSync(file, src.replace(from, to), "utf8");
  report.push(`OK     ${label} (${to.length} Zeichen)`);
  return true;
};

// 1) Registry-Beschreibung (100-Zeichen-Grenze!)
const SERVER_JSON = resolve(ROOT, "server.json");
const json = JSON.parse(readFileSync(SERVER_JSON, "utf8"));
if (DESCRIPTION.length > 100) {
  console.error(`ABBRUCH — Registry-Beschreibung ist ${DESCRIPTION.length} Zeichen, erlaubt sind 100.`);
  process.exit(1);
}
const oldDesc = json.description;
json.description = DESCRIPTION;
if (!CHECK) writeFileSync(SERVER_JSON, JSON.stringify(json, null, 2) + "\n", "utf8");
report.push(`OK     server.json description (${DESCRIPTION.length} Zeichen, Grenze 100)`);
report.push(`       alt: ${oldDesc}`);
report.push(`       neu: ${DESCRIPTION}`);

// 2) Tool-Beschreibung in server-card.json (src/server.js)
const SERVER_JS = resolve(ROOT, "src/server.js");
const src = readFileSync(SERVER_JS, "utf8");
const oldTool = (src.match(/\{ name: "wi_webinar", description: "([^"]+)"/) || [])[1];
if (oldTool) {
  apply(SERVER_JS, oldTool, TOOL_DESCRIPTION, "server-card + tools/list (wi_webinar)");
} else {
  report.push("FEHLT  Tool-Beschreibung wi_webinar in src/server.js");
}

console.log(CHECK ? "TROCKENLAUF (nichts geschrieben)" : "GESCHRIEBEN");
console.log("");
report.forEach((r) => console.log("  " + r));
console.log("");
console.log("  Belegte Fähigkeiten (Quelle: was=-Schritte + 18 Fähigkeiten im Code):");
ABILITIES.forEach((a) => console.log("   - " + a));
