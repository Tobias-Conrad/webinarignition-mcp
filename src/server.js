import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, renameSync, unlinkSync } from "fs";
import { createHash, timingSafeEqual } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { engine } from "./lib/engine.js";
import { techPlan, INTERFACES } from "./lib/techplan.js";
import { ask, askFromFunnel } from "./lib/ask.js";
import { s, o, SUPPORTED, faqItems, negotiateLanguage, ogLocale, baseLanguage, hreflangLinks } from "./lib/i18n.js";
// Sprach-Zählung fürs Report (2026-10-02): normalisiert Accept-Language, erkennt auch Sprachen,
// die wir NICHT anbieten (z. B. haw) — genau die sind die interessante Zeile im Report.
import { languageOf, isOfferedLanguage, offeredLanguages } from "./lib/langstats.js";
import { beginConnect, completeConnect, connectionStatus, hasPendingConnect, siteAbilities, runSiteAbility, disconnect } from "./lib/wpconnect.js";
import * as outbound from "./lib/outbound.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.WI_MCP_PORT || "3000", 10);

// Phase 3 (2026-08-31): der Nordstern ("für wen baue ich") kommt aus EINER Quelle — dem Relay.
// Beim Start wird er von dort geholt; die lokale Fassung ist nur der Offline-Fallback. So driften
// die drei Oberflächen (Backend, Prompter, MCP) nicht mehr auseinander.
const PRINCIPLES_FALLBACK = `## Who you are working for, in this order

1. **The attendee** — the person who will register and watch. Everything you write must be
   effortless for them: one clear next step, no jargon, no doubt that it worked.
2. **The host** — the person in this chat, who is setting the webinar up. Ask as few
   questions as possible. Prefer offering choices over asking open questions.
3. **The technology** — never a reason to make 1 or 2 worse.`;

// B-Entscheidung (2026-09-08): Fakten-Uebergabe MCP -> WordPress beim Anlegen.
// Beim create-webinar injiziert der Connector die im Gespraech gesammelten Fakten automatisch
// 1:1 in die create-Args — aber NUR in leere Feldluecken (was das Modell/Host explizit
// uebergibt, gewinnt). Whitelist: nur Keys, die `wi_create_webinar` im Kernel deklariert.
const CREATE_FACT_MAP = [
  ["topic", "topic", "string"],
  ["audience", "target_audience", "string"],
  ["participant_goal", "primary_goal", "string"],
  ["goal", "primary_goal", "string"],
  ["offer", "offer_description", "string"],
  ["title", "title", "string"],
  ["channel", "channel", "string"],
  ["start_date", "start_date", "string"],
  ["start_time", "start_time", "string"],
  ["start_timezone", "start_timezone", "string"],
  ["start_offset_days", "start_offset_days", "number"],
  ["host", "host", "string"],
  ["host_info", "host_info", "string"],
  ["speaker", "host_info", "string"],
  ["language", "language", "string"],
  ["type", "type", "string"],
  ["reminders", "reminders", "number"],
  ["duration_minutes", "duration_minutes", "number"],
  ["schedule", "schedule", "object"],
  ["cta_timing", "cta_timing", "string"],
  ["mail_cta", "mail_cta", "string"],
  ["reminder_frame", "reminder_frame", "string"],
];

// true, wenn ein create-Arg eine leere Luecke ist, die ein Fakt fuellen darf.
// K1 (2026-09-08, gewaehlte Variante): Ein EXPLIZIT uebergebenes `""` zaehlt NICHT als Luecke,
// sondern als bewusst geleert und BLOCKIERT die Injektion. Sicherster Weg fuer create: hat der
// Host ein Feld absichtlich geleert, darf kein Session-Fakt still wieder hineinrutschen. Nur
// undefined/null sind fuellbare Luecken — ein leerer String nicht.
function isCreateGap(value) {
  if (value === undefined || value === null) return true;
  return false;
}

// normalisiert einen Wert auf eine brauchbare Form; gibt null zurueck, wenn er nicht passt.
function normalizeCreateFact(raw, type) {
  if (type === "string") {
    if (typeof raw !== "string") return null;
    const v = raw.trim();
    return v === "" ? null : v;
  }
  if (type === "number") {
    // R2/R3 (2026-09-08): akzeptiere Zahl UND eindeutigen numerischen String („10" -> 10),
    // statt `typeof === "number"` hart zu verlangen. Leere/weisse Strings sind keine Zahlen
    // (Number("") wuerde sonst 0 liefern) und werden abgewiesen.
    if (typeof raw === "string" && raw.trim() === "") return null;
    const n = Number(raw);
    if ((typeof raw !== "number" && typeof raw !== "string") || !Number.isFinite(n)) return null;
    return n;
  }
  if (type === "object") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw;
  }
  return null;
}

