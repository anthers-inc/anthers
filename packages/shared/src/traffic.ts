// SPDX-License-Identifier: Apache-2.0
/**
 * Traffic measurement — the pure policy behind first-party, site-wide traffic and
 * audience analytics: what counts as a page view we record, whose referrer counts as
 * what, which requests are bots, and how long raw rows may live.
 *
 * This is the traffic-side sibling of `attention.ts`, and it obeys the same shape: the
 * module is pure (no clock, no DOM, no I/O) so the whole policy is exhaustively
 * testable without a browser. The database writer is `services/traffic.ts`; the browser
 * emitter is `apps/web/src/lib/traffic.ts`. Nothing here touches either.
 *
 * What this pipeline deliberately is NOT, and must never drift into:
 *
 * - **It is not attention.** Attention measures seconds on content and pays the Time
 *   Pool; traffic measures visits, referrers and paths and pays nobody. They share
 *   nothing — different tables, different endpoints, different retention — and the
 *   Roadmap's standing warning that impressions must not ride `attention_events`
 *   applies to the whole traffic family.
 * - **It is not surveillance.** A traffic row carries no user id, no account, no
 *   IP-derived visitor hash, nothing fingerprint-shaped. The one identity-like value
 *   is a client-generated, per-tab session id (in `sessionStorage`, dying with the
 *   tab) that cannot re-identify anybody and cannot follow them across sessions,
 *   devices or visits. Signed-in status is irrelevant to traffic, by design: the
 *   funnel is an aggregate, never a join.
 * - **It does not know where you are, and that is a decision, not a gap.** Cloudflare
 *   hands every request a country code derived from your IP, and stamping it at intake
 *   would be one column — but the Privacy Policy's measurement sentence holds that no
 *   IP address enters the record, and an attribute derived from your IP on every
 *   request is the one compromise that would weaken that sentence. The un-parking
 *   condition is a real creator demand signal (a creator asking where their readers
 *   are), and the day it comes it takes a policy wording pass, a column at intake, and
 *   a disclosed creator surface — never a quiet default. Until then, site-level
 *   geography is answerable from Cloudflare's own aggregate dashboards.
 */

/** How a request's referrer classifies for grouping. */
export type ReferrerSource = "direct" | "search" | "social" | "other";

/**
 * Hosts of search engines, whose referrals say "arrived from a search". Keys are the
 * registrable host; subdomains match (`www.google.com` classifies through
 * `google.com`). Data lifted from Plausible's referrer classification (Apache‑era
 * `ref_inspector` list, license-compatible), trimmed to the engines that could
 * realistically send a creator's audience; extend the list as real referrers show up.
 *
 * A referrer is classified by *host only* — never by a URL's path or query — because
 * the full referrer URL is the browser's to strip and ours to discard: query strings
 * can carry somebody's search terms, and storing them would import another site's
 * tracking data into ours.
 */
const SEARCH_HOSTS: ReadonlySet<string> = new Set([
	"google.com",
	"bing.com",
	"duckduckgo.com",
	"search.brave.com",
	"ecosia.org",
	"startpage.com",
	"qwant.com",
	"yandex.com",
	"baidu.com",
	"yahoo.com",
	"ask.com",
]);

/**
 * Hosts of social platforms, whose referrals say "arrived from a post or profile".
 * Same subdomain-matching rule; same Plausible-lifted, trimmed list. Bluesky is listed
 * first on purpose: it is where Anthers' audience is.
 */
const SOCIAL_HOSTS: ReadonlySet<string> = new Set([
	"bsky.app",
	"x.com",
	"twitter.com",
	"t.co",
	"threadreaderapp.com",
	"reddit.com",
	"youtube.com",
	"youtu.be",
	"m.youtube.com",
	"facebook.com",
	"l.facebook.com",
	"instagram.com",
	"threads.net",
	"linkedin.com",
	"tiktok.com",
	"twitch.tv",
	"pin.it",
	"pinterest.com",
	"mastodon.social",
	"tumblr.com",
	"discourse.org",
	"news.ycombinator.com",
]);

/** The longest `path` we will store for a page view. */
export const MAX_PATH_LENGTH = 2_048;
/** The longest referrer host we will store. */
export const MAX_REFERRER_HOST_LENGTH = 253;
/** The longest previous-path we will store (same cap family as MAX_PATH_LENGTH). */
export const MAX_PREVIOUS_PATH_LENGTH = 2_048;
/** The session id is a UUID the client generated this session — never trusted for identity, only for counting. */
export const MAX_SESSION_ID_LENGTH = 64;

/**
 * The host suffixes a page-view beacon may arrive from and still count as traffic to
 * *this site*. The API answers several hosts (production, branch-preview dev hosts),
 * and the admin console's pages are operator traffic, not site traffic — those are
 * excluded at intake rather than filtered at read, so a mis-routed admin request can
 * never leak into the public figures.
 */
