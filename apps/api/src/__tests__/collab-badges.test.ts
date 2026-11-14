// SPDX-License-Identifier: Apache-2.0
/**
 * Collab Badges: one Badge, several owners, one support line.
 *
 * The suite exercises the properties the feature is for, not the UI: a Badge is one row
 * with an owner set, an invitation is private until accepted, every owner can edit but only
 * remove themselves, a held Badge counts for every owner's gate, and the publisher can be
 * handed over without changing the Badge or anyone's share.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badgeCollaborators, badges, userBadges } from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import app from "../index";
import { resolveAccess } from "../services/access";
import { splitCentsEvenly, splitDollarsEvenly } from "../services/badge-splits";
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

let publisher: Awaited<ReturnType<typeof createAccount>>;
let collaborator: Awaited<ReturnType<typeof createAccount>>;
let outsider: Awaited<ReturnType<typeof createAccount>>;
let supporter: Awaited<ReturnType<typeof createAccount>>;
let badgeId = 0;

beforeAll(async () => {
	publisher = await createAccount(`cb_pub_${RUN}`, { fields: { creatorMode: true } });
	collaborator = await createAccount(`cb_col_${RUN}`, { fields: { creatorMode: true } });
	outsider = await createAccount(`cb_out_${RUN}`, { fields: { creatorMode: true } });
	supporter = await createAccount(`cb_sup_${RUN}`);

	const created = await req(
		"/api/subscriptions/badges",
		json(publisher.cookie, { threshold: "6.00", label: `Shared ${RUN}` }),
	);
	expect(created.status).toBe(201);
	badgeId = ((await created.json()) as { badge: { id: number } }).badge.id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// Cascades remove the collaborator rows and holdings; the Badge itself is explicit so a
	// failed suite does not leave one behind.
	if (badgeId) await db.delete(badges).where(eq(badges.id, badgeId));
});

describe("an invitation", () => {
	it("is private until the invited creator accepts", async () => {
		const invited = await req(
			`/api/subscriptions/badges/${badgeId}/collaborators`,
			json(publisher.cookie, { did: collaborator.did }),
		);
		expect(invited.status).toBe(201);

		const before = await req(`/api/subscriptions/badges?creator=${collaborator.handle}`);
		expect(before.status).toBe(200);
		expect(
			((await before.json()) as { badges: { id: number }[] }).badges.some(
				(badge) => badge.id === badgeId,
			),
		).toBe(false);

		const inbox = await req("/api/subscriptions/collaborations", {
			headers: { Cookie: collaborator.cookie },
		});
		expect(inbox.status).toBe(200);
		const { invites } = (await inbox.json()) as { invites: { badge: { id: number } }[] };
		expect(invites.map((invite) => invite.badge.id)).toContain(badgeId);
	});

	it("adds the second view on acceptance, with the publisher first", async () => {
		const accepted = await req(
			`/api/subscriptions/badges/${badgeId}/collaborators/accept`,
			json(collaborator.cookie, {}),
		);
		expect(accepted.status).toBe(200);

		for (const handle of [publisher.handle, collaborator.handle]) {
			const res = await req(`/api/subscriptions/badges?creator=${handle}`);
			const { badges: ladder } = (await res.json()) as {
				badges: { id: number; creatorId: number; owners: { id: number }[] }[];
			};
			const badge = ladder.find((row) => row.id === badgeId);
			expect(badge).toBeDefined();
			expect(badge?.creatorId).toBe(publisher.userId);
			expect(badge?.owners.map((owner) => owner.id)).toEqual([
				publisher.userId,
				collaborator.userId,
			]);
		}
	});
});

describe("editing a shared Badge", () => {
	it("lets either owner edit and leaves the outsider outside", async () => {
		const edited = await req(`/api/subscriptions/badges/${badgeId}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: collaborator.cookie,
			},
			body: JSON.stringify({ label: `Shared by both ${RUN}` }),
		});
		expect(edited.status).toBe(200);
		const [row] = await db
			.select({ label: badges.label })
			.from(badges)
			.where(eq(badges.id, badgeId));
		expect(row?.label).toBe(`Shared by both ${RUN}`);

		const refused = await req(`/api/subscriptions/badges/${badgeId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: outsider.cookie },
			body: JSON.stringify({ label: "Not mine" }),
		});
		expect(refused.status).toBe(404);
	});

	it("does not let one owner remove another", async () => {
		const res = await req(
			`/api/subscriptions/badges/${badgeId}/collaborators/${collaborator.userId}`,
			{ method: "DELETE", headers: { Origin: ORIGIN, Cookie: publisher.cookie } },
		);
		expect(res.status).toBe(403);
	});
});

describe("a held Collab Badge", () => {
	it("opens a Work published by the collaborator, not only the publisher", async () => {
		const work = await insertWork({
			creatorId: collaborator.userId,
			type: "text",
			title: `Shared gate ${RUN}`,
			access: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 6, badgeId, allow: true, price: "0" },
			],
		});
		await db
			.insert(userBadges)
			.values({ userId: supporter.userId, badgeId, billingCycle: currentCycleKey() })
			.onConflictDoNothing();

		const supporterAccess = await resolveAccess(work, supporter.userId);
		expect(supporterAccess.canAccess).toBe(true);

		const outsiderAccess = await resolveAccess(work, outsider.userId);
		expect(outsiderAccess.canAccess).toBe(false);
	});
});

describe("the publisher role", () => {
	it("moves only after the target accepts, and leaves both creators owning the Badge", async () => {
		const asked = await req(
			`/api/subscriptions/badges/${badgeId}/publisher`,
			json(publisher.cookie, { creatorId: collaborator.userId }),
		);
		expect(asked.status).toBe(201);

		const inbox = await req("/api/subscriptions/collaborations", {
			headers: { Cookie: collaborator.cookie },
		});
		const { handovers } = (await inbox.json()) as { handovers: { badge: { id: number } }[] };
		expect(handovers.map((handover) => handover.badge.id)).toContain(badgeId);

		const accepted = await req(
			`/api/subscriptions/badges/${badgeId}/publisher/accept`,
			json(collaborator.cookie, {}),
		);
		expect(accepted.status).toBe(200);

		const [badge] = await db
			.select({ creatorId: badges.creatorId })
			.from(badges)
			.where(eq(badges.id, badgeId));
		expect(badge?.creatorId).toBe(collaborator.userId);

		const [oldPublisher] = await db
			.select({ status: badgeCollaborators.status })
			.from(badgeCollaborators)
			.where(
				and(
					eq(badgeCollaborators.badgeId, badgeId),
					eq(badgeCollaborators.creatorId, publisher.userId),
				),
			);
		expect(oldPublisher?.status).toBe("accepted");

		// The old publisher is a collaborator now and can still edit.
		const edited = await req(`/api/subscriptions/badges/${badgeId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: publisher.cookie },
			body: JSON.stringify({ description: "Still ours." }),
		});
		expect(edited.status).toBe(200);
	});

	it("lets the former publisher leave, keeping the Badge with the new publisher", async () => {
		const left = await req(
			`/api/subscriptions/badges/${badgeId}/collaborators/${publisher.userId}`,
			{ method: "DELETE", headers: { Origin: ORIGIN, Cookie: publisher.cookie } },
		);
		expect(left.status).toBe(204);

		const [badge] = await db
			.select({ creatorId: badges.creatorId })
			.from(badges)
			.where(eq(badges.id, badgeId));
		expect(badge?.creatorId).toBe(collaborator.userId);

		const [oldRow] = await db
			.select({ id: badgeCollaborators.id })
			.from(badgeCollaborators)
			.where(
				and(
					eq(badgeCollaborators.badgeId, badgeId),
					eq(badgeCollaborators.creatorId, publisher.userId),
				),
			);
		expect(oldRow).toBeUndefined();

		const publisherLadder = await req(`/api/subscriptions/badges?creator=${publisher.handle}`);
		const { badges: publisherBadges } = (await publisherLadder.json()) as {
			badges: { id: number }[];
		};
		expect(publisherBadges.some((row) => row.id === badgeId)).toBe(false);

		const collaboratorLadder = await req(
			`/api/subscriptions/badges?creator=${collaborator.handle}`,
		);
		const { badges: collaboratorBadges } = (await collaboratorLadder.json()) as {
			badges: { id: number }[];
		};
		expect(collaboratorBadges.some((row) => row.id === badgeId)).toBe(true);
	});
});

describe("the split", () => {
	it("conserves the total and gives the remainder to the last owner", () => {
		expect(splitCentsEvenly(600, 2)).toEqual([300, 300]);
		expect(splitCentsEvenly(1000, 3)).toEqual([333, 333, 334]);
		expect(splitCentsEvenly(5, 2)).toEqual([2, 3]);
		expect(splitDollarsEvenly(new Decimal("6.00"), 3)).toEqual([200, 200, 200]);
		expect(splitCentsEvenly(1000, 3).reduce((sum, share) => sum + share, 0)).toBe(1000);
	});
});
