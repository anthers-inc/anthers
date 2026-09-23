// SPDX-License-Identifier: Apache-2.0
/**
 * Accepting and rejecting credit for a Work.
 *
 * Acceptance writes an `org.anthers.creditAcceptance` record in the contributor's own
 * repository. While the Lexicon is unpublished, the local row is the signal and no record
 * is written. Rejection removes the credit and blocks re-adding it.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { creditAcceptances, creditRejections, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index.js";
import { QUEUES, queue } from "../jobs/queue.js";
import { acceptCredit, rejectCredit } from "../services/credit-acceptance.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `ca${Date.now().toString(36)}`;
const insertedWorkIds: number[] = [];
// A stubbed queue.send, as record-enqueues.test.ts sets up: acceptance and rejection both
// re-queue the Work listing, and a bare `bun test` has no running boss to receive it. The spy
// captures the enqueue and keeps "Database not opened" out of the assertions.
let sent: { name: string; data: Record<string, unknown> }[] = [];
let sendSpy: ReturnType<typeof spyOn>;

afterAll(async () => {
	sendSpy.mockRestore();
	// Acceptances and rejections are tied to Works that cascade them, but tests that leave
	// behind a Work whose creator was deleted need explicit cleanup.
	if (insertedWorkIds.length > 0) {
		await db.delete(creditAcceptances).where(inArray(creditAcceptances.workId, insertedWorkIds));
		await db.delete(creditRejections).where(inArray(creditRejections.workId, insertedWorkIds));
	}
	await purgeWorkIds(insertedWorkIds);
});

let workWithDidCredit: Awaited<ReturnType<typeof insertWork>>;
let workWithNameCredit: Awaited<ReturnType<typeof insertWork>>;
let contributor: Awaited<ReturnType<typeof createAccount>>;
let creator: Awaited<ReturnType<typeof createAccount>>;

beforeAll(async () => {
	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);

	creator = await createAccount(`${RUN}-creator`, { emailVerified: true });
	contributor = await createAccount(`${RUN}-contributor`, { emailVerified: true });
	workWithDidCredit = await insertWork({
		creatorId: creator.userId,
		type: "text",
		credits: [
			{ role: "Written by", contributor: contributor.did, types: ["created"] },
			{ role: "Edited by", contributor: "An Editor", types: ["created"] },
		],
	});
	workWithNameCredit = await insertWork({
		creatorId: creator.userId,
		type: "text",
		credits: [{ role: "Written by", contributor: "A Named Author", types: ["created"] }],
	});
	insertedWorkIds.push(workWithDidCredit.id, workWithNameCredit.id);
});

async function acceptViaRoute(workId: number, role: string, token: string): Promise<Response> {
	return app.request(`/api/content/works/${workId}/credits/accept`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${token}`,
			Origin: "http://localhost:3000",
		},
		body: JSON.stringify({ role }),
	});
}

async function rejectViaRoute(workId: number, role: string, token: string): Promise<Response> {
	return app.request(`/api/content/works/${workId}/credits/reject`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${token}`,
			Origin: "http://localhost:3000",
		},
		body: JSON.stringify({ role }),
	});
}

describe("acceptCredit", () => {
	it("records an acceptance row with a null atprotoUri while the collection is unpublished", async () => {
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: workWithDidCredit.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Written by",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Unpublished collection: no record address yet.
		expect(result.atprotoUri).toBeNull();

		const [row] = await db
			.select()
			.from(creditAcceptances)
			.where(
				and(
					eq(creditAcceptances.workId, workWithDidCredit.id),
					eq(creditAcceptances.contributorDid, contributor.did),
					eq(creditAcceptances.role, "Written by"),
				),
			)
			.limit(1);
		expect(row).toBeDefined();
		expect(row.atprotoUri).toBeNull();
	});

	it("re-queues the work listing after acceptance", async () => {
		// Its own work+credit — the first acceptance test already consumed the shared one, and a
		// second accept of the same credit returns already_accepted.
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);
		sent = [];
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Written by",
		});
		expect(result.ok).toBe(true);
		// The listing re-sync is what publishes a newly confirmed credit, so the enqueue is the
		// assertion rather than the success flag.
		expect(sent.some((s) => s.name === QUEUES.SYNC_WORK_LISTING && s.data.workId === work.id)).toBe(
			true,
		);
	});

	it("refuses when the caller is not credited with that role", async () => {
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: workWithNameCredit.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Written by",
		});
		expect(result).toEqual({ ok: false, code: "not_credited" });
	});

	it("refuses when the credit has been rejected", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);

		await rejectCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			role: "Written by",
		});

		// Rejection removes the credit from the Work, so there is nothing left to accept — the
		// refusal is not_credited. The thing that keeps a rejected credit from coming BACK is the
		// re-add guard, asserted in the routes block below (PATCH → credit_rejected).
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Written by",
		});
		expect(result).toEqual({ ok: false, code: "not_credited" });
	});

	it("refuses when there is no matching did-credit at all", async () => {
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: workWithNameCredit.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Illustrated by",
		});
		expect(result).toEqual({ ok: false, code: "not_credited" });
	});
});

describe("rejectCredit", () => {
	it("removes the credit from the Work and writes a rejection row", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);

		const result = await rejectCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			role: "Written by",
		});
		expect(result).toEqual({ ok: true });

		const [updated] = await db
			.select({ credits: works.credits })
			.from(works)
			.where(eq(works.id, work.id))
			.limit(1);
		expect(updated?.credits).toEqual([]);

		const [rejection] = await db
			.select()
			.from(creditRejections)
			.where(
				and(
					eq(creditRejections.workId, work.id),
					eq(creditRejections.contributorDid, contributor.did),
					eq(creditRejections.role, "Written by"),
				),
			)
			.limit(1);
		expect(rejection).toBeDefined();
	});

	it("refuses to reject a credit that is not on the Work", async () => {
		const result = await rejectCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: workWithNameCredit.id,
			role: "Written by",
		});
		expect(result).toEqual({ ok: false, code: "not_credited" });
	});
});

describe("routes", () => {
	it("accepts credit via POST /api/content/works/:id/credits/accept", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			visibility: "released",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);
		// The route accepts credit only against a public listing, so the fixture needs the
		// address a real release would have stamped.
		await db
			.update(works)
			.set({ atprotoUri: `at://${creator.did}/org.anthers.work/${work.id}` })
			.where(eq(works.id, work.id));

		const res = await acceptViaRoute(work.id, "Written by", contributor.token);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.accepted).toBe(true);
		expect(body.atprotoUri).toBeNull();
	});

	it("rejects credit via POST /api/content/works/:id/credits/reject", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);

		const res = await rejectViaRoute(work.id, "Written by", contributor.token);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.rejected).toBe(true);

		const [updated] = await db
			.select({ credits: works.credits })
			.from(works)
			.where(eq(works.id, work.id))
			.limit(1);
		expect(updated?.credits).toEqual([]);
	});

	it("refuses re-adding a rejected credit via PATCH /api/content/works/:id", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		insertedWorkIds.push(work.id);

		await rejectCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			role: "Written by",
		});

		const res = await app.request(`/api/content/works/${work.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${creator.token}`,
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({
				credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("credit_rejected");
	});
});
