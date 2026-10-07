// SPDX-License-Identifier: Apache-2.0
/**
 * Re-send the buyer's receipt for one production transaction, through the production
 * senders — run by hand, never by a test or CI:
 *
 *     make receipt-replay INTENT=pi_…
 *     make receipt-replay REFUND=re_…
 *
 * This exists because anthers.org went live against Stripe before receipts did: the
 * platform's first real charge (2026-10-07) completed with the buyer told by nobody. The
 * machinery that now receipts every transaction cannot reach into the past on its own —
 * a completed purchase never re-fires `payment_intent.succeeded` — so this script is the
 * hand-crank, running the same sender the webhook would, against the rows production
 * still holds.
 *
 * 🚨 **Production data and production secrets, reached the way every production touch
 * is.** The rows through `make prod-db` (the connection string never crosses a command
 * line — `scripts/prod-db.ts` carries that incident), the Resend key through `bws run
 * --` (environment injection, never an argument). The Makefile target composes both, and
 * running the script bare from a dev checkout fails its environment checks below rather
 * than sending from the wrong place.
 *
 * The send is latched the way the webhook's would be: a `receipt_sends` row is written
 * with the same dedupe key the live trigger uses, before the send — so a second replay
 * no-ops exactly as a redelivered webhook would, and this script is safe to run twice
 * and useless to run twice. No creator-side copy is sent by a replay: the buyer's
 * receipt is the piece the transaction owes the person who paid, and the creator copy
 * of a past sale is the creator's own record already carried by the payout.
 *
 * ⚠️ **A REFUND replay is for a refund the receipts machinery arrived too late for.**
 * It reads the row's settled figures and signs them negative; it does not re-issue,
 * reverse, or net anything — that remains `services/refunds.ts`'s alone.
 */
import { parseArgs } from "node:util";
import { db } from "@anthers/db/client";
import { purchases, receiptSends, users } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import {
	type ReceiptLine,
	sendPurchaseReceiptEmail,
	sendRefundReceiptEmail,
} from "../apps/api/src/services/email";
import { bwsSecrets } from "./bws";

const TAG = "[receipt-replay]";

const parsed = parseArgs({
	options: { intent: { type: "string" }, refund: { type: "string" } },
	strict: false,
});
// `strict: false` widens every value to `string | boolean`; narrow it by hand, because
// the guards below compare these against literal strings and a boolean would be a
// `reference` that latches wrongly.
const intentValue = typeof parsed.values.intent === "string" ? parsed.values.intent : undefined;
const refundValue = typeof parsed.values.refund === "string" ? parsed.values.refund : undefined;

const intentId = intentValue ?? refundValue;
const what: "purchase" | "refund" = intentValue ? "purchase" : "refund";
if (!intentId || (intentValue && refundValue)) {
	console.error(`${TAG} pass exactly one of INTENT=pi_… or REFUND=re_… — see the header.`);
	process.exit(64);
}

// 🚨 **The key is fetched from Bitwarden's prod project at run time** — never an env the
// caller sets, never a value on a command line. Resend's keys carry no self-describing
// mode, so the check that this is the production key is that it comes from the
// production role's project, which `bwsSecrets("prod")` is the only door to.
const resendKey = (await bwsSecrets("prod")).get("RESEND_API_KEY") ?? "";
if (!resendKey) {
	console.error(
		`${TAG} the prod project holds no RESEND_API_KEY — is bws authenticated (DOCTL_CONTEXT / BWS access)?`,
	);
	process.exit(2);
}
process.env.RESEND_API_KEY = resendKey;

// This module runs inside `make prod-db CMD=` — the production session the Makefile
// injects DATABASE_URL into. A dev database would carry no such row; the lookup below
// is the check that the right database was reached, and it fails closed.
const rows = await db.select().from(purchases).where(eq(purchases.stripePaymentIntentId, intentId));
if (rows.length === 0) {
	console.error(
		`${TAG} no purchase rows carry ${intentId} — wrong id, or this is not the production database.`,
	);
	process.exit(1);
}

const buyerId = rows[0].buyerId;
if (buyerId == null) {
	console.error(
		`${TAG} the purchase's buyer is detached (account deleted); there is nobody to mail.`,
	);
	process.exit(1);
}
const [buyerUser] = await db
	.select({ email: users.email })
	.from(users)
	.where(eq(users.id, buyerId))
	.limit(1);
if (!buyerUser) {
	console.error(`${TAG} buyer ${buyerId} no longer exists; there is nobody to mail.`);
	process.exit(1);
}
const buyerEmail = buyerUser.email;

// Off the rows themselves — the transaction as it happened, tax and per-item figures
// as the completion webhook stamped them. A receipt does not consult the live catalog.
const lines: ReceiptLine[] = rows.map((r) => ({
	description: r.workTitle ?? `Work #${r.workId ?? "unknown"}`,
	amount: r.amount,
}));
const tax = rows.reduce((acc, r) => acc.plus(new Decimal(r.salesTax)), new Decimal(0));
const total = rows.reduce(
	(acc, r) => acc.plus(new Decimal(r.amount).plus(new Decimal(r.salesTax))),
	new Decimal(0),
);
const whatDate =
	what === "refund"
		? (rows[0].refundedAt ?? rows[0].updatedAt)
		: (rows[0].updatedAt ?? rows[0].createdAt);
const refundRef = rows[0].stripeRefundId;
if (what === "refund" && !refundRef) {
	console.error(
		`${TAG} the row carries no settle-time Stripe refund id — nothing honest to reference or latch on.`,
	);
	process.exit(1);
}
const reference = what === "refund" ? refundRef! : intentId;

// The dedupe key the live trigger uses, written BEFORE the send: a second replay
// no-ops exactly as a redelivered webhook would. (The live trigger keys one row per
// recipient; the replay sends the buyer's copy only, so the buyer key is the one.)
const dedupeKey = `${what}:${reference}:buyer:${buyerId}`;
const [latch] = await db
	.insert(receiptSends)
	.values({ dedupeKey, kind: what, userId: buyerId, role: "buyer", email: buyerEmail })
	.onConflictDoNothing({ target: receiptSends.dedupeKey })
	.returning({ id: receiptSends.id });
if (!latch) {
	console.log(
		`${TAG} a receipt for this transaction was already sent (its receipt_sends row exists) — nothing to do.`,
	);
	process.exit(0);
}

const signed = (s: string) => (what === "refund" ? new Decimal(s).negated().toFixed(2) : s);
const result =
	what === "purchase"
		? await sendPurchaseReceiptEmail({
				to: buyerEmail,
				reference,
				date: whatDate,
				lines,
				tax: tax.toFixed(2),
				total: total.toFixed(2),
			})
		: await sendRefundReceiptEmail({
				to: buyerEmail,
				reference,
				date: whatDate,
				lines,
				tax: signed(tax.toFixed(2)),
				total: signed(total.toFixed(2)),
			});

if (!result.sent) {
	console.error(
		`${TAG} the send did not go (receipt_sends row ${latch.id} records it as unsent) — read the [email] log lines above.`,
	);
	process.exit(1);
}
console.log(
	`${TAG} receipt sent to ${buyerEmail} (${what}, $${total.toFixed(2)}) — provider id ${result.messageId ?? "none"}`,
);
console.log(
	`${TAG} run inside \`make prod-db CMD="bun run scripts/receipt-replay.ts …"\` with \`bws run --\` — see the Makefile target.`,
);
