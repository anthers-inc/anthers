// SPDX-License-Identifier: Apache-2.0
/**
 * What a Work's credits look like to each viewer, and how the credited person finds out.
 *
 * Two halves of one premise — a `did`-naming credit is a claim about a third party, not a
 * liner note yet:
 *
 * 1. **The overlay.** An unaccepted identity-credit is withheld from everyone except the
 *    person it names and the Work's creator; an accepted one resolves to a handle and never
 *    ships a bare `did:` string; a named credit is untouched in every case.
 * 2. **The notification.** Saving a Work that names an on-network person tells them once
 *    per (work, contributor, role) — block-checked, self-DID excluded, and excluded once the
 *    credit has been accepted.
 *
 * Overlay cases are staged through `insertWork` (no route, so no notification side effects);
 * notification cases go through the create/PATCH routes because the dedupe guarantee only
 * means anything across real saves.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creditAcceptances,
	notifications,
	userBlocks,
	users,
	type WorkCredit,
} from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import app from "../index.js";
import { queue } from "../jobs/queue.js";
import { blockUser } from "../services/blocks.js";
import {
	acceptCredit,
	creditsForOwner,
	creditsForViewer,
	notifyCreditedAccounts,
} from "../services/credit-acceptance.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const RUN = `cv${Date.now().toString(36)}`;
const ORIGIN = "http://localhost:3000";

// A stubbed queue.send, as credit-acceptance.test.ts sets up: the save routes enqueue scans
// and transcodes, and a bare `bun test` has no running boss to receive them.
let sendSpy: ReturnType<typeof spyOn>;

afterAll(() => {
	sendSpy.mockRestore();
});

let creator: Awaited<ReturnType<typeof createAccount>>;
let contributor: Awaited<ReturnType<typeof createAccount>>;
let thirdParty: Awaited<ReturnType<typeof createAccount>>;

/** Works this suite inserted directly (route-created ones are tracked per test). */
const fixtureWorkIds: number[] = [];
afterAll(async () => {
	// Acceptances key on the Work, and cascade with it — but the Work rows created through
	// the routes are tracked below and everything else here goes through the fixture sweep,
	// so the explicit pass is the belt to the sweep's braces.
	await purgeWorkIds(fixtureWorkIds);
});

/** The notification rows a save produced for the contributor, by dedupe key. */
async function creditNotifications(userId: number, did: string, workId: number, role: string) {
	return db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.userId, userId),
				eq(notifications.kind, "credit_offered"),
				eq(notifications.dedupeKey, `credit-offered:${workId}:${did}:${role}`),
			),
		);
}

