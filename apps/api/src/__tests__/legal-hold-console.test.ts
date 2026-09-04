// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * An operator can place a hold without reaching for `psql`.
 *
 * 🚨 **The mechanism shipped without a way to reach it.** `legal_holds` has been honored by
 * five sweeps since PR #72 and placed by exactly one caller — `services/quarantine.ts`,
 * automatically. Everything arriving as paper went in by hand, and **a hold you can only
 * place with `psql` is one that will not get placed at 2am**, which is when a preservation
 * letter arrives.
 *
 * ⚠️ **The assertion that matters most is the one about an id that names nothing.** Every
 * integer is a valid `subject_id` as far as the table is concerned, so a hold on a typo'd
 * id writes a row, returns success, and preserves nothing — and it is indistinguishable
 * from a working hold until the day somebody needs the records and they are gone. That is
 * why the route resolves the subject to a **label** before writing, and why the failure
 * case below counts rows rather than trusting the status code.
 *
 * ⭐ **A lifted hold has to keep showing.** `liftHold` stamps rather than deletes so the
 * record of what was preserved survives the preservation; a list filtered to active holds
 * would undo that at the one place anybody looks.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { legalHolds, users } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const adminName = `holdop_admin_${RUN}`;
const plainName = `holdop_plain_${RUN}`;
const subjectName = `holdop_subject_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

async function userId(username: string): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);
	return row.id;
}

/** How many holds exist against this subject, whatever their state. */
async function holdCount(subjectId: number): Promise<number> {
	const rows = await db
		.select({ id: legalHolds.id })
		.from(legalHolds)
		.where(and(eq(legalHolds.subjectType, "user"), eq(legalHolds.subjectId, subjectId)));
	return rows.length;
}

interface HoldRow {
	id: number;
	subjectId: number;
	subjectLabel: string | null;
	reason: string;
	state: string;
	expiresAt: string | null;
	placedBy: string | null;
}

async function listHolds(cookie: string): Promise<HoldRow[]> {
	const res = await req("/api/admin/legal-holds", { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return ((await res.json()) as { holds: HoldRow[] }).holds;
}

let adminCookie: string;
let plainCookie: string;
let subjectId: number;
/** An id no row can have, for the case the whole surface exists to prevent. */
const MISSING_ID = 2_100_000_000;

describe("the legal hold console", () => {
	beforeAll(async () => {
		adminCookie = await signUp(adminName);
		plainCookie = await signUp(plainName);
		await signUp(subjectName);
		subjectId = await userId(subjectName);
		// Admin is an out-of-band flag, never self-serve.
		await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.delete(legalHolds).where(eq(legalHolds.subjectId, subjectId));
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${adminName}, ${plainName}, ${subjectName})`,
		);
	});

	it("is not advertised to anyone who is not an operator", async () => {
		expect((await req("/api/admin/legal-holds")).status).toBe(401);
		expect((await req("/api/admin/legal-holds", { headers: { Cookie: plainCookie } })).status).toBe(
			404,
		);
	});

	it("🚨 refuses a hold on an id that names nothing, and writes no row", async () => {
		// The one that matters. A row here would preserve nothing while looking exactly
		// like a hold that works, and nobody finds out until the records are needed.
		const before = await holdCount(MISSING_ID);
		const res = await req("/api/admin/legal-holds", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
			body: JSON.stringify({
				subjectType: "user",
				subjectId: MISSING_ID,
				reason: "Preservation request, test",
				duration: "preservation",
			}),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("no_such_subject");
		expect(await holdCount(MISSING_ID)).toBe(before);
	});

	it("🚨 refuses a blank reason at the edge rather than throwing in the service", async () => {
		// `placeHold` throws on a blank reason, so without the schema check this is a 500
		// and the operator sees nothing they can act on.
		for (const reason of ["", "   "]) {
			const res = await req("/api/admin/legal-holds", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
				body: JSON.stringify({ subjectType: "user", subjectId, reason, duration: "indefinite" }),
			});
			expect(res.status, JSON.stringify(reason)).toBe(400);
		}
		expect(await holdCount(subjectId)).toBe(0);
	});

	it("places a preservation hold and echoes back what it actually held", async () => {
		const res = await req("/api/admin/legal-holds", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
			body: JSON.stringify({
				subjectType: "user",
				subjectId,
				reason: "§ 2703(f) preservation request, case 26-114873",
				duration: "preservation",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { holdId: number; subjectLabel: string };
		// The label is the whole safety property — it is what lets somebody notice they
		// preserved the wrong account.
		expect(body.subjectLabel).toBe(`@${subjectName}`);

		const [row] = await db
			.select({ expiresAt: legalHolds.expiresAt, placedBy: legalHolds.placedBy })
			.from(legalHolds)
			.where(eq(legalHolds.id, body.holdId));
		// One year, per 18 U.S.C. § 2258A(h), computed by the server rather than typed.
		expect(row.expiresAt).not.toBeNull();
		const years = (row.expiresAt!.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000);
		expect(years).toBeGreaterThan(0.9);
		expect(years).toBeLessThan(1.1);
		// A hand-placed hold names the person who placed it; only a job leaves this null.
		expect(row.placedBy).toBe(await userId(adminName));
	});

	it("shows it as active, attributed, and labeled", async () => {
		const hold = (await listHolds(adminCookie)).find((h) => h.subjectId === subjectId);
		expect(hold).toBeDefined();
		expect(hold!.state).toBe("active");
		expect(hold!.subjectLabel).toBe(`@${subjectName}`);
		expect(hold!.placedBy).toBe(adminName);
	});

	it("⭐ keeps a lifted hold in the list, because the record outlives the preservation", async () => {
		const before = (await listHolds(adminCookie)).find((h) => h.subjectId === subjectId)!;
		const res = await req(`/api/admin/legal-holds/${before.id}/lift`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: adminCookie },
		});
		expect(res.status).toBe(200);

		const after = (await listHolds(adminCookie)).find((h) => h.id === before.id);
		expect(after, "a lifted hold must still be listed").toBeDefined();
		expect(after!.state).toBe("lifted");
		expect(after!.reason).toBe(before.reason);
	});

	it("refuses to lift the same hold twice, so the stamp is never rewritten", async () => {
		// A second lift would move `liftedAt` forward and quietly rewrite when the
		// preservation actually ended.
		const hold = (await listHolds(adminCookie)).find((h) => h.subjectId === subjectId)!;
		const res = await req(`/api/admin/legal-holds/${hold.id}/lift`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: adminCookie },
		});
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("not_active");
	});

	it("accepts an indefinite hold, which is what a live suit gets", async () => {
		const res = await req("/api/admin/legal-holds", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
			body: JSON.stringify({
				subjectType: "user",
				subjectId,
				reason: "Litigation hold — Doe v. Anthers",
				duration: "indefinite",
			}),
		});
		expect(res.status).toBe(201);
		const { holdId } = (await res.json()) as { holdId: number };
		const [row] = await db
			.select({ expiresAt: legalHolds.expiresAt })
			.from(legalHolds)
			.where(eq(legalHolds.id, holdId));
		expect(row.expiresAt).toBeNull();
	});
});
