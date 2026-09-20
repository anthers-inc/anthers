// SPDX-License-Identifier: Apache-2.0
/**
 * Publishing anything requires a fully set-up creator: creator mode and completed payout setup.
 *
 * That covers releasing a Work, publishing or scheduling a post, and publishing a project, and
 * drafting any of them stays open. 🚨 **The Creator Terms and `/parents` both promise it** — *"a
 * completed payment setup with Stripe before you can publish anything"* — and a promise with
 * nothing exercising it rots as quietly as an absence does, which is the shape
 * `about-claims.test.ts` guards from the other side.
 *
 * **Why the gate exists** (Parker, 2026-08-28 for Works and 2026-09-13 for everything else,
 * since a post can be paid through Stickers), because a future reader will meet it as an
 * obstacle and needs both halves:
 *
 *   1. It is the **only** structural check making every creator here an adult. Stripe runs
 *      identity verification and will not verify a minor; Anthers deliberately holds no
 *      date of birth and no ID.
 *   2. It means **nothing published is payout-ineligible**. Ungated work earns from the Time
 *      Pool by the time people spend with it and a post can carry Stickers, so publishing
 *      without a way to be paid books a debt to somebody we cannot settle.
 *
 * ⚠️ **The case that is easiest to get wrong is the one that must NOT be gated.** Stripe can
 * hold an account at any time, long after release. If that re-closed an already-live Work's
 * edits, a creator whose account went under review would lose the ability to fix a typo, to
 * correct a rating, or to take the Work down — punishing them for something Stripe did. The
 * gate asks only about the moment of release or publication.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, projects, stripeAccounts, users, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { publishScheduled } from "../jobs/publish-scheduled";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { enablePayoutsFor } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

const id = crypto.randomUUID().slice(0, 8);
/** One account per payout state, so no test has to mutate another's. */
const noneName = `paynone_${id}`;
const heldName = `payheld_${id}`;
const readyName = `payready_${id}`;
/** Payouts ready, creator mode off — the half of "set up" the account holder fixes in a click. */
const payerName = `paypayer_${id}`;

