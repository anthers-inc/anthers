// SPDX-License-Identifier: Apache-2.0
/**
 * The processor boundary — the one module that talks to Stripe.
 *
 * Every payment operation goes through a function here, never as a direct SDK call from a
 * route or a service. This is deliberate even though Anthers runs on Stripe today:
 * creator platforms sit in Stripe's **Restricted** category — supported, but at the
 * vendor's discretion and revocable — so the payment processor must stay swappable, and
 * every direct SDK call written outside this boundary is one more thing to unpick if the
 * vendor has to change. When a new payment operation is needed, add a function to this
 * module; do not call the SDK anywhere else.
 *
 * **The "you handle pricing" rates are architectural, not negotiable.** Anthers charges
 * buyers and allocates to creators as separate-charges-and-transfers — the Time Pool
 * allocates *after* the charge — which is incompatible with the "Stripe handles pricing"
 * tier. No rate optimization can move Anthers into that tier, so pricing decisions stay
 * on our side of this boundary.
 *
 * Each function resolves the shared client from `getStripe()` on every call, so the
 * tests' `setStripeClient` seam keeps driving every path, and returns `null` when
 * payments are unconfigured so callers preserve their existing 503 / refusal behavior.
 * One function per call site, mirroring the Stripe operation it wraps — this module IS
 * the interface; there is deliberately no generic abstraction or provider layer beneath it.
 */
import type Stripe from "stripe";
import { getStripe } from "./stripe.js";

/**
 * Whether a payment operation is possible at all — false when no processor client is
 * configured, which routes turn into their existing 503 responses.
 */
export function paymentsConfigured(): boolean {
	return getStripe() !== null;
}

/** Mirrors `stripe.accounts.create` — the Connect account a creator is paid through. */
export async function createConnectAccount(
	params: Stripe.AccountCreateParams,
): Promise<Stripe.Account | null> {
	return (await getStripe()?.accounts.create(params)) ?? null;
}

/** Mirrors `stripe.accountLinks.create` — the hosted onboarding flow for an account. */
export async function createAccountOnboardingLink(
	params: Stripe.AccountLinkCreateParams,
): Promise<Stripe.AccountLink | null> {
	return (await getStripe()?.accountLinks.create(params)) ?? null;
}

/** Mirrors `stripe.paymentIntents.create` — a charge against a buyer's card. */
export async function createPaymentIntent(
	params: Stripe.PaymentIntentCreateParams,
): Promise<Stripe.PaymentIntent | null> {
	return (await getStripe()?.paymentIntents.create(params)) ?? null;
}

/**
 * Mirrors `stripe.checkout.sessions.create` — a Checkout Session, the only charge shape that
 * can carry a product tax code and so the only path a purchase may be charged through since
 * real tax calculation landed. In `ui_mode: "elements"` the session's `client_secret` is
 * handed to the browser, which mounts the Payment Element from it and confirms there.
 */
export async function createCheckoutSession(
	params: Stripe.Checkout.SessionCreateParams,
): Promise<Stripe.Checkout.Session | null> {
	return (await getStripe()?.checkout.sessions.create(params)) ?? null;
}

/**
 * Mirrors `stripe.checkout.sessions.list` — sessions by filter, here to find the one a
 * completed PaymentIntent belongs to. The session id does not exist when the
 * PaymentIntent's metadata is written (Stripe creates the intent inside the session), so
 * the session cannot be named in advance — it has to be looked up by the intent.
 */
export function listCheckoutSessions(
	params: Stripe.Checkout.SessionListParams,
): Stripe.ApiListPromise<Stripe.Checkout.Session> | null {
	return getStripe()?.checkout.sessions.list(params) ?? null;
}

/** Mirrors `stripe.webhooks.constructEventAsync` — signature verification for an inbound event. */
export async function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
): Promise<Stripe.Event | null> {
	return (await getStripe()?.webhooks.constructEventAsync(payload, signature, secret)) ?? null;
}

/** Mirrors `stripe.subscriptions.retrieve` — a subscription by id, or null when unknown. */
export async function retrieveSubscription(
	subscriptionId: string,
): Promise<Stripe.Subscription | null> {
	return (
		(await getStripe()
			?.subscriptions.retrieve(subscriptionId)
			.catch(() => null)) ?? null
	);
}

