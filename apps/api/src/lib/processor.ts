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

/**
 * Mirrors `stripe.accounts.retrieve` — the connected account's live state, read by
 * `GET /stripe/onboard` (the reconcile-on-read self-heal, and the `?detail` shape the
 * Studio Payments tab renders): when our `stripe_connect_accounts` row disagrees with Stripe,
 * Stripe is what the row should say. Returns null when payments are unconfigured; callers
 * keep their 503 / skip behavior.
 */
export async function retrieveConnectAccount(accountId: string): Promise<Stripe.Account | null> {
	return (
		(await getStripe()
			?.accounts.retrieve(accountId)
			.catch(() => null)) ?? null
	);
}

/**
 * Mirrors `stripe.balance.retrieve` reading the connected account's own balance — the
 * account target rides the REQUEST OPTIONS' `stripeAccount` (a read on the account's
 * behalf, made from the platform's signing key), not the params object, which the SDK's
 * `BalanceRetrieveParams` does not carry. Its value is what the Studio Payments tab renders
 * as the Stripe balance card.
 */
export async function retrieveConnectBalance(
	accountId: string,
): Promise<Stripe.Response<Stripe.Balance> | null> {
	return (
		(await getStripe()
			?.balance.retrieve({}, { stripeAccount: accountId })
			.catch(() => null)) ?? null
	);
}

/** Mirrors `stripe.accountLinks.create` — the hosted onboarding flow for an account. */
export async function createAccountOnboardingLink(
	params: Stripe.AccountLinkCreateParams,
): Promise<Stripe.AccountLink | null> {
	return (await getStripe()?.accountLinks.create(params)) ?? null;
}

/**
 * Mirrors `stripe.accounts.createLoginLink` — a one-click door into the connected
 * account's own Express Dashboard, which the Studio Payments tab opens for a creator who
 * wants to change their payout schedule, read Stripe's notifications or see Stripe's fee
 * figures. The platform profile named that dashboard the creator's manual-payout surface,
 * so this is the door rather than a second payout UI beside it.
 */
