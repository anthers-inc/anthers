// SPDX-License-Identifier: Apache-2.0
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
import { projects } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { PROJECT_COLLECTION } from "../services/atproto-record-plan.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { CREATED_CREDIT, giveWorkAFile } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

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
/** A draft the suite never publishes — the detail route's draft gate's own subject. */
const DRAFT_SLUG = `pw-draft-${id}`;

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
	return (await createAccount(username)).cookie;
}

async function makeWork(title: string, access: unknown): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			type: "audio",
			title,
			maturityRows: rowsRatedAs("general"),
			credits: CREATED_CREDIT,
		}),
	});
	expect(created.status).toBe(201);
	const workId = (await created.json()).work.id as number;
	await giveWorkAFile(workId);
	const patched = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ access: access, streamEnabled: true, visibility: "released" }),
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
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`,
		);
		const cookie = await signUp(creatorName);
		await enablePayouts(creatorName);
		strangerCookie = await signUp(strangerName);
		await enablePayouts(strangerName);
		auth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie };

		for (const slug of [SLUG, OTHER_SLUG]) {
			const project = await req("/api/content/projects", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ title: slug, slug, isPublished: true }),
			});
			expect(project.status).toBe(201);
		}
		// The draft, created unpublished and left there.
		const draft = await req("/api/content/projects", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ title: DRAFT_SLUG, slug: DRAFT_SLUG, isPublished: false }),
		});
		expect(draft.status).toBe(201);

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

	it("carries the project's record link beside it: null without one, Taproot with one", async () => {
		const uri = `at://did:plc:${id}/${PROJECT_COLLECTION}/${id}key`;
		const [row] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, SLUG));
		await db.update(projects).set({ atprotoUri: uri }).where(eq(projects.id, row.id));
		try {
			// A stranger's read — the record is public no matter who reads.
			const detail = await req(`/api/content/projects/${SLUG}`, {
				headers: { Cookie: strangerCookie },
			});
			expect(detail.status).toBe(200);
			const { project } = await detail.json();
			expect(project.recordUrl).toBe(`https://atproto.at/uri/${uri}`);
		} finally {
			await db.update(projects).set({ atprotoUri: null }).where(eq(projects.id, row.id));
		}
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

	/**
	 * The draft gate on the detail route (the unified-editor pass, 2026-10-17). A draft
	 * Project was readable by anyone holding its URL — the member filtering hid draft
	 * works and posts, and nothing hid the PROJECT — while a private Work 404s the same
	 * audience, and the Project page's publish field claims "only you can read" from the
	 * owner's copy of the page. Same rule for both: the existence of unreleased work is
	 * itself not public information.
	 */
	it("a draft Project 404s for a stranger and signed-out, and reads for its creator", async () => {
		const signedOut = await req(`/api/content/projects/${DRAFT_SLUG}`);
		expect(signedOut.status).toBe(404);
		const stranger = await req(`/api/content/projects/${DRAFT_SLUG}`, {
			headers: { Cookie: strangerCookie },
		});
		expect(stranger.status).toBe(404);
		const owner = await req(`/api/content/projects/${DRAFT_SLUG}`, { headers: auth });
		expect(owner.status).toBe(200);
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

	it("the owner's listing rides worksSummary in shelf order; the public listing carries none", async () => {
		// The Studio's Projects table renders each project's works as a thumbnail grid
		// beside the project block, and this is the only call it fetches them with — the
		// owner's serialization needs no maturity hiding, but it must not leak onto the
		// public one, where a private member's existence is a disclosure.
		const mine = await req("/api/content/projects?mine=true", { headers: auth });
		expect(mine.status).toBe(200);
		const { projects: mineProjects } = (await mine.json()) as {
			projects: {
				slug: string;
				worksSummary?: { id: number; type: string; visibility?: string; sortOrder: number }[];
			}[];
		};
		const album = mineProjects.find((p) => p.slug === SLUG);
		expect(album, "the owner's own listing is where the summary rides").toBeTruthy();
		// Shelf order for the released tracks; the draft the earlier test added to this
		// same shelf is here too — with its visibility — because the owner's grid shows
		// the shelf as the owner holds it, private members included.
		expect(album!.worksSummary?.length).toBe(tracks.length + 1);
		expect(album!.worksSummary?.slice(0, tracks.length).map((w) => w.id)).toEqual(
			tracks.map((t) => t.workId),
		);
		const [draft] = album!.worksSummary!.slice(-1);
		expect(draft.visibility).toBe("private");
		// A summary is identity and state, not the Work entire — no media payload rides it.
		expect(Object.keys(album!.worksSummary![0])).toEqual([
			"id",
			"publicId",
			"slug",
			"title",
			"type",
			"thumbnail",
			"visibility",
			"sortOrder",
		]);
		const other = mineProjects.find((p) => p.slug === OTHER_SLUG);
		expect(other!.worksSummary?.map((w) => w.id)).toEqual(otherWorks.map((w) => w.workId));

		// And the public listing never carries it — the exact assertion an absence needs.
		const listing = await req("/api/content/projects");
		expect(listing.status).toBe(200);
		const { projects: publicProjects } = (await listing.json()) as {
			projects: { slug: string; worksSummary?: unknown }[];
		};
		expect(publicProjects.find((p) => p.slug === SLUG)?.worksSummary).toBeUndefined();
	});
});
