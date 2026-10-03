#!/usr/bin/env node
/**
 * wi-seo-keywords-i18n.mjs — setzt die VORSCHAU-Texte (og_title/og_desc) in allen 26 WI-Sprachen
 * so, dass die Begriffe drin sind, die Leute wirklich suchen.
 *
 * Belegte Begriffe (Recherche 2026-10-02, Google-Autocomplete = echte Queries, Güte B):
 *   webinar plugin · wordpress · live · automated webinar(s) · evergreen webinar · webinar funnel
 * "automated" und "evergreen" sind laut Google-Autocomplete verwandt, aber NICHT gleich (gemessen:
 * beide schlagen einander vor). Deshalb beide im Text — Varianten sind gewollt, eine Keyword-Kette
 * wäre falsch.
 * Bewusst NICHT verwendet: "self-paced" (bedeutet etwas anderes: Lernkurs) und "on-demand"
 * (andere Absicht: jederzeit abrufbar).
 *
 * Aufruf:  node wi-mcp-server/scripts/wi-seo-keywords-i18n.mjs
 * Wirkung: schreibt og_title/og_desc in wi-mcp-server/src/lib/i18n.js neu (idempotent).
 * Danach: wi-seo-faq-export.mjs laufen lassen (die Hauptseite liest dieselbe Quelle).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../src/lib/i18n.js", import.meta.url));

// ── Titel: kurz (WhatsApp zeigt ~2 Zeilen), Marke vorn, "Webinar" + Sprache drin ──────────────
const TITLES = {
  en: "WebinarIgnition — live & evergreen webinars from a chat",
  de: "WebinarIgnition — Live- & Evergreen-Webinare aus dem Chat",
  de_DE_formal: "WebinarIgnition — Live- & Evergreen-Webinare aus dem Chat",
  es: "WebinarIgnition — webinars en vivo y evergreen desde el chat",
  es_MX: "WebinarIgnition — webinars en vivo y evergreen desde el chat",
  fr: "WebinarIgnition — webinaires live et evergreen depuis le chat",
  it: "WebinarIgnition — webinar live ed evergreen dalla chat",
  pt: "WebinarIgnition — webinars ao vivo e evergreen a partir do chat",
  pt_PT: "WebinarIgnition — webinars em direto e evergreen a partir do chat",
  nl: "WebinarIgnition — live en evergreen webinars vanuit de chat",
  pl: "WebinarIgnition — webinary live i evergreen z czatu",
  ro: "WebinarIgnition — webinare live și evergreen din chat",
  tr: "WebinarIgnition — sohbetten canlı ve evergreen webinarlar",
  ru: "WebinarIgnition — живые и вечные вебинары прямо из чата",
  uk: "WebinarIgnition — живі та вічні вебінари прямо з чату",
  bg: "WebinarIgnition — живи и evergreen уебинари направо от чата",
  hr: "WebinarIgnition — live i evergreen webinari iz razgovora",
  hu: "WebinarIgnition — élő és evergreen webináriumok csevegésből",
  el: "WebinarIgnition — ζωντανά και evergreen webinar από τη συνομιλία",
  af: "WebinarIgnition — lewendige en evergreen webinars uit die klets",
  nb: "WebinarIgnition — live og evergreen webinars fra chatten",
  ja: "WebinarIgnition — チャットからライブ＆エバーグリーンウェビナー",
  zh: "WebinarIgnition — 从聊天创建直播与常青网络研讨会",
  hi: "WebinarIgnition — चैट से लाइव और एवरग्रीन वेबिनार",
  ur: "WebinarIgnition — چیٹ سے لائیو اور ایورگرین ویبینار",
  id: "WebinarIgnition — webinar live dan evergreen dari obrolan",
};

// ── Beschreibung: 130–160 Zeichen, trägt WordPress + live + automated + evergreen + funnel ────
const DESCS = {
  en: "WordPress webinar plugin: build live, automated and evergreen webinars from a chat — signup page, invitation emails and the webinar funnel.",
  de: "WordPress-Webinar-Plugin: Live-, automatisierte und Evergreen-Webinare aus dem Chat — Anmeldeseite, Einladungsmails und der ganze Webinar-Funnel.",
  de_DE_formal: "WordPress-Webinar-Plugin: Live-, automatisierte und Evergreen-Webinare aus dem Chat — Anmeldeseite, Einladungsmails und der ganze Webinar-Funnel.",
  es: "Plugin de webinars para WordPress: crea webinars en vivo, automatizados y evergreen desde el chat — página de registro, correos y el embudo completo.",
  es_MX: "Plugin de webinars para WordPress: crea webinars en vivo, automatizados y evergreen desde el chat — página de registro, correos y el embudo completo.",
  fr: "Plugin webinar WordPress : créez des webinaires live, automatisés et evergreen depuis le chat — page d'inscription, e-mails et le tunnel complet.",
  it: "Plugin webinar per WordPress: crea webinar live, automatizzati ed evergreen dalla chat — pagina di iscrizione, email e l'intero funnel del webinar.",
  pt: "Plugin de webinars para WordPress: crie webinars ao vivo, automatizados e evergreen a partir do chat — página de inscrição, e-mails e o funil completo.",
  pt_PT: "Plugin de webinars para WordPress: crie webinars em direto, automatizados e evergreen a partir do chat — página de registo, e-mails e o funil completo.",
  nl: "WordPress webinar-plugin: maak live, geautomatiseerde en evergreen webinars vanuit de chat — aanmeldpagina, e-mails en de hele webinar-funnel.",
  pl: "Wtyczka webinarowa do WordPressa: twórz webinary live, automatyczne i evergreen z czatu — strona zapisu, e-maile i cały lejek webinarowy.",
  ro: "Plugin de webinare pentru WordPress: creează webinare live, automatizate și evergreen din chat — pagină de înscriere, e-mailuri și întregul funnel.",
  tr: "WordPress webinar eklentisi: sohbetten canlı, otomatik ve evergreen webinarlar oluşturun — kayıt sayfası, e-postalar ve tüm webinar hunisi.",
  ru: "Плагин вебинаров для WordPress: живые, автоматические и вечные вебинары прямо из чата — страница регистрации, письма и вся воронка.",
  uk: "Плагін вебінарів для WordPress: живі, автоматичні та вічні вебінари прямо з чату — сторінка реєстрації, листи та вся воронка.",
  bg: "Уебинар плъгин за WordPress: създавай живи, автоматични и evergreen уебинари от чата — страница за записване, имейли и цялата фуния.",
  hr: "WordPress dodatak za webinare: stvori live, automatizirane i evergreen webinare iz razgovora — stranica za prijavu, e-mailovi i cijeli lijevak.",
  hu: "WordPress webinár bővítmény: élő, automatizált és evergreen webináriumok csevegésből — regisztrációs oldal, e-mailek és a teljes webinár-tölcsér.",
  el: "Πρόσθετο webinar για WordPress: δημιούργησε ζωντανά, αυτοματοποιημένα και evergreen webinar από τη συνομιλία — σελίδα εγγραφής, email και funnel.",
  af: "WordPress-webinar-inprop: bou lewendige, outomatiese en evergreen webinars uit die klets — registrasieblad, e-posse en die hele webinar-tregter.",
  nb: "Webinar-plugin for WordPress: lag live, automatiserte og evergreen webinars fra chatten — påmeldingsside, e-poster og hele webinartrakten.",
  ja: "WordPressウェビナープラグイン：チャットからライブ・自動・エバーグリーンウェビナーを作成 — 登録ページ、メール、ファネルまで。",
  zh: "WordPress网络研讨会插件：从聊天创建直播、自动与常青网络研讨会——报名页、邮件与完整营销漏斗。",
  hi: "WordPress वेबिनार प्लगइन: चैट से लाइव, ऑटोमेटेड और एवरग्रीन वेबिनार बनाएँ — रजिस्ट्रेशन पेज, ईमेल और पूरा वेबिनार फ़नल।",
  ur: "WordPress ویبینار پلگ ان: چیٹ سے لائیو، خودکار اور ایورگرین ویبینار بنائیں — رجسٹریشن صفحہ، ای میلز اور مکمل ویبینار فنل۔",
  id: "Plugin webinar untuk WordPress: buat webinar live, otomatis, dan evergreen dari obrolan — halaman pendaftaran, email, dan funnel webinar.",
};

const KEYS = { og_title: TITLES, og_desc: DESCS };

let src = readFileSync(FILE, "utf8");
const report = [];

for (const [key, map] of Object.entries(KEYS)) {
  const re = new RegExp(`(  ${key}: \\{)([\\s\\S]*?)(\\n  \\},)`);
  const m = src.match(re);
  if (!m) {
    console.error(`ABBRUCH — Schlüssel ${key} nicht gefunden.`);
    process.exit(1);
  }
  const langs = [...m[2].matchAll(/^\s{4}([A-Za-z_]+):/gm)].map((x) => x[1]);
  const body = langs
    .map((lang) => `    ${lang}: ${JSON.stringify(map[lang] ?? map.en)},`)
    .join("\n");
  src = src.replace(re, `$1\n${body}$3`);
  const missing = langs.filter((l) => !(l in map));
  report.push(`${key}: ${langs.length} Sprachen${missing.length ? ` — Fallback auf en: ${missing.join(", ")}` : ""}`);
}

writeFileSync(FILE, src, "utf8");
console.log("geschrieben:", FILE);
report.forEach((r) => console.log("  " + r));