/** Mirrors `stripe.subscriptions.update` — changing an existing subscription. */
export async function updateSubscription(
	subscriptionId: string,
	params: Stripe.SubscriptionUpdateParams,
): Promise<Stripe.Subscription | null> {
	return (await getStripe()?.subscriptions.update(subscriptionId, params)) ?? null;
}

/** Mirrors `stripe.subscriptions.create` — a new subscription. */
export async function createSubscription(
	params: Stripe.SubscriptionCreateParams,
): Promise<Stripe.Subscription | null> {
	return (await getStripe()?.subscriptions.create(params)) ?? null;
}

/** Mirrors `stripe.paymentMethods.list` — the cards on file for a customer. */
export async function listCardPaymentMethods(
	params: Stripe.PaymentMethodListParams,
): Promise<Stripe.ApiList<Stripe.PaymentMethod> | null> {
	return (await getStripe()?.paymentMethods.list(params)) ?? null;
}

/** Mirrors `stripe.invoices.createPreview` — what a subscription change would cost. */
export async function previewInvoice(
	params: Stripe.InvoiceCreatePreviewParams,
): Promise<Stripe.Invoice | null> {
	return (await getStripe()?.invoices.createPreview(params)) ?? null;
}

/** Mirrors `stripe.billingPortal.sessions.create` — the customer's billing portal session. */
export async function createBillingPortalSession(
	params: Stripe.BillingPortal.SessionCreateParams,
): Promise<Stripe.BillingPortal.Session | null> {
	return (await getStripe()?.billingPortal.sessions.create(params)) ?? null;
}

/** Mirrors `stripe.products.list` — active Products, as Stripe's auto-paginating list. */
export function listActiveProducts(): Stripe.ApiListPromise<Stripe.Product> | null {
	return getStripe()?.products.list({ limit: 100, active: true }) ?? null;
}

/** Mirrors `stripe.products.create` — a new Product. */
export async function createProduct(
	params: Stripe.ProductCreateParams,
): Promise<Stripe.Product | null> {
	return (await getStripe()?.products.create(params)) ?? null;
}

/**
 * Mirrors `stripe.products.update` — changing a Product, here to keep its tax code honest
 * when what a creator's support buys changes (a gate ladder appearing or disappearing).
 */
export async function updateProduct(
	productId: string,
	params: Stripe.ProductUpdateParams,
): Promise<Stripe.Product | null> {
	return (await getStripe()?.products.update(productId, params)) ?? null;
}

/** Mirrors `stripe.customers.create` — a new Customer. */
export async function createCustomer(
	params: Stripe.CustomerCreateParams,
): Promise<Stripe.Customer | null> {
	return (await getStripe()?.customers.create(params)) ?? null;
}

/** Mirrors `stripe.setupIntents.create` — a card check that moves no money. */
export async function createSetupIntent(
	params: Stripe.SetupIntentCreateParams,
): Promise<Stripe.SetupIntent | null> {
	return (await getStripe()?.setupIntents.create(params)) ?? null;
}

/** Mirrors `stripe.invoicePayments.list` — the payments that paid an invoice. */
export async function listPaidInvoicePayments(
	params: Stripe.InvoicePaymentListParams,
): Promise<Stripe.ApiList<Stripe.InvoicePayment> | null> {
	return (await getStripe()?.invoicePayments.list(params)) ?? null;
}

/** Mirrors `stripe.paymentIntents.retrieve` — a PaymentIntent by id. */
export async function retrievePaymentIntent(
	paymentIntentId: string,
	params: Stripe.PaymentIntentRetrieveParams,
): Promise<Stripe.PaymentIntent | null> {
	return (await getStripe()?.paymentIntents.retrieve(paymentIntentId, params)) ?? null;
}

/** Mirrors `stripe.charges.retrieve` — a Charge by id. */
export async function retrieveCharge(
	chargeId: string,
	params: Stripe.ChargeRetrieveParams,
): Promise<Stripe.Charge | null> {
	return (await getStripe()?.charges.retrieve(chargeId, params)) ?? null;
}

