/**
 * How this connector asks a question.
 *
 * A host who is handed an empty field has to invent an answer. A host who is handed four
 * good answers taps one and is a step further. So every tool that still needs something
 * returns a `question` block, and the assistant is told to render it with its own
 * multiple-choice UI (in Claude that is AskUserQuestion) instead of writing a numbered
 * list into the chat.
 *
 * Two things this fixes that were measured on the real thing:
 *
 * 1. The wasted turn. The old escape option was future tense — "Ich schreib's unten selbst".
 *    Tapping it is not an answer, so the assistant replied "go ahead, I'm listening" and the
 *    host lost a whole turn to nothing. The escape is now PAST tense: it says the answer is
 *    already written, so it is tapped after typing, not before. Every real multiple-choice UI
 *    has a free-text field built in, so the escape belongs THERE, not in the list.
 * 2. The wrong word. "unten" is right on webinarignition.com, where there really is a field
 *    below the chips. In a chat client there is no "below", so the wording drops it.
 */

export const ASK_RULE =
  "Ask this with your own multiple-choice UI (in Claude: AskUserQuestion) — one question, " +
  "the options as buttons. Do NOT write them out as a numbered list and wait for typing. " +
  "The free-text escape belongs in that UI's own 'type your own answer' field; only if your " +
  "UI has none, show free_text.label as the last option. Never answer 'go ahead, I'm " +
  "listening' and then wait — asking and waiting are the same step. Show the question and " +
  "the options in the host's language; translate them if they are not in it already.";

/**
 * The escape, in the languages this connector actually sees. Short, and past tense in every
 * one of them: "I have written it" invites typing first and tapping second. A future-tense
 * label ("I'll say it myself") does the opposite and costs a turn.
 */
const OWN_ANSWER = {
  de: "Hab ich schon geschrieben",
  en: "I've written it myself",
  es: "Ya lo he escrito",
  fr: "Je l'ai déjà écrit",
  it: "L'ho già scritto",
  nl: "Heb ik al geschreven",
  pt: "Já escrevi",
};

function ownAnswerLabel(language) {
  const code = String(language || "en").slice(0, 2).toLowerCase();
  return OWN_ANSWER[code] || OWN_ANSWER.en;
}

/**
 * The relay writes its own escape chip into `options`, in the host's language and worded
 * for the web page ("Ich schreib's unten selbst"). In a chat client that chip is wrong on
 * both counts, so it is lifted out of the list and becomes the free-text field instead.
 * If a wording slips through the net it simply stays an option — nothing breaks.
 */
const ESCAPE_PATTERNS = [
  // Past tense — the wording since 23.08.2026.
  /hab(e)?\s+ich\s+(unten\s+)?(schon\s+)?(rein)?geschrieben/i,
  /steht\s+(schon\s+)?unten/i,
  /(i'?ve|already)\s+(written|typed)/i,
  /ya lo he escrito|je l['’]ai déjà écrit|l['’]ho già scritto|heb ik al geschreven|já escrevi/i,
  // Future tense — older sessions and cached replies still produce these.
  /schreib(e|'?s)?\s+(ich\s+)?(es\s+)?(unten\s+)?(selbst|selber)/i,
  /sag(e)?\s+ich\s+(dir\s+)?selbst/i,
  /(write|type|say|tell)\s+(it|this|you)?\s*myself/i,
  /in my own words/i,
  /eigene\s+antwort/i,
  /(lo|se lo)\s+(escribo|digo)\s+yo/i,
  /j['’]écris|je le dis moi/i,
  /zeg ik zelf|lo dico io|eu digo/i,
];

export function looksLikeEscape(option) {
  const s = String(option || "").trim();
  if (!s) return false;
  return ESCAPE_PATTERNS.some((re) => re.test(s));
}

/**
 * Build a question block.
 *
 * @param {string}   text      One question, nothing else.
 * @param {string[]} options   2–4 concrete answers. Never a category — something the host
 *                             can picture and tap without thinking.
 * @param {object}   opts      language · free_text (false when the answer really is a
 *                             closed set, e.g. yes/no) · note (why we are asking).
 */
export function ask(text, options, { language = "en", free_text = true, note } = {}) {
  const clean = (Array.isArray(options) ? options : [])
    .map((o) => String(o || "").trim())
    .filter(Boolean)
    .filter((o) => !looksLikeEscape(o));

  return {
    text: String(text || "").trim(),
    options: clean,
    free_text: free_text
      ? { allowed: true, label: ownAnswerLabel(language) }
      : { allowed: false },
    ...(note ? { why: note } : {}),
    how_to_show: ASK_RULE,
  };
}

/**
 * The funnel is the one place where the question is written by the relay, not by us: it
 * sits at the end of `reply` and the answers come back in `options`. Pull the question
 * sentence out so the assistant has something to put in the UI header, and keep the full
 * reply for the chat itself.
 */
export function askFromFunnel(r, language = "de") {
  const options = Array.isArray(r.options) ? r.options : [];
  if (!options.length) return null;

  const reply = String(r.reply || "");
  const sentences = reply.split(/(?<=[?!.])\s+/).map((s) => s.trim()).filter(Boolean);
  const question = [...sentences].reverse().find((s) => s.endsWith("?")) || sentences.pop() || "";

  return ask(question, options, { language });
}