// A (2026-09-08): reiner Datums-Vergleich als String `YYYY-MM-DD` gegen heute (UTC).
// Heute gilt als uebernehmbar; nur ein streng vergangenes Datum gilt als abgelaufen.
// Nicht-passende Formate koennen wir nicht sicher vergleichen -> als uebernehmbar behandeln.
function isPastDate(dateStr) {
  if (typeof dateStr !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return dateStr < new Date().toISOString().slice(0, 10);
}

// Bereichs-Grenzen je Zahlen-Feld (Kernel-Grenzen, keine Ermessenssache).
const CREATE_NUMBER_RANGES = {
  reminders: [0, 5],
  start_offset_days: [1, 90],
  duration_minutes: [1, 1440],
};

// Merged facts -> create-Args: fuellt nur leere Feldluecken, ueberschreibt nie.
// Liefert ein NEUES args-Objekt; das Original bleibt unveraendert.
export function mergeCreateFacts(args, facts) {
  const out = { ...(args || {}) };
  if (!facts || typeof facts !== "object") return out;
  for (const [source, target, type] of CREATE_FACT_MAP) {
    if (!isCreateGap(out[target])) continue; // Modell/Host hat es gesetzt -> Vorrang
    const v = normalizeCreateFact(facts[source], type);
    if (v === null) continue; // leer/null/kein passender Typ -> ueberspringen
    if (type === "number") {
      const [min, max] = CREATE_NUMBER_RANGES[target] || [-Infinity, Infinity];
      if (!Number.isInteger(v) || v < min || v > max) continue; // R2/R4: Integer + Bereich
    }
    // A (2026-09-08): ein vergangener Session-Termin wird nicht still uebernommen —
    // das ausfuehren-Case fragt den Gastgeber stattdessen EINMAL nach dem neuen Termin.
    if (source === "start_date" && isPastDate(v)) continue;
    out[target] = v;
  }
  return out;
}

// true, wenn das Ziel-Tool ein create-webinar ist (normalisiert wie resolveToolName).
export function isCreateWebinarTool(tool) {
  const flat = String(tool || "").toLowerCase().replace(/[/\-\s]/g, "_");
  return flat === "create_webinar" || flat === "webinarignition_create_webinar";
}

// ── Zerstoerend-Flaeche (Tobias 2026-09-24) ────────────────────────────────
// Warum: OpenAI (und jeder andere Host) liest die MCP-Annotation UNSERES Node-Werkzeugs, nicht
// die der WordPress-Faehigkeiten dahinter. Solange EIN allgemeines Werkzeug mit
// destructiveHint:false auch ueber was="ausfuehren" loeschen konnte, log die Annotation.
// Deshalb: wi_webinar fuehrt nichts Zerstoerendes mehr aus (es leitet um), und das eigene
// Werkzeug wi_webinar_delete fuehrt ausschliesslich Zerstoerendes aus. Beide gehen denselben
// Weg (runSiteAbility/resolveToolName) — nur diese Pruefung unterscheidet sie.

// Namens-Vergleich so tolerant wie resolveToolName: Bindestriche/Unterstriche/Leerzeichen egal,
// Praefix `webinarignition_` (bzw. `wi_`) egal. "webinarignition/delete-webhook" -> "delete_webhook".
export function normaliseAbilityName(name) {
  return String(name || "").toLowerCase().replace(/[/\-\s]/g, "_")
    .replace(/^webinarignition_/, "").replace(/^wi_/, "");
}

// Statische Allowlist = UNTERGRENZE: was hier steht, ist IMMER zerstoerend — auch dann, wenn die
// Faehigkeitsliste der Seite es anders behauptet. Die Seitenliste kann nur ERWEITERN, nie
// wegdiskutieren. Nötig, weil zwei ehrliche Quellen sonst luegen koennen (Prueferbefund 2026-09-24):
// der Kernel-Fallback-Katalog fuer Cores ohne Abilities-API setzt destructiveHint:false fuer ALLE
// Tools (webinarignition-premium/inc/wi-mcp-server.php:332-336), und eine aeltere Plugin-Version
// annotiert z. B. reset_funnel noch false. Quelle der Liste:
// webinarignition-premium/inc/wi-capability-kernel.php, annotations.destructive => true (2026-09-24).
const DESTRUCTIVE_ABILITIES = new Set([
  "delete_webhook",
  "delete_campaign",
  "delete_lead",
  "delete_all_leads",
  "reset_funnel",
  "delete_logs",
  "delete_all_questions",
  "import_hc_campaign",
]);

// Sonderfall: wi_moderate_question ist nur mit action="delete" zerstoerend (Einzelfrage loeschen),
// obwohl die Faehigkeit selbst destructive:false traegt. Gilt unabhaengig von der Seitenliste.
// BEIDE Schluesselnamen pruefen: der Kernel remappt synonyme Arg-Namen
// (remap_prefixed_arg_synonyms, Praefix `webinar_`, wi-capability-kernel.php:1812, angewandt in
// invoke() :1982 VOR dem Callback, der danach $args['action'] liest). Ohne `webinar_action`
// umginge {action:undefined, webinar_action:"delete"} die Pruefung (Prueferbefund 2026-09-24).
function isDestructiveByPolicy(name, args) {
  if (name !== "moderate_question") return false;
  const wanted = [args && args.action, args && args.webinar_action];
  return wanted.some((v) => String(v || "").toLowerCase() === "delete");
}

/** Statische Entscheidung ohne Netz: in der Allowlist ODER der moderate-question-Sonderfall. */
export function isStaticallyDestructive(tool, args = {}) {
  const name = normaliseAbilityName(tool);
  return DESTRUCTIVE_ABILITIES.has(name) || isDestructiveByPolicy(name, args);
}

/**
 * Ist das Ziel zerstoerend? Liefert einen von vier Zustaenden:
 *   "destructive" | "not_destructive" | "unknown" | "not_connected"
 *
 * Die statische Untergrenze (isStaticallyDestructive, inkl. moderate-question-Sonderfall) gilt
 * IMMER — sie wird mit dem Treffer der Seitenliste verodert, nicht von ihm abgeloest. Die Liste
 * der verbundenen Seite (siteAbilities liefert je Tool `destructive`) kann also nur zusaetzlich
 * zerstoerende Ziele melden. Ist sie nicht abrufbar ODER leer, bleibt nur die Untergrenze; ein
 * unbekanntes Ziel heisst dann "unknown":
 *   wi_webinar        leitet NUR bei "destructive" um ("unknown" laeuft weiter — die Untergrenze
 *                     faengt jedes bekannte Loeschen ohnehin ab, runSiteAbility/resolveToolName
 *                     prueft die Existenz ohnehin).
 *   wi_webinar_delete laesst nur "destructive" durch, lehnt "not_destructive"/"unknown" ab.
 * "not_connected" heisst: es gibt gar keine Verbindung — dann sagt der normale Aufrufpfad
 * ehrlich Bescheid (statt hier eine Umleitung zu erfinden).
 */
export async function classifyAbilityTarget(session_id, tool, args = {}) {
  const name = normaliseAbilityName(tool);
  if (isDestructiveByPolicy(name, args)) return "destructive";
  if (!connectionStatus(session_id).connected) return "not_connected";

  let listed = null;
  try {
    const ab = await siteAbilities(session_id);
    // Nur eine NICHT-LEERE Liste gilt als gelesen. `[]` ist truthy und wuerde sonst als
    // "die Seite hat keine zerstoerenden Tools" durchgehen (fail-open).
    listed = Array.isArray(ab.tools) && ab.tools.length ? ab.tools : null;
  } catch {
    listed = null; // Liste nicht abrufbar -> es bleibt bei der statischen Untergrenze
  }

  const match = listed ? listed.find((t) => normaliseAbilityName(t.name) === name) : null;

  // Union: Untergrenze ODER Seitenlisten-Treffer. Eine Seite kann damit nur ergaenzen, nie
  // eine bekannte Loeschfaehigkeit als harmlos ausgeben.
  if (isStaticallyDestructive(tool, args) || (match && match.destructive)) return "destructive";
  if (match) return "not_destructive";
  return listed ? "not_destructive" : "unknown";
}

// A (2026-09-08): Liefert den vergangenen Session-Termin zurueck, wenn ein Build sonst blind
// OHNE Datum starten wuerde — d.h. die Session traegt ein vergangenes start_date UND das Modell
// hat im selben Zug KEIN eigenes Datum (start_date/start_offset_days) uebergeben. Sonst null.
// Der ausfuehren-Case beantwortet den Treffer mit einem Hinweis statt runSiteAbility zu rufen,
// damit der Kernel nicht mitten im Build abbricht. Hat das Modell ein eigenes Datum, gewinnt das
// wie immer (kein stale-Check).
export function staleSessionStartDate(funnelFacts, args) {
  // B1 (2026-09-08): Evergreen braucht KEIN Datum — der Kernel baut ihn sofort ohne Datumsfrage.
  // Ein Evergreen-Build darf deshalb nie stale-blockiert werden, auch wenn die Session ein
  // vergangenes start_date traegt (und die Datums-Injektion ohnehin schon deaktiviert ist).
  // Massgeblich ist der Typ: vom Modell in args ODER als Session-Fakt.
  const modelType = args && args.type;
  const factsType = funnelFacts && funnelFacts.type;
  if (modelType === "evergreen" || factsType === "evergreen") return null;
  const sessionStart = funnelFacts && funnelFacts.start_date;
  const modelDate = args && args.start_date;
  const modelOffset = args && args.start_offset_days;
  const modelSuppliedDate =
    (modelDate !== undefined && modelDate !== null && String(modelDate).trim() !== "") ||
    (modelOffset !== undefined && modelOffset !== null && String(modelOffset).trim() !== "");
  if (isPastDate(sessionStart) && !modelSuppliedDate) return sessionStart;
  return null;
}

let HOW_IT_WORKS = `# WebinarIgnition — how to build a webinar with this connector

WebinarIgnition is a WordPress plugin (since 2013) that runs live, scheduled and evergreen
webinars on the host's own site: registration page, confirmation and reminder emails,
countdown, live room with chat and call-to-action, replay and follow-up.
Product site: https://webinarignition.com/

${PRINCIPLES_FALLBACK}

## How to run the conversation

**HARD RULE — the first turn is always \`was="start"\`.** Whenever the host writes anything that is
not an answer to a question you just asked — a greeting ("hi", "hello", "hey"), a topic, a vague
statement, anything — call \`wi_webinar\` with \`was="start"\` immediately. NEVER answer with small talk
or "how can I help you", and NEVER write invitation texts yourself outside the tool. The host should
see tappable options on the very first turn, whether or not they know WebinarIgnition.

Do NOT open with "What is your goal?" — most people cannot answer that.
Open with what they are good at, and offer concrete choices, for example:

  "Tell me what you do best and I'll build the webinar around it.
   Or pick where you want to start:
     1. Just set up WebinarIgnition on my site
     2. Help me find a topic
     3. Write my invitation emails
     4. Plan the whole webinar from scratch"

Useful follow-ups once a topic exists — ask only what changes the outcome:
how many attendees, live or evergreen, do they already have a website and a list.

## One connector, one conversation

There is a single entry point and a single tool: **\`wi_webinar\`**. Call it with
\`was="start"\` first, and again every time the host changes direction. It tells you what
to do next and what else is on offer. \`was\` picks the step: \`start\` · \`thema\` ·
\`weiter\` · \`texte\` · \`stand\` · \`seite\` · \`technik\` · \`frage\` · \`status\`.

The four areas it routes between:

| focus | For someone who … |
|---|---|
| \`thema\` | knows what they are good at, but not what the webinar should be about |
| \`texte\` | has the topic, needs title / invitation / emails |
| \`technik\` | wants it installed and running on their WordPress site |
| \`fragen\` | just wants to know whether it can do X, or what it costs |
| \`alles\` | wants the whole thing, start to finish (default) |

**The host is never locked into an area.** If they are halfway through the technical
setup and suddenly want to change the topic, that is fine — call \`wi_webinar\` with
\`was="start"\` and \`focus: "thema"\` and carry on. Never tell them to start over.

**If they want only one area, respect it.** Someone who says "I only want the technical
setup" gets exactly that. Mention once that the rest exists, then drop it.

## Always ask with buttons, never with an empty field

Every tool that still needs something comes back with a **\`question\`** block: one question,
a handful of concrete answers, and a free-text escape. Put it in front of the host with
**your own multiple-choice UI** — in Claude that is AskUserQuestion — not as a numbered
list they have to type a reply to.

- The escape ("I'll say it myself") belongs in that UI's own free-text field. Only show
  \`free_text.label\` as a last option if your UI has no such field.
- **Never** answer "go ahead, I'm listening" and then wait. Asking and waiting are one step.
- Translate the question and the options into the host's language.
- Never invent extra options that the block did not contain.

## One tool

There is **wi_webinar**. A field \`was\` says what this call is about: \`start\` · \`thema\` ·
\`weiter\` · \`texte\` · \`stand\` · \`seite\` · \`technik\` · \`frage\` · \`status\`. Use this one for
everything — then the host grants permission once instead of nine times.

## The tool flow

1. \`wi_webinar was="thema"\` — first message from the host. Returns a **session_id**, a reply to
   show them, collected \`facts\`, ready-made \`options\` (offer these as choices) and
   \`ready\` (false until enough facts are collected).
2. \`wi_webinar was="weiter"\` — every further message, always with the same session_id. Keep
   going until \`ready\` is true. Show the \`options\` each turn so the host can just pick.
3. \`wi_webinar was="texte"\` — once \`ready\` is true, produces the finished texts
   (\`type\`: "invites" for title + invitation email, "starter" for a short starter set).
4. \`wi_webinar was="seite"\` — checks a WordPress address and answers with one finished next
   step: \`next_action\` and \`next_url\` say whether the host has to get WordPress, install
   WebinarIgnition, update it, or can connect right away. When \`ready_to_connect: true\`, go
   straight to \`was="verbinden"\` — not \`was="technik"\`. The AI never installs or updates
   WebinarIgnition — it assumes the host keeps the plugin current. Every link is handed to
   the host untouched; he clicks, he updates.
5. \`wi_webinar was="frage"\` — **any** question about the product: integrations
   ("how do my leads reach Mailchimp?"), webhooks, attendee limits, pricing, page
   builders, GDPR, video sources, or whether it fits at all. Call it instead of
   answering from memory — model memory about a plugin is usually out of date.
   These questions come up mid-conversation; answer them and carry on with the funnel.

## Rules

- Never invent facts about the host's offer, prices, dates, or scarcity
  ("only 10 seats left") unless the host said so.
- Start promoting as soon as the registration page stands with a date. The live room
  and the interactions (chat, countdown, call-to-action) do not have to be finished
  yet — people who register now already land on the stored list and get their
  confirmation email. Do not hold the promotion back until the whole room is built.
- Write in the host's language. The texts are for real attendees, not for a demo.
- If WebinarIgnition is genuinely not the right tool for their case, say so plainly.
- Flexible channels (Tobias 26.08.2026): invite_type is limited to the built-in enum, but the
  host may name any channel or format (Twitter/X, a guest post, "other" with their own entry).
  Do NOT block that and do NOT fall back to the email list too quickly. Map it by sense: a
  chat/messenger service → treat like WhatsApp; a social-feed platform (like Facebook) → treat
  like Facebook/Instagram; mail/newsletter → treat like the email list; a guest post/article →
  as its own longer text. If the format is unknown to you, look it up online to see what kind of
  thing it is, then offer the length as a concrete choice: "two lines + link" · "one short
  paragraph" · "two paragraphs" · "three paragraphs". If nothing is clear, a short punchy text
  with a link is enough. Pass the closest fitting invite_type value to the generator; only fall
  back to the email list when nothing else fits.

## Reading a source the host gives you

When the host names a source (a website, PDF or link), WebinarIgnition harvests it itself
and reports the result in the response as 'source_harvest':

- 'status: "done"' — WI already read it and the extracted facts are already filled into
  'facts'. This happens deliberately WITHOUT asking the host to confirm ("Sog statt
  Druck": fewer questions). The host still has priority: harvest only fills empty fields
  and never overwrites anything the host decided. Still show the facts as a proposal with
  the origin ("as I read it on your page") so the host can correct them. Never claim
  anything that is not on the page, never invent from memory.
- 'status: "failed"' or absent — WI could not read it. Then YOU read the source yourself
  and tell WebinarIgnition what you found, always citing where you read it ("as I read it
  on your page"), and let the host confirm. Never fill facts from memory.

## The title and the order — fixed

- **A decided title stays.** Once the host has chosen or confirmed the title, you do NOT
  change it and do NOT offer an alternative. It is their decision. Only before it is
  decided do you ask "does the title work?" and let them choose. Offer title ideas only
  once you have enough context (topic, audience, participant goal) and they ask for them.
- **The order is fixed:** (1) the title — and it stays decided; (2) the invitation texts,
  which the barometer measures; (3) the handover to WordPress/WebinarIgnition;
  (4) everything else — the email texts, the confirmation and reminder emails, the script —
  is generated IN THE PLUGIN, not on this page or in this chat. Here you produce only the
  title and the invitation texts, nothing more.

## After the texts: connect WordPress and hand over (the handoff flow, Tobias 2026-08-26)

Once the invitation texts are written (was="texte" done), the topic work is finished and it
is time to implement. Do not stop there. Say, in the host's language, the next step:
"Nächster Schritt wäre die Registrierungsseite in WebinarIgnition — sobald die mit Datum
steht, kann die Einladung schon raus." Then drive the connection one step at a time, always
ONE question per turn, never a wall of text:

1. Ask the WordPress address ALONE (one thing per turn, never a big text block).
2. Check it: call \`wi_webinar was="seite"\` with the URL. It answers with the finished next
   step — \`state\`, \`next_action\` and \`next_url\`. The chain is: check the address, install
   or activate WebinarIgnition (or update it if it is too old), then connect. The AI never
   installs or updates anything — it hands the address to the host and he keeps the plugin
   current. Hand \`next_url\` to the host unchanged; he clicks. When the answer is
   \`ready_to_connect: true\`, go straight to \`was="verbinden"\` — not \`was="technik"\`.
   Never invent the result — if nothing can be verified, say so honestly instead of guessing.
3. Ask the DATE and the TIMEZONE SEPARATELY, never bundled. 14 days is the normal default:
   propose a concrete date about 14 days out and let the host move it earlier or later
   ("Sagen wir früher oder später, welcher Tag?"). Ask the participant timezone with the date
   (e.g. Europe/Berlin) — the host's own timezone may differ.
4. Recommend a start time for the audience: "Bei der Zielgruppe empfehle ich die Uhrzeit …".
5. "haben wir schon geklärt": never re-ask anything already in the collected facts or already
   answered — confirm it in one line and move on.
6. At the end, offer to connect WordPress / create a new one (a few minutes) / or hand the
   topic and the data over as a link carrying the data — the link is the fallback when the
   WordPress connection is not possible, so the host never retypes anything. Produce that
   link by calling \`wi_webinar was="handoff"\` with the session_id.

## Building it on the host's own site (since 26.08.2026)

WebinarIgnition **4.18.123 and newer** is its own sign-in server and its own connection
point. No extra connector plugin is needed. That means the campaign no longer has to be
built by hand — this conversation can build it.

1. \`wi_webinar was="verbinden"\` with \`session_id\` and the site \`url\`. It answers with a
   **\`connect_url\`**. Hand that to the host as a clickable link and say in ONE sentence
   what happens: they sign in on their own WordPress and press Allow. Nothing is granted
   before that, and their password never passes through here.
2. Wait for them. Then \`was="verbinden"\` again **without** url to see whether it worked.
   Do not poll in a loop — ask them. When it answers \`connected: true\`, do NOT stop at the
   confirmation and do NOT wait for the host to type anything. The answer already carries the
   site's \`abilities\` and a \`next\` instruction: say connected in ONE line in the host's
   language, then continue right where the conversation was — the technical implementation of
   the webinar they planned — and offer ONE concrete question with 2-4 options. That is the
   whole point of connecting: the work continues, the host never has to say "go on".
3. \`was="faehigkeiten"\` — ask the site what it can do. **Read it, do not assume.** A host
   on an older version has fewer abilities, and promising one that is not there is worse
   than saying so.
 4. \`was="ausfuehren"\` with \`tool\` and \`args\` — run one. Typical order:
    \`webinarignition_create_webinar\` (a draft, nobody sees it), then
    \`webinarignition_configure_webinar\`, and only at the very end
    \`webinarignition_master_switch\` to take it live. **Take the names from
    \`was="faehigkeiten"\`, never from memory** — the site publishes them with underscores,
    and a name invented from the documentation is a name that does not exist.

**Changing ONE existing text — never rebuild for it (hard, Tobias 2026-10-03).** When the host
points at text that already stands and wants it replaced, shortened, or one word changed, do NOT
call \`improve-webinar\` — that re-writes the whole webinar and destroys the wording he wanted to
keep (this is a real, measured failure: a host changed one line and every approved text came back
rewritten). The one-line route — take the ability names from \`was="faehigkeiten"\`:
1. \`webinarignition_replace_text\` with \`target:"journey_field"\` replaces a sentence in the
   webinar's own copy (landing text, sales copy, headlines, mail subjects and bodies) — pass
   \`find\` = the current sentence verbatim and \`value\` = the new wording, copied character for
   character (no comma/case fixes);
2. \`webinarignition_replace_text\` with \`target:"page_block"\` replaces ONE block on the page
   (\`find\` = the block's current visible text in full); on a shortcode-built page use
   \`target:"page_heading"\` for the visible heading. If a block is ambiguous the call refuses and
   lists the candidate paths — then edit one by path with
   \`webinarignition_reg_page_blocks\` + \`webinarignition_reg_page_edit\`.
Say in ONE line what will change, confirm from the tool's read-back, and STOP — no follow-up
\`improve\`. An INSERTION ("add a line") is a NEW block, never a replace of an existing one.

**After a build, present the links — never the dashboard.** \`create-webinar\` and
\`improve-webinar\` return the finished registration, thank-you, room and edit links in the
result (\`lp_url\` / \`ty_url\` / \`room_url\` / \`edit_url\`), and the connector hands them
back labeled in \`links\`. Put those in front of the host as clickable links right away, so
they have something to look at and to share — never send the host to navigate the dashboard
to find them. Then offer the tappable follow-up options from the \`question\` (view the
registration page, adjust reminder emails, set up video/studio, publish, set up the
call-to-action).

**The connect link is made here, from nothing but the address.** The AI builds the
\`connect_url\` itself from the address the host names — \`wpconnect.js\` registers its client
on the host's site via Dynamic Client Registration and builds the Authorize address with
PKCE. No per-customer directory entry and no previously stored address are needed: the host
names a WordPress address, and the link is ready.

**Before every ability marked \`writes: true\`, say in one sentence what will happen and let
the host confirm.** For anything marked \`destructive: true\`, or for \`master-switch\`, that
confirmation is not optional: attendees see a switch immediately, and a deleted webhook does
not come back.

**Never ask the host for their WordPress password.** There is no place to put one. If a site
is older than 4.18.123, say that plainly and offer the handover link instead.

If the connection drops ("not connected"), do not fight it — say it and offer a fresh link.
`;

// ── The orchestrator ──────────────────────────────────────────────────────
// One connector, one entry point. Whatever the host wants — a topic, the texts, the
// technical setup, or just a question — they stay in the same conversation and this
// decides what happens next. Nobody should ever have to leave and start over because
// they changed their mind halfway through.
const AREAS = {
  thema: {
    title: "Find a topic",
    for_whom: "You know what you are good at but not what the webinar should be about.",
    next: "wi_webinar was=\"thema\" — send what they are good at; offer the returned options as choices.",
    ask_key: "thema",
  },
  texte: {
    title: "Write the texts",
    for_whom: "The topic is settled; you need the title, invitation and emails.",
    next: "wi_webinar was=\"thema\" (or was=\"weiter\" if a session is open), then was=\"texte\" once ready = true. Once the texts stand, drive the WordPress-connection flow in the chat (see HOW_IT_WORKS 'After the texts'): ask the WordPress address and the date + timezone one at a time, never re-ask what is collected, then offer to connect / create / or hand over a link with the data as fallback.",
    ask_key: "texte",
  },
  technik: {
    title: "Set it up technically",
    for_whom: "You want WebinarIgnition running on a WordPress site — installed, connected, live.",
    next: "wi_webinar was=\"technik\" first — it works even if they have no site yet and writes down what the webinar needs. Then was=\"seite\" with their URL. Then CONNECT: was=\"verbinden\" with the URL returns a link the host opens in their browser to sign in and approve; after that was=\"faehigkeiten\" says what that site can do and was=\"ausfuehren\" does it. IMPORTANT since 26.08.2026: WebinarIgnition (4.18.123+) is its own sign-in server and its own connection point, so no extra connector plugin is needed. It offers eighteen abilities — create-webinar and configure-webinar build a real campaign, list-webinars and get-webinar read them, master-switch takes it live, and configure-daily and daily-status connect a Daily.co live room the same way configure-100ms and 100ms-status do for 100ms. Do NOT tell the host that campaigns must be created by hand; that was true until this version and is not any more. Creating one comes back after about one to two minutes with the finished registration page and its link — give that link to the host right away, so they have something to look at. The confirmation email is included; the four reminder and follow-up emails are written afterwards in the background, about a minute. Do NOT call create-webinar again and do not wait for those emails — to see whether they are done, call get-webinar and read emails_status / emails_note. The thank-you page is there immediately: it comes from the template in the webinar's language, it is not written.",
    ask_key: "technik",
  },
  fragen: {
    title: "Answer a question",
    for_whom: "Can it do X? What does it cost? Does it work with my email tool?",
    next: "wi_webinar was=\"frage\" with their exact wording.",
    ask_key: "fragen",
  },
  alles: {
    title: "Build the whole thing",
    for_whom: "Start to finish: topic, texts, and live on your site.",
    next: "wi_webinar was=\"thema\", then was=\"weiter\" until ready = true, then was=\"texte\", then was=\"seite\" for the setup.",
    ask_key: "alles",
  },
};

function guide(focus, situation, language) {
  const key = String(focus || "alles").toLowerCase();
  const area = AREAS[key] || AREAS.alles;
  const others = Object.entries(AREAS)
    .filter(([k]) => k !== key && k !== "alles")
    .map(([k, a]) => `${k} — ${a.title}`);

  const say_first = String(language || "de").toLowerCase().replace(/[-_].*$/, "") === "de"
    ? "WebinarIgnition ist jetzt mit dir verbunden — ich bin dein Webinar-Helfer. Zuerst finden wir dein Thema und schreiben alle Texte (Titel, Einladungen, Erinnerungen). Dein Webinar erstellen und auf deiner WordPress-Seite einrichten machen wir später — wenn du so weit bist."
    : "WebinarIgnition is now connected — I'm your webinar helper. First we find your topic and write all the texts (title, invitation, reminders). Building the webinar and putting it on your WordPress site comes later, when you are ready.";

  return {
    focus: key,
    doing_now: area.title,
    next_step: area.next,
    ...(situation ? { situation } : {}),
    question: ask(s(`${area.ask_key}_q`, language), o(`${area.ask_key}_o`, language), { language }),
    say_first,
    can_switch_to: others,
    rules_for_you: [
      "At the very first contact of a conversation (greeting, a connect request, a bare webinar wish): open by relaying the `say_first` field to the host, in the host's language, then show the start options right away. Never open with a technical explanation, never say the words MCP, connector or interface to the host, and do not repeat `say_first` later in the same conversation. And ANY TIME LATER the host mentions connecting, an MCP/connector, the address mcp.webinarignition.com or a 'connection problem': you are already connected by the mere presence of this tool — never show or describe a website, never claim a problem, never give a 'how to connect' explanation; call wi_webinar with was=\"start\" at once. Only when the host means connecting their OWN WordPress site (a website/WordPress address is named, or the setup step was reached) do you call was=\"seite\"/\"verbinden\" instead.",
      "NEVER claim that connecting lets the host manage or control their website or their webinars, and never say \"you can now access/manage your webinar site\". This connector helps to CREATE the webinar here in the chat (topic, texts, plan); setting it up on the host's own WordPress site is offered by the tool itself at the end of the flow.",
      "When the host hands control back — \"you answer\", \"you decide\", \"you know better\", \"just do it\", or only \"yes\"/\"ok\": do NOT lecture or answer from memory. Decide the most likely option or next content on the host's behalf, tell them in one short line what you assumed (\"I'm answering for you with … — correct me if you meant something else\"), then call wi_webinar with that answer as `text` (the appropriate step: weiter/thema/texte). A bare \"yes\" to a question the tool asked is forwarded as a confirmation (weiter with text=\"yes\"), never an excuse for your own explanations.",
      "Put the `question` above in front of the host with your own multiple-choice UI — see its `how_to_show`. Never turn it into a numbered list they have to type a reply to.",
      "Do not ask 'what is your goal?' — most people cannot answer it. Ask what they are good at, and offer concrete choices.",
      "The host may change direction at any time. If they do, call wi_webinar with was=\"start\" and the new focus — never make them start over, and never say a flow is finished when they want something else.",
      "If they only want one area (for example: only the technical setup), stay in it. Mention once that the other areas exist, then LEAVE IT — measured 24.08.2026: a host said 'I only want the technical setup, nothing else' and was pushed back to topic-finding and copywriting anyway. That is the moment someone closes the tab. Concretely, with focus technik: do NOT call wi_webinar with was=\"thema\" or was=\"weiter\", do NOT suggest a topic, do NOT offer to write texts. Ask what is missing on the site and fix that.",
      "NEVER assume where someone is. Do not take a timezone from the WordPress setting, from the language, or from a guess — a host in Panama was told to set his site to Berlin. Ask two things before any date: where are YOU, and where do your participants sit. Then pass the IANA zone (e.g. America/Panama) with the campaign; WebinarIgnition carries it.",
      "Two WebinarIgnition folders on one site are NORMAL, not a fault: webinar-ignition is the free build, webinarignition-premium the paid one, and many sites run both. Never advise deleting one — the free copy is what counts wordpress.org installs.",
      "Bewerben darf schon, sobald die Registrierungsseite mit Datum steht — der Webinarraum und die Interaktionen (Chat, Countdown, Call-to-Action) muessen dafuer noch nicht fertig sein. Wer sich jetzt anmeldet, landet schon in der gespeicherten Liste und bekommt seine Bestaetigungsmail. Halte die Bewerbung nicht zurueck, bis der ganze Raum steht.",
      "After the texts are written, drive the WordPress-connection flow IN THE CHAT (Tobias 2026-08-26): say 'Nächster Schritt wäre die Registrierungsseite in WebinarIgnition — sobald die mit Datum steht, kann die Einladung schon raus.', then ask the WordPress address EINZELN (one thing per turn, never a text block). When the host names it, call wi_webinar was=\"seite\" with the URL to check it. Then ask DATE and TIMEZONE SEPARATELY: 14 days is the normal default (propose a concrete date ~14 days out, adjustable earlier/later), ask the participant timezone (e.g. Europe/Berlin) with the date, and recommend a start time for the audience ('Bei der Zielgruppe empfehle ich die Uhrzeit …').",
      "'haben wir schon geklärt': never re-ask anything already in the collected facts or already answered — confirm it in one line and move on. At the end offer to connect WordPress / create a new one / or hand the topic and data over as a link with the data (the fallback when the WordPress connection is not possible, so nothing is retyped). Produce that link with wi_webinar was=\"handoff\" (session_id) — do NOT promise a link you cannot produce.",
      "Ask only what changes the outcome. Everything else can be filled in later.",
    ],
  };
}

/**
 * The funnel answer, with the question turned into something tappable.
 *
 * The relay already writes good answers into `options` — they just arrived as a flat list
 * that assistants printed as prose. Here they become a `question` block, and the relay's
 * own escape chip ("Hab ich unten geschrieben", worded for the web page) is dropped from
 * the list: `ask()` filters it out and puts a free-text field in its place.
 *
 * When the relay asks nothing back — which is exactly the moment it says "ready" — the
 * host would otherwise be left with an open question. So that moment gets its own.
 */
function withQuestion(r) {
  const language = r.language || "de";
  const question = askFromFunnel(r, language);
  if (question) return { ...r, options: question.options, question };

  if (r.ready) {
    // SOFORT (Tobias 2026-09-10): Der Assistent hat die Texte gerade angekuendigt — nicht den
    // Host fragen, sondern den Client anweisen, die Texte JETZT zu schreiben (Kanal aus den
    // Fakten). Die fruehere ready_q-Frage ("soll ich schreiben?") entfaellt bewusst.
    return { ...r, next_step: "You have just announced the texts and the facts are complete. Call was=\"texte\" NOW with this session_id — do NOT ask the host another question first." };
  }
  return r;
}

/** After looking at a site, there is always exactly one sensible next question. */
function assessQuestion(r, language) {
  // ZUERST der ehrliche Fall (Prueferbefund 2026-09-11, M1; eigener Zustand 2026-09-12, N2):
  // die Adresse nennt einen WordPress-Pfad, die Seite war von aussen aber NICHT lesbar
  // (Bot-/WAF-Schranke, Wartung, abgeschaltete REST-Schnittstelle). Dann ist NICHTS belegt —
  // weder has_wp noch has_wi. Der Zustand ist `wp_unreadable`, nicht `no_wp`: "kein WordPress"
  // waere eine Behauptung, die wir nicht haben.
  if (r.state === "wp_unreadable") {
    return ask(s("assess_unreadable_q", language), o("assess_unreadable_o", language), { language });
  }
  if (r.needs_wp) {
    return ask(s("assess_wp_q", language), o("assess_wp_o", language), { language });
  }
  if (r.state === "wi_too_old") {
    return ask(s("assess_update_q", language), o("assess_update_o", language), { language });
  }
  if (r.needs_wi) {
    return ask(s("assess_wi_q", language), o("assess_wi_o", language), { language });
  }
  return ask(s("assess_installed_q", language), o("assess_installed_o", language), { language });
}

/** The setup plan always has a first open link in the chain — ask about that one. */
function planQuestion({ has_wordpress, has_wi, has_mcp }, language) {
  if (!has_wordpress) {
    return ask(s("plan_wp_q", language), o("plan_wp_o", language), { language });
  }
  if (!has_wi) {
    return ask(s("plan_wi_q", language), o("plan_wi_o", language), { language });
  }
  if (!has_mcp) {
    return ask(s("plan_mcp_q", language), o("plan_mcp_o", language), { language });
  }
  return ask(s("plan_all_q", language), o("plan_all_o", language), { language });
}

/**
 * After assessing a site, hand the host exactly one finished next step.
 *
 * The AI never installs or updates WebinarIgnition — we assume the host keeps the plugin
 * current. The OAuth access covers only WebinarIgnition's own route, not WordPress' plugin
 * screen — and until WebinarIgnition exists there is no access at all. So every link here is
 * handed to the host untouched; the host clicks and updates, not the AI. Never claim
 * otherwise.
 *
 * next_url is empty only for "connect": that link is produced by was="verbinden" on the
 * actual site, not here. next_url_alt exists where a fallback link makes sense (install).
 */
function nextStepFor(r) {
  const base = r.checked_url || "";
  // WP-Struktur-Hinweis (Tobias 2026-09-11; eigener Zustand 2026-09-12, N2): die Adresse
  // nennt selbst einen WordPress-Pfad (/wp, /wp-admin …), aber von aussen war die Seite nicht
  // lesbar — eine Bot-/WAF-Schranke oder Wartung sieht genau so aus. Dann NICHT "hol dir
  // WordPress" sagen, sondern direkt verbinden; die Adresse inkl. Unterordner bleibt erhalten
  // (kein zweiter Erkennungsweg). Der Zustand heisst `wp_unreadable` und traegt den
  // `ready_to_connect:true`-Fall eindeutig; `state:"no_wp"` behauptet das Gegenteil und kommt
  // hier bewusst nicht mehr vor.
  //
  // Die ehrliche Bremse (Prueferbefund 2026-09-11, M2) bleibt: nur dieser Zweig hat es auf true.
  // Eine private/interne Adresse (`10.0.0.5/wp`) oder ein DNS-Fehler setzt ihn NIE — dort bleibt
  // die "nicht prüfbar"-Antwort stehen, statt einen Verbindungs-Link auf etwas Unerreichbares zu
  // bauen.
  if (r.state === "wp_unreadable") {
    return {
      next_action: "connect",
      outbound_registered: Boolean(r.outbound_registered),
      instruction:
        `Die Adresse ${base} nennt einen WordPress-Pfad, war von außen aber nicht lesbar (Bot-/WAF-Schranke, Wartung oder abgeschaltete REST-Schnittstelle sieht genau so aus). Sage dem Gastgeber NICHT, dass dort kein WordPress ist. Gehe direkt zum Verbinden (was="verbinden") mit genau dieser Adresse — inklusive Unterordner, nichts davon wegschneiden. ` +
        (r.outbound_registered
          ? "Diese Seite hat ihren outbound-Kanal bereits eingerichtet: was=\"verbinden\" verbindet dann ohne jeden eingehenden Aufruf; danach was=\"faehigkeiten\" und was=\"ausfuehren\" normal nutzen."
          : "Ist die Seite hinter einer Bot-Schranke, braucht sie ihren outbound-Kanal: der Gastgeber öffnet in wp-admin den Punkt WebinarIgnition → AI connection und klickt “Connect outbound”. Danach was=\"verbinden\" erneut aufrufen — dann läuft alles über den Kanal, ohne eingehenden Aufruf."),
    };
  }
  switch (r.state) {
    case "no_wp":
      return {
        next_action: "get_wordpress",
        next_url: "https://wordpress.com/",
        instruction: "Unter dieser Adresse war nichts prüfbar — das kann ein Tippfehler sein, eine abgeschaltete REST-Schnittstelle oder eine langsame Seite. Frag zuerst nach, ob die Adresse stimmt und ob dort WordPress läuft, und sage nicht, dass er kein WordPress hat. Den Link zu WordPress.com gibst du nur, wenn er sagt, dass er noch gar keine Seite hat.",
      };
    case "wp_without_wi":
      return {
        next_action: "install",
        // Der Fenster-Link, den Tobias benutzt. Der Rückfall (gefilterte Plugin-Liste) deckt
        // den Fall ab, dass WebinarIgnition installiert, aber deaktiviert ist: von außen
        // sehen wir nur aktive Plugins über die REST-Namensräume, daher sieht eine
        // deaktivierte Installation für uns exakt wie „gar nicht installiert" aus — der
        // zweite Link führt genau dann zum Ziel, der Gastgeber sieht seine gefilterte
        // Plugin-Liste und muss nur aktivieren statt neu installieren.
        next_url: `${base}/wp-admin/plugin-install.php?tab=plugin-information&plugin=webinar-ignition&TB_iframe=true&width=772&height=551`,
        next_url_alt: `${base}/wp-admin/plugins.php?s=webinarignition&plugin_status=all`,
        instruction: "Reiche dem Gastgeber den Installations-Link unverändert weiter — er kümmert sich selbst darum, dass WebinarIgnition installiert und aktuell ist; ist das Plugin nur installiert, aber deaktiviert, führt der zweite Link direkt zu seiner gefilterten Plugin-Liste, wo er es nur aktivieren muss. Von außen sehen wir nicht, welche von beiden zutrifft. Danach die Adresse erneut prüfen.",
      };
    case "wi_too_old":
      return {
        next_action: "update",
        // Die gefilterte Plugin-Liste landet direkt auf der WebinarIgnition-Zeile statt in
        // einer langen Liste. Kein next_url_alt: hier ist die eine Adresse das Ziel.
        next_url: `${base}/wp-admin/plugins.php?s=webinarignition&plugin_status=all`,
        instruction: "Reiche dem Gastgeber den Link zu seiner gefilterten Plugin-Liste weiter — er sorgt selbst dafür, dass WebinarIgnition auf dem neuesten Stand ist; die KI installiert und aktualisiert nichts. Meist hilft ein Update; ändert das nichts, ist die KI-Verbindung auf der Seite abgeschaltet. Danach die Adresse erneut prüfen.",
      };
    case "wi_ready":
      return {
        next_action: "connect",
        instruction: "Ruf als Nächstes wi_webinar was=\"verbinden\" mit dieser Adresse auf, um den fertigen Verbindungs-Link für den Gastgeber zu erzeugen.",
      };
    default:
      return { next_action: "connect", instruction: "Prüfe die Adresse erneut, dann verbinde." };
  }
}

/**
 * The finished answer about a site, shared by the tool (was="seite") and the REST route
 * (POST /api/assess/wp). One truth, two doors: whatever assessWp reports, plus the one
 * question that follows and the one finished next step.
 */
async function assessWpAnswer(url, language) {
  const r = await engine.assessWp(url);
  // Does this site already hold an outbound channel? Then "could not be read from outside"
  // is not the end of the road — the site can still be used, it just polls us.
  try {
    r.outbound_registered = outbound.hasSite(r.checked_url || url);
  } catch {
    r.outbound_registered = false;
  }
  r.question = assessQuestion(r, language);
  Object.assign(r, nextStepFor(r));
  return r;
}

// Server-level guidance (MCP `instructions`): HOW the assistant should behave.
// Deliberately separate from the tool descriptions, which only say WHAT the tool does.
export const SERVER_INSTRUCTIONS =
  "WebinarIgnition is the webinar builder for WordPress. Everything runs through the tool `wi_webinar`; " +
  "answer from this connector, never from memory, and never write invitation texts yourself outside the tool. " +
  "Answer in the user's language and never expose tool names, MCP or interface wording to the user.\n" +
  "- Open every new conversation by calling `wi_webinar` with was=\"start\" so the user sees tappable options — " +
  "never open with small talk or \"how can I help you\". Call was=\"start\" again whenever the user changes " +
  "direction or writes anything that is not an answer to a question you just asked.\n" +
  "- The user is already connected as soon as this tool is present. If they mention connecting, an MCP/connector, " +
  "mcp.webinarignition.com or a connection problem, do not explain connecting and do not describe a website — " +
  "call `wi_webinar` with was=\"start\". The only exception is connecting their OWN WordPress site: then they name a " +
  "WordPress address (or the flow has reached the site-setup step) and you use was=\"seite\"/\"verbinden\" rather than " +
  "was=\"start\".\n" +
  "- When a call returns ready=true, continue with was=\"texte\" in the same turn without asking anything else.\n" +
  "- Before anything marked writes=true or destructive=true, say in one sentence what will happen and let the user " +
  "confirm. Destructive abilities are never run through `wi_webinar`: ask what should be removed, wait for the " +
  "confirmation, then call `wi_webinar_delete` with the same session_id, tool and args.\n" +
  "- Drive the WordPress setup step by step: ask for the WordPress address and the date + timezone one at a time, " +
  "never re-ask what the session already holds.";

export function registerAll(server) {
  // ── Tools ─────────────────────────────────────────────────────────────
  // ── Ein Werkzeug für alles ───────────────────────────────────────────────
  //
  // Neun Werkzeuge hiessen neun Berechtigungsfragen. Gemessen am 24.08.2026: ein Gastgeber
  // wurde mitten im Gespraech viermal gefragt, ob Claude dieses oder jenes benutzen darf —
  // "Ziel einmal berechtigen sollte fuer alles reichen" (Tobias). Wieviele Fragen kommen,
  // entscheidet der Client; WIE VIELE WERKZEUGE er sieht, entscheiden wir.
  //
  // Also: eines. `was` sagt, worum es geht, der Rest laeuft innen weiter — dieselben
  // Funktionen, dieselben Antworten. Die neun einzelnen wurden am 26.08.2026 geschlossen
  // (keine Nutzer installiert): nur dieses eine Werkzeug wird registriert, eine einzige
  // Berechtigungsfrage fuer den Gastgeber.
  server.registerTool("wi_webinar", {
    title: "WebinarIgnition",
    description:
    "Plan, write and set up a webinar from a chat, and answer questions about WebinarIgnition. " +
    "It picks a topic, produces the title, the invitation emails, the reminders and the registration page, and " +
    "prepares the live, automated or evergreen room on the user's own WordPress site. Needs no sign-in. Returns JSON.\n" +
    "`was` selects the step:\n" +
    "• start — entry point; returns a question with tappable options.\n" +
    "• thema — starts a conversation from the user's text; needs `text`.\n" +
    "• weiter — continues a conversation; needs `session_id` and `text`. A result with ready=true means the texts can be written next with was=texte.\n" +
    "• texte — writes the finished texts for a ready session; needs `session_id`. Optional: `job_id` to poll a running job, `direction` for an angle, `skip_direction`, `invite_type` (list, personal, facebook, whatsapp, instagram, linkedin, telegram, youtube), or type=\"custom\" with `custom_channel` for any other channel.\n" +
    "• stand — returns what the session has collected so far; needs `session_id`.\n" +
    "• seite — checks a WordPress address for WebinarIgnition; needs `url`; returns state, next_action and next_url.\n" +
    "• verbinden — connects the chat to the user's own WordPress; the first call needs `session_id` and `url` and returns a connect_url that the user opens in their own browser; a later call without `url` reports whether it went through.\n" +
    "• faehigkeiten — lists the abilities of the connected site; needs `session_id`.\n" +
    "• ausfuehren — runs one ability on the connected site; needs `session_id`, `tool` and `args`. Destructive abilities are not run here; the answer points to wi_webinar_delete.\n" +
    "• trennen — drops the connection; needs `session_id`.\n" +
    "• handoff — returns a handover link carrying the collected data; needs `session_id` (or `known_facts`/`content`), optional `url`.\n" +
    "• technik — returns the setup plan without a connected site.\n" +
    "• frage — answers a product question (prices, limits, integrations); needs `text`.\n" +
    "• status — technical state of the connector.\n" +
    "Returns { error, message } when a required field is missing, and { question } when the user has choices to make.",
    inputSchema: {
      was: z.enum(["start", "thema", "weiter", "texte", "stand", "seite", "verbinden", "faehigkeiten", "ausfuehren", "trennen", "handoff", "technik", "frage", "status"])
        .describe("Which step to run."),
      tool: z.string().optional().describe("Only with was=ausfuehren: the ability name exactly as was=faehigkeiten reported it, e.g. webinarignition_create_webinar. Slashes and hyphens are accepted too, but the site publishes underscores."),
      args: z.record(z.any()).optional().describe("Only with was=ausfuehren: the arguments for that ability, shaped by its input_schema."),
      text: z.string().optional().describe("What the host said (thema · weiter) or the question in the host's language (frage)."),
      session_id: z.string().optional().describe("From an earlier turn (weiter · texte · stand)."),
      job_id: z.string().optional().describe("Only with was=texte: the job number from an earlier call, to check whether the texts are ready. Without job_id a new job is started; only one text job runs at a time."),
      url: z.string().optional().describe("The WordPress address (seite). With was=handoff: the host's WordPress address to point the handover link at."),
      content: z.string().optional().describe("Only with was=handoff: finished text to carry over, if the session alone does not hold it."),
      rating: z.number().int().optional().describe("Only with was=handoff: the host's rating (1-10), if any."),
      language: z.string().optional().default("de").describe("The language the host writes in."),
      known_facts: z.record(z.any()).optional().describe("Everything you already know — send it every turn so nothing is lost on a restart."),
      focus: z.enum(["thema", "texte", "technik", "fragen", "alles"]).optional().describe("Only with was=start: what it should be about."),
      situation: z.string().optional().describe("Only with was=start: what the host just said."),
      type: z.string().optional().describe("Only with was=texte: invites (default), starter, or custom. custom = the invitation is for a channel that is NOT one of the eight built-in platforms — pass the channel name in custom_channel. A channel outside the eight built-ins is written as custom, not as one of the eight."),
      custom_channel: z.string().optional().describe("Only with was=texte and type=\"custom\": the exact name of the channel or format the invitation is for when it is not one of the eight built-in platforms — e.g. Xing, WeChat, Line, KakaoTalk, Viber, Threads, Mastodon, a guest article, or the host's own format. The text is then written for exactly this channel, not for a built-in platform."),
      invite_type: z.enum(["list", "personal", "facebook", "whatsapp", "instagram", "linkedin", "telegram", "youtube"]).optional().describe("Only with was=texte, when the invitation is for a specific platform: list = email list, personal = personal message, facebook = Facebook post, whatsapp = WhatsApp status, instagram = Instagram post, linkedin = LinkedIn post, telegram = Telegram channel, youtube = YouTube post."),
      direction: z.string().optional().describe("Optional with was=texte: the angle/framing of the invitation (natural language), e.g. 'Zeitersparnis und Skalierung ohne neue Mitarbeiter' for an agency. If missing, the invitation is written at once without a special angle."),
      skip_direction: z.boolean().optional().describe("Only with was=texte: true when the host wants NO special angle — then it generates without an angle."),
      has_wordpress: z.boolean().optional().describe("Only with was=start: true when the host already has a WordPress site."),
      has_wi: z.boolean().optional().describe("Only with was=start: true when WebinarIgnition is already installed on the host's site."),
      has_mcp: z.boolean().optional().describe("Only with was=start: true when the host already uses an MCP/connector — the connector normally sets this itself."),
      wants: z.array(z.string()).optional().describe('Only with was=start: what the host wants, as short keywords (e.g. "thema", "texte", "technik").'),
    },
    outputSchema: z.object({ result: z.unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
      const J = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: { result: o } });
      const need = (k) => J({ error: "missing", message: `was="${a.was}" braucht ${k}. Frag den Host danach oder nimm was="start".` });
      try {
        switch (a.was) {
          case "start":
            return J(guide(a.focus || "alles", a.situation, a.language));
          case "thema":
            if (!a.text) return need("text");
            return J(withQuestion(await engine.funnelStart(a.text, a.language, "own")));
          case "weiter":
            if (!a.session_id || !a.text) return need("session_id und text");
            return J(withQuestion(await engine.funnelChat(a.session_id, a.text, a.known_facts)));
          case "texte": {
            if (!a.session_id) return need("session_id");
            // Mit job_id: nachfragen, ob der Auftrag fertig ist. Ohne: neuen aufgeben.
            if (a.job_id) return J(await engine.generateStatus(a.session_id, a.job_id));
            // SOFORT (Tobias 2026-09-10): Der Kanal steht schon in den gesammelten Fakten
            // (facts.channel) — dann ohne Plattform- und ohne Winkel-Frage direkt schreiben.
            // Nur wenn kein Kanal bekannt ist, nachfragen (bisheriger Weg).
            const allowed = ["list", "personal", "facebook", "whatsapp", "instagram", "linkedin", "telegram", "youtube"];
            const typeWantsCustom = String(a.type || "").toLowerCase().trim() === "custom";
            let inviteType = a.invite_type || "";
            let customChannel = String(a.custom_channel || "").trim();
            let factsChannel = "";
            try {
              const st = engine.funnelGet(a.session_id);
              const f = (st && st.facts) || {};
              if (!customChannel) customChannel = String(f.custom_channel || "").trim();
              factsChannel = f.channel ? String(f.channel).toLowerCase().trim() : "";
            } catch (e) { /* Session weg: Fakten kommen ggf. als known_facts */ }
            if (!customChannel && a.known_facts && typeof a.known_facts === "object") {
              customChannel = String(a.known_facts.custom_channel || "").trim();
            }
            // EIGENER KANAL ("Anderer Kanal", 2026-09-11): type="custom" mit Kanalnamen ODER
            // ein uebergebener/faktischer custom_channel. Nicht nach der Plattform fragen und
            // NICHT auf einen der acht Schluessel zwingen — direkt als type=custom mit
            // facts.custom_channel an das Plugin. Ohne Kanalnamen bleibt es beim bisherigen
            // Weg (facts.channel oder Plattform-Frage). Der invite_type-Enum bleibt unveraendert.
            if ((!inviteType || typeWantsCustom) && customChannel) {
              const dirC = a.skip_direction ? "" : String(a.direction || "");
              return J(await engine.funnelGenerate(a.session_id, "custom", a.known_facts, "", dirC, customChannel));
            }
            if (!inviteType && allowed.includes(factsChannel)) inviteType = factsChannel;
            if (!inviteType) {
              return J({
                session_id: a.session_id,
                question: ask(s("platform_q", a.language), o("platform_o", a.language), { language: a.language, note: "Nur bei was=texte ohne job_id, ohne invite_type und ohne bekannten Kanal: der Host waehlt zuerst die Plattform, dann generiert der Funnel den passenden Einladungstext." }),
                hint: "Nach der Antwort ruf was=texte erneut MIT invite_type auf, damit der Text für die gewählte Plattform geschrieben wird. Ist der genannte Kanal keiner der acht (z. B. Xing, WeChat, eigenes Format), ruf stattdessen was=texte mit type=\"custom\" und custom_channel=<Kanalname> auf.",
              });
            }
            // Kein Winkel-Zwischenschritt mehr: sofort schreiben. Ein ausdruecklich mitgegebener
            // direction wird weiterhin verwendet, skip_direction erzwingt "ohne Winkel".
            const dir = a.skip_direction ? "" : String(a.direction || "");
            return J(await engine.funnelGenerate(a.session_id, a.type || "invites", a.known_facts, inviteType, dir));
          }
          case "stand":
            if (!a.session_id) return need("session_id");
            return J(engine.funnelGet(a.session_id));
          case "seite":
            return J(await assessWpAnswer(a.url, a.language));
          case "verbinden": {
            if (!a.session_id) return need("session_id");
            // Ohne url: nur nachsehen, ob der Gastgeber inzwischen zugestimmt hat.
            if (!a.url) {
              const st = connectionStatus(a.session_id);
              if (!st.connected) {
                // Keine laufende Autorisierung fuer diese Session: das Modell hat was="verbinden"
                // gerufen, weil der Host "verbinde mich" sagte — die Chat-Verbindung besteht aber
                // laengst, und ohne eine echte WordPress-Adresse gibt es nichts zu verbinden.
                // (Beleg 07.09.2026: gpt-4o-mini erfand eine session_id, und die alte Antwort
                // "Frag, ob er den Link geoeffnet hat" fuehrte es tiefer in die falsche Welt.)
                if (!hasPendingConnect(a.session_id)) {
                  return J({
                    connected: false,
                    hint:
                      "MISUNDERSTANDING — the connection to this chat already exists: the host is connected by definition, there is no link to open and nothing to click Allow on. " +
                      "Do NOT show any website and do NOT invent a link. Tell the host in ONE sentence in their language that WebinarIgnition is connected, " +
                      "then call wi_webinar with was=\"start\" so they see the start options. " +
                      "Only if the host means connecting WebinarIgnition to their OWN WordPress site do you need its address first: call was=\"seite\" with the url, and only then was=\"verbinden\".",
                  });
                }
                return J({ connected: false, next: "Noch keine Zustimmung. Frag den Gastgeber, ob er den Link geoeffnet und auf Erlauben geklickt hat — oder ruf was=\"verbinden\" mit url erneut auf." });
              }
              // Weiter-Impuls (Tobias 2026-09-03): der Gastgeber hat gerade zugestimmt und
              // landet zurueck im Chat. Statt einer Bestaetigung ohne Folge holen wir die
              // Faehigkeiten der Seite gleich mit (lesend) und geben dem Modell den Auftrag,
              // genau an der Stelle weiterzumachen, an der das Gespraech stand — ohne dass
              // der Gastgeber "go" tippen muss. Schlaegt der Faehigkeiten-Abruf fehl, steht
              // die Verbindung trotzdem und der Gastgeber bekommt seinen Impuls.
              let abilities = null;
              try {
                const ab = await siteAbilities(a.session_id);
                abilities = {
                  count: ab.count,
                  // Die Beschreibung je Tool MITGEBEN (2026-10-02): sie wird von der Site
                  // geliefert und ist der Text, unter dem ein Verzeichnis (mcp.so, Glama)
                  // jedes Werkzeug einzeln auffindbar macht — und den die KI liest, bevor
                  // sie ein Werkzeug aufruft. Ohne sie stünde nur der Name da.
                  tools: ab.tools.map((t) => ({
                    name: t.name,
                    description: t.description || "",
                    writes: !!t.writes,
                    destructive: !!t.destructive,
                  })),
                };
              } catch {
                abilities = null;
              }
              return J({
                ...st,
                ...(abilities ? { abilities } : {}),
                next:
                  "Die Verbindung steht. Sag dem Gastgeber in SEINER Sprache in EINEM Satz, dass es geklappt hat. " +
                  "Dann mach SOFORT weiter, ohne dass er etwas tippen muss — ihr wart mitten im Gespraech. " +
                  "Die Faehigkeiten der Seite stehen in `abilities` oben. " +
                  "Biete EINE konkrete Frage mit 2-4 Optionen an, die genau dort weiterfuehrt, wo ihr aufgehoert habt: " +
                  "waren Thema/Texte fertig und die Registrierungsseite fehlte, ist der naechste Schritt, die Kampagne anzulegen " +
                  "(ausfuehren mit create-webinar) — erst in einem Satz ankündigen und den Gastgeber bestaetigen lassen. " +
                  "Wollte er nur die Technik pruefen, biete an, die Faehigkeiten zu zeigen oder die Seite zu pruefen. " +
                  "Kein neues Thema, keine Werbung — nur der Impuls, weiterzumachen.",
              });
            }
            const begun = await beginConnect(a.session_id, a.url, a.language);
            // Outbound: the site polls us, so there is no link to open and nothing to
            // approve in a browser. Say that plainly and go straight on to the abilities.
            if (begun && begun.outbound) {
              return J({
                ...begun,
                next:
                  "Die Seite ist über ihren outbound-Kanal verbunden — kein Link, kein Anmelden, kein Freigeben nötig. " +
                  "Sag dem Gastgeber in SEINER Sprache in EINEM Satz, dass die Verbindung steht. " +
                  "Ruf dann SOFORT was=\"faehigkeiten\" auf (dieselbe session_id), damit du weißt, was diese Seite kann, " +
                  "und mach genau dort weiter, wo ihr im Gespräch wart.",
              });
            }
            return J({
              ...begun,
              connected: false,
              instruction:
                "Gib dem Gastgeber die connect_url als anklickbaren Link und sag in EINEM Satz, was ihn erwartet: " +
                "er meldet sich auf seiner eigenen WordPress-Seite an und klickt auf Erlauben. " +
                "Es wird nichts freigegeben, bevor er das getan hat, und das Passwort sieht hier niemand. " +
                "Danach ruf was=\"verbinden\" OHNE url erneut auf, um zu pruefen, ob es geklappt hat. Warte auf ihn, statt zu pollen.",
            });
          }
          case "faehigkeiten":
            if (!a.session_id) return need("session_id");
            return J(await siteAbilities(a.session_id));
          case "ausfuehren":
            if (!a.session_id || !a.tool) return need("session_id und tool");
            {
              // Zerstoerendes Ziel? Dann NICHT hier ausfuehren (2026-09-24): dieses Werkzeug
              // traegt destructiveHint:false und muss auch so handeln. Umleitung an das eigene
              // Werkzeug wi_webinar_delete. NUR "destructive" blockiert hier: "unknown" (Liste
              // nicht lesbar/leer) laeuft weiter, sonst wuerde ein transienter tools/list-Fehler
              // JEDEN Aufruf blockieren, auch create-webinar. Die statische Untergrenze faengt
              // jedes bekannte Loeschen ohnehin ab, und runSiteAbility prueft die Existenz ohnehin.
              const cls = await classifyAbilityTarget(a.session_id, a.tool, a.args || {});
              if (cls === "destructive") {
                return J({
                  ok: false,
                  code: "destructive_tool",
                  tool: a.tool,
                  redirect: "wi_webinar_delete",
                  next: `"${a.tool}" is destructive — it deletes or replaces something and cannot be undone — so was="ausfuehren" does NOT run it. ` +
                    "Ask the host in one sentence in their language exactly what will be removed and wait for their confirmation, " +
                    "then call the separate tool wi_webinar_delete with the same session_id, this tool name and these args.",
                });
              }

              // B4+B9 (2026-08-30): Ein Build (create/improve-webinar) liefert die fertigen
              // Kampagnen-Links im `result` zurueck (edit_url/lp_url/ty_url/room_url/view_url).
              // Statt dem Host Dashboard-Anweisungen zu geben, haengen wir diese Links als
              // klickbare, in seiner Sprache beschriftete Links an das Ergebnis und bieten
              // klickbare Folgeoptionen an. Kein Dashboard-Rumlaufen.
              // B (2026-09-08): Beim create-webinar die im Gespraech gesammelten Fakten automatisch
              // 1:1 in leere Feldluecken injizieren. Session kann weg sein -> still durchreichen.
              // A (2026-09-08): Ein vergangener Session-Termin wird nicht blind ohne Datum gebaut.
              let mergedArgs = a.args || {};
              if (isCreateWebinarTool(a.tool)) {
                let funnelFacts = null;
                try {
                  const funnel = engine.funnelGet(a.session_id);
                  funnelFacts = (funnel && funnel.facts) || null;
                } catch (_e) {
                  // Session nicht mehr da -> Fakten nicht verfuegbar; unveraendert weiterreichen.
                }
                // A: Traegt die Session ein vergangenes start_date und uebergibt das Modell im
                // selben Zug KEIN eigenes Datum (start_date/start_offset_days), antwortet der
                // Connector mit einem Hinweis statt den Build zu starten — der Kernel wuerde
                // sonst mitten im Build abbrechen und nachfragen (genau der Abbruch, den wir
                // vermeiden). Das Modell fragt den Gastgeber EINMAL nach dem neuen Termin und
                // ruft create danach mit frischem start_date erneut auf. Hat das Modell bereits
                // ein eigenes Datum uebergeben, gewinnt das wie immer -> kein stale-Check.
                const stale = staleSessionStartDate(funnelFacts, a.args);
                if (stale) {
                  return J({
                    ok: false,
                    code: "stale_start_date",
                    next:
                      `Der gespeicherte Termin (${stale}) liegt in der Vergangenheit. ` +
                      "Frag den Gastgeber in seiner Sprache nach dem neuen Termin (14-Tage-Vorschlag wie gewohnt) " +
                      "und ruf create-webinar danach mit frischem start_date erneut auf.",
                  });
                }
                if (funnelFacts) {
                  mergedArgs = mergeCreateFacts(mergedArgs, funnelFacts);
                }
              }
              const res = await runSiteAbility(a.session_id, a.tool, mergedArgs);
              const rr = res && res.result && typeof res.result === "object" ? res.result : null;
              const linkOrder = [
                ["lp_url", "link_registration"],
                ["ty_url", "link_thank_you"],
                ["room_url", "link_room"],
                ["edit_url", "link_edit"],
              ];
              const links = rr ? linkOrder
                .filter(([k]) => rr[k])
                .map(([k, labelKey]) => ({ label: s(labelKey, a.language), url: rr[k] }))
                : [];
              if (res && res.ok && links.length) {
                return J({
                  ...res,
                  links,
                  question: ask(s("after_build_q", a.language), o("after_build_o", a.language), {
                    language: a.language,
                    note: "Die Kampagne steht: die Links oben dem Host als klickbare Links praesentieren und diese Folgeoptionen anbieten, statt ihn durch das Dashboard zu schicken.",
                  }),
                });
              }
              return J(res);
            }
          case "trennen":
            if (!a.session_id) return need("session_id");
            return J(disconnect(a.session_id));
          case "handoff":
            return J(await engine.issueHandoff({
              session_id: a.session_id,
              facts: a.known_facts,
              content: a.content,
              rating: a.rating,
              target_url: a.url,
            }));
          case "technik":
            return J({ ...techPlan(a), question: planQuestion(a, a.language) });
          case "frage": {
            if (!a.text) return need("text");
            // The verified product knowledge service is part of the hosted server and is
            // deliberately not shipped in this public source mirror. Answer honestly and
            // point at the hosted endpoint instead of guessing.
            return J({ found: false, hosted_only: true,
              message: "The verified product knowledge service is part of the hosted WebinarIgnition MCP server and is not included in this public source mirror. Ask the hosted endpoint https://mcp.webinarignition.com, or see https://webinarignition.com/ directly.",
              question: ask(s("frage_no_q", a.language), o("frage_no_o", a.language), { language: a.language }) });
          }
          case "status":
            return J(engine.getConfig());
          default:
            return J(guide("alles", a.situation, a.language));
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Das zerstoerende Werkzeug (Tobias 2026-09-24) ─────────────────────────
  // Zweites Werkzeug, gleicher Weg (runSiteAbility/resolveToolName), nur die Pruefung trennt:
  // hier laeuft AUSSCHLIESSLICH ein zerstoerendes Ziel durch. Jetzt traegt genau dieses
  // Werkzeug destructiveHint:true — die Annotation luegt an keiner Stelle mehr, und
  // create-webinar/send-test-webhook bleiben ausdruecklich NICHT zerstoerend.
  server.registerTool("wi_webinar_delete", {
    title: "WebinarIgnition — delete",
    description:
    "Delete or replace something on the connected WordPress site — irreversible. Runs only an ability that is " +
    "verified as destructive: delete a campaign, a webhook, registrants (single or all), the logs, the attendee " +
    "questions, or the HC import that replaces a campaign. Writes abilities are not run here; use wi_webinar with " +
    "was=\"ausfuehren\" for those. Needs `session_id` and `tool`, optional `args`. Returns JSON.",
    inputSchema: {
      session_id: z.string().describe("The conversation id from an earlier turn — the session whose WordPress site is connected."),
      tool: z.string().describe("The destructive ability name exactly as was=\"faehigkeiten\" reported it, e.g. webinarignition_delete_campaign or webinarignition_delete_webhook. Slashes and hyphens are accepted too, but the site publishes underscores."),
      args: z.record(z.any()).optional().describe("The arguments for that ability, shaped by its input_schema."),
    },
    outputSchema: z.object({ result: z.unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
      const J = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: { result: o } });
      try {
        if (!a.session_id) return J({ error: "missing", message: 'wi_webinar_delete braucht session_id. Frag den Host danach oder nimm was="start".' });
        if (!a.tool) return J({ error: "missing", message: 'wi_webinar_delete braucht tool — den Namen so, wie was="faehigkeiten" ihn gemeldet hat.' });

        // Nur zerstoerende Ziele laufen hier durch. Ein nicht-zerstoerendes Ziel gehoert
        // ausdruecklich zum allgemeinen Werkzeug; ein unpruefbares wird sicherheitshalber abgelehnt.
        const cls = await classifyAbilityTarget(a.session_id, a.tool, a.args || {});
        if (cls === "not_destructive") {
          return J({
            ok: false,
            code: "not_destructive",
            tool: a.tool,
            next: `"${a.tool}" is not destructive, so this tool does NOT run it — it is only for irreversible deletions and replacements. ` +
              "Call wi_webinar with was=\"ausfuehren\" for it (same session_id, tool and args).",
          });
        }
        if (cls === "unknown") {
          return J({
            ok: false,
            code: "destructive_unverified",
            tool: a.tool,
            next: `Could not verify that "${a.tool}" is destructive (the connected site's ability list could not be read or came back empty), so this tool does NOT run it. ` +
              "Call wi_webinar with was=\"faehigkeiten\" to re-read the site's abilities, then try again.",
          });
        }
        return J(await runSiteAbility(a.session_id, a.tool, a.args || {}));
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── Prompts (starters the host can pick — no need to know what to type) ──
  server.prompt("build_my_webinar",
    "Build a complete webinar — topic, title, invitation emails and registration page.",
    { topic: z.string().optional().describe("What you do best, or the topic — leave empty and we will find one together.") },
    ({ topic }) => ({
      messages: [{ role: "user", content: { type: "text", text: topic
        ? `Build me a webinar about: ${topic}\n\nUse the WebinarIgnition tool. Call wi_webinar with was="thema" to begin, then keep the conversation going with was="weiter" until ready is true, then call wi_webinar with was="texte" to generate. Offer me the returned options as choices instead of asking open questions. Use wi_webinar for every step and never write the invitation texts yourself — the tool generates them.`
        : `I want to build a webinar with WebinarIgnition but I am not sure about the topic yet.\n\nDo not ask me what my goal is. Ask me what I am good at, and offer me concrete choices. Use wi_webinar with was="thema" to begin and follow the options it returns. Never write the texts yourself — call the tool for every step.` } }]
    })
  );
  server.prompt("find_my_topic",
    "Not sure what to talk about? Find a webinar topic your audience is already looking for.",
    () => ({
      messages: [{ role: "user", content: { type: "text", text:
        "Help me find a webinar topic. Ask me what I am good at and who I help — then use wi_webinar with was=\"thema\" and offer me the suggested topics it returns as concrete choices. Do not ask me open questions I cannot answer. Call wi_webinar for every step; never write texts yourself." } }]
    })
  );
  server.prompt("can_webinarignition_do_this",
    "Ask anything about WebinarIgnition — integrations, limits, pricing, or whether it fits what you need.",
    { question: z.string().describe("What you want to know, e.g. \"how do my registrations reach ActiveCampaign?\"") },
    ({ question }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `${question}\n\nAnswer using the wi_webinar tool of the WebinarIgnition connector with was="frage" — do not answer from memory. If the tool has no verified answer, say so plainly instead of guessing. Always call the tool, never answer from memory.` } }]
    })
  );
  server.prompt("write_my_invitation",
    "I already have a topic — write my invitation email and title.",
    { topic: z.string().describe("The topic of your webinar.") },
    ({ topic }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `I already know my webinar topic: ${topic}\n\nWrite my title and invitation email with WebinarIgnition. Use wi_webinar with was="thema" to begin, collect only the facts you really need with was="weiter", then call wi_webinar with was="texte" and type "invites". Use wi_webinar for every step and never write the texts yourself — the tool generates them.` } }]
    })
  );

  // ── Resource (context so the model knows the flow and the priorities) ───
  server.resource("Which interface to use", "webinarignition://interfaces",
    { title: "Which interface to use", description: "Which existing WordPress interface handles which job — and where an AI cannot edit (Elementor, Divi, Thrive).", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: INTERFACES }] })
  );
  server.resource("What WebinarIgnition solves", "webinarignition://capabilities",
    { title: "What WebinarIgnition solves", description: "Verified answers: integrations, webhooks, limits, licences, video sources, page builders, when it is not the right tool.", mimeType: "text/markdown" },
    // In the hosted server this resource is built from the live knowledge service. That
    // service is not part of this public source mirror, so this returns a fixed pointer.
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text:
      "# What WebinarIgnition solves\n\n" +
      "The verified product knowledge base is served by the hosted WebinarIgnition MCP server " +
      "and is not included in this public source mirror.\n\n" +
      "Use the hosted endpoint (https://mcp.webinarignition.com) or see https://webinarignition.com/." }] })
  );
  server.resource("How WebinarIgnition works", "webinarignition://how-it-works",
    { title: "How WebinarIgnition works", description: "What WebinarIgnition does, who you are building for, and how to run the conversation.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: HOW_IT_WORKS }] })
  );
}

