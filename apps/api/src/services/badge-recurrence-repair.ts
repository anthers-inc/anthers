// SPDX-License-Identifier: Apache-2.0
/**
 * Repair a Badge recurrence that a completed checkout left behind without a subscription.
 *
 * 🚨 **The charge date is the source of the reduction, never the repair date.** A Badge
 * bought on the 6th was charged the full month; the next 1st is reduced by the five days
 * before it began. A repair run on the 13th that used `new Date()` would record twelve days
 * and over-discount the renewal, so every reduction is computed from
 * `badge_charges.created_at` and the line's `charged_amount`.
 *
 * The service is deliberately handle-scoped rather than a blind sweep: a completed Badge
 * charge can belong to a buyer who canceled on purpose, and recreating every one of those
 * would resurrect a subscription somebody ended. An operator names the accounts to repair.
 */
import { db } from "@anthers/db/client";
import {
	badgeCharges,
	badges,
	billingReductions,
	stripeCustomers,
	users,
} from "@anthers/db/schema";
import {
	currentCycleKey,
	cycleKeyFor,
	cycleStart,
	nextCycleKey,
} from "@anthers/shared/billing-cycle";
import { reductionFor } from "@anthers/shared/fees";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import {
	attachPaymentMethod,
	createSubscription,
	listSubscriptions,
	retrievePaymentIntent,
	retrievePaymentMethod,
	updateCustomer,
} from "../lib/processor.js";
import { ensureBadgeProduct } from "./billing.js";

export interface BadgeRecurrenceRepair {
	handle: string;
	customer: string;
	paymentMethod: string;
	subscription: string | null;
	status: string;
	trialEnd: string;
	items: number;
	reductions: Array<{ cycle: string; destination: string; amount: string; line: string }>;
	applied: boolean;
	skipped?: string;
}

