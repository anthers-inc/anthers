// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two promises that had no mechanism behind them, and the shape of test that catches
 * that class.
 *
 * 51.05 says a deleted account's profile is deleted and that "Sessions: deleted when
 * they expire." Both were false, and neither failed anywhere:
 *
 * - `eraseAccount` made **zero object-storage calls**. `storage.delete` and
 *   `deletePrefix` each had exactly one caller, both inside `purgeWorkMedia`, which
 *   only `DELETE /works/:id` reached — so a deleted profile's avatar stayed publicly
 *   downloadable at its CDN URL forever, and every original, HLS rendition and asset
 *   stayed in the private bucket.
 * - `deleteExpiredSessions()` and `deleteExpiredTokens()` were exported and called from
 *   nowhere, so every session row ever written kept its `ip_address` and `user_agent`.
 *
 * 🚨 **The reason neither was caught is the reason these assertions are written the way
 * they are.** Every reader of `sessions` already filters on `expiresAt > now()`, so a
 * test that asks "can I still use this session?" passes identically against a working
 * cleanup and against no cleanup at all. It has to assert **rows removed**. Likewise the
 * storage sweep has no observable effect on any API response — nothing 404s differently
 * — so it has to assert **the calls made**, which is why `storage` is spied rather than
 * probed. Same family as the Agents Hub's *"a test that restates the code's formula"* and
 * *"where a document claims an absence, that absence needs a test."*
 *
 * Verified by sabotage before being committed: stubbing `sweepCollected` to a no-op fails
 * the storage cases, and stubbing either cleanup to `return 0` fails the credential ones.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, sessions, users, verificationTokens, works } from "@anthers/db/schema";
import { eq, inArray, lt } from "drizzle-orm";
import { eraseAccount } from "../services/account-deletion.js";
import { deleteExpiredSessions, deleteExpiredTokens } from "../services/auth.js";
import { storage } from "../services/storage/index.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const SUFFIX = `del${Date.now().toString(36)}`;
const created: number[] = [];

async function makeUser(name: string, extra: Record<string, unknown> = {}): Promise<number> {
	const [row] = await db
		.insert(users)
		.values({
			username: `${name}_${SUFFIX}`,
			email: `${name}_${SUFFIX}@example.test`,
			passwordHash: "x",
			emailVerified: true,
			isCreator: true,
			...extra,
		})
		.returning({ id: users.id });
	created.push(row.id);
	return row.id;
}

afterAll(async () => {
	// This suite runs against the shared dev Postgres, and most suites here never clean
	// up — the dev DB is not a clean room as a result. Works and posts are deleted first
	// because `works.creator_id` is ON DELETE SET NULL, so removing the user orphans
	// their content rather than removing it.
	if (created.length > 0) {
		await db.delete(works).where(inArray(works.creatorId, created));
		await db.delete(users).where(inArray(users.id, created));
	}
});