const app = express();
// Behind Fly's proxy: without this, req.ip is the proxy and every X-Forwarded-For header is
// ignored. Set for the fingerprint's last fallback (see mcpClientIp) — the header path above it
// always wins, so a client cannot move its own fingerprint by sending its own X-F-F.
app.set("trust proxy", true);
// 4 MB, not the 100 kB default: the outbound channel posts the site's JSON-RPC replies back
// verbatim, and `tools/list` on a full WebinarIgnition install (every ability description and
// input schema) is well past 100 kB. Measured on 2026-09-13: a 100 kB cap turned that reply
// into PayloadTooLargeError and the tool call into a timeout.
app.use(express.json({ limit: "4mb" }));

// Brand / share assets (og:image). The icon is a 1200x1200 PNG (square, flame only, no text)
// preview in WhatsApp, LinkedIn and Facebook — the channels the invitations actually travel on.
// Served from the image path /assets/... that the head above points at. No auth: it is a public
// brand image; nothing here is user data.
app.use("/assets", express.static(join(__dirname, "..", "assets"), { maxAge: "7d" }));

const LANDING_HTML = `<!DOCTYPE html>
<html lang="{{WI_HTML_LANG}}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{WI_OG_TITLE}} | WebinarIgnition</title>
<!-- Search + share head. One source of truth for the wording is this block: search engines
     read description/canonical, chat apps and social feeds read og:*.
     WhatsApp (and every feed that follows the same rule) sends Accept-Language of the RECIPIENT
     and expects the page to answer in that language: "The request will also have the
     Accept-Language header set to the language selected by the recipient ... website owners can
     customize the content language accordingly." (Meta, WhatsApp Link Previews, 2026-10-01).
     That is why the title/description/alt below are placeholders, filled per request.
     og:url stays the clean canonical URL — Meta requires it "undecorated, without session
     variables", so the language NEVER goes into a query parameter.
     The og:image is a 1200x1200 brand icon (flame, no text) served by the /assets route below:
     a shared link always shows title + image, so text inside the image would appear twice. -->
<meta name="description" content="{{WI_OG_DESC}}">
<link rel="canonical" href="https://mcp.webinarignition.com/">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="WebinarIgnition">
{{WI_OG_LOCALE}}
<meta property="og:url" content="https://mcp.webinarignition.com/">
<meta property="og:title" content="{{WI_OG_TITLE}}">
<meta property="og:description" content="{{WI_OG_DESC}}">
<meta property="og:image" content="https://mcp.webinarignition.com/assets/wi-share-icon-xl-1200.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:image:alt" content="{{WI_OG_ALT}}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{{WI_OG_TITLE}}">
<meta name="twitter:description" content="{{WI_OG_DESC}}">
<meta name="twitter:image" content="https://mcp.webinarignition.com/assets/wi-share-icon-xl-1200.png">
{{WI_JSONLD}}
<style>
:root{--green:#5fa426;--ink:#1d2419;--muted:#5c6657;--line:#e3e7de;--soft:#f6f8f4}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:var(--ink);line-height:1.65;background:#fff;-webkit-font-smoothing:antialiased}
.wrap{max-width:660px;margin:0 auto;padding:0 22px}
header{padding:34px 0 6px}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink);font-weight:600;font-size:15px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--green);display:inline-block}
h1{font-size:31px;line-height:1.25;margin:26px 0 14px;letter-spacing:-.4px}
h2{font-size:17px;margin:38px 0 12px;letter-spacing:-.2px}
.lead{font-size:18px;color:var(--muted);margin:0 0 26px}
.cta{display:inline-block;background:var(--green);color:#fff;text-decoration:none;font-weight:600;
padding:13px 24px;border-radius:8px;margin:4px 10px 4px 0}
.cta:hover{background:#4f8c1f}
.cta-2{display:inline-block;color:var(--green);text-decoration:none;font-weight:600;padding:13px 4px}
.cta-2:hover{text-decoration:underline}
ul{padding-left:0;list-style:none;margin:0}
li{padding:13px 0;border-bottom:1px solid var(--line)}
li b{display:block;font-size:15px}
li span{color:var(--muted);font-size:15px}
.card{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:6px 20px;margin:14px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:4px 16px;padding:13px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .k{flex:0 0 110px;color:var(--muted);font-size:14px}
.row .v{flex:1;min-width:200px;font-size:15px;word-break:break-all}
code{background:#fff;border:1px solid var(--line);padding:2px 7px;border-radius:5px;font-size:14px}
.note{color:var(--muted);font-size:15px;margin:14px 0 0}
details{border-bottom:1px solid var(--line);padding:12px 0}
summary{cursor:pointer;font-weight:600;font-size:15px}
details p{margin:10px 0 2px;color:var(--muted);font-size:15px}
.faq{margin:30px 0 0}
.faq h2{margin-top:0;font-size:17px}
footer{margin:46px 0 40px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
footer a{color:var(--muted)}
@media(max-width:520px){h1{font-size:26px}.lead{font-size:17px}.cta{display:block;text-align:center;margin-right:0}}
</style>
</head>
<body>
<div class="wrap">

<header>
  <a target="_blank" rel="noopener" class="brand" href="https://webinarignition.com/"><span class="dot"></span> WebinarIgnition</a>
</header>

<h1>Tell Tobias AI what you do best.<br>He builds your webinar.</h1>

<p class="lead">This is the connector that puts WebinarIgnition inside your AI assistant.
Talk about your idea in plain words — and get your title, your invitation emails and your
registration page written for you, ready to publish on your own WordPress site.</p>

<p>
  <a target="_blank" rel="noopener" class="cta" href="https://webinarignition.com/">See what WebinarIgnition does</a>
  <a target="_blank" rel="noopener" class="cta-2" href="https://webinarignition.com/ai-webinar-writer/">Try it on the web instead &rarr;</a>
</p>

<h2>What you can do from your chat</h2>
<ul>
  <li><b>Ask anything first</b><span>Does WebinarIgnition fit what you need, what it costs, which integrations it supports — before you install or buy anything.</span></li>
  <li><b>Find a topic that fills seats</b><span>Not sure what to talk about? Start anyway — Tobias asks the right questions and suggests topics your audience is already looking for.</span></li>
  <!-- "thank-you page" was in this list until 27.08.2026 and was not true: the AI writes the
       registration page, the confirmation email and the reminders, while the thank-you page
       comes from the template in the webinar's language. Promising a text nobody writes is the
       kind of sentence a host measures us by. Planned to become true — see THEMA-wi-mcp-oauth.md
       "Notiert für später: die Danke-Seite von der KI schreiben lassen". -->
  <li><b>Get every text written</b><span>Title, invitation email, reminders, replay follow-up. In your voice, in your language.</span></li>
  <li><b>Put it live on your WordPress</b><span>Registration page, countdown, live room and emails — set up on your own site. Your webinar, your domain, your list.</span></li>
</ul>
<p class="note">Try it: &ldquo;Does WebinarIgnition fit what I need?&rdquo; · &ldquo;Find a topic for my audience and write my webinar.&rdquo; · &ldquo;Set up my webinar on my WordPress site and move the date to next Tuesday.&rdquo;</p>

<h2>Add it to your AI — takes 30 seconds</h2>
<div class="card">
  <div class="row"><div class="k">Name</div><div class="v">Tobias AI — WebinarIgnition</div></div>
  <div class="row"><div class="k">URL</div><div class="v"><code>https://mcp.webinarignition.com</code></div></div>
  <div class="row"><div class="k">Sign-in</div><div class="v">None — nothing to set up</div></div>
</div>
<p class="note">In Claude: <b>Settings &rarr; Connectors &rarr; Add custom connector</b>. Paste the URL, leave everything
else as it is, save. Then open a new chat and write: <i>&ldquo;Build me a webinar for freelancers.&rdquo;</i><br>
Works the same in Cursor, Claude Code and any other assistant that speaks MCP.</p>

<!-- FAQ: genau hier — unter dem MCP-Steckbrief und damit unter der Adresse, die oben steht.
     Inhalt (Fragen + Antworten) kommt aus lib/i18n.js, in der Sprache des Lesers; Texte
     eingeklappt als <details>, damit die Seite trotzdem vollständig wirkt. -->
{{WI_FAQ}}

<h2>Who is Tobias?</h2>
<p class="note">WebinarIgnition has been running live, scheduled and evergreen webinars on WordPress
sites since 2013. <b>Tobias Conrad</b> has been building with WordPress since 2014, took the plugin
over in 2022, and has been developing it ever since. <b>Tobias AI</b> is trained on how he sets
webinars up for customers — so you get the same thinking without the wait.
<a target="_blank" rel="noopener" href="https://webinarignition.com/">Meet the plugin &rarr;</a></p>

<footer>
  <a target="_blank" rel="noopener" href="https://webinarignition.com/">webinarignition.com</a> ·
  <a target="_blank" rel="noopener" href="mailto:support@webinarignition.com">support@webinarignition.com</a> ·
  <a target="_blank" rel="noopener" href="https://webinarignition.com/privacy-policy/">Privacy Policy</a> ·
  <a target="_blank" rel="noopener" href="https://webinarignition.com/terms/">Terms</a> ·
  <a target="_blank" rel="noopener" href="https://webinarignition.com/imprint/">Imprint</a><br>
  <span style="opacity:.75">For developers: <a target="_blank" rel="noopener" href="/health">status</a> · <a target="_blank" rel="noopener" href="/openapi.json">OpenAPI schema</a> · <a target="_blank" rel="noopener" href="/.well-known/mcp/server-card.json">server card</a> · MCP over Streamable HTTP</span>
</footer>

</div>
</body>
</html>`;

