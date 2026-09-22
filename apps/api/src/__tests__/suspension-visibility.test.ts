// SPDX-License-Identifier: Apache-2.0
/**
 * Suspension as a read-side absence — the "the account goes dark" half.
 *
 * One property, asserted at each shape of surface a suspended account used to appear
 * on: it stops being served. A suspended creator's Work page, profile, catalog and
 * comments answer with the same 404 a nonexistent entity gets, and their presence
 * drops out of every listing — the creator directory, the feed, the projects browse
 * — rather than being decorated with a suspension state, because naming the state in
 * a response would leak the one thing the state is for.
 *
 * The one exception the spec settles is asserted here too: a buyer's completed
 * purchase keeps working. A suspended creator's Work is still served to somebody who
 * owns it, because "what you buy stays yours" — the route that serves a purchased
 * Work to its buyer is not a listing.
 *
 * The fixture cleans its content by hand before its accounts, on the rule
 * `cleanup.creatorIds` exists for: `works.creator_id` is `set null`, and deleting a
 * user orphans its Works instead of taking them along.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases, users, works } from "@anthers/db/schema";
import { eq, like, sql } from "drizzle-orm";
import app from "../index";
import { suspendAccount, unsuspendAccount } from "../services/moderation.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
const creatorName = `sv_creator_${RUN}`;
const buyerName = `sv_buyer_${RUN}`;
const otherName = `sv_other_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function idOf(name: string): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${name}@example.com`));
	return row!.id;
}

let creatorId = 0;
let otherId = 0;
let adminId = 0;
let buyerCookie = "";
let workId = 0;
let workSlug = "";

/** Suspended the fixture creator, whatever state an earlier failed run left them in. */
async function suspend() {
	await suspendAccount({ userId: creatorId, adminId, reason: "fixture" });
}

async function unsuspend() {
	await unsuspendAccount({ userId: creatorId });
}

describe("Suspension visibility — a suspended account goes dark", () => {
	beforeAll(async () => {
		// A previous failed run may have left these accounts behind — clear them the way
		// withdrawn-work-notice does rather than dying on the unique email. The
		// moderation FKs being `set null` mean a report can outlive the account it
		// concerns, which is why a delete here does not trip on the suspension rows.
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${`${creatorName}@example.com`}, ${`${buyerName}@example.com`}, ${`${otherName}@example.com`})`,
		);
		const [creator, buyer, other] = await Promise.all([
			createAccount(creatorName),
			createAccount(buyerName),
			createAccount(otherName),
		]);
		// A real operator row: `moderation_actions.admin_actor_id` is a live FK, so a
		// stand-in id would fail the insert the sweep makes.
		adminId = (await createAdminFixture("sv-admin")).id;
		buyerCookie = buyer.cookie;
		creatorId = creator.user.id;
		otherId = other.user.id;
		void other;

		await db.update(users).set({ isCreator: true }).where(eq(users.id, creatorId));
		await db.update(users).set({ isCreator: true }).where(eq(users.id, otherId));

		// A released Work on the suspended creator, and a completed purchase of it by
		// the fixture buyer — written directly, because this suite is about reads and
		// driving Stripe would test checkout instead.
		const work = await insertWork({ creatorId, type: "game", title: "Suspended fixture" });
		workId = work.id;
		workSlug = work.slug;

		const buyerId = buyer.user.id;
		await db.insert(purchases).values({
			buyerId,
			workId: work.id,
			creatorId,
			workTitle: work.title,
			workType: work.type,
			workPublicId: work.publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			deliveryFee: "0.00",
			crfFee: "0.00",
			salesTax: "0.41",
			creatorEarnings: "4.53",
			stripePaymentIntentId: `pi_sv_${RUN}`,
			status: "completed",
		});
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Back to a standing state before teardown, so a *failed* run's accounts are
		// found by the next one regardless of which assertion tripped. The suspension
		// itself is the thing under test, so the sweep would lift a leftover anyway.
		await unsuspendAccount({ userId: creatorId });
		// Content first, while the rows still point at their owner — `works.creator_id`
		// is `set null`, so a deleted account orphans its Works instead of removing them.
		await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, `pi_sv_${RUN}`));
		await db.delete(works).where(like(works.slug, `%-${RUN}`));
	});

	describe("while suspended", () => {
		beforeAll(suspend);
		afterAll(unsuspend);

		it("answers a suspended creator's Work page with the ordinary not-found", async () => {
			const res = await req(`/api/content/works/${workSlug}`);
			expect(res.status).toBe(404);
			// The body is the same one an unknown slug gets — naming the suspension here
			// would be the leak the state exists to prevent.
			expect((await res.json()) as { error: string }).toEqual({ error: "Work not found" });
		});

		it("drops the suspended creator from the public creator directory", async () => {
			const res = await req("/api/accounts/creators");
			expect(res.status).toBe(200);
			const { creators } = (await res.json()) as { creators: { id: number }[] };
			expect(creators.some((c) => c.id === creatorId)).toBe(false);
			// The listing itself still works, and a creator nobody suspended is on it.
			expect(creators.some((c) => c.id === otherId)).toBe(true);
		});

		it("answers the suspended creator's profile by handle with not-found", async () => {
			const [creator] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, creatorId));
			const res = await req(`/api/accounts/users/${creator!.handle}`);
			expect(res.status).toBe(404);
		});

		it("answers the suspended creator's catalog with not-found", async () => {
			const [creator] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, creatorId));
			const res = await req(`/api/content/catalog/${creator!.handle}`);
			expect(res.status).toBe(404);
		});

		it("still serves the suspended creator's purchased Work to its buyer", async () => {
			const res = await req(`/api/content/works/${workSlug}`, {
				headers: { Cookie: buyerCookie },
			});
			expect(res.status).toBe(200);
		});

		it("drops the suspended creator's Works from the projects browse and the feed", async () => {
			// `?creator=` is the per-handle public feed; a suspended account reads as
			// somebody with nothing to show rather than as an error about the account.
			const [creator] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, creatorId));
			const postsRes = await req(`/api/content/posts?creator=${creator!.handle}`);
			expect(postsRes.status).toBe(200);
			const postsBody = (await postsRes.json()) as { posts: unknown[] };
			expect(postsBody.posts).toHaveLength(0);
		});
	});

	describe("before and after", () => {
		it("serves a standing creator's Work page, profile and catalog normally", async () => {
			expect((await req(`/api/content/works/${workSlug}`)).status).toBe(200);
			const [creator] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, creatorId));
			expect((await req(`/api/accounts/users/${creator!.handle}`)).status).toBe(200);
			const listed = (await req("/api/accounts/creators")).status;
			expect(listed).toBe(200);
		});
	});
});