export async function repairMissingBadgeRecurrences({
	handles,
	apply,
}: {
	handles: string[];
	apply: boolean;
}): Promise<BadgeRecurrenceRepair[]> {
	if (handles.length === 0) throw new Error("name at least one handle to repair");
	const people = await db
		.select({ id: users.id, handle: users.atprotoHandle, email: users.email })
		.from(users)
		.where(inArray(users.atprotoHandle, handles));
	if (people.length !== handles.length) {
		const found = new Set(people.map((p) => p.handle));
		throw new Error(`unknown handle(s): ${handles.filter((h) => !found.has(h)).join(", ")}`);
	}

	const summary: BadgeRecurrenceRepair[] = [];
	for (const person of people) {
		const [acct] = await db
			.select()
			.from(stripeCustomers)
			.where(eq(stripeCustomers.userId, person.id))
			.limit(1);
		if (!acct?.stripeCustomerId) throw new Error(`${person.handle}: no Stripe customer`);
		if (acct.stripeSubscriptionId) {
			summary.push({
				handle: person.handle,
				customer: acct.stripeCustomerId,
				paymentMethod: "",
				subscription: acct.stripeSubscriptionId,
				status: "skipped",
				trialEnd: "",
				items: 0,
				reductions: [],
				applied: false,
				skipped: "already has a subscription",
			});
			continue;
		}

		const charges = await db
			.select()
			.from(badgeCharges)
			.where(and(eq(badgeCharges.buyerId, person.id), eq(badgeCharges.status, "completed")))
			.orderBy(badgeCharges.createdAt);
		if (charges.length === 0) throw new Error(`${person.handle}: no completed Badge charge`);

		const existing = listSubscriptions({
			customer: acct.stripeCustomerId,
			status: "all",
			limit: 1,
		});
		if (existing && (await existing).data.length > 0) {
			throw new Error(
				`${person.handle}: Stripe already has a subscription but the billing row does not name it`,
			);
		}

		const items: Stripe.SubscriptionCreateParams.Item[] = [];
		const reductions: Array<{ cycle: string; destination: string; amount: string; line: string }> =
			[];
		let pmId: string | null = null;

		for (const charge of charges) {
			if (!charge.creatorId || !charge.badgeId)
				throw new Error(`${person.handle}: incomplete charge ${charge.id}`);
			const pi = await retrievePaymentIntent(charge.stripePaymentIntentId, {
				expand: ["payment_method"],
			});
			const method = pi?.payment_method;
			const id = typeof method === "string" ? method : method?.id;
			if (!id)
				throw new Error(`${person.handle}: no payment method on ${charge.stripePaymentIntentId}`);
			if (pmId && pmId !== id) throw new Error(`${person.handle}: charges used different cards`);
			pmId = id;

			const [issuer] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, charge.creatorId))
				.limit(1);
			const [badge] = await db
				.select({ product: badges.stripeProductId })
				.from(badges)
				.where(eq(badges.id, charge.badgeId))
				.limit(1);
			const product = badge?.product
				? badge.product
				: apply
					? await ensureBadgeProduct(
							charge.badgeId,
							charge.badgeLabel ?? `$${charge.threshold}`,
							issuer?.handle ?? "unknown",
						)
					: "(would create a product)";
			items.push({
				price_data: {
					currency: "usd",
					product,
					unit_amount: Math.round(Number(charge.threshold) * 100),
					recurring: { interval: "month" },
					tax_behavior: "exclusive",
				},
				quantity: 1,
				metadata: { destination: String(charge.creatorId) },
			});
			const amount = reductionFor(Number(charge.chargedAmount), charge.createdAt);
			reductions.push({
				cycle: nextCycleKey(cycleKeyFor(charge.createdAt)),
				destination: String(charge.creatorId),
				amount: amount.toFixed(2),
				line: Number(charge.threshold).toFixed(2),
			});
		}

		if (!pmId) throw new Error(`${person.handle}: no payment method`);
		const method = await retrievePaymentMethod(pmId);
		const billing = method?.billing_details;
		const address = billing?.address;
		if (
			!address?.line1 ||
			!address.city ||
			!address.state ||
			!address.postal_code ||
			!address.country
		)
			throw new Error(`${person.handle}: the saved card has no usable billing address`);

		const trialEnd = Math.floor(cycleStart(nextCycleKey(currentCycleKey())).getTime() / 1000);
		let subscription: Stripe.Subscription | null = null;

		if (apply) {
			const attachedTo =
				typeof method?.customer === "string" ? method.customer : (method?.customer?.id ?? null);
			if (attachedTo !== acct.stripeCustomerId) {
				await attachPaymentMethod(pmId, acct.stripeCustomerId);
			}
			await updateCustomer(acct.stripeCustomerId, {
				email: person.email,
				...(billing?.name ? { name: billing.name } : {}),
				address: {
					line1: address.line1,
					...(address.line2 ? { line2: address.line2 } : {}),
					city: address.city,
					state: address.state,
					postal_code: address.postal_code,
					country: address.country,
				},
				invoice_settings: { default_payment_method: pmId },
			});
			subscription = await createSubscription({
				customer: acct.stripeCustomerId,
				items,
				trial_end: trialEnd,
				automatic_tax: { enabled: true },
				default_payment_method: pmId,
				metadata: { userId: String(person.id) },
			});
			if (!subscription) throw new Error(`${person.handle}: Stripe returned no subscription`);

			await db
				.update(stripeCustomers)
				.set({ stripeSubscriptionId: subscription.id, isActive: true, updatedAt: new Date() })
				.where(eq(stripeCustomers.userId, person.id));

			for (const reduction of reductions) {
				if (Number(reduction.amount) <= 0) continue;
				const [already] = await db
					.select({ id: billingReductions.id })
					.from(billingReductions)
					.where(
						and(
							eq(billingReductions.userId, person.id),
							eq(billingReductions.billingCycle, reduction.cycle),
							eq(billingReductions.destination, reduction.destination),
						),
					)
					.limit(1);
				if (already) continue;
				await db.insert(billingReductions).values({
					userId: person.id,
					billingCycle: reduction.cycle,
					destination: reduction.destination,
					amount: reduction.amount,
				});
			}
		}

		summary.push({
			handle: person.handle,
			customer: acct.stripeCustomerId,
			paymentMethod: pmId,
			subscription: subscription?.id ?? null,
			status: subscription?.status ?? "dry run",
			trialEnd: new Date(trialEnd * 1000).toISOString(),
			items: items.length,
			reductions,
			applied: apply,
		});
	}
	return summary;
}
