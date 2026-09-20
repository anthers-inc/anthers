// SPDX-License-Identifier: Apache-2.0
/**
 * A reader's filter by kind of content: Hide, Blur or Show for each row of the rating matrix,
 * whatever a Work's rating (Parker, 2026-09-18).
 *
 * 🚨 **Asserted as absences, like the rung filter in `adult-enforcement.test.ts`.** A filter that
 * silently stops matching renders a perfectly plausible listing, so each test names a Work that
 * must be missing as well as one that must be present, and a listing that returned nothing would
 * fail the second.
 *
 * ⚠️ **An unanswered row counts as containing the content.** The filter is an allow-list: a Work is
 * listed for a reader hiding Violence only when its creator answered Violence *Not in It*, so a Work
 * released before the matrix existed, with no rows, is absent for that reader. The legacy fixture
 * here is that case.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, projectItems, projects, users, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `cfilt_c_${run}`;
const readerName = `cfilt_r_${run}`;

/** Every row answered, none of it present, apart from what `over` marks. */
const rows = (over: Record<string, string> = {}) => ({
	violence: "none",
	"sexual-themes": "none",
	"substance-use": "none",
	"self-harm": "none",
	horror: "none",
	language: "none",
	...over,
});

// Titles as constants, for the reason `adult-enforcement.test.ts` gives: a nullable column read
// back could make an absence assertion pass against `null`.
const CARTOON = `Cartoon violence ${run}`;
const GENTLE = `Nothing in it ${run}`;
const LEGACY = `Rated before the matrix ${run}`;
const HORROR = `Graphic horror ${run}`;

let creatorCookie: string;
let readerCookie: string;
let creatorId: number;
let readerId: number;
const madeWorkIds: number[] = [];
const workByTitle = new Map<string, { id: number; publicId: number }>();

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const { cookie } = await createAccount(username);
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.atprotoHandle, username));
	return { cookie, id: row!.id };
}

