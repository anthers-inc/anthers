// SPDX-License-Identifier: Apache-2.0
/**
 * Reading a Stripe invoice the way Stripe actually shapes it.
 *
 * Two readers take an invoice apart — the subledger recording what was paid, and the day-exact
 * reduction spending what is owed against a renewal — and both need the same two answers: which
 * month the invoice pays for, and every one of its lines. Both answers have a plausible-looking
 * field that is wrong, and a hand-built test invoice cannot tell the difference, so they are read
 * here once. `make stripe-walk` is what checks them against Stripe itself.
 */
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";

/**
 * The month an invoice pays for, read from its subscription lines' service period.
 *
 * 🚨 **Never from `invoice.period_start`.** On a renewal Stripe sets that to the start of the
 * PREVIOUS period — the usage period the invoice looks back over — so an October renewal reads as
 * September there while every one of its lines says October. Keyed on the invoice-level field, a
 * renewal is discounted against the wrong month's reductions and credited to the wrong month's
 * creators, and every total still adds up.
 *
 * The latest line start wins: a renewal's lines all open the new month, and a mid-month raise's
 * lines are prorated from the period's own start, so either way the answer is the month the
 * money is for. An invoice with no subscription lines falls back to `period_end`, which on a
 * subscription invoice is where the covered period begins.
 */
export function cycleInvoicePaysFor(invoice: Stripe.Invoice): string {
	const starts = (invoice.lines?.data ?? [])
		.filter((line) => line.parent?.subscription_item_details)
		.map((line) => line.period?.start)
		.filter((start): start is number => typeof start === "number");
	const start =
		starts.length > 0 ? Math.max(...starts) : (invoice.period_end ?? invoice.period_start ?? 0);
	return cycleKeyFor(new Date(start * 1000));
}

/**
 * Every line on an invoice, not only the ones embedded in it.
 *
 * ⚠️ **An invoice object carries its first ten lines and says `has_more` for the rest**, in a
 * webhook payload as anywhere else. A supporter backing more than nine creators has an invoice
 * whose embedded lines leave somebody out, so the rest are listed from Stripe.
 */
export async function allInvoiceLines(invoice: Stripe.Invoice): Promise<Stripe.InvoiceLineItem[]> {
	const embedded = invoice.lines?.data ?? [];
	if (!invoice.lines?.has_more || !invoice.id) return embedded;
	const stripe = getStripe();
	if (!stripe) return embedded;
	const all: Stripe.InvoiceLineItem[] = [];
	for await (const line of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) {
		all.push(line);
	}
	return all;
}
