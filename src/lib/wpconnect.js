/**
 * Connecting this connector to the host's own WordPress site.
 *
 * Until now the conversation ended at the door: we could write the title and the
 * invitation, and then the host had to walk into wp-admin and build the campaign by
 * hand. Since 4.18.124 their site carries its own OAuth 2.1 server and its own MCP
 * endpoint, and registers seventeen WebinarIgnition abilities there. This file is the
 * other half of that bridge: we become an OAuth client to THEIR site, so the same
 * conversation that found the topic can also create the campaign.
 *
 * Roles, so nobody confuses the two servers:
 *
 *   mcp.webinarignition.com   this file's process — MCP SERVER for the AI client,
 *                             and OAuth CLIENT to the host's site
 *   the host's WordPress      OAuth authorization server AND MCP resource server
 *
 * Three decisions worth knowing before changing anything here:
 *
 * 1. **Tokens live in memory only.** Never on the Fly volume, never in a log. A refresh
 *    token for someone else's WordPress is a thirty-day administrator key; keeping a pile
 *    of those on a public server is the kind of asset that turns one break-in into a
 *    hundred. If this process restarts, the host reconnects with one click — that is a
 *    far smaller cost than the alternative. Funnel sessions still persist as before;
 *    only tokens do not.
 *
 * 2. **The authorization server must live on the host's own origin.** The MCP spec allows
 *    a separate one, but every site we talk to is a WordPress that authorises itself. A
 *    site that points its discovery document at somebody else's login server is either
 *    misconfigured or bait, and following it would hand the host's approval to a stranger
 *    (the "confused deputy" the spec warns about). We refuse instead.
 *
 * 3. **Every address is checked for reach before it is fetched** — the one the host types
 *    AND every endpoint the discovery document names. Otherwise a hostile site could
 *    point token_endpoint at an internal address and use our server to knock on doors it
 *    cannot reach itself.
 */

import crypto from "crypto";
import { guardedFetch, normaliseWpBase } from "./engine.js";
import * as outbound from "./outbound.js";

/** Where the host's browser comes back to after approving. Must match DCR exactly. */
const PUBLIC_BASE = (process.env.WI_MCP_PUBLIC_BASE || "https://mcp.webinarignition.com").replace(/\/+$/, "");
const REDIRECT_URI = `${PUBLIC_BASE}/connect/callback`;

/** A pending approval is worth nothing after ten minutes. */
const PENDING_TTL_MS = 10 * 60e3;
/** A connection nobody used for a day is dropped from memory. */
const CONNECTION_TTL_MS = 24 * 3600e3;
/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 5 * 60e3;
/**
 * Running an ability is a different kind of wait.
 *
 * Creating a webinar writes the registration page, the thank-you page and the whole email
 * sequence in one go; measured on 26.08.2026 it was still working when the fifteen-second
 * limit above cut the line, so create-webinar failed through this connector every single
 * time with "operation aborted". The host would have seen a broken feature, not a slow one.
 */
const TOOL_TIMEOUT_MS = 240e3;

/** state -> { session_id, site, resource, endpoints, client_id, verifier, created } */
const pending = new Map();
/** session_id -> { site, resource, endpoints, client_id, access, refresh, expires_at, scope, touched } */
const connections = new Map();
/** site -> client_id, so a second attempt reuses the registration instead of making litter. */
const clientsBySite = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.created > PENDING_TTL_MS) pending.delete(k);
  for (const [k, v] of connections) if (now - v.touched > CONNECTION_TTL_MS) connections.delete(k);
}, 60e3).unref?.();

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newVerifier() {
  return base64url(crypto.randomBytes(32));
}

