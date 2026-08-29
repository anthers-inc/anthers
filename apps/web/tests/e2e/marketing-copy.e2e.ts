// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The marketing pages, checked at the RENDERED level for claims that are no longer true.
//
// 🚨 Why this exists, and why it is not redundant with `econ:figures --check`. Four
// marketing pages once sold a mechanism that had been deleted, and promised unlimited
// streaming to a free account whose Public Access is capped monthly. Every one of them
// carried a *correct* money figure, so the figure scan was silent — **a retired mechanism
// carries no wrong number**, and that is exactly its blind spot. The source-level `RETIRED_COPY` rules now catch the phrasings we know about;
// this file catches the claim wherever it is *assembled*, including from a constant or a
// prop the source scan reads as an identifier rather than a sentence.
//
// The rule for adding a case: assert the shape of a claim the model can no longer
// support, not the wording of a sentence someone may legitimately rewrite.

import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Every marketing surface a logged-out visitor can reach.
 *
 * ⚠️ The homepage is `/`, not `/for-users` — that path is a redirect stub kept for old
 * links. Pointing a test at it lands on `RootRedirect`'s spinner while `/auth/me`
 * resolves, which is how the first draft of this file "passed": see `copy()`.
 */
const PAGES = ["/", "/for-creators", "/about", "/faq", "/parents", "/roadmap"];

/**
 * Navigate, prove the page actually rendered, and hand back its text.
 *
 * 🚨 The proof is the entire point. Every assertion below is a NEGATIVE one — "this
 * retired claim is absent" — and a negative assertion is satisfied perfectly by a blank
 * page. The first draft of this spec read `body.textContent` straight after `goto` and
 * reported nine passes against a loading spinner, which is a green test that checks
 * nothing. Waiting for a real `<h1>` is what makes the absence mean something.
 */
async function copy(page: Page, path: string): Promise<string> {
	await page.goto(path);
	await expect(page.locator("h1").first()).toBeVisible();
	// `<Reveal>` animates opacity rather than gating render, so below-fold text is in the
	// DOM and `textContent` sees all of it without scrolling.
	const text = (await page.locator("body").textContent()) ?? "";
	expect(text.length, `${path} rendered no copy`).toBeGreaterThan(500);
	return text;
}

test.describe("marketing copy tells the truth about access", () => {
	for (const path of PAGES) {
		test(`${path} sells no retired gate`, async ({ page }) => {
			const text = await copy(page, path);

			// One gate primitive, pointed only at a creator.
			expect(text).not.toMatch(/Anthers[- ]gates?\b(?!\s+nothing)/i);
			expect(text).not.toContain("Anthers-gated");

			// A Badge is standing, not entitlement — it opens nothing.
			expect(text).not.toMatch(/Badge (?:that )?(?:opens|unlocks)/i);
		});
	}

	test("a free account's streaming is never promised as unlimited", async ({ page }) => {
		for (const path of PAGES) {
			const text = await copy(page, path);
			// Downloads ARE unlimited and must stay sayable; what may not appear is
			// streaming inside an unbounded claim.
			expect(text, `${path} promises unmetered streaming`).not.toMatch(
				/stream\w*\s+and\s+download\w*\s+are\s+unlimited|streams?\s+and\s+downloads?\s+(?:freely|without a meter)/i,
			);
		}
	});

	test("the pages that promise free access also state the limit", async ({ page }) => {
		// 63.01 makes these co-present: "free forever" with no limit beside it reads as
		// unlimited, and the limit is the whole reason to give Anthers anything. This is the
		// one POSITIVE assertion in the file, and it is what keeps the negatives honest —
		// deleting the sentence to satisfy them would fail here.
		for (const path of ["/", "/faq"]) {
			const text = await copy(page, path);
			expect(text, `${path} omits the Public Access limit`).toContain(
				`${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access`,
			);
		}
	});
});

test.describe("FAQ", () => {
	test("a question discloses its answer", async ({ page }) => {
		await page.goto("/faq");

		// The disclosure is a native <details>, not a checkbox collapse — this asserts the
		// behaviour rather than the element, so swapping the mechanism again stays free.
		const q = page.getByText("Is there a data cap?", { exact: false }).first();
		await expect(q).toBeVisible();

		const answer = page.getByText("There is no data cap", { exact: false });
		await expect(answer).toBeHidden();

		await q.click();
		await expect(answer).toBeVisible();

		// And the answer it discloses carries the limit, not the old "no cap" claim.
		await expect(answer).toContainText(`${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access`);
	});

	test("the gates answer describes one gate, pointed at a creator", async ({ page }) => {
		await page.goto("/faq");
		const q = page.getByText("How do gated content and gates work?", { exact: false }).first();
		await q.click();
		await expect(page.getByText("There is one kind of gate on Anthers")).toBeVisible();
	});
});
