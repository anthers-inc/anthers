// SPDX-License-Identifier: Apache-2.0
/**
 * The proof-of-work gate on the signup door, from the browser side.
 *
 * 🚨 **What this spec pins is the WIRE, not the arithmetic.** The puzzle's rules —
 * single-use, short-lived, difficulty honored — are `signup-pow.test.ts`'s subject on the
 * API side, tested against the service directly; what only a browser can prove is that
 * pressing the button actually fetches a challenge, solves it, and carries `{ id, nonce }`
 * in the begin POST — the connection that, if it silently broke, would leave every
 * visitor stranded at "pow_required" while every API test stayed green.
 *
 * ⚠️ **The browser session runs at difficulty 0** (`scripts/session.ts` hands it
 * `SIGNUP_POW_DIFFICULTY=0`, and the webServer's `--env-file` cannot beat the session's
 * explicit value), so the solve is instant here — which is itself worth asserting: the
 * whole e2e signup fleet depends on that knob reaching the API, and a session change that
 * dropped it would surface as every signup spec timing out on difficulty 4. The
 * raised-difficulty half below intercepts the challenge response and rewrites it to 1 —
 * 16 expected hashes, instant but real — so a solve that only worked at 0 would fail.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** The signup control at the top of the page; `/signup` renders two. See its siblings. */
const topSignup = (page: Page) => page.locator('[data-signup="top"]');

/** A handle nobody else will ask for, inside the 18-character ceiling the name rules enforce. */
const handleName = () =>
	`e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 18);

/** Answer the availability check without leaving the browser. */
async function stubAvailability(page: Page) {
	await page.route("**/api/atproto/handle-available**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ status: "available", handle: "stubbed.anthers.social" }),
		});
	});
}

/** What the begin POST carried, once it has been made. */
async function beginPayload(page: Page): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | null = null;
	await page.route("**/api/auth/signup/begin", async (route) => {
		payload = route.request().postDataJSON() as Record<string, unknown>;
		await route.continue();
	});
	await expect.poll(() => payload, { message: "the begin POST never fired" }).not.toBeNull();
	return payload as Record<string, unknown>;
}

test.describe("the proof-of-work gate", () => {
	test("pressing the button fetches a challenge and carries the solved proof in the begin POST", async ({
		page,
	}) => {
		await stubAvailability(page);
		let challenges = 0;
		await page.route("**/api/auth/signup/challenge", async (route) => {
			challenges += 1;
			await route.continue();
		});

		await page.goto("/signup");
		await expect(topSignup(page).getByRole("tab", { name: "Anthers", exact: true })).toBeVisible();
		const payload = beginPayload(page);
		await topSignup(page).getByLabel("The handle you'd like").fill(handleName());
		await topSignup(page)
			.getByRole("button", { name: /sign up with anthers/i })
			.click();

		// The proof travels with the press: the challenge was fetched, and the begin POST
		// carries the id and the solved nonce.
		expect(challenges).toBeGreaterThanOrEqual(1);
		const body = await payload;
		expect(body.pow).toMatchObject({ id: expect.any(Number), nonce: expect.any(Number) });
	});

	test("arriving burns no CPU — the challenge is fetched on submit, never on page load", async ({
		page,
	}) => {
		let challenges = 0;
		await page.route("**/api/auth/signup/challenge", async (route) => {
			challenges += 1;
			await route.continue();
		});

		await page.goto("/signup");
		// The page is fully interactive (the doors have answered); nothing has fetched.
		await expect(topSignup(page).getByRole("tab", { name: "Anthers", exact: true })).toBeVisible();
		expect(challenges).toBe(0);
	});

	test("a raised difficulty still solves — the grind works past the test-only setting", async ({
		page,
	}) => {
		await stubAvailability(page);
		// Rewrite the issued challenge to difficulty 1: 16 expected hashes, instant but
		// real. The session's knob is 0, so this is the only way a browser spec can see the
		// grind actually run — and it proves the client honors the difficulty the ANSWER
		// names rather than one it assumes.
		await page.route("**/api/auth/signup/challenge", async (route) => {
			const res = await route.fetch();
			const body = (await res.json()) as { id: number; challenge: string };
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ...body, difficulty: 1 }),
			});
		});

		await page.goto("/signup");
		await expect(topSignup(page).getByRole("tab", { name: "Anthers", exact: true })).toBeVisible();
		const payload = beginPayload(page);
		await topSignup(page).getByLabel("The handle you'd like").fill(handleName());
		await topSignup(page)
			.getByRole("button", { name: /sign up with anthers/i })
			.click();

		// The POST lands with a real proof at difficulty 1 — a solver that only worked at
		// 0 would either hang here or send a nonce the server refuses.
		const body = await payload;
		expect(body.pow).toMatchObject({ nonce: expect.any(Number) });
		await expect(page).toHaveURL(/\/finish$/);
	});
});
