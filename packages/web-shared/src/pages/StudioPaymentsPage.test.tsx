// SPDX-License-Identifier: Apache-2.0
/**
 * The Payments tab's derivations, kept out of the component for the same reason
 * `studio-worklist.ts` is: **the failure mode is a wrong state rendered quietly** — a
 * pending account offered a link the creator has already used, or an incomplete one told
 * to wait. Nothing here reaches the network or the DOM; the browser-level coverage of the
 * page is the e2e return-path walk and the Studio routes walk.
 */
import { describe, expect, it } from "bun:test";
import type { StripeAccountStatus } from "../lib/types";
import { deriveSetupState, scheduleSentence } from "./StudioPaymentsPage";

function status(over: Partial<StripeAccountStatus> = {}): StripeAccountStatus {
	return {
		hasAccount: true,
		chargesEnabled: false,
		payoutsEnabled: false,
		onboardingComplete: false,
		detailsSubmitted: false,
		...over,
	};
}

describe("deriveSetupState", () => {
	it("reads no account at all as none", () => {
		expect(deriveSetupState(null)).toBe("none");
		expect(deriveSetupState(status({ hasAccount: false }))).toBe("none");
	});

	it("reads a fully enabled account as connected", () => {
		expect(
			deriveSetupState(
				status({ chargesEnabled: true, payoutsEnabled: true, onboardingComplete: true }),
			),
		).toBe("connected");
	});

	it("reads submitted-but-not-enabled as pending — the state that must not offer a link", () => {
		// The live cutover's defect: onboarding submitted, sync lagging, and the page
		// rendered "Complete Stripe Setup" as if the creator had done nothing.
		expect(deriveSetupState(status({ detailsSubmitted: true }))).toBe("pending");
	});

	it("reads an unstarted or held-back account as incomplete, so it gets the link", () => {
		expect(deriveSetupState(status())).toBe("incomplete");
	});
});

describe("scheduleSentence", () => {
	it("says manual in the creator's own words", () => {
		// The decided posture (2026-09-14): no schedule until the creator picks one.
		expect(scheduleSentence({ interval: "manual" })).toContain("Manual");
	});
	it("names the delay a daily schedule carries", () => {
		expect(scheduleSentence({ interval: "daily", delayDays: 2 })).toContain("2 days");
		expect(scheduleSentence({ interval: "daily", delayDays: 1 })).toContain("1 day");
		expect(scheduleSentence({ interval: "daily" })).not.toContain("undefined");
	});
	it("reads the other intervals without pretending to a delay it does not know", () => {
		expect(scheduleSentence({ interval: "weekly" })).toContain("Weekly");
		expect(scheduleSentence({ interval: "monthly" })).toContain("Monthly");
	});
	it("falls back to the raw interval rather than inventing a reading", () => {
		// An interval this build predates is Stripe's fact to show, not ours to mangle.
		expect(scheduleSentence({ interval: "something_new" })).toBe("something_new");
	});
});
