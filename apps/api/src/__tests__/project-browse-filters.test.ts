// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `GET /content/projects` — the filters Discover has always sent.
 *
 * These existed as controls in the sidebar long before the handler read any of them, so
 * every filter on the page silently did nothing while looking like it worked. That is
 * the failure this file exists to keep from coming back: a filter that is dropped
 * server-side is indistinguishable, from the browser, from a filter that matched
 * everything.
 *
 * A project has no type, tags or price of its own — it is a collection — so each filter
 * asks a question about the **Works** it contains, and a project matches when ANY
 * released Work in it does. Works are game/audio/text so nothing hits media processing.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `filt_${id}`;

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const PAID = [{ threshold: 0, allow: true, price: "5.00" }];
const GATED = [{ threshold: 2, allow: true, price: "0" }];

/** Slugs of the projects this run created, so assertions ignore everyone else's data. */
const mine = new Map<string, string>();

async function listSlugs(query: string): Promise<string[]> {
	const res = await req(`/api/content/projects?${query}`);
	expect(res.status).toBe(200);
	const { projects } = await res.json();
	const ours = new Set(mine.values());
	return (projects as { slug: string }[]).map((p) => p.slug).filter((s) => ours.has(s));
}

describe("project browse filters", () => {
	let cookie: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);

		const signUp = await req("/api/auth/sign-up", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				username: creatorName,
				email: `${creatorName}@example.com`,
				password: "testpass123",
			}),
		});
		expect(signUp.status).toBe(201);
		cookie = signUp.headers.get("Set-Cookie")!.split(";")[0];

		const auth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie };

		// Each project holds exactly one Work, so a filter that matches the Work and a
		// filter that matches the project are the same assertion.
		const cases = [
			{ label: "game", type: "game", tags: ["puzzle"], access: FREE, release: true },
			{ label: "audio", type: "audio", tags: ["lo-fi"], access: PAID, release: true },
			{ label: "text", type: "text", tags: ["essay"], access: GATED, release: true },
			// The control: a Work that was never released must not qualify its project for
			// any public listing, however well it matches on type or tag.
			{ label: "unreleased", type: "game", tags: ["puzzle"], access: FREE, release: false },
		];

		for (const c of cases) {
			const created = await req("/api/content/works", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ type: c.type, title: `${c.label} ${id}`, tags: c.tags }),
			});
			expect(created.status).toBe(201);
			const workId = (await created.json()).work.id as number;

			const patch: Record<string, unknown> = {
				anthersAccess: c.access,
				streamEnabled: c.type !== "text",
				downloadEnabled: true,
			};
			if (c.release) patch.visibility = "released";
			const patched = await req(`/api/content/works/${workId}`, {
				method: "PATCH",
				headers: auth,
				body: JSON.stringify(patch),
			});
			expect(patched.status).toBe(200);

			const slug = `filt-${c.label}-${id}`;
			const project = await req("/api/content/projects", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ title: `Filt ${c.label} ${id}`, slug, isPublished: true }),
			});
			expect(project.status).toBe(201);
			mine.set(c.label, slug);

			const added = await req(`/api/content/projects/${slug}/works`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ workId }),
			});
			expect(added.status).toBe(201);
		}
	}, DB_SETUP_TIMEOUT);

	it("returns every published project when nothing is filtered", async () => {
		const slugs = await listSlugs("");
		expect(slugs.sort()).toEqual([...mine.values()].sort());
	});

	it("filters by the media type of the Works a project holds", async () => {
		expect(await listSlugs("media_type=audio")).toEqual([mine.get("audio")!]);
		expect(await listSlugs("media_type=text")).toEqual([mine.get("text")!]);
		// `game` matches the released game and NOT the unreleased one, which is the
		// control: an unreleased Work must never qualify a project for a public listing.
		expect(await listSlugs("media_type=game")).toEqual([mine.get("game")!]);
	});

	it("filters by tag", async () => {
		expect(await listSlugs("tag=lo-fi")).toEqual([mine.get("audio")!]);
		expect(await listSlugs("tag=essay")).toEqual([mine.get("text")!]);
		expect(await listSlugs("tag=nobody-uses-this")).toEqual([]);
	});

	it("distinguishes free, paid and gated by the access rows on the Work", async () => {
		expect(await listSlugs("pricing=free")).toEqual([mine.get("game")!]);
		expect(await listSlugs("pricing=paid")).toEqual([mine.get("audio")!]);
		// Gated means a threshold you must HOLD, not a price you can pay — so the $5 Work
		// is not gated and the 2-Seed one is, even though neither is free.
		expect(await listSlugs("pricing=gated")).toEqual([mine.get("text")!]);
	});

	it("combines filters rather than letting the last one win", async () => {
		expect(await listSlugs("media_type=audio&pricing=paid")).toEqual([mine.get("audio")!]);
		expect(await listSlugs("media_type=audio&pricing=free")).toEqual([]);
	});

	it("accepts every sort the sidebar can send, and ignores one it cannot", async () => {
		// The guarantee is narrow and deliberate: each sort must RUN and return this
		// creator's projects. Asserting an ORDER here would pin nothing real — views and
		// ratings are zero across the fixture, so every ordering is a legitimate tie.
		//
		// Scoped by creator on purpose. The handler takes 100 rows, and a shared dev
		// database holds hundreds of projects with real view counts, so an unscoped
		// `popular` sorts these zero-view fixtures off the end — a true result that
		// would read as a broken filter.
		for (const sort of ["newest", "popular", "top_rated"]) {
			const slugs = await listSlugs(`creator=${creatorName}&sort=${sort}`);
			expect(slugs.sort()).toEqual([...mine.values()].sort());
		}
		// An unknown sort falls back to newest rather than erroring, so an older client
		// still gets a list. `trending` is exactly that case: it was removed from the
		// sidebar because `works.view_count` is a lifetime counter with no window.
		const fallback = await listSlugs(`creator=${creatorName}&sort=trending`);
		expect(fallback.sort()).toEqual([...mine.values()].sort());
	});

	it("still honours the filters that already worked", async () => {
		expect(await listSlugs(`search=Filt audio ${id}`)).toEqual([mine.get("audio")!]);
		expect((await listSlugs(`creator=${creatorName}`)).sort()).toEqual([...mine.values()].sort());
	});
});
