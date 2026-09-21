// SPDX-License-Identifier: Apache-2.0
/**
 * A handle that moved keeps reaching the person who held it, for a while.
 *
 * The whole redirect mechanism has one writer pair and one reader, and this suite is the
 * only thing that exercises them together: `findUserByAtprotoDid` (a sign-in that finds a
 * DID under a new handle) and `recordHandleChange` (a swap the hub made itself) each write
 * a `handle_history` row, and `GET /users/:handle` falls through to it only when the live
 * lookup has found nothing. The order is the safety property: a name somebody new has
 * claimed resolves to them, and the stale row is never consulted.
 *
 * The expiry half is covered by writing a row whose hold is already over rather than by
 * moving dates around — the window's length is a decision, but the lapse is a mechanism.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { handleHistory, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { findUserByAtprotoDid, HANDLE_HOLD_DAYS } from "../services/atproto.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

/** The run tag, so fixture names and the handles they get stay unique to this run. */
const RUN = `hh${Date.now().toString(36)}`;

describe("an address whose owner renamed", () => {
	it("reaches the same account from the old handle, because the sign-in held it", async () => {
		const account = await createAccount(`redir_mover_${RUN}`, { identity: "brought" });
		const oldHandle = account.handle;
		const newHandle = `${RUN}moved.example.com`;

		// The OAuth reconcile is the writer under test: the DID turns up claiming a new
		// handle, and the account — not a new one — is what comes back.
		const reconciled = await findUserByAtprotoDid({
			did: account.did,
			handle: newHandle,
			pdsUrl: account.user.atprotoPdsUrl ?? "https://anthers.test",
		});
		expect(reconciled?.id).toBe(account.userId);

		const [user] = await db.select().from(users).where(eq(users.id, account.userId));
		expect(user.atprotoHandle).toBe(newHandle);

		// The old address was held at the moment it moved, for the hold window.
		const [held] = await db.select().from(handleHistory).where(eq(handleHistory.did, account.did));
		expect(held.oldHandle).toBe(oldHandle);
		const days = (held.holdUntil.getTime() - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(HANDLE_HOLD_DAYS);

		// Both addresses name the same account.
		const profile = async (h: string) => {
			const res = await app.request(`/api/accounts/users/${h}`);
			return res;
		};
		expect((await profile(newHandle)).status).toBe(200);
		const old = await profile(oldHandle);
		expect(old.status).toBe(200);
		expect(((await old.json()) as { user: { id: number } }).user.id).toBe(account.userId);
	});

	it("hands the address to its new owner the moment it is claimed, and the hold is never read", async () => {
		const first = await createAccount(`redir_first_${RUN}`, { identity: "brought" });
		const oldHandle = first.handle;
		// The first owner has moved on, and the old address is on record as theirs for a
		// while. The hold is written directly rather than through the reconcile, so the
		// shadowing is what is on trial here — a writer failure is covered by its own test
		// and must not masquerade as a shadowing failure.
		await db
			.update(users)
			.set({ atprotoHandle: `${RUN}first-moved.example.com` })
			.where(eq(users.id, first.userId));
		await db.insert(handleHistory).values({
			oldHandle,
			did: first.did,
			holdUntil: new Date(Date.now() + 86_400_000),
		});

		// The instant somebody new holds the address live, it is theirs. The redirect
		// table is consulted only on a miss, so nothing has to tear the hold down — the
		// live lookup winning is the shadowing, on its own.
		const second = await createAccount(`redir_second_${RUN}`, {
			identity: "brought",
		});
		await db.update(users).set({ atprotoHandle: oldHandle }).where(eq(users.id, second.userId));

		const res = await app.request(`/api/accounts/users/${oldHandle}`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { user: { id: number } }).user.id).toBe(second.userId);
	});

	it("stops routing once the hold has lapsed", async () => {
		const account = await createAccount(`redir_lapsed_${RUN}`, { identity: "brought" });
		const oldHandle = account.handle;
		await findUserByAtprotoDid({
			did: account.did,
			handle: `${RUN}lapsed.example.com`,
			pdsUrl: account.user.atprotoPdsUrl ?? "https://anthers.test",
		});

		// The lapse, simulated the honest way: the row says what it would say the day after
		// the window closed. Nothing travels in time.
		await db
			.update(handleHistory)
			.set({ holdUntil: new Date(Date.now() - 1000) })
			.where(eq(handleHistory.did, account.did));

		const res = await app.request(`/api/accounts/users/${oldHandle}`);
		expect(res.status).toBe(404);
	});

	it("holds nothing for a first sighting, only for a move", async () => {
		// The writer runs on reconcile; an identity seen for the first time has nothing to
		// have moved FROM, and a row would be a redirect from an address nobody ever had.
		const account = await createAccount(`redir_fresh_${RUN}`, { identity: "brought" });
		const rows = await db.select().from(handleHistory).where(eq(handleHistory.did, account.did));
		expect(rows).toHaveLength(0);
	});
});
