// SPDX-License-Identifier: Apache-2.0
/**
 * The card a shared profile is unfurled with.
 *
 * Three things this suite exists to keep true, none of which has another guard:
 *
 * 1. **A suspended account answers not-found, not a description of itself.** The profile
 *    page goes dark when an account is suspended; a card that still named the person would
 *    publish exactly what the page withholds, to an audience that never signed in.
 * 2. **A handle that moved resolves to the account it moved to**, because a profile shared
 *    under a name somebody later left must still point at its owner rather than 404.
 * 3. **A creator who wrote nothing still gets a card with a heading and a line**, since an
 *    account always has a handle to be named by.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { handleHistory, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { suspendAccount } from "../services/moderation";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;
function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const PORTRAIT = "https://cdn.anthers.org/creators/1/portrait-fixture.webp";

let account: { handle: string };
let bare: { handle: string };
/** The handle this account used to answer at, cleaned up below rather than by the purge. */
const OLD_HANDLE = `creator_card_old_${run}`;

beforeAll(async () => {
	account = await createAccount(`creator_card_${run}`, {
		fields: {
			isCreator: true,
			displayName: "A Card Fixture",
			bio: "Composing, drawing and building a garden.",
			avatar: PORTRAIT,
		},
	});
	bare = await createAccount(`creator_card_bare_${run}`, {
		fields: { isCreator: true, displayName: null, bio: null, avatar: null },
	});

	const [row] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.atprotoHandle, account.handle))
		.limit(1);
	await db.insert(handleHistory).values({
		oldHandle: OLD_HANDLE,
		did: row!.did,
		holdUntil: new Date(Date.now() + 60_000),
	});
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// `handle_history` keys on the DID rather than a row id, so it does not cascade with the
	// account the shared purge removes — this suite owns its row and takes it away itself.
	await db.delete(handleHistory).where(eq(handleHistory.oldHandle, OLD_HANDLE));
});

describe("GET /accounts/users/:handle/card", () => {
	it(
		"serves the creator's name, words and portrait",
		async () => {
			const res = await req(`/api/accounts/users/${account.handle}/card`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				preview: {
					title: "A Card Fixture",
					description: "Composing, drawing and building a garden.",
					image: PORTRAIT,
				},
			});
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"resolves a handle the account left to the account it belongs to",
		async () => {
			const res = await req(`/api/accounts/users/${OLD_HANDLE}/card`);
			expect(res.status).toBe(200);
			const { preview } = (await res.json()) as { preview: { title: string } };
			expect(preview.title).toBe("A Card Fixture");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"answers an account it does not have with the same 404 as the profile",
		async () => {
			expect((await req("/api/accounts/users/no_such_handle_here/card")).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a suspended account rather than describing it",
		async () => {
			const author = await createAccount(`creator_card_susp_${run}`, {
				fields: { isCreator: true, displayName: "Suspended Fixture" },
			});
			const operator = await createAdminFixture("creator-card-op");

			expect((await req(`/api/accounts/users/${author.handle}/card`)).status).toBe(200);
			await suspendAccount({
				userId: author.userId,
				adminId: operator.id,
				reason: "spam",
				note: "fixture",
			});
			expect((await req(`/api/accounts/users/${author.handle}/card`)).status).toBe(404);

			// Unsuspend so the purge is the only cleanup this fixture needs.
			await db.update(users).set({ suspendedAt: null }).where(eq(users.id, author.userId));
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"falls back to the handle and the platform sentence where the creator wrote neither",
		async () => {
			const res = await req(`/api/accounts/users/${bare.handle}/card`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				preview: {
					title: `@${bare.handle}`,
					description: "A profile on Anthers, a nonprofit creative garden for everyone.",
					image: null,
				},
			});
		},
		DB_SETUP_TIMEOUT,
	);
});
