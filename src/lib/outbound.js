/**
 * Outbound channel — a WordPress site that reaches us, because we cannot reach it.
 *
 * The problem it solves: a site behind a JS bot wall (testcookie-nginx-module on Byethost,
 * for example) never answers `/wp-json/...` from the open internet. Discovery, OAuth and
 * every tool call fail before the first byte of PHP runs. The one direction that always
 * works is the site's own outgoing request, because it leaves from inside the wall.
 *
 * So the site registers HERE and then keeps polling US:
 *
 *   site → POST /outbound/register   {site_url, plugin_version}
 *     ← {token, poll_interval_seconds}
 *   site → GET  /outbound/poll?wait=25   (long-poll, 204 when idle)
 *     ← {id, payload}          … the JSON-RPC request we want run on the site
 *   site → POST /outbound/result     {id, result}
 *
 * The token always travels in `Authorization: Bearer <token>` — never in a URL, because a
 * URL is retained by proxies and logs. For one release the old query/body form is still
 * accepted (see server.js), so plugins already deployed keep working.
 *
 * `enqueue()` is the server side of that: it parks a JSON-RPC request and waits for the
 * matching result, exactly the shape `rpc()` in wpconnect.js already produces and consumes.
 *
 * LIMITATION, on purpose and written down: channels live in memory on ONE machine.
 * A restart or a deploy drops every channel (the site notices and re-registers on its next
 * poll, but an in-flight tool call is lost), and a second machine would not see a channel
 * registered on the first. That is acceptable for today's single-machine wi-mcp-server; move
 * channels to shared storage together with the funnel sessions before scaling out.
 *
 * Tokens: the token is a bearer secret. Only its SHA-256 is kept, so a memory dump or a log
 * line cannot reveal a working credential, and it is never written to a log here.
 */

import crypto from "crypto";
import { normaliseWpBase } from "./engine.js";

/** How long a site may long-poll in one request. Kept under a minute for proxies. */
const DEFAULT_POLL_WAIT = 25;
const MAX_POLL_WAIT = 50;
/** Idle channels are swept after this. Long-lived on purpose — the site polls forever. */
const CHANNEL_TTL_MS = 30 * 24 * 3600e3;
/** How long a tool call waits for the site to come around and answer. */
const REQUEST_TIMEOUT_MS = 90e3;
/** Internal queue check interval while a poll is open. In-process and cheap. */
const POLL_TICK_MS = 250;

/** token_hash -> channel */
const channels = new Map();
/** site root -> channel (one channel per site; re-registering replaces the old one) */
const bySite = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/** Same site string the rest of the connector uses, so lookups never miss on a slash. */
export function normaliseOutboundSite(raw) {
  return normaliseWpBase(raw).replace(/\/+$/, "");
}

function newChannel(site, meta) {
  return {
    token_hash: "",
    site,
    created: Date.now(),
    last_seen: 0,
    polls: 0,
    registrations: 1,
    plugin_version: String(meta.plugin_version || "").slice(0, 32),
    abilities: Array.isArray(meta.abilities) ? meta.abilities.slice(0, 200) : [],
    queue: [],
    pending: new Map(),
  };
}

/**
 * A site says hello. Creates (or replaces) its channel and hands out the bearer token.
 *
 * @param {{site_url:string, plugin_version?:string, abilities?:string[]}} input
 * @returns {{token:string, poll_interval_seconds:number, site:string}}
 */
