// SPDX-License-Identifier: Apache-2.0
/**
 * Admin accounts, their sign-in codes and their sessions — the only writer of all four tables in
 * `packages/db/src/schema/admin.ts`.
 *
 * An admin account is an email identity with no password: it signs in with a code sent to its own
 * address, at the admin host, and nowhere else. Two doors change these rows and both come through
 * here, so they cannot leave different states behind: the admin app's Accounts section, acting as
 * a super-admin, and `scripts/admin-account.ts`, which Parker runs against a database directly
 * and which is how the first account exists and how a locked-out team gets back in.
 *
 * 🚨 **There is always at least one active super-admin once one exists.** Deactivating or demoting
 * the last one is refused here rather than in either door, because the Accounts section is the
 * only place accounts are managed from inside the app and an app with no super-admin could never
 * manage one again without the script.
 */
import { db } from "@anthers/db/client";
import {
	adminAccountEvents,
	adminAccounts,
	adminSessions,
	adminSignInCodes,
} from "@anthers/db/schema";
import { and, desc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { generateToken, hashPassword } from "./auth.js";
import {
	type CodeCheck,
	deleteExpiredEmailedCodes,
	generateSignupCode,
	mintEmailedCode,
	normalizeEmail,
	spendEmailedCode,
} from "./signup-codes.js";

/**
 * How long an admin sign-in lasts: one working day.
 *
 * Far shorter than an Anthers session's thirty days, because what this session opens is the legal
 * queues and every account on the platform, and signing in again costs one emailed code.
 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Every kind of change `admin_account_events` records. */
export const ADMIN_ACCOUNT_EVENT_KINDS = [
	"created",
	"deactivated",
	"reactivated",
	"email_changed",
	"super_admin_granted",
	"super_admin_revoked",
] as const;
export type AdminAccountEventKind = (typeof ADMIN_ACCOUNT_EVENT_KINDS)[number];

export type AdminAccount = typeof adminAccounts.$inferSelect;

/** Why an account change was refused, for a door to turn into its own words. */
export type AdminAccountRefusal =
	| "not_found"
	| "email_taken"
	| "last_super_admin"
	| "already_in_that_state";

export class AdminAccountError extends Error {
	constructor(readonly reason: AdminAccountRefusal) {
		super(reason);
		this.name = "AdminAccountError";
	}
}

/**
 * Who made a change: a super-admin's account id, or null for the recovery script.
 *
 * Deliberately not optional. A caller has to say which it is, because a change recorded with no
 * actor reads as *somebody with database access ran the script*, and that must never be the
 * accidental result of forgetting to pass one.
 */
export type AdminActor = number | null;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function recordEvent(
	tx: Tx,
	accountId: number,
	actorId: AdminActor,
	kind: AdminAccountEventKind,
	detail: Record<string, unknown> | null = null,
): Promise<void> {
	await tx.insert(adminAccountEvents).values({ accountId, actorId, kind, detail });
}

/**
 * Lock every active super-admin row and refuse if `accountId` is the only one.
 *
 * `FOR UPDATE` rather than a count, so two super-admins demoting each other at the same moment
 * cannot both pass the check and leave nobody.
 */
async function refuseIfLastSuperAdmin(tx: Tx, accountId: number): Promise<void> {
	const supers = await tx
		.select({ id: adminAccounts.id })
		.from(adminAccounts)
		.where(and(eq(adminAccounts.isSuperAdmin, true), isNull(adminAccounts.deactivatedAt)))
		.for("update");
	if (supers.length === 1 && supers[0].id === accountId) {
		throw new AdminAccountError("last_super_admin");
	}
}

async function lockAccount(tx: Tx, accountId: number): Promise<AdminAccount> {
	const [account] = await tx
		.select()
		.from(adminAccounts)
		.where(eq(adminAccounts.id, accountId))
		.for("update");
	if (!account) throw new AdminAccountError("not_found");
	return account;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

/** Create an admin account. Inviting from the app and the recovery script both arrive here. */
export async function createAdminAccount(
	input: { email: string; displayName: string; isSuperAdmin?: boolean },
	actorId: AdminActor,
): Promise<AdminAccount> {
	const email = normalizeEmail(input.email);
	return db.transaction(async (tx) => {
		const [taken] = await tx
			.select({ id: adminAccounts.id })
			.from(adminAccounts)
			.where(eq(adminAccounts.email, email))
			.limit(1);
		if (taken) throw new AdminAccountError("email_taken");

		const [account] = await tx
			.insert(adminAccounts)
			.values({
				email,
				displayName: input.displayName.trim(),
				isSuperAdmin: input.isSuperAdmin ?? false,
			})
			.returning();
		await recordEvent(tx, account.id, actorId, "created", {
			email,
			isSuperAdmin: account.isSuperAdmin,
		});
		return account;
	});
}

export async function findAdminAccountByEmail(rawEmail: string): Promise<AdminAccount | null> {
	const [account] = await db
		.select()
		.from(adminAccounts)
		.where(eq(adminAccounts.email, normalizeEmail(rawEmail)))
		.limit(1);
	return account ?? null;
}

export async function listAdminAccounts(): Promise<AdminAccount[]> {
	return db.select().from(adminAccounts).orderBy(adminAccounts.createdAt);
}

/** Grant or revoke super-admin. Revoking the last active super-admin is refused. */
export async function setSuperAdmin(
	accountId: number,
	isSuperAdmin: boolean,
	actorId: AdminActor,
): Promise<AdminAccount> {
	return db.transaction(async (tx) => {
		const account = await lockAccount(tx, accountId);
		if (account.isSuperAdmin === isSuperAdmin) throw new AdminAccountError("already_in_that_state");
		if (!isSuperAdmin && account.deactivatedAt === null) {
			await refuseIfLastSuperAdmin(tx, accountId);
		}
		const [updated] = await tx
			.update(adminAccounts)
			.set({ isSuperAdmin })
			.where(eq(adminAccounts.id, accountId))
			.returning();
		await recordEvent(
			tx,
			accountId,
			actorId,
			isSuperAdmin ? "super_admin_granted" : "super_admin_revoked",
		);
		return updated;
	});
}

/**
 * Deactivate an account, ending every session it holds. Deactivating the last active super-admin
 * is refused.
 */
export async function deactivateAdminAccount(
	accountId: number,
	actorId: AdminActor,
): Promise<AdminAccount> {
	return db.transaction(async (tx) => {
		const account = await lockAccount(tx, accountId);
		if (account.deactivatedAt !== null) throw new AdminAccountError("already_in_that_state");
		if (account.isSuperAdmin) await refuseIfLastSuperAdmin(tx, accountId);

		const [updated] = await tx
			.update(adminAccounts)
			.set({ deactivatedAt: new Date() })
			.where(eq(adminAccounts.id, accountId))
			.returning();
		// Ended rather than left to expire. `validateAdminSession` already refuses a deactivated
		// account, so this is not what locks them out — it is what stops a reactivation restoring
		// a session that was live when the account was switched off.
		await tx.delete(adminSessions).where(eq(adminSessions.accountId, accountId));
		await tx.delete(adminSignInCodes).where(eq(adminSignInCodes.email, account.email));
		await recordEvent(tx, accountId, actorId, "deactivated");
		return updated;
	});
}

export async function reactivateAdminAccount(
	accountId: number,
	actorId: AdminActor,
): Promise<AdminAccount> {
	return db.transaction(async (tx) => {
		const account = await lockAccount(tx, accountId);
		if (account.deactivatedAt === null) throw new AdminAccountError("already_in_that_state");
		const [updated] = await tx
			.update(adminAccounts)
			.set({ deactivatedAt: null })
			.where(eq(adminAccounts.id, accountId))
			.returning();
		await recordEvent(tx, accountId, actorId, "reactivated");
		return updated;
	});
}

/**
 * Change the address an account signs in with.
 *
 * 🚨 **This moves the credential**, since the mailbox is the account, so every session and any
 * live code are ended with it: they were proved by the old mailbox, and whoever held that mailbox
 * is exactly who an address change may be trying to shut out.
 */
export async function changeAdminEmail(
	accountId: number,
	rawNewEmail: string,
	actorId: AdminActor,
): Promise<AdminAccount> {
	const email = normalizeEmail(rawNewEmail);
	return db.transaction(async (tx) => {
		const account = await lockAccount(tx, accountId);
		if (account.email === email) throw new AdminAccountError("already_in_that_state");
		const [taken] = await tx
			.select({ id: adminAccounts.id })
			.from(adminAccounts)
			.where(and(eq(adminAccounts.email, email), ne(adminAccounts.id, accountId)))
			.limit(1);
		if (taken) throw new AdminAccountError("email_taken");

		const [updated] = await tx
			.update(adminAccounts)
			.set({ email })
			.where(eq(adminAccounts.id, accountId))
			.returning();
		await tx.delete(adminSessions).where(eq(adminSessions.accountId, accountId));
		await tx.delete(adminSignInCodes).where(eq(adminSignInCodes.email, account.email));
		await recordEvent(tx, accountId, actorId, "email_changed", { from: account.email, to: email });
		return updated;
	});
}

// ─── Sign-in codes ───────────────────────────────────────────────────────────

/**
 * Mint a sign-in code, but only for the address of an active admin account.
 *
 * The same shape as `issueSignInCode` on the main site, for the same reasons: an unknown or
 * deactivated address gets no row, so nothing is left live and no throttle starts, and the miss
 * does the same argon2 work as the hit so the two cannot be told apart by timing. The route
 * answers identically either way.
 */
export async function issueAdminSignInCode(
	rawEmail: string,
	now = new Date(),
): Promise<{ code: string | null; throttled: boolean }> {
	const account = await findAdminAccountByEmail(rawEmail);
	if (!account || account.deactivatedAt !== null) {
		await hashPassword(generateSignupCode());
		return { code: null, throttled: false };
	}
	return mintEmailedCode(adminSignInCodes, account.email, now);
}

/**
 * Spend a sign-in code, and answer with the account it signs into.
 *
 * The account is read after the code is spent rather than before, so an account deactivated
 * between the email and the typing does not sign in on a code it was issued while active.
 */
export async function checkAdminSignInCode(
	rawEmail: string,
	rawCode: string,
	now = new Date(),
): Promise<CodeCheck & { account?: AdminAccount }> {
	const result = await spendEmailedCode(adminSignInCodes, rawEmail, rawCode, now);
	if (!result.ok) return result;
	const account = await findAdminAccountByEmail(result.email);
	if (!account || account.deactivatedAt !== null) return { ok: false, reason: "no_code" };
	return { ...result, account };
}

export function deleteExpiredAdminSignInCodes(now = new Date()): Promise<number> {
	return deleteExpiredEmailedCodes(adminSignInCodes, now);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** SHA-256 of a session token, which is all `admin_sessions` ever holds. */
export function hashAdminSessionToken(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Start a session. Returns the token, which exists only in the cookie from here on. */
export async function createAdminSession(
	accountId: number,
	ipAddress?: string | null,
	userAgent?: string | null,
	now = new Date(),
): Promise<string> {
	const token = generateToken();
	await db.insert(adminSessions).values({
		tokenHash: hashAdminSessionToken(token),
		accountId,
		ipAddress: ipAddress ?? null,
		userAgent: userAgent ?? null,
		expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS),
	});
	return token;
}

/** The active account a token signs in as, or null for anything expired, unknown or deactivated. */
export async function validateAdminSession(
	token: string,
	now = new Date(),
): Promise<AdminAccount | null> {
	const [row] = await db
		.select({ account: adminAccounts })
		.from(adminSessions)
		.innerJoin(adminAccounts, eq(adminSessions.accountId, adminAccounts.id))
		.where(
			and(
				eq(adminSessions.tokenHash, hashAdminSessionToken(token)),
				gt(adminSessions.expiresAt, now),
				isNull(adminAccounts.deactivatedAt),
			),
		)
		.limit(1);
	return row?.account ?? null;
}

export async function deleteAdminSession(token: string): Promise<void> {
	await db.delete(adminSessions).where(eq(adminSessions.tokenHash, hashAdminSessionToken(token)));
}

/** Drop expired sessions. Returns the count, so a test can assert on rows removed. */
export async function deleteExpiredAdminSessions(now = new Date()): Promise<number> {
	const gone = await db
		.delete(adminSessions)
		.where(lt(adminSessions.expiresAt, now))
		.returning({ id: adminSessions.id });
	return gone.length;
}

/** The most recent changes to admin accounts, newest first, with both parties named. */
export async function listAdminAccountEvents(limit = 50) {
	const subject = alias(adminAccounts, "subject");
	const actor = alias(adminAccounts, "actor");
	const rows = await db
		.select({
			id: adminAccountEvents.id,
			kind: adminAccountEvents.kind,
			detail: adminAccountEvents.detail,
			createdAt: adminAccountEvents.createdAt,
			account: subject.displayName,
			actor: actor.displayName,
		})
		.from(adminAccountEvents)
		.innerJoin(subject, eq(subject.id, adminAccountEvents.accountId))
		.leftJoin(actor, eq(actor.id, adminAccountEvents.actorId))
		.orderBy(desc(adminAccountEvents.createdAt))
		.limit(limit);
	return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** The shape an admin account is sent to the admin app in. */
export function serializeAdminAccount(account: AdminAccount) {
	return {
		id: account.id,
		email: account.email,
		displayName: account.displayName,
		isSuperAdmin: account.isSuperAdmin,
	};
}

/** The fuller shape the Accounts section lists, which includes an account's state. */
export function serializeAdminAccountListing(account: AdminAccount) {
	return {
		...serializeAdminAccount(account),
		deactivatedAt: account.deactivatedAt?.toISOString() ?? null,
		createdAt: account.createdAt.toISOString(),
	};
}
