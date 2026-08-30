// SPDX-License-Identifier: AGPL-3.0-or-later

// The logged-out surface, and the phone width it has to fit in.
//
// This module holds the list once because two things consume it: the e2e gate
// (`tests/e2e/mobile-overflow.e2e.ts`, which fails a run) and the diagnostic script
// (`scripts/mobile-overflow.ts`, which names the offending elements and screenshots
// them). A route added to one list and not the other is a page nobody measures, and
// nothing would say so — the same reasoning `playwright.config.ts` gives for keeping
// `metadata.needsMedia` in one place rather than as two lists in `ci.yml`.
//
// It is data only, with no side effects, so the spec can import it without booting the
// server the script starts at module scope.

/**
 * The width to measure at. 390px is the iPhone 12/13/14 logical width and the narrowest
 * viewport worth designing for; anything that fits here fits the phones above it.
 */
export const MOBILE_WIDTH = 390;

/**
 * Every route a logged-out visitor can reach, which is the whole surface this can check —
 * a signed-in page needs a session the `chromium` project deliberately does not have.
 *
 * ⚠️ `/signup` is deliberately absent: it is a `<Navigate>` to `/subscribe`, so including
 * it would measure the same page twice and read as coverage of a route that renders
 * nothing of its own.
 */
export const MOBILE_ROUTES = [
	"/",
	"/for-creators",
	"/about",
	"/faq",
	"/parents",
	"/roadmap",
	"/compare/itch-io",
	"/compare/ghost",
	"/resources",
	"/resources/pay-comparison",
	"/resources/video-storage",
	"/resources/creator-monetization",
	"/subscribe",
	"/login",
	"/privacy",
	"/terms",
	"/creator-terms",
	"/copyright",
];
