// SPDX-License-Identifier: Apache-2.0
/**
 * The words a Work, a post and a profile hand a reader that runs no JavaScript.
 *
 * These endpoints are the API half of the documents' `<noscript>` bodies, so what this suite
 * exists to keep true is the pair of things a body endpoint can get wrong without failing
 * anything else:
 *
 * 1. **The gate is the card's gate.** An Adult Work, a withdrawn Work, a suspended creator, a
 *    draft post and a private Project are all absent from the page; a body endpoint that
 *    answered any of them would put back the existence (or the words) the page withholds,
 *    to an audience that never signed in.
 * 2. **A creator's text is text.** The fragment is injected into a served document without
 *    React, so a title or bio containing markup has to read as what its author typed rather
 *    than become structure.
 *
 * The view count is asserted too: this read sits on the document path, and an unfurl or a
 * crawler asking for the body is not somebody opening the page.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, projectItems, projects, users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { suspendAccount } from "../services/moderation";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;
function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);

let creatorId: number;
let creatorHandle: string;

beforeAll(async () => {
	const account = await createAccount(`reader_body_${run}`, {
		fields: {
			creatorMode: true,
			displayName: "A Reader Fixture",
			bio: "Composing, drawing and building a garden.",
		},
	});
	creatorId = account.userId;
	creatorHandle = account.handle;
}, DB_SETUP_TIMEOUT);

async function aWork(overrides: Partial<WorkFixture> = {}) {
	return insertWork({
		creatorId,
		type: "text",
		title: "A Quiet Year",
		description: "A short game about a garden that keeps growing.",
		bodyHtml: "<p>The work's own gated words.</p>",
		...overrides,
	});
}

const workPath = (work: { slug: string; publicId: number }) =>
	`/api/content/works/${work.slug}-${work.publicId}/reader`;

async function aPost(overrides: Partial<typeof posts.$inferInsert> = {}) {
	const [post] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId: testPublicId(),
			slug: `reader-body-${run}-${crypto.randomUUID().slice(0, 6)}`,
			title: "Hello, there",
			body: "A short note about the garden.",
			isPublished: true,
			publishedAt: new Date(),
			...overrides,
		})
		.returning();
	return post!;
}

const postPath = (post: { slug: string; publicId: number }) =>
	`/api/content/posts/${post.slug}-${post.publicId}/reader`;

async function aProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
	const [project] = await db
		.insert(projects)
		.values({
			creatorId,
			slug: `reader-project-${run}-${crypto.randomUUID().slice(0, 6)}`,
			title: "The Garden",
			description: "Everything grown so far.",
			isPublished: true,
			...overrides,
		})
		.returning();
	return project!;
}

/** Put one Work in a Project, which is what the listing's visibility rule reads. */
async function showInProject(projectId: number, workId: number, sortOrder = 0) {
	await db.insert(projectItems).values({ projectId, workId, sortOrder });
}