/** Mirrors `stripe.invoices.listLineItems` — every line on an invoice, as Stripe's auto-paginating list. */
export function listInvoiceLineItems(
	invoiceId: string,
): Stripe.ApiListPromise<Stripe.InvoiceLineItem> | null {
	return getStripe()?.invoices.listLineItems(invoiceId, { limit: 100 }) ?? null;
}

/** Mirrors `stripe.refunds.create` — money back to a buyer. `options` carries the idempotency key. */
export async function issueRefund(
	params: Stripe.RefundCreateParams,
	options?: Stripe.RequestOptions,
): Promise<Stripe.Refund | null> {
	return (await getStripe()?.refunds.create(params, options)) ?? null;
}

/** Mirrors `stripe.coupons.create` — the coupon a reduction's discount is carried on. */
export async function createCoupon(
	params: Stripe.CouponCreateParams,
): Promise<Stripe.Coupon | null> {
	return (await getStripe()?.coupons.create(params)) ?? null;
}

/** Mirrors `stripe.invoices.updateLines` — attaching discounts to a draft invoice's lines. */
export async function updateInvoiceLines(
	invoiceId: string,
	params: Stripe.InvoiceUpdateLinesParams,
): Promise<Stripe.Invoice | null> {
	return (await getStripe()?.invoices.updateLines(invoiceId, params)) ?? null;
}

/**
 * Mirrors `stripe.transfers.create` — moving settled, held money from Anthers' platform
 * balance into a creator's connected-account balance (`transfer-held-credits.ts`, the
 * monthly transfer step of the 2026-09-14 payouts decision). `options` carries the
 * idempotency key, which is not optional at this call site: the job derives it
 * deterministically from the coverage set so a crash between the Stripe call and the DB
 * write cannot double-transfer on retry. See the job's docblock for the crash-window
 * reasoning.
 */
export async function createTransfer(
	params: Stripe.TransferCreateParams,
	options?: Stripe.RequestOptions,
): Promise<Stripe.Transfer | null> {
	return (await getStripe()?.transfers.create(params, options)) ?? null;
}

/**
 * Mirrors `stripe.transfers.retrieve` — a transfer by id, or null when unknown. The retry
 * path uses this to confirm a transfer Stripe says already exists under the idempotency
 * key, so a crash-window recovery reads the amount and the created moment from Stripe
 * rather than guessing.
 */
export async function retrieveTransfer(transferId: string): Promise<Stripe.Transfer | null> {
	return (
		(await getStripe()
			?.transfers.retrieve(transferId)
			.catch(() => null)) ?? null
	);
}

/**
 * Mirrors `stripe.disputes.update` — submitting evidence to a dispute. The contest path
 * (`services/disputes.ts`, the admin route's only door to this) is the sole caller, and it
 * sends `submit: true` so the evidence goes to the bank rather than staging in the
 * Dashboard: a person chose to contest, and a staged submission nothing finished would
 * read as contested when it was not.
 *
 * The params type carries Visa Compelling Evidence 3.0's enhanced shape too
 * (`evidence.enhanced_evidence.visa_compelling_evidence_3`), which the SDK exposes. The
 * confirmed 2026-10-02 finding is that Stripe **autofills** the CE3.0 half —
 * `customer_purchase_ip`, `customer_email_address`, and the two prior undisputed
 * transactions — from the transaction history it holds as the processor, so a contest
 * submits the plain evidence fields (what the Work was, when, to whom) and lets Stripe
 * assemble the program evidence itself.
 */
export async function updateDisputeEvidence(
	disputeId: string,
	params: Stripe.DisputeUpdateParams,
): Promise<Stripe.Dispute | null> {
	return (await getStripe()?.disputes.update(disputeId, params)) ?? null;
}

/**
 * Mirrors `stripe.disputes.retrieve` — a dispute by id, or null when unknown. The contest
 * path uses this to read the dispute back after submitting evidence, so the record shows
 * the state Stripe reports rather than the state we assumed.
 */
export async function retrieveDispute(disputeId: string): Promise<Stripe.Dispute | null> {
	return (
		(await getStripe()
			?.disputes.retrieve(disputeId)
			.catch(() => null)) ?? null
	);
}
