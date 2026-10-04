// SPDX-License-Identifier: Apache-2.0
/**
 * The basket is reachable from the header — the one conversion surface that was only
 * reachable from a Work page.
 *
 * 🚨 **This spec exists because `/basket` was linked from no layout or header component
 * at all.** A buyer who added an item and navigated anywhere had no way back except the
 * browser's back button — on the one surface where money changes hands. The header link
 * renders only when the basket has items, so the tight header costs nothing when empty;
 * this spec pins both halves (appears when non-empty, absent when empty) and the count.
 *
 * The basket is the SERVER's now (`basket_items`, moved off localStorage — Parker,
 * 2026-10-03), so the spec seeds it through the storage routes rather than into a
 * browser store: seeding fake ids the way the localStorage spec did would now test
 * nothing, because the server excludes an id that does not resolve.
 *
 * 🚨 **This spec's buyer is a throwaway account, not the gauntlet viewer** — and that is
 * load-bearing now rather than tidy. The basket is per-account, and
 * `basket-checkout-flow.authed.e2e.ts` walks the viewer's own basket in the SAME
 * `authed` project beside this file; two files seeding and asserting counts on ONE
 * account's basket would race (`fullyParallel: true` is the project config, so the two
 * files run on different workers at once). A buyer of our own makes this spec's server
 * state private to itself: the account is minted with `db:local-account`, signed in by
 * API, and its session becomes this spec's storageState — the badge walked is the one an
 * actually signed-in buyer's browser renders.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { type BrowserContext, expect, expect as fixtureExpect, type Page } from "@playwright/test";
import { purgeAccountIds } from "../../../api/src/__tests__/purge";
import { API_URL, emailedCode, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TITLE_PREFIX = "Basket header walk ";
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
		execFileSync("bun", ["run", "db:local-account", "--name", name, "--email", email], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { userId: number };
	return { id: out.userId, email };
}

async function signInBuyer(email: string): Promise<string> {
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
	fixtureExpect(
		res.ok,
		`sign-in as ${email} failed (${res.status}): ${await res.text().catch(() => "")}`,
	).toBe(true);
	const token = /(?:^|\s)session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
	fixtureExpect(token, "no session cookie in the verify answer").toBeTruthy();
	return token as string;
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
		// scoping walk — the gauntlet viewer's cookie arrived in a fresh context), and
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
 * Put the walk Work into THIS buyer's server-side basket — one add of one Work, the same
 * route the Work page's button drives. Distinct counts need distinct Works, and the
 * count assertions here are 1s and 0s, so one Work covers every case walked.
 */
async function seedThisBuyersBasket(cookie: string): Promise<void> {
	if (!work) throw new Error("walk Work was not created");
	const res = await fetch(`${API_URL}/api/payments/basket/items`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ workId: work.id }),
	});
	fixtureExpect(res.status, `seeding the basket failed: ${await res.text()}`).toBe(200);
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	const fixtureContext = await browser.newContext();
	sessionToken = await signInAsMediaFixture(fixtureContext);
	await fixtureContext.close();

	await sweep();

	// Create and price the Work directly through the API — the Studio's access editor is
	// another surface's business (`basket-checkout-flow.authed.e2e.ts` carries the full
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
	buyerSessionToken = await signInBuyer(buyer.email);
});

test.afterAll(async () => {
	await sweep();
	// The buyer's own basket is emptied with the account — the purge helper takes the
	// cascade, from the API unit suites' cleanup (the canonical dependency-ordered
	// delete; importing it keeps THIS order from drifting).
	await purgeAccountIds([buyerId]);
});

test.describe.configure({ mode: "serial" });

// Scope to the header — the sidebar also carries a Basket entry when non-empty, so an
// unscoped `getByRole("link", { name: /Basket/ })` matches two and fails strict mode.
// This mirrors `header-account-menu.authed.e2e.ts`'s scoping for the same reason.
const header = (page: Page) => page.getByRole("banner");

test("the header shows a basket link with a count when the basket has items", async ({
	browser,
}) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	await page.goto("/feed");
	await seedThisBuyersBasket(await buyerCookie(context));
	// The header reads the server on the page's own terms — a navigation, not a guess.
	await page.reload();

	await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible();
	const link = header(page).getByRole("link", { name: /Basket \(1 item\)/ });
	await expect(link, "the basket link did not appear in the header").toBeVisible();
	await expect(link).toHaveAttribute("href", "/basket");
	// The count badge is the load-bearing part — a link that is always there with no
	// count is a different, weaker control.
	await expect(header(page).locator(".badge").filter({ hasText: "1" })).toBeVisible();
	await context.close();
});

test("the header hides the basket link when the basket is empty", async ({ browser }) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	// No seed — an empty basket is what an account nobody added to holds.
	await page.goto("/feed");
	await expect(
		header(page).getByRole("link", { name: /Basket/ }),
		"the basket link appeared when the basket was empty",
	).toHaveCount(0);
	await context.close();
});

test("the basket link reaches the basket page and shows the seeded item", async ({ browser }) => {
	const context = await newBuyerContext(browser);
	const page = await context.newPage();
	await page.goto("/feed");
	await seedThisBuyersBasket(await buyerCookie(context));
	await page.reload();

	await header(page)
		.getByRole("link", { name: /Basket \(1 item\)/ })
		.click();
	await expect(page).toHaveURL("/basket");
	// The item the seed put on the server is what the page reads — a count from a
	// browser-side ghost with an empty page behind it is exactly the lie this mode
	// exists to prevent.
	await expect(page.getByText(work?.title ?? "")).toBeVisible();
	await context.close();
});

/** The buyer's session out of the context, for seeding — `gauntlet.setup`'s gotcha again. */
async function buyerCookie(context: BrowserContext): Promise<string> {
	const cookies = await context.cookies(API_URL);
	const session = cookies.find((c) => c.name === "session")?.value;
	fixtureExpect(session, "the buyer context carries no session cookie").toBeTruthy();
	return `session=${session}`;
}
