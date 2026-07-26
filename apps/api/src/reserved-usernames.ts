// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Usernames we can't hand out, because something else already answers at that
 * URL.
 *
 * `apps/web/src/App.tsx` ends with a root-level `/:username` catch-all, so every
 * route registered ahead of it wins over a creator of the same name — and the
 * ingress in `.do/app.yaml` peels off `/api` and `/health` before the SPA sees
 * them at all. Registering one of these names isn't a conflict the user ever
 * sees: sign-up succeeds, and their profile is simply unreachable forever,
 * because `/about` renders the About page instead. Rejecting the name up front
 * is the only point at which that's fixable.
 *
 * The check is case-insensitive: React Router matches paths case-insensitively
 * by default, so `/About` hits the About page exactly as `/about` does, and a
 * user named "About" would be just as stranded as one named "about".
 *
 * KEEP IN SYNC with the routes in `apps/web/src/App.tsx` — a new root-level
 * route needs its name added here, or it silently strands anyone already
 * holding it.
 */

/**
 * Root-level path segments registered ahead of the `/:username` catch-all in
 * `apps/web/src/App.tsx`. Only the first segment matters — `/compare/ghost`
 * can't collide with a username, but `/compare` can.
 */
const ROUTE_NAMES = [
	"about",
	"auth",
	"compare",
	"dashboard",
	"demo-creator-breakdown",
	"demo-creator-page",
	"demo-infrastructure",
	"demo-user",
	"desktop",
	"discover",
	"faq",
	"feed",
	"for-creators",
	"for-users",
	"jams",
	"library",
	"login",
	"posts",
	"purchases",
	"resources",
	"roadmap",
	"settings",
	"signup",
	"site-gate",
	"subscribe",
	"subscription",
	"verify-email",
	"wiki",
];

/**
 * Names the infrastructure answers to, or that we should hold back rather than
 * let a creator impersonate. `/api` and `/health` are ingress-routed to the API
 * service; the rest are conventional reservations we'd regret giving away.
 */
const INFRASTRUCTURE_NAMES = [
	"admin",
	"anthers",
	"api",
	"assets",
	"cdn",
	"foundation",
	"health",
	"mail",
	"moderation",
	"official",
	"static",
	"studio",
	"support",
	"www",
];

/**
 * Locale tags a path-prefixed localization scheme would claim (`/es/`,
 * `/pt-BR/`). Forward-looking rather than a live bug — nothing serves these
 * today — but a name is only reclaimable before a real person owns it, and
 * sign-ups haven't opened yet. See the wiki's Localization and
 * Internationalization note for why path prefixes are the likely shape.
 *
 * The two-letter tags are already unreachable via `signUpSchema`'s 3-character
 * minimum; they're listed anyway so this stays correct if that minimum moves.
 * Deliberately NOT the full ISO 639 set: the three-letter codes collide with
 * ordinary words people would legitimately want ("art", "new", "sun", "man" are
 * all valid ISO 639-2), so this covers the locales we'd plausibly ship and their
 * regional forms, not every tag that exists.
 */
const LOCALE_NAMES = [
	// The 15 obsidian.md ships, as a sane reference target.
	"ar",
	"bn",
	"de",
	"en",
	"es",
	"fr",
	"it",
	"ja",
	"ko",
	"pl",
	"pt",
	"pt-BR",
	"ro",
	"ru",
	"sv",
	"zh",
	// Regional and script forms — the ones long enough to actually register.
	"en-GB",
	"en-US",
	"es-419",
	"es-ES",
	"es-MX",
	"fr-CA",
	"fr-FR",
	"pt-PT",
	"zh-CN",
	"zh-Hans",
	"zh-Hant",
	"zh-TW",
];

/** Lower-cased for case-insensitive comparison — see the note on `/About` above. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(
	[...ROUTE_NAMES, ...INFRASTRUCTURE_NAMES, ...LOCALE_NAMES].map((name) => name.toLowerCase()),
);

export function isReservedUsername(candidate: string): boolean {
	return RESERVED_USERNAMES.has(candidate.trim().toLowerCase());
}