export function register(input) {
  const raw = String((input && input.site_url) || "").trim();
  if (!raw) throw new Error("site_url is required");

  let site;
  try {
    site = normaliseOutboundSite(raw);
  } catch (e) {
    throw new Error(`site_url could not be read: ${e.message}`);
  }
  if (!/^https?:\/\//i.test(site)) throw new Error("site_url must be http(s)");

  // Re-registering replaces the old token — the previous secret stops working the moment a
  // new one exists. Otherwise a leaked token would survive a reinstall.
  const previous = bySite.get(site);
  if (previous) channels.delete(previous.token_hash);

  const token = crypto.randomBytes(32).toString("hex");
  const channel = newChannel(site, input || {});
  channel.token_hash = hashToken(token);
  channels.set(channel.token_hash, channel);
  bySite.set(site, channel);

  console.error(`[outbound] registered ${site} v${channel.plugin_version || "?"} (channels=${channels.size})`);
  return { token, poll_interval_seconds: 10, site };
}

/**
 * The channel for a token, or null. Constant-time compare on the hash, so a wrong token
 * cannot be found by timing either.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function auth(token) {
  const want = Buffer.from(hashToken(token), "hex");
  if (!want.length) return null;
  let found = null;
  for (const channel of channels.values()) {
    const have = Buffer.from(channel.token_hash, "hex");
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) {
      found = channel;
      break;
    }
  }
  return found;
}

/** The channel a site has, if any. Used to decide whether a tool call may go outbound. */
export function channelForSite(site) {
  if (!site) return null;
  try {
    return bySite.get(normaliseOutboundSite(site)) || null;
  } catch {
    return null;
  }
}

export function hasSite(site) {
  return Boolean(channelForSite(site));
}

/**
 * Long-poll for one queued request.
 *
 * @param {object} channel  Authenticated channel.
 * @param {number} waitSec  How long to wait (clamped).
 * @param {() => boolean} [aborted] True when the caller already went away.
 * @returns {Promise<{id:string,payload:object}|null>} The request, or null when idle.
 */
export async function poll(channel, waitSec, aborted = null) {
  const wait = Math.min(Math.max(Number(waitSec) || 0, 0), MAX_POLL_WAIT);
  const deadline = Date.now() + wait * 1000;
  channel.last_seen = Date.now();
  channel.polls += 1;

  for (;;) {
    if (channel.queue.length) {
      const item = channel.queue.shift();
      return item;
    }
    if (Date.now() >= deadline) return null;
    if (aborted && aborted()) return null;
    // 250 ms is below what a human notices and keeps this loop trivial in memory.
    await sleep(Math.min(POLL_TICK_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Resolve a request that a site just answered.
 *
 * @param {object} channel
 * @param {string} id
 * @param {object} result JSON-RPC reply ({result} or {error}).
 * @returns {{ok:boolean, unknown?:boolean}}
 */
export function submitResult(channel, id, result) {
  const job = channel.pending.get(String(id || ""));
  if (!job) return { ok: false, unknown: true };
  channel.pending.delete(String(id));
  clearTimeout(job.timer);
  job.resolve(result);
  return { ok: true };
}

/**
 * Park a JSON-RPC request and wait for the site to answer it through its poll.
 *
 * Resolves with the site's JSON-RPC reply ({jsonrpc,result} or {jsonrpc,error}), the same
 * shape `rpc()` already unwraps for the inbound path — so the caller does not care which
 * channel carried it.
 *
 * @param {string} site        Normalised site root.
 * @param {object} payload     The JSON-RPC request.
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
export function enqueue(site, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  const channel = channelForSite(site);
  if (!channel) {
    const err = new Error("This site is not registered on its outbound channel.");
    err.code = "no_outbound_channel";
    return Promise.reject(err);
  }

  const id = `ob_${crypto.randomBytes(8).toString("hex")}`;
  const item = { id, payload: { ...payload, id } };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.pending.delete(id);
      const idx = channel.queue.indexOf(item);
      if (idx >= 0) channel.queue.splice(idx, 1);
      const err = new Error("The site did not answer through its outbound channel in time.");
      err.code = "outbound_timeout";
      reject(err);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    channel.pending.set(id, { resolve, reject, timer });
    channel.queue.push(item);
  });
}

/** How many channels this process knows about (health output; never the tokens). */
export function size() {
  return channels.size;
}

/** Idle channels are dropped. Nothing else is ever deleted here. */
setInterval(() => {
  const now = Date.now();
  for (const [hash, channel] of channels) {
    const idleSince = channel.last_seen || channel.created;
    if (now - idleSince > CHANNEL_TTL_MS) {
      channels.delete(hash);
      if (bySite.get(channel.site) === channel) bySite.delete(channel.site);
      console.error(`[outbound] channel for ${channel.site} swept after 30 days idle`);
    }
  }
}, 3600e3).unref?.();
