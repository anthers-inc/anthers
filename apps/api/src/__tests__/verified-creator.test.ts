// SPDX-License-Identifier: Apache-2.0
/**
 * Verified creator standing at the API boundary — `isCreator` plus a released Work.
 *
 * The shared predicate's truth table is `packages/shared/src/verified-creator.test.ts`'s.
 * What needs real rows is the half this file pins: **which Works count**. `works.released_at`
 * is the marker rather than `visibility = 'released'`, so a withdrawn Work still verifies its
 * creator — withdrawing is not un-making the thing, and the buyers may still hold it. A post
 * never counts, however published it is.
 *
 * Both serializers are asserted on every case, because the field's reason to exist is the
 * shell's boot read (`/auth/me`) as much as the account's own (`/accounts/me`): a surface that
 * gates on creator standing reads the payload the client already has.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork, testPublicId } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `verified${Date.now().toString(36)}`;

function get(path: string, cookie: string) {
	return app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }));
}

/** Both payloads the standing rides, read together so one cannot drift from the other. */
async function standing(account: FixtureAccount) {
	const [me, auth] = await Promise.all([
		(await get("/api/accounts/me", account.cookie)).json(),
		(await get("/api/auth/me", account.cookie)).json(),
	]);
	return { me: me.user.isVerifiedCreator, auth: auth.user.isVerifiedCreator };
}

let creatorWithNothing: FixtureAccount;
let creatorWithReleased: FixtureAccount;
let creatorWithdrawn: FixtureAccount;
let creatorPostOnly: FixtureAccount;
let notCreatorWithWork: FixtureAccount;

beforeAll(async () => {
	creatorWithNothing = await createAccount(`${RUN}nothing`, { fields: { isCreator: true } });
	creatorWithReleased = await createAccount(`${RUN}released`, { fields: { isCreator: true } });
	creatorWithdrawn = await createAccount(`${RUN}withdrawn`, { fields: { isCreator: true } });
	creatorPostOnly = await createAccount(`${RUN}posts`, { fields: { isCreator: true } });
	notCreatorWithWork = await createAccount(`${RUN}notcreator`);

	await insertWork({ creatorId: creatorWithReleased.userId, type: "text" });

	const withdrawn = await insertWork({ creatorId: creatorWithdrawn.userId, type: "text" });
	await db
		.update(works)
		.set({ visibility: "withdrawn", withdrawnAt: new Date() })
		.where(eq(works.id, withdrawn.id));

	await db.insert(posts).values({
		creatorId: creatorPostOnly.userId,
		publicId: testPublicId(),
		slug: `verified-post-${testPublicId()}`,
		title: "An announcement",
		body: "Not a Work.",
		isPublished: true,
		publishedAt: new Date(),
	});

	await insertWork({ creatorId: notCreatorWithWork.userId, type: "text" });
});

describe("verified creator standing", () => {
	it("is false for a creator who has released nothing", async () => {
		expect(await standing(creatorWithNothing)).toEqual({ me: false, auth: false });
	});

	it("is true once the creator has one released Work", async () => {
		expect(await standing(creatorWithReleased)).toEqual({ me: true, auth: true });
	});

	it("stays true for a creator whose only released Work was withdrawn", async () => {
		expect(await standing(creatorWithdrawn)).toEqual({ me: true, auth: true });
	});

	it("is false for a creator who has only published a post", async () => {
		expect(await standing(creatorPostOnly)).toEqual({ me: false, auth: false });
	});

	it("is false with creator mode off, even with a released Work on the account", async () => {
		expect(await standing(notCreatorWithWork)).toEqual({ me: false, auth: false });
	});
});