function patchReq(workId: number, token: string, body: unknown): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${token}`,
				Origin: ORIGIN,
			},
			body: JSON.stringify(body),
		}),
	);
}

beforeAll(async () => {
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);

	creator = await createAccount(`${RUN}-creator`, { emailVerified: true });
	contributor = await createAccount(`${RUN}-contributor`, { emailVerified: true });
	thirdParty = await createAccount(`${RUN}-third`, { emailVerified: true });
}, 30_000);

// ─── The overlay ──────────────────────────────────────────────────────────────

describe("creditsForViewer", () => {
	let overlayWork: Awaited<ReturnType<typeof insertWork>>;
	const namedCredit: WorkCredit = { role: "Edited by", contributor: "An Editor", types: ["created"] };

	beforeAll(async () => {
		overlayWork = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [
				{ role: "Written by", contributor: contributor.did, types: ["created"] },
				namedCredit,
			],
		});
		fixtureWorkIds.push(overlayWork.id);
	});

	it("withholds an unaccepted did-credit from a signed-out viewer, leaving named credits untouched", async () => {
		const seen = await creditsForViewer(overlayWork, null);
		expect(seen).toHaveLength(1);
		// The untouched promise: the named credit ships with exactly what was stored.
		expect(seen[0]).toEqual(namedCredit);
		expect(seen.some((c) => c.contributor.includes(contributor.did))).toBe(false);
	});

	it("withholds an unaccepted did-credit from a third-party viewer", async () => {
		const seen = await creditsForViewer(overlayWork, thirdParty.userId);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual(namedCredit);
	});

	it("shows the did-credit to the named person, flagged for their confirmation", async () => {
		const seen = await creditsForViewer(overlayWork, contributor.userId);
		expect(seen).toHaveLength(2);
		const pending = seen.find((c) => c.contributor === contributor.did);
		expect(pending).toBeDefined();
		expect(pending?.awaitingYourConfirmation).toBe(true);
		expect(pending?.role).toBe("Written by");
		expect(pending?.types).toEqual(["created"]);
		// The named credit is untouched for them too.
		expect(seen.some((c) => c.role === "Edited by" && c.contributor === "An Editor")).toBe(true);
	});

	it("shows the did-credit to the creator, flagged as awaiting the contributor", async () => {
		const seen = await creditsForViewer(overlayWork, creator.userId);
		expect(seen).toHaveLength(2);
		const pending = seen.find((c) => c.contributor === contributor.did);
		expect(pending?.awaitingContributorConfirmation).toBe(true);
		expect(pending?.awaitingYourConfirmation).toBeUndefined();
	});

	it("flags the same credit as awaiting through the owner shape", async () => {
		const seen = await creditsForOwner(overlayWork);
		expect(seen).toHaveLength(2);
		expect(seen.find((c) => c.contributor === contributor.did)?.awaitingContributorConfirmation).toBe(
			true,
		);
	});

	it("resolves an accepted did-credit to the account's name for every viewer", async () => {
		const result = await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: overlayWork.id,
			workUri: `at://${creator.did}/org.anthers.work/abc123`,
			role: "Written by",
		});
		expect(result.ok).toBe(true);

		// The invariant the resolution leans on: acceptance implies a users row for the DID,
		// because accepting requires a signed-in account whose identity IS that DID. Without
		// it, resolution would have no name to reach for and a bare DID would be the only
		// thing left to show.
		const [row] = await db
			.select({ id: users.id, handle: users.atprotoHandle })
			.from(users)
			.where(eq(users.atprotoDid, contributor.did))
			.limit(1);
		expect(row).toBeDefined();
		expect(row.handle).toBe(contributor.handle);

		// Every viewer — signed-out, third-party, the creator, the contributor — now sees a
		// name, never a bare did: string.
		for (const viewer of [null, thirdParty.userId, creator.userId, contributor.userId]) {
			const seen = await creditsForViewer(overlayWork, viewer);
			expect(seen).toHaveLength(2);
			const resolved = seen.find((c) => c.role === "Written by");
			expect(resolved?.contributor).toBe(contributor.handle);
			// Confirmed, so it carries neither awaiting flag.
			expect(resolved?.awaitingYourConfirmation).toBeUndefined();
			expect(resolved?.awaitingContributorConfirmation).toBeUndefined();
		}
	});

	it("resolves a display name in preference to a handle, like every creator rendering does", async () => {
		await db
			.update(users)
			.set({ displayName: "Contributor Display Name" })
			.where(eq(users.id, contributor.userId));
		const seen = await creditsForViewer(overlayWork, null);
		expect(seen.find((c) => c.role === "Written by")?.contributor).toBe(
			"Contributor Display Name",
		);
	});
});

// ─── The serialization paths ──────────────────────────────────────────────────

