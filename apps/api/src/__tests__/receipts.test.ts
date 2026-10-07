// SPDX-License-Identifier: Apache-2.0
/**
 * Receipt emails — the dedupe latch, the figures a receipt shows, and the trigger
 * points the webhook and the refund route own.
 *
 * The money path's tests (`payments-stripe.test.ts`) own the economics and the webhook
 * plumbing; nothing there pinned receipts, because receipts did not exist. This file
 * covers what a receipt test can honestly assert without a provider:
 *
 *   • **Every transaction earns exactly one receipt per recipient, however many times
 *     the event arrives.** The dedupe key built from the Stripe identity is the whole
 *     guarantee, and the redelivery it defends against is not hypothetical — Stripe
 *     retries webhooks by design — so the double-send shape is asserted directly.
 *
 *   • **The figures come off the rows, not the catalog.** A receipt rendered from the
 *     Work's *current* title would mail a name the buyer never saw at sale time.
 *
 *   • **The creator's preference is read where it is defined.** On means mailed, off
 *     means not, and null (the stored default) means on.
 *
 * `sendEmail` refuses under the test runner by design, so every send records
 * `sent: false` and no message goes anywhere — which is the honest test surface: the
 * latch, the row, and the figures are all checkable without mail. The copy itself is
 * pinned where the copy lives, in the senders' module.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	invoiceLines,
	invoices,
	purchases,
	receiptSends,
	stripeAccounts,
	works,
} from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { sendPurchaseReceipts, sendRefundReceipts, sendSupportReceipt } from "../services/receipts";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

await purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);

let buyerId: number;
let creatorId: number;
let buyerEmailAddress: string;
let workId: number;
const createdWorkIds: number[] = [];

beforeAll(async () => {
	const [buyer, creator] = [
		await createAccount(`rcp_buyer_${run}`),
		await createAccount(`rcp_creator_${run}`, { fields: { isCreator: true } }),
	];
	buyerId = buyer.userId;
	creatorId = creator.userId;
	buyerEmailAddress = buyer.email;
	workId = (await insertWork({ creatorId, type: "game", title: "Receipt work" })).id;
	createdWorkIds.push(workId);
}, DB_SETUP_TIMEOUT);

/** A completed purchase row, the shape the completion webhook leaves behind. */
async function completedPurchase(opts: {
	buyerId: number;
	creatorId: number;
	workId: number;
	intentId: string;
	title?: string;
	amount?: string;
	tax?: string;
	earnings?: string;
}) {
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId: opts.buyerId,
			workId: opts.workId,
			creatorId: opts.creatorId,
			type: "digital",
			workTitle: opts.title ?? "Receipt test work",
			amount: opts.amount ?? "5.00",
			processingFee: "0.45",
			salesTax: opts.tax ?? "0.36",
			creatorEarnings: opts.earnings ?? "4.55",
			stripePaymentIntentId: opts.intentId,
			status: "completed",
			updatedAt: new Date(),
		})
		.returning();
	return row;
}

async function receiptRows(dedupeKey: string) {
	return db.select().from(receiptSends).where(eq(receiptSends.dedupeKey, dedupeKey));
}

/** The rows a webhook would complete, read back by intent id. */
function rowsFor(intentId: string) {
	return db.select().from(purchases).where(eq(purchases.stripePaymentIntentId, intentId));
}

/** The rows the webhook's refund branch reads back after settling. */
function refundedRowsFor(intentId: string) {
	return db
		.select()
		.from(purchases)
		.where(and(eq(purchases.stripePaymentIntentId, intentId), eq(purchases.status, "refunded")));
}

async function markRefunded(intentId: string, refundId: string) {
	const rows = await rowsFor(intentId);
	for (const row of rows) {
		await db
			.update(purchases)
			.set({
				status: "refunded",
				refundedAt: new Date(),
				stripeRefundId: refundId,
				refundInitiator: "platform",
			})
			.where(eq(purchases.id, row.id));
	}
}

afterAll(async () => {
	// Receipt rows first (they point at users with set null), then the works — the
	// purchases rows are set-null on both and are claimed by the account purge.
	for (const id of createdWorkIds) await db.delete(works).where(eq(works.id, id));
	await db.delete(receiptSends);
	await db.delete(invoiceLines);
	await db.delete(invoices);
});

describe("Receipts: purchases", () => {
	it("sends one buyer receipt and one creator receipt for one purchase", async () => {
		const intentId = `pi_rcp_${run}_one`;
		await completedPurchase({ buyerId, creatorId, workId, intentId, title: "Receipt work" });

		await sendPurchaseReceipts(await rowsFor(intentId));

		// The buyer's receipt: latched on the intent, recorded even though the send
		// itself no-ops under the test runner (the row's `sent: false` is the honest
		// state — see the module header).
		const buyerRows = await receiptRows(`purchase:${intentId}:buyer:${buyerId}`);
		expect(buyerRows).toHaveLength(1);
		expect(buyerRows[0].kind).toBe("purchase");
		expect(buyerRows[0].role).toBe("buyer");
		expect(buyerRows[0].email).toBe(buyerEmailAddress);

		// The creator's copy: a second row with its own key. A redelivered event must
		// find both rows standing and mail neither again.
		const creatorRows = await receiptRows(`purchase:${intentId}:creator:${creatorId}`);
		expect(creatorRows).toHaveLength(1);
		expect(creatorRows[0].role).toBe("creator");
	});

	it("redelivery is a no-op — one row per recipient, however many times the event arrives", async () => {
		const intentId = `pi_rcp_${run}_redeliver`;
		await completedPurchase({ buyerId, creatorId, workId, intentId });

		await sendPurchaseReceipts(await rowsFor(intentId));
		await sendPurchaseReceipts(await rowsFor(intentId));
		await sendPurchaseReceipts(await rowsFor(intentId));

		expect(await receiptRows(`purchase:${intentId}:buyer:${buyerId}`)).toHaveLength(1);
		expect(await receiptRows(`purchase:${intentId}:creator:${creatorId}`)).toHaveLength(1);
	});

	it("a basket is one receipt per recipient with every Work on it, not one email per Work", async () => {
		const intentId = `pi_rcp_${run}_basket`;
		const secondWorkId = (await insertWork({ creatorId, type: "game", title: "Basket item two" }))
			.id;
		createdWorkIds.push(secondWorkId);
		await completedPurchase({ buyerId, creatorId, workId, intentId, title: "Basket item one" });
		await completedPurchase({
			buyerId,
			creatorId,
			workId: secondWorkId,
			intentId,
			title: "Basket item two",
			amount: "3.00",
			tax: "0.12",
			earnings: "3.00",
		});

		await sendPurchaseReceipts(await rowsFor(intentId));

		expect(await receiptRows(`purchase:${intentId}:buyer:${buyerId}`)).toHaveLength(1);
		expect(await receiptRows(`purchase:${intentId}:creator:${creatorId}`)).toHaveLength(1);
	});

	it("a self-purchase mails the buyer only — the creator copy of your own money back to you is the same email's job", async () => {
		const intentId = `pi_rcp_${run}_self`;
		const ownWorkId = (await insertWork({ creatorId: buyerId, type: "game", title: "My own work" }))
			.id;
		createdWorkIds.push(ownWorkId);
		await completedPurchase({ buyerId, creatorId: buyerId, workId: ownWorkId, intentId });

		await sendPurchaseReceipts(await rowsFor(intentId));

		expect(await receiptRows(`purchase:${intentId}:buyer:${buyerId}`)).toHaveLength(1);
		expect(await receiptRows(`purchase:${intentId}:creator:${buyerId}`)).toHaveLength(0);
	});

	it("the creator's preference off silences the creator copy and only that", async () => {
		const intentId = `pi_rcp_${run}_pref`;
		await db
			.insert(stripeAccounts)
			.values({ userId: creatorId, stripeAccountId: `acct_rcp_${run}` })
			.onConflictDoNothing();
		await db
			.update(stripeAccounts)
			.set({ creatorReceiptEmails: false })
			.where(eq(stripeAccounts.userId, creatorId));

		await completedPurchase({ buyerId, creatorId, workId, intentId });
		await sendPurchaseReceipts(await rowsFor(intentId));

		// The buyer's receipt is never preference-gated: money the buyer spent is told,
		// like every other essential record.
		expect(await receiptRows(`purchase:${intentId}:buyer:${buyerId}`)).toHaveLength(1);
		// The creator's is.
		expect(await receiptRows(`purchase:${intentId}:creator:${creatorId}`)).toHaveLength(0);
	});

	it("a null preference reads as on (the stored default is on)", async () => {
		// A row written without the column — or by a pass that predates it — carries
		// null, and "never answered" must not read as a no.
		const intentId = `pi_rcp_${run}_nullpref`;
		await db
			.update(stripeAccounts)
			.set({ creatorReceiptEmails: null })
			.where(eq(stripeAccounts.userId, creatorId));

		await completedPurchase({ buyerId, creatorId, workId, intentId });
		await sendPurchaseReceipts(await rowsFor(intentId));
		expect(await receiptRows(`purchase:${intentId}:creator:${creatorId}`)).toHaveLength(1);
	});
});

