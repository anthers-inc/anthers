// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt and its refund record against the branch's real PDS — the lab's scenario 03,
 * through the service the purchase webhook feeds.
 *
 * What only this suite holds is that the space endpoints accept the record and hand it back
 * unchanged: the fake PDS proves the shape and the verification, and this proves the addresses,
 * the CBOR round trip, and the signature surviving it. A receipt that verifies in memory and
 * not after a PDS round trip would pass every other test here.
 *
 * Skipped unless `SPACE_STAGING_PDS_URL` names a server. Never point it at the real network.
 *
 *   cd ~/Anthers/anthers-spaces-lab && ./scripts/node.sh scripts/network.mjs
 *   cd ~/Anthers/anthers && SPACE_STAGING_PDS_URL=http://127.0.0.1:2683 \
 *     bun test apps/api/src/__tests__/access-receipts-staging.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	RECEIPT_COLLECTION,
	type ReceiptPayload,
	receiptIdFor,
	verifyAccessReceiptRecord,
	writeAccessReceipt,
} from "../services/access-receipts.js";
import { accessSigningKey } from "../services/access-signing.js";
import { SpaceClient } from "../services/atproto-space.js";
import { userSpaceUri } from "../services/space-registry.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

const PDS_URL = process.env.SPACE_STAGING_PDS_URL ?? null;

purgeAccountsCreatedHere();

const staged = PDS_URL ? describe : describe.skip;

staged("the access receipt against a staging PDS", () => {
	let buyer: { did: string; token: string };
	let creator: { did: string; token: string };
	let buyerLocalId = 0;
	let workId = 0;
	let purchaseId = 0;
	let resolveSession: ResolveSpaceSession;

	async function account(name: string): Promise<{ did: string; token: string }> {
		const tag = `${name}${Date.now().toString(36)}`;
		const response = await fetch(
			new URL("/xrpc/com.atproto.server.createAccount", PDS_URL as string),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					handle: `${tag}.spaces.test`,
					email: `${tag}@example.com`,
					password: `pw-${tag}`,
				}),
			},
		);
		const text = await response.text();
		const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		if (!response.ok) throw new Error(`createAccount: ${response.status} ${text}`);
		return { did: String(data.did), token: String(data.accessJwt) };
	}

	beforeAll(async () => {
		creator = await account("ar-c");
		buyer = await account("ar-b");

		const localBuyer = await createAccount(`ar-buyer-${Date.now().toString(36)}`);
		buyerLocalId = localBuyer.userId;
		await db
			.update(users)
			.set({ atprotoDid: buyer.did, atprotoPdsUrl: PDS_URL })
			.where(eq(users.id, buyerLocalId));
		const localCreator = await createAccount(`ar-creator-${Date.now().toString(36)}`);
		await db
			.update(users)
			.set({ atprotoDid: creator.did, atprotoPdsUrl: PDS_URL })
			.where(eq(users.id, localCreator.userId));

		const work = await insertWork({
			creatorId: localCreator.userId,
			type: "text",
			title: "Nightjar",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
			sourceKey: `creators/${localCreator.userId}/media/nightjar.epub`,
		});
		workId = work.id;
		await db
			.update(works)
			.set({ atprotoUri: `at://${creator.did}/org.anthers.work/nightjar-${work.publicId}` })
			.where(eq(works.id, workId));

		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: buyerLocalId,
				workId,
				creatorId: localCreator.userId,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				salesTax: "0.41",
				creatorEarnings: "4.55",
				buyerCountry: "US",
				stripePaymentIntentId: `pi_staging_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
			})
			.returning();
		purchaseId = purchase.id;

		resolveSession = async (id) =>
			id === buyerLocalId
				? { session: { did: buyer.did, pdsUrl: PDS_URL as string, token: buyer.token } }
				: { session: null, reason: "not_hosted" };
	}, 60_000);

	afterAll(async () => {
		if (buyer?.token) {
			const client = new SpaceClient({ baseUrl: PDS_URL as string, token: buyer.token });
			await client.deleteSpace(userSpaceUri(buyer.did)).catch(() => undefined);
		}
	});

	it("writes a receipt the PDS returns byte-for-byte verifiable", async () => {
		const written = await writeAccessReceipt(purchaseId, "purchase", { resolveSession });
		if (written.outcome !== "written") throw new Error(`not written: ${JSON.stringify(written)}`);
		expect(written.spaceUri).toBe(userSpaceUri(buyer.did));

		const reader = new SpaceClient({ baseUrl: PDS_URL as string, token: buyer.token });
		const stored = await reader.getRecord({
			space: userSpaceUri(buyer.did),
			repo: buyer.did,
			collection: RECEIPT_COLLECTION,
			rkey: receiptIdFor(purchaseId, "purchase"),
		});
		const key = accessSigningKey();
		if (!key) throw new Error("no access signing key");
		const verdict = verifyAccessReceiptRecord(stored.value, { publicKey: key.publicKey });
		if (!verdict.ok) throw new Error(`receipt did not verify after the PDS: ${verdict.problem}`);
		const payload = verdict.payload as Extract<ReceiptPayload, { kind: "purchase" }>;
		expect(payload.reader).toBe(buyer.did);
		expect(payload.creator).toBe(creator.did);
		expect(payload.work).toBe(
			`at://${creator.did}/org.anthers.work/nightjar-${payload.workPublicId}`,
		);
		expect(JSON.stringify(payload).includes('"amount"')).toBe(false);
	});

	it("adds a refund record on the PDS and leaves the receipt verifying", async () => {
		const refundedAt = new Date();
		await db
			.update(purchases)
			.set({
				status: "refunded",
				refundedAt,
				refundInitiator: "platform",
				refundReason: "Staging refund",
			})
			.where(eq(purchases.id, purchaseId));
		const written = await writeAccessReceipt(purchaseId, "refund", { resolveSession });
		expect(written.outcome).toBe("written");

		const reader = new SpaceClient({ baseUrl: PDS_URL as string, token: buyer.token });
		const key = accessSigningKey();
		if (!key) throw new Error("no access signing key");
		const refund = await reader.getRecord({
			space: userSpaceUri(buyer.did),
			repo: buyer.did,
			collection: RECEIPT_COLLECTION,
			rkey: receiptIdFor(purchaseId, "refund"),
		});
		const verdict = verifyAccessReceiptRecord(refund.value, { publicKey: key.publicKey });
		if (!verdict.ok) throw new Error(`refund did not verify: ${verdict.problem}`);
		expect(verdict.payload).toMatchObject({
			kind: "refund",
			receipt: receiptIdFor(purchaseId, "purchase"),
			reader: buyer.did,
		});

		const receipt = await reader.getRecord({
			space: userSpaceUri(buyer.did),
			repo: buyer.did,
			collection: RECEIPT_COLLECTION,
			rkey: receiptIdFor(purchaseId, "purchase"),
		});
		expect(verifyAccessReceiptRecord(receipt.value, { publicKey: key.publicKey }).ok).toBe(true);
	});
});