export async function createAccountLoginLink(accountId: string): Promise<string | null> {
	const link = await getStripe()
		?.accounts.createLoginLink(accountId)
		.catch(() => null);
	return link?.url ?? null;
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

/**
 * Mirrors `stripe.checkout.sessions.retrieve` — one session by id, the read the basket
 * uses to decide whether the session an abandoned checkout left behind is still open
 * and still carrying the basket the buyer is looking at.
 */
export async function retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session | null> {
	return (await getStripe()?.checkout.sessions.retrieve(id)) ?? null;
}

/**
 * Mirrors `stripe.checkout.sessions.expire` — closes an open session so nobody can pay
 * it after the basket it was built from has changed. A session that is already complete
 * or expired refuses here; the caller reads that as "nothing left to close".
 */
export async function expireCheckoutSession(id: string): Promise<Stripe.Checkout.Session | null> {
	return (await getStripe()?.checkout.sessions.expire(id)) ?? null;
}

/**
 * Mirrors `stripe.tax.calculations.create` — a Stripe Tax quotation against a typed
 * address, no session and no charge. This is the store panel's live tax line: an ESTIMATE
 * by construction, because the checkout session's own tax resolves from the address the
 * buyer actually delivers to, which the quote can only stand in for. Returns null when
 * payments are unconfigured; a Stripe refusal (an address Stripe cannot resolve, most
 * often) propagates to the caller, which decides whether a failed estimate degrades to
 * "calculated at checkout" or refuses the surface.
 */
export async function createTaxCalculation(
	params: Stripe.Tax.CalculationCreateParams,
): Promise<Stripe.Tax.Calculation | null> {
	return (await getStripe()?.tax.calculations.create(params)) ?? null;
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

/**
 * Mirrors `stripe.customers.retrieve` — the Customer a saved billing address prefills
 * from. The only customer read the saved-address flow makes; callers treat null as
 * "nothing on file" as well as "payments unconfigured", which is the same no-op. A
 * *deleted* Customer is reachable here and narrows in the service.
 */
export async function retrieveCustomer(
	customerId: string,
): Promise<Stripe.Response<Stripe.Customer | Stripe.DeletedCustomer> | null> {
	return (
		(await getStripe()
			?.customers.retrieve(customerId)
			.catch(() => null)) ?? null
	);
}

/**
 * Mirrors `stripe.customers.update` — the saved billing address's only write. `address:
 * null` is the clear; a shape is the save. No `.catch`: a refused address must reach the
 * caller as an error, not as a silent no-save.
 */
export async function updateCustomer(
	customerId: string,
	params: Stripe.CustomerUpdateParams,
): Promise<Stripe.Customer | null> {
	return (await getStripe()?.customers.update(customerId, params)) ?? null;
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

/**
 * Mirrors `stripe.refunds.list` — the refunds on a charge, as Stripe's auto-paginating list.
 *
 * The caller is the webhook's `charge.refunded` dashboard path, and it must read Stripe's
 * truth rather than trust the event: the live account's newer API version delivers the
 * event's charge snapshot with the `refunds` list omitted entirely (found 2026-10-14 by
 * the first live dashboard-path refund, when the settle stamped no refund id and read the
 * reversal as absent — `services/netting.ts`'s no-identity guard then skipped a netting
 * the transfer's actual reversal made unnecessary, which is the coincidence this defends).
 * Deliberately no `.catch`: an API failure here should fail the webhook delivery so Stripe
 * redelivers and the settle runs on recovered facts, rather than settling on the event's
 * degraded shape.
 */
export async function listRefundsForCharge(
	chargeId: string,
): Promise<Stripe.ApiList<Stripe.Refund> | null> {
	return (await getStripe()?.refunds.list({ charge: chargeId })) ?? null;
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
 * Mirrors `stripe.invoiceItems.create` — a line added to a draft invoice (or to the next
 * upcoming one when no invoice is named). The storage top-up's charging surface: a
 * per-cycle line on the draft renewal, priced at cost against the Anthers Product.
 */
export async function createInvoiceItem(
	params: Stripe.InvoiceItemCreateParams,
): Promise<Stripe.InvoiceItem | null> {
	return (await getStripe()?.invoiceItems.create(params)) ?? null;
}

/** Mirrors `stripe.invoiceItems.list` — the items already on a draft, for the stamp lookup. */
export async function listDraftInvoiceItems(
	params: Stripe.InvoiceItemListParams,
): Promise<Stripe.ApiList<Stripe.InvoiceItem> | null> {
	return (await getStripe()?.invoiceItems.list(params)) ?? null;
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
 * Mirrors `stripe.transfers.createReversal` — reversing some or all of a transfer the
 * completion path made, the clawback half of the split.
 *
 * The sole caller is `services/refunds.ts`: a purchase refund returns the buyer's
 * money at the charge and then reverses the creator's share off the transfer that
 * carried it, for the row's own earnings — never more, so a creator is never billed
 * for someone else's refund (the module's first invariant, unchanged by the split).
 * The idempotency key is the caller's to derive, from the purchase id, for the same
 * crash-window reason `refundPurchase` derives its refund key.
 *
 * ⚠️ **Reversals draw from the connected account's balance.** A creator who has
 * already paid the money out cannot fund one — the call throws (Stripe's
 * `balance_insufficient`) — and that failure is not an error state but the observable
 * the netting ledger keys on: the share did not come back, so recovery moves to the
 * creator's later earnings (`services/netting.ts`). The caller catches and books
 * rather than retries.
 */
export async function createTransferReversal(
	transferId: string,
	params: Stripe.TransferCreateReversalParams,
	options?: Stripe.RequestOptions,
): Promise<Stripe.TransferReversal | null> {
	return (await getStripe()?.transfers.createReversal(transferId, params, options)) ?? null;
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
