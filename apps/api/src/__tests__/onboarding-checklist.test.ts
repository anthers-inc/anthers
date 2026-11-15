// SPDX-License-Identifier: Apache-2.0
/**
 * The two onboarding checklists' server half: the facts their rows derive from, and the
 * act that puts each card away.
 *
 * 🚨 **The rule this suite pins is that a row is answered by the thing itself.** The
 * subtlest case is `saved`: a creator's own Works join the Library at creation, so a
 * count of every Library row would check the reader's "save something" for an account
 * that has only ever made something. The exclusion is `workOwnedBy`, the same predicate
 * the Works page lists by.
 *
 * ⚠️ **Both serializers carry the dismissal timestamps.** `GET /accounts/me` keeps the
 * Settings page honest and `/auth/me` is the shell's boot read, which is the one Discovery
 * and the Studio actually draw from; a timestamp that rode one and not the other would
 * bring a dismissed card back on the next page load.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts } from "@anthers/db/schema";
import app from "../index";
import { ensureFollow } from "../services/follows";
import { saveOwnWork, savePost, saveWork } from "../services/library";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const RUN = `onboard${Date.now().toString(36)}`;
let account: FixtureAccount;

beforeAll(async () => {
	account = await createAccount(RUN);
});

async function facts(c = account.cookie) {
	const res = await req("/api/accounts/me/onboarding", { headers: { Cookie: c } });
	return res.json();
}

function dismiss(body: unknown, c = account.cookie) {
	return req("/api/accounts/me/onboarding/dismiss", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: c },
		body: JSON.stringify(body),
	});
}

describe("the onboarding facts", () => {
	it("starts every count at zero", async () => {
		const fresh = await createAccount(`fresh${Date.now().toString(36)}`);
		expect(await facts(fresh.cookie)).toEqual({
			following: 0,
			saved: 0,
			works: 0,
			releasedWorks: 0,
			posts: 0,
			badges: 0,
		});
	});

	it("counts a follow and a save, and nothing else yet", async () => {
		const creator = await createAccount(`maker${Date.now().toString(36)}`);
		await ensureFollow(account.userId, creator.userId);
		const work = await insertWork({ creatorId: creator.userId, type: "video" });
		await saveWork(account.userId, work.id);

		const answered = await facts();
		expect(answered.following).toBe(1);
		expect(answered.saved).toBe(1);
		expect(answered.works).toBe(0);
	});

	// The subtle one. A creator's own Work arrives in their Library on creation, so the
	// reader's row must not read that as a save.
	it("does not count a creator's own Work as something saved", async () => {
		const creator = await createAccount(`selfsave${Date.now().toString(36)}`);
		const own = await insertWork({ creatorId: creator.userId, type: "image" });
		await saveOwnWork(creator.userId, own.id);

		const answered = await facts(creator.cookie);
		expect(answered.works).toBe(1);
		expect(answered.releasedWorks).toBe(1);
		expect(answered.saved).toBe(0);
	});

	// The other side of the same clause: a Library row with no Work is a Post or a
	// Project, and only a save puts one there.
	it("counts a saved post", async () => {
		const author = await createAccount(`author${Date.now().toString(36)}`);
		const reader = await createAccount(`keeper${Date.now().toString(36)}`);
		const [post] = await db
			.insert(posts)
			.values({
				creatorId: author.userId,
				publicId: Math.floor(Math.random() * 1_000_000) + 1,
				slug: `onboarding-post-${Date.now().toString(36)}`,
				title: "A post worth keeping",
			})
			.returning({ id: posts.id });
		await savePost(reader.userId, post.id);

		const answered = await facts(reader.cookie);
		expect(answered.saved).toBe(1);
		expect(answered.works).toBe(0);
	});
});

describe("dismissing a checklist", () => {
	it("records the reader's and leaves the creator's alone", async () => {
		const reader = await createAccount(`dismiss${Date.now().toString(36)}`);
		const res = await dismiss({ checklist: "reader" }, reader.cookie);
		expect(res.status).toBe(200);

		const me = await (await req("/api/accounts/me", { headers: { Cookie: reader.cookie } })).json();
		expect(typeof me.user.readerChecklistDismissedAt).toBe("string");
		expect(me.user.creatorChecklistDismissedAt).toBeNull();

		// The boot read the pages actually draw from.
		const boot = await (await req("/api/auth/me", { headers: { Cookie: reader.cookie } })).json();
		expect(typeof boot.user.readerChecklistDismissedAt).toBe("string");
		expect(boot.user.creatorChecklistDismissedAt).toBeNull();
	});

	it("records the creator's independently", async () => {
		const creator = await createAccount(`firststeps${Date.now().toString(36)}`);
		expect((await dismiss({ checklist: "creator" }, creator.cookie)).status).toBe(200);

		const me = await (
			await req("/api/accounts/me", { headers: { Cookie: creator.cookie } })
		).json();
		expect(typeof me.user.creatorChecklistDismissedAt).toBe("string");
		expect(me.user.readerChecklistDismissedAt).toBeNull();
	});

	it("refuses a checklist it does not have", async () => {
		expect((await dismiss({ checklist: "everything" })).status).toBe(400);
		expect((await dismiss({})).status).toBe(400);
	});

	it("is a signed-in act", async () => {
		const res = await req("/api/accounts/me/onboarding/dismiss", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ checklist: "reader" }),
		});
		expect(res.status).toBe(401);
	});
});
