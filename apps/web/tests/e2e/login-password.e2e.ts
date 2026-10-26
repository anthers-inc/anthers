// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in from `/login` with the identity's own password.
 *
 * ⭐ **This is the first-party shape, and it is the one Bluesky's own client uses.** For an
 * identity Anthers hosts, the page asks for the password the person chose and sends it to the
 * node in one request. There is no second host and no consent screen. A handle on somebody
 * else's server still takes the OAuth door (`login-bluesky.e2e.ts`), because Anthers is a
 * third-party client there and should not ask for the password.
 *
 * ⚠️ **The emailed code is recovery, not a login**, so the six-box field no longer appears on
 * this page at all. The signup ceremony still uses an emailed code to prove an address, which
 * is a different job and has its own spec.
 */
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { API_URL, expect, leashedExecFileSync, test } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const PASSWORD = "e2e a long enough password";
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** An Anthers-hosted account whose password this spec knows, because it set it. */
function makeAccount(prefix: string): { handle: string } {
	const name = `e2e-${prefix}-${stamp()}`.slice(0, 18);
	const address = `${name}@example.com`;
	return JSON.parse(
		leashedExecFileSync("bun", ["run", "db:local-account", "--name", name, "--email", address], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			// In the environment, never on argv.
			env: { ...process.env, LOCAL_ACCOUNT_PASSWORD: PASSWORD },
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { handle: string };
}

const identifierField = (page: Page) => page.locator('input[autocomplete="username"]');
const passwordField = (page: Page) => page.locator('input[autocomplete="current-password"]');

async function signIn(page: Page, identifier: string, password: string) {
	await page.goto("/login");
	await identifierField(page).fill(identifier);
	await passwordField(page).fill(password);
	await page.getByRole("button", { name: /^sign in$/i }).click();
}

test.describe("signing in with a password", () => {
	test("an Anthers handle or address reveals the password field; a Bluesky handle does not", async ({
		page,
	}) => {
		await page.goto("/login");

		// Idle: the one identifier field, and no password until the page knows what it has.
		await expect(page.getByText(/^email or handle$/i)).toBeVisible();
		await expect(identifierField(page)).toHaveCount(1);
		await expect(passwordField(page)).toHaveCount(0);

		// An address is an Anthers identity until proven otherwise.
		await identifierField(page).fill("jane@doe.com");
		await expect(passwordField(page)).toBeVisible();
		await expect(page.getByText(/password for this anthers identity/i)).toBeVisible();

		// A handle this node issues is the same door.
		const config = (await (await page.request.get(`${API_URL}/api/atproto/config`)).json()) as {
			hostedHandleSuffix: string;
		};
		await identifierField(page).fill(`@jane.${config.hostedHandleSuffix}`);
		await expect(passwordField(page)).toBeVisible();
		await expect(page.getByText(/your identity's password/i)).toBeVisible();

		// A Bluesky handle is somebody else's server, so there is no password here to give.
		await identifierField(page).fill("@alice.bsky.social");
		await expect(passwordField(page)).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: /continue with your identity server/i }),
		).toBeVisible();
	});

	test("an Anthers handle never hands the browser to OAuth", async ({ page }) => {
		await page.goto("/login");

		let handedOff = false;
		await page.route("**/api/atproto/auth", () => {
			handedOff = true;
		});

		const config = (await (await page.request.get(`${API_URL}/api/atproto/config`)).json()) as {
			hostedHandleSuffix: string;
		};
		await identifierField(page).fill(`@jane.${config.hostedHandleSuffix}`);
		await passwordField(page).fill("a wrong but long password");
		await page.getByRole("button", { name: /^sign in$/i }).click();

		await expect(page.getByText(/that handle or password didn't work/i)).toBeVisible();
		expect(handedOff, "a hosted identity signs in here, not at a second host").toBe(false);
	});

	test("a wrong password is refused, and signs nobody in", async ({ page }) => {
		const made = makeAccount("wrong");
		await signIn(page, made.handle, "not the password");

		await expect(page.getByText(/that handle or password didn't work/i)).toBeVisible();
		const me = await page.request.get(`${API_URL}/api/auth/me`);
		expect((await me.json()).user, "a refused password must not create a session").toBeNull();
	});

	test("the identity's own password signs in", async ({ page }) => {
		const made = makeAccount("ok");
		await signIn(page, made.handle, PASSWORD);

		// A new account still owes the terms, so onboarding is the landing.
		await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
		await expect
			.poll(async () => {
				const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
					user: { handle: string } | null;
				};
				return me.user?.handle ?? null;
			})
			.toBe(made.handle);
	});

	test("something that is neither an address nor a handle is asked for one", async ({ page }) => {
		await page.goto("/login");
		await identifierField(page).fill("alice");
		await page.getByRole("button", { name: /^sign in$/i }).click();

		await expect(page.getByText(/email address or the handle on your account/i)).toBeVisible();
		const me = await page.request.get(`${API_URL}/api/auth/me`);
		expect((await me.json()).user).toBeNull();
	});
});
