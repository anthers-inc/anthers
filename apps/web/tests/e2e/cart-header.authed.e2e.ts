// SPDX-License-Identifier: Apache-2.0
/**
 * The cart is reachable from the header — the one conversion surface that was only
 * reachable from a Work page.
 *
 * 🚨 **This spec exists because `/cart` was linked from no layout or header component
 * at all.** A buyer who added an item and navigated anywhere had no way back except the
 * browser's back button — on the one surface where money changes hands. The header link is
 * always present now (Parker, 2026-11-13); only its count badge waits for the cart to hold
 * something. This spec pins both halves (the link at every width, the badge appearing and
 * disappearing with the server cart) and the count.
 *
 * The cart is the SERVER's now (`cart_items`, moved off localStorage — Parker,
 * 2026-10-03), so the spec seeds it through the storage routes rather than into a
 * browser store: seeding fake ids the way the localStorage spec did would now test
 * nothing, because the server excludes an id that does not resolve.
 *
 * 🚨 **This spec's buyer is a throwaway account, not the gauntlet user** — and that is
 * load-bearing now rather than tidy. The cart is per-account, and
 * `cart-checkout-flow.authed.e2e.ts` walks the user's own cart in the SAME
 * `authed` project beside this file; two files seeding and asserting counts on ONE
 * account's cart would race (`fullyParallel: true` is the project config, so the two
 * files run on different workers at once). A buyer of our own makes this spec's server
 * state private to itself: the account is minted with `db:local-account`, signed in by
 * API, and its session becomes this spec's storageState — the badge walked is the one an
 * actually signed-in buyer's browser renders.
 */
