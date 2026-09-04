// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Usernames we hold back, and the only reason left to hold one back is impersonation.
 *
 * ⭐ **A username cannot collide with a page.** Profiles live at `/@name` and everything else
 * the site serves lives at `/name`, so the two namespaces do not touch: a new root route can
 * be added without reserving anything, and a person may call themselves "about" or "login"
 * without their profile becoming unreachable. `@anthers/web-shared/profile` owns that prefix
 * and `apps/web/src/App.tsx` refuses any root segment arriving without it.
 *
 * 🚨 **So do not re-introduce a route blacklist here.** What survives is the narrow case the
 * router was never involved in — a name that would let somebody be *believed*. That is a claim
 * about who is speaking rather than about where a page lives, and no URL scheme fixes it.
 *
 * The check is case-insensitive: React Router matches paths case-insensitively, so `@Admin`
 * and `@admin` reach the same profile and reserving one has to reserve the other.
 */

/**
 * Names the infrastructure answers to, or that we should hold back rather than let a creator
 * impersonate. `api` and `health` are ingress-routed to the API service at the root, and while
 * `/@api` could not reach either, a creator posting as "api" is a phishing surface rather than
 * a routing one — which is the same reason the rest are here.
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

/** Lower-cased for case-insensitive comparison — see the note on `@Admin` above. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(
	INFRASTRUCTURE_NAMES.map((name) => name.toLowerCase()),
);

export function isReservedUsername(candidate: string): boolean {
	const name = candidate.trim().toLowerCase();
	// An issued handle is checked FIRST, so the prefix rule cannot block the very
	// accounts the prefix exists to mark.
	if (ISSUED_STAFF_USERNAMES.includes(name)) return false;
	if (RESERVED_USERNAMES.has(name)) return true;
	return STAFF_PREFIXES.some((prefix) => name.startsWith(prefix));
}