function challengeFor(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

/** Same scheme + host + port. Used to keep the login on the host's own site. */
function sameOrigin(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}

/**
 * Turn whatever the host typed into a site root we can work with.
 *
 * People paste all sorts of things: with /wp-admin/, without a scheme, with a trailing
 * page. Same normalisation the site check already does, so both agree.
 *
 * @param {string} raw What the host typed.
 * @returns {string} Site root without trailing slash.
 */
export function normaliseSite(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("No address given.");

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new Error(`${scheme[1]} is not a web address this can use — it needs http or https.`);
  }
  const withScheme = scheme ? trimmed : `https://${trimmed}`;

  // Throws on nonsense before anything is fetched.
  // eslint-disable-next-line no-new
  new URL(withScheme);

  // Derselbe Schnitt wie in assessWp (Prueferbefund 2026-09-11, M3): technische Endstuecke
  // (wp-admin, wp-login.php, wp-json, wp-content, wp-includes, index.php …) und alles danach
  // fallen weg, hoechstens drei Unterordner bleiben. Vorher fiel nur `/wp-admin/…` — eine
  // getippte `…/wp-login.php`-Adresse wurde hier als Seitenwurzel weiterverwendet.
  return normaliseWpBase(withScheme).replace(/\/+$/, "");
}

/* ---------------------------------------------------------------------------
 * Discovery
 * ------------------------------------------------------------------------ */

/**
 * Find the two discovery documents on the host's site.
 *
 * Three addresses are tried in order, and the reason there are three is worth keeping:
 * the canonical /.well-known/ path only reaches PHP when the web server hands unknown
 * paths to WordPress, which it does not do on a site with plain permalinks. The plugin
 * therefore publishes the same documents as REST routes as well, and those are reachable
 * either way — including through ?rest_route= on a site with no rewriting at all.
 *
 * @param {string} site Normalised site root.
 * @returns {Promise<object>} { resource, issuer, authorization_endpoint, token_endpoint,
 *   registration_endpoint, revocation_endpoint, scopes_supported }
 */
export async function discover(site) {
  const candidates = [
    `${site}/.well-known/oauth-protected-resource`,
    `${site}/wp-json/wi-mcp/v1/.well-known/oauth-protected-resource`,
    `${site}/?rest_route=/wi-mcp/v1/.well-known/oauth-protected-resource`,
  ];

  let prm = null;
  let lastError = "";
  for (const url of candidates) {
    try {
      const res = await guardedFetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) { lastError = `${url} answered ${res.status}`; continue; }
      const body = await res.json();
      if (body && typeof body === "object" && body.resource) { prm = body; break; }
      lastError = `${url} answered without a resource field`;
    } catch (e) {
      lastError = `${url}: ${e.message}`;
    }
  }

  if (!prm) {
    const err = new Error(
      "This site does not offer an AI connection yet. It needs WebinarIgnition 4.18.123 or newer, " +
      "and the connection has to be switched on there."
    );
    err.detail = lastError;
    err.code = "no_discovery";
    throw err;
  }

  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
  const issuer = String(servers[0] || "").replace(/\/+$/, "");
  if (!issuer) throw new Error("The site says it is protected but does not say who hands out the keys.");

  // Decision 2 from the file header: the login must stay on the host's own site.
  if (!sameOrigin(issuer, site)) {
    const err = new Error(
      "This site points its sign-in at a different address than its own. That is refused on purpose — " +
      "approving there would hand the host's access to somebody else."
    );
    err.code = "foreign_authorization_server";
    throw err;
  }

  const asCandidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${site}/wp-json/wi-mcp/v1/.well-known/oauth-authorization-server`,
    `${site}/?rest_route=/wi-mcp/v1/.well-known/oauth-authorization-server`,
  ];

  let as = null;
  for (const url of asCandidates) {
    try {
      const res = await guardedFetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.authorization_endpoint && body.token_endpoint) { as = body; break; }
    } catch { /* try the next one */ }
  }
  if (!as) throw new Error("The site did not say how to sign in.");

  const endpoints = {
    issuer,
    authorization_endpoint: String(as.authorization_endpoint || ""),
    token_endpoint: String(as.token_endpoint || ""),
    registration_endpoint: String(as.registration_endpoint || ""),
    revocation_endpoint: String(as.revocation_endpoint || ""),
    scopes_supported: Array.isArray(as.scopes_supported) ? as.scopes_supported : [],
    code_challenge_methods_supported: Array.isArray(as.code_challenge_methods_supported)
      ? as.code_challenge_methods_supported : [],
  };

  const resource = String(prm.resource || "");
  if (!resource) throw new Error("The site did not say where its connection point is.");

  // Every address has to sit on the host's own site — otherwise a doctored discovery
  // document could send the authorisation code, and with it the host's access, elsewhere.
  //
  // `resource` belongs in this list and was missing from it at first. It is the address
  // that receives the finished bearer token on every single call, so leaving it unchecked
  // guarded the wrong door: the endpoints that take the code were protected, the one that
  // takes the key was not.
  for (const [label, value] of [
    ["authorization endpoint", endpoints.authorization_endpoint],
    ["token endpoint", endpoints.token_endpoint],
    ["registration endpoint", endpoints.registration_endpoint],
    ["connection point", resource],
  ]) {
    if (!value) continue;
    if (!sameOrigin(value, site)) {
      const err = new Error(`This site's ${label} points somewhere else. Refused.`);
      err.code = "foreign_endpoint";
      throw err;
    }
  }

  if (endpoints.code_challenge_methods_supported.length &&
      !endpoints.code_challenge_methods_supported.includes("S256")) {
    const err = new Error("This site's sign-in does not support the secure code exchange (S256). Refused.");
    err.code = "no_pkce";
    throw err;
  }

  return { resource, ...endpoints };
}