describe("GET /works/:id/reader", () => {
	it(
		"renders the Work's public words, its byline and its kind",
		async () => {
			const work = await aWork();
			const res = await req(workPath(work));
			expect(res.status).toBe(200);
			const { body } = (await res.json()) as { body: string };

			expect(body).toContain("<h1>A Quiet Year</h1>");
			expect(body).toContain(
				`<a href="/@${encodeURIComponent(creatorHandle)}">A Reader Fixture</a>`,
			);
			expect(body).toContain("A short game about a garden that keeps growing.");
			expect(body).toContain("Writing");
			expect(body).toContain("Released");
			// The gated body is the deliverable, not the blurb: a reader with no session has
			// not opened it, and the body endpoint must not hand it over because it can.
			expect(body).not.toContain("The work's own gated words.");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"keeps a Mature Work readable and names the rating, while an Adult Work stays absent",
		async () => {
			const mature = await aWork({ maturity: "mature", maturityNotes: ["violence"] });
			const matureRes = await req(workPath(mature));
			expect(matureRes.status).toBe(200);
			const { body } = (await matureRes.json()) as { body: string };
			expect(body).toContain("Mature");
			expect(body).toContain("Violence");

			const adult = await aWork({ maturity: "adult" });
			expect((await req(workPath(adult))).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a Work that is not released, exactly as the page does",
		async () => {
			const privateWork = await aWork({ visibility: "private" });
			expect((await req(workPath(privateWork))).status).toBe(404);

			const withdrawn = await aWork();
			await db.update(works).set({ visibility: "withdrawn" }).where(eq(works.id, withdrawn.id));
			expect((await req(workPath(withdrawn))).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"counts no view — a reader body is not somebody opening the page",
		async () => {
			const work = await aWork();
			const before = (
				await db.select({ viewCount: works.viewCount }).from(works).where(eq(works.id, work.id))
			)[0]!.viewCount;
			await req(workPath(work));
			const after = (
				await db.select({ viewCount: works.viewCount }).from(works).where(eq(works.id, work.id))
			)[0]!.viewCount;
			expect(after).toBe(before);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"escapes markup a creator wrote rather than making it structure",
		async () => {
			const work = await aWork({
				title: "<script>alert(1)</script>",
				description: "<b>not bold</b>",
			});
			const { body } = (await (await req(workPath(work))).json()) as { body: string };
			expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
			expect(body).toContain("&lt;b&gt;not bold&lt;/b&gt;");
			expect(body).not.toContain("<script>");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"answers a Work it does not have with the card's own 404",
		async () => {
			expect((await req("/api/content/works/no-such-work-999/reader")).status).toBe(404);
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("GET /posts/:slug/reader", () => {
	it(
		"renders the post's heading, byline and full markdown body",
		async () => {
			const post = await aPost({
				body: "A **bold** note.\n\n||the ending||\n\n- one\n- two",
			});
			const res = await req(postPath(post));
			expect(res.status).toBe(200);
			const { body } = (await res.json()) as { body: string };

			expect(body).toContain("<h1>Hello, there</h1>");
			expect(body).toContain("A Reader Fixture");
			expect(body).toContain("<strong>bold</strong>");
			// The spoiler convention is the write boundary's, and the body carries it rather
			// than printing the pipes or the ending in the open.
			expect(body).toContain('<span class="spoiler">the ending</span>');
			expect(body).toContain("<li>one</li>");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a draft and a suspended author's post, as the permalink does",
		async () => {
			const draft = await aPost({ isPublished: false, publishedAt: null });
			expect((await req(postPath(draft))).status).toBe(404);

			const author = await createAccount(`reader_body_susp_${run}`, {
				fields: { creatorMode: true },
			});
			const operator = await createAdminFixture("reader-body-op");
			const post = await aPost({
				creatorId: author.userId,
				slug: `reader-body-susp-${run}`,
				publicId: testPublicId(),
			});
			expect((await req(postPath(post))).status).toBe(200);
			await suspendAccount({
				userId: author.userId,
				adminId: operator.id,
				reason: "spam",
				note: "fixture",
			});
			expect((await req(postPath(post))).status).toBe(404);
			await db.update(users).set({ suspendedAt: null }).where(eq(users.id, author.userId));
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"counts no view",
		async () => {
			const post = await aPost();
			const views = async () =>
				(
					await db.select({ viewCount: posts.viewCount }).from(posts).where(eq(posts.id, post.id))
				)[0]!.viewCount;
			const before = await views();
			await req(postPath(post));
			expect(await views()).toBe(before);
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("GET /accounts/users/:handle/reader", () => {
	it(
		"renders the profile's name, handle, bio and published Projects",
		async () => {
			const work = await aWork();
			const project = await aProject();
			await showInProject(project.id, work.id);

			const res = await req(`/api/accounts/users/${creatorHandle}/reader`);
			expect(res.status).toBe(200);
			const { body } = (await res.json()) as { body: string };

			expect(body).toContain("<h1>A Reader Fixture</h1>");
			expect(body).toContain(`@${creatorHandle}`);
			expect(body).toContain("Composing, drawing and building a garden.");
			expect(body).toContain("The Garden");
			expect(body).toContain(`href="/projects/${project.slug}"`);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"leaves out a private Project and one whose only Work is Adult",
		async () => {
			await aProject({ title: "Unfinished", isPublished: false });
			const adultWork = await aWork({ maturity: "adult", title: "The Adult Work" });
			const adultProject = await aProject({ title: "Only Adult Work" });
			await showInProject(adultProject.id, adultWork.id);

			const { body } = (await (
				await req(`/api/accounts/users/${creatorHandle}/reader`)
			).json()) as { body: string };
			expect(body).not.toContain("Unfinished");
			expect(body).not.toContain("Only Adult Work");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"hides a suspended account",
		async () => {
			const author = await createAccount(`reader_body_prof_susp_${run}`, {
				fields: { creatorMode: true },
			});
			const operator = await createAdminFixture("reader-body-profile-op");
			expect((await req(`/api/accounts/users/${author.handle}/reader`)).status).toBe(200);
			await suspendAccount({
				userId: author.userId,
				adminId: operator.id,
				reason: "spam",
				note: "fixture",
			});
			expect((await req(`/api/accounts/users/${author.handle}/reader`)).status).toBe(404);
			await db.update(users).set({ suspendedAt: null }).where(eq(users.id, author.userId));
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"escapes a bio that contains markup",
		async () => {
			const account = await createAccount(`reader_body_escape_${run}`, {
				fields: { creatorMode: true, bio: "<img src=x onerror=alert(1)>" },
			});
			const { body } = (await (
				await req(`/api/accounts/users/${account.handle}/reader`)
			).json()) as { body: string };
			expect(body).not.toContain("<img");
			expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
		},
		DB_SETUP_TIMEOUT,
	);
});
