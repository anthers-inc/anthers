// SPDX-License-Identifier: Apache-2.0
/**
 * The basket is the account's, not the browser's — the property Parker's live testing
 * found broken (2026-10-03): signed in as A, built a basket, signed out, signed in as B —
 * and B inherited A's basket, because the basket lived in `localStorage`, keyed to the
 * browser. The basket moved into `basket_items`, scoped to the buyer's account; this spec
 * walks that exact case in the browser.
 *
 * What is walked, and why in the browser rather than an API suite:
 *
 * - **B's header badge reads zero** — the badge is the surface the bug showed on, and it
 *   is only honest if `useBasket` in its server-backed mode reads the SERVER's basket for
 *   whoever is signed in. An API suite cannot see a badge.
 * - **The login merge**: a basket built while logged OUT survives sign-in — the one place
 *   the anonymous scratch basket survives — after which the browser holds nothing, so B's
 *   basket following it is impossible by construction.
 * - **The mixed-creator merge**: the scratch held creator X's work and the account's
 *   basket holds creator Y's — the most recent intent wins (the add's replace-on-clash),
 *   the same rule the Work page's button has always kept.
 *
 * The accounts are throwaways made with `db:local-account` and signed in through the
 * REAL `/login` UI — the emailed code off the session's mail catcher. The merge is wired
 * into the sign-in ceremony's completion (`LoginPage`, the ATProto callback, the signup
 * finish), so walking the ceremony is the only honest way to walk it.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import { basketItems } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import type { Page } from "@playwright/test";
import { inArray } from "drizzle-orm";
import { enablePayoutsFor } from "../../../api/src/__tests__/payouts-fixture";
import { purgeAccountIds, purgeWorkIds } from "../../../api/src/__tests__/purge";
import { API_URL, emailedCode, expect, test, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TITLE_PREFIX = "Basket account scoping ";
const PRICE = "9.99";

const stamp = () => `${Date.now().toString(36)}`;

/** A throwaway account, made the canonical way; email pre-verified like signup's own gate. */
function makeAccount(name: string, creator = false): { handle: string; email: string; id: number } {
	const address = `${name}@example.com`;
	const out = JSON.parse(
		execFileSync(
			"bun",
			[
				"run",
				"db:local-account",
				"--name",
				name,
				"--email",
				address,
				...(creator ? ["--creator"] : []),
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { handle: string; userId: number };
	return { handle: out.handle, email: address, id: out.userId };
}

/**
 * Sign IN through the real /login UI: the address, the emailed code, the six boxes. This
 * is what fires the basket merge, wired into the ceremony's completion — nothing about
 * this walk may bypass it, so the walk does not either.
 */
async function signInThroughUi(page: Page, email: string): Promise<void> {
	await page.goto("/login");
	await page.locator('input[autocomplete="username"]').fill(email);
	await page.getByRole("button", { name: /^continue$/i }).click();
	await expect(page.locator('input[aria-label="Code character 1 of 6"]')).toBeFocused();
	await page.keyboard.type(await emailedCode(email));
	// The verify lands a session, `refreshUser` tells the shell, and /login navigates —
	// off the login page is the walk's own signal that the sign-in completed. Polling
	// `/auth/me` from here instead would race the redirect AND read a different cookie
	// jar than the page's (`page.request` carries the context's, the page carries its
	// own — same jar, but the UI is the thing walking).
	await expect
		.poll(() => page.url(), { message: `sign-in as ${email} never landed`, timeout: 15_000 })
		.not.toContain("/login");
}

async function signOutThroughUi(page: Page): Promise<void> {
	// The menu needs a page to live on; a test that reaches here without navigating
	// still gets the banner once the shell has rendered.
	await page.goto("/feed");
	const header = page.getByRole("banner");
	await header.getByRole("button", { name: "Your account" }).click();
	await header.getByRole("button", { name: "Log out" }).click();
	// The logged-out shell takes the account menu away and lands on the marketing root;
	// the URL off /feed is the walk's own signal, the same one sign-in uses.
	await expect
		.poll(() => page.url(), { message: "sign-out never happened", timeout: 15_000 })
		.not.toContain("/feed");
}

/** The signed-in basket, as the server holds it — the truth the badge renders. */
async function serverBasket(cookie: string): Promise<{ count: number; workIds: number[] }> {
	const res = await fetch(`${API_URL}/api/payments/basket`, {
		headers: { Cookie: `session=${cookie}` },
	});
	const body = (await res.json()) as { items: { workId: number }[]; count: number };
	return { count: body.count, workIds: body.items.map((i) => i.workId) };
}

/** Sign the account in by API (fixtures' own fetch path) and return the session cookie. */
async function apiSession(email: string): Promise<string> {
	const startedAt = Date.now();
	await fetch(`${API_URL}/api/auth/signin/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		body: JSON.stringify({ email }),
	});
	const code = await emailedCode(email, 15_000, startedAt);
	const res = await fetch(`${API_URL}/api/auth/signin/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		body: JSON.stringify({ email, code }),
	});
	const token = /(?:^|\s)session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
	expect(token, "no session cookie in the verify answer").toBeTruthy();
	return token as string;
}

test.describe.configure({ mode: "serial" });

// ── Run state ────────────────────────────────────────────────────────────────

let sellerCookie = "";
let buyerACookie = "";
let buyerAEmail = "";
let buyerBEmail = "";
let buyerACreatedId = 0;
let buyerBCreatedId = 0;
let sellerCreatedId = 0;
let workX: { id: number; title: string } | null = null;
let workY: { id: number; title: string } | null = null;
/** Accounts made outside `beforeAll` (the mixed-creator test's second creator), purged too. */
const createdAccountIds: number[] = [];

/** Price and release a freshly created Work, the shape the checkout flow reasons through. */
async function releasePriced(
	title: string,
	credits: string,
): Promise<{ id: number; title: string }> {
	const made = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${sellerCookie}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "software", title }),
	});
	expect(made.status, "creating the walk Work failed").toBe(201);
	const { work } = (await made.json()) as { work: { id: number; title: string } };
	const patched = await fetch(`${API_URL}/api/content/works/${work.id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${sellerCookie}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			visibility: "released",
			downloadEnabled: true,
			maturityRows: rowsRatedAs("general"),
			access: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 0, allow: true, price: PRICE },
			],
			credits: [{ role: "Made by", contributor: credits, types: ["created"] }],
		}),
	});
	expect(patched.ok, `pricing the Work failed: ${patched.status} ${await patched.text()}`).toBe(
		true,
	);
	return work;
}

test.beforeAll(async () => {
	test.setTimeout(180_000);
	const s = stamp();
	const seller = makeAccount(`bsk-${s}-seller`, true);
	sellerCreatedId = seller.id;
	sellerCookie = await apiSession(seller.email);
	const buyerA = makeAccount(`bsk-${s}-a`);
	buyerACreatedId = buyerA.id;
	buyerAEmail = buyerA.email;
	buyerACookie = await apiSession(buyerA.email);
	const buyerB = makeAccount(`bsk-${s}-b`);
	buyerBCreatedId = buyerB.id;
	buyerBEmail = buyerB.email;

	// Release refuses a Work whose creator has not finished payout setup
	// (`payouts_required`) — the seller is a fixture, so its Connect row is written
	// directly, exactly the way `payouts-fixture` does it for every suite that needs a
	// creator who can publish. Deliberately not the default: the two buyers here stay
	// ordinary (no payouts, no creator mode).
	await enablePayoutsFor(seller.id);

	workX = await releasePriced(`${TITLE_PREFIX}X ${s}`, "The Seller");
	workY = await releasePriced(`${TITLE_PREFIX}Y ${s}`, "The Seller");
});

test.afterAll(async () => {
	// The spec's own litter, by id — the dependency-ordered delete is the same one the
	// API unit suites write, pulled in directly so the order can't drift.
	const workIds = [workX?.id ?? 0, workY?.id ?? 0].filter((n) => n > 0);
	await db
		.delete(basketItems)
		.where(inArray(basketItems.workId, workIds.length > 0 ? workIds : [0]));
	await purgeWorkIds(workIds);
	await purgeAccountIds(
		[sellerCreatedId, buyerACreatedId, buyerBCreatedId, ...createdAccountIds].filter((n) => n > 0),
	);
});

test("account A's basket stays account A's, and account B starts empty", async ({ page }) => {
	// A signs in through the real door and puts X in their basket — through the Work
	// page's own door, the way an item actually enters a basket.
	if (!workX) throw new Error("the walk Work was not created");
	await signInThroughUi(page, buyerAEmail);
	// The Work page accepts a bare id and settles to its canonical slug-publicId form;
	// waiting on the pricing card is the sync point either side of that settling.
	await page.goto(`/works/${workX.id}`);
	await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: /Add to basket/ }).click();
	await expect(page.getByText("In your basket")).toBeVisible();
	await expect(
		page.getByRole("banner").getByRole("link", { name: /Basket \(1 item\)/ }),
	).toBeVisible();

	// Sign out. A's basket survives on the SERVER — the browser holds nothing.
	await signOutThroughUi(page);
	expect((await serverBasket(buyerACookie)).workIds).toContain(workX.id);

	// B signs in on the SAME browser: the badge must read nothing.
	await signInThroughUi(page, buyerBEmail);
	await page.goto("/feed");
	await expect(
		page.getByRole("banner").getByRole("link", { name: /Basket/ }),
		"B's header offered a basket their account never built",
	).toHaveCount(0);
	// And the server half agrees — B's account basket is empty.
	const bCookie = await apiSession(buyerBEmail);
	expect((await serverBasket(bCookie)).count).toBe(0);
});

test("an anonymous scratch basket survives sign-in — the merge, then the scratch is gone", async ({
	browser,
}) => {
	if (!workX) throw new Error("the walk Work was not created");

	// ⚠️ **A genuinely anonymous browser, not the project's page.** The `authed` project
	// stamps every page with the gauntlet viewer's storageState, so the page fixture is
	// never signed out and the scratch mode would never run. The scratch is walked in a
	// fresh, empty context, and the merge is signed in THROUGH THAT BROWSER's UI.
	const anon = await browser.newContext({
		// Empty on purpose — see the note above on why a genuinely anonymous browser is
		// the subject here. (Empirically, `browser.newContext()` on this suite's `browser`
		// fixture carries the project's storageState, so the emptiness must be stated.)
		storageState: { cookies: [], origins: [] },
	});
	const scratchPage = await anon.newPage();

	// Anonymous: build the scratch basket through the Work page's door, exactly as a
	// pre-login buyer does. The scratch is the only browser-side basket.
	await scratchPage.goto(`/works/${workX.id}`);
	await expect(scratchPage.getByRole("heading", { name: "Pricing" })).toBeVisible({
		timeout: 15_000,
	});
	await scratchPage.getByRole("button", { name: /Add to basket/ }).click();
	await expect(scratchPage.getByText("In your basket")).toBeVisible();
	// Scratch mode confirmed: the browser's own key carries it.
	const scratch = await scratchPage.evaluate((key) => localStorage.getItem(key), "anthers_basket");
	expect(scratch, "the scratch basket never landed in the browser").toBeTruthy();

	// Sign in — the merge is the ceremony's own act, and the badge is what proves it.
	await signInThroughUi(scratchPage, buyerAEmail);
	await scratchPage.goto("/feed");
	await expect(
		scratchPage.getByRole("banner").getByRole("link", { name: /Basket \(1 item\)/ }),
		"the merged item never reached the header badge",
	).toBeVisible();

	// The account's server basket holds it...
	const after = (await serverBasket(buyerACookie)) as { count: number; workIds: number[] };
	expect(after.workIds).toContain(workX.id);
	// ...and the scratch is GONE — after login the browser holds nothing. (The key
	// itself may remain with an empty shape; the thing that must not survive is ITEM
	// CONTENT — that is what a second account would otherwise inherit through the merge.)
	const scratchAfter = (await scratchPage.evaluate(
		(key) => localStorage.getItem(key),
		"anthers_basket",
	)) as string | null;
	expect(
		scratchAfter === null || JSON.parse(scratchAfter).items.length === 0,
		"the scratch survived the login it merged at",
	).toBe(true);
	await anon.close();
});

test("a mixed-creator merge — the scratch's most recent intent wins, and both sides say so", async ({
	browser,
}) => {
	if (!workX || !workY) throw new Error("the walk Works were not created");
	// X and Y above are the same seller's; the CLASH needs a second creator, so this test
	// mints one and its Work beside them (purged in afterAll via `createdAccountIds`).

	// The account's basket ALREADY holds X. (Clean slate from the merge test, which is
	// serial-before this one.)
	const pre = await fetch(`${API_URL}/api/payments/basket/items`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${buyerACookie}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ workId: workX.id }),
	});
	expect(pre.status).toBe(200);

	// The scratch walk happens in a genuinely anonymous browser — same reasoning as the
	// merge test above (the project page is never signed out).
	const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const scratchPage = await anon.newPage();

	// A second creator's Work: made by a throwaway creator, added by an anonymous
	// visitor through the front door.
	const other = makeAccount(`bsk-${stamp()}-other`, true);
	const otherCookie = await apiSession(other.email);
	// The second creator releases too, so payouts go with it (same reasoning as the
	// seller's in `beforeAll`).
	await enablePayoutsFor(other.id);
	const madeOther = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${otherCookie}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "software", title: `${TITLE_PREFIX}other ${stamp()}` }),
	});
	const otherWork = ((await madeOther.json()) as { work: { id: number } }).work;
	const patched = await fetch(`${API_URL}/api/content/works/${otherWork.id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${otherCookie}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			visibility: "released",
			downloadEnabled: true,
			maturityRows: rowsRatedAs("general"),
			access: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 0, allow: true, price: PRICE },
			],
			credits: [{ role: "Made by", contributor: "The Other Creator", types: ["created"] }],
		}),
	});
	expect(
		patched.ok,
		`pricing the second creator's Work failed: ${patched.status} ${await patched.text()}`,
	).toBe(true);
	// Cleanup owns this test's second creator by id, like the beforeAll ones.
	createdAccountIds.push(other.id);
	// The scratch build goes through the page: the anonymous visitor's most recent intent.
	await scratchPage.goto(`/works/${otherWork.id}`);
	await expect(scratchPage.getByRole("heading", { name: "Pricing" })).toBeVisible({
		timeout: 15_000,
	});
	await scratchPage.getByRole("button", { name: /Add to basket/ }).click();
	await expect(scratchPage.getByText("In your basket")).toBeVisible();

	// Sign back in as A, whose basket holds X (creator X): the merge's add of the
	// scratch item (creator Y) REPLACES the basket — most recent intent — and the
	// account ends with Y alone.
	await signInThroughUi(scratchPage, buyerAEmail);
	await scratchPage.goto("/feed");
	await expect(
		scratchPage.getByRole("banner").getByRole("link", { name: /Basket \(1 item\)/ }),
	).toBeVisible();
	const after = await serverBasket(buyerACookie);
	expect(after.workIds).toEqual([otherWork.id]);
	await anon.close();
});
