// SPDX-License-Identifier: Apache-2.0
/**
 * Signing up through the Bluesky door, all the way: the stand-in's own sign-in and consent pages,
 * the OAuth callback, the emailed code, and an account holding the identity that was brought.
 *
 * 🚨 **Every other Bluesky spec stops at the handoff**, because the far side was somebody else's
 * website. The session's network runs a server standing in for `bsky.social`, with a real
 * authorization server, so this walks the round trip the hub actually makes — resolving the handle,
 * asking for Anthers' published permission sets, and receiving the grant.
 *
 * ⚠️ **It runs on `127.0.0.1`, not `localhost`.** A loopback OAuth client's redirect must be a
 * literal loopback IP, so the callback lands on `127.0.0.1`, and cookies are host-scoped: a signup
 * started on `localhost` would be unreadable when the browser came back.
 */
import { emailedCode, expect, test } from "./fixtures";

const ORIGIN = `http://127.0.0.1:${process.env.PREVIEW_PORT ?? 4173}`;
const API = `http://127.0.0.1:${process.env.API_PORT ?? 8000}`;

test("a Bluesky identity signs up through its own server's consent, and the account holds it", async ({
	page,
}) => {
	const server = process.env.BLUESKY_STAND_IN_URL;
	expect(server, "the browser suite runs with the session's Bluesky stand-in").toBeTruthy();

	const name = `bs${Date.now().toString(36)}`;
	const handle = `${name}.bsky.test`;
	const address = `${name}@example.com`;
	const password = crypto.randomUUID();
	const created = await fetch(`${server}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle, email: address, password }),
	});
	expect(created.status).toBe(200);
	const { did } = (await created.json()) as { did: string };

	await page.goto(`${ORIGIN}/subscribe`);
	const card = page.locator('[data-signup="top"]');
	await card.getByRole("tab", { name: "Bluesky", exact: true }).click();
	await card.getByLabel("Bluesky handle").fill(handle);
	await card.getByRole("button", { name: /sign up with bluesky/i }).click();

	// The stand-in's own pages: sign in, then grant what Anthers asked for.
	await page.waitForURL(/\/oauth\/authorize/);
	await page.locator('input[name="password"]').fill(password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	// ⭐ The permission set's title, which the stand-in could only show by resolving the Lexicon
	// Anthers published — so this line is also the proof that resolution worked.
	await expect(page.getByText("Your Anthers Activity")).toBeVisible();
	await page.getByRole("button", { name: "Authorize", exact: true }).click();

	// Back on Anthers to prove the address the stand-in shared, because a server's word about an
	// address is not proof of it: the code is already on its way to the address the grant carried.
	await page.waitForURL(`${ORIGIN}/finish`);
	await expect(page.getByText(`@${handle}`)).toBeVisible();
	await expect(page.getByText(address)).toBeVisible();
	await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	await page.keyboard.type(await emailedCode(address));

	await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
	const me = (await (await page.request.get(`${API}/api/auth/me`)).json()) as {
		user: { atprotoDid: string; handle: string } | null;
	};
	expect(me.user?.atprotoDid).toBe(did);
	// The brought handle IS the account's address — there is nothing left to claim, and
	// `/welcome`'s remaining job is the terms.
	expect(me.user?.handle).toBe(handle);
});