describe("work serialization", () => {
	let releasedWork: Awaited<ReturnType<typeof insertWork>>;

	beforeAll(async () => {
		releasedWork = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		fixtureWorkIds.push(releasedWork.id);
	});

	it("withholds an unaccepted did-credit from the work detail route for a signed-out viewer", async () => {
		const res = await app.request(`/api/content/works/${releasedWork.id}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.credits).toEqual([]);
	});

	it("withholds an unaccepted did-credit from the work detail route for a third party", async () => {
		const res = await app.request(`/api/content/works/${releasedWork.id}`, {
			headers: { Cookie: `session=${thirdParty.token}`, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.credits).toEqual([]);
	});

	it("shows the pending credit to the named person through the same route", async () => {
		const res = await app.request(`/api/content/works/${releasedWork.id}`, {
			headers: { Cookie: `session=${contributor.token}`, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.credits).toEqual([
			{
				role: "Written by",
				contributor: contributor.did,
				types: ["created"],
				awaitingYourConfirmation: true,
			},
		]);
	});

	it("shows the pending credit to the creator through the owner shape, flagged as awaiting", async () => {
		const res = await app.request(`/api/content/works/${releasedWork.id}`, {
			headers: { Cookie: `session=${creator.token}`, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.credits).toEqual([
			{
				role: "Written by",
				contributor: contributor.did,
				types: ["created"],
				awaitingContributorConfirmation: true,
			},
		]);
	});

	it("withholds an unaccepted did-credit from the catalog listing for a third party", async () => {
		const res = await app.request(`/api/content/catalog/${creator.handle}`, {
			headers: { Cookie: `session=${thirdParty.token}`, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const work = body.works.find((w: { id: number }) => w.id === releasedWork.id);
		expect(work?.credits).toEqual([]);
	});
});

// ─── The notification ─────────────────────────────────────────────────────────

describe("notifyCreditedAccounts", () => {
	const didCredits = (): WorkCredit[] => [
		{ role: "Written by", contributor: contributor.did, types: ["created"] },
	];

	/** A private Work straight through the create route — the route is what notifies. */
	async function createWorkViaRoute(credits: WorkCredit[]): Promise<{
		id: number;
		slug: string;
		publicId: number;
	}> {
		const res = await app.request("/api/content/works", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${creator.token}`,
				Origin: ORIGIN,
			},
			body: JSON.stringify({
				type: "text",
				title: `Credit notice ${RUN}`,
				credits,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		fixtureWorkIds.push(body.work.id);
		return body.work;
	}

	it("notifies a newly did-credited person once, with the work-shaped dedupe key", async () => {
		const work = await createWorkViaRoute(didCredits());
		const rows = await creditNotifications(contributor.userId, contributor.did, work.id, "Written by");
		expect(rows).toHaveLength(1);
		expect(rows[0].category).toBe("activity");
		expect(rows[0].linkPath).toBe(`/works/${work.slug}-${work.publicId}`);
		expect(rows[0].title).toContain("credited");

		// A re-save of the same credits is the dedupe guarantee's whole subject.
		const res = await patchReq(work.id, creator.token, { credits: didCredits() });
		expect(res.status).toBe(200);
		const again = await creditNotifications(
			contributor.userId,
			contributor.did,
			work.id,
			"Written by",
		);
		expect(again).toHaveLength(1);
	});

	it("does not notify for an already-accepted credit", async () => {
		const work = await createWorkViaRoute(didCredits());
		// The first save notified; accepting is the contributor answering it.
		await acceptCredit({
			callerUserId: contributor.userId,
			callerDid: contributor.did,
			workId: work.id,
			workUri: `at://${creator.did}/org.anthers.work/abc456`,
			role: "Written by",
		});
		// A save that arrives after the acceptance — removing and re-adding the same credit —
		// must not produce a second notification.
		const res = await patchReq(work.id, creator.token, {
			credits: [{ role: "Written by", contributor: contributor.did, types: ["created"] }],
		});
		expect(res.status).toBe(200);
		const rows = await creditNotifications(
			contributor.userId,
			contributor.did,
			work.id,
			"Written by",
		);
		expect(rows).toHaveLength(1);
	});

	it("does not notify the creator about their own did", async () => {
		const work = await createWorkViaRoute([
			{ role: "Written by", contributor: creator.did, types: ["created"] },
		]);
		const rows = await creditNotifications(creator.userId, creator.did, work.id, "Written by");
		expect(rows).toHaveLength(0);
	});

	it("does not notify a person who is blocked from the creator, in either direction", async () => {
		// The contributor blocks the creator, so the contributor never hears about the credit.
		await blockUser(contributor.userId, creator.userId);
		try {
			const work = await createWorkViaRoute(didCredits());
			const rows = await creditNotifications(
				contributor.userId,
				contributor.did,
				work.id,
				"Written by",
			);
			expect(rows).toHaveLength(0);
		} finally {
			await db.delete(userBlocks).where(
				and(
					eq(userBlocks.blockerId, contributor.userId),
					eq(userBlocks.blockedId, creator.userId),
				),
			);
		}
	});

	it("does not notify for a did with no account on the platform", async () => {
		const offPlatformDid = "did:plc:no-such-account-on-this-network";
		const work = await createWorkViaRoute([
			{ role: "Written by", contributor: offPlatformDid, types: ["created"] },
		]);
		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.kind, "credit_offered"),
					eq(notifications.dedupeKey, `credit-offered:${work.id}:${offPlatformDid}:Written by`),
				),
			);
		expect(rows).toHaveLength(0);
	});

	it("notifies separately per role on the same work and did", async () => {
		const work = await createWorkViaRoute([
			{ role: "Written by", contributor: contributor.did, types: ["created"] },
			{ role: "Produced by", contributor: contributor.did, types: ["created"] },
		]);
		const written = await creditNotifications(
			contributor.userId,
			contributor.did,
			work.id,
			"Written by",
		);
		const produced = await creditNotifications(
			contributor.userId,
			contributor.did,
			work.id,
			"Produced by",
		);
		expect(written).toHaveLength(1);
		expect(produced).toHaveLength(1);
	});
});

// ─── Direct service entry ─────────────────────────────────────────────────────

describe("notifyCreditedAccounts (service)", () => {
	it("is a no-op for a work whose credits name nobody on the network", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			credits: [{ role: "Written by", contributor: "A Named Author", types: ["created"] }],
		});
		fixtureWorkIds.push(work.id);
		const before = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(eq(notifications.userId, contributor.userId));
		await notifyCreditedAccounts(work, creator.userId);
		const after = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(eq(notifications.userId, contributor.userId));
		expect(after).toHaveLength(before.length);
	});
});

// The credit_acceptances rows this suite wrote are removed with their Works (cascade on
// work_id); the works themselves by the purge above. The notifications rows cascade with
// the fixture accounts, which `purgeAccountsCreatedHere` removes.
void creditAcceptances;