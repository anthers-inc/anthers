// SPDX-License-Identifier: Apache-2.0
/**
 * A person's own credit list — the creator profile's Credits tab read.
 *
 * Two facts make the list what it is, and both are proved here:
 *
 * 1. **Only accepted credits are public.** A `did`-naming credit with no acceptance row is
 *    withheld from every stranger's answer; the account it names sees it in `pending`, so the
 *    profile is where an attribution waits to be reviewed.
 * 2. **A creator's own credit on their own Work is accepted when written.** It is not a claim
 *    about a third party, so it never sits in their own pending queue and never waits for a
 *    confirmation they would be giving themselves.
 *
 * The visibility conditions are the point of the route rather than its plumbing: a listing of
 * Works carries `maturityHiddenFrom` beside `notBlockedBy`, so an Adult Work the viewer may not
 * reach contributes no row — title included — and an unreleased Work contributes none at all.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { workCreditDecisions } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { queue } from "../jobs/queue.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `pc${Date.now().toString(36)}`;
const ORIGIN = "http://localhost:3000";

let sendSpy: ReturnType<typeof spyOn>;
afterAll(() => {
	sendSpy.mockRestore();
});

let creator: Awaited<ReturnType<typeof createAccount>>;
let contributor: Awaited<ReturnType<typeof createAccount>>;

const fixtureWorkIds: number[] = [];
afterAll(async () => {
	await purgeWorkIds(fixtureWorkIds);
});

interface CreditRow {
	workId: number;
	title: string | null;
	role: string;
	year: number | null;
}

interface CreditsAnswer {
	creator: { handle: string; displayName: string | null };
	accepted: CreditRow[];
	pending: CreditRow[];
}

/** The profile credits answer as a given signed-in account, or signed out. */
async function creditsFor(handle: string, token?: string): Promise<CreditsAnswer> {
	const res = await app.request(`/api/content/credits/${handle}`, {
		headers: token ? { Cookie: `session=${token}` } : {},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as CreditsAnswer;
}

/** Rows in an answer that belong to one Work. */
function forWork(rows: CreditRow[], workId: number): CreditRow[] {
	return rows.filter((row) => row.workId === workId);
}

beforeAll(async () => {
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
	creator = await createAccount(`${RUN}-creator`, { emailVerified: true });
	contributor = await createAccount(`${RUN}-contributor`, { emailVerified: true });
}, 30_000);

describe("GET /api/content/credits/:handle", () => {
	it("withholds a pending credit from strangers and shows it to the person it names", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: `Pending credit ${RUN}`,
			credits: [{ role: "Sound design", contributor: contributor.did, types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);

		const stranger = await creditsFor(contributor.handle);
		expect(forWork(stranger.accepted, work.id)).toEqual([]);
		expect(stranger.pending).toEqual([]);

		const owner = await creditsFor(contributor.handle, contributor.token);
		expect(owner.pending).toContainEqual(
			expect.objectContaining({
				workId: work.id,
				title: `Pending credit ${RUN}`,
				role: "Sound design",
			}),
		);
		expect(forWork(owner.accepted, work.id)).toEqual([]);
	});

	it("moves a credit from pending to accepted when the person accepts", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: `Accepted credit ${RUN}`,
			credits: [{ role: "Illustration", contributor: contributor.did, types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);

		await db.insert(workCreditDecisions).values({
			workId: work.id,
			contributorDid: contributor.did,
			role: "Illustration",
			decision: "accepted",
		});

		const answer = await creditsFor(contributor.handle, contributor.token);
		expect(forWork(answer.accepted, work.id)).toEqual([
			expect.objectContaining({ role: "Illustration", title: `Accepted credit ${RUN}` }),
		]);
		expect(forWork(answer.pending, work.id)).toEqual([]);
	});

	it("accepts a self-credit when the Work is created", async () => {
		const res = await app.request("/api/content/works", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${creator.token}`,
				Origin: ORIGIN,
			},
			body: JSON.stringify({
				type: "service",
				title: `Self-credited ${RUN}`,
				credits: [{ role: "Everything", contributor: creator.did, types: ["created"] }],
			}),
		});
		expect(res.status).toBe(201);
		const { work } = (await res.json()) as { work: { id: number } };
		fixtureWorkIds.push(work.id);

		const [acceptance] = await db
			.select({ role: workCreditDecisions.role })
			.from(workCreditDecisions)
			.where(eq(workCreditDecisions.workId, work.id));
		expect(acceptance?.role).toBe("Everything");
	});

	it("shows a released Work's self-credit as accepted, never as pending", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: `Returning credit ${RUN}`,
			credits: [{ role: "Words", contributor: "A Named Author", types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);

		// A credit added on an edit to a released Work — the route is where "added" happens.
		const patch = await app.request(`/api/content/works/${work.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${creator.token}`,
				Origin: ORIGIN,
			},
			body: JSON.stringify({
				credits: [
					{ role: "Words", contributor: "A Named Author", types: ["created"] },
					{ role: "Design", contributor: creator.did, types: ["created"] },
				],
			}),
		});
		expect(patch.status).toBe(200);

		const answer = await creditsFor(creator.handle, creator.token);
		expect(forWork(answer.accepted, work.id)).toEqual([
			expect.objectContaining({ role: "Design", title: `Returning credit ${RUN}` }),
		]);
		expect(forWork(answer.pending, work.id)).toEqual([]);
	});

	it("leaves an unreleased Work out of the list", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: `Draft credit ${RUN}`,
			visibility: "private",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);
		await db.insert(workCreditDecisions).values({
			workId: work.id,
			contributorDid: contributor.did,
			role: "Written by",
			decision: "accepted",
		});

		const answer = await creditsFor(contributor.handle);
		expect(forWork(answer.accepted, work.id)).toEqual([]);
	});

	it("hides an Adult Work from someone who has not opted in", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: `Adult credit ${RUN}`,
			maturity: "adult",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);
		await db.insert(workCreditDecisions).values({
			workId: work.id,
			contributorDid: contributor.did,
			role: "Written by",
			decision: "accepted",
		});

		const answer = await creditsFor(contributor.handle, contributor.token);
		expect(forWork(answer.accepted, work.id)).toEqual([]);
	});

	it("answers 404 for a handle nobody holds", async () => {
		const res = await app.request(`/api/content/credits/no-such-handle-${RUN}`);
		expect(res.status).toBe(404);
	});
});
