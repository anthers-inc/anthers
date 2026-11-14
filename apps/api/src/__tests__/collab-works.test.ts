// SPDX-License-Identifier: Apache-2.0
/**
 * Collab Works: one Work, several owners, one publisher.
 *
 * The suite exercises the properties the feature is for, not the UI: a Work is one row
 * with an owner set, an invitation is private until accepted, every owner can edit but only
 * remove themselves, the Work appears on each owner's profile and Studio, and the publisher
 * role can be handed over without changing the Work or anyone's ownership.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { workCollaborators, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function json(cookie: string, body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	};
}

function patch(cookie: string, body: unknown): RequestInit {
	return {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	};
}

let publisher: Awaited<ReturnType<typeof createAccount>>;
let collaborator: Awaited<ReturnType<typeof createAccount>>;
let outsider: Awaited<ReturnType<typeof createAccount>>;
let workId = 0;

beforeAll(async () => {
	publisher = await createAccount(`cw_pub_${RUN}`, { fields: { creatorMode: true } });
	collaborator = await createAccount(`cw_col_${RUN}`, { fields: { creatorMode: true } });
	outsider = await createAccount(`cw_out_${RUN}`, { fields: { creatorMode: true } });
	const work = await insertWork({
		creatorId: publisher.userId,
		type: "video",
		title: `Collab work ${RUN}`,
		visibility: "private",
	});
	workId = work.id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workId) await db.delete(works).where(eq(works.id, workId));
});

describe("an invitation", () => {
	it("is private until the invited creator accepts", async () => {
		const invited = await req(
			`/api/content/works/${workId}/collaborators`,
			json(publisher.cookie, { did: collaborator.did }),
		);
		expect(invited.status).toBe(201);

		const inbox = await req("/api/content/work-collaborations", {
			headers: { Cookie: collaborator.cookie },
		});
		expect(inbox.status).toBe(200);
		const { invites } = (await inbox.json()) as { invites: { work: { id: number } }[] };
		expect(invites.map((invite) => invite.work.id)).toContain(workId);

		const studio = await req("/api/content/works", {
			headers: { Cookie: collaborator.cookie },
		});
		const { works: before } = (await studio.json()) as { works: { id: number }[] };
		expect(before.some((work) => work.id === workId)).toBe(false);

		const refused = await req(
			`/api/content/works/${workId}`,
			patch(collaborator.cookie, { title: "Too early" }),
		);
		expect(refused.status).toBe(404);
	});

	it("adds the second owner on acceptance, and both can edit", async () => {
		const accepted = await req(
			`/api/content/works/${workId}/collaborators/accept`,
			json(collaborator.cookie, {}),
		);
		expect(accepted.status).toBe(200);

		const studio = await req("/api/content/works", {
			headers: { Cookie: collaborator.cookie },
		});
		const { works: after } = (await studio.json()) as { works: { id: number }[] };
		expect(after.some((work) => work.id === workId)).toBe(true);

		const edited = await req(
			`/api/content/works/${workId}`,
			patch(collaborator.cookie, { title: `Edited by co-owner ${RUN}` }),
		);
		expect(edited.status).toBe(200);

		const refused = await req(
			`/api/content/works/${workId}`,
			patch(outsider.cookie, { title: "Not mine" }),
		);
		expect(refused.status).toBe(404);

		const profile = await req(`/api/content/catalog/${collaborator.handle}`, {
			headers: { Cookie: collaborator.cookie },
		});
		expect(profile.status).toBe(200);
		const { works: catalog } = (await profile.json()) as { works: { id: number }[] };
		expect(catalog.some((work) => work.id === workId)).toBe(true);
	});

	it("does not let an outsider invite or remove", async () => {
		const invited = await req(
			`/api/content/works/${workId}/collaborators`,
			json(outsider.cookie, { did: outsider.did }),
		);
		expect(invited.status).toBe(404);

		const removed = await req(`/api/content/works/${workId}/collaborators/${publisher.userId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: outsider.cookie },
		});
		expect(removed.status).toBe(404);
	});
});

describe("leaving and handover", () => {
	it("lets a collaborator leave without touching the Work", async () => {
		const left = await req(`/api/content/works/${workId}/collaborators/${collaborator.userId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: collaborator.cookie },
		});
		expect(left.status).toBe(204);

		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work).toBeDefined();

		const refused = await req(
			`/api/content/works/${workId}`,
			patch(collaborator.cookie, { title: "No longer mine" }),
		);
		expect(refused.status).toBe(404);
	});

	it("hands the publisher role over by a two-step consent", async () => {
		// Re-invite and accept the collaborator, then move the publisher role.
		expect(
			(
				await req(
					`/api/content/works/${workId}/collaborators`,
					json(publisher.cookie, { did: collaborator.did }),
				)
			).status,
		).toBe(201);
		expect(
			(
				await req(
					`/api/content/works/${workId}/collaborators/accept`,
					json(collaborator.cookie, {}),
				)
			).status,
		).toBe(200);

		const asked = await req(
			`/api/content/works/${workId}/publisher`,
			json(publisher.cookie, { creatorId: collaborator.userId }),
		);
		expect(asked.status).toBe(201);

		const accepted = await req(
			`/api/content/works/${workId}/publisher/accept`,
			json(collaborator.cookie, {}),
		);
		expect(accepted.status).toBe(200);

		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work?.creatorId).toBe(collaborator.userId);
		const rows = await db
			.select()
			.from(workCollaborators)
			.where(eq(workCollaborators.workId, workId));
		expect(rows.map((row) => [row.creatorId, row.status])).toEqual([
			[publisher.userId, "accepted"],
		]);

		// The same Work, and both former owners still edit it.
		for (const cookie of [publisher.cookie, collaborator.cookie]) {
			const edited = await req(
				`/api/content/works/${workId}`,
				patch(cookie, { title: `Edited after handover ${RUN}` }),
			);
			expect(edited.status).toBe(200);
		}
	});

	it("deletes a Work when its last owner leaves", async () => {
		const lonely = await insertWork({
			creatorId: publisher.userId,
			type: "video",
			title: `Last owner ${RUN}`,
			visibility: "private",
		});
		const left = await req(`/api/content/works/${lonely.id}/collaborators/${publisher.userId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: publisher.cookie },
		});
		expect(left.status).toBe(204);
		expect(await db.select().from(works).where(eq(works.id, lonely.id))).toHaveLength(0);
	});
});

/**
 * A co-owned Work's gate.
 *
 * The money rule behind it: a solo Badge would let one owner's supporters take a Work
 * whose earnings are split with people they never gave anything to. A Badge another
 * creator also owns pays every owner through its own split, and a direct price pays them
 * through the ordinary purchase split — so those two are allowed and the solo gate is not.
 */