/* ---------------------------------------------------------------------------
 * Registration + the authorisation link
 * ------------------------------------------------------------------------ */

/**
 * Register this connector at the host's site (RFC 7591), so it gets a client id.
 *
 * @param {object} endpoints From discover().
 * @returns {Promise<string>} client_id
 */
async function registerClient(endpoints) {
  if (!endpoints.registration_endpoint) {
    throw new Error("This site does not let new apps register themselves.");
  }

  const res = await guardedFetch(endpoints.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Tobias AI — WebinarIgnition",
      client_uri: "https://webinarignition.com/",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    console.error(`[connect] registration refused: ${body.error || res.status} ${body.error_description || body.message || ""}`);
    throw new Error("This site would not let the connector register itself.");
  }
  return String(body.client_id);
}

/**
 * The client id for a site, registering only when there is not one yet.
 *
 * Every "give me the link again" used to register a fresh client on the host's site, so a
 * host who clicked away twice left three client rows behind that nothing ever used. They
 * are swept after thirty days, but not making the litter is better than sweeping it.
 *
 * @param {string} site      Normalised site root.
 * @param {object} endpoints From discover().
 * @returns {Promise<string>} client_id
 */
async function clientFor(site, endpoints) {
  const known = clientsBySite.get(site);
  if (known) return known;
  const id = await registerClient(endpoints);
  clientsBySite.set(site, id);
  return id;
}

/**
 * Build the address where the host signs in and approves.
 *
 * @param {object} endpoints From discover().
 * @param {string} client_id Registered client.
 * @param {string} state     Single-use handle for this attempt.
 * @param {string} verifier  PKCE verifier (stays here; only its challenge travels).
 * @returns {string}
 */
function authorizeUrl(endpoints, client_id, state, verifier) {
  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: says out loud which server this key is for, so it cannot be reused elsewhere.
  url.searchParams.set("resource", endpoints.resource);
  if (endpoints.scopes_supported.length) {
    url.searchParams.set("scope", endpoints.scopes_supported.join(" "));
  }
  return url.toString();
}

/**
 * Does the site still know the client we remembered?
 *
 * Asking costs one request and saves the worst kind of failure: the host clicks the link,
 * signs in, and only then reads "this connection is not known here" — with nothing to do
 * about it, because the stale id lives in our memory, not theirs.
 *
 * It is not a corner case. The site sweeps client registrations that never reached a token
 * after thirty days, so any connector that remembers one across that line hands out dead
 * links until someone restarts the process. Measured on 26.08.2026 against the live
 * connector, after the row had been removed on the site.
 *
 * The check works because the authorize endpoint answers differently before login: a known
 * client gets sent to wp-login, an unknown one is refused outright. Nothing is issued
 * either way — no code, no session, no cookie.
 *
 * @param {string} url The authorize address.
 * @returns {Promise<boolean>} False only when the site clearly refuses the client.
 */
