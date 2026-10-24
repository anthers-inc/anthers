// SPDX-License-Identifier: Apache-2.0
/**
 * The signed access receipt: a permanent statement that a purchase happened, written into
 * the reader's own space.
 *
 * ⭐ **The ledger is the entitlement and this is the proof, so the two say different things.**
 * `purchases` answers "does this Work open now" and is the only artifact a refund edits. A
 * receipt answers "did this transaction happen" and is never edited: a refund appends a
 * second signed record that references the first. A third party holding the receipt and
 * Anthers' public key can check the signature without asking the ledger; the ledger is what
 * says whether the thing still opens.
 *
 * 🚨 **The receipt carries no money.** No amount, processing fee, sales tax, tax
 * jurisdiction, address, or payment-method detail reaches the space, because those are
 * Anthers' financial record and a portable copy in a reader's repository would be a privacy
 * leak with no purpose. What it carries is the Work's public id, title and kind as sold (all
 * public catalog facts, kept so the record is legible), the two DIDs, the date, and the
 * processor's transaction reference — the same reference that is already on the reader's
 * emailed receipt.
 *
 * ⚠️ **The write is a row on `access_receipts` first, then a background write.** The payment
 * webhook stamps the purchase and inserts a `pending` row; the sweep drains it, because a
 * webhook must not fail on another server being down. A receipt that never lands stays a
 * `failed` row with the message, which is the difference between a promise that broke and
 * one nobody notices.
 */
import { db } from "@anthers/db";
import { accessReceipts, purchases, users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	accessIssuerOrigin,
	accessSigningKey,
	signAccessPayload,
	verifyAccessPayload,
} from "./access-signing.js";
import { USER_SPACE_COLLECTIONS } from "./space-records.js";
import { ensureUserSpace } from "./space-registry.js";
import {
	hostedSpaceSession,
	putVerifiedSpaceRecord,
	type ResolveSpaceSession,
	spaceWriterFor,
} from "./space-writer.js";

export const RECEIPT_COLLECTION = USER_SPACE_COLLECTIONS.receipt;

/** The two statements one purchase can produce. A refund references the purchase receipt. */
export type ReceiptKind = "purchase" | "refund";

/**
 * The signed half of a purchase receipt.
 *
 * ⚠️ **The Work URI is the listing as it was when the receipt was written.** A Work deleted
 * later keeps its public id and title on the receipt; the address is the one a reader could
 * have followed at the time, and `null` when the Work had no listing.
 */
export interface PurchaseReceiptPayload {
	$type: typeof RECEIPT_COLLECTION;
	kind: "purchase";
	id: string;
	work: string | null;
	workPublicId: number | null;
	workTitle: string | null;
	workType: string | null;
	creator: string | null;
	reader: string;
	purchasedAt: string;
	transactionId: string;
}

/** The signed half of a refund record: a new statement, never an edit. */
export interface RefundReceiptPayload {
	$type: typeof RECEIPT_COLLECTION;
	kind: "refund";
	id: string;
	receipt: string;
	reader: string;
	at: string;
	reason: string | null;
}

export type ReceiptPayload = PurchaseReceiptPayload | RefundReceiptPayload;

/**
 * The record as it lands in the space.
 *
 * `issuer` and `keyId` are what make it checkable elsewhere: the reader's app, or a third
 * party the reader shows it to, fetches `${issuer}/api/content/access/issuer.json`, finds the
 * key by id, and verifies the signature over the canonical payload. The envelope's `id` and
 * `kind` mirror the signed ones so a listing can group records without verifying every one.
 */
export type AccessReceiptRecord = {
	$type: typeof RECEIPT_COLLECTION;
	id: string;
	kind: ReceiptKind;
	issuer: string;
	keyId: string;
	payload: ReceiptPayload;
	signature: string;
} & Record<string, unknown>;

/** The stable key one statement lands under, so a reissue lands on the same address. */
export function receiptIdFor(purchaseId: number, kind: ReceiptKind): string {
	return `${kind}-${purchaseId}`;
}

type PurchaseRow = typeof purchases.$inferSelect;

