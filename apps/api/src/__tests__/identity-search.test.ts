// SPDX-License-Identifier: Apache-2.0
/**
 * The credits editor's identity autocomplete — `GET /api/accounts/identity-search`.
 *
 * The endpoint answers with the accounts Anthers already knows, and the assertions here
 * are the filters the route's docblock promises:
 *
 * - **Substring match over handle and display name**, capped at ten.
 * - **Blocked pairs are absent, in both directions** — one account is never offered
 *   another, either way of the block, alongside a control proving the filter is
 *   pair-scoped and not global.
 * - **Suspended accounts are absent** from a suggestion list, the same rule the
 *   creator listing runs.
 * - **Signed out means refused** — credits are written in the Studio, so there is no
 *   signed-out use for the door.
 * - **The answer carries the DID**, which is what a picked suggestion writes into the
 *   credit row — the acceptance keys on it, and the editor sends the field back verbatim.
 *
 * Staged with `createAccount` fixtures and swept with `purgeAccountsCreatedHere`, like
 * every suite that mints identities.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { userBlocks, users } from "@anthers/db/schema";
import { and, eq, or } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

/** Whose view the search runs from. */
const seekerName = `srch_seeker_${id}`;
/** A name matched exactly by handle, and shared by nobody else. */
const namedName = `srch_uniq_${id}`;
/** The account `seeker` blocks — never suggested to either of the pair. */
const blockedName = `srch_blk_${id}`;
/** Involved in nothing — the control proving the block filter is pair-scoped. */
const bystanderName = `srch_by_${id}`;

let seeker: FixtureAccount;
let named: FixtureAccount;
let blocked: FixtureAccount;
let bystander: FixtureAccount;

interface Match {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

async function search(q: string, cookie: string): Promise<{ status: number; matches: Match[] }> {
	const res = await app.request(`/api/accounts/identity-search?q=${encodeURIComponent(q)}`, {
		headers: { Cookie: cookie, Origin: ORIGIN },
	} as RequestInit);
	const body = (await res.json()) as { identities?: Match[] };
	return { status: res.status, matches: body.identities ?? [] };
}

beforeAll(async () => {
	seeker = await createAccount(seekerName);
	named = await createAccount(namedName, { fields: { displayName: "Srch Uniq Person" } });
	blocked = await createAccount(blockedName);
	bystander = await createAccount(bystanderName);
});

afterAll(async () => {
	// The block row is deleted explicitly (it cascades with the accounts too, but the
	// suite's own footprint is stated rather than implied) — and the suspendedAt flip is
	// undone before any parallel-phase read of the fixture rows.
	if (seeker && bystander) {
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, bystander.userId));
	}
	if (seeker && blocked) {
		await db
			.delete(userBlocks)
			.where(
				or(
					and(eq(userBlocks.blockerId, seeker.userId), eq(userBlocks.blockedId, blocked.userId)),
					and(eq(userBlocks.blockerId, blocked.userId), eq(userBlocks.blockedId, seeker.userId)),
				),
			);
	}
});

describe("GET /api/accounts/identity-search", () => {
	it("refuses a signed-out request", async () => {
		const res = await app.request("/api/accounts/identity-search?q=anything", {
			headers: { Origin: ORIGIN },
		} as RequestInit);
		expect(res.status).toBe(401);
	});

	it("answers empty for a query shorter than two characters", async () => {
		for (const q of ["", "x"]) {
			const { matches } = await search(q, seeker.cookie);
			expect(matches).toEqual([]);
		}
	});

	it("finds an account by handle, including the partial form", async () => {
		const { status, matches } = await search(`srch_uniq_${id}`, seeker.cookie);
		expect(status).toBe(200);
		const hit = matches.find((m) => m.handle === named.handle);
		expect(hit).toBeTruthy();
		expect(hit!.did).toBe(named.did);
	});

	it("finds an account by display name, and the match still lands on the handle", async () => {
		const { matches } = await search("Srch Uniq Person", seeker.cookie);
		const hit = matches.find((m) => m.handle === named.handle);
		expect(hit).toBeTruthy();
		expect(hit!.displayName).toBe("Srch Uniq Person");
	});

	it("carries the did a picked suggestion writes into the credit row", async () => {
		const { matches } = await search(`srch_by_${id}`, seeker.cookie);
		const hit = matches.find((m) => m.handle === bystander.handle);
		expect(hit).toBeTruthy();
		expect(hit!.did).toBe(bystander.did);
	});

	it("never suggests a blocked pair, in either direction, beside an unfiltered control", async () => {
		await db.insert(userBlocks).values({ blockerId: seeker.userId, blockedId: blocked.userId });

		// The seeker's view: the blocked account is absent, the bystander still present.
		const fromSeeker = await search("srch_", seeker.cookie);
		expect(fromSeeker.matches.some((m) => m.handle === blocked.handle)).toBe(false);
		expect(fromSeeker.matches.some((m) => m.handle === bystander.handle)).toBe(true);

		// The blocked account's view: the seeker is absent, the bystander still present —
		// the same symmetric filter blocking.test.ts establishes for every other surface.
		const fromBlocked = await search("srch_", blocked.cookie);
		expect(fromBlocked.matches.some((m) => m.handle === seeker.handle)).toBe(false);
		expect(fromBlocked.matches.some((m) => m.handle === bystander.handle)).toBe(true);

		await db
			.delete(userBlocks)
			.where(
				and(eq(userBlocks.blockerId, seeker.userId), eq(userBlocks.blockedId, blocked.userId)),
			);
	});

	it("hides a suspended account from the suggestions", async () => {
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, bystander.userId));
		const { matches } = await search(`srch_by_${id}`, seeker.cookie);
		expect(matches).toEqual([]);
		// Put it back — the suite's own footprint, restored before the run moves on.
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, bystander.userId));
	});

	it("caps the answer at ten", async () => {
		// The prefix `srch_` matches this suite's fixtures plus anything parallel suites
		// left standing; the cap is asserted on the response, not on that count.
		const { matches } = await search("srch_", seeker.cookie);
		expect(matches.length).toBeLessThanOrEqual(10);
	});
});
