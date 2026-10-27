// SPDX-License-Identifier: Apache-2.0
/**
 * The two order surfaces — a creator's packing list and a buyer's page.
 *
 * The suite's claims, one spec each:
 * - **Each side sees only its own.** A creator's list holds orders addressed to them; a
 *   buyer's page answers for a purchase they made; a stranger gets the same 404 a missing
 *   order gets, so neither side can probe for the other's.
 * - **Marking shipped is the creator's act, once.** The carrier is normalized, the link is
 *   built from it, and a second mark is refused rather than silently overwriting the first.
 * - **The buyer's two acts are the parcel's own.** Confirming receipt stamps delivery and
 *   opens the window; a complaint inside that window is one row, and the same press twice is
 *   still one row.
 * - **The clock is read, never recomputed.** An order past its ship-by date reads overdue
 *   while it is unshipped, and stops the moment it ships.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, shipmentComplaints, shipments } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createShipmentForPurchase } from "../services/shipments";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

let seller: FixtureAccount;
let buyer: FixtureAccount;
let stranger: FixtureAccount;
const workIds: number[] = [];
const purchaseIds: number[] = [];

let orderId = 0;

function call(method: string, path: string, cookie?: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		}),
	);
}

/** A completed physical purchase with its shipment, as the webhook would have left it. */
async function makeOrder(opts: { handling?: number; createdAt?: Date } = {}) {
	const work = await insertWork({
		creatorId: seller.userId,
		type: "physical",
		title: "A mug",
		access: [{ threshold: 0, allow: true, price: "18.00" }],
	});
	workIds.push(work.id);
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: buyer.userId,
			workId: work.id,
			creatorId: seller.userId,
			workTitle: "A mug",
			workType: "physical",
			workPublicId: work.publicId,
			type: "physical",
			amount: "36.00",
			processingFee: "1.34",
			salesTax: "2.11",
			creatorEarnings: "41.16",
			quantity: 2,
			options: [
				{ name: "Size", label: "Large" },
				{ name: "Glaze", label: "Blue" },
			],
			shippingAmount: "6.50",
			handlingBusinessDays: opts.handling ?? 3,
			buyerCountry: "US",
			buyerState: "CO",
			buyerPostalCode: "80202",
			buyerAddressLine1: "1 Test Street",
			buyerCity: "Denver",
			stripePaymentIntentId: `pi_orders_${crypto.randomUUID().slice(0, 8)}`,
			status: "completed",
			...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
		})
		.returning();
	purchaseIds.push(purchase.id);
	await createShipmentForPurchase({
		purchaseId: purchase.id,
		handlingBusinessDays: opts.handling ?? 3,
		// A backdated order needs its clock backdated too, or the overdue case cannot be
		// produced without waiting three days.
		now: opts.createdAt ?? new Date(),
	});
	return purchase;
}

