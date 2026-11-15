// SPDX-License-Identifier: Apache-2.0
/**
 * The two onboarding checklists in the browser: one at the top of Discovery for a reader,
 * one at the top of the Studio's Works page for a creator.
 *
 * 🚨 **What this spec pins is the whole loop, not the card's shape.** Each checklist is
 * drawn only while its rows are open and its account has not put it away, dismissing it
 * is a write to the account rather than to this browser, and the reload is the assertion
 * that matters: a dismissal kept in `localStorage` would pass the click and fail here. The
 * accounts are throwaways made with `db:local-account`, so neither card is meeting state
 * another spec left behind.
 *
 * ⚠️ **The two cards are different kinds and the difference is in the spec.** The reader's
 * is guidance and takes a dismiss; the creator's first phase is the publishing gate and
 * only the follow-up list after it can be put away, which is why the creator account here
 * has payout setup completed before the page is opened.
 */
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { enablePayoutsFor } from "../../../api/src/__tests__/payouts-fixture";
import { purgeAccountIds } from "../../../api/src/__tests__/purge";
import { expect, leashedExecFileSync, mintSession, test } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** A throwaway account, made the canonical way. */
function makeAccount(name: string): { email: string; id: number } {
	const email = `${name}@example.com`;
	const out = JSON.parse(
		leashedExecFileSync("bun", ["run", "db:local-account", "--name", name, "--email", email], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { userId: number };
	return { email, id: out.userId };
}

/** Sign the browser in as one of those accounts, with the same cookie a real session has. */
async function signInAs(page: Page, userId: number, label: string): Promise<void> {
	const token = await mintSession(userId, label);
	await page.context().addCookies([
		{
			name: "session",
			value: token,
			domain: "localhost",
			path: "/",
			expires: Math.floor(Date.now() / 1000) + 3600,
			httpOnly: true,
			secure: false,
			sameSite: "Lax" as const,
		},
	]);
}

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: number[] = [];

test.describe("the onboarding checklists", () => {
	test.afterAll(async () => {
		await purgeAccountIds(created);
	});

	test("a reader meets the orientation checklist once, and its dismissal is the account's", async ({
		page,
	}) => {
		const reader = makeAccount(`e2e_orientation_${stamp}`);
		created.push(reader.id);
		await signInAs(page, reader.id, "anthers e2e orientation");

		await page.goto("/discovery");

		const card = page.getByRole("region", { name: "Getting Around Anthers" });
		await expect(card).toBeVisible();
		// A brand-new account has none of the four, and the card says so plainly.
		await expect(card.getByText("0 of 4 done")).toBeVisible();
		await expect(card.getByRole("listitem")).toHaveCount(4);
		// Four rows; the three that point somewhere else are doors, and the follow row is
		// the one that stands on the page it names.
		await expect(card.getByRole("link")).toHaveCount(3);

		const dismissed = page.waitForResponse(
			(res) =>
				res.url().includes("/api/accounts/me/onboarding/dismiss") &&
				res.request().method() === "POST",
		);
		await card.getByRole("button", { name: "I know my way around" }).click();
		expect((await dismissed).status()).toBe(200);
		await expect(card).toHaveCount(0);

		// The account's answer, not this browser's: a fresh load still has no card.
		await page.reload();
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toHaveCount(0);
	});

	test("a creator meets the follow-up checklist after the gate, and can put it away", async ({
		page,
	}) => {
		const creator = makeAccount(`e2e_firststeps_${stamp}`);
		created.push(creator.id);
		// Payout setup is one half of the publishing gate; the hosted identity answers the
		// other, so the required card is behind this account and the follow-up is what shows.
		await enablePayoutsFor(creator.id);
		await signInAs(page, creator.id, "anthers e2e first steps");

		await page.goto("/studio/works");

		const card = page.getByRole("region", { name: "Creator First Steps" });
		await expect(card).toBeVisible();
		await expect(card.getByText("0 of 5 done")).toBeVisible();
		await expect(card.getByRole("listitem")).toHaveCount(5);
		// The required card is not on screen once the gate is passed.
		await expect(page.getByRole("region", { name: "Creator Setup Checklist" })).toHaveCount(0);

		const dismissed = page.waitForResponse(
			(res) =>
				res.url().includes("/api/accounts/me/onboarding/dismiss") &&
				res.request().method() === "POST",
		);
		await card.getByRole("button", { name: "Dismiss" }).click();
		expect((await dismissed).status()).toBe(200);
		await expect(card).toHaveCount(0);

		await page.reload();
		await expect(page.getByRole("region", { name: "Creator First Steps" })).toHaveCount(0);
	});
});
