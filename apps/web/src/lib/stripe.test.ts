// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stripe.js must load with advanced fraud detection OFF.
 *
 * Anthers claims it does not fingerprint devices and does not let its payment processor do
 * it either. That claim rests on exactly one line — `loadStripe.setLoadParameters({
 * advancedFraudSignals: false })` in `lib/stripe.ts` — and the claim is published, so the
 * line needs something watching it. Removing it or flipping it to `true` silently restores
 * device-characteristic and activity-indicator collection for everyone who reaches a
 * payment surface, with nothing failing and no error anywhere. That is the same shape as
 * the defect this whole area exists because of: until 2026-08-09 Stripe.js loaded on every
 * route for every visitor, and nothing in the repository noticed.
 *
 * 🚨 **Be exact about what this proves, because it is less than it looks.** This is a
 * source-text assertion. It proves the call is written and its argument is `false`. It does
 * NOT observe a browser, so it cannot prove the injected script really carries the flag —
 * that mapping belongs to `@stripe/stripe-js`, whose `dist/pure.js` builds the URL as
 * `V3_URL + (params && !params.advancedFraudSignals ? "?advancedFraudSignals=false" : "")`.
 * That is deterministic and the version is pinned exactly, so the residual risk is a major
 * upgrade changing the contract rather than drift in our own code.
 *
 * ⚠️ **The behavioral guard is owed and is not this.** It wants a browser on a real payment
 * surface asserting the script URL carries the flag and that nothing reaches `m.stripe.com`
 * or `m.stripe.network` — and it cannot be written today, because **no browser spec reaches
 * the payment modal at all**: the signup suite deliberately stops before code verification,
 * and the gauntlet hops billing states rather than entering checkout. It lands with the
 * Roadmap's *Test Gauntlets* item 4, the `GAUNTLET_STRIPE=1` walk, which is the change that
 * first drives the real payment UI. An attempt to write it against the static preview was
 * removed rather than left passing, because it could only ever have asserted the absence of
 * a script that was never going to load.
 */
describe("Stripe.js load parameters", () => {
	const source = readFileSync(join(import.meta.dir, "stripe.ts"), "utf8");

	it("configures advanced fraud signals off before any load", () => {
		// Whitespace-tolerant, so a formatter reflowing the call cannot silently defeat this
		// — a sabotage that matches nothing is indistinguishable from a test that proves
		// nothing, and this file is small enough that the tolerant form costs nothing.
		expect(
			source,
			"lib/stripe.ts no longer disables Stripe's advanced fraud signals. That turns " +
				"device and activity fingerprinting back on for everyone who reaches a payment " +
				"surface, and the privacy policy says it is off. If this is deliberate, change " +
				"the policy in the same commit — the claim is the reason the flag exists.",
		).toMatch(/setLoadParameters\(\s*{\s*advancedFraudSignals:\s*false\s*,?\s*}\s*\)/);

		expect(source, "advanced fraud signals were switched ON in lib/stripe.ts").not.toMatch(
			/advancedFraudSignals:\s*true/,
		);
	});

	it("uses the /pure entry, which is what makes the flag reachable at all", () => {
		// The main entry injects Stripe.js as a side effect of being imported, so there is no
		// moment at which `setLoadParameters` could run first — it throws if a script already
		// exists. `/pure` is therefore load-bearing for the fraud-signal setting as well as
		// for keeping Stripe off non-payment routes.
		expect(source).toContain('from "@stripe/stripe-js/pure"');

		// ⚠️ **`import type` from the main entry is fine and must not be flagged.** A type
		// import is erased at build time and carries no side effect, so the thing to forbid
		// is a *value* import — which is what actually evaluates the module and injects the
		// script. Written the other way this test failed on the correct code, which is the
		// more expensive direction to be wrong in: it teaches the next person to loosen it.
		const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map(
			(m) => m[1],
		);
		expect(valueImports, "the side-effecting main entry is back").not.toContain(
			"@stripe/stripe-js",
		);
	});
});