import { fileURLToPath } from "node:url";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { type BrowserContext, expect, expect as fixtureExpect, type Page } from "@playwright/test";
import { purgeAccountIds } from "../../../api/src/__tests__/purge";
import {
	API_URL,
	leashedExecFileSync,
	mintSession,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TITLE_PREFIX = "Cart header walk ";
const PRICE = "9.99";

interface OwnedWork {
	id: number;
	slug: string;
	title: string;
}

interface MeResponse {
	user?: { handle?: string | null };
}

/** The fixture creator's session, for making the purchasable Work; sweeper for its litter. */
let sessionToken: string | null = null;
let work: OwnedWork | null = null;
/** This spec's own buyer — account id (for cleanup), email, and the minted session. */
let buyerId = 0;
let buyerSessionToken: string | null = null;

/** The fixture creator's own Works, by session cookie — what the cleanup sweep matches. */
async function ownWorks(): Promise<OwnedWork[]> {
	if (!sessionToken) return [];
	const me = (await (
		await fetch(`${API_URL}/api/auth/me`, { headers: { Cookie: `session=${sessionToken}` } })
	).json()) as MeResponse;
	const handle = me.user?.handle ?? "";
	if (!handle) return [];
	const res = await fetch(`${API_URL}/api/content/catalog/${handle}`, {
		headers: { Cookie: `session=${sessionToken}` },
	});
	return ((await res.json()) as { works?: OwnedWork[] }).works ?? [];
}

/** Delete every walk Work on the shared creator, so a failed run leaves no litter. */
async function sweep(): Promise<void> {
	if (!sessionToken) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${sessionToken}`, Origin: WEB_ORIGIN },
		});
	}
}

/**
 * A throwaway buyer, minted the canonical way.
 *
 * Its `db:local-account` row carries a pre-verified email and accepted terms (the script's
 * defaults), which is what a buyer needs to hold a session at all. The storageState below
 * is built from the API sign-in's Set-Cookie by hand — `gauntlet.setup.ts` documents the
 * Playwright-under-Bun Set-Cookie gotcha that makes `page.request` the wrong tool for it.
 */
function makeBuyer(name: string): { id: number; email: string } {
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
	return { id: out.userId, email };
}

/**
 * The buyer's session.
 *
 * Minted rather than posted: sign-in is OAuth at the identity's server, so there is no route a
 * spec can hand a password to, and a cart spec has no business driving a consent screen.
 */
async function signInBuyer(userId: number): Promise<string> {
	const token = await mintSession(userId, "anthers e2e cart");
	fixtureExpect(token, "no session was minted").toBeTruthy();
	return token;
}

/** A context whose ONLY state is the buyer's session cookie — no localStorage residue. */
async function newBuyerContext(
	browser: import("@playwright/test").Browser,
): Promise<BrowserContext> {
	const token = buyerSessionToken;
	if (!token) throw new Error("the buyer session was not minted");
	return browser.newContext({
		// 🚨 Empty storageState, stated: `browser.newContext()` on this suite's `browser`
		// fixture empirically carried the project's storageState (verified in the
		// scoping walk — the gauntlet user's cookie arrived in a fresh context), and
		// a spec about A count on B's account would then be about nothing.
		storageState: {
			cookies: [
				{
					name: "session",
					value: token,
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
}

/**
 * Put the walk Work into THIS buyer's server-side cart — one add of one Work, the same
 * route the Work page's button drives. Distinct counts need distinct Works, and the
 * count assertions here are 1s and 0s, so one Work covers every case walked.
 */
async function seedThisBuyersCart(cookie: string): Promise<void> {
	if (!work) throw new Error("walk Work was not created");
	const res = await fetch(`${API_URL}/api/payments/cart/items`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ workId: work.id }),
	});
	fixtureExpect(res.status, `seeding the cart failed: ${await res.text()}`).toBe(200);
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	const fixtureContext = await browser.newContext();
	sessionToken = await signInAsMediaFixture(fixtureContext);
	await fixtureContext.close();

	await sweep();

	// Create and price the Work directly through the API — the Studio's access editor is
	// another surface's business (`cart-checkout-flow.authed.e2e.ts` carries the full
	// reasoning for the shape: software type, released, priced, credited, payout-ready
	// creator — the fixture carries that).
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${sessionToken}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "software", title: `${TITLE_PREFIX}${Date.now()}` }),
	});
	fixtureExpect(created.status, "creating the walk Work failed").toBe(201);
	const body = (await created.json()) as { work: OwnedWork };
	work = body.work;

	const released = await fetch(`${API_URL}/api/content/works/${work.id}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${sessionToken}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			visibility: "released",
			downloadEnabled: true,
			// Release refuses a Work whose rating matrix is incomplete
			// (`maturity_undeclared`), so the matrix is answered here — every row
			// General, the same move `rowsRatedAs("general")` makes for the specs that
			// go through the Studio's grid.
			maturityRows: rowsRatedAs("general"),
			access: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 0, allow: true, price: PRICE },
			],
			// Release refuses a Work whose credits name no human
			// (`credits_creator_required`) — the same fixture credit the checkout-flow
			// spec's create carries.
			credits: [{ role: "Made by", contributor: MEDIA_FIXTURE_USERNAME, types: ["created"] }],
		}),
	});
	fixtureExpect(
		released.ok,
		`pricing the Work failed: ${released.status} ${await released.text()}`,
	).toBe(true);

	const buyer = makeBuyer(`bsk-header-${Date.now().toString(36)}`);
	buyerId = buyer.id;
	buyerSessionToken = await signInBuyer(buyer.id);
});

test.afterAll(async () => {
	await sweep();
	// The buyer's own cart is emptied with the account — the purge helper takes the
	// cascade, from the API unit suites' cleanup (the canonical dependency-ordered
	// delete; importing it keeps THIS order from drifting).
	await purgeAccountIds([buyerId]);
});

test.describe.configure({ mode: "serial" });

// Scope to the header: the sidebar's separate Cart row was removed with the rename
// (2026-11-07), and the top-bar icon is the one door at every width.
const header = (page: Page) => page.getByRole("banner");