// A client asking for an event stream on / wants MCP, not the landing page.
function wantsEventStream(req) {
  return String(req.headers.accept || "").includes("text/event-stream");
}

// ── Sprache des Lesers (2026-09-30) ────────────────────────────────────────────────────────
// Die Vorschau eines geteilten Links richtete sich nach der Seiten-Sprache (fest en_US), nicht
// nach dem Leser. Jetzt entscheidet Accept-Language: eine der 26 WI-Sprachen aus lib/i18n.js,
// unbekannt → en. Bei en fällt og:locale bewusst weg (WhatsApp/Facebook fallen selbst auf
// Englisch zurück). Der Kopf steht trotzdem nur EINMAL im Template — die drei sprachabhängigen
// Stellen (og:locale/hreflang, Struktur-Daten, FAQ) setzt landingPage() pro Anfrage ein.
const LANDING_URL = "https://mcp.webinarignition.com/";
const LANDING_IMAGE = "https://mcp.webinarignition.com/assets/wi-share-icon-xl-1200.png";

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON-LD einbetten; `</` entschärfen, damit kein Skript-Tag mitten im Datenblock endet. */
function jsonLd(data) {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/<\//g, "<\\/")}\n</script>`;
}

/** Der sprachabhängige Kopf-Teil: og:locale (+ alternate) und das hreflang-Netz. */
function landingHeadLang(lang) {
  const locale = ogLocale(lang);
  const lines = [];
  if (locale) lines.push(`<meta property="og:locale" content="${locale}">`);
  if (locale && locale !== "en_US") lines.push(`<meta property="og:locale:alternate" content="en_US">`);
  lines.push(...hreflangLinks(lang, LANDING_URL));
  return lines.join("\n");
}

