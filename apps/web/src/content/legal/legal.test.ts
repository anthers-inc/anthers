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

const CREATOR_TERMS_TEXT = () => LEGAL_DOCUMENTS["creator-terms"].blocks.join("\n");

describe("published legal documents", () => {
	it("🚨 carries no effective date — they are pending, not in force", () => {
		for (const [slug, doc] of Object.entries(LEGAL_DOCUMENTS)) {
			expect(`${slug}:${doc.effectiveDate}`).toBe(`${slug}:null`);
		}
	});

	it("serves the three documents the app links to", () => {
		expect(Object.keys(LEGAL_DOCUMENTS).sort()).toEqual(["creator-terms", "privacy", "terms"]);
	});

	it("carries no drafting apparatus", () => {
		// These were an abridgement of a vault specification until 2026-09-02, and that
		// specification carried `NOT YET BUILT` markers, a DO-NOT-PUBLISH banner and a
		// "Notes for us" section. The vault copies are gone and this file is canonical, so
		// nothing should reintroduce any of it — a reader meeting a marker is being told we
		// knew the document was untrue and published it anyway.
		for (const doc of Object.values(LEGAL_DOCUMENTS)) {
			const text = doc.blocks.join("\n");
			expect(text).not.toContain("NOT YET BUILT");
			expect(text).not.toContain("DO NOT PUBLISH");
			expect(text).not.toContain("Notes for us");
			expect(text).not.toContain("⚠️");
		}
	});

	it("🚨 promises no storage exemption for Public Access work", () => {
		/*
		 * A retired promise is worse in an instrument than anywhere else, because a reader
		 * can act on it and then hold us to it.
		 *
		 * The Creator Terms told creators that "anything you release as Public Access does
		 * not count against your storage at all" — a deliberate commons incentive, retired
		 * on 2026-08-30 and **never implemented at any point**: `estimateStorageCost` has no
		 * such parameter and the cost job has always summed every asset on a creator's
		 * works. It was retired because its cost is set by how much creators choose to
		 * store, which modeled out at the edge of what the charitable budget could carry and
		 * breached it as soon as library sizes were doubled.
		 *
		 * It survived in the vault copy until the vault copy was retired, and it is exactly
		 * the sentence somebody would restore from a backup while "restoring the full text".
		 */
		const text = CREATOR_TERMS_TEXT();
		expect(text).not.toContain("does not count against your storage");
		expect(text.toLowerCase()).not.toMatch(/public access[^.]{0,80}storage[^.]{0,40}free/);
	});

	it('never says "watch-time" — a minute is a minute across four media', () => {
		/*
		 * 🚨 The equal-time principle, enforced where it is most likely to be broken.
		 *
		 * The privacy policy's own sentence enumerates *"play, watch, read, or listen"*
		 * and then, until 2026-08-12, called the result **watch-time** — naming one medium
		 * as the unit for a platform that hosts four, in the same breath as listing them.
		 * The wiki's *How Anthers Talks About Itself* made the same mistake and worse: it blessed the term while citing this
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

	it("🚨 names every outside party that receives something about a user", () => {
		/*
		 * The disclosure list is the whole point of a privacy policy, and it is the part
		 * that goes stale silently — a recipient is added in code and nobody edits prose.
		 *
		 * 🚨 **The Canadian Centre for Child Protection is here because it was missing for
		 * three days while the scan was live.** The vault copy had the paragraph, under a
		 * `NOT YET BUILT` marker; the serving layer strips marked copy; so shipping the
		 * scanner published nothing, and the policy named four providers while a fifth
		 * party was receiving a hash of every uploaded image. **A marker withholding a
		 * disclosure is worse than a marker annotating a draft**, and nothing failed.
		 */
		const text = LEGAL_DOCUMENTS.privacy.blocks.join("\n");
		for (const recipient of [
			"Cloudflare",
			"DigitalOcean",
			"Stripe",
			"Resend",
			"Canadian Centre for Child Protection",
		]) {
			expect(text, `${recipient} receives user data and the policy must name it`).toContain(
				recipient,
			);
		}
	});

	it("⭐ names the media the scan does not reach, for exactly as long as that is true", () => {
		/*
		 * The other half of the recipient assertion, pointed the other way, and it has
		 * already done its job once: the claim used to read *"Video and audio are not
		 * covered"* and this test is what forced it to be widened when keyframe sampling
		 * landed rather than leaving the policy telling people less than we do.
		 *
		 * ⚠️ **A disclosure that under-claims is not safe by default.** It describes a
		 * platform that examines less than this one does, and somebody reading it to decide
		 * whether to upload here is being told something untrue in the cautious direction.
		 * Audio is the live gap now — a perceptual image hash has nothing to say about a
		 * sound — and when that changes, this line changes with it.
		 */
		const text = LEGAL_DOCUMENTS.privacy.blocks.join("\n");
		expect(text).toContain("Audio is not covered");
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