function preferences(cookie?: string) {
	const headers: Record<string, string> = { Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	return req("/api/accounts/me/content-preferences", { headers });
}

function setPreferences(body: unknown, cookie = readerCookie) {
	return req("/api/accounts/me/content-preferences", {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

/** Everything a response says, so a title anywhere in the payload counts. */
async function said(path: string, cookie?: string): Promise<string> {
	const headers: Record<string, string> = { Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	const res = await req(path, { headers });
	expect(res.status).toBe(200);
	return JSON.stringify(await res.json());
}

const catalog = (cookie?: string) => said(`/api/content/catalog/${creatorName}`, cookie);

describe("a reader's filter by kind of content", () => {
	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE atproto_handle IN (${creatorName}, ${readerName})`);
		({ cookie: creatorCookie, id: creatorId } = await signUp(creatorName));
		({ cookie: readerCookie, id: readerId } = await signUp(readerName));

		const fixtures = [
			{ title: CARTOON, maturity: "general" as const, maturityRows: rows({ violence: "general" }) },
			{ title: GENTLE, maturity: "general" as const, maturityRows: rows() },
			{ title: LEGACY, maturity: "general" as const, maturityRows: {} },
			{ title: HORROR, maturity: "mature" as const, maturityRows: rows({ horror: "mature" }) },
		];
		for (const f of fixtures) {
			const row = await insertWork({ creatorId, type: "text", ...f });
			madeWorkIds.push(row.id);
			workByTitle.set(f.title, { id: row.id, publicId: row.publicId });
		}
		await db.insert(follows).values({ followerId: readerId, creatorId });
		const [project] = await db
			.insert(projects)
			.values({
				creatorId,
				slug: `cfilt-violent-only-${run}`,
				title: `Violent-only project ${run}`,
				isPublished: true,
			})
			.returning({ id: projects.id });
		await db
			.insert(projectItems)
			.values({ projectId: project.id, workId: workByTitle.get(CARTOON)!.id });
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (madeWorkIds.length > 0) await db.delete(works).where(inArray(works.id, madeWorkIds));
		await purgeFixtureAccounts([creatorName, readerName]);
	});

	describe("the setting", () => {
		it("shows every kind of content by default, signed in or out", async () => {
			// A note may drive a reader's own filter and never a platform default, so nothing is
			// covered for what it contains until the reader asks.
			for (const cookie of [undefined, readerCookie]) {
				const prefs = await (await preferences(cookie)).json();
				expect(prefs.notes).toEqual({
					violence: "show",
					"sexual-themes": "show",
					"substance-use": "show",
					"self-harm": "show",
					horror: "show",
					language: "show",
				});
			}
		});

		it("changes the rows it is given and leaves the others as they were", async () => {
			expect((await setPreferences({ notes: { violence: "blur" } })).status).toBe(200);
			expect((await setPreferences({ notes: { horror: "hide" } })).status).toBe(200);
			const prefs = await (await preferences(readerCookie)).json();
			expect(prefs.notes).toMatchObject({ violence: "blur", horror: "hide", language: "show" });
			// And the rungs are untouched by a change to a kind of content.
			expect(prefs.mature).toBe("blur");
			await setPreferences({ notes: { violence: "show", horror: "show" } });
		});

		it("refuses a kind of content or a display it does not know", async () => {
			expect((await setPreferences({ notes: { gore: "hide" } })).status).toBe(400);
			expect((await setPreferences({ notes: { violence: "obliterate" } })).status).toBe(400);
		});
	});

	describe("hiding", () => {
		beforeAll(async () => {
			expect((await setPreferences({ notes: { violence: "hide" } })).status).toBe(200);
		});
		afterAll(async () => {
			await setPreferences({ notes: { violence: "show" } });
		});

		it("keeps out a Work marked at any rung, even General, and keeps one marked Not in It", async () => {
			const listed = await catalog(readerCookie);
			expect(listed).not.toContain(CARTOON);
			expect(listed).toContain(GENTLE);
			// A different kind of content is not what the reader hid.
			expect(listed).toContain(HORROR);
		});

		it("🚨 keeps out a Work whose row nobody answered", async () => {
			// The allow-list direction: a reader relying on the filter is not shown a Work nobody
			// has said is free of what they hid.
			expect(await catalog(readerCookie)).not.toContain(LEGACY);
		});

		it("keeps them for everyone who did not ask", async () => {
			const listed = await catalog();
			expect(listed).toContain(CARTOON);
			expect(listed).toContain(LEGACY);
		});

		it("never hides a creator's own Work from them", async () => {
			expect((await setPreferences({ notes: { violence: "hide" } }, creatorCookie)).status).toBe(
				200,
			);
			expect(await catalog(creatorCookie)).toContain(CARTOON);
			await setPreferences({ notes: { violence: "show" } }, creatorCookie);
		});

		it("still opens a hidden Work from a direct link, because hiding is not an access rule", async () => {
			const res = await req(`/api/content/works/${workByTitle.get(CARTOON)!.publicId}`, {
				headers: { Origin: ORIGIN, Cookie: readerCookie },
			});
			expect(res.status).toBe(200);
		});

		it("applies to the followed-creator feed", async () => {
			const feed = await said("/api/accounts/me/feed", readerCookie);
			expect(feed).not.toContain(CARTOON);
			expect(feed).toContain(GENTLE);
		});

		it("leaves out a project holding only Works the reader hid", async () => {
			// The project listing writes its condition in raw SQL over its own alias, which is the
			// call most easily left reading the wrong column.
			const path = `/api/content/projects?creator=${creatorName}`;
			expect(await said(path, readerCookie)).not.toContain(`Violent-only project ${run}`);
			expect(await said(path)).toContain(`Violent-only project ${run}`);
		});
	});

	describe("blurring", () => {
		it("⭐ leaves a blurred Work listed, because a blur is not a hide", async () => {
			expect((await setPreferences({ notes: { violence: "blur" } })).status).toBe(200);
			const listed = await catalog(readerCookie);
			expect(listed).toContain(CARTOON);
			expect(listed).toContain(LEGACY);
			await setPreferences({ notes: { violence: "show" } });
		});

		it("hands a reader the rows the browser blurs by, on the Work and in the feed", async () => {
			const res = await req(`/api/content/works/${workByTitle.get(CARTOON)!.publicId}`, {
				headers: { Origin: ORIGIN, Cookie: readerCookie },
			});
			const { work } = await res.json();
			expect(work.maturityRows).toMatchObject({ violence: "general", horror: "none" });

			const feed = await (
				await req("/api/accounts/me/feed", { headers: { Origin: ORIGIN, Cookie: readerCookie } })
			).json();
			const entry = feed.entries.find((e: { title: string }) => e.title === HORROR);
			expect(entry.maturity).toBe("mature");
			expect(entry.maturityRows).toMatchObject({ horror: "mature" });
		});
	});
});
