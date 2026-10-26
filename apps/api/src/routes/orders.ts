// SPDX-License-Identifier: Apache-2.0
/**
 * Orders — the creator's packing list and the buyer's page for a physical purchase.
 *
 * Two audiences, one set of rows. The creator route answers with the delivery address and
 * the actions that move a parcel (mark shipped); the buyer routes answer with what they
 * bought, where it is, and the two things they may do about it (confirm it arrived, or
 * report a problem inside the window). Every route is scoped to the caller: a creator sees
 * orders addressed to them, a buyer sees purchases they made, and neither can learn whether
 * somebody else's order exists.
 *
 * ⚠️ **Nothing here moves money.** The hold that gates a creator's share reads the same
 * shipment and complaint rows; this surface reports what is true rather than settling it.
 */
import { db } from "@anthers/db/client";
import { purchases } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { buyerOrder, creatorOrders, openComplaint } from "../services/orders.js";
import { confirmReceipt, markShipped } from "../services/shipments.js";

const shipSchema = z.object({
	carrier: z.string().max(80).optional(),
	carrierName: z.string().max(80).optional(),
	trackingNumber: z.string().min(1).max(120),
});

const complaintSchema = z.object({
	reason: z.string().max(40),
	details: z.string().max(2000).optional(),
});

export const orderRoutes = new Hono()
	/**
	 * The carriers a creator may pick — declared before `/:id`, because Hono matches in
	 * registration order and `/carriers` would otherwise be read as an order id.
	 */
	.get("/carriers", (c) => c.json({ carriers: ["usps", "ups", "fedex", "dhl", "other"] }))

	/**
	 * The creator's own orders — what is waiting to be packed, what is in transit, and
	 * anything a buyer has reported.
	 */
	.get("/selling", requireAuth, async (c) => {
		const user = c.get("user");
		return c.json({ orders: await creatorOrders(user.id) });
	})

	/**
	 * Mark an order shipped, with the carrier and the tracking number a buyer can follow.
	 *
	 * Refused when the order is not this creator's (404, so a stranger learns nothing), when
	 * it has already been marked (409 — a re-mark is a correction, and correcting a typo is
	 * a deliberate act rather than a silent overwrite), and when a tracking number is
	 * missing (400: it is the buyer's only way to follow the parcel).
	 */
	.post("/:id/shipped", requireAuth, zValidator("json", shipSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Order not found" }, 404);
		const [purchase] = await db
			.select({ id: purchases.id, creatorId: purchases.creatorId })
			.from(purchases)
			.where(and(eq(purchases.id, id), eq(purchases.creatorId, user.id)))
			.limit(1);
		if (!purchase) return c.json({ error: "Order not found" }, 404);

		const body = c.req.valid("json");
		const result = await markShipped(id, {
			carrier: body.carrier,
			carrierName: body.carrierName,
			trackingNumber: body.trackingNumber,
		});
		if (!result.ok) {
			if (result.reason === "already_shipped")
				return c.json(
					{
						error: "This order is already marked shipped.",
						code: result.reason,
					},
					409,
				);
			if (result.reason === "no_tracking")
				return c.json({ error: "Add the carrier's tracking number.", code: result.reason }, 400);
			return c.json({ error: "Order not found", code: result.reason }, 404);
		}
		return c.json({
			shipped: true,
			carrier: result.shipment.carrier,
			trackingNumber: result.shipment.trackingNumber,
			trackingUrl: result.shipment.trackingUrl,
			shippedAt: result.shipment.shippedAt,
		});
	})

	/** A buyer's own order: what was bought, where it is, and whether they can still complain. */
	.get("/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Order not found" }, 404);
		const order = await buyerOrder(id, user.id);
		if (!order) return c.json({ error: "Order not found" }, 404);
		return c.json({ order });
	})

	/**
	 * The buyer saying the parcel arrived. The strongest delivery signal available without a
	 * carrier integration, and the one that opens the complaint window.
	 */
	.post("/:id/received", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Order not found" }, 404);
		const order = await buyerOrder(id, user.id);
		if (!order) return c.json({ error: "Order not found" }, 404);
		if (!order.shipment.shippedAt)
			return c.json({ error: "This order hasn't been sent yet." }, 409);
		if (order.shipment.deliveredAt) return c.json({ order: await buyerOrder(id, user.id) });
		await confirmReceipt(id);
		return c.json({ order: await buyerOrder(id, user.id) });
	})

	/** The buyer reporting a problem, inside the window the shipment stamped. */
	.post("/:id/problem", requireAuth, zValidator("json", complaintSchema), async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Order not found" }, 404);
		const body = c.req.valid("json");
		const result = await openComplaint(id, user.id, {
			reason: body.reason,
			details: body.details,
		});
		if (!result.ok) return c.json({ error: result.error }, result.status);
		return c.json({ complaint: result.complaint }, 201);
	});
