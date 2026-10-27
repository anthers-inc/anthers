// SPDX-License-Identifier: Apache-2.0
/**
 * The two order surfaces, in a real browser: the creator's packing list and the buyer's
 * page for the same order.
 *
 * ⭐ **One account plays both sides here, on purpose.** The walk needs an order whose buyer
 * and seller are the person signed in, and producing that with two accounts would mean
 * driving two sign-ins through one spec for no extra coverage — the API tests already pin
 * that each side sees only its own. What this walk is for is that the cards render, the
 * state reads the way the clocks do, and each act moves the other side's page.
 *
 * The order is seeded straight into the database, because a real one would need a Stripe
 * charge; everything after it is the real surface and the real API.
 */
import { db } from "@anthers/db/client";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { purchases, shipmentComplaints, shipments, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { expect, signInAsMediaFixture, test } from "./fixtures";

const RUN = Date.now().toString(36);

let orderId = 0;
let userId = 0;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, MEDIA_FIXTURE_EMAIL))
		.limit(1);
	expect(account?.id, "the media fixture account").toBeTruthy();
	userId = account.id;

	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: userId,
			creatorId: userId,
			workTitle: `Orders walk ${RUN}`,
			workType: "physical",
			workPublicId: 1,
			type: "physical",
			amount: "36.00",
			processingFee: "1.34",
			salesTax: "2.11",
			creatorEarnings: "41.16",
			quantity: 2,
			options: [{ name: "Size", label: "Large" }],
			shippingAmount: "6.50",
			handlingBusinessDays: 3,
			buyerCountry: "US",
			buyerState: "CO",
			buyerPostalCode: "80202",
			buyerAddressLine1: "1 Test Street",
			buyerCity: "Denver",
			stripePaymentIntentId: `pi_orderswalk_${RUN}`,
			status: "completed",
		})
		.returning();
	orderId = purchase.id;

	await db.insert(shipments).values({
		purchaseId: orderId,
		handlingBusinessDays: 3,
		shipByAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
		events: [],
	});
});

test.afterAll(async () => {
	if (!orderId) return;
	await db.delete(shipmentComplaints).where(eq(shipmentComplaints.purchaseId, orderId));
	await db.delete(shipments).where(eq(shipments.purchaseId, orderId));
	await db.delete(purchases).where(eq(purchases.id, orderId));
});

test("the creator marks the order shipped, and the buyer's page follows", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);

	await page.goto("/studio/orders");
	const card = page.locator("li", { hasText: `Orders walk ${RUN}` });
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card.getByText("To ship")).toBeVisible();
	await expect(card.getByText("1 Test Street")).toBeVisible();
	await expect(card.getByText("2 × Size: Large")).toBeVisible();

	// The creator writes the carrier and the number the parcel actually has.
	await card.getByLabel("Carrier").selectOption("usps");
	await card.getByLabel("Tracking number").fill("9400111899223197428490");
	await card.getByRole("button", { name: "Mark shipped" }).click();
	await expect(card.getByText("On its way")).toBeVisible({ timeout: 15_000 });

	// The buyer's page reads the same row — state, tracking link and all.
	await page.goto(`/orders/${orderId}`);
	await expect(page.getByText(/on its way/i)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("link", { name: /Track it with USPS/i })).toBeVisible();
});

test("the buyer confirms receipt and reports a problem inside the window", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await page.goto(`/orders/${orderId}`);

	await page.getByRole("button", { name: "It arrived" }).click();
	await expect(page.getByText(/it arrived/i)).toBeVisible({ timeout: 15_000 });

	await page.getByRole("button", { name: "Report a problem" }).click();
	await page.getByLabel("What went wrong").selectOption("damaged");
	await page
		.getByLabel("Tell the creator what happened")
		.fill("The handle was cracked when it arrived.");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.getByText(/you reported: the handle was cracked/i)).toBeVisible({
		timeout: 15_000,
	});

	// And the creator's list shows the same complaint, which is what freezes the payout.
	await page.goto("/studio/orders");
	const card = page.locator("li", { hasText: `Orders walk ${RUN}` });
	await expect(card.getByText("A buyer reported a problem")).toBeVisible({ timeout: 15_000 });
});