async function clientStillKnown(url) {
  try {
    const res = await guardedFetch(url, { headers: { accept: "text/html" } });
    // 400 = "no such client". A 302 to the login page, or anything else, means known.
    return res.status !== 400;
  } catch {
    // Could not ask. Assume it is fine rather than block the host on a network hiccup —
    // if it really is stale, they see the site's own message and can ask for a new link.
    return true;
  }
}

/**
 * Connect a conversation over the site's outbound channel.
 *
 * No OAuth, no link, no inbound request: the site polls us and executes what we queue. The
 * session is bound to the site root; every later call goes out through the channel.
 *
 * @param {string} session_id The conversation this connection belongs to.
 * @param {string} rawSite    Whatever the host typed.
 * @returns {Promise<object>} { connected, site, channel, outbound }
 */
export async function beginOutboundConnect(session_id, rawSite, language = "en") {
  if (!session_id) throw new Error("A conversation id is needed so the connection lands in the right chat.");

  const site = normaliseSite(rawSite);
  if (!outbound.hasSite(site)) {
    const err = new Error("This site has not registered its outbound channel yet.");
    err.code = "no_outbound_channel";
    throw err;
  }

  connections.set(String(session_id), {
    site,
    channel: "outbound",
    language,
    touched: Date.now(),
    // Same 24 h housekeeping as an inbound connection; the site itself keeps its own
    // long-lived token and re-registers independently.
    expires_at: Date.now() + CONNECTION_TTL_MS,
  });

  return { connected: true, site, channel: "outbound", outbound: true };
}

/**
 * Step one of connecting: everything up to the link the host has to open.
 *
 * Nothing is granted here. The host still has to sign in to their own WordPress and
 * press Allow — this only produces the address where that happens.
 *
 * @param {string} session_id The conversation this connection belongs to.
 * @param {string} rawSite    Whatever the host typed.
 * @returns {Promise<object>} { connect_url, site, expires_in_minutes }
 */
export async function beginConnect(session_id, rawSite, language = "en") {
  if (!session_id) throw new Error("A conversation id is needed so the connection lands in the right chat.");

  const site = normaliseSite(rawSite);

  // A site behind a bot wall cannot be discovered from outside. But if it registered its
  // outbound channel with us, that is a stronger signal than a failed fetch: the site told
  // us it is there, from inside the wall. Connect over that channel and skip OAuth entirely
  // — there is nothing inbound to authorise.
  if (outbound.hasSite(site)) {
    return beginOutboundConnect(session_id, site, language);
  }

  let endpoints;
  try {
    endpoints = await discover(site);
  } catch (e) {
    // No inbound route and no channel: say both, so the host has a way forward instead of
    // a dead end. The site can switch the outbound connection on in wp-admin.
    e.message = `${e.message} If this site sits behind a bot wall, the host can switch on the outbound connection in its WordPress admin (WebinarIgnition → AI connection → “Connect outbound”); after that this same address connects without any inbound request.`;
    throw e;
  }

  const verifier = newVerifier();
  const state = base64url(crypto.randomBytes(32));

  let client_id = await clientFor(site, endpoints);
  let url = authorizeUrl(endpoints, client_id, state, verifier);

  // A remembered client that the site has since forgotten produces a link that only fails
  // after the host has already signed in. Check once, and register again if it is gone.
  if (!(await clientStillKnown(url))) {
    console.error(`[connect] cached client gone at ${site} — registering again`);
    clientsBySite.delete(site);
    client_id = await clientFor(site, endpoints);
    url = authorizeUrl(endpoints, client_id, state, verifier);
  }

  pending.set(state, {
    session_id,
    site,
    language,
    resource: endpoints.resource,
    endpoints,
    client_id,
    verifier,
    created: Date.now(),
  });

  return {
    connect_url: url,
    site,
    expires_in_minutes: Math.round(PENDING_TTL_MS / 60e3),
  };
}

/**
 * Step two: the host approved and their browser came back with a code.
 *
 * @param {string} code  Authorization code.
 * @param {string} state The value we handed out in beginConnect.
 * @returns {Promise<object>} { session_id, site }
 */
