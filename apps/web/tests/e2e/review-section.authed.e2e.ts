// SPDX-License-Identifier: Apache-2.0
/**
 * The Your Review section's three modes, walked in a browser.
 *
 * A reader who has not met the Work is told what would open the composer; one who has
 * met it writes a review; and what they wrote then replaces the composer rather than
 * joining the list below. **The card holds one height through all three**, which is the
 * point of walking it rather than asserting the pieces separately: a section that grew
 * only when a review landed would move the tab under the reader's cursor.
 *
 * ⭐ **Playing is the transition the brief names.** The episode is playback-mode, so
 * nothing credits until the reader presses a chapter row; the attention engine's first
 * earned tick is flushed and the section re-reads at once, rather than waiting out the
 * thirty-second cadence or a poll. Asserting the composer appears after the click is
 * therefore asserting the live path, not a seeded row.
 *
 * ⚠️ **The reader is this spec's own throwaway account.** Every authed spec shares the
 * gauntlet walker, whose attention rows outlive a run; a section about the INELIGIBLE
 * state cannot be walked as somebody another spec may have just credited. The account
 * is minted the canonical way (`db:local-account`) and purged in `afterAll`.
 */

import { fileURLToPath } from "node:url";
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { purgeAccountIds } from "../../../api/src/__tests__/purge";
import { expect, leashedExecFileSync, mintSession, test } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const EPISODE = mediaFixtureWork("episode");
const WORK_PATH = `/works/${EPISODE.slug}-${EPISODE.publicId}`;

let readerId = 0;
let readerSession = "";

test.beforeAll(async () => {
	const name = `e2e_review_modes_${crypto.randomUUID().slice(0, 8)}`;
	const out = JSON.parse(
		leashedExecFileSync(
			"bun",
			["run", "db:local-account", "--name", name, "--email", `${name}@example.com`],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { userId: number };
	readerId = out.userId;
	readerSession = await mintSession(readerId, "anthers e2e review modes");
});

test.afterAll(async () => {
	await purgeAccountIds([readerId]);
});

/** A browser context whose only state is this spec's reader, signed in. */
async function readerPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		// Empty beyond the cookie, and stated: the project's own storageState would carry
		// the walker in, which is the account this spec exists not to be.
		storageState: {
			cookies: [
				{
					name: "session",
					value: readerSession,
					domain: "localhost",
					path: "/",
					expires: Math.floor(Date.now() / 1000) + 3600,
					httpOnly: true,
					secure: false,
					sameSite: "Lax",
				},
			],
			origins: [],
		},
	});
	return { context, page: await context.newPage() };
}

test("the Your Review section holds one shape from ineligible through reviewed", async ({
	browser,
}) => {
	const { context, page } = await readerPage(browser);
	try {
		await page.goto(`${WORK_PATH}#reviews`);

		// ── Mode one: the reader cannot review yet ─────────────────────────────
		const card = page.getByTestId("your-review");
		await expect(page.getByRole("heading", { name: "Your Review" })).toBeVisible();
		await expect(card).toContainText(
			"You can review this Work once you've experienced some of it.",
		);
		await expect(card.getByRole("button", { name: "Recommend", exact: true })).toHaveCount(0);
		const closedHeight = (await card.boundingBox())!.height;

		// ── The live transition: playing is attention starting ─────────────────
		await page
			.getByTestId("chapter-list")
			.getByRole("button", { name: /The interview begins/ })
			.click();
		await expect(card.getByRole("button", { name: "Recommend", exact: true })).toBeVisible({
			timeout: 20_000,
		});
		expect(
			(await card.boundingBox())!.height,
			"the composer holds the height the closed card had",
		).toBe(closedHeight);

		// ── Mode two: the composer ─────────────────────────────────────────────
		await card.getByRole("button", { name: "Recommend", exact: true }).click();
		const body = "A short verdict, with a timestamp at 0:02.";
		await card.locator("textarea").fill(body);
		await card.getByRole("button", { name: "Post review" }).click();

		// ── Mode three: the review replaces the composer ───────────────────────
		await expect(card.getByText(body)).toBeVisible();
		await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
		await expect(card.getByRole("button", { name: "Remove" })).toBeVisible();
		await expect(card.getByRole("button", { name: "Recommend", exact: true })).toHaveCount(0);
		expect(
			(await card.boundingBox())!.height,
			"the posted review holds the composer's height",
		).toBe(closedHeight);

		// ⭐ **Their own words are not repeated among other people's.** The list below is
		// Other Reviews, and a reader's review is theirs to manage above it.
		await expect(page.getByText(body)).toHaveCount(1);
	} finally {
		await context.close();
	}
});
