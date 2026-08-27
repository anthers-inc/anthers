// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A Project's shelf of Works: membership, ordering, and what a shelf is NOT allowed to do.
 *
 * `POST /projects/:slug/works/reorder` is new (2026-08-13) and had no counterpart until
 * then — `POST .../works` assigned `max(sortOrder) + 1` and nothing could change it
 * afterwards, so order was fixed at the moment of adding. For an album that is not a
 * missing convenience: **track order is the artifact.**
 *
 * The other half of this file is the property that makes a Project safe to put anything
 * on: 🚨 **a Project is a shelf, not an owner.** Membership confers no access, removal
 * destroys nothing, and a gated Work stays gated on the shelf. Those are the assertions
 * that would let a shelf quietly become an access path if they ever stopped holding.
 *
 * Verified by sabotage before being committed, and the first round found a hole in this
 * file rather than in the code. Five breaks — dropping the reorder's `projectId`
 * predicate, deleting the Work instead of the membership, removing the duplicate guard,
 * dropping the ownership check, and leaking draft members — now fail exactly one test
 * each. **The `projectId` one originally failed none**, because the control Project held a
 * single Work and a one-element list cannot show a reorder; the control has two members
 * now, named reversed at the front of the request. A control that cannot distinguish the
 * two outcomes is not a control.
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
const creatorName = `pw_${id}`;
const strangerName = `pw_s_${id}`;
const SLUG = `pw-album-${id}`;
const OTHER_SLUG = `pw-other-${id}`;

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const GATED = [{ threshold: 2, allow: true, price: "0" }];

let auth: Record<string, string>;
let strangerCookie: string;
/** Track title → Work id, in the order they were added. */
const tracks: { title: string; workId: number }[] = [];
let gatedWorkId = 0;
/** Members of a SECOND Project, used as the cross-Project control. */
const otherWorks: { title: string; workId: number }[] = [];

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

async function makeWork(title: string, access: unknown): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ type: "audio", title, maturity: "general" }),
	});
	expect(created.status).toBe(201);
	const workId = (await created.json()).work.id as number;
	const patched = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ seedAccess: access, streamEnabled: true, visibility: "released" }),
	});
	expect(patched.status).toBe(200);
	return workId;
}

/** The member Works of a Project, in the order the detail endpoint returns them. */
async function orderOf(slug: string, cookie?: string): Promise<string[]> {
	const res = await req(
		`/api/content/projects/${slug}`,
		cookie ? { headers: { Cookie: cookie } } : undefined,
	);
	expect(res.status).toBe(200);
	const { project } = await res.json();
	return (project.works as { title: string }[]).map((w) => w.title);
}

