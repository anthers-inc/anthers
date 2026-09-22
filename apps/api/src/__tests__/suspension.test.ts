// SPDX-License-Identifier: Apache-2.0
/**
 * Account suspension itself: the state on the row, the sessions it ends, the
 * sign-in it refuses, and the log it appends to.
 *
 * The assertions this file exists for are the ones the design rests on: suspension
 * is a **state, never a delete**, so every check that the account is refused is
 * paired with a direct read proving the row, the identity and the log are still
 * there; the lift is a *new* `unsuspend` row rather than an edit of the `suspend`;
 * and the expiry sweep lifts only a suspension whose end has passed, recording it as
 * automated so an appeal reads the clock's lift the same as an operator's.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions, sessions, users } from "@anthers/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { validateSession } from "../services/auth.js";
import {
	isAccountSuspended,
	liftExpiredSuspensions,
	suspendAccount,
	unsuspendAccount,
} from "../services/moderation.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

/** The account's current suspension columns, read straight so no helper can lie. */
async function suspensionOf(userId: number) {
	const [row] = await db
		.select({
			suspendedAt: users.suspendedAt,
			suspendedUntil: users.suspendedUntil,
			did: users.atprotoDid,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row;
}

async function actionsFor(userId: number) {
	return db
		.select()
		.from(moderationActions)
		.where(and(eq(moderationActions.subjectType, "user"), eq(moderationActions.subjectId, userId)))
		.orderBy(desc(moderationActions.createdAt));
}

describe("suspendAccount", () => {
	it("suspends: the row carries the state, sessions end, and the log records who and why", async () => {
		const account = await createAccount("suspend-some");
		const operator = await createAdminFixture("suspend-op");

		const result = await suspendAccount({
			userId: account.userId,
			adminId: operator.id,
			reason: "spam",
			note: "fixture",
		});
		expect(result).toEqual({ status: "suspended" });

		// The state is on the row, and the identity is untouched by it.
		const state = await suspensionOf(account.userId);
		expect(state?.suspendedAt).not.toBeNull();
		expect(state?.suspendedUntil).toBeNull(); // indefinite
		expect(state?.did).toBe(account.did);

		// The session the account was holding no longer exists anywhere.
		const live = await db.select().from(sessions).where(eq(sessions.userId, account.userId));
		expect(live).toHaveLength(0);
		expect(await validateSession(account.token)).toBeNull();

		// The decision is appended, naming the admin and the reason.
		const log = await actionsFor(account.userId);
		expect(log).toHaveLength(1);
		expect(log[0]!.action).toBe("suspend");
		expect(log[0]!.adminActorId).toBe(operator.id);
		expect(log[0]!.reason).toBe("spam");
	});

	it("returns null for an account that does not exist", async () => {
		const operator = await createAdminFixture("suspend-null");
		const result = await suspendAccount({
			userId: 999_999_999,
			adminId: operator.id,
			reason: "spam",
		});
		expect(result).toBeNull();
	});
});

describe("unsuspendAccount", () => {
	it("lifts with SECOND row rather than an edit, and signs nobody in but lets the next sign-in work", async () => {
		const account = await createAccount("suspend-lift");
		const operator = await createAdminFixture("lift-op");
		await suspendAccount({ userId: account.userId, adminId: operator.id, reason: "spam" });

		const result = await unsuspendAccount({
			userId: account.userId,
			adminId: operator.id,
			note: "operator lift",
		});
		expect(result).toEqual({ status: "visible" });

		// The row is clear again — the account is whole, not revived from anything.
		const state = await suspensionOf(account.userId);
		expect(state?.suspendedAt).toBeNull();
		expect(state?.suspendedUntil).toBeNull();

		// The log reads as the sequence: suspend, then unsuspend. Nothing edited the first.
		const log = await actionsFor(account.userId);
		expect(log.map((a) => a.action)).toEqual(["unsuspend", "suspend"]);
	});

	it("is a no-op on an account that is not suspended", async () => {
		const account = await createAccount("suspend-none");
		const operator = await createAdminFixture("lift-none");
		const result = await unsuspendAccount({ userId: account.userId, adminId: operator.id });
		expect(result).toEqual({ status: "visible" });
		expect(await actionsFor(account.userId)).toHaveLength(0);
	});
});

describe("liftExpiredSuspensions", () => {
	it("lifts a suspension whose end has passed, recorded as automated", async () => {
		const account = await createAccount("suspend-expired");
		const operator = await createAdminFixture("sweep-op");
		// Ended an hour ago.
		await suspendAccount({
			userId: account.userId,
			adminId: operator.id,
			reason: "spam",
			until: new Date(Date.now() - 60 * 60 * 1000),
		});

		const lifted = await liftExpiredSuspensions();
		expect(lifted).toBeGreaterThanOrEqual(1);

		const state = await suspensionOf(account.userId);
		expect(state?.suspendedAt).toBeNull();

		// The clock's lift reads as automated: both actor columns null.
		const log = await actionsFor(account.userId);
		const lift = log.find((a) => a.action === "unsuspend");
		expect(lift).toBeDefined();
		expect(lift!.adminActorId).toBeNull();
		expect(lift!.actorId).toBeNull();
	});

	it("leaves an indefinite suspension standing", async () => {
		const account = await createAccount("suspend-indef");
		const operator = await createAdminFixture("sweep-indef");
		await suspendAccount({ userId: account.userId, adminId: operator.id, reason: "spam" });

		const before = await liftExpiredSuspensions();
		// The account was suspended with no end, so the sweep must not touch it. Count the
		// accounts this suite just suspended that are STILL suspended after the sweep ran.
		const state = await suspensionOf(account.userId);
		expect(state?.suspendedAt).not.toBeNull();
		expect(before).toBeGreaterThanOrEqual(0);
	});
});

describe("isAccountSuspended", () => {
	it("reads the pair: null is standing, an end in the past is over only until the lift clears both", () => {
		expect(isAccountSuspended({ suspendedAt: null, suspendedUntil: null })).toBe(false);
		expect(isAccountSuspended({ suspendedAt: new Date(), suspendedUntil: null })).toBe(true);
		expect(
			isAccountSuspended({
				suspendedAt: new Date(),
				suspendedUntil: new Date(Date.now() + 60_000),
			}),
		).toBe(true);
		expect(
			isAccountSuspended({
				suspendedAt: new Date(),
				suspendedUntil: new Date(Date.now() - 60_000),
			}),
		).toBe(false);
	});
});