export function purchaseReceiptPayload(
	purchase: PurchaseRow,
	context: { reader: string; creator: string | null; work: string | null },
): PurchaseReceiptPayload {
	return {
		$type: RECEIPT_COLLECTION,
		kind: "purchase",
		id: receiptIdFor(purchase.id, "purchase"),
		work: context.work,
		workPublicId: purchase.workPublicId ?? null,
		workTitle: purchase.workTitle ?? null,
		workType: purchase.workType ?? null,
		creator: context.creator,
		reader: context.reader,
		// The row's creation is the checkout the charge was made in; settlement is the
		// ledger's business and the emailed receipt's date, and it is not stored separately.
		purchasedAt: purchase.createdAt.toISOString(),
		transactionId: purchase.stripePaymentIntentId,
	};
}

export function refundReceiptPayload(
	purchase: PurchaseRow,
	context: { reader: string; now?: Date },
): RefundReceiptPayload {
	return {
		$type: RECEIPT_COLLECTION,
		kind: "refund",
		id: receiptIdFor(purchase.id, "refund"),
		receipt: receiptIdFor(purchase.id, "purchase"),
		reader: context.reader,
		at: (purchase.refundedAt ?? context.now ?? new Date()).toISOString(),
		reason: purchase.refundReason ?? null,
	};
}

/** Sign one payload into the record that lands in the space. */
export function sealReceipt(payload: ReceiptPayload): AccessReceiptRecord {
	const { keyId, signature } = signAccessPayload(payload as unknown as Record<string, unknown>);
	return {
		$type: RECEIPT_COLLECTION,
		id: payload.id,
		kind: payload.kind,
		issuer: accessIssuerOrigin(),
		keyId,
		payload,
		signature,
	};
}

export type ReceiptProblem =
	| "not-an-object"
	| "wrong-type"
	| "missing-signature"
	| "id-mismatch"
	| "kind-mismatch"
	| "bad-signature";

/**
 * Verify a record read back from a space.
 *
 * ⚠️ **An unrecognized payload is a failure, not a newer format.** A receipt only ever comes
 * from Anthers' signer, so a payload with no `kind` or no `reader` did not come from it; the
 * signature check would reject it anyway, and saying which check failed is what makes a
 * support question answerable.
 */
export function verifyAccessReceiptRecord(
	value: unknown,
	options: { publicKey: Uint8Array; keyId?: string },
): { ok: true; payload: ReceiptPayload } | { ok: false; problem: ReceiptProblem } {
	if (!value || typeof value !== "object") return { ok: false, problem: "not-an-object" };
	const record = value as Record<string, unknown>;
	if (record.$type !== RECEIPT_COLLECTION) return { ok: false, problem: "wrong-type" };
	const payload = record.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== "object") return { ok: false, problem: "not-an-object" };
	if (payload.$type !== RECEIPT_COLLECTION) return { ok: false, problem: "wrong-type" };
	if (typeof record.signature !== "string" || record.signature.length === 0) {
		return { ok: false, problem: "missing-signature" };
	}
	if (typeof payload.id !== "string" || payload.id !== record.id) {
		return { ok: false, problem: "id-mismatch" };
	}
	if (payload.kind !== record.kind || (payload.kind !== "purchase" && payload.kind !== "refund")) {
		return { ok: false, problem: "kind-mismatch" };
	}
	if (options.keyId && record.keyId !== options.keyId)
		return { ok: false, problem: "bad-signature" };
	if (!verifyAccessPayload(payload, record.signature, options.publicKey)) {
		return { ok: false, problem: "bad-signature" };
	}
	return { ok: true, payload: payload as unknown as ReceiptPayload };
}

/** Insert the row that says a receipt is owed, without disturbing one that already exists. */
export async function oweAccessReceipt(
	purchaseId: number,
	kind: ReceiptKind,
	now: Date = new Date(),
): Promise<void> {
	await db
		.insert(accessReceipts)
		.values({
			purchaseId,
			kind,
			receiptId: receiptIdFor(purchaseId, kind),
			updatedAt: now,
		})
		.onConflictDoNothing();
}

