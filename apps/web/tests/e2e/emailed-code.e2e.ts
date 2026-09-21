// SPDX-License-Identifier: Apache-2.0
/**
 * A signup and a sign-in finished with the code that was actually emailed.
 *
 * 🚨 **Everything else in this suite stops at the code field**, because until the session had a
 * mail catcher the code existed only hashed in the database. These two walk the far side: the code
 * read out of the session's inbox, typed into the six boxes, and an account on the other end — for
 * signup, one that holds the handle it asked for as a real identity on the session's network.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileUrl } from "@anthers/web-shared/profile";
import type { Page } from "@playwright/test";
import { API_URL, emailedCode, expect, test } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const topSignup = (page: Page) => page.locator('[data-signup="top"]');

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function typeCode(page: Page, code: string) {
	// Waited on the focus rather than the field: `keyboard.type` goes wherever focus is, and the
	// field appearing is a different moment from its autofocus having run.
	await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	await page.keyboard.type(code);
}

test("an emailed code finishes a signup, and the account holds the handle it asked for", async ({
	page,
}) => {
	const name = `e2e${stamp()}`.slice(0, 18);
	const address = `e2e-signup-${stamp()}@example.com`;

	await page.goto("/subscribe");
	await topSignup(page).getByLabel("The handle you'd like").fill(name);
	await topSignup(page)
		.getByRole("button", { name: /sign up with anthers|create my account/i })
		.click();
	await expect(page).toHaveURL(/\/finish$/);

	await page.getByLabel(/where should we reach you/i).fill(address);
	await page
		.getByRole("button", { name: /send|continue|confirm|code/i })
		.first()
		.click();
	await typeCode(page, await emailedCode(address));

	// A new account owes the terms (the onboarding claim step is gone — the handle arrives
	// with the identity), so the ceremony's last page is next, wearing its terms checkbox.
	await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

	// And the ceremony is all that is on it. Every sidebar destination is behind
	// ProtectedRoute, which sends an unfinished account straight back here — so on this
	// page the nav is a list of dead ends, and LoggedInLayout leaves it out until there
	// is an account to navigate with. (Pinned here because this is the one existing walk
	// that lands on /welcome with terms still owed; the toggle lives in the header.)
	//
	// Asserted by the aria-hidden state rather than an absence, and through a locator
	// rather than getByRole (which hides aria-hidden elements from the query entirely).
	// LoggedInLayout keeps the toggle MOUNTED through the auth load
	// (`sidebar-phone.authed.e2e.ts` is why), so the button is always in the DOM, and
	// aria-hidden is the state that separates the onboarding render from the ordinary one.
	await expect(page.locator('button[aria-label="Toggle sidebar"]')).toHaveAttribute(
		"aria-hidden",
		"true",
	);

	const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
		user: {
			email: string;
			handle: string;
			atprotoDid: string;
			termsAcceptedAt: string | null;
		} | null;
	};
	expect(me.user?.email).toBe(address);
	expect(me.user?.handle).toMatch(new RegExp(`^${name}\\.`));
	expect(me.user?.termsAcceptedAt, "the account exists but still owes the terms").toBeNull();
	// The profile address is the handle, in the one way one is built.
	expect(profileUrl(me.user?.handle ?? "")).toBe(`/@${me.user?.handle}`);

	// And the identity is real: the session's server holds a repository under that DID and handle.
	const server = process.env.HOSTED_PDS_URL;
	expect(server, "the browser suite runs with the session's identity server").toBeTruthy();
	const repo = await fetch(
		`${server}/xrpc/com.atproto.repo.describeRepo?repo=${me.user?.atprotoDid}`,
	);
	expect(repo.status).toBe(200);
	expect(((await repo.json()) as { handle: string }).handle).toBe(me.user?.handle);
});

test("an emailed code signs an existing account in from /login", async ({ page }) => {
	const name = `e2e-login-${stamp()}`.slice(0, 18);
	const address = `${name}@example.com`;
	const made = JSON.parse(
		execFileSync("bun", ["run", "db:local-account", "--name", name, "--email", address], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { handle: string };

	await page.goto("/login");
	await page.locator('input[autocomplete="email"]').fill(address);
	await page.getByRole("button", { name: /email me a sign-in code/i }).click();
	await typeCode(page, await emailedCode(address));

	await expect
		.poll(async () => {
			const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
				user: { handle: string } | null;
			};
			return me.user?.handle ?? null;
		})
		.toBe(made.handle);
});
