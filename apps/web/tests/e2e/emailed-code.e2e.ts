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

	// A new account owes a username, so the ceremony's last page is next.
	await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

	// And the ceremony is all that is on it. Every sidebar destination is behind
	// ProtectedRoute, which sends a handle-less account straight back here — so on this
	// page the nav is a list of dead ends, and LoggedInLayout leaves it out until there
	// is an account to navigate with. (Pinned here because this is the one existing walk
	// that lands on /welcome as a nameless account; the toggle lives in the header.)
	//
	// 🚨 The nav's existence is asserted by an element that only renders with it — not by
	// the links, which sit inside a `w-0` collapsed aside and so are in the DOM either
	// way. The hamburger button that opens the drawer goes away with its chrome.
	await expect(page.getByRole("button", { name: /toggle sidebar/i })).toHaveCount(0);

	const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
		user: { email: string; atprotoHandle: string; atprotoDid: string } | null;
	};
	expect(me.user?.email).toBe(address);
	expect(me.user?.atprotoHandle).toMatch(new RegExp(`^${name}\\.`));

	// And the identity is real: the session's server holds a repository under that DID and handle.
	const server = process.env.HOSTED_PDS_URL;
	expect(server, "the browser suite runs with the session's identity server").toBeTruthy();
	const repo = await fetch(
		`${server}/xrpc/com.atproto.repo.describeRepo?repo=${me.user?.atprotoDid}`,
	);
	expect(repo.status).toBe(200);
	expect(((await repo.json()) as { handle: string }).handle).toBe(me.user?.atprotoHandle);
});

test("an emailed code signs an existing account in from /login", async ({ page }) => {
	const username = `e2e_login_${stamp()}`;
	const address = `${username}@example.com`;
	execFileSync("bun", ["run", "db:local-account", "--username", username, "--email", address], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});

	await page.goto("/login");
	await page.locator('input[autocomplete="username"]').fill(address);
	await page.getByRole("button", { name: /email me a sign-in code/i }).click();
	await typeCode(page, await emailedCode(address));

	await expect
		.poll(async () => {
			const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
				user: { username: string } | null;
			};
			return me.user?.username ?? null;
		})
		.toBe(username);
});