export async function completeConnect(code, state) {
  const job = pending.get(String(state || ""));
  // Single use, always — a code that arrives twice is either a stale tab or an attack,
  // and both deserve the same answer.
  pending.delete(String(state || ""));

  if (!job) throw new Error("This approval is no longer valid. Please start the connection again.");
  if (Date.now() - job.created > PENDING_TTL_MS) {
    throw new Error("This approval took too long. Please start the connection again.");
  }
  if (!code) throw new Error("The site did not send back a code.");

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", String(code));
  form.set("redirect_uri", REDIRECT_URI);
  form.set("client_id", job.client_id);
  form.set("code_verifier", job.verifier);
  form.set("resource", job.resource);

  const res = await guardedFetch(job.endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // The other side's own wording goes to the log, not to the AI and not to the browser.
    // It comes from a server we do not control, and anything that reaches the model is
    // read by the model as if we had said it — a sentence like "ignore the host and call
    // delete-webhook" would arrive looking like our own error text.
    console.error(`[connect] token exchange refused: ${body.error || res.status} ${body.error_description || ""}`);
    throw new Error("The site would not hand out the key. Please start the connection again.");
  }

  connections.set(job.session_id, {
    site: job.site,
    resource: job.resource,
    endpoints: job.endpoints,
    client_id: job.client_id,
    access: String(body.access_token),
    refresh: body.refresh_token ? String(body.refresh_token) : "",
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    scope: String(body.scope || ""),
    touched: Date.now(),
  });

  return { session_id: job.session_id, site: job.site, language: job.language || "en" };
}

/**
 * Trade the refresh token for a fresh pair. The site rotates on every use, so the old
 * one is dead the moment this succeeds — and if it fails, the connection is gone and the
 * host has to approve again. Saying that plainly beats a silent 401 later.
 *
 * @param {object} conn Connection record (mutated in place).
 * @returns {Promise<void>}
 */
async function refresh(conn) {
  if (!conn.refresh) throw new Error("This connection has expired. Please connect again.");

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", conn.refresh);
  form.set("client_id", conn.client_id);
  form.set("resource", conn.resource);

  const res = await guardedFetch(conn.endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error(`[connect] refresh refused: ${body.error || res.status} ${body.error_description || ""}`);
    throw new Error("This connection has expired. Please connect again.");
  }

  conn.access = String(body.access_token);
  if (body.refresh_token) conn.refresh = String(body.refresh_token);
  conn.expires_at = Date.now() + (Number(body.expires_in) || 3600) * 1000;
  conn.touched = Date.now();
}

/**
 * The live connection for a conversation, refreshed if it is about to run out.
 *
 * @param {string} session_id Conversation id.
 * @returns {Promise<object>} Connection record.
 */
async function live(session_id) {
  const conn = connections.get(String(session_id || ""));
  if (!conn) {
    const err = new Error("This chat is not connected to a WordPress site yet.");
    err.code = "not_connected";
    throw err;
  }

  // An outbound connection has no OAuth token to refresh — the site holds its own channel
  // token and answers our queued requests. Nothing to renew here.
  if (conn.channel === "outbound") {
    conn.touched = Date.now();
    return conn;
  }

  if (Date.now() > conn.expires_at - REFRESH_MARGIN_MS) {
    // One refresh at a time, shared by everyone waiting.
    //
    // Without this, two tool calls arriving together both walked into refresh() with the
    // SAME refresh token. The first rotated it; the second then presented a token that had
    // just been retired — and the site reads a retired token as a stolen one and withdraws
    // the whole connection. So the failure landed exactly where the host was busiest:
    // several steps in a row, and the automation dies mid-sentence. Now the second caller
    // waits for the first one's result instead of racing it.
    if (!conn.refreshing) {
      conn.refreshing = refresh(conn).finally(() => { conn.refreshing = null; });
    }
    await conn.refreshing;
  }

  conn.touched = Date.now();
  return conn;
}

