/**
 * langstats.js — welcher Sprachcode steckt in einem Accept-Language-Header?
 *
 * Zweck (Tobias 2026-10-01): im Report sichtbar machen, in welchen Sprachen die Leute
 * ankommen — UND ob eine Sprache dabei ist, die wir gar nicht anbieten (dann sieht man im
 * Report „dafür kommen Leute, dafür haben wir nichts").
 *
 * Wichtig: Diese Funktion NORMALISIERT nur, sie entscheidet nichts. Die Auslieferung der
 * Seite nutzt weiter negotiateLanguage() aus i18n.js (26 WI-Sprachen, en als Fallback).
 * Hier wird bewusst auch ein Code zurückgegeben, den wir NICHT können (z. B. "haw") —
 * genau der ist die interessante Zeile.
 *
 * Es wird nur der Sprachcode gespeichert (2–3 Buchstaben, optional Region), nie die
 * Kopfzeile im Klartext und nichts, was auf eine Person zeigt.
 */

/** Sprachen, die wir ausliefern können — kommt aus i18n.js, damit es nur EINE Liste gibt. */
import { SUPPORTED } from "./i18n.js";

const OFFERED = new Set(SUPPORTED.map((l) => String(l).toLowerCase().split("_")[0]));

/** Bekannte Deutsch-Varianten ohne eigenes WI-Paket → de. */
const ALIASES = {
  de_at: "de", de_ch: "de", de_lu: "de", de_li: "de",
  en_us: "en", en_gb: "en", en_au: "en", en_ca: "en", en_nz: "en", en_ie: "en", en_za: "en",
  pt_br: "pt", pt_pt: "pt_pt", es_mx: "es_mx", es_es: "es", es_ar: "es", es_co: "es", es_cl: "es",
  fr_ca: "fr", fr_fr: "fr", fr_be: "fr", fr_ch: "fr",
  nl_be: "nl", nl_nl: "nl", sv_se: "sv", nb_no: "nb", nn_no: "nb",
  zh_cn: "zh", zh_tw: "zh", zh_hk: "zh",
};

/**
 * Den führenden Sprachcode eines Accept-Language-Kopfes holen.
 *
 * @param {string} header z. B. "de-DE,de;q=0.9,en;q=0.8"
 * @returns {string} normalisierter Code ("de", "es_mx", …) oder "" wenn nichts brauchbares.
 */
export function languageOf(header) {
  const raw = String(header || "").trim();
  if (!raw) return "";
  // Erster nicht-* Eintrag mit q>0 (der Aufrufer meint den zuerst genannten).
  for (const part of raw.split(",")) {
    const bits = part.split(";");
    const tag = String(bits[0] || "").trim().toLowerCase().replace(/-/g, "_");
    if (!tag || tag === "*") continue;
    let q = 1;
    for (let i = 1; i < bits.length; i++) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(bits[i]);
      if (m) q = parseFloat(m[1]);
    }
    if (!(q > 0)) continue;
    if (ALIASES[tag]) return ALIASES[tag];
    const base = tag.split("_")[0];
    if (ALIASES[base]) return ALIASES[base];
    // 2–3 Buchstaben: als Code zurückgeben, auch wenn wir die Sprache nicht können.
    return /^[a-z]{2,3}$/.test(base) ? base : "";
  }
  return "";
}

/**
 * Ist der Code eine Sprache, die wir auch ausliefern können?
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isOfferedLanguage(code) {
  return OFFERED.has(String(code || "").toLowerCase().split("_")[0]);
}

/** Die angebotenen Sprachteile (für die Report-Ausgabe). */
export function offeredLanguages() {
  return [...OFFERED].sort();
}
