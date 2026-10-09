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

	await page.goto("/signup");
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
	await page.locator('input[autocomplete="username"]').fill(address);
	await page.getByRole("button", { name: /^continue$/i }).click();
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

test("an Anthers handle signs in from /login, keyed on the handle alone", async ({ page }) => {
	const name = `e2e-han-${stamp()}`.slice(0, 18);
	const address = `e2e-handle-${stamp()}@example.com`;
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

	// 🚨 **The browser never receives the handle's mailbox, and it must never ask for it.**
	// A hosted handle is resolved into the code's address on the server, so a handoff to
	// the OAuth door — where `signInWithBluesky` sends the typed handle — is precisely what
	// must NOT fire. Recorded rather than blocked, so the routing still routes and the
	// assertion reads the wire after the fact.
	let handedOff = false;
	await page.route("**/api/atproto/auth", () => {
		handedOff = true;
	});

	// Typed with the leading `@`, and in the case somebody's profile shows it — the page
	// strips and lowercases both before the API ever sees them.
	await page.locator('input[autocomplete="username"]').fill(`@${made.handle.toUpperCase()}`);
	await page.getByRole("button", { name: /^continue$/i }).click();

	// The code modal opens IN PLACE — and tells the person it is their handle it asked for,
	// never the address the server put the code in.
	await expect(page.getByRole("heading", { name: /check your email/i })).toBeVisible();
	await expect(
		page.getByText(new RegExp(`anthers account for.*@${made.handle}`, "i")),
	).toBeVisible();

	await typeCode(page, await emailedCode(address));

	await expect
		.poll(async () => {
			const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
				user: { handle: string } | null;
			};
			return me.user?.handle ?? null;
		})
		.toBe(made.handle);

	expect(handedOff, "a hosted handle stays on the emailed-code door").toBe(false);
});