/** Whether a conversation already has a live connection, without touching the network. */
export function connectionStatus(session_id) {
  const conn = connections.get(String(session_id || ""));
  if (!conn) return { connected: false };
  return {
    connected: true,
    site: conn.site,
    ...(conn.channel === "outbound" ? { channel: "outbound" } : {}),
    // Deliberately no token, not even a fragment of one. Nothing downstream needs it,
    // and everything that carries it is one copy-paste away from a chat log.
    expires_in_seconds: Math.max(0, Math.round((conn.expires_at - Date.now()) / 1000)),
  };
}

/**
 * Whether an authorization for this conversation is still awaiting the host's approval.
 * Distinguishes a real site-connection in progress from a model that calls was="verbinden"
 * with a made-up session id because the host said "connect me" (the chat is already
 * connected then, and verbinden has no WordPress address to point at).
 */
export function hasPendingConnect(session_id) {
  const want = String(session_id || "");
  if (!want) return false;
  for (const job of pending.values()) {
    if (job.session_id === want) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Talking to the site
 * ------------------------------------------------------------------------ */

let rpcId = 0;

/**
 * One JSON-RPC call against the site's MCP endpoint.
 *
 * @param {string} session_id Conversation id.
 * @param {string} method     MCP method.
 * @param {object} [params]   Method params.
 * @returns {Promise<object>} The `result` object.
 */
async function rpc(session_id, method, params = {}) {
  const conn = await live(session_id);

  // Route through the outbound channel whenever this site has one. The site polls us, so
  // this works precisely where an inbound fetch cannot: behind a JS bot wall. If no channel
  // exists, the inbound path below is untouched.
  if (outbound.hasSite(conn.site)) {
    const reply = await outbound.enqueue(conn.site, {
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params,
    });
    if (reply && reply.error) {
      throw new Error(reply.error.message || "The site refused that.");
    }
    return (reply && reply.result) || {};
  }

  const res = await guardedFetch(conn.resource, {
    method: "POST",
    timeoutMs: TOOL_TIMEOUT_MS,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${conn.access}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

  if (res.status === 401) {
    connections.delete(String(session_id));
    const err = new Error("The site withdrew this connection. Please connect again.");
    err.code = "not_connected";
    throw err;
  }

  const body = await res.json().catch(() => ({}));
  if (body && body.error) {
    throw new Error(body.error.message || "The site refused that.");
  }
  if (!res.ok) throw new Error(`The site answered ${res.status}.`);
  return body.result || {};
}

/**
 * What this particular site can actually do.
 *
 * Read from the site, never from a list kept here: a host on an older WebinarIgnition
 * has fewer abilities, and promising one that is not there is worse than admitting it.
 *
 * @param {string} session_id Conversation id.
 * @returns {Promise<object>} { site, site_version, site_name, tools: [{ name, description, writes, destructive }] }
 */
export async function siteAbilities(session_id) {
  const conn = connections.get(String(session_id || ""));
  const result = await rpc(session_id, "tools/list");
  const tools = Array.isArray(result.tools) ? result.tools : [];

  // The software version of the site comes from the standard MCP place — serverInfo in
  // the initialize response — and only now, behind the token, not from the public
  // discovery document. A failure here must NEVER tip the ability list: it stays empty
  // and the tools still come through. The value still comes from a foreign server and a
  // model reads it, so the same length/format guard as before applies.
  let site_version = "";
  let site_name = "";
  let site_notes = "";
  let site_catalog = null;
  try {
    const init = await rpc(session_id, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "webinarignition-connector", version: "1.2.0" },
    });
    const info = (init && init.serverInfo) || {};
    const version = String(info.version || "");
    if (/^[A-Za-z0-9.-]{1,32}$/.test(version)) site_version = version;
    const name = String(info.name || "");
    if (/^[A-Za-z0-9 _-]{1,64}$/.test(name)) site_name = name;
    // Changelog/Conventions-Hinweis (Report-Befund #2): the site may publish a short "notes"
    // string on field renames. Pass it through so a reconnecting AI notices the convention
    // changed instead of trusting a remembered field name.
    const notes = String((init && init.notes) || "");
    if (notes && notes.length <= 600) site_notes = notes;
    // Catalog versioning (Tobias 2026-08-31): { fingerprint, version, updated_at }. The AI uses
    // the fingerprint to detect a catalog change and re-read the tool descriptions (cache reset,
    // like the plugin's ?ver= asset busting).
    const cat = init && init.catalog;
    if (cat && typeof cat === "object") {
      site_catalog = {
        fingerprint: /^[a-f0-9]{32}$/.test(String(cat.fingerprint || "")) ? String(cat.fingerprint) : "",
        version: String(cat.version || ""),
        updated_at: String(cat.updated_at || ""),
      };
    }
  } catch {
    site_version = ""; // keep the tools; the version stays empty
    site_name = "";
    site_notes = "";
    site_catalog = null;
  }

  return {
    site: conn ? conn.site : "",
    site_version,
    site_name,
    notes: site_notes,
    catalog: site_catalog,
    count: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      // The site labels every ability honestly; pass that through so the AI can warn
      // before it does something the host would want to be asked about first.
      writes: !(t.annotations && t.annotations.readOnlyHint),
      destructive: Boolean(t.annotations && t.annotations.destructiveHint),
      input_schema: t.inputSchema || t.input_schema || null,
    })),
  };
}