describe("account deletion sweeps object storage", () => {
	it(
		"deletes the account's avatar, header and unpurchased Work media",
		async () => {
			const userId = await makeUser("sweep", {
				avatar: "https://cdn.anthers.org/creators/9/gallery/avatar.png",
				headerImage: "https://cdn.anthers.org/creators/9/gallery/header.png",
			});
			const unbought = await insertWork({
				creatorId: userId,
				type: "video",
				title: "Unbought",
				sourceKey: `creators/${userId}/videos/source.mp4`,
			});
			// `thumbnail` isn't on the fixture, and it is the one that lives in the PUBLIC
			// bucket, so it is worth setting explicitly rather than skipping.
			await db
				.update(works)
				.set({ thumbnail: `https://cdn.anthers.org/creators/${userId}/gallery/thumb.jpg` })
				.where(eq(works.id, unbought.id));

			const deleted: string[] = [];
			const delSpy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
				deleted.push(key);
			});
			const prefixSpy = spyOn(storage, "deletePrefix").mockImplementation(async () => {});

			try {
				await eraseAccount(userId);
			} finally {
				delSpy.mockRestore();
				prefixSpy.mockRestore();
			}

			// The avatar is the one that mattered: it lives in the PUBLIC bucket behind
			// cdn.anthers.org, so leaving it is a deleted person's face still on the internet.
			expect(deleted).toContain("creators/9/gallery/avatar.png");
			expect(deleted).toContain("creators/9/gallery/header.png");
			expect(deleted).toContain(`creators/${userId}/videos/source.mp4`);
			expect(deleted).toContain(`creators/${userId}/gallery/thumb.jpg`);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"does NOT sweep a purchased Work — a buyer still downloads it",
		async () => {
			// The sharp edge. A purchased Work is *withdrawn*, not destroyed, and
			// `resolveAccess` reads purchases rather than visibility — so its bytes must
			// survive the creator leaving. Sweeping by creator instead of by
			// unpurchased-Work would pass every other assertion in this file.
			const userId = await makeUser("keep");
			const paid = await insertWork({
				creatorId: userId,
				type: "video",
				title: "Bought",
				sourceKey: `creators/${userId}/videos/paid.mp4`,
			});
			// A second, unbought Work by the SAME creator. Without it this test is a pure
			// negative assertion and passes against a sweep that does nothing at all —
			// which is exactly what it did under sabotage. Asserting the discrimination
			// (this one goes, that one stays) is what makes it load-bearing.
			const alsoUnbought = await insertWork({
				creatorId: userId,
				type: "video",
				title: "Also unbought",
				sourceKey: `creators/${userId}/videos/free.mp4`,
			});
			expect(alsoUnbought.id).toBeGreaterThan(0);

			// A completed purchase is enough — `purchasedAmong` only asks whether one exists.
			await db.insert(purchases).values({
				workId: paid.id,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				crfFee: "0.00",
				creatorEarnings: "4.55",
				stripePaymentIntentId: `pi_test_${SUFFIX}`,
				status: "completed",
				workTitle: "Bought",
			});

			const deleted: string[] = [];
			const delSpy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
				deleted.push(key);
			});
			const prefixSpy = spyOn(storage, "deletePrefix").mockImplementation(async () => {});

			try {
				await eraseAccount(userId);
			} finally {
				delSpy.mockRestore();
				prefixSpy.mockRestore();
			}

			expect(deleted).not.toContain(`creators/${userId}/videos/paid.mp4`);
			// ...and the sweep did run, so the absence above is a decision rather than a no-op.
			expect(deleted).toContain(`creators/${userId}/videos/free.mp4`);
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("expired credentials are actually deleted", () => {
	it(
		"removes expired session rows, and keeps live ones",
		async () => {
			const userId = await makeUser("cred");
			const past = new Date(Date.now() - 60_000);
			const future = new Date(Date.now() + 3_600_000);

			await db.insert(sessions).values([
				{ userId, token: `dead_${SUFFIX}`, expiresAt: past, ipAddress: "203.0.113.9" },
				{ userId, token: `live_${SUFFIX}`, expiresAt: future, ipAddress: "203.0.113.9" },
			]);

			const removed = await deleteExpiredSessions();

			// Asserting the COUNT, not a read: every reader already filters on expiry, so a
			// read-based assertion passes against a cleanup that does nothing at all.
			expect(removed).toBeGreaterThan(0);

			const rows = await db
				.select({ token: sessions.token })
				.from(sessions)
				.where(eq(sessions.userId, userId));
			const tokens = rows.map((r) => r.token);
			expect(tokens).toContain(`live_${SUFFIX}`);
			expect(tokens).not.toContain(`dead_${SUFFIX}`);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"leaves no expired session rows behind at all",
		async () => {
			// The retention promise is about rows on disk, not about reachability — the IP
			// address and user-agent are the payload, and they sit on the row.
			await deleteExpiredSessions();
			const stragglers = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(lt(sessions.expiresAt, new Date()));
			expect(stragglers).toHaveLength(0);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"removes expired verification tokens",
		async () => {
			const userId = await makeUser("tok");
			await db.insert(verificationTokens).values({
				userId,
				token: `expired_${SUFFIX}`,
				type: "email_verify",
				expiresAt: new Date(Date.now() - 60_000),
			});

			const removed = await deleteExpiredTokens();
			expect(removed).toBeGreaterThan(0);

			const stragglers = await db
				.select({ id: verificationTokens.id })
				.from(verificationTokens)
				.where(lt(verificationTokens.expiresAt, new Date()));
			expect(stragglers).toHaveLength(0);
		},
		DB_SETUP_TIMEOUT,
	);
});
