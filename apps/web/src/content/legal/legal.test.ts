// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The legal documents are published PENDING, and this is the guard on that.
 *
 * These pages were deliberately unbuilt for a week because a policy describing
 * features that don't exist is a misrepresentation the moment it is published. They
 * are servable now only because they carry **no effective date** and say plainly that
 * they are not in force — Parker's call, 2026-08-10: publish pending, date them once
 * the outstanding legal review clears.
 *
 * So `effectiveDate` is the single field that turns a draft into a representation
 * people can rely on, and the failure mode is somebody filling it in because the copy
 * looks finished — which is precisely the hazard the vault's DO-NOT-PUBLISH banner
 * named, one layer along.
 *
 * **If this test fails, do not "fix" it by updating the expectation.** It failing
 * means someone dated a document. That is either a real decision (in which case delete
 * the assertion, deliberately, in the same commit that made the decision) or an
 * accident (in which case the test just did its job).
 */
import { describe, expect, it } from "bun:test";
import { LEGAL_DOCUMENTS } from "./index.js";

describe("published legal documents", () => {
	it("🚨 carries no effective date — they are pending, not in force", () => {
		for (const [slug, doc] of Object.entries(LEGAL_DOCUMENTS)) {
			expect(`${slug}:${doc.effectiveDate}`).toBe(`${slug}:null`);
		}
	});

	it("serves the three documents the app links to", () => {
		expect(Object.keys(LEGAL_DOCUMENTS).sort()).toEqual(["creator-terms", "privacy", "terms"]);
	});

	it("carries none of the vault's internal apparatus", () => {
		// The vault copies are specifications and carry markers, a DO-NOT-PUBLISH banner
		// and a "Notes for us" section. Shipping any of that would be worse than not
		// publishing: it would tell a reader we knew the document was untrue.
		for (const doc of Object.values(LEGAL_DOCUMENTS)) {
			const text = doc.blocks.join("\n");
			expect(text).not.toContain("NOT YET BUILT");
			expect(text).not.toContain("DO NOT PUBLISH");
			expect(text).not.toContain("Notes for us");
			expect(text).not.toContain("⚠️");
		}
	});

	it('never says "watch-time" — a minute is a minute across four media', () => {
		/*
		 * 🚨 The equal-time principle, enforced where it is most likely to be broken.
		 *
		 * The privacy policy's own sentence enumerates *"play, watch, read, or listen"*
		 * and then, until 2026-08-12, called the result **watch-time** — naming one medium
		 * as the unit for a platform that hosts four, in the same breath as listing them.
		 * 63.01 made the same mistake and worse: it blessed the term while citing this
		 * principle as its authority.
		 *
		 * Nothing errors when copy drifts back, which is why this is a test rather than a
		 * style note. "watch-hour" is caught too — the free allowance is hours of Public
		 * Access, drawn down by reading and playing exactly as by watching.
		 */
		for (const doc of Object.values(LEGAL_DOCUMENTS)) {
			const text = doc.blocks.join("\n").toLowerCase();
			expect(text).not.toContain("watch-time");
			expect(text).not.toContain("watch time");
			expect(text).not.toContain("watch-hour");
		}
	});

	it("makes no claim Anthers is a 501(c)(3)", () => {
		// Copy rule, and a live one until the determination letter arrives: the honest
		// word is "nonprofit". Asserted here because a legal page is the most plausible
		// place for it to creep in.
		for (const doc of Object.values(LEGAL_DOCUMENTS)) {
			const text = doc.blocks.join("\n").toLowerCase();
			expect(text).not.toContain("501(c)");
			expect(text).not.toContain("tax-deductible");
			expect(text).not.toContain("tax deductible");
		}
	});
});
