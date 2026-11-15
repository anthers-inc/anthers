// SPDX-License-Identifier: Apache-2.0
/**
 * The two onboarding checklists in the browser: the reader's floating in the shell's
 * lower-right corner, and the creator's on the Studio's Works page.
 *
 * 🚨 **What this spec pins is the vocabulary and the whole loop.** Both cards are the same
 * floating `SetupChecklist` the Work page already uses: expanded on arrival, collapsible to
 * a round button that keeps the count, and — for the reader's, the guidance one — dismissible
 * so it never comes back. The reload is the assertion that matters for the dismissal, since
 * a card kept away in `localStorage` would pass the click and fail here.
 *
 * ⚠️ **Both cards are page-scoped, and that is part of the rule.** The reader's belongs to
 * Discovery, the page a session starts on, and the creator's to the Studio's Works page;
 * neither follows a person onto a Work, the cart or a player, where an overlay would sit on
 * somebody else's controls. The Library absence below is the reader half of that. The
 * accounts are throwaways made with `db:local-account`, so neither card is meeting state
 * another spec left behind.
 */
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { enablePayoutsFor } from "../../../api/src/__tests__/payouts-fixture";
import { purgeAccountIds } from "../../../api/src/__tests__/purge";
import { expect, leashedExecFileSync, mintSession, test } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * A throwaway account, made the canonical way, with the terms accepted.
 *
 * ⚠️ **The terms matter to this spec.** A terms-owing account's shell hides its chrome,
 * the onboarding cards included, because they are the app's chrome and its links would be
 * dead ends behind the welcome gate. `db:local-account` leaves the terms unaccepted, so the
 * fixture accepts them here — the same state every real account is in by the time it meets
 * either checklist.
 */
async function makeAccount(name: string): Promise<{ email: string; id: number }> {
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
	await db.update(users).set({ termsAcceptedAt: new Date() }).where(eq(users.id, out.userId));
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

	test("a reader meets the orientation checklist as the floating card, and its dismissal is the account's", async ({
		page,
	}) => {
		const reader = await makeAccount(`e2e_orientation_${stamp}`);
		created.push(reader.id);
		await signInAs(page, reader.id, "anthers e2e orientation");

		await page.goto("/discovery");

		const card = page.getByRole("region", { name: "Getting Around Anthers" });
		await expect(card).toBeVisible();
		// A brand-new account has none of the four, and the card says so plainly.
		await expect(card.getByText("0 of 4 done")).toBeVisible();
		await expect(card.getByRole("listitem")).toHaveCount(4);
		// Four rows; the three that point somewhere else are doors, and the follow row is
		// the one that stands on the page it names. The guide is the fourth door, and it
		// leaves the app for the walkthrough that covers the whole list.
		await expect(card.getByRole("link")).toHaveCount(4);
		await expect(card.getByRole("link", { name: "Follow the full walkthrough" })).toHaveAttribute(
			"href",
			"https://anthers.wiki/first-steps/your-first-visit",
		);

		// The card belongs to Discovery and does not follow the reader onto the Library:
		// that scoping is what keeps an overlay off other pages' controls.
		await page.goto("/library");
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toHaveCount(0);
		await page.goto("/discovery");
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toBeVisible();

		// The vocabulary's own gesture — the card folds into the round button and back.
		await page.getByRole("button", { name: "Collapse the Getting Around Anthers" }).click();
		const collapsed = page.getByRole("button", {
			name: "Open the Getting Around Anthers: 0 of 4 done",
		});
		await expect(collapsed).toBeVisible();
		await collapsed.click();
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toBeVisible();

		const dismissed = page.waitForResponse(
			(res) =>
				res.url().includes("/api/accounts/me/onboarding/dismiss") &&
				res.request().method() === "POST",
		);
		await page.getByRole("button", { name: "I know my way around" }).click();
		expect((await dismissed).status()).toBe(200);
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toHaveCount(0);

		// The account's answer, not this browser's: a fresh load still has no card.
		await page.reload();
		await expect(page.getByRole("region", { name: "Getting Around Anthers" })).toHaveCount(0);
	});

	test("a creator meets the follow-up checklist after the gate, in the same floating card", async ({
		page,
	}) => {
		const creator = await makeAccount(`e2e_firststeps_${stamp}`);
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
		// The guide leaves the app for the walkthrough that covers the whole path.
		await expect(card.getByRole("link", { name: "Follow the full walkthrough" })).toHaveAttribute(
			"href",
			"https://anthers.wiki/getting-started/releasing-your-first-work",
		);
		// The required card is not on screen once the gate is passed.
		await expect(page.getByRole("region", { name: "Creator Setup Checklist" })).toHaveCount(0);

		// The same collapse gesture as the reader's card.
		await page.getByRole("button", { name: "Collapse the Creator First Steps" }).click();
		await expect(
			page.getByRole("button", { name: "Open the Creator First Steps: 0 of 5 done" }),
		).toBeVisible();

		await page.getByRole("button", { name: "Open the Creator First Steps: 0 of 5 done" }).click();

		const dismissed = page.waitForResponse(
			(res) =>
				res.url().includes("/api/accounts/me/onboarding/dismiss") &&
				res.request().method() === "POST",
		);
		await card.getByRole("button", { name: "Dismiss" }).click();
		expect((await dismissed).status()).toBe(200);
		await expect(page.getByRole("region", { name: "Creator First Steps" })).toHaveCount(0);

		await page.reload();
		await expect(page.getByRole("region", { name: "Creator First Steps" })).toHaveCount(0);
	});
});
