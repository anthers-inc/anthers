// SPDX-License-Identifier: Apache-2.0
/**
 * A game or software Work's embed address is refused unless it is https on another site, on the way
 * in and on the way out.
 *
 * The address becomes an iframe `src` on the Work page, and that iframe's sandbox allows scripts and
 * same-origin access, so what it may point at is a security boundary rather than a form rule. The
 * reasons are in `embedUrlProblem`, and `packages/shared/src/embed-url.test.ts` walks the individual
 * schemes and hosts. This file proves the routes use the check: creating and editing both refuse,
 * with a message a creator can act on, and a bad address already in the database is handed to
 * neither the creator nor a viewer.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const GOOD = "https://games.example.com/embed/build";
const SCRIPT = "javascript:alert(document.cookie)";
const PUBLIC_ACCESS = [{ threshold: 0, allow: true, price: "0" }];

function req(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method: init.method ?? "GET",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);
}

let creator: { cookie: string; userId: number };
let viewer: { cookie: string };

beforeAll(async () => {
	creator = await createAccount(`embed_creator_${id}`);
	viewer = await createAccount(`embed_viewer_${id}`);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.delete(works).where(eq(works.creatorId, creator.userId));
});

describe("creating a Work", () => {
	for (const [address, reason] of [
		[SCRIPT, "https://"],
		["http://games.example.com/embed", "https://"],
		["https://anthers.org/api/content/works/1/assets/2/download", "another site"],
	] as const) {
		it(`refuses ${address}, and says why`, async () => {
			const title = `refused ${id} ${address}`;
			const res = await req("/api/content/works", creator.cookie, {
				method: "POST",
				body: { type: "game", title, embedUrl: address },
			});
			expect(res.status).toBe(400);
			// A string a creator can read. Without the validation hook the route answered with a
			// serialized ZodError, which reaches the form as "[object Object]".
			expect((await res.json()).error).toContain(reason);
			const created = await db
				.select({ id: works.id })
				.from(works)
				.where(and(eq(works.creatorId, creator.userId), eq(works.title, title)));
			expect(created).toHaveLength(0);
		});
	}

	it("accepts an https page on another site", async () => {
		const res = await req("/api/content/works", creator.cookie, {
			method: "POST",
			body: { type: "game", title: `accepted ${id}`, embedUrl: GOOD },
		});
		expect(res.status).toBe(201);
		expect((await res.json()).work.embedUrl).toBe(GOOD);
	});
});

describe("editing a Work", () => {
	it("refuses a bad address and keeps the one it had", async () => {
		const work = await insertWork({
			creatorId: creator.userId,
			type: "game",
			visibility: "private",
			embedUrl: GOOD,
		});
		const res = await req(`/api/content/works/${work.id}`, creator.cookie, {
			method: "PATCH",
			body: { embedUrl: SCRIPT },
		});
		expect(res.status).toBe(400);
		const [row] = await db
			.select({ embedUrl: works.embedUrl })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row.embedUrl).toBe(GOOD);
	});
});

describe("a bad address already in the database", () => {
	let badId: number;
	let goodId: number;

	beforeAll(async () => {
		const base = { creatorId: creator.userId, type: "game", seedAccess: PUBLIC_ACCESS };
		badId = (await insertWork({ ...base, embedUrl: SCRIPT })).id;
		goodId = (await insertWork({ ...base, embedUrl: GOOD })).id;
	}, DB_SETUP_TIMEOUT);

	async function embedFor(workId: number, cookie: string): Promise<string> {
		const res = await req(`/api/content/works/${workId}`, cookie);
		expect(res.status).toBe(200);
		return (await res.json()).work.embedUrl;
	}

	it("is not handed to a viewer", async () => {
		// The control first: a viewer who can play the good Work is given its address, so the
		// empty answer below is the check and not a viewer who could never have had one.
		expect(await embedFor(goodId, viewer.cookie)).toBe(GOOD);
		expect(await embedFor(badId, viewer.cookie)).toBe("");
	});

	it("is not handed to the creator either, whose Work page renders the same field", async () => {
		expect(await embedFor(goodId, creator.cookie)).toBe(GOOD);
		expect(await embedFor(badId, creator.cookie)).toBe("");
	});
});