/** Struktur-Daten: SoftwareApplication (was es ist) + FAQPage (was es beantwortet). */
function landingJsonLd(lang) {
  const app = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Tobias AI — WebinarIgnition connector",
    "description": "Tell Tobias AI what you are good at and he builds your evergreen webinar: title, invitation emails and registration page, ready for your WordPress site.",
    "applicationCategory": "BusinessApplication",
    "operatingSystem": "Any MCP-compatible AI assistant",
    "url": LANDING_URL,
    "image": LANDING_IMAGE,
    "screenshot": LANDING_IMAGE,
    "isAccessibleForFree": true,
    // Die 26 WI-Sprachen — auf den Sprach-Teil gekürzt und doppelte entfernt (de_DE_formal → de).
    "inLanguage": [...new Set(SUPPORTED.map(baseLanguage))],
    "featureList": [
      "Live webinars with date, countdown and chat",
      "Evergreen / automated webinars",
      "Registration page with countdown",
      "Invitation, confirmation, reminder and replay-follow-up emails",
      "Live room with chat and call-to-action",
      "Sell in the room or through WooCommerce",
      "Runs on your own WordPress site — no SaaS limits, no per-seat fees"
    ],
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD",
      "description": "Free — the connector is included, no sign-in needed."
    },
    "isPartOf": {
      "@type": "SoftwareApplication",
      "name": "WebinarIgnition",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "WordPress",
      "url": "https://webinarignition.com/"
    }
  };
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "inLanguage": baseLanguage(lang),
    "mainEntity": faqItems(lang).map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a }
    }))
  };
  return `${jsonLd(app)}\n${jsonLd(faq)}`;
}

