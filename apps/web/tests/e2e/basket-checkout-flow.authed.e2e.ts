// SPDX-License-Identifier: Apache-2.0
/**
 * The purchase flow, in the browser: **every purchase goes through the basket** (Parker,
 * 2026-10-03) — the Work page offers the doors, and `/basket` is where the money moves.
 *
 * ⚠️ **What this suite can and cannot see.** The browser session has no Stripe key, so
 * the session POST answers 503 and the Payment Element never mounts — the same constraint
 * `checkout-address-guard.test.ts` documents. What CAN be walked, and is: the Work page's
 * two doors (Buy Now and Add to Basket), the Work page carrying NO payment form (the
 * nested-form defect shipped because nothing looked), the basket's quote receipt, the
 * failure surfaces showing the server's own message, and the retry-without-reload path.
 * A real charge is the Stripe walk's business (`make stripe-walk`); this is the flow's.
 *
 * The single-item basket is asserted deliberately: since the Work page's inline checkout
 * was retired, one item is the PRIMARY flow (Buy Now lands there), not an edge case.
 *
 * Runs in the `authed` project, signed in as the gauntlet viewer (storageState), with
 * the Work created on `media_fixture` — the shared-fixture ownership rule every spec in
 * this directory carries: media_fixture is nobody else's reset target, and this spec
 * cleans up after itself with a prefix sweep, the pattern `work-release.authed.e2e.ts`
 * uses.
 */

import { gauntletHandle } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { API_URL, expect, type Page, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

/** Unique per run, so a leftover row from a crashed run can never satisfy an assertion. */
const TITLE = `Basket checkout walk ${Date.now()}`;
const TITLE_PREFIX = "Basket checkout walk ";
/** Priced above the card floor, so the quote resolves to real numbers. */
const PRICE = "9.99";

interface OwnedWork {
	id: number;
	publicId: number;
	slug: string;
	title: string;
}

interface MeResponse {
	user?: { handle?: string | null };
}

let sessionToken: string | null = null;
let work: OwnedWork | null = null;
let creatorHandle = "";

/** The creator's own Works, by session cookie. The handle is what the catalog keys on. */
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
 * Seed the basket directly into `localStorage`, then reload so `useBasket` reads it.
 *
 * The seeding path (rather than driving the Add to Basket button) is used for the tests
 * AFTER the first: the add path is exercised once on its own, and re-driving it per test
 * would make every later assertion depend on a navigation this suite has already proven.
 * Same reasoning as `basket-header.authed.e2e.ts` — evaluate + reload, not addInitScript.
 */
async function seedBasket(page: Page): Promise<void> {
	if (!work) throw new Error("walk Work was not created");
	// localStorage is only reachable on a loaded document — an evaluate on a fresh page
	// throws SecurityError (which is exactly what this spec's first run died on), so
	// land on the basket's own empty state first. Same reasoning as
	// `basket-header.authed.e2e.ts`: evaluate + reload, not addInitScript.
	await page.goto("/basket");
	await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
		key: "anthers_basket",
		value: JSON.stringify({
			version: 1,
			items: [
				{
					workId: work.id,
					slug: work.slug,
					title: work.title,
					price: PRICE,
					creatorHandle,
				},
			],
		}),
	});
	await page.reload();
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	sessionToken = await signInAsMediaFixture(context);
	await context.close();

	creatorHandle = await gauntletHandle(API_URL, MEDIA_FIXTURE_USERNAME);
	await sweep();

	// Create and price the Work directly through the API — the Studio's access editor is
	// another surface's business. The access shape is two rows: a denied baseline and an
	// allowed row whose price is the list price (`resolveAccess` reads the cheapest
	// allowed row's price). A `software` Work needs no media file, nothing waits on
	// ffmpeg, and it carries a tax code and a delivery (`downloadEnabled`) — both are
	// load-bearing: `resolvePurchase` refuses a Work type it cannot tax or deliver
	// ("This kind of work can't be bought yet"), and that refusal is exactly what a
	// `service` stand-in produced on this spec's first run. It also needs a credit
	// naming a human to release.
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${sessionToken}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "software", title: TITLE }),
	});
	expect(created.status, "creating the walk Work failed").toBe(201);
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
			credits: [{ role: "Made by", contributor: MEDIA_FIXTURE_USERNAME, types: ["created"] }],
		}),
	});
	expect(released.ok, `pricing the Work failed: ${released.status} ${await released.text()}`).toBe(
		true,
	);
});

