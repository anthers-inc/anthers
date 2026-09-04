// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two derived counts whose correctness is a side effect of a join.
 *
 * ⚠️ **Neither of these was ever broken, and this file exists because that took real work
 * to establish.** A reconciliation pass reported both as live instances of the
 * unqualified-subquery bug PR #223 fixed in `routes/accounts.ts`. They are not. Drizzle
 * renders an interpolated `${table.id}` as bare `"id"` **only when the query has a single
 * table in its FROM**; both of these join `users`, so both always qualified. Established
 * three ways: `toSQL()` on each real query shape, the same probe against a no-join
 * version (which does go bare), and reverting `accounts.ts` to its pre-#223 form, whose
 * suite then fails 3/3 while these two keep passing.
 *
 * So what is guarded here is the **dependency**, not a defect: remove the join from either
 * query and the identifier silently goes bare, binds `project_posts.id` — which exists —
 * and every count becomes a plausible constant with no error anywhere. That is precisely
 * how `accounts.ts` read 0 for months.
 *
 * ⚠️ This file covered a SECOND count until 2026-08-14: `jam_entries.entryCount`, on the
 * same reasoning. Jams were retired outright, so that half went with the feature. The
 * lesson is unchanged and now rests on one example instead of two — which is worth knowing
 * if the remaining one is ever refactored away, because then nothing guards the pattern.
 *
 * 🚨 **Each test asserts DISCRIMINATION between two rows, never one row's value.** The
 * broken form compares a column to itself, so it is independent of the outer row and
 * answers the same constant for every project. A single-row assertion against
 * separately-counted truth therefore passes whenever that constant happens to match — the
 * first draft of this file did exactly that and survived sabotage. Two rows with
 * different true counts cannot both equal one constant.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, projectPosts, projects, users } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

let seq = 0;
/** A minimal published post. Both join tables key on `posts`, not `works`. */
async function makePost(title: string): Promise<number> {
	seq += 1;
	const publicId = 900_000_000 + ((Date.now() % 90_000_000) + seq * 7919);
	const [row] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId,
			slug: `${title}-${publicId}`,
			title,
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning({ id: posts.id });
	madePosts.push(row.id);
	return row.id;
}

const SUFFIX = `dc${Date.now().toString(36)}`;
let creatorId: number;
const madeUsers: number[] = [];
const madeProjects: number[] = [];
const madePosts: number[] = [];

/** How many posts this project really has, counted straight rather than via the route. */
async function realPostCount(projectId: number): Promise<number> {
	const rows = await db
		.select({ id: projectPosts.id })
		.from(projectPosts)
		.where(eq(projectPosts.projectId, projectId));
	return rows.length;
}

beforeAll(async () => {
	const [u] = await db
		.insert(users)
		.values({
			username: `counts_${SUFFIX}`,
			email: `counts_${SUFFIX}@example.test`,
			passwordHash: "x",
			emailVerified: true,
			isCreator: true,
		})
		.returning({ id: users.id });
	creatorId = u.id;
	madeUsers.push(u.id);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// Projects first — their join rows cascade — then posts, then the user.
	// `posts.creator_id` is ON DELETE SET NULL, so removing the user would orphan them.
	if (madeProjects.length > 0) await db.delete(projects).where(inArray(projects.id, madeProjects));
	if (madePosts.length > 0) await db.delete(posts).where(inArray(posts.id, madePosts));
	if (madeUsers.length > 0) await db.delete(users).where(inArray(users.id, madeUsers));
});

describe("project listing — postCount", () => {
	it(
		"reports the project's own post count, not a row id that happens to match",
		async () => {
			const slug = `proj-${SUFFIX}`;
			const [proj] = await db
				.insert(projects)
				.values({ creatorId, title: "Counts", slug, description: "", isPublished: true })
				.returning({ id: projects.id });
			madeProjects.push(proj.id);

			// A SECOND project with a different number of posts. One project alone proves
			// nothing: the broken subquery is outer-row-independent, so it answers the same
			// constant for both, and a single-row assertion passes whenever that constant
			// happens to match.
			const slugB = `projb-${SUFFIX}`;
			const [projB] = await db
				.insert(projects)
				.values({ creatorId, title: "Counts B", slug: slugB, description: "", isPublished: true })
				.returning({ id: projects.id });
			madeProjects.push(projB.id);

			for (let i = 0; i < 3; i++) {
				const postId = await makePost(`proj-post-${i}`);
				await db.insert(projectPosts).values({ projectId: proj.id, postId, sortOrder: i });
			}
			const postIdB = await makePost("projb-post-0");
			await db.insert(projectPosts).values({ projectId: projB.id, postId: postIdB, sortOrder: 0 });

			const truthA = await realPostCount(proj.id);
			const truthB = await realPostCount(projB.id);
			expect({ a: truthA, b: truthB }).toEqual({ a: 3, b: 1 });

			const res = await app.request(`/api/content/projects?creator=counts_${SUFFIX}`, {
				headers: { Origin: "http://localhost:3000" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { projects?: Array<{ slug: string; postCount: number }> };
			const rowA = (body.projects ?? []).find((p) => p.slug === slug);
			const rowB = (body.projects ?? []).find((p) => p.slug === slugB);
			expect(rowA, "project A missing from listing").toBeDefined();
			expect(rowB, "project B missing from listing").toBeDefined();
			// The load-bearing assertion: two projects, two different counts, each its own.
			expect({ a: rowA?.postCount, b: rowB?.postCount }).toEqual({ a: truthA, b: truthB });
		},
		DB_SETUP_TIMEOUT,
	);
});