test("the header's cart badge counts what the cart holds and drops when the server empties it", async ({
	browser,
}) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	await page.goto("/discovery");
	// The page has read an empty cart and cached it. Seeding behind the tab is what a
	// purchase in another tab looks like to this one. The link is there before anything
	// is in the cart; only the badge waits.
	const emptyLink = header(page).getByRole("link", { name: "Cart", exact: true });
	await expect(emptyLink).toBeVisible();
	await expect(emptyLink.locator(".badge")).toHaveCount(0);
	await seedThisBuyersCart(await buyerCookie(context));

	// 🚨 **A tab coming back into view re-reads the server** — no reload. The count must
	// not wait for a full page load to notice a cart that changed elsewhere.
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	const link = header(page).getByRole("link", { name: /Cart \(1 item\)/ });
	await expect(link, "the cart count did not appear in the header").toBeVisible();
	await expect(link).toHaveAttribute("href", "/cart");
	// The count badge is the load-bearing part — the link alone says a cart exists, not
	// that it holds anything.
	await expect(link.locator(".badge")).toHaveText("1");

	// And the completion the tab did not see: the checkout webhook empties the rows while
	// the buyer is on another surface. The stale count is the bug this pins.
	const emptied = await fetch(`${API_URL}/api/payments/cart`, {
		method: "DELETE",
		headers: { Cookie: await buyerCookie(context), Origin: WEB_ORIGIN },
	});
	fixtureExpect(emptied.status, `emptying the cart failed: ${await emptied.text()}`).toBe(200);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	const emptiedLink = header(page).getByRole("link", { name: "Cart", exact: true });
	await expect(emptiedLink).toBeVisible();
	await expect(
		emptiedLink.locator(".badge"),
		"the header kept the count after the server cart was emptied",
	).toHaveCount(0);
	await context.close();
});

test("the header keeps the cart link when the cart is empty, with no count badge", async ({
	browser,
}) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	// No seed — an empty cart is what an account nobody added to holds.
	await page.goto("/discovery");
	const link = header(page).getByRole("link", { name: "Cart", exact: true });
	await expect(link, "the cart link is missing on an empty cart").toBeVisible();
	await expect(link).toHaveAttribute("href", "/cart");
	await expect(link.locator(".badge")).toHaveCount(0);
	await context.close();
});

test("the cart link reaches the cart page and shows the seeded item", async ({ browser }) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	await page.goto("/discovery");
	await seedThisBuyersCart(await buyerCookie(context));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));

	await header(page)
		.getByRole("link", { name: /Cart \(1 item\)/ })
		.click();
	await expect(page).toHaveURL("/cart");
	// The item the seed put on the server is what the page reads — a count from a
	// browser-side ghost with an empty page behind it is exactly the lie this mode
	// exists to prevent.
	await expect(page.getByText(work?.title ?? "")).toBeVisible();
	await context.close();
});

test("the header cart is the one door on a phone", async ({ browser }) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	await page.setViewportSize({ width: 375, height: 800 });
	await page.goto("/discovery");
	await seedThisBuyersCart(await buyerCookie(context));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));

	// The header link is visible and is the only Cart link on the page — the sidebar row
	// that used to share this job is gone, and this is the width where losing it would
	// have stranded a buyer.
	const link = header(page).getByRole("link", { name: /Cart \(1 item\)/ });
	await expect(link).toBeVisible();
	await expect(page.getByRole("link", { name: /Cart/ })).toHaveCount(1);
	await link.click();
	await expect(page).toHaveURL("/cart");
	await context.close();
});

/** The buyer's session out of the context, for seeding — `gauntlet.setup`'s gotcha again. */
async function buyerCookie(context: BrowserContext): Promise<string> {
	const cookies = await context.cookies(API_URL);
	const session = cookies.find((c) => c.name === "session")?.value;
	fixtureExpect(session, "the buyer context carries no session cookie").toBeTruthy();
	return `session=${session}`;
}