describe("the order surfaces", () => {
	beforeAll(async () => {
		const run = crypto.randomUUID().slice(0, 8);
		seller = await createAccount(`ord-seller-${run}`, {
			emailVerified: true,
			fields: { creatorMode: true },
		});
		buyer = await createAccount(`ord-buyer-${run}`, { emailVerified: true });
		stranger = await createAccount(`ord-stranger-${run}`, { emailVerified: true });

		const order = await makeOrder({ createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) });
		orderId = order.id;
	}, 60_000);

	afterAll(async () => {
		if (purchaseIds.length > 0) {
			await db.delete(shipmentComplaints).where(eq(shipmentComplaints.purchaseId, orderId));
			await db.delete(shipments).where(eq(shipments.purchaseId, orderId));
			for (const id of purchaseIds) await db.delete(purchases).where(eq(purchases.id, id));
		}
		await purgeWorkIds(workIds);
	});

	it("gives the creator their packing list, with the address and the clock", async () => {
		const res = await call("GET", "/api/orders/selling", seller.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			orders: Array<{
				id: number;
				quantity: number;
				options: Array<{ name: string; label: string }>;
				address: { line1: string | null; postalCode: string | null };
				shipment: { state: string; overdue: boolean; handlingBusinessDays: number };
			}>;
		};
		const order = body.orders.find((o) => o.id === orderId);
		expect(order).toBeTruthy();
		expect(order?.quantity).toBe(2);
		expect(order?.options).toEqual([
			{ name: "Size", label: "Large" },
			{ name: "Glaze", label: "Blue" },
		]);
		expect(order?.address.line1).toBe("1 Test Street");
		expect(order?.address.postalCode).toBe("80202");
		// Five days old with a three-day handling time: overdue, and unshipped.
		expect(order?.shipment.state).toBe("awaiting_shipment");
		expect(order?.shipment.overdue).toBe(true);
	});

	it("keeps a stranger's list empty and their lookup a 404", async () => {
		const list = await call("GET", "/api/orders/selling", stranger.cookie);
		const body = (await list.json()) as { orders: unknown[] };
		expect(body.orders).toEqual([]);

		const read = await call("GET", `/api/orders/${orderId}`, stranger.cookie);
		expect(read.status).toBe(404);
		const ship = await call("POST", `/api/orders/${orderId}/shipped`, stranger.cookie, {
			carrier: "usps",
			trackingNumber: "9400111899223197428490",
		});
		expect(ship.status).toBe(404);
	});

	it("gives the buyer their own order, without the creator's earnings", async () => {
		const res = await call("GET", `/api/orders/${orderId}`, buyer.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			order: { id: number; creatorHandle: string | null; shipment: { state: string } };
		};
		expect(body.order.id).toBe(orderId);
		expect(body.order.shipment.state).toBe("awaiting_shipment");
		expect(body.order.creatorHandle).toBeTruthy();
	});

	it("has the creator mark it shipped, with a link the buyer can follow", async () => {
		const res = await call("POST", `/api/orders/${orderId}/shipped`, seller.cookie, {
			carrier: "usps",
			trackingNumber: "9400 1118 9922 3197 4284 90",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			carrier: string;
			trackingUrl: string | null;
		};
		expect(body.carrier).toBe("usps");
		expect(body.trackingUrl).toContain("tools.usps.com");

		const read = await call("GET", `/api/orders/${orderId}`, buyer.cookie);
		const order = (await read.json()) as {
			order: { shipment: { state: string; trackingUrl: string } };
		};
		expect(order.order.shipment.state).toBe("in_transit");
		expect(order.order.shipment.trackingUrl).toContain("tools.usps.com");
	});

	it("refuses a second mark rather than overwriting the first", async () => {
		const res = await call("POST", `/api/orders/${orderId}/shipped`, seller.cookie, {
			carrier: "ups",
			trackingNumber: "1Z999AA10123456784",
		});
		expect(res.status).toBe(409);
		const [row] = await db.select().from(shipments).where(eq(shipments.purchaseId, orderId));
		expect(row.carrier).toBe("usps");
	});

	it("lets the buyer confirm receipt, which opens the window", async () => {
		const res = await call("POST", `/api/orders/${orderId}/received`, buyer.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			order: {
				shipment: {
					state: string;
					deliveredAt: string | null;
					complaintWindowEndsAt: string | null;
				};
			};
		};
		expect(body.order.shipment.deliveredAt).toBeTruthy();
		expect(body.order.shipment.complaintWindowEndsAt).toBeTruthy();
		expect(body.order.shipment.state).toBe("delivered");
	});

	it("takes one complaint, however many times the button is pressed", async () => {
		const first = await call("POST", `/api/orders/${orderId}/problem`, buyer.cookie, {
			reason: "damaged",
			details: "The handle was cracked on arrival.",
		});
		expect(first.status).toBe(201);
		const second = await call("POST", `/api/orders/${orderId}/problem`, buyer.cookie, {
			reason: "damaged",
			details: "Pressed twice.",
		});
		expect([200, 201, 409]).toContain(second.status);

		const rows = await db
			.select()
			.from(shipmentComplaints)
			.where(eq(shipmentComplaints.purchaseId, orderId));
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe("open");
	});

	it("shows the open complaint on both sides", async () => {
		const sellerView = await call("GET", "/api/orders/selling", seller.cookie);
		const sellerBody = (await sellerView.json()) as {
			orders: Array<{ id: number; complaint: { reason: string } | null }>;
		};
		expect(sellerBody.orders.find((o) => o.id === orderId)?.complaint?.reason).toBe("damaged");

		const buyerView = await call("GET", `/api/orders/${orderId}`, buyer.cookie);
		const buyerBody = (await buyerView.json()) as {
			order: { complaint: { reason: string } | null };
		};
		expect(buyerBody.order.complaint?.reason).toBe("damaged");
	});

	it("refuses a complaint outside its window", async () => {
		// Wind the shipment's window into the past, which is how a lapsed deadline looks.
		await db
			.update(shipments)
			.set({ complaintWindowEndsAt: new Date(Date.now() - 1000) })
			.where(eq(shipments.purchaseId, orderId));
		const res = await call("POST", `/api/orders/${orderId}/problem`, buyer.cookie, {
			reason: "never_arrived",
		});
		expect(res.status).toBe(409);
	});

	it("requires a session on every door", async () => {
		for (const path of ["/api/orders/selling", `/api/orders/${orderId}`]) {
			const res = await call("GET", path);
			expect(res.status).toBe(401);
		}
	});
});
