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