export interface ReceiptWriteOptions {
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	now?: Date;
}

export type ReceiptWrite =
	| { outcome: "written"; receiptId: string; spaceUri: string; uri: string }
	| { outcome: "already_written"; receiptId: string; spaceUri: string }
	| { outcome: "skipped"; reason: string; receiptId: string };

/**
 * Write one purchase or refund statement into the buyer's space.
 *
 * The order is: the row, then the reader's DID, then the space. A buyer with no hosted
 * identity has no credential this deployment may use, so the write is skipped by name rather
 * than attempted — the receipt remains reissuable from the ledger the day that identity
 * grants a write path.
 *
 * ⚠️ **A valid record already at the key is left alone.** That is the receipt's immutability
 * in code: the second run of a job, a redelivered webhook, and an operator's reissue all read
 * before they write, and only a record that does not verify is replaced.
 */
export async function writeAccessReceipt(
	purchaseId: number,
	kind: ReceiptKind,
	opts: ReceiptWriteOptions = {},
): Promise<ReceiptWrite> {
	const receiptId = receiptIdFor(purchaseId, kind);
	const [purchase] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
	if (!purchase) return { outcome: "skipped", reason: "no_purchase", receiptId };
	if (purchase.status === "pending" || purchase.status === "failed") {
		return { outcome: "skipped", reason: "not_settled", receiptId };
	}
	if (purchase.buyerId == null) return { outcome: "skipped", reason: "no_reader", receiptId };

	const [reader] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.id, purchase.buyerId))
		.limit(1);
	if (!reader?.did) return { outcome: "skipped", reason: "no_reader", receiptId };
	const readerDid = reader.did;

	const creatorDid = purchase.creatorId
		? ((
				await db
					.select({ did: users.atprotoDid })
					.from(users)
					.where(eq(users.id, purchase.creatorId))
					.limit(1)
			)[0]?.did ?? null)
		: null;

	let payload: ReceiptPayload;
	if (kind === "purchase") {
		const workUri = purchase.workId
			? ((
					await db
						.select({ uri: works.atprotoUri })
						.from(works)
						.where(eq(works.id, purchase.workId))
						.limit(1)
				)[0]?.uri ?? null)
			: null;
		payload = purchaseReceiptPayload(purchase, {
			reader: readerDid,
			creator: creatorDid,
			work: workUri,
		});
	} else {
		// A dispute is a live ledger state, not a refund: the money may come back, so no
		// refund record is written for one. The receipt for the purchase still stands.
		if (purchase.status !== "refunded") {
			return { outcome: "skipped", reason: "not_refunded", receiptId };
		}
		payload = refundReceiptPayload(purchase, { reader: readerDid, now: opts.now });
	}

	const record = sealReceipt(payload);
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(purchase.buyerId);
	if (!resolved.session) return { outcome: "skipped", reason: resolved.reason, receiptId };
	const session = resolved.session;

	// The space is created on the first write, and a buyer may never have saved anything.
	const ensured = await ensureUserSpace(purchase.buyerId, {
		resolveSession: async () => ({ session }),
		fetchImpl: opts.fetchImpl,
		now: opts.now,
	});
	if (!ensured.space) return { outcome: "skipped", reason: ensured.reason, receiptId };
	const spaceUri = ensured.space.spaceUri;

	const writer = spaceWriterFor(session, spaceUri, { fetchImpl: opts.fetchImpl });
	const existing = await writer.get(RECEIPT_COLLECTION, receiptId).catch(() => null);
	const key = accessSigningKey();
	if (key && existing) {
		const verdict = verifyAccessReceiptRecord(existing.value, {
			publicKey: key.publicKey,
			keyId: key.publicJwk.kid,
		});
		if (verdict.ok) return { outcome: "already_written", receiptId, spaceUri };
	}
	const written = await putVerifiedSpaceRecord(writer, RECEIPT_COLLECTION, receiptId, record);
	return { outcome: "written", receiptId, spaceUri, uri: written.uri };
}