export function isTrackedHost(host: string): boolean {
	const h = host.toLowerCase();
	return (
		h === "anthers.org" ||
		h === "www.anthers.org" ||
		(h.endsWith(".localhost") && !h.startsWith("admin."))
	);
}

/** The registrable domain of a referrer host: the last two labels, or shorter if that is all there is. */
function registrable(host: string): string {
	const parts = host.toLowerCase().split(".");
	if (parts.length <= 2) return parts.join(".");
	// A two-label public suffix (co.uk) would need the PSL; the list above has no
	// multi-label entries, so the plain last-two form is right for classification.
	return parts.slice(-2).join(".");
}

/**
 * Classify a referrer for grouping. `referrerHost` is the stored host of the
 * document.referrer (null when the browser sent none); `pageHost` is the host the
 * beacon says it is on, so a same-host referrer reads as direct — arriving inside the
 * site by entering its address is indistinguishable from a fresh direct visit, and
 * both are "direct" in every analytics convention.
 */
export function classifyReferrerSource(
	referrerHost: string | null,
	pageHost: string | null,
): ReferrerSource {
	if (!referrerHost || referrerHost === "localhost") {
		return "direct";
	}
	const ref = referrerHost.toLowerCase();
	if (pageHost && registrable(pageHost.toLowerCase()) === registrable(ref)) {
		return "direct";
	}
	const domain = registrable(ref);
	if (SEARCH_HOSTS.has(domain) || SEARCH_HOSTS.has(ref)) return "search";
	if (SOCIAL_HOSTS.has(domain) || SOCIAL_HOSTS.has(ref)) return "social";
	return "other";
}

/**
 * Whether a request's user agent is a bot, crawler or preview fetcher — traffic we
 * refuse at intake rather than inflate the numbers with. The client emitter only runs
 * from real pages, so most bots never reach the route; this filter is for the ones
 * that execute JavaScript (headless browsers, page previewers) and for direct probes.
 *
 * Matched against the lowercase UA. Deliberately broad on the automation families
 * (`headless`, `phantomjs`, `playwright`, `puppeteer`, `curl`, `wget`,
 * `python-requests`…) because a test environment's browser is the least important
 * traffic there is: an integration suite's page views should NOT count. The e2e
 * suites that assert recorded traffic set a real-browser UA for their fixture
 * sessions deliberately.
 */
const BOT_SIGNATURES: readonly string[] = [
	"bot",
	"crawl",
	"spider",
	"slurp",
	"headless",
	"phantomjs",
	"playwright",
	"puppeteer",
	"selenium",
	"lighthouse",
	"preview",
	"facebookexternalhit",
	"twitterbot",
	"discordapp",
	"slackbot",
	"telegrambot",
	"linkedinbot",
	"embedly",
	"curl",
	"wget",
	"wget2",
	"httpclient",
	"python-requests",
	"python-urllib",
	"aiohttp",
	"go-http-client",
	"java/",
	"okhttp",
	"postman",
	"insomnia",
	"node-fetch",
	"undici",
	"monitor",
	"pingdom",
	"uptimerobot",
	"statuscake",
	"site24x7",
];

export function isBotUserAgent(userAgent: string | null): boolean {
	if (!userAgent) return true;
	const ua = userAgent.toLowerCase();
	return BOT_SIGNATURES.some((sig) => ua.includes(sig));
}

/** The device class recorded with each page view — the same three-word vocabulary `attention_events.device` uses. */
export type DeviceClass = "desktop" | "mobile" | "tablet";

/**
 * Broad device class from the user agent, for the record rather than the decision —
 * nothing pays by it and nothing gates on it. Tablet is tested before mobile because
 * iPads report as both ("iPad" vs "iPhone").
 */
export function deviceClassFor(userAgent: string): DeviceClass {
	const ua = userAgent.toLowerCase();
	if (ua.includes("ipad") || ua.includes("tablet")) return "tablet";
	if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android")) return "mobile";
	return "desktop";
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * How long a raw traffic row — the only place a session id exists — may live before
 * `jobs/prune-traffic.ts` aggregates it into `traffic_daily` and deletes it.
 *
 * Thirty days, against attention's 180: attention's window is derived from the billing
 * cycle and the card-dispute window, because its rows are money evidence. A traffic
 * row is not evidence of anything owed — it is a visit — so its window is answered by
 * what the analytics actually need raw: enough to read a month's per-session flows
 * (the funnel's per-session shape) with margin, and no more. Shorter raw retention is
 * also the stronger privacy claim the Privacy Policy revision will state, so the
 * number is written once, typed nowhere in prose, and consumed by the job that
 * enforces it.
 */
export const TRAFFIC_RAW_RETENTION_DAYS = 30;