describe("a Project's Works", () => {
	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${strangerName})`);
		const cookie = await signUp(creatorName);
		strangerCookie = await signUp(strangerName);
		auth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie };

		for (const slug of [SLUG, OTHER_SLUG]) {
			const project = await req("/api/content/projects", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ title: slug, slug, isPublished: true }),
			});
			expect(project.status).toBe(201);
		}

		// Added deliberately OUT of the order they should end up in, so a passing reorder
		// can't be the insertion order wearing a disguise.
		for (const title of ["Track C", "Track A", "Track B"]) {
			const workId = await makeWork(`${title} ${id}`, FREE);
			tracks.push({ title: `${title} ${id}`, workId });
			const added = await req(`/api/content/projects/${SLUG}/works`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ workId }),
			});
			expect(added.status).toBe(201);
		}

		gatedWorkId = await makeWork(`Gated ${id}`, GATED);

		// The other Project needs **two** members in a known order, not one. A single-member
		// list cannot show a reorder, so a one-Work control passes whether or not the
		// cross-Project guard exists — which is exactly what the first version of this file
		// did: sabotaging the `projectId` predicate left all 8 tests green.
		for (const title of ["Other One", "Other Two"]) {
			const workId = await makeWork(`${title} ${id}`, FREE);
			otherWorks.push({ title: `${title} ${id}`, workId });
			const added = await req(`/api/content/projects/${OTHER_SLUG}/works`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ workId }),
			});
			expect(added.status).toBe(201);
		}
	}, DB_SETUP_TIMEOUT);

	it("serves member Works in their stored order, newest addition last", async () => {
		expect(await orderOf(SLUG)).toEqual([`Track C ${id}`, `Track A ${id}`, `Track B ${id}`]);
	});

	it("reorders to exactly the requested sequence", async () => {
		const byTitle = (t: string) => tracks.find((x) => x.title.startsWith(t))!.workId;
		const res = await req(`/api/content/projects/${SLUG}/works/reorder`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				workIds: [byTitle("Track A"), byTitle("Track B"), byTitle("Track C")],
			}),
		});
		expect(res.status).toBe(200);
		expect(await orderOf(SLUG)).toEqual([`Track A ${id}`, `Track B ${id}`, `Track C ${id}`]);
	});

	it("refuses a duplicate id rather than giving two Works one position", async () => {
		const dupe = tracks[0].workId;
		const res = await req(`/api/content/projects/${SLUG}/works/reorder`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ workIds: [dupe, dupe] }),
		});
		expect(res.status).toBe(400);
	});

	/**
	 * The predicate that keeps a reorder inside its own Project. Without it the UPDATE
	 * matches on `work_id` alone and renumbers every Project the Work sits on — a
	 * cross-Project corruption with no error and no visible cause at the call site.
	 */
	it("cannot renumber the Works of a different Project", async () => {
		const before = await orderOf(OTHER_SLUG);
		expect(before).toEqual([`Other One ${id}`, `Other Two ${id}`]);

		// Name the other Project's members REVERSED, at the front. If the UPDATE matched on
		// `work_id` alone, "Other Two" would take position 0 and the other shelf would come
		// back inverted. Two members are the minimum that can show this at all.
		const res = await req(`/api/content/projects/${SLUG}/works/reorder`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				workIds: [otherWorks[1].workId, otherWorks[0].workId, ...tracks.map((t) => t.workId)],
			}),
		});
		expect(res.status).toBe(200);
		expect(await orderOf(OTHER_SLUG)).toEqual(before);
	});

	it("refuses to reorder a Project the caller doesn't own", async () => {
		const res = await req(`/api/content/projects/${SLUG}/works/reorder`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: strangerCookie },
			body: JSON.stringify({ workIds: tracks.map((t) => t.workId) }),
		});
		expect(res.status).toBe(404);
	});

	// ── A shelf is not an owner ───────────────────────────────────────────────

	/**
	 * 🚨 The property the whole model rests on. If membership ever conferred access, a
	 * creator could unlock their own gated work by shelving it somewhere public — and
	 * every Project page would become a bypass rather than a listing.
	 */
	it("does not grant access to a gated Work put on a public shelf", async () => {
		const added = await req(`/api/content/projects/${SLUG}/works`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ workId: gatedWorkId }),
		});
		expect(added.status).toBe(201);

		const res = await req(`/api/content/projects/${SLUG}`, {
			headers: { Cookie: strangerCookie },
		});
		const { project } = await res.json();
		const gated = (project.works as { title: string; access: { canAccess: boolean } }[]).find((w) =>
			w.title.startsWith("Gated"),
		);
		expect(gated, "the gated Work should still be listed").toBeTruthy();
		expect(gated?.access.canAccess).toBe(false);
	});

	it("removing a Work from a Project leaves the Work itself untouched", async () => {
		const removed = await req(`/api/content/projects/${SLUG}/works/${gatedWorkId}`, {
			method: "DELETE",
			headers: auth,
		});
		expect(removed.status).toBe(204);

		// Off the shelf…
		expect(await orderOf(SLUG)).not.toContain(`Gated ${id}`);
		// …and still in the Catalog, released, reachable at its own URL.
		const work = await req(`/api/content/works/${gatedWorkId}`, { headers: auth });
		expect(work.status).toBe(200);
		expect((await work.json()).work.visibility).toBe("released");
	});

	it("hides unreleased members from everyone but the creator", async () => {
		const draftId = await makeWork(`Draft ${id}`, FREE);
		await req(`/api/content/works/${draftId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({ visibility: "private" }),
		});
		await req(`/api/content/projects/${SLUG}/works`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ workId: draftId }),
		});

		expect(await orderOf(SLUG, auth.Cookie)).toContain(`Draft ${id}`);
		expect(await orderOf(SLUG, strangerCookie)).not.toContain(`Draft ${id}`);
	});
});