async function signUp(username: string): Promise<{ cookie: string; userId: number }> {
	const account = await createAccount(username);
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${username}@example.com`));
	return { cookie: account.cookie, userId: row!.id };
}

describe("publishing requires a fully set-up creator", () => {
	let none: { cookie: string; userId: number };
	let payer: { cookie: string; userId: number };
	let held: { cookie: string; userId: number };
	let ready: { cookie: string; userId: number };
	const created: number[] = [];

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join([sql`${noneName + "@example.com"}`, sql`${heldName + "@example.com"}`, sql`${readyName + "@example.com"}`, sql`${payerName + "@example.com"}`], sql`, `)})`,
		);
		none = await signUp(noneName);
		held = await signUp(heldName);
		ready = await signUp(readyName);
		payer = await signUp(payerName);
		// The payout-state accounts are creators, so the only thing each lacks is what it is named for.
		await db
			.update(users)
			.set({ isCreator: true })
			.where(inArray(users.id, [none.userId, held.userId]));
		await enablePayoutsFor(payer.userId);
		await db.update(users).set({ isCreator: false }).where(eq(users.id, payer.userId));

		// Onboarding finished, but Stripe will not send money — under review, a missing
		// document, a restricted country. The state that proves the gate reads BOTH flags:
		// an implementation checking only `onboardingComplete` passes every other test here
		// and lets this creator through.
		await db.insert(stripeAccounts).values({
			userId: held.userId,
			stripeAccountId: `acct_test_held_${id}`,
			onboardingComplete: true,
			payoutsEnabled: false,
			chargesEnabled: false,
		});
		await enablePayoutsFor(ready.userId);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (created.length > 0) await db.delete(works).where(inArray(works.id, created));
		const mine = [none.userId, held.userId, ready.userId, payer.userId];
		await db.delete(posts).where(inArray(posts.creatorId, mine));
		await db.delete(projects).where(inArray(projects.creatorId, mine));
		await purgeFixtureAccounts([noneName, heldName, readyName, payerName]);
	});

	/** A private, rated text Work — so the only thing standing between it and release is payouts. */
	async function makeWork(cookie: string): Promise<number> {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				type: "text",
				title: `Payout fixture ${id}`,
				body: "A short thing.",
				bodyHtml: "<p>A short thing.</p>",
				maturityRows: rowsRatedAs("general"),
			}),
		});
		expect(res.status).toBe(201);
		const { work } = await res.json();
		created.push(work.id);
		return work.id;
	}

	const patch = (workId: number, body: Record<string, unknown>, cookie: string) =>
		req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify(body),
		});

	async function reload(workId: number) {
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		return row;
	}

	it("refuses a creator who has never connected an account, and leaves the Work private", async () => {
		const workId = await makeWork(none.cookie);
		const res = await patch(workId, { visibility: "released" }, none.cookie);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("payouts_required");
		// The Studio needs to tell "start setup" from "wait for Stripe" without guessing.
		expect(body.connected).toBe(false);
		expect((await reload(workId)).visibility).toBe("private");
	});

	it("refuses a creator Stripe is holding, even though onboarding finished", async () => {
		const workId = await makeWork(held.cookie);
		const res = await patch(workId, { visibility: "released" }, held.cookie);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("payouts_required");
		expect(body.connected).toBe(true);
		// A different message, because a different person has to do something next.
		expect(body.error).toContain("Stripe still needs something from you");
		expect((await reload(workId)).visibility).toBe("private");
	});

	it("refuses an account with payouts ready that is not in creator mode", async () => {
		const workId = await makeWork(payer.cookie);
		const res = await patch(workId, { visibility: "released" }, payer.cookie);
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("creator_required");
		expect((await reload(workId)).visibility).toBe("private");
	});

	it("releases once payouts are ready", async () => {
		const workId = await makeWork(ready.cookie);
		const res = await patch(workId, { visibility: "released" }, ready.cookie);
		expect(res.status).toBe(200);
		expect((await reload(workId)).visibility).toBe("released");
	});

	// The same rule every other readiness refusal follows: a creator who declares a rating
	// and ticks release in one request must not lose the declaration to the refusal.
	it("keeps a rating declared in the refused request", async () => {
		const workId = await makeWork(none.cookie);
		const res = await patch(
			workId,
			{ maturityRows: rowsRatedAs("mature"), visibility: "released" },
			none.cookie,
		);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("payouts_required");
		const row = await reload(workId);
		expect(row.visibility).toBe("private");
		expect(row.maturity).toBe("mature");
		expect(row.maturityNotes).toEqual(["violence"]);
	});

	// 🚨 The half that must stay open. See the note at the top of this file: a creator whose
	// account is held after release keeps every ordinary power over their own Work.
	it("still lets a creator edit a live Work after their payouts lapse", async () => {
		const workId = await makeWork(ready.cookie);
		expect((await patch(workId, { visibility: "released" }, ready.cookie)).status).toBe(200);

		await db
			.update(stripeAccounts)
			.set({ payoutsEnabled: false })
			.where(eq(stripeAccounts.userId, ready.userId));
		try {
			const res = await patch(workId, { title: `Edited ${id}` }, ready.cookie);
			expect(res.status).toBe(200);
			expect((await reload(workId)).title).toBe(`Edited ${id}`);

			// And taking it down is still theirs to do.
			expect((await patch(workId, { visibility: "private" }, ready.cookie)).status).toBe(200);

			// But re-releasing is gated again, because that is a release.
			const again = await patch(workId, { visibility: "released" }, ready.cookie);
			expect(again.status).toBe(409);
			expect((await again.json()).code).toBe("payouts_required");
		} finally {
			await enablePayoutsFor(ready.userId);
		}
	});

	describe("posts and projects", () => {
		const send = (method: string, path: string, cookie: string, body: Record<string, unknown>) =>
			req(path, {
				method,
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
				body: JSON.stringify(body),
			});
		const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

		it("lets a creator without payouts draft a post, and refuses publishing or scheduling one", async () => {
			const draft = await send("POST", "/api/content/posts", none.cookie, {
				title: `Draft ${id}`,
				isPublished: false,
			});
			expect(draft.status).toBe(201);
			const { post } = await draft.json();

			const publishNow = await send("POST", "/api/content/posts", none.cookie, {
				title: `Straight out ${id}`,
				isPublished: true,
			});
			expect(publishNow.status).toBe(409);
			expect((await publishNow.json()).code).toBe("payouts_required");

			const publish = await send("PATCH", `/api/content/posts/${post.slug}`, none.cookie, {
				isPublished: true,
			});
			expect(publish.status).toBe(409);
			const schedule = await send("PATCH", `/api/content/posts/${post.slug}`, none.cookie, {
				scheduledFor: tomorrow(),
			});
			expect(schedule.status).toBe(409);

			const [row] = await db
				.select({ isPublished: posts.isPublished, scheduledFor: posts.scheduledFor })
				.from(posts)
				.where(eq(posts.id, post.id));
			expect(row).toEqual({ isPublished: false, scheduledFor: null });
		});

		it("publishes a post for a creator whose payouts are ready", async () => {
			const res = await send("POST", "/api/content/posts", ready.cookie, {
				title: `Ready post ${id}`,
				isPublished: true,
			});
			expect(res.status).toBe(201);
		});

		it("keeps a live post editable after payouts lapse, because the editor resends isPublished", async () => {
			const res = await send("POST", "/api/content/posts", ready.cookie, {
				title: `Lapsing post ${id}`,
				isPublished: true,
			});
			const { post } = await res.json();
			await db
				.update(stripeAccounts)
				.set({ payoutsEnabled: false })
				.where(eq(stripeAccounts.userId, ready.userId));
			try {
				const edit = await send("PATCH", `/api/content/posts/${post.slug}`, ready.cookie, {
					title: `Lapsed post ${id}`,
					isPublished: true,
				});
				expect(edit.status).toBe(200);
			} finally {
				await enablePayoutsFor(ready.userId);
			}
		});

		it("clears the schedule on a draft whose creator's payouts lapsed before its date", async () => {
			const res = await send("POST", "/api/content/posts", ready.cookie, {
				title: `Scheduled ${id}`,
				isPublished: false,
				scheduledFor: tomorrow(),
			});
			expect(res.status).toBe(201);
			const { post } = await res.json();
			await db
				.update(stripeAccounts)
				.set({ payoutsEnabled: false })
				.where(eq(stripeAccounts.userId, ready.userId));
			try {
				// Due by moving the date rather than the clock, so nothing else in the shared
				// database that is not already due is published.
				await db
					.update(posts)
					.set({ scheduledFor: new Date(Date.now() - 60_000) })
					.where(eq(posts.id, post.id));
				await publishScheduled();
				const [row] = await db
					.select({ isPublished: posts.isPublished, scheduledFor: posts.scheduledFor })
					.from(posts)
					.where(eq(posts.id, post.id));
				expect(row).toEqual({ isPublished: false, scheduledFor: null });
			} finally {
				await enablePayoutsFor(ready.userId);
			}
		});

		it("lets anyone draft a project, and refuses publishing one without payouts", async () => {
			const draft = await send("POST", "/api/content/projects", none.cookie, {
				title: "Draft project",
				slug: `payproj-draft-${id}`,
				isPublished: false,
			});
			expect(draft.status).toBe(201);

			const publishNow = await send("POST", "/api/content/projects", none.cookie, {
				title: "Published project",
				slug: `payproj-live-${id}`,
				isPublished: true,
			});
			expect(publishNow.status).toBe(409);

			const publish = await send(
				"PATCH",
				`/api/content/projects/payproj-draft-${id}`,
				none.cookie,
				{
					isPublished: true,
				},
			);
			expect(publish.status).toBe(409);
			const [row] = await db
				.select({ isPublished: projects.isPublished })
				.from(projects)
				.where(eq(projects.slug, `payproj-draft-${id}`));
			expect(row.isPublished).toBe(false);
		});

		it("publishes a project for a creator whose payouts are ready", async () => {
			const res = await send("POST", "/api/content/projects", ready.cookie, {
				title: "Ready project",
				slug: `payproj-ready-${id}`,
				isPublished: true,
			});
			expect(res.status).toBe(201);
		});
	});
});
