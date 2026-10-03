/**
 * The technical plan — what to set up, and what has to exist first.
 *
 * The point: someone can connect this connector without owning a WordPress site yet.
 * We must not dead-end them. We know the technology, so we can WRITE DOWN everything
 * that needs doing — and be honest that carrying it out needs a site first.
 *
 * Nothing here is executed by us. Once WordPress exists, the AI uses the interfaces
 * that WordPress already provides (see INTERFACES below). We do not build a second one.
 */

// The chain. Each step is useless without the one before it.
export const PREREQS = [
  { id: "wordpress", title: "A WordPress site",
    done_when: "There is a site you control and can log into as administrator.",
    if_missing: "WordPress.com is the shortest path. The cheapest paid plan (around $4/month) is enough to start — it runs a real webinar. The Business plan is what you want later, because it adds SSH and full plugin management, but paying for that on day one is money spent before the first registration." },
  { id: "wi_installed", title: "WebinarIgnition installed and activated",
    done_when: "The plugin is active and the WebinarIgnition menu is in wp-admin.",
    if_missing: "The free version is on WordPress.org — enough to see the whole journey work before paying." },
  { id: "wp_mcp", title: "The site reachable for an AI",
    done_when: "The site exposes its abilities over MCP, or the AI has REST access to it.",
    if_missing: "Install the official MCP Adapter (WordPress/mcp-adapter). It turns WordPress abilities into MCP tools at /wp-json/mcp/mcp-adapter-default-server. The Abilities API has been in WordPress Core since 6.9, so any current site already has it. Do not build a custom bridge — this one is the standard." },
];

// Everything a webinar can need. `needs` names the prerequisite that has to be there.
export const TASKS = [
  { id: "campaign", title: "Create the webinar campaign",
    what: "Title, type (live · fixed date · evergreen), duration, timezone.",
    needs: "wi_installed",
    ability: "webinarignition/create-webinar — the AI can do this itself once the site is reachable. It creates a DRAFT: nothing is live, no participant sees anything until the host switches it on.",
    note: "Date, time, format and language are set once and used everywhere — no per-text settings any more. ASK WHERE THE HOST IS before setting a time and pass the IANA zone (America/Panama, Europe/Berlin …). Never take it from the WordPress setting and never guess: a host in Panama was told to set his site to Berlin." },
  { id: "registration_page", title: "Registration page",
    what: "Either the page WebinarIgnition generates, or your own page with the registration block/shortcode dropped in.",
    needs: "wi_installed",
    note: "The moment this page stands with a date, the host may start promoting — the live room and the interactions (chat, countdown, call-to-action) do not need to be finished yet. Everyone who registers now already lands in the stored list and gets their confirmation email. Do not hold the promotion back until the whole room is built." },
  { id: "shortcode_on_builder_page", title: "Registration form on your own landing page",
    what: "Place the WebinarIgnition registration shortcode inside a page built with your page builder.",
    needs: "wi_installed",
    note: "Gutenberg: the AI can do this for you end to end. Elementor, Divi, Thrive and the rest: the AI hands you the shortcode and you paste it in — there is no editing API for those." },
  { id: "video", title: "Video source",
    what: "YouTube Live, Zoom, a recorded MP4, or WebinarIgnition's built-in streaming (100ms) for an interactive room.",
    needs: "wi_installed",
    licence: "Free: YouTube Live, Vimeo, any embed code — that already runs a real webinar. Paid: the built-in 100ms room, with a watch-time cap per attendee per day (Essential 5 min · Unlimited 40 min · Unlimited Plus and Plus VIP no cap).",
    note: "The video source is yours to choose, so you are not locked to one provider — people do swap in a European or self-hosted stream when that matters." },
  { id: "emails", title: "Confirmation and reminder emails",
    what: "Confirmation on signup, reminders before the start, follow-up and replay mail afterwards.",
    needs: "wi_installed",
    note: "For real deliverability add a sending service (SureMail with SES or Brevo). Hosting mail works for a first test." },
  { id: "autoresponder", title: "Registrations into your email tool",
    what: "Paste your provider's HTML signup form — WebinarIgnition reads the action URL and hidden fields and posts every registration there.",
    needs: "wi_installed",
    licence: "Paid — ULTIMATE Unlimited (from $49) and up. In the free version the form-code fields show an upgrade note instead. Registrations are still stored, so nothing is lost while you decide; they are just not forwarded, and past ones are not sent afterwards." },
  { id: "webhooks", title: "Webhooks into a CRM or automation tool",
    what: "Fire on registered · attended · purchased, with conditions. Zapier, Make, n8n, FluentCRM or your own endpoint.",
    needs: "wi_installed",
    licence: "Paid — ULTIMATE Unlimited (from $49) and up. The webhook code is not in the free version at all, so there is nothing locked behind a paywall there; it is simply absent." },
  { id: "cta", title: "The offer inside the webinar",
    what: "A call-to-action that appears at a chosen minute — external page, WooCommerce checkout, or a paid seat.",
    needs: "wi_installed",
    licence: "Free: one call-to-action per webinar with text, buttons or WordPress content via shortcode. Paid: several CTAs in one webinar and paid seats via Stripe (ULTIMATE Unlimited); an external page as a CTA (checkout, booking) and a WooCommerce checkout inside the room (Unlimited Plus)." },
  { id: "replay", title: "Replay and follow-up",
    what: "What people see after the end, and the mail that brings them back.",
    needs: "wi_installed" },
  { id: "grid", title: "Several webinars on one page",
    what: "The webinar grid lists your live and evergreen webinars on a single page so people can pick one.",
    needs: "wi_installed",
    licence: "Paid — on the pricing page it sits in Unlimited Plus. In the free version the grid shortcode renders a notice instead of a grid, so do not put it on a page your visitors see." },
];