/** Die FAQ sichtbar (eingeklappt) in der Sprache des Lesers — Text und Markup aus einer Quelle. */
function landingFaq(lang) {
  const body = faqItems(lang)
    .map(({ q, a }) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`)
    .join("\n");
  return `<section class="faq" lang="${baseLanguage(lang)}">
<h2>${esc(s("faq_heading", lang))}</h2>
${body}
</section>`;
}

/** Die sprachabhängigen Kopf-Texte für die Vorschau (og:title/description/alt + <html lang>). */
function landingCopy(lang) {
  return {
    title: s("og_title", lang),
    desc: s("og_desc", lang),
    alt: s("og_alt", lang),
  };
}

/** Eine Seite, alle sprachabhängigen Stellen. Der Rest steht genau einmal im Template. */
function landingPage(lang) {
  const copy = landingCopy(lang);
  return LANDING_HTML
    .replace("{{WI_HTML_LANG}}", () => baseLanguage(lang))
    .replace(/\{\{WI_OG_TITLE\}\}/g, () => esc(copy.title))
    .replace(/\{\{WI_OG_DESC\}\}/g, () => esc(copy.desc))
    .replace(/\{\{WI_OG_ALT\}\}/g, () => esc(copy.alt))
    .replace("{{WI_OG_LOCALE}}", () => landingHeadLang(lang))
    .replace("{{WI_JSONLD}}", () => landingJsonLd(lang))
    .replace("{{WI_FAQ}}", () => landingFaq(lang));
}

app.get("/", async (req, res, next) => {
  if (wantsEventStream(req)) return next();      // → MCP handler below
  // Dieselbe Adresse liefert je Sprache einen anderen Kopf — Caches müssen das wissen.
  res.set("Vary", "Accept-Language");
  res.type("html").send(landingPage(negotiateLanguage(req.headers["accept-language"])));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wi-mcp-server", protocol: "streamable-http",
    client_id: engine.config.client_id, consent: engine.config.consent_granted,
    api_base: engine.config.api_base, outbound_channels: outbound.size() });
});

/* ── OpenAI domain verification (2026-09-24) ─────────────────────────────
 *
 * The plugin submission portal checks that we control mcp.webinarignition.com by
 * fetching /.well-known/openai-apps-challenge. It must return EXACTLY the challenge
 * token — no JSON, no list, no extra text. The token is public, but it lives in an
 * env secret so it can be rotated without touching code. Without the env the route
 * answers 404 and nothing else changes.
 */
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  const token = String(process.env.OPENAI_APPS_CHALLENGE_TOKEN || "").trim();
  if (!token) return res.status(404).type("text/plain").send("not configured");
  res.set("Cache-Control", "no-store").type("text/plain").send(token);
});

/* ── Static MCP server card (2026-09-26) ─────────────────────────────────
 *
 * Fallback metadata for registries and directories that cannot scan the live
 * server (auth wall, WAF, bot protection). The live scan stays the source of
 * truth; this document only mirrors name/version and the public capability
 * names. It does NOT define or change the MCP tools — those are served over the
 * protocol below and remain the published definitions.
 */
app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.set("Cache-Control", "no-store").json({
    // Muss zur veroeffentlichten Registry-Version passen (server.json) — sonst zeigt die
    // Server-Card eine andere Nummer als die Registry und Verzeichnisse verwirren sich.
    serverInfo: { name: "WebinarIgnition", version: "1.0.6" },
    authentication: { required: false },
    tools: [
      { name: "wi_webinar", description: "71 AI tools for WordPress webinars across 11 areas (webinar, config, live control, Gutenberg registration pages, email, webhooks, leads, colors, autoresponder, settings, reports). 28 are read-only; 43 change something and 8 delete — nothing happens without the host's OK. Build the signup page, write invitation and reminder emails, open the live room, run live/automated/evergreen webinars, sell in the room with WooCommerce. Needs no sign-in." },
      { name: "wi_webinar_delete", description: "Delete or replace something on the connected WordPress site — irreversible." }
    ],
    prompts: [
      { name: "build_my_webinar" },
      { name: "find_my_topic" },
      { name: "can_webinarignition_do_this" },
      { name: "write_my_invitation" }
    ],
    resources: [
      { uri: "webinarignition://interfaces" },
      { uri: "webinarignition://capabilities" },
      { uri: "webinarignition://how-it-works" }
    ]
  });
});

/* ── Outbound channel ─────────────────────────────────────────────────────
 *
 * A site behind a bot wall cannot be called from here, so it calls us and polls. These
 * three routes are that conversation; the queue itself lives in lib/outbound.js. The token
 * is the only credential and is never logged — see the note at the top of that file.
 *
 * The token belongs in `Authorization: Bearer <token>`, never in a URL: URLs are kept by
 * proxies and logs. For one release the old query/body form is still accepted, so plugins
 * already deployed keep working; a channel is warned about once, without the token, so ops
 * can see who has not updated yet.
 *
 * Long-poll and Fly: a GET can sit here for up to ~50 s. Fly's proxy does not cut that,
 * and the plugin polls with its own timeout slightly above its requested wait.
 */

/** The bearer token from the Authorization header, or "" when there is none. */
function outboundBearer(req) {
  const raw = String(req.headers.authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : "";
}

/** Note once per channel that the legacy query/body token was used. Never the token itself. */
function outboundNoteLegacy(channel) {
  if (!channel || channel.legacy_token_warned) return;
  channel.legacy_token_warned = true;
  console.error(
    `[outbound] legacy token via query/body for ${channel.site}; update the plugin to send Authorization: Bearer`
  );
}

app.post("/outbound/register", (req, res) => {
  try {
    const out = outbound.register(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/outbound/poll", async (req, res) => {
  const headerToken = outboundBearer(req);
  const token = headerToken || String(req.query.token || "");
  const channel = outbound.auth(token);
  if (!channel) return res.status(401).json({ error: "Unknown outbound channel." });
  if (!headerToken) outboundNoteLegacy(channel);

  const requested = Number(req.query.wait);
  const wait = Number.isFinite(requested) ? requested : 25;
  const item = await outbound.poll(channel, wait, () => req.destroyed || res.headersSent);

  if (res.headersSent) return;
  if (!item) return res.status(204).end();
  res.json(item);
});

app.post("/outbound/result", (req, res) => {
  const body = req.body || {};
  const headerToken = outboundBearer(req);
  const token = headerToken || String(body.token || "");
  const channel = outbound.auth(token);
  if (!channel) return res.status(401).json({ error: "Unknown outbound channel." });
  if (!headerToken) outboundNoteLegacy(channel);

  const { id, result } = body;
  if (!id) return res.status(400).json({ error: "id is required" });

  const done = outbound.submitResult(channel, String(id), result);
  res.json({ ok: done.ok, unknown: Boolean(done.unknown) });
});

// ── OAuth / Auth discovery — no auth needed ──────────────────────────
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: "https://mcp.webinarignition.com",
    authorization_endpoint: "https://mcp.webinarignition.com/auth",
    token_endpoint: "https://mcp.webinarignition.com/auth/token",
    response_types_supported: ["none"],
    scopes_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// ── The host comes back here after approving on their own site ───────
//
// This is a page a real person looks at, in a browser, at the one moment where they have
// just handed over access and want to know whether it worked. So it says so in words, and
// it points back at the product instead of dead-ending in JSON. (AGENTS §15: every page a
// human sees is a touchpoint.)
// One language, on purpose. The sentences that land in `message` come from wpconnect.js
// and are English, like every other source string here; wrapping them in a German page
// produced exactly the half-translated result that reads as broken. The connector's
// landing page is English too, so this matches. Rendering it in the host's language means
// carrying that language through `state` and adding these strings to lib/i18n.js in all
// 23 languages — worth doing, but as one piece, not as one page in two.
function connectPage({ ok, site, message, language = "en" }) {
  const lang = String(language || "en");
  const langCode = lang.slice(0, 2).toLowerCase() || "en";
  const dir = langCode === "ur" ? ' dir="rtl"' : "";
  const title = ok ? s("connect_ok_title", lang) : s("connect_fail_title", lang);
  const body = ok
    ? `<p class="lead">${s("connect_ok_lead", lang).replace("{site}", `<b>${escapeHtml(site)}</b>`)}</p>
       <p class="lead">${s("connect_ok_action", lang)}</p>
       <p class="note">${s("connect_ok_note", lang)}</p>`
    : `<p class="lead">${escapeHtml(message || "The connection was not made.")}</p>
       <p class="note">${s("connect_fail_note", lang)}</p>`;

  return `<!DOCTYPE html><html lang="${escapeHtml(langCode)}"${dir}><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | WebinarIgnition</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:#1d2419;line-height:1.65;background:#fff}
.wrap{max-width:560px;margin:0 auto;padding:60px 22px}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:#1d2419;font-weight:600;font-size:15px}
.dot{width:11px;height:11px;border-radius:50%;background:${ok ? "#5fa426" : "#c0392b"};display:inline-block}
h1{font-size:28px;line-height:1.25;margin:26px 0 14px;letter-spacing:-.4px}
.lead{font-size:18px;color:#5c6657;margin:0 0 22px}
.note{color:#5c6657;font-size:15px}
footer{margin:44px 0 0;padding-top:18px;border-top:1px solid #e3e7de;color:#5c6657;font-size:14px}
footer a{color:#5c6657}
</style></head><body><div class="wrap">
<a class="brand" href="https://webinarignition.com/"><span class="dot"></span> WebinarIgnition</a>
<h1>${escapeHtml(title)}</h1>
${body}
<footer><a href="https://webinarignition.com/">webinarignition.com</a> ·
<a href="mailto:support@webinarignition.com">support@webinarignition.com</a></footer>
</div><script>try{window.close();}catch(e){}</script></body></html>`;
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** First language tag from the browser's Accept-Language header (keeps region, e.g. "es-MX"), or "en". */
function detectLang(req) {
  const header = String(req.headers["accept-language"] || "");
  const m = header.match(/[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?/);
  return m ? m[0] : "en";
}

app.get("/connect/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query || {};

  if (error) {
    // The host pressed Deny, or their site refused. Not a fault — just say it.
    return res.status(200).type("html").send(connectPage({
      ok: false,
      message: String(error_description || "Der Zugang wurde nicht erteilt."),
      language: detectLang(req),
    }));
  }

  try {
    const done = await completeConnect(String(code || ""), String(state || ""));
    console.error(`[connect] ok site=${done.site}`);
    res.type("html").send(connectPage({ ok: true, site: done.site, language: done.language || detectLang(req) }));
  } catch (e) {
    // Never echo the query back into the page — a code or state in the HTML is a code or
    // state in the browser history and in every screenshot of it.
    console.error(`[connect] failed: ${e.message}`);
    res.status(400).type("html").send(connectPage({ ok: false, message: e.message, language: detectLang(req) }));
  }
});

const openApiPath = join(__dirname, "openapi.json");
if (existsSync(openApiPath)) {
  app.get("/openapi.json", (_req, res) => res.type("json").send(readFileSync(openApiPath, "utf8")));
}

/* ── README als Datei ausliefern (2026-10-02) ────────────────────────────────
 *
 * Grund (gemessen): mcp.so füllt den Abschnitt „Tools" NICHT aus dem MCP-Handshake,
 * sondern „we auto-extract tools from the README" — und erwartet dort die Überschrift
 * `## Tools`. Unser Eintrag zeigte deshalb „No tools detected".
 *
 * Wir haben kein öffentliches GitHub-Repo; also liefert der Server sein README selbst aus
 * und das Verzeichnis kann es unter „Docs URL" abholen. Dieselbe Datei wie im Repository
 * (README.md im Server-Ordner) — keine zweite Fassung, die auseinanderlaufen könnte.
 */
const readmePath = join(__dirname, "..", "README.md");
if (existsSync(readmePath)) {
  app.get("/README.md", (_req, res) => res.type("text/markdown").send(readFileSync(readmePath, "utf8")));
  // Manche Verzeichnisse probieren die kleingeschriebene Form oder /readme.
  app.get("/readme.md", (_req, res) => res.redirect(301, "/README.md"));
  app.get("/readme", (_req, res) => res.redirect(301, "/README.md"));
}

// ── MCP: fresh transport per request (stateless mode) ────────────────
// Each request to / creates a fresh McpServer + StreamableHTTP transport.
// The engine.js stores the funnel session state in-memory with 6h TTL.
// POST = JSON-RPC · GET (event-stream) = SSE probe · DELETE = session teardown.
// One line per MCP request on the mounted volume — answers "which directory brought calls?".
// Never breaks a request; see THEMA-mcp-discovery-roi.md. Read with:
//   fly ssh console -a wi-mcp-server -C "grep -o '\"src\":\"[^\"]*\"' /data/mcp-events.ndjson | sort | uniq -c"
// ── Growth brake (THEMA-mcp-agenten-statistik.md, Stufe 1.4) ───────────
// Append-only means unbounded (512 MB machine, one machine, one file). Past
// WI_MCP_EVENTS_MAX_BYTES (default 5 MiB) the current file becomes the *previous* segment
// (`mcp-events.1.ndjson`, the old one is dropped) and a fresh one starts. Disk stays bounded at
// ~2× the threshold and the aggregate can still look across the rotation boundary.
const MCP_EVENTS_MAX_BYTES = (() => {
  const raw = parseInt(process.env.WI_MCP_EVENTS_MAX_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024;
})();

function mcpEventsFile(dir) { return join(dir, "mcp-events.ndjson"); }
function mcpEventsPrevFile(dir) { return join(dir, "mcp-events.1.ndjson"); }

function rotateMcpEventsIfNeeded(file, prev) {
  try {
    if (!existsSync(file) || statSync(file).size < MCP_EVENTS_MAX_BYTES) return false;
    if (existsSync(prev)) unlinkSync(prev);
    renameSync(file, prev); // rename inside one directory is atomic
    return true;
  } catch (e) {
    return false; // a failed rotation must never break the request
  }
}

function logMcpEvent(ev) {
  try {
    const dir = process.env.WI_MCP_STATE_DIR || "/data";
    if (!existsSync(dir)) return;
    const file = mcpEventsFile(dir);
    const prev = mcpEventsPrevFile(dir);
    if (rotateMcpEventsIfNeeded(file, prev)) {
      console.error(`[mcp] events log rotated at >= ${MCP_EVENTS_MAX_BYTES} bytes -> ${prev}`);
    }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
  } catch (e) { /* logging must never break a request */ }
}

// ── Stats: "how many different people, per channel?" ───────────────────
// THEMA-mcp-agenten-statistik.md (Stufe 1). One extra field per event:
// `cf` = a daily-rotating anonymous fingerprint. sha256(ip | ua | UTC-day | salt),
// hex, 16 chars. The raw IP is never written — and the day inside the hash means the
// value cannot be followed across days. Rows written before this change have no `cf`
// and still count as calls (not as people).
/**
 * The client address for the fingerprint.
 *
 * `fly-client-ip` is set by Fly's own proxy and cannot be forged by the caller — first choice,
 * same as wi-node-ai-relay/src/token/issuer.js:90. Only if it is missing do we fall back to
 * X-Forwarded-For: a proxy *appends* the peer it saw on the RIGHT, so the last entry is the one
 * we control — the first entry is whatever the caller sent, and taking it let one client look
 * like a new "user" on every request. `req.ip` is the last resort: with the header gone it is
 * the socket peer, so it cannot be spoofed either.
 */
function mcpClientIp(req) {
  const h = (req && req.headers) || {};
  const fly = String(h["fly-client-ip"] || "").trim();
  if (fly) return fly;

  const parts = String(h["x-forwarded-for"] || "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];

  return String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || "");
}

function mcpClientFingerprint(req) {
  try {
    // Only WI_MCP_STATS_SALT: reusing the endpoint secret would silently couple the two (rotate
    // one, the fingerprints change). Missing salt = fail-soft: the row is still logged, just
    // without a `cf`, so it counts as a call and not as a person.
    const salt = String(process.env.WI_MCP_STATS_SALT || "");
    if (!salt) return "";
    const ip = mcpClientIp(req);
    const ua = String(req.headers["user-agent"] || "-");
    const day = new Date().toISOString().slice(0, 10);
    return createHash("sha256").update(`${ip}|${ua}|${day}|${salt}`).digest("hex").slice(0, 16);
  } catch (e) { return ""; }
}

// Channel labels: `?src=` is the tracking value the directories use.
const MCP_SOURCE_LABELS = {
  smithery: "Smithery",
  registry: "MCP-Registry",
  claude: "Claude",
  chatgpt: "ChatGPT",
  glama: "Glama",
  mcpso: "mcp.so",
  pulsemcp: "PulseMCP",
  // Verzeichnisse, die uns listen (2026-10-02). Jedes bekommt eine EIGENE URL mit ?src=…,
  // damit im Report steht, wer wirklich kommt — statt „direkt / andere" (waren 44 %).
  mcpbeat: "mcpbeat",
  mcpradar: "MCP Radar",
  mcpservers: "MCP Servers",
  cursor: "Cursor",
  claudecode: "Claude Code",
  vscode: "VS Code",
  opencode: "opencode",
};

function mcpSourceLabel(src) {
  if (!src) return "direkt / andere";
  return MCP_SOURCE_LABELS[src] || src;
}

// ── Herkunft aus dem User-Agent ────────────────────────────────────────
// Stufe 2 (2026-09-30): the tile showed channels but not WHO was behind them. The User-Agent
// is already logged (`ua`) and often carries the caller's own URL in parentheses — that is the
// only place the origin domain appears. Two honest caveats, shown in the tile as well:
//   1. a User-Agent is self-declared and freely forgeable — "domain" means "claims to be";
//   2. the UA is truncated before it is logged (80 chars, see handleMcp), so a URL near the end
//      can arrive cut off. This matters: the cut usually lands INSIDE the host, and a fragment
//      like "wellknown.network/bot" -> "wellknown.net" still contains a dot — it looks like a
//      valid domain but would point at a DIFFERENT, real site. So a host is only trusted when
//      the URL clearly ended (a slash, space, bracket or semicolon followed) before the cut.
const MCP_UA_URL_RE = /https?:\/\/([^\s)"'<>]+)/i;

// At most this many origin rows per channel; the tail is folded into one "weitere Aufrufer" row.
// Keeps both the in-memory Maps and the JSON response bounded against UA-rotating crawlers.
const MCP_STATS_MAX_ORIGINS = Math.max(5, parseInt(process.env.WI_MCP_STATS_MAX_ORIGINS || "40", 10) || 40);
const MCP_STATS_REST_KEY = "weitere Aufrufer";

function mcpUaDomain(ua) {
  const s = String(ua || "");
  const m = MCP_UA_URL_RE.exec(s);
  if (!m) return "";
  const raw = m[1];
  // Does the URL run all the way to the end of the UA string? Then it may have been cut by the
  // UA truncation, and the fragment would look like a valid host while pointing elsewhere.
  // Accept it only when the string ends on a natural boundary (which would end the URL anyway).
  const atEnd = m.index + m[0].length === s.length;
  if (atEnd && !/[\/;:)\].,]$/.test(raw)) return "";
  const host = raw.toLowerCase().replace(/[.,;:)\]]+$/, "").split("/")[0].split(":")[0];
  // A host needs a dot and a plausible TLD — "mcpchecku" is a cut fragment, not a domain.
  if (!host.includes(".")) return "";
  const last = host.split(".").pop();
  if (last.length < 2 || !/[a-z]/.test(last)) return "";
  return host.slice(0, 60);
}

// Klassifikation des Aufrufers — Tobias 2026-09-30: drei Spalten, keine erfundene Sicherheit.
//   "self"   = wir selbst (eigener `?src=own`, siehe SELF_SRC) — wird NIE mitgezählt.
//   "user"   = ein Client, den jemand bedient (Browser, KI-Agent im Chat, IDE, curl).
//              Das ist NICHT bewiesen "ein Mensch" — nur "kein Bot-Muster".
//   "bot"    = nennt sich selbst Crawler/Probe/Census/Uptime/Directory.
//   "others" = kein Muster passt (kein UA, blosses "node", unbekannter Name).
//              Bewusst offen gelassen für spätere Forschung — nichts wird geraten.
const MCP_SELF_SRC = "own";

const MCP_BOT_RE =
  /(bot|spider|crawl|probe|scann?er|scrape|harvest|collector|monitor|watch|uptime|telemetry|census|survey|research|directory|indexer|registr|discover|audit|checker|syncer|sync|verifier|observatory|bench|pulsefeed|drift|lastseen|snapshot|builtwith|sitemap)/i;
const MCP_USER_RE =
  /(opencode|claude|anthropic|chatgpt|openai|gemini|cursor|windsurf|cline|mozilla\/5\.0|chrome|safari|firefox|edg\/|curl|wget|python-httpx|python-requests|aiohttp|undici|go-http-client|bun\/|deno)/i;

/** "self" | "bot" | "user" | "others" — siehe Kommentar oben. */
function mcpClassify(src, ua) {
  if (String(src || "") === MCP_SELF_SRC) return "self";
  const s = String(ua || "").trim();
  if (MCP_BOT_RE.test(s)) return "bot";   // Bot-Muster gewinnt, auch in einem Browser-UA
  if (!s || s === "-" || s === "node") return "others";
  if (MCP_USER_RE.test(s)) return "user";
  return "others";
}

// "geschaut" vs. "verbaut": initialize / *_list / notifications are the discovery handshake a
// client does before it does anything. Only tools/call shows that someone actually used a tool.
// Note what each number does and does not say (the tile footnotes this too):
//   - `peeks` counts every non-tool message, INCLUDING ones the server rejected (401/406/400).
//     It means "someone knocked", not "someone understood" — a UA with only 406 answers still
//     appears as pure peeks, which is exactly the truth about it.
//   - `uses` counts tools/call, including probes that called a tool name that does not exist.
//     It means "someone invoked a tool", not "something was built".
function mcpIsUse(label) {
  return String(label || "").startsWith("tools/call");
}

// Stufenkette (Teil C, 2026-10-01): welchen Schritt hat ein Client erreicht? Aus `label`.
// Nur die Schritte, die es im Log wirklich gibt — kein Wunschdenken.
function mcpStageKey(label) {
  const l = String(label || "");
  if (l === "initialize") return "initialize";
  if (l === "notifications/initialized") return "initialized";
  if (l === "tools/list") return "tools_list";
  if (l === "prompts/list") return "prompts_list";
  if (l.startsWith("prompts/get")) return "prompts_get";
  if (l === "resources/list") return "resources_list";
  if (l === "resources/templates/list") return "resources_templates";
  if (l === "resources/read") return "resources_read";
  if (l === "server/discover") return "discover";
  if (l === "tools/call (wi_webinar)") return "tool_webinar";
  if (l.startsWith("tools/call")) return "tool_other";
  return "";
}

// Reihenfolge der Kette für die Anzeige (Tages-Kachel).
const MCP_STAGE_ORDER = [
  "initialize", "initialized", "tools_list", "prompts_list", "prompts_get",
  "resources_list", "discover", "tool_webinar",
];

/** A short, human-readable label for an origin row (domain if there is one, else the UA). */
function mcpOriginLabel(ua) {
  const dom = mcpUaDomain(ua);
  if (dom) return dom;
  const s = String(ua || "").trim();
  if (!s || s === "-") return "(ohne Angabe)";
  // Matches the logged length (handleMcp keeps 80 chars), so the label is what we actually have.
  return s.slice(0, 80);
}

// Bounds for the aggregate. Rotation caps the bytes on disk; these cap the work per read; the
// cache caps how often a read happens at all (this runs in the same process as the MCP traffic).
const MCP_STATS_MAX_LINES = Math.max(1000, parseInt(process.env.WI_MCP_STATS_MAX_LINES || "200000", 10) || 200000);
const MCP_STATS_CACHE_MS = Math.max(0, parseInt(process.env.WI_MCP_STATS_CACHE_MS || "60000", 10) || 0);
const mcpStatsCache = new Map(); // days -> { at, payload }  (at most 90 entries)
let mcpStatsLastRead = { files: 0, lines: 0 }; // proof for "a cache hit does not read the file"

/**
 * The newest `limit` lines of an append-only file — the tail is the current window, so cutting
 * the head loses the oldest (already out-of-window) rows, not the newest.
 */
function mcpEventLines(file, limit) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.length <= limit) return lines;
  return lines.slice(lines.length - limit);
}

/**
 * Aggregate the event log over the last `days` UTC days.
 * Never throws: a missing or half-written log is an empty result, not an error.
 */
function mcpSourcesStats(days) {
  const raw = parseInt(days, 10);
  const d = Number.isNaN(raw) ? 14 : Math.min(90, Math.max(1, raw));
  // Whole UTC days, oldest label day first — NOT a rolling 24h window. The chart draws one label
  // per UTC day (PHP: gmdate() for i = days-1..0); with a rolling cutoff a day could show up in
  // the totals/table that the chart has no label for. Same boundary on both sides.
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = todayUtc - (d - 1) * 86400000;
  const dir = process.env.WI_MCP_STATE_DIR || "/data";
  const bySrc = new Map();
  const byDay = new Map();
  // Rolling 24 h, aggregated over all channels (one bucket per UTC hour) — the "last 24 hours"
  // view of the tile. Bounded by construction to at most 25 keys, so the response stays small.
  const byHour = new Map();
  const currentHour = Math.floor(now.getTime() / 3600000) * 3600000;
  const hourCutoff = currentHour - 23 * 3600000;
  // Stufenkette (Teil C): welchen Schritt hat ein Client erreicht? Alle Stufen und die nur
  // von aussen (ohne src=own). Bounded: eine feste Menge von Schlüsseln.
  const stages = {};
  const stagesOuter = {};
  const usersAll = new Set();
  // Aussen-Zahlen (ohne uns) und Gruppen. Tobias 2026-09-30: „uns nie tracken", Maschine extra.
  const outerUsers = new Set();
  const byKind = {
    user: { calls: 0, uses: 0, users: new Set() },
    bot: { calls: 0, uses: 0, users: new Set() },
    others: { calls: 0, uses: 0, users: new Set() },
    self: { calls: 0, uses: 0, users: new Set() },
  };
  let calls = 0;
  let usesAll = 0;
  let outerCalls = 0;
  let outerUses = 0;
  let linesRead = 0;
  let filesRead = 0;

  try {
    // Previous segment first (older rows), then the live file. Both are bounded by rotation.
    const files = [mcpEventsPrevFile(dir), mcpEventsFile(dir)];
    for (const file of files) {
      if (!existsSync(file)) continue;
      filesRead += 1;
      for (const line of mcpEventLines(file, MCP_STATS_MAX_LINES)) {
        if (!line.trim()) continue; // the trailing newline is not a line
        linesRead += 1;
        let ev = null;
        try { ev = JSON.parse(line); } catch (e) { continue; } // ignore broken lines
        if (!ev || typeof ev !== "object") continue;
        const ms = Date.parse(ev.ts);
        if (!Number.isFinite(ms) || ms < cutoff) continue;

        const src = typeof ev.src === "string" ? ev.src : "";
        const cf = typeof ev.cf === "string" ? ev.cf : "";
        const date = String(ev.ts).slice(0, 10);
        const label = typeof ev.label === "string" ? ev.label : "";
        const ua = typeof ev.ua === "string" ? ev.ua : "";
        const use = mcpIsUse(label);
        const kind = mcpClassify(src, ua); // self | user | bot | others

        // Wir selbst werden gezaehlt, aber nur in der eigenen Zeile — nie in den Aussen-Zahlen.
        byKind[kind].calls += 1;
        if (use) byKind[kind].uses += 1;
        if (cf) byKind[kind].users.add(cf);

        calls += 1;
        if (use) usesAll += 1;
        if (cf) usersAll.add(cf);
        if (kind !== "self") {
          outerCalls += 1;
          if (use) outerUses += 1;
          if (cf) outerUsers.add(cf);
        }
        if (!bySrc.has(src)) {
          bySrc.set(src, { calls: 0, uses: 0, users: new Set(), last: "", origins: new Map(), peeks: 0, kinds: { user: 0, bot: 0, others: 0, self: 0 } });
        }
        const s = bySrc.get(src);
        s.calls += 1;
        if (use) s.uses += 1; else s.peeks += 1;
        if (cf) s.users.add(cf);
        if (String(ev.ts) > s.last) s.last = String(ev.ts);
        s.kinds[kind] += 1;

        // Per-origin row inside the channel: which caller (domain/UA) is behind these calls,
        // and did it only look around or actually run a tool?
        // Capped: a prober that rotates its UA per request would otherwise grow one row per
        // request (unbounded memory here, and an unbounded JSON payload downstream). The
        // longest tail beyond the cap is folded into a single "weitere" row.
        const oKey = `${kind}|${mcpOriginLabel(ua)}`;
        if (!s.origins.has(oKey)) {
          if (s.origins.size >= MCP_STATS_MAX_ORIGINS) {
            if (!s.origins.has(MCP_STATS_REST_KEY)) {
              s.origins.set(MCP_STATS_REST_KEY, { label: MCP_STATS_REST_KEY, domain: "", kind: "others", calls: 0, uses: 0, users: new Set(), last: "", rest: true, hosts: new Set() });
            }
            const rest = s.origins.get(MCP_STATS_REST_KEY);
            rest.calls += 1;
            if (use) rest.uses += 1;
            if (cf) rest.users.add(cf);
            if (oKey && oKey !== MCP_STATS_REST_KEY) rest.hosts.add(oKey);
            if (String(ev.ts) > rest.last) rest.last = String(ev.ts);
          } else {
            s.origins.set(oKey, { label: mcpOriginLabel(ua), domain: mcpUaDomain(ua), kind, calls: 0, uses: 0, users: new Set(), last: "", rest: false, hosts: null });
          }
        }
        const o = s.origins.get(oKey) || s.origins.get(MCP_STATS_REST_KEY);
        if (!o.rest) { // the rest row was already counted above
          o.calls += 1;
          if (use) o.uses += 1;
          if (cf) o.users.add(cf);
          if (String(ev.ts) > o.last) o.last = String(ev.ts);
        }

        // Per UTC day: calls + the share that is us (src=own) + real tool calls ("verbaut").
        // The tile draws "geschaut" vs "verbaut" per day from this — same pass, no second truth.
        const dayKey = `${date}|${src}`;
        const day = byDay.get(dayKey) || { calls: 0, self: 0, uses: 0 };
        day.calls += 1;
        if (kind === "self") day.self += 1;
        if (use) day.uses += 1;
        byDay.set(dayKey, day);

        if (ms >= hourCutoff) {
          const hourKey = String(ev.ts).slice(0, 13); // "YYYY-MM-DDTHH" (UTC)
          const h = byHour.get(hourKey) || { calls: 0, self: 0, uses: 0 };
          h.calls += 1;
          if (kind === "self") h.self += 1;
          if (use) h.uses += 1;
          byHour.set(hourKey, h);
        }

        // Stufenkette (Teil C).
        const stage = mcpStageKey(label);
        if (stage) {
          stages[stage] = (stages[stage] || 0) + 1;
          if (kind !== "self") stagesOuter[stage] = (stagesOuter[stage] || 0) + 1;
        }
      }
    }
  } catch (e) { /* unreadable log = empty statistics */ }
  mcpStatsLastRead = { files: filesRead, lines: linesRead };

  const sources = [...bySrc.entries()]
    .map(([src, s]) => ({
      src,
      label: mcpSourceLabel(src),
      calls: s.calls,
      uses: s.uses,
      peeks: s.peeks,
      users: s.users.size,
      last: s.last,
      // Wie viele Aufrufe dieses Kanals kommen von wem? Selbst-Aufrufe bleiben sichtbar,
      // damit man sie sieht — sie zaehlen aber nicht in den Aussen-Zahlen.
      kinds: s.kinds,
      origins: [...s.origins.values()]
        .map((o) => ({
          label: o.label,
          domain: o.domain,
          kind: o.kind,
          calls: o.calls,
          uses: o.uses,
          users: o.users.size,
          last: o.last,
          // Only on the folded "weitere Aufrufer" row: how many distinct callers it stands for.
          folded: o.rest && o.hosts ? o.hosts.size : 0,
        }))
        .sort((a, b) => (b.uses - a.uses) || (b.calls - a.calls)),
    }))
    .sort((a, b) => b.calls - a.calls);

  const daily = [...byDay.entries()]
    .map(([key, v]) => { const [date, src] = key.split("|"); return { date, src, calls: v.calls, self: v.self, uses: v.uses }; })
    .sort((a, b) => (a.date === b.date ? a.src.localeCompare(b.src) : a.date.localeCompare(b.date)));

  // At most 25 rows (24 whole hours + the running one); the tail-slice is belt-and-braces only.
  const hourly = [...byHour.entries()]
    .map(([hour, v]) => ({ hour, calls: v.calls, self: v.self, uses: v.uses }))
    .sort((a, b) => a.hour.localeCompare(b.hour))
    .slice(-25);

  // Stufenkette in fester Reihenfolge, nur die Stufen die real vorkommen.
  const stageRows = MCP_STAGE_ORDER
    .filter((k) => stages[k] || stagesOuter[k])
    .map((k) => ({ stage: k, calls: stages[k] || 0, outer: stagesOuter[k] || 0 }));

  return {
    ok: true,
    // When these numbers were *computed* — with the 60 s cache that can be up to a minute ago.
    generated_at: new Date().toISOString(),
    days: d,
    // `calls` counts every MCP message (including the handshake); `uses` only real tool calls.
    // `outer*` leave out our own traffic (src=own) — that is the number that matters.
    totals: {
      calls,
      uses: usesAll,
      peeks: calls - usesAll,
      users: usersAll.size,
      outer_calls: outerCalls,
      outer_uses: outerUses,
      outer_peeks: outerCalls - outerUses,
      outer_users: outerUsers.size,
      self_calls: byKind.self.calls,
      self_uses: byKind.self.uses,
    },
    // Die drei Gruppen, nach denen die Kachel trennt: User · Bot · Others (+ wir selbst).
    groups: {
      user: { calls: byKind.user.calls, uses: byKind.user.uses, users: byKind.user.users.size },
      bot: { calls: byKind.bot.calls, uses: byKind.bot.uses, users: byKind.bot.users.size },
      others: { calls: byKind.others.calls, uses: byKind.others.uses, users: byKind.others.users.size },
      self: { calls: byKind.self.calls, uses: byKind.self.uses, users: byKind.self.users.size },
    },
    sources,
    daily,
    hourly,
    stages: stageRows,
  };
}

/**
 * The aggregate behind a short in-memory cache (WI_MCP_STATS_CACHE_MS, default 60 s).
 * The tile polls every 5 minutes anyway; this keeps a burst of dashboard loads from reading the
 * whole log each time in the same process that serves the MCP traffic.
 */
/**
 * Sprach-Statistik (2026-10-02, Tobias): in welchen Sprachen kommen die Leute — und ist eine
 * dabei, die wir gar nicht anbieten?
 *
 * Liest dieselben Event-Zeilen wie die Quellen-Statistik (`lang`-Feld seit 2026-10-02).
 * Gezählt wird pro Aufruf, getrennt nach Art (Mensch/Bot/Werkzeug): ein Bot mit `en` ist kein
 * Signal für eine Sprachlücke. Rohdaten — akkumuliert wird im Report.
 *
 * @param {string|number} days Zeitraum in Tagen (1–90, Standard 14).
 * @returns {object} { ok, days, total, languages:[…], not_offered:[…], offered:[…] }
 */
function mcpLanguageStats(days) {
  const raw = parseInt(days, 10);
  const d = Number.isNaN(raw) ? 14 : Math.min(90, Math.max(1, raw));
  const now = new Date();
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (d - 1) * 86400000;
  const dir = process.env.WI_MCP_STATE_DIR || "/data";

  const byLang = new Map();   // code -> { calls, kinds:{user,bot,tool}, last }
  const byDay = new Map();    // "YYYY-MM-DD" -> { code -> calls }
  let total = 0;
  let without = 0;

  try {
    for (const file of [mcpEventsPrevFile(dir), mcpEventsFile(dir)]) {
      if (!existsSync(file)) continue;
      for (const line of mcpEventLines(file, MCP_STATS_MAX_LINES)) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(ev.ts || "");
        if (Number.isNaN(ts) || ts < cutoff) continue;
        total += 1;
        const code = String(ev.lang || "").toLowerCase();
        if (!code) { without += 1; continue; }
        const kind = String(ev.ua || "").toLowerCase().match(/bot|crawl|spider|probe|scan/)
          ? "bot"
          : String(ev.ua || "").toLowerCase().match(/curl|wget|python|node|go-http|java|okhttp|axios/)
            ? "tool"
            : "user";
        const row = byLang.get(code) || { calls: 0, kinds: { user: 0, bot: 0, tool: 0 }, last: "" };
        row.calls += 1;
        row.kinds[kind] += 1;
        if (!row.last || ev.ts > row.last) row.last = ev.ts;
        byLang.set(code, row);

        const day = new Date(ts).toISOString().slice(0, 10);
        const perDay = byDay.get(day) || {};
        perDay[code] = (perDay[code] || 0) + 1;
        byDay.set(day, perDay);
      }
    }
  } catch (e) {
    return { ok: false, reason: "read_failed", error: String(e.message || e) };
  }

  const languages = [...byLang.entries()]
    .map(([code, row]) => ({
      lang: code,
      calls: row.calls,
      // „wir koennen es" = haben eine fertige Fassung; sonst ist es eine Luecke.
      offered: isOfferedLanguage(code),
      users: row.kinds.user,
      bots: row.kinds.bot,
      tools: row.kinds.tool,
      last: row.last,
    }))
    .sort((a, b) => b.calls - a.calls);

  const notOffered = languages.filter((x) => !x.offered);
  const offered = languages.filter((x) => x.offered);

  return {
    ok: true,
    days: d,
    total,
    without_language: without,
    offered_languages: offeredLanguages(),
    languages,
    // Die interessante Zeile: Sprachen, für die Leute kommen, für die wir aber nichts haben.
    not_offered: notOffered,
    by_day: Object.fromEntries([...byDay.entries()].sort()),
  };
}

/**
 * Die Quellen-Statistik (Kachel im wp-admin) — alt, unverändert.
 */
function mcpSourcesStatsCached(days) {
  const raw = parseInt(days, 10);
  const d = Number.isNaN(raw) ? 14 : Math.min(90, Math.max(1, raw));
  const now = Date.now();
  const hit = mcpStatsCache.get(d);
  if (hit && now - hit.at < MCP_STATS_CACHE_MS) {
    console.error(`[stats] sources days=${d} cache=hit age=${now - hit.at}ms files=0 lines=0`);
    return hit.payload;
  }
  const payload = mcpSourcesStats(d);
  mcpStatsCache.set(d, { at: Date.now(), payload });
  if (mcpStatsCache.size > 120) mcpStatsCache.clear(); // days is clamped to 1..90 — never grows
  console.error(
    `[stats] sources days=${d} cache=miss files=${mcpStatsLastRead.files} lines=${mcpStatsLastRead.lines} ` +
    `calls=${payload.totals.calls} users=${payload.totals.users} sources=${payload.sources.length}`
  );
  return payload;
}

// Constant-time secret compare (equal length required for timingSafeEqual).
function mcpStatsKeyOk(req) {
  const expected = String(process.env.WI_MCP_STATS_SECRET || "");
  const given = String(req.headers["x-wi-stats-key"] || "");
  if (!expected || !given || given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
  } catch (e) { return false; }
}

// Der Statistik-Abruf selbst ist kein MCP-Verkehr — er darf nie im Log landen. Das ist hier
// strukturell sicher: `logMcpEvent()` wird ausschliesslich aus `handleMcp()` (POST auf "/")
// gerufen. Die GET-Routen `/api/stats/*` und `/api/funnel/*` laufen daran vorbei, koennen sich
// also nicht selbst hochzaehlen. Wer eine neue Route hinzufuegt, darf hier KEIN Logging einbauen.

async function handleMcp(req, res) {
  const t0 = Date.now();
  const rpc = req.method === "POST" && req.body && typeof req.body === "object" ? req.body : null;
  const label = rpc
    ? `${rpc.method || "?"}${rpc.params && rpc.params.name ? " (" + rpc.params.name + ")" : ""}`
    : req.method;
  const ua = String(req.headers["user-agent"] || "-").slice(0, 80);
  // Attribution (2026-09-26): each directory lists its own endpoint URL with ?src=<channel>
  // (e.g. ?src=claude, ?src=chatgpt, ?src=smithery). Log-only — no behaviour change.
  const src = String((req.query && (req.query.src || req.query.source)) || "")
    .toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  const cf = mcpClientFingerprint(req);
  // Sprache des Aufrufers (2026-10-02): MCP-Clients schicken dieselbe Accept-Language wie
  // WhatsApp. Sie wird mitgeschrieben, damit im Report sichtbar ist, WELCHE Sprachen ankommen —
  // auch solche, die wir gar nicht anbieten (Rechner: lib/langstats.js). Nur der Sprachcode
  // wird gespeichert, nie die Kopfzeile im Klartext und nie eine Verbindung zur Person.
  const lang = languageOf(req.headers["accept-language"]);

  res.on("finish", () => {
    console.error(`[mcp] ${req.method} ${label} -> ${res.statusCode} ${Date.now() - t0}ms ua=${ua}${src ? " src=" + src : ""}${lang ? " lang=" + lang : ""}`);
    logMcpEvent({ src, ua, method: req.method, label, status: res.statusCode, cf, lang });
  });

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new McpServer(
      { name: "WebinarIgnition", version: "1.0.6" },
      { instructions: SERVER_INSTRUCTIONS }
    );
    registerAll(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(`[mcp] ERROR ${label}: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}

app.post("/", handleMcp);

// This server is stateless: it never pushes anything on its own, so there is no
// standalone SSE stream to open. 405 is the documented answer — clients then simply
// keep using POST. Answering with the HTML page (or holding the stream open forever)
// is what made the connector look broken.
app.get("/", (req, res) => {
  console.error(`[mcp] GET event-stream -> 405 ua=${String(req.headers["user-agent"] || "-").slice(0, 40)}`);
  res.status(405).set("Allow", "POST, DELETE").json({
    jsonrpc: "2.0", id: null,
    error: { code: -32000, message: "This server is stateless. Use POST for MCP requests." },
  });
});

// Session teardown. Nothing to tear down in stateless mode, but it must not 404.
app.delete("/", (req, res) => {
  console.error(`[mcp] DELETE -> 204 ua=${String(req.headers["user-agent"] || "-").slice(0, 40)}`);
  res.status(204).end();
});

// ── REST endpoints ─────────────────────────────────────────────────
app.post("/api/funnel/start", async (req, res) => {
  try { const { message, language, role } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    res.json(await engine.funnelStart(message, language, role));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/funnel/chat", async (req, res) => {
  try { const { session_id, message } = req.body;
    if (!session_id || !message) return res.status(400).json({ error: "session_id and message are required" });
    res.json(await engine.funnelChat(session_id, message));
  } catch (e) { res.status(e.message.includes("not found") ? 404 : 500).json({ error: e.message }); }
});
app.post("/api/funnel/generate", async (req, res) => {
  try { const { session_id, type, job_id, invite_type, custom_channel } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    // Mit job_id: nur nachfragen, ob der Auftrag fertig ist. Ohne: neuen aufgeben.
    if (job_id) return res.json(await engine.generateStatus(session_id, job_id));
    res.json(await engine.funnelGenerate(session_id, type, null, invite_type, "", custom_channel));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/funnel/status", async (req, res) => {
  try { const { session_id, job_id } = req.body;
    if (!session_id || !job_id) return res.status(400).json({ error: "session_id and job_id are required" });
    res.json(await engine.generateStatus(session_id, job_id));
  } catch (e) { res.status(e.message.includes("not found") ? 404 : 500).json({ error: e.message }); }
});
// ── Erste Herkunft je Installation (Teil B, Tobias 2026-10-02) ─────────
// Steht bewusst VOR `/api/funnel/:session_id`, sonst fängt die Sitzungs-Route den Pfad ab.
//
// „Woher kamen sie, bevor sie ins Opt-in gingen?" Der erste Opt-in passiert VOR jeder
// MCP-Berührung. Deshalb meldet die Site ihren Opt-in anonym (Installations-Abdruck `sk` =
// sha256(home_url), 16 Hex) und meldet später, wenn sie per Handoff über die KI ankam. Über den
// gemeinsamen Abdruck wird der frühere Opt-in RÜCKWIRKEND zuordenbar.
//
// Gespeichert wird NUR: Abdruck → { via, first_seen, last_seen, events }. Keine Person, keine
// Domain, keine IP. Höchstens 5000 Installationen, älteste fallen weg (die Antwort bleibt klein).
const WI_FUNNEL_SRC_DIR = process.env.WI_MCP_STATE_DIR || "/data";
const WI_FUNNEL_SRC_FILE = "mcp-sources-origin.json";
const WI_FUNNEL_SRC_MAX = 5000;
let funnelSourceCache = null;

function funnelSourceLoad() {
  if (funnelSourceCache) return funnelSourceCache;
  const out = { at: Date.now(), map: new Map() };
  try {
    const p = join(WI_FUNNEL_SRC_DIR, WI_FUNNEL_SRC_FILE);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (/^[a-z0-9:]{6,40}$/.test(k) && v && typeof v === "object") out.map.set(k, v);
        }
      }
    }
  } catch (e) { /* unlesbar = leer, nie ein Fehler nach aussen */ }
  funnelSourceCache = out;
  return out;
}

function funnelSourceSave() {
  try {
    if (!existsSync(WI_FUNNEL_SRC_DIR)) return;
    const obj = {};
    for (const [k, v] of funnelSourceLoad().map) obj[k] = v;
    writeFileSync(join(WI_FUNNEL_SRC_DIR, WI_FUNNEL_SRC_FILE), JSON.stringify(obj));
  } catch (e) { /* Schreiben darf nie brechen */ }
}

/** Abdruck säubern (nur a-z0-9:, mindestens 6 Zeichen) — sonst gibt es keinen Eintrag. */
function funnelSourceKey(v) {
  const s = String(v || "").toLowerCase().replace(/[^a-z0-9:]/g, "").slice(0, 40);
  return s.length >= 6 ? s : "";
}

function funnelSourceHasOptin(rec) {
  return Array.isArray(rec && rec.events)
    ? rec.events.some((e) => String((e && e.event) || "").startsWith("optin"))
    : false;
}

/** Eine Meldung aufnehmen: Herkunft (via) und/oder ein Opt-in-Ereignis. */
function funnelSourceRecord(body) {
  const sk = funnelSourceKey(body && body.sk);
  if (!sk) return { ok: false, error: "bad_sk" };
  const via = String((body && body.via) || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16);
  const event = String((body && body.event) || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  const iidHash = String((body && body.iid_hash) || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  const now = new Date().toISOString();

  const c = funnelSourceLoad();
  let rec = c.map.get(sk);
  if (!rec) rec = { via: "", first_seen: now, last_seen: now, events: [] };
  if (via) rec.via = via;
  rec.last_seen = now;
  if (event) {
    rec.events.push({ at: now, event, iid_hash: iidHash });
    if (rec.events.length > 20) rec.events = rec.events.slice(-20);
  }
  c.map.set(sk, rec);

  if (c.map.size > WI_FUNNEL_SRC_MAX) {
    const drop = c.map.size - WI_FUNNEL_SRC_MAX;
    let i = 0;
    for (const k of c.map.keys()) { if (i++ >= drop) break; c.map.delete(k); }
  }
  funnelSourceSave();

  return {
    ok: true,
    sk,
    via: rec.via,
    first_seen: rec.first_seen,
    last_seen: rec.last_seen,
    optin_seen: funnelSourceHasOptin(rec),
    events: rec.events.length,
  };
}

function funnelSourceLookup(skRaw) {
  const sk = funnelSourceKey(skRaw);
  if (!sk) return { ok: false, error: "bad_sk" };
  const rec = funnelSourceLoad().map.get(sk);
  if (!rec) return { ok: true, sk, via: "", known: false };
  return {
    ok: true,
    sk,
    via: rec.via || "",
    known: true,
    first_seen: rec.first_seen,
    last_seen: rec.last_seen,
    optin_seen: funnelSourceHasOptin(rec),
  };
}

// Eine Meldung (Herkunft und/oder Opt-in-Ereignis). Kein Secret nötig: es sind keine Zahlen über
// Kunden, sondern nur „welche Installation kam woher" — ohne Person, Domain oder IP.
app.post("/api/funnel/source", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(funnelSourceRecord(req.body));
});

// Auskunft für die Site: kennt der Server die Herkunft dieser Installation schon?
app.get("/api/funnel/source", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(funnelSourceLookup(req.query.sk));
});

app.get("/api/funnel/:session_id", (req, res) => {
  try { res.json(engine.funnelGet(req.params.session_id)); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
app.post("/api/assess/wp", async (req, res) => {
  try { const { url, language } = req.body;
    if (!url || !String(url).trim()) return res.status(400).json({ error: "url is required — the address of the WordPress site to check." });
    res.json(await assessWpAnswer(url, language));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/config", (_req, res) => res.json(engine.getConfig()));

// ── Stats for the WordPress dashboard tile ─────────────────────────
// THEMA-mcp-agenten-statistik.md (Stufe 1): read-only aggregate of the local event log.
// Fail closed: an empty/unset secret or a missing/wrong header is 401 — never a stat.
app.get("/api/stats/sources", (req, res) => {
  if (!mcpStatsKeyOk(req)) {
    console.error(`[stats] sources -> 401 ua=${String(req.headers["user-agent"] || "-").slice(0, 40)}`);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  res.set("Cache-Control", "no-store");
  res.json(mcpSourcesStatsCached(req.query.days));
});

/* ── Sprach-Statistik (2026-10-02) ───────────────────────────────────────────
 *
 * Tobias-Wunsch: sichtbar machen, in welchen Sprachen die Leute ankommen — und ob eine
 * Sprache dabei ist, die wir gar nicht anbieten. Rohdaten, akkumuliert wird im Report.
 *
 * Quelle sind die ohnehin geschriebenen Event-Zeilen (`logs/…mcp-events…`), jetzt mit `lang`.
 * Gezählt wird PRO AUFRUF, getrennt nach Art (Mensch/Bot/Werkzeug) — ein Bot mit `en` ist kein
 * Signal für eine Sprachlücke. Kein Personenbezug: Sprache, Seite, Zeit, Art.
 */
app.get("/api/stats/languages", (req, res) => {
  if (!mcpStatsKeyOk(req)) {
    console.error(`[stats] languages -> 401 ua=${String(req.headers["user-agent"] || "-").slice(0, 40)}`);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  res.set("Cache-Control", "no-store");
  res.json(mcpLanguageStats(req.query.days));
});

// Nur starten, wenn diese Datei direkt laeuft (fly/Docker: `node src/server.js`).
// Beim Import (z. B. der stdio-Einstieg index.js nutzt registerAll) darf kein HTTP-Server
// mitgestartet werden.
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
	// Phase 3 (2026-08-31): den Nordstern ("für wen baue ich") beim Start aus der EINEN Quelle holen.
	// Fire-and-forget: schlägt es fehl, bleibt die lokale Fassung stehen — kein Fehler für den Host.
	(async function refreshPrinciples() {
		const apiKey = process.env.WI_NODE_API_KEY || "";
		const base = process.env.WI_NODE_RELAY_BASE_URL || "https://wi-node-ai-relay.fly.dev";
		try {
			const res = await fetch(`${base}/wi-ai/prompt-pack`, { headers: { "x-wi-api-key": apiKey } });
			if (!res.ok) return;
			const data = await res.json().catch(() => null);
			const principles = data && data.ok && data.principles ? String(data.principles).trim() : "";
			if (principles) {
				HOW_IT_WORKS = HOW_IT_WORKS.replace(PRINCIPLES_FALLBACK, principles);
			}
		} catch {
			/* Offline: der lokale Fallback bleibt stehen. */
		}
	})();

	app.listen(PORT, "0.0.0.0", () => {
		console.error(`WI-MCP ready on port ${PORT}`);
		console.error(`MCP: https://mcp.webinarignition.com/`);
		console.error(`REST: https://mcp.webinarignition.com/api/`);
	});
}
