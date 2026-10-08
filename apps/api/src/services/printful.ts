// SPDX-License-Identifier: Apache-2.0
/**
 * The Printful boundary — the one module that talks to Printful, and the fulfillment
 * service for Anthers' own merch.
 *
 * Mirrors `lib/processor.ts`'s shape deliberately: every Printful operation is a function
 * here, never a direct `fetch` from a route. Printful is the vendor behind every physical
 * good Anthers sells, and the day a second fulfiller exists (self-fulfilled goods are
 * signposted as coming) the call sites stay put and a provider changes behind these
 * functions. The client is null when `PRINTFUL_TOKEN` is unset — dev sessions, CI and any
 * environment that has not been handed the secret — and callers treat null exactly as the
 * Stripe paths treat an unconfigured processor: a 503, never a crash.
 *
 * **The token is a private, store-scoped token** (Parker's decision on the ask), held in
 * the BWS secret manager and injected into the environment — never committed, never named
 * on a command line (the credential rule). One store, one account: the creator-merch path
 * (a future task) uses Printful's Public App OAuth and is a different client shape, and
 * nothing here reaches for it.
 *
 * 🚨 **This module is the one writer of `merch_fulfillments`** — the completion path and
 * the webhook receiver write through it, and no route writes those rows directly.
 */
import { db } from "@anthers/db/client";
import type { merchFulfillments as merchFulfillmentsTable } from "@anthers/db/schema";
import { merchFulfillments, purchases } from "@anthers/db/schema";
import { MERCH_MARGIN_DOLLARS } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";

const API_BASE = "https://api.printful.com";

/** The store-scoped private token, from configuration. Null when unconfigured. */
function token(): string | null {
	return process.env.PRINTFUL_TOKEN?.trim() || null;
}

/** Whether any Printful operation is possible — false when no token is configured. */
export function printfulConfigured(): boolean {
	return token() !== null;
}

interface PrintfulEnvelope<T> {
	code: number;
	result: T;
}

class PrintfulError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string,
		message: string,
	) {
		super(`Printful ${status} ${reason}: ${message}`);
	}
}

/**
 * One Printful API call, with the error shape every caller wants: a thrown
 * `PrintfulError` carrying the status and Printful's own reason. Rate-limit responses
 * respect `Retry-After` with one retel before failing — the estimate/shipping calls sit
 * inside a checkout, where a silent failure strands a buyer.
 */
async function call<T>(method: string, path: string, body?: unknown, depth = 0): Promise<T> {
	const tok = token();
	if (!tok) throw new PrintfulError(0, "NotConfigured", "PRINTFUL_TOKEN is not set");
	const res = await fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${tok}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (res.status === 429 && depth < 1) {
		// The authoritative wait is Retry-After; one retel with a small jitter, then the
		// failure is real. Checkout volume never approaches 120/min, so this exists for
		// a shared-window collision, not for a busy store.
		const wait = Number(res.headers.get("Retry-After") ?? "2") + Math.random();
		await new Promise((r) => setTimeout(r, wait * 1000));
		return call<T>(method, path, body, depth + 1);
	}
	const json = (await res.json().catch(() => null)) as
		| PrintfulEnvelope<T>
		| { error?: { reason?: string; message?: string } }
		| null;
	if (!res.ok) {
		const err = (json as { error?: { reason?: string; message?: string } } | null)?.error;
		throw new PrintfulError(
			res.status,
			err?.reason ?? "Unknown",
			err?.message ?? JSON.stringify(json),
		);
	}
	return (json as PrintfulEnvelope<T>).result;
}

// ── Types, exactly the fields this integration reads ──────────────────────────

export interface PrintfulCatalogVariant {
	id: number;
	product_id: number;
	name: string;
	size: string;
	color: string;
	price: string;
	in_stock: boolean;
}

export interface PrintfulSyncVariant {
	id: number;
	external_id: string | null;
	name: string;
	sync_product_id: number;
	variant_id: number;
	retail_price: string | null;
	currency: string;
	files: Array<{ type: string; id: number; url?: string }>;
}

export interface PrintfulOrderCosts {
	currency: string;
	subtotal: string;
	discount: string;
	shipping: string;
	tax: string;
	vat: string;
	total: string;
}

