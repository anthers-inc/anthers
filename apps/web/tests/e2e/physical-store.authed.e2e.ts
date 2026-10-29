// SPDX-License-Identifier: Apache-2.0
/**
 * A physical good's store panel, and its line in the basket — in a real browser.
 *
 * The panel is the one surface where the goods model becomes visible to a buyer: a price,
 * the creator's choices, a count and what shipping costs. No API test can tell you whether
 * a sold-out value reads as sold out or whether the pickers are reachable at all, which is
 * what this walk is for.
 *
 * ⚠️ **The fixture creator has no connected Stripe account**, deliberately: the gauntlet
 * creator is reset between runs and a Work made there can vanish mid-walk, while the media
 * fixture is stable but unconnected. So the panel is walked for its pricing and choices —
 * the half that renders without money — and the basket line is placed through the same API
 * the panel's button calls. What the button itself does is the API test's subject.
 */
import { db } from "@anthers/db/client";
import { workPhysicalListings, works } from "@anthers/db/schema";
import { type BrowserContext, eq } from "drizzle-orm";
import {
	API_URL,
	expect,
	signInAsMediaFixture,
	test,
	trackErrorsStrict,
	WEB_ORIGIN,
} from "./fixtures";

const STEM = "Store panel walk";
const RUN = Date.now().toString(36);

let session = "";
let workId = 0;
let publicId = 0;
let slug = "";

function headers(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: WEB_ORIGIN,
		Cookie: `session=${session}`,
	};
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
	if (!session) return;
	await fetch(`${API_URL}/api/content/works/${workId}`, {
		method: "DELETE",
		headers: headers(),
	}).catch(() => {});
});

test.beforeAll(async ({ browser }: { browser: { newContext: () => Promise<BrowserContext> } }) => {
	const context = await browser.newContext();
	session = await signInAsMediaFixture(context);
	await context.close();

	const res = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			type: "physical",
			title: `${STEM} ${RUN}`,
			access: [{ threshold: 0, allow: true, price: "18.00" }],
			credits: [{ role: "Everything", contributor: "The Creator", types: ["created"] }],
		}),
	});
	expect(res.status, "creating the store fixture Work").toBe(201);
	const body = (await res.json()) as { work: { id: number; publicId: number; slug: string } };
	workId = body.work.id;
	publicId = Number(body.work.publicId);
	slug = body.work.slug;

	await db.insert(workPhysicalListings).values({
		workId,
		shippingPrice: "6.50",
		handlingBusinessDays: 4,
		taxCategory: "general",
		options: [
			{
				name: "Size",
				values: [
					{ label: "Small", stock: null },
					{ label: "Large", stock: null },
				],
			},
			{
				name: "Glaze",
				values: [
					{ label: "Blue", stock: null },
					{ label: "Bare", stock: 0 },
				],
			},
		],
	});

	// Released so a visitor can see it — the goods rule's own precondition.
	await db
		.update(works)
		.set({ visibility: "released", releasedAt: new Date() })
		.where(eq(works.id, workId));
}, 60_000);

test("the store panel prices the good, offers its choices and refuses the sold-out one", async ({
	page,
}) => {
	const errors = trackErrorsStrict(page);
	// Signed out on purpose: the panel is public, and it must be.
	await page.context().clearCookies();
	await page.goto(`/works/${slug}-${publicId}`);
	await expect(page.getByRole("heading", { name: new RegExp(STEM) })).toBeVisible({
		timeout: 15_000,
	});

	// The panel's own price box, not the price chip a card elsewhere on the page now carries:
	// a physical Work resolves a price like any other, so "$18.00" appears twice on the page.
	const panel = page.getByTestId("physical-quote-box");
	await expect(panel.getByText("$18.00")).toBeVisible();
	await expect(panel.getByText("$6.50")).toBeVisible();
	await expect(page.getByRole("button", { name: "Large" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Bare — sold out/ })).toBeDisabled();

	// The storefront no longer asks for a count; the basket owns it.
	await expect(page.getByLabel("How many")).toHaveCount(0);

	expect(errors).toEqual([]);
});

test("a physical line in the basket shows its count and choices, and the count is editable", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	const add = await fetch(`${API_URL}/api/payments/basket/items`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			workId,
			quantity: 2,
			options: [
				{ name: "Size", label: "Large" },
				{ name: "Glaze", label: "Blue" },
			],
		}),
	});
	expect(add.status, "adding the physical line").toBe(200);

	await page.goto("/basket");
	await expect(page.getByText(/Size: Large · Glaze: Blue · × 2/)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText("$36.00").first()).toBeVisible();

	// The stepper is the basket's own — the buyer fixes a count where they read it.
	await page.getByRole("button", { name: /One more/ }).click();
	await expect(page.getByText(/× 3/)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText("$54.00")).toBeVisible({ timeout: 15_000 });
});
