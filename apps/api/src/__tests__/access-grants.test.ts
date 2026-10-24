// SPDX-License-Identifier: Apache-2.0
/**
 * The short-lived grant: what it claims, when it stops, and what delivery does with it.
 *
 * The lab's scenario 03 is the model — a receipt is permanent, a grant expires, a refund
 * stops the next grant and denies delivery even with one already in hand. This file holds the
 * app's implementation to it, and then holds the download route to the two things a grant
 * cannot do alone: the ledger is still read first, and a grant is scoped to one file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, purchases, users } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import {
	type AccessGrantPayload,
	GRANT_LIFETIME_MS,
	mintAccessGrant,
	verifyAccessGrant,
} from "../services/access-grants";
import { accessSigningKey, signAccessPayload } from "../services/access-signing";
import { downloadAsset, grantForAsset } from "./access-fixture";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const FILE = "creators/1/assets/build.zip";
const READER = "did:plc:grant-reader";

function post(path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				Origin: ORIGIN,
				Cookie: cookie,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}

describe("the access grant", () => {
	it("verifies for the reader, Work and file it was minted for", () => {
		const now = new Date("2026-10-24T12:00:00.000Z");
		const { token, payload } = mintAccessGrant({
			workId: 7,
			workUri: "at://did:plc:creator/org.anthers.work/nightjar",
			receipt: "receipt-42",
			reader: READER,
			basis: "purchased",
			files: [FILE],
			now,
		});
		expect(payload.expiresAt).toBe(new Date(now.getTime() + GRANT_LIFETIME_MS).toISOString());
		expect(payload.receipt).toBe("receipt-42");

		const verdict = verifyAccessGrant(token, {
			readerDid: READER,
			workId: 7,
			fileKey: FILE,
			now: new Date(now.getTime() + 60_000),
		});
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.payload.id).toBe(payload.id);
	});

	it("refuses an expired grant even though it still verifies", () => {
		const now = new Date("2026-10-24T12:00:00.000Z");
		const { token } = mintAccessGrant({
			workId: 7,
			workUri: null,
			receipt: null,
			reader: READER,
			basis: "free",
			files: [FILE],
			now,
		});
		expect(
			verifyAccessGrant(token, {
				readerDid: READER,
				workId: 7,
				fileKey: FILE,
				now: new Date(now.getTime() + GRANT_LIFETIME_MS + 1),
			}),
		).toEqual({ ok: false, reason: "expired" });
	});

	it("refuses another reader, Work or file", () => {
		const { token } = mintAccessGrant({
			workId: 7,
			workUri: null,
			receipt: null,
			reader: READER,
			basis: "purchased",
			files: [FILE],
		});
		expect(
			verifyAccessGrant(token, { readerDid: "did:plc:someone", workId: 7, fileKey: FILE }),
		).toEqual({ ok: false, reason: "wrong_reader" });
		expect(verifyAccessGrant(token, { readerDid: READER, workId: 8, fileKey: FILE })).toEqual({
			ok: false,
			reason: "wrong_work",
		});
		expect(
			verifyAccessGrant(token, { readerDid: READER, workId: 7, fileKey: "creators/1/other.zip" }),
		).toEqual({ ok: false, reason: "wrong_file" });
	});

	it("refuses a tampered payload and a token of another type", () => {
		const { token } = mintAccessGrant({
			workId: 7,
			workUri: null,
			receipt: null,
			reader: READER,
			basis: "purchased",
			files: [FILE],
		});
		const [encoded, signature] = token.split(".");
		const payload = JSON.parse(
			Buffer.from(encoded as string, "base64url").toString(),
		) as AccessGrantPayload;
		const tampered = Buffer.from(
			JSON.stringify({ ...payload, files: ["creators/1/other.zip"] }),
		).toString("base64url");
		expect(
			verifyAccessGrant(`${tampered}.${signature}`, {
				readerDid: READER,
				workId: 7,
				fileKey: "creators/1/other.zip",
			}),
		).toEqual({ ok: false, reason: "bad_signature" });

		// A correctly signed statement of another type is still not a grant.
		const foreign = { $type: "org.anthers.receipt", id: "receipt-1" };
		const foreignToken = `${Buffer.from(JSON.stringify(foreign)).toString("base64url")}.${
			signAccessPayload(foreign).signature
		}`;
		expect(
			verifyAccessGrant(foreignToken, { readerDid: READER, workId: 7, fileKey: FILE }),
		).toEqual({ ok: false, reason: "wrong_type" });
	});
});

describe("the download route and its grant", () => {
	const id = crypto.randomUUID().slice(0, 8);
	const creatorName = `gr_creator_${id}`;
	const buyerName = `gr_buyer_${id}`;
	const strangerName = `gr_stranger_${id}`;
	let buyerCookie = "";
	let strangerCookie = "";
	let creatorId = 0;
	let buyerId = 0;
	let workId = 0;
	let assetId = 0;
	let purchaseId = 0;

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join(
				[creatorName, buyerName, strangerName].map((name) => sql`${`${name}@example.com`}`),
				sql`, `,
			)})`,
		);
		await createAccount(creatorName);
		buyerCookie = (await createAccount(buyerName)).cookie;
		strangerCookie = (await createAccount(strangerName)).cookie;
		const rows = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(inArray(users.email, [`${creatorName}@example.com`, `${buyerName}@example.com`]));
		for (const row of rows) {
			if (row.email === `${creatorName}@example.com`) creatorId = row.id;
			if (row.email === `${buyerName}@example.com`) buyerId = row.id;
		}

		const work = await insertWork({
			creatorId,
			type: "software",
			title: "Nightjar",
			visibility: "released",
			downloadEnabled: true,
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		});
		workId = work.id;
		const [asset] = await db
			.insert(assets)
			.values({
				workId,
				file: `creators/${creatorId}/assets/nightjar.zip`,
				filename: "nightjar.zip",
				fileSize: 1024,
				mimeType: "application/zip",
				platform: "linux",
				isPrimary: true,
			})
			.returning();
		assetId = asset.id;

		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId,
				creatorId,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				salesTax: "0.00",
				creatorEarnings: "4.55",
				stripePaymentIntentId: `pi_grant_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
			})
			.returning();
		purchaseId = purchase.id;
	});

	afterAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join(
				[creatorName, buyerName, strangerName].map((name) => sql`${`${name}@example.com`}`),
				sql`, `,
			)})`,
		);
	});

	it("mints a grant for a purchaser and lets the file through", async () => {
		expect(accessSigningKey()).not.toBeNull();
		const response = await post(`/api/content/works/${workId}/grant`, buyerCookie, { assetId });
		expect(response.status).toBe(200);
		const { grant, expiresAt } = (await response.json()) as { grant: string; expiresAt: string };
		expect(grant.split(".")).toHaveLength(2);
		expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

		const download = await downloadAsset(buyerCookie, workId, assetId);
		expect(download.status).toBe(200);
		expect((await download.json()).url).toBeTruthy();
	});

	it("refuses a grant to somebody the ledger does not admit", async () => {
		const response = await post(`/api/content/works/${workId}/grant`, strangerCookie, { assetId });
		expect(response.status).toBe(403);
	});

	it("refuses a download with no grant, and one for another file", async () => {
		const bare = await post(`/api/content/works/${workId}/assets/${assetId}/download`, buyerCookie);
		expect(bare.status).toBe(403);
		expect((await bare.json()).code).toBe("grant_malformed");

		const { token } = mintAccessGrant({
			workId,
			workUri: null,
			receipt: null,
			reader: (
				await db.select({ did: users.atprotoDid }).from(users).where(eq(users.id, buyerId)).limit(1)
			)[0]!.did,
			basis: "purchased",
			files: ["creators/1/other.zip"],
		});
		const wrongFile = await app.fetch(
			new Request(`${ORIGIN}/api/content/works/${workId}/assets/${assetId}/download`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: buyerCookie, "X-Anthers-Grant": token },
			}),
		);
		expect(wrongFile.status).toBe(403);
		expect((await wrongFile.json()).code).toBe("grant_wrong_file");
	});

	it("stops the next grant at a refund, and denies delivery with the old one", async () => {
		const before = await grantForAsset(buyerCookie, workId, assetId);
		expect(before).not.toBeNull();

		await db
			.update(purchases)
			.set({ status: "refunded", refundedAt: new Date(), refundInitiator: "platform" })
			.where(eq(purchases.id, purchaseId));

		const after = await post(`/api/content/works/${workId}/grant`, buyerCookie, { assetId });
		expect(after.status).toBe(403);

		// The ledger is read first, so even a grant that still verifies does not deliver.
		const download = await app.fetch(
			new Request(`${ORIGIN}/api/content/works/${workId}/assets/${assetId}/download`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: buyerCookie, "X-Anthers-Grant": before as string },
			}),
		);
		expect(download.status).toBe(403);
		const body = (await download.json()) as { access?: { canAccess?: boolean } };
		expect(body.access?.canAccess).toBe(false);
	});
});