test.afterAll(async () => {
	await sweep();
});

/** The walk Work's public page. */
async function gotoWork(page: Page): Promise<void> {
	const slug = work?.slug;
	if (!slug) throw new Error("walk Work was not created");
	await page.goto(`/works/${slug}`);
	// The URL settles to the canonical slug-publicId form; waiting for the pricing card
	// is the sync point either way.
	await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

/**
 * 🚨 **Serial on purpose, and the reason is the shared Work.** `fullyParallel: true` (the
 * project config) spreads a file's tests across workers, and each worker would run its own
 * `beforeAll` — creating its own walk Work and then, through the prefix sweep, deleting the
 * OTHER workers' walk Works as litter. The first 4-worker run failed exactly that way: every
 * Work-page test read "Not Found" while the basket tests, which never named the Work's page,
 * passed. One stateful fixture, one worker, one walk — the same reasoning the gauntlet
 * declares serial on.
 */
test.describe("the basket purchase flow", () => {
	test("the Work page offers the basket doors and no payment form", async ({ page }) => {
		await gotoWork(page);

		// The two doors exist.
		await expect(page.getByRole("button", { name: /Buy Now/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Add to basket/ })).toBeVisible();

		// 🚨 **And no payment form is on the page** — the defect that shipped was a `<form>`
		// nested in the page's tree with undefined submit behavior. Asserted by what a
		// payment form consists of: no Stripe frame, no card-name field, no address inputs.
		// (The word "billing address" appears in the copy above the buttons — the tax note —
		// which is prose, not a form.)
		await expect(page.locator("iframe[src*='stripe.com']")).toHaveCount(0);
		await expect(page.locator("input[name='cc-name']")).toHaveCount(0);
		await expect(page.locator("input[name='city']")).toHaveCount(0);

		// The quote's fee breakdown prices the purchase, from the server. The Work page's
		// price card still says "calculated at checkout" — it is a price display without
		// an address form, so nothing resolves there; the basket's receipt is where tax
		// reads "from your address", and that copy is asserted in the basket tests.
		await expect(page.getByText("Card processing")).toBeVisible();
		await expect(page.getByText("calculated at checkout")).toBeVisible();
	});

	/** The receipt renders once the quote POST answers; under the shared-Postgres contention
	 *  every spec in this project runs under, the poll below is patience, not leniency — an
	 *  error alert still fails the poll, with the server's sentence in the failure message. */
	async function expectReceiptWithQuote(page: Page): Promise<void> {
		await expect
			.poll(
				async () => {
					if (await page.getByTestId("basket-receipt").isVisible()) return "receipt";
					const alert = page.locator(".alert-error, .alert-warning").first();
					return (await alert.isVisible())
						? ((await alert.textContent()) ?? "error-alert")
						: "none";
				},
				{ message: "the basket receipt never rendered from the quote", timeout: 15_000 },
			)
			.toBe("receipt");
		await expect(page.getByTestId("basket-receipt")).toBeVisible();
	}

	test("Buy Now adds the item and lands on the basket — the one-item flow", async ({ page }) => {
		await gotoWork(page);

		// The header badge is empty before the add.
		const header = page.getByRole("banner");
		await expect(header.getByRole("link", { name: /Basket/ })).toHaveCount(0);

		await page.getByRole("button", { name: /Buy Now/ }).click();

		// Landed on the basket, with the item in it and the badge moved.
		await expect(page).toHaveURL(/\/basket$/);
		await expect(page.getByText(TITLE)).toBeVisible();
		await expect(header.getByRole("link", { name: /Basket \(1 item\)/ })).toBeVisible();

		// The receipt renders real numbers from the quote — subtotal and at-cost fee, with
		// tax named as coming (never estimated).
		await expectReceiptWithQuote(page);
		await expect(page.getByTestId("basket-total")).toHaveText(`$${PRICE} + tax`);
		await expect(page.getByTestId("basket-receipt")).toContainText("calculated from your address");
	});

	test("the basket reads in two columns on desktop and stacks on mobile", async ({ page }) => {
		// 🚨 **Two columns is the second checkout's layout decision (2026-10-03)**: the
		// checkout in one column (the only column with buttons on it), items and receipt
		// in the other; below `lg` it stacks to one column reading items → receipt →
		// checkout. Asserted by computed layout rather than class strings, so a Tailwind
		// class that silently loses cannot pass.
		await seedBasket(page);
		await expectReceiptWithQuote(page);
		// The receipt lives in the items column; visible here means the columns exist.
		await expect(page.getByTestId("basket-items-column")).toBeVisible();
		await expect(page.getByTestId("basket-checkout-column")).toBeVisible();
		await expect(page.getByTestId("basket-items")).toBeVisible();

		// Desktop (the project default, 1280×720): the two columns sit side by side —
		// the checkout column's left edge is at or right of the items column's RIGHT
		// edge, on the same rows.
		const desktop = async () => {
			const itemsBox = await page.getByTestId("basket-items-column").boundingBox();
			const checkoutBox = await page.getByTestId("basket-checkout-column").boundingBox();
			expect(itemsBox).not.toBeNull();
			expect(checkoutBox).not.toBeNull();
			expect(
				checkoutBox!.x,
				"the checkout column must sit beside (not above) the items column on desktop",
			).toBeGreaterThanOrEqual(itemsBox!.x + itemsBox!.width - 1);
		};
		await desktop();

		// Mobile (390px, the phone width `MOBILE_WIDTH` designs for): stacked — the
		// checkout column starts BELOW the items column, and reading order is items →
		// receipt → checkout (the DOM order under the flex column).
		await page.setViewportSize({ width: 390, height: 844 });
		const stacked = async () => {
			const itemsBox = await page.getByTestId("basket-items-column").boundingBox();
			const checkoutBox = await page.getByTestId("basket-checkout-column").boundingBox();
			expect(itemsBox).not.toBeNull();
			expect(checkoutBox).not.toBeNull();
			expect(
				checkoutBox!.y,
				"the checkout column must stack below the items column on mobile",
			).toBeGreaterThanOrEqual(itemsBox!.y + itemsBox!.height - 1);
		};
		await stacked();
		// And the receipt sits between them vertically — the reading-order claim.
		const receiptBox = await page.getByTestId("basket-receipt").boundingBox();
		const itemsBox = await page.getByTestId("basket-items-column").boundingBox();
		const checkoutBox = await page.getByTestId("basket-checkout-column").boundingBox();
		expect(receiptBox!.y).toBeGreaterThanOrEqual(itemsBox!.y);
		expect(receiptBox!.y + receiptBox!.height).toBeLessThanOrEqual(checkoutBox!.y + 1);

		// Back to desktop for the next test in the serial run.
		await page.setViewportSize({ width: 1280, height: 720 });
		await desktop();
	});

	test("the checkout page's forms are siblings, never ancestors of each other", async ({
		page,
	}) => {
		// Structurally asserted in-page: no form may be a DOM descendant of another. The
		// nested-form defect shipped because nothing looked — this is the looking. It runs
		// regardless of whether the Payment Element mounted (the skeleton replaces it here),
		// because the defect was one OUR markup introduced, not one Stripe's iframe brought.
		await seedBasket(page);
		await page.goto("/basket");
		await expectReceiptWithQuote(page);

		const nesting = await page.evaluate(() => {
			const forms = Array.from(document.querySelectorAll("form"));
			return forms.filter((outer) =>
				forms.some((inner) => inner !== outer && outer.contains(inner)),
			).length;
		});
		expect(nesting, "a <form> is nested inside another <form> on the basket page").toBe(0);
	});

	test("Add to Basket keeps the buyer on the Work page", async ({ page }) => {
		await gotoWork(page);
		await page.getByRole("button", { name: /Add to basket/ }).click();
		// Still here — the door that adds without leaving, for the buyer building a basket.
		// (Anchored at the end: the Work's own slug starts "…-walk-…", and a bare /basket/
		// pattern would match the word inside it.)
		await expect(page).not.toHaveURL(/\/basket\/?(\?.*)?$/);
		await expect(page.getByText("In your basket")).toBeVisible();
		const header = page.getByRole("banner");
		await expect(header.getByRole("link", { name: /Basket \(1 item\)/ })).toBeVisible();
	});

	test("a failed checkout session surfaces the server's own message and offers a retry", async ({
		page,
	}) => {
		await seedBasket(page);
		await page.goto("/basket");

		// The browser session has no Stripe key: the session POST answers 503 with
		// "Payments are not configured." — the server's sentence, not a generic banner.
		await expect(page.getByText(/Payments are not configured\./i)).toBeVisible();
		// And the dead end has a road back: a retry control. Clicking it re-fires the same
		// POST in place — asserted here by its still being enabled after the failure.
		const retry = page.getByRole("button", { name: /try again/i });
		await expect(retry).toBeVisible();
		await expect(retry).toBeEnabled();
	});
});