export interface PrintfulOrder {
	id: number;
	external_id: string | null;
	status: string;
	created: number;
	updated: number;
	costs: PrintfulOrderCosts;
	retail_costs: PrintfulOrderCosts | null;
	shipments: Array<{
		id: number;
		carrier: string;
		service: string;
		tracking_number: string | number;
		tracking_url: string;
		ship_date: string;
		shipped_at: number | null;
	}>;
}

export interface PrintfulShippingOption {
	id: string;
	name: string;
	rate: string;
	currency: string;
	minDeliveryDays: number;
	maxDeliveryDays: number;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** One catalog variant — the blank garment+size+color. Price is `null` when unconfigured. */
export async function getCatalogVariant(variantId: number): Promise<PrintfulCatalogVariant | null> {
	if (!printfulConfigured()) return null;
	return call<{ variant: PrintfulCatalogVariant }>("GET", `/products/variant/${variantId}`).then(
		(r) => r.variant,
	);
}

/** One sync variant by Printful's id — the in-store representation. */
export async function getSyncVariant(syncVariantId: number): Promise<PrintfulSyncVariant | null> {
	if (!printfulConfigured()) return null;
	return call<PrintfulSyncVariant>("GET", `/sync/variants/${syncVariantId}`);
}

/**
 * Shipping options for a recipient country + a set of catalog variants — the quote's
 * live source. Only country/state is required; Printful's US rates are flat per product
 * category, so the figure is real without the buyer's ZIP. Rates are dynamic and are not
 * cached — the docs' warning about mismatched displayed vs charged rates is read as
 * binding for a checkout path.
 */
export async function getShippingRates(
	recipient: { country_code: string; state_code?: string },
	items: Array<{ catalogVariantId: number; quantity: number }>,
): Promise<PrintfulShippingOption[] | null> {
	if (!printfulConfigured()) return null;
	return call<PrintfulShippingOption[]>("POST", "/shipping/rates", {
		recipient,
		items: items.map((i) => ({ variant_id: i.catalogVariantId, quantity: i.quantity })),
	});
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** The order-placement shape — exactly the fields this integration sets. */
export interface PrintfulOrderInput {
	externalId: string;
	recipient: {
		name: string;
		address1: string;
		address2?: string;
		city: string;
		state_code: string;
		country_code: string;
		zip: string;
		email?: string;
	};
	items: Array<{
		syncVariantId: number;
		quantity: number;
		retailPrice: string;
	}>;
	/** The shipping method id from a `getShippingRates` answer, e.g. "STANDARD". */
	shippingMethod: string;
}

/**
 * Place an order, confirmed for fulfillment in the same call (`confirm: true` skips the
 * draft). Idempotent by `external_id` + `update_existing`: a retried placement after a
 * network failure updates the existing order rather than making a second one — the docs'
 * own recommendation, and the same shape the Stripe flows' idempotency latches take.
 */
export async function placeOrder(input: PrintfulOrderInput): Promise<PrintfulOrder | null> {
	if (!printfulConfigured()) return null;
	return call<{ result: PrintfulOrder }>("POST", "/orders?confirm=true&update_existing=true", {
		external_id: input.externalId,
		shipping: input.shippingMethod,
		recipient: input.recipient,
		items: input.items.map((i) => ({
			sync_variant_id: i.syncVariantId,
			quantity: i.quantity,
			retail_price: i.retailPrice,
		})),
	}).then((r) => r.result);
}

/** One order by id — the webhook receiver's read-back, the hint verifying itself. */
export async function getOrder(orderId: number): Promise<PrintfulOrder | null> {
	if (!printfulConfigured()) return null;
	return call<PrintfulOrder>("GET", `/orders/${orderId}`);
}

/** Cancel an order — printable only in draft/pending; later states answer 400 and the refund path records that. */
export async function cancelOrder(orderId: number): Promise<boolean> {
	if (!printfulConfigured()) return false;
	try {
		await call("DELETE", `/orders/${orderId}`);
		return true;
	} catch {
		return false;
	}
}

/** Set the store's webhook configuration — the setup script's step, not a runtime call. */
export async function setWebhookUrl(url: string, types: string[]): Promise<boolean> {
	if (!printfulConfigured()) return false;
	try {
		await call("POST", "/webhooks", { url, types });
		return true;
	} catch {
		return false;
	}
}

// ── The fulfillment record ────────────────────────────────────────────────────

export type MerchFulfillment = typeof merchFulfillments.$inferSelect;

/**
 * `merch_fulfillments` upsert for a purchase: the row exists from the moment a merch
 * purchase completes (pending placement, for the sweep to retry), and placement or a
 * webhook updates it in place. One row per purchase, by the unique index.
 */
export async function ensureFulfillment(purchaseId: number): Promise<MerchFulfillment> {
	const [existing] = await db
		.select()
		.from(merchFulfillments)
		.where(eq(merchFulfillments.purchaseId, purchaseId))
		.limit(1);
	if (existing) return existing;
	return (await db.insert(merchFulfillments).values({ purchaseId }).returning())[0];
}

/** Append one event to the fulfillment's log and, where given, update the live columns. */
export async function recordFulfillmentEvent(
	fulfillmentId: number,
	event: { type: string; occurredAt: string; note?: string },
	patch: Partial<typeof merchFulfillmentsTable.$inferInsert> = {},
): Promise<void> {
	const [row] = await db
		.select({ events: merchFulfillments.events })
		.from(merchFulfillments)
		.where(eq(merchFulfillments.id, fulfillmentId))
		.limit(1);
	await db
		.update(merchFulfillments)
		.set({ events: [...(row?.events ?? []), event], updatedAt: new Date(), ...patch })
		.where(eq(merchFulfillments.id, fulfillmentId));
}

/**
 * Stamp Printful's costs onto the purchase row — from `estimate-costs`/the order's own
 * `costs` object. Nothing else writes this column (`purchases.printful_costs`).
 */
export async function stampPrintfulCosts(
	purchaseId: number,
	costs: PrintfulOrderCosts,
): Promise<void> {
	await db
		.update(purchases)
		.set({
			printfulCosts: {
				subtotal: costs.subtotal,
				shipping: costs.shipping,
				tax: costs.tax,
				total: costs.total,
			},
			updatedAt: new Date(),
		})
		.where(eq(purchases.id, purchaseId));
}

/** The margin on a merch list price — print cost plus `MERCH_MARGIN_DOLLARS`, as Decimal ops. */
export function merchListPrice(printCost: string | Decimal): Decimal {
	return new Decimal(printCost).plus(MERCH_MARGIN_DOLLARS);
}

// ── Order placement (the completion path's write) ─────────────────────────────

export interface MerchPlacementInput {
	purchaseId: number;
	syncVariantId: number;
	quantity: number;
	retailPrice: string;
	shippingMethod: string;
	recipient: PrintfulOrderInput["recipient"];
}

/**
 * Place (or re-place) the Printful order for one completed merch purchase, and write the
 * fulfillment row. Returns the fulfillment row; `placedAt` null means the placement did
 * not succeed and the sweep will retry.
 *
 * 🚨 **The buyer has already paid when this runs** — the completion path calls it after
 * the purchase row flipped to `completed` — so a placement failure is never the buyer's
 * problem and never blocks their receipt: it is recorded on the fulfillment row
 * (`placementError`, `placementAttempts`) and the sweep retries. The one exception is a
 * not-configured client, which returns the pending row without an attempt (a dev-session
 * or half-configured environment must not manufacture a failure record for a placement
 * that was never possible).
 */
export async function placeMerchOrder(input: MerchPlacementInput): Promise<MerchFulfillment> {
	const row = await ensureFulfillment(input.purchaseId);
	if (row.placedAt) return row; // latched — a redelivered completion cannot re-place

	if (!printfulConfigured()) return row;

	const attempts = row.placementAttempts + 1;
	try {
		const order = await placeOrder({
			externalId: `purchase-${input.purchaseId}`,
			recipient: input.recipient,
			shippingMethod: input.shippingMethod,
			items: [
				{
					// The Printful id, not our own — the order names the store's variant.
					syncVariantId: input.syncVariantId,
					quantity: input.quantity,
					retailPrice: input.retailPrice,
				},
			],
		});
		if (!order) throw new PrintfulError(0, "NotConfigured", "client returned null");
		// The order's own costs object is the authoritative fulfillment-cost snapshot.
		await stampPrintfulCosts(input.purchaseId, order.costs);
		await db
			.update(merchFulfillments)
			.set({
				printfulOrderId: order.id,
				printfulStatus: order.status,
				placedAt: new Date(),
				placementError: null,
				placementAttempts: attempts,
				updatedAt: new Date(),
			})
			.where(eq(merchFulfillments.id, row.id));
		await recordFulfillmentEvent(row.id, {
			type: "order_placed",
			occurredAt: new Date().toISOString(),
			note: `Printful order ${order.id}, status ${order.status}`,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db
			.update(merchFulfillments)
			.set({ placementError: message, placementAttempts: attempts, updatedAt: new Date() })
			.where(eq(merchFulfillments.id, row.id));
	}
	return (
		await db.select().from(merchFulfillments).where(eq(merchFulfillments.id, row.id)).limit(1)
	)[0];
}

// ── The webhook receiver's write ──────────────────────────────────────────────

/**
 * Handle one inbound Printful event: find the fulfillment by the Printful order id,
 * re-read the order from the API, and write state only from that answer. Returns how
 * many records moved (0 is ordinary — an order this store does not own, or an event
 * type nothing here tracks).
 */
export async function receiveMerchWebhook(
	type: string,
	printfulOrderId: number,
): Promise<{ matched: number; reason?: string }> {
	const [row] = await db
		.select()
		.from(merchFulfillments)
		.where(eq(merchFulfillments.printfulOrderId, printfulOrderId))
		.limit(1);
	if (!row) return { matched: 0, reason: "unknown_order" };

	// The hint verifying itself: state comes from the API's answer, never the payload.
	const order = await getOrder(printfulOrderId);
	if (!order) {
		// A fetch that answered nothing is recorded as *seen* and left otherwise alone —
		// Printful will redeliver if it matters, and failing the POST here would loop.
		await recordFulfillmentEvent(row.id, {
			type: `webhook_${type}`,
			occurredAt: new Date().toISOString(),
			note: "order read-back unavailable; state unchanged",
		});
		return { matched: 1 };
	}

	const patch: Partial<typeof merchFulfillmentsTable.$inferInsert> = {
		printfulStatus: order.status,
		updatedAt: new Date(),
	};
	// The newest shipment's tracking url is the buyer-facing one.
	const shipment = order.shipments[order.shipments.length - 1];
	if (type === "package_shipped" && shipment?.tracking_url)
		patch.trackingUrl = shipment.tracking_url;

	await recordFulfillmentEvent(
		row.id,
		{ type: `webhook_${type}`, occurredAt: new Date().toISOString(), note: order.status },
		patch,
	);
	return { matched: 1 };
}

/**
 * Unwind a merch purchase's fulfillment on a refund: cancel the Printful order where its
 * status still allows (draft/pending), and record the outcome either way. Cancellation
 * after Printful began fulfilling is NOT forced — the goods exist, the B-stock posture
 * owns what happens to them, and fighting the vendor's fulfillment state to save a shirt
 * is not a decision a webhook should make.
 */
export async function unwindMerchOrder(purchaseId: number): Promise<void> {
	const [row] = await db
		.select()
		.from(merchFulfillments)
		.where(eq(merchFulfillments.purchaseId, purchaseId))
		.limit(1);
	if (!row?.printfulOrderId || row.placedAt == null) return;
	const canceled = await cancelOrder(row.printfulOrderId);
	await recordFulfillmentEvent(row.id, {
		type: canceled ? "order_canceled_refund" : "cancel_refused_refund",
		occurredAt: new Date().toISOString(),
		...(canceled ? {} : { note: "Printful refused cancellation; B-stock path handles the goods" }),
	});
	if (canceled) {
		await db
			.update(merchFulfillments)
			.set({ printfulStatus: "canceled", updatedAt: new Date() })
			.where(eq(merchFulfillments.id, row.id));
	}
}