describe("a co-owned Work's gate", () => {
	it("refuses a solo Badge, and keeps a shared Badge and a direct price", async () => {
		const work = await insertWork({
			creatorId: collaborator.userId,
			type: "video",
			title: `Gate ${RUN}`,
			visibility: "private",
		});
		await db.insert(workCollaborators).values({
			workId: work.id,
			creatorId: publisher.userId,
			status: "accepted",
			invitedById: collaborator.userId,
		});

		const created = async (label: string, threshold: string) => {
			const res = await req(
				"/api/subscriptions/badges",
				json(collaborator.cookie, { threshold, label }),
			);
			expect(res.status).toBe(201);
			return ((await res.json()) as { badge: { id: number } }).badge.id;
		};
		const soloBadgeId = await created(`Solo gate ${RUN}`, "6.00");
		const sharedBadgeId = await created(`Shared gate ${RUN}`, "7.00");
		expect(
			(
				await req(
					`/api/subscriptions/badges/${sharedBadgeId}/collaborators`,
					json(collaborator.cookie, { did: publisher.did }),
				)
			).status,
		).toBe(201);
		expect(
			(
				await req(
					`/api/subscriptions/badges/${sharedBadgeId}/collaborators/accept`,
					json(publisher.cookie, {}),
				)
			).status,
		).toBe(200);

		const rows = (badgeId: number, threshold: number, allow: boolean, price: string) => [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold, badgeId, allow, price },
		];

		const refused = await req(
			`/api/content/works/${work.id}`,
			patch(publisher.cookie, { access: rows(soloBadgeId, 6, true, "0") }),
		);
		expect(refused.status).toBe(400);
		const refusal = (await refused.json()) as { error: string };
		expect(refusal.error).toContain("another creator owns too");

		const sharedGate = await req(
			`/api/content/works/${work.id}`,
			patch(publisher.cookie, { access: rows(sharedBadgeId, 7, true, "0") }),
		);
		expect(sharedGate.status).toBe(200);

		// The solo rung's PRICED row is a purchase door, not a gate: it pays the Work's
		// owners through the ordinary split, so the same rung is allowed to sell.
		const priced = await req(
			`/api/content/works/${work.id}`,
			patch(publisher.cookie, { access: rows(soloBadgeId, 6, false, "4.00") }),
		);
		expect(priced.status).toBe(200);
		const [stored] = await db.select().from(works).where(eq(works.id, work.id));
		expect(
			(stored.access ?? []).some((row) => row.badgeId === soloBadgeId && row.price === "4.00"),
		).toBe(true);
	});
});
