// SPDX-License-Identifier: Apache-2.0
/**
 * The signed access receipt: immutable proof in the reader's own space.
 *
 * What only this suite holds is the split's behavior rather than its prose: a completed
 * purchase writes one signed record, a second write leaves it exactly as it was, a refund
 * adds a second record that references the first without touching it, and the payload carries
 * no money. The fake PDS is the same one the Library suites use; the signature is real, and it
 * is checked against the published key rather than against the object that made it.
 */
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchaseReceipts, purchases, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { accessReceiptsJob } from "../jobs/access-receipts";
import {
	oweAccessReceipt,
	RECEIPT_COLLECTION,
	type ReceiptPayload,
	receiptIdFor,
	verifyAccessReceiptRecord,
	writeAccessReceipt,
} from "../services/access-receipts";
import { accessIssuerOrigin, accessSigningKey } from "../services/access-signing";
import { userSpaceUri } from "../services/space-registry";
import { spaceClientFor } from "../services/space-writer";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { spaceContext } from "./space-fixtures";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

interface Fixture {
	buyerDid: string;
	creatorDid: string;
	creatorId: number;
	purchaseId: number;
	workId: number;
	transactionId: string;
}

async function fixture(): Promise<{
	fixture: Fixture;
	ctx: Awaited<ReturnType<typeof spaceContext>>;
}> {
	const ctx = await spaceContext();
	const creator = await createAccount(`receipts-creator-${Date.now().toString(36)}`);
	const work = await insertWork({
		creatorId: creator.userId,
		type: "text",
		title: "Nightjar",
		visibility: "released",
		access: [{ threshold: 0, allow: true, price: "5.00" }],
		sourceKey: `creators/${creator.userId}/media/nightjar.epub`,
	});
	const listing = `at://${creator.did}/org.anthers.work/nightjar-${work.publicId}`;
	await db.update(works).set({ atprotoUri: listing }).where(eq(works.id, work.id));

	const transactionId = `pi_receipt_${crypto.randomUUID().slice(0, 12)}`;
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: ctx.userId,
			workId: work.id,
			creatorId: creator.userId,
			workTitle: work.title,
			workType: work.type,
			workPublicId: work.publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			salesTax: "0.41",
			creatorEarnings: "4.55",
			buyerCountry: "US",
			buyerState: "CO",
			stripePaymentIntentId: transactionId,
			status: "completed",
		})
		.returning();

	return {
		ctx,
		fixture: {
			buyerDid: ctx.did,
			creatorDid: creator.did,
			creatorId: creator.userId,
			purchaseId: purchase.id,
			workId: work.id,
			transactionId,
		},
	};
}

async function recordAt(ctx: Awaited<ReturnType<typeof spaceContext>>, rkey: string) {
	const client = spaceClientFor(ctx.session, { fetchImpl: ctx.pds.fetch });
	return client.getRecord({
		space: userSpaceUri(ctx.did),
		repo: ctx.did,
		collection: RECEIPT_COLLECTION,
		rkey,
	});
}

function publicKey(): Uint8Array {
	const key = accessSigningKey();
	if (!key) throw new Error("no access signing key in this process");
	return key.publicKey;
}

describe("the access receipt", () => {
	it("writes a signed, money-free receipt into the reader's space", async () => {
		const { ctx, fixture: f } = await fixture();
		const receiptId = receiptIdFor(f.purchaseId, "purchase");
		const written = await writeAccessReceipt(f.purchaseId, "purchase", {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if (written.outcome !== "written") throw new Error(`not written: ${JSON.stringify(written)}`);
		expect(written.spaceUri).toBe(userSpaceUri(f.buyerDid));

		const stored = await recordAt(ctx, receiptId);
		const verdict = verifyAccessReceiptRecord(stored.value, { publicKey: publicKey() });
		if (!verdict.ok) throw new Error(`receipt did not verify: ${verdict.problem}`);
		const payload = verdict.payload as Extract<ReceiptPayload, { kind: "purchase" }>;

		expect(payload).toMatchObject({
			kind: "purchase",
			workPublicId: expect.any(Number),
			workTitle: "Nightjar",
			workType: "text",
			creator: f.creatorDid,
			reader: f.buyerDid,
			transactionId: f.transactionId,
		});
		expect(payload.work).toMatch(/^at:\/\/.+\/org\.anthers\.work\//);
		// 🚨 None of the ledger's money or tax detail reaches a portable copy.
		const serialized = JSON.stringify(payload);
		for (const forbidden of [
			"amount",
			"processingFee",
			"salesTax",
			"creatorEarnings",
			"buyerCountry",
			"buyerState",
			"stripePaymentIntentId",
		]) {
			expect(serialized.includes(`"${forbidden}"`)).toBe(false);
		}
		expect((stored.value as { issuer?: string }).issuer).toBe(accessIssuerOrigin());
	});

	it("leaves a receipt that already verifies exactly as it was", async () => {
		const { ctx, fixture: f } = await fixture();
		const receiptId = receiptIdFor(f.purchaseId, "purchase");
		await writeAccessReceipt(f.purchaseId, "purchase", {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		const first = await recordAt(ctx, receiptId);
		const again = await writeAccessReceipt(f.purchaseId, "purchase", {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(again.outcome).toBe("already_written");
		const second = await recordAt(ctx, receiptId);
		expect(second.cid).toBe(first.cid);
		expect(second.value).toEqual(first.value);

		// A tampered payload fails verification even though the record is in the right place.
		const tampered = {
			...(first.value as Record<string, unknown>),
			payload: {
				...(first.value as { payload: Record<string, unknown> }).payload,
				workTitle: "Something Else",
			},
		};
		expect(verifyAccessReceiptRecord(tampered, { publicKey: publicKey() })).toEqual({
			ok: false,
			problem: "bad-signature",
		});
	});

	it("adds a refund record that references the receipt and leaves it verifying", async () => {
		const { ctx, fixture: f } = await fixture();
		const purchaseId = receiptIdFor(f.purchaseId, "purchase");
		const refundId = receiptIdFor(f.purchaseId, "refund");
		await writeAccessReceipt(f.purchaseId, "purchase", {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		const before = await recordAt(ctx, purchaseId);

		const refundedAt = new Date("2026-10-24T15:00:00.000Z");
		await db
			.update(purchases)
			.set({
				status: "refunded",
				refundedAt,
				refundInitiator: "platform",
				refundReason: "The creator withdrew the Work",
			})
			.where(eq(purchases.id, f.purchaseId));
		const event = await writeAccessReceipt(f.purchaseId, "refund", {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		expect(event.outcome).toBe("written");

		const refund = await recordAt(ctx, refundId);
		const verdict = verifyAccessReceiptRecord(refund.value, { publicKey: publicKey() });
		if (!verdict.ok) throw new Error(`refund did not verify: ${verdict.problem}`);
		expect(verdict.payload).toMatchObject({
			kind: "refund",
			receipt: purchaseId,
			reader: f.buyerDid,
			at: refundedAt.toISOString(),
			reason: "The creator withdrew the Work",
		});

		// The receipt itself is untouched and still verifies.
		const after = await recordAt(ctx, purchaseId);
		expect(after.cid).toBe(before.cid);
		expect(verifyAccessReceiptRecord(after.value, { publicKey: publicKey() }).ok).toBe(true);
	});

	it("writes nothing for a purchase that never settled, or a reader Anthers cannot write for", async () => {
		const { ctx, fixture: f } = await fixture();
		await db.update(purchases).set({ status: "pending" }).where(eq(purchases.id, f.purchaseId));
		expect(
			await writeAccessReceipt(f.purchaseId, "purchase", {
				resolveSession: ctx.resolveSession,
				fetchImpl: ctx.pds.fetch,
			}),
		).toMatchObject({ outcome: "skipped", reason: "not_settled" });

		await db.update(purchases).set({ status: "completed" }).where(eq(purchases.id, f.purchaseId));
		expect(
			await writeAccessReceipt(f.purchaseId, "purchase", {
				resolveSession: async () => ({ session: null, reason: "not_hosted" }),
				fetchImpl: ctx.pds.fetch,
			}),
		).toMatchObject({ outcome: "skipped", reason: "not_hosted" });
	});

	it("drains an owed row through the job and records where it landed", async () => {
		const { ctx, fixture: f } = await fixture();
		await oweAccessReceipt(f.purchaseId, "purchase");
		await accessReceiptsJob(
			{ limit: 10, purchaseIds: [f.purchaseId] },
			{ resolveSession: ctx.resolveSession, fetchImpl: ctx.pds.fetch },
		);

		const [row] = await db
			.select()
			.from(purchaseReceipts)
			.where(eq(purchaseReceipts.purchaseId, f.purchaseId))
			.limit(1);
		expect(row?.state).toBe("written");
		expect(row?.writtenAt).not.toBeNull();
		expect(row?.spaceUri).toBe(userSpaceUri(f.buyerDid));
		expect(row?.lastError).toBeNull();

		// A second pass has nothing to do; the row is terminal and the record is untouched.
		await accessReceiptsJob(
			{ limit: 10, purchaseIds: [f.purchaseId] },
			{ resolveSession: ctx.resolveSession, fetchImpl: ctx.pds.fetch },
		);
		const stored = await recordAt(ctx, receiptIdFor(f.purchaseId, "purchase"));
		expect(verifyAccessReceiptRecord(stored.value, { publicKey: publicKey() }).ok).toBe(true);
	});

	it("marks a reader with no hosted identity as skipped rather than failing", async () => {
		const { ctx, fixture: f } = await fixture();
		await oweAccessReceipt(f.purchaseId, "purchase");
		await accessReceiptsJob(
			{ limit: 10, purchaseIds: [f.purchaseId] },
			{
				resolveSession: async () => ({ session: null, reason: "not_hosted" }),
				fetchImpl: ctx.pds.fetch,
			},
		);
		const [row] = await db
			.select()
			.from(purchaseReceipts)
			.where(eq(purchaseReceipts.purchaseId, f.purchaseId))
			.limit(1);
		expect(row?.state).toBe("skipped");
		expect(row?.lastError).toBe("not_hosted");
	});
});
