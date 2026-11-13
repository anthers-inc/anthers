// SPDX-License-Identifier: Apache-2.0
/**
 * The users directory: every account is listed, the ways an operator names one find it, and
 * a page says what it is showing.
 *
 * 🚨 **The counterpart to `admin-people.test.ts`'s first case is the point of this file.** A
 * quiet account is absent from the moderation list and present here — the two surfaces answer
 * different questions, and a directory folded into the moderation list would invite acting on
 * somebody nobody complained about. This suite holds the directory half of that pair.
 *
 * It also guards the creator answer. `creatorMode` is a self-serve switch, not standing, so a
 * mode-on account must not read as a creator until payout setup is complete; a directory that
 * got this wrong would repeat the mistake `services/creator-standing.ts` exists to stop.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);

interface DirectoryBody {
	users: {
		id: number;
		handle: string;
		displayName: string;
		email: string;
		emailVerified: boolean;
		creatorMode: boolean;
		isCreator: boolean;
		suspendedAt: string | null;
		suspendedUntil: string | null;
		deletionRequestedAt: string | null;
		createdAt: string;
	}[];
	page: number;
	pageSize: number;
	total: number;
	hasMore: boolean;
}

describe("Admin users directory", () => {
	let adminCookie: string;
	/** An ordinary account with no reports and no suspension — the directory-line fixture. */
	let quiet: FixtureAccount;
	/** An account with creator standing: the switch on and payout setup complete. */
	let creator: FixtureAccount;
	/** The switch on without payout setup — a creator only in intention, not in standing. */
	let modeOnly: FixtureAccount;
	/** A suspended account, which the directory lists like any other rather than hiding. */
	let suspended: FixtureAccount;

	beforeAll(async () => {
		adminCookie = (await createAdminFixture("users-directory")).cookie;

		quiet = await createAccount(`udir_quiet_${run}`, {
			emailVerified: true,
			fields: { displayName: "Quiet Directory Person" },
		});

		creator = await createAccount(`udir_creator_${run}`);
		await enablePayoutsFor(creator.userId);

		modeOnly = await createAccount(`udir_mode_${run}`, { fields: { creatorMode: true } });

		suspended = await createAccount(`udir_suspended_${run}`);
		const { suspendAccount } = await import("../services/moderation.js");
		const operator = await createAdminFixture("users-directory-suspend");
		await suspendAccount({
			userId: suspended.userId,
			adminId: operator.id,
			reason: "spam",
			note: `directory fixture ${run}`,
		});
	}, DB_SETUP_TIMEOUT);

	it("answers 401 without an admin session", async () => {
		const res = await req("/api/admin/users");
		expect(res.status).toBe(401);
	});

	it("lists every account, newest first, with the basic columns", async () => {
		const res = await req("/api/admin/users", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as DirectoryBody;

		expect(body.page).toBe(0);
		expect(body.pageSize).toBe(50);
		expect(body.total).toBeGreaterThanOrEqual(3);

		const ids = body.users.map((u) => u.id);
		expect(ids).toContain(quiet.userId);
		expect(ids).toContain(creator.userId);
		expect(ids).toContain(suspended.userId);

		const quietRow = body.users.find((u) => u.id === quiet.userId)!;
		expect(quietRow.handle).toBe(quiet.handle);
		expect(quietRow.email).toBe(quiet.email);
		expect(quietRow.displayName).toBe("Quiet Directory Person");
		expect(quietRow.emailVerified).toBe(true);
		expect(quietRow.creatorMode).toBe(false);
		expect(quietRow.isCreator).toBe(false);
		expect(quietRow.suspendedAt).toBeNull();
		expect(typeof quietRow.createdAt).toBe("string");
	});

	it("tells creator standing apart from the creator-mode switch", async () => {
		const standing = await req(`/api/admin/users?q=${encodeURIComponent(`udir_creator_${run}`)}`, {
			headers: { Cookie: adminCookie },
		});
		const standingRow = ((await standing.json()) as DirectoryBody).users.find(
			(u) => u.id === creator.userId,
		)!;
		expect(standingRow.creatorMode).toBe(true);
		expect(standingRow.isCreator).toBe(true);

		const intention = await req(`/api/admin/users?q=${encodeURIComponent(`udir_mode_${run}`)}`, {
			headers: { Cookie: adminCookie },
		});
		const modeRow = ((await intention.json()) as DirectoryBody).users.find(
			(u) => u.id === modeOnly.userId,
		)!;
		expect(modeRow.creatorMode).toBe(true);
		expect(modeRow.isCreator).toBe(false);
	});

	it("lists a suspended account with its state rather than hiding it", async () => {
		const res = await req(`/api/admin/users?q=${encodeURIComponent(`udir_suspended_${run}`)}`, {
			headers: { Cookie: adminCookie },
		});
		const body = (await res.json()) as DirectoryBody;
		const row = body.users.find((u) => u.id === suspended.userId)!;
		expect(row.suspendedAt).not.toBeNull();
		expect(row.suspendedUntil).toBeNull();
	});

	it("finds an account by handle, email address, display name, and account number", async () => {
		for (const query of [
			quiet.handle,
			// A handle is written with its @, so a pasted one has to work too.
			`@${quiet.handle}`,
			quiet.email,
			"Quiet Directory Person",
			String(quiet.userId),
		]) {
			const res = await req(`/api/admin/users?q=${encodeURIComponent(query)}`, {
				headers: { Cookie: adminCookie },
			});
			expect(res.status, query).toBe(200);
			const body = (await res.json()) as DirectoryBody;
			expect(
				body.users.map((u) => u.id),
				query,
			).toContain(quiet.userId);
		}
	});

	it("answers an empty page for a search that matches nobody", async () => {
		const res = await req(`/api/admin/users?q=${encodeURIComponent(`zzzz-nobody-${run}`)}`, {
			headers: { Cookie: adminCookie },
		});
		const body = (await res.json()) as DirectoryBody;
		expect(body.users).toEqual([]);
		expect(body.total).toBe(0);
		expect(body.hasMore).toBe(false);
	});

	it("pages past the table rather than wrapping around to it", async () => {
		const res = await req("/api/admin/users?page=9999", { headers: { Cookie: adminCookie } });
		const body = (await res.json()) as DirectoryBody;
		expect(body.users).toEqual([]);
		expect(body.total).toBeGreaterThanOrEqual(3);
		expect(body.page).toBe(9999);
	});
});