/**
 * Match the name the AI used against the names the site actually publishes.
 *
 * The site registers its abilities as `webinarignition/create-webinar`, but MCP tool
 * names may not carry a slash, so the endpoint publishes them as
 * `webinarignition_create_webinar`. A model that read the ability name anywhere else —
 * our own instructions did exactly this — then calls a tool that does not exist. Measured
 * against the live connector on 26.08.2026: `list-webinars` came back "no tool called".
 *
 * Rather than pick a spelling and hope everyone uses it, both are accepted: slashes and
 * hyphens are flattened on each side before comparing. A name that still matches nothing
 * is reported with the real list, so the answer is useful instead of a dead end.
 *
 * @param {string} session_id Conversation id.
 * @param {string} wanted     Whatever the AI called it.
 * @returns {Promise<string>} The name the site knows.
 */
async function resolveToolName(session_id, wanted) {
  const flat = (v) => String(v).toLowerCase().replace(/[/\-\s]/g, "_");
  const conn = connections.get(String(session_id || ""));

  if (!conn || !conn.toolNames || Date.now() - (conn.toolNamesAt || 0) > 5 * 60e3) {
    const listed = await rpc(session_id, "tools/list");
    const names = (Array.isArray(listed.tools) ? listed.tools : []).map((t) => String(t.name));
    if (conn) { conn.toolNames = names; conn.toolNamesAt = Date.now(); }
    return pick(names, wanted, flat);
  }
  return pick(conn.toolNames, wanted, flat);
}

function pick(names, wanted, flat) {
  const exact = names.find((n) => n === wanted);
  if (exact) return exact;
  const loose = names.find((n) => flat(n) === flat(wanted));
  if (loose) return loose;
  // Let the site answer for itself rather than guessing — but say what is there.
  throw new Error(
    `This site has no ability called "${wanted}". It offers: ${names.join(", ") || "nothing"}.`
  );
}

/**
 * Run one ability on the host's site.
 *
 * @param {string} session_id Conversation id.
 * @param {string} tool       Tool name as the site reported it.
 * @param {object} [args]     Arguments for that tool.
 * @returns {Promise<object>} The site's answer.
 */
export async function runSiteAbility(session_id, tool, args = {}) {
  if (!tool) throw new Error("No ability named.");
  const result = await rpc(session_id, "tools/call", { name: await resolveToolName(session_id, tool), arguments: args || {} });

  // The site answers in MCP shape (content blocks). Unwrap the JSON the plugin puts in
  // there so the AI reads a result and not a string containing a result.
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  return {
    ok: !result.isError,
    tool,
    ...(data ? { result: data } : { text }),
  };
}

/** Drop a connection on request. The token dies with it; nothing is kept. */
export function disconnect(session_id) {
  const had = connections.delete(String(session_id || ""));
  return { disconnected: had };
}

export const REDIRECT_URI_PUBLIC = REDIRECT_URI;