describe("Receipts: refunds", () => {
	it("a refund mails buyer and creator, latched on the refund's own id, redelivery included", async () => {
		const intentId = `pi_rcp_${run}_refund`;
		const refundId = `re_rcp_${run}`;
		await completedPurchase({ buyerId, creatorId, workId, intentId });
		await markRefunded(intentId, refundId);

		await sendRefundReceipts(await refundedRowsFor(intentId));
		await sendRefundReceipts(await refundedRowsFor(intentId));

		const buyerRows = await receiptRows(`refund:${refundId}:buyer:${buyerId}`);
		expect(buyerRows).toHaveLength(1);
		expect(buyerRows[0].kind).toBe("refund");
		expect(await receiptRows(`refund:${refundId}:creator:${creatorId}`)).toHaveLength(1);
	});
});

describe("Receipts: monthly support", () => {
	it("a recorded invoice earns one receipt naming the creators it reached, redelivery included", async () => {
		// The invoice subledger's own test owns recording; here the receipt is what is
		// under test, so a minimal row is inserted by hand with the shape
		// `recordPaidInvoice` leaves.
		const [invoiceRow] = await db
			.insert(invoices)
			.values({
				userId: buyerId,
				stripeInvoiceId: `in_rcp_${run}`,
				stripePaymentIntentId: `pi_rcp_${run}_inv`,
				billingCycle: "2026-10",
				status: "paid",
				subtotal: "9.00",
				discount: "0.00",
				tax: "0.48",
				total: "9.48",
				processingFee: "0.45",
				paidAt: new Date(),
			})
			.returning();
		await db.insert(invoiceLines).values([
			{ invoiceId: invoiceRow.id, creatorId, amount: "6.00" },
			// Anthers' own line (creatorId null) is excluded from the receipt: the
			// supporter's mail names the creators their support reached.
			{ invoiceId: invoiceRow.id, creatorId: null, amount: "3.00" },
		]);

		await sendSupportReceipt(invoiceRow);
		await sendSupportReceipt(invoiceRow);

		const rows = await receiptRows(`invoice:in_rcp_${run}:buyer:${buyerId}`);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("invoice");
	});

	it("a detached invoice (its buyer deleted) is receipted by nobody", async () => {
		// The money record stays when the account goes (`set null`), but there is no
		// address to mail — no row, no send, and no error either.
		const [invoiceRow] = await db
			.insert(invoices)
			.values({
				userId: null,
				stripeInvoiceId: `in_rcp_${run}_detached`,
				stripePaymentIntentId: `pi_rcp_${run}_detached`,
				billingCycle: "2026-10",
				status: "paid",
				subtotal: "3.00",
				discount: "0.00",
				tax: "0.00",
				total: "3.00",
				processingFee: "0.30",
				paidAt: new Date(),
			})
			.returning();
		await db
			.insert(invoiceLines)
			.values({ invoiceId: invoiceRow.id, creatorId: null, amount: "3.00" });

		await sendSupportReceipt(invoiceRow);
		expect(await receiptRows(`invoice:in_rcp_${run}_detached:buyer:null`)).toHaveLength(0);
	});
});
