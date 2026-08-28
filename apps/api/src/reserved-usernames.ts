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
	"abuse",
	"auth",
	"compare",
	"copyright",
	"creator-terms",
	"dashboard",
	"demo-creator-breakdown",
	"demo-creator-page",
	"demo-infrastructure",
	"demo-user",
	"desktop",
	"discover",
	"basket",
	"faq",
	"feed",
	"finish",
	"for-creators",
	"for-users",
	"jams",
	"library",
	"login",
	"parents",
	"posts",
	"privacy",
	"purchases",
	"resources",
	"roadmap",
	// A single letter, and the shortest route on the platform: `/s/:token` is where a share
	// link lands. Short on purpose — the URL carries no Work id, slug or username, so pasting
	// it reveals nothing until somebody follows it — which is exactly what makes the segment
	// worth reserving.
	"s",
	"safety",
	"settings",
	"signup",
	"site-gate",
	"subscribe",
	"subscription",
	"terms",
	"verify-email",
	// Onboarding. Reserved with a sharper edge than the rest of this list: it is the
	// route a handle-less account is sent to, so claiming it would let someone strand
	// every *future* pending account — and their own profile — behind a name the router
	// answers first.
	"welcome",
	"wiki",
	"works",
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

/**
 * The shape an official Anthers account takes: `anthers-{person}`, on an
 * `@anthers.org` address (Parker, 2026-08-25).
 *
 * 🚨 **The convention is the reason this has to be enforced, not a reason it does not.**
 * The point of the prefix is that an account carrying it is the organization speaking
 * rather than a person who helps out — so the moment it means something to a reader, an
 * unreserved `@anthers-support` becomes a way to be believed. A signal anyone can mint is
 * worse than no signal, because it borrows the credibility of the real ones.
 *
 * Both separators are held, because `anthers_support` reads exactly as official as
 * `anthers-support` and the username charset allows either. ⚠️ **What is deliberately
 * NOT held is the run-on form** — `anthersfan` and `anthersenjoyer` stay available,
 * because this is a platform for creators and a community name is a legitimate thing to
 * want. The residue is that `antherssupport` is still claimable; the trade is that
 * blocking every name beginning with the word would cost real people real handles to
 * close a gap that does not match the convention it is imitating. Widen this if that
 * turns out to be the wrong call — it is one string.
 */
const STAFF_PREFIXES = ["anthers-", "anthers_"];

/**
 * Official handles we have deliberately issued, which the prefix rule must not block.
 *
 * ⚠️ **A name on this list is claimable through ordinary signup**, which is exactly how
 * it is meant to be used: we add the line, the person signs up, and uniqueness protects
 * the name from then on. The hazard is the other end — **leaving a name here after its
 * holder is gone re-opens it to anybody**, so removing the line is part of offboarding
 * rather than tidying afterwards.
 */
const ISSUED_STAFF_USERNAMES = ["anthers-parker"];

/** Lower-cased for case-insensitive comparison — see the note on `/About` above. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(
	[...ROUTE_NAMES, ...INFRASTRUCTURE_NAMES, ...LOCALE_NAMES].map((name) => name.toLowerCase()),
);

export function isReservedUsername(candidate: string): boolean {
	const name = candidate.trim().toLowerCase();
	// An issued handle is checked FIRST, so the prefix rule cannot block the very
	// accounts the prefix exists to mark.
	if (ISSUED_STAFF_USERNAMES.includes(name)) return false;
	if (RESERVED_USERNAMES.has(name)) return true;
	return STAFF_PREFIXES.some((prefix) => name.startsWith(prefix));
}