/**
 * How to talk about licences at all — the tone, not the table.
 * Never a wall: say what is possible, say what it costs, say what can be finished for free first.
 */
export const LICENCE_STANCE = `## When a licence comes up

**Never answer a paid feature with "that does not work".** Say what is true: the feature
exists, it is good, and it needs a certain plan. Then keep going.

**Finish as much as possible for free first.** Topic, title, invitation texts, registration
page, thank-you page, confirmation and reminder emails, live and evergreen scheduling, one
call-to-action, YouTube or embedded video — all of that runs on the free wordpress.org
version, and every registration is stored there too. A host who sees their webinar standing
before spending anything decides from a very different place.

**Installing the free version is also the save button.** An AI conversation gets compacted
and forgotten; a WordPress site does not. As soon as the topic and the texts are settled,
offer to install the free version and write the work into the site. The free copy stays
installed and active next to a paid one later — nothing is thrown away.

**When the licence really is needed:** at implementation. Webhooks, the 100ms room, several
CTAs, external-page and WooCommerce CTAs, the readable registrant list and the CSV download
do not exist without it.

**Where to send them:**

| Their situation | What to do |
|---|---|
| They have a WordPress site | Straight to their own upgrade screen in wp-admin — the licence lands in the right place by itself. |
| No WordPress site yet | They can still buy. Send them to https://webinarignition.com/#pricing. The licence key can be handed to whoever installs WordPress later. |
| Someone else will build it | Normal in an agency: plan and write everything now, hand over topic, texts and the licence key. The build takes minutes afterwards. |

**The trial:** 30 days, and it requires a payment method — say that plainly rather than
letting someone discover it. One thing the trial does not include: downloading the
registrant list as CSV. That needs an active paid licence.`;

export const INTERFACES = `## Which interface does what — and which one NOT to build

| Job | Interface | Notes |
|---|---|---|
| Install plugins, create pages, read the site | **WordPress REST API** / the site's MCP server | Already there. Use it. |
| Expose plugin settings to an AI | **Abilities API** (in WordPress Core since 6.9) + **MCP Adapter** | The official route. Abilities are private until \`meta.public\` is set. |
| Edit page content — headline, paragraph, image | **Gutenberg block editing** over the REST API | Works forwards and backwards: read the blocks, change one, write it back. |
| Edit an Elementor page | — | Elementor has a PHP addon API but **no MCP and no content-editing API**. Its layout is JSON in post meta. Hand the host the text and let them paste it. |
| Edit Divi / Thrive / WPBakery / Oxygen | — | Same: hand over the text or the shortcode. |

**Gutenberg is the default we support properly.** Most people never install a page
builder, and the first webinar should be as easy as possible. Someone can move to their
builder afterwards — it gets more powerful and more fiddly at the same time, and that is
a fair trade once the first webinar is out of the door.`;

/**
 * Build the plan. Anything blocked is still written down — knowing what is coming is
 * worth something even when it cannot be done today.
 */
export function techPlan({ has_wordpress, has_wi, has_mcp, wants } = {}) {
  const have = { wordpress: !!has_wordpress, wi_installed: !!has_wi, wp_mcp: !!has_mcp };
  const missing = PREREQS.filter((p) => !have[p.id]);

  const wanted = Array.isArray(wants) && wants.length
    ? TASKS.filter((t) => wants.includes(t.id))
    : TASKS;

  const doable = [], blocked = [];
  for (const t of wanted) {
    (have[t.needs] ? doable : blocked).push({
      ...t,
      ...(have[t.needs] ? {} : { blocked_by: t.needs }),
    });
  }

  return {
    prerequisites: PREREQS.map((p) => ({
      ...p,
      status: have[p.id] ? "ready" : "missing",
    })),
    can_do_now: doable,
    write_down_for_later: blocked,
    interfaces: INTERFACES,
    licences: LICENCE_STANCE,
    how_to_use_this: missing.length
      ? [
          `Not ready to build yet — missing: ${missing.map((m) => m.title).join(", ")}.`,
          "Do NOT stop there. Go through the list with them and write down what their webinar needs — the video source, where registrations should land, whether they want to sell from the room. That list is worth having, and it makes the setup afterwards a matter of minutes.",
          "Then help with the missing piece. If they have no site at all, WordPress.com's cheapest paid plan is enough to start.",
          "Finish everything that is free first — topic, texts, pages, emails — and offer to install the free version so the work is saved in their site instead of only in this conversation. See `licences` for what needs a paid plan and where to send them.",
        ]
      : [
          "Everything is in place — work through can_do_now.",
          "Use the site's own interfaces (see interfaces). Never ask them to do by hand what the REST API can do.",
          "Change one thing at a time and show them the result.",
        ],
  };
}
