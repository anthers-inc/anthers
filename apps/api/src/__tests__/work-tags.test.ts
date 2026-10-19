// SPDX-License-Identifier: Apache-2.0
/**
 * Work tags: the creator's five, and the directory that shows how used each one is.
 *
 * The properties under test, one spec each:
 * - **The directory counts released Works**, most-used first, and a search narrows it.
 * - **Private and Adult Works never contribute a count** — the same invisibility every
 *   listing applies — while a Mature Work does.
 * - **Saving normalizes** whitespace, case and a pasted hash into one slug, and de-duplicates
 *   before the cap is measured.
 * - **The cap is the API's**, not only the form's: six distinct tags are refused with a
 *   sentence, and five are accepted.
 * - **A tag that cannot be a slug is refused** rather than silently truncated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { MAX_WORK_TAGS } from "@anthers/shared/tags";
import { inArray } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

let creator = { id: 0, cookie: "" };
const workIds: number[] = [];

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** The unique prefix every tag this suite creates carries, so the directory is readable. */
const p = `tagdir-${run}`;

async function directory(query = "") {
	const res = await app.fetch(
		new Request(`http://localhost/api/content/tags?q=${encodeURIComponent(query)}&limit=100`, {
			headers: { Origin: ORIGIN },
		}),
	);
	expect(res.status).toBe(200);
	return (await res.json()) as { tags: { tag: string; works: number }[] };
}

async function tagAPrivateWork(tags: unknown) {
	const res = await call("PATCH", `/api/content/works/${workIds[0]}`, creator.cookie, { tags });
	return res;
}

beforeAll(async () => {
	const account = await createAccount(`tags_creator_${run}`);
	creator = { id: account.userId as number, cookie: account.cookie };

	// Three released Works share `shared`, which is what makes popularity a ranking rather
	// than an alphabetical list; the rest carry one tag each.
	const released = [
		{ tags: [`${p}-shared`, `${p}-alpha`] },
		{ tags: [`${p}-shared`, `${p}-beta`] },
		{ tags: [`${p}-shared`] },
		{ tags: [`${p}-mature`], maturity: "mature" as const },
	];
	for (const fixture of released) {
		const row = await insertWork({ creatorId: creator.id, type: "text", ...fixture });
		workIds.push(row.id);
	}
	const hidden = [
		{ tags: [`${p}-private`], visibility: "private" as const },
		{ tags: [`${p}-adult`], maturity: "adult" as const },
	];
	for (const fixture of hidden) {
		const row = await insertWork({ creatorId: creator.id, type: "text", ...fixture });
		workIds.push(row.id);
	}

	// A private Work whose only job is to be edited by the save tests.
	const editable = await insertWork({
		creatorId: creator.id,
		type: "text",
		visibility: "private",
	});
	workIds.unshift(editable.id);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
});

describe("the tag directory", () => {
	it("counts released Works and orders by use, then name", async () => {
		const { tags } = await directory(p);
		const counts = new Map(tags.map((t) => [t.tag, t.works]));
		expect(counts.get(`${p}-shared`)).toBe(3);
		expect(counts.get(`${p}-alpha`)).toBe(1);
		expect(counts.get(`${p}-beta`)).toBe(1);
		// Equal counts settle alphabetically, which is what makes the list stable between reads.
		const ones = tags.filter((t) => t.tag.startsWith(`${p}-`) && t.tag !== `${p}-shared`);
		const order = ones.map((t) => t.tag);
		expect(order).toEqual([...order].sort());
	});

	it("includes a Mature Work's tag", async () => {
		const { tags } = await directory(p);
		expect(tags.some((t) => t.tag === `${p}-mature`)).toBe(true);
	});

	it("leaves out a private Work's tag and an Adult Work's tag", async () => {
		const { tags } = await directory(p);
		const names = tags.map((t) => t.tag);
		expect(names).not.toContain(`${p}-private`);
		expect(names).not.toContain(`${p}-adult`);
	});

	it("narrows by a typed search", async () => {
		const { tags } = await directory(`${p}-alp`);
		expect(tags.map((t) => t.tag)).toEqual([`${p}-alpha`]);
	});

	it("finds a tag typed with a leading hash, the way a creator pastes one", async () => {
		const { tags } = await directory(`#${p}-shared`);
		expect(tags[0]).toEqual({ tag: `${p}-shared`, works: 3 });
	});
});

describe("saving a Work's tags", () => {
	it("normalizes, de-duplicates and drops the pasted hash", async () => {
		const res = await tagAPrivateWork([" Indie ", "cozy horror", "indie", "#pixel-art"]);
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as { work: { tags: string[] } };
		expect(work.tags).toEqual(["indie", "cozy-horror", "pixel-art"]);
	});

	it("accepts a list at the cap", async () => {
		const tags = Array.from({ length: MAX_WORK_TAGS }, (_, i) => `tag-${i}`);
		const res = await tagAPrivateWork(tags);
		expect(res.status).toBe(200);
	});

	it("measures the cap after de-duplication", async () => {
		const tags = ["indie", "Indie", "tag-a", "tag-b", "tag-c", "tag-d"];
		const res = await tagAPrivateWork(tags);
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as { work: { tags: string[] } };
		expect(work.tags).toEqual(["indie", "tag-a", "tag-b", "tag-c", "tag-d"]);
	});

	it("refuses one past the cap with a sentence", async () => {
		const tags = Array.from({ length: MAX_WORK_TAGS + 1 }, (_, i) => `tag-${i}`);
		const res = await tagAPrivateWork(tags);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(`A Work can carry up to ${MAX_WORK_TAGS} tags.`);
	});

	it("refuses a tag that cannot be a slug", async () => {
		const res = await tagAPrivateWork(["C++"]);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Tags can use letters, numbers, hyphens and underscores.");
	});
});
