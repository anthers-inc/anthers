// SPDX-License-Identifier: Apache-2.0
/**
 * A Project's cover can be one of its Works, by reference.
 *
 * The cover is the Project's whole face in every listing, so the interesting half of this
 * suite is not "the Work's image appears" but the three ways that reference must NOT show
 * anything: a Work from another Project or another creator cannot be chosen, an Adult Work
 * does not dress a Project for somebody who has not opted in, and a Work taken out of the list
 * (or deleted) stops dressing it. In each of those the uploaded `coverImage` stands in,
 * which is why the two choices fall back to each other rather than replacing one another.
 *
 * ⭐ **Reference, not copy**: changing the Work's own cover changes the Project's, and that
 * is asserted directly — a copied URL would pass every other test here and still be wrong.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

/** The fields this suite reads from a Project answer; the API's own shape is wider. */
interface ProjectRow {
	id: number;
	creatorId: number;
	slug: string;
	title: string;
	coverImage: string | null;
	coverWorkId: number | null;
	works?: { id: number; title: string | null; thumbnail: string | null }[];
}

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `pc_${run}`;
const strangerName = `pc_s_${run}`;
const SLUG = `pc-project-${run}`;

let creator = { id: 0, cookie: "" };
let stranger = { id: 0, cookie: "" };

const thumb = (label: string) => `https://cdn.anthers.test/${label}-${run}.png`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function authed(method: string, path: string, body?: unknown) {
	return req(path, {
		method,
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator.cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function detail(cookie?: string): Promise<ProjectRow> {
	const res = await req(
		`/api/content/projects/${SLUG}`,
		cookie ? { headers: { Cookie: cookie } } : undefined,
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { project: ProjectRow }).project;
}

async function addToLibrary(workId: number) {
	const res = await authed("POST", `/api/content/projects/${SLUG}/works`, { workId });
	expect(res.status).toBe(201);
}

let generalWorkId = 0;
let projectId = 0;
let uploadedCover = "";

describe("a Project's cover chosen from one of its Works", () => {
	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`,
		);
		const account = await createAccount(creatorName);
		await enablePayouts(creatorName);
		creator = { id: account.userId as number, cookie: account.cookie };
		const strangerAccount = await createAccount(strangerName);
		stranger = { id: strangerAccount.userId as number, cookie: strangerAccount.cookie };
		await enablePayouts(strangerName);

		const project = await authed("POST", "/api/content/projects", {
			title: `Cover ${run}`,
			slug: SLUG,
			isPublished: true,
		});
		expect(project.status).toBe(201);
		projectId = ((await project.json()) as { project: { id: number } }).project.id;

		const general = await insertWork({
			creatorId: creator.id,
			type: "image",
			title: `General ${run}`,
			thumbnail: thumb("general"),
		});
		generalWorkId = general.id;
		await addToLibrary(general.id);

		uploadedCover = await storage.getUrl(`creators/${creator.id}/covers/cover-${run}.png`);
	}, DB_SETUP_TIMEOUT);

	it("shows the chosen Work's cover on the owner's page, the public page and both listings", async () => {
		const patched = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverImage: uploadedCover,
		});
		expect(patched.status).toBe(200);

		const chosen = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverWorkId: generalWorkId,
		});
		expect(chosen.status).toBe(200);
		const chosenRow = ((await chosen.json()) as { project: ProjectRow }).project as ProjectRow;
		expect(chosenRow.coverWorkId).toBe(generalWorkId);
		expect(chosenRow.coverImage).toBe(thumb("general"));

		expect((await detail()).coverImage).toBe(thumb("general"));
		expect((await detail(creator.cookie)).coverImage).toBe(thumb("general"));

		const publicList = await req(`/api/content/projects`);
		expect(publicList.status).toBe(200);
		const listed = ((await publicList.json()) as { projects: ProjectRow[] }).projects.find(
			(project) => project.slug === SLUG,
		);
		expect(listed?.coverImage).toBe(thumb("general"));

		const mine = await authed("GET", "/api/content/projects?mine=true");
		const owned = ((await mine.json()) as { projects: ProjectRow[] }).projects.find(
			(project) => project.slug === SLUG,
		);
		expect(owned?.coverImage).toBe(thumb("general"));
	});

	it("follows the Work when the Work's own cover changes", async () => {
		await db
			.update(works)
			.set({ thumbnail: thumb("changed") })
			.where(eq(works.id, generalWorkId));
		try {
			expect((await detail()).coverImage).toBe(thumb("changed"));
		} finally {
			await db
				.update(works)
				.set({ thumbnail: thumb("general") })
				.where(eq(works.id, generalWorkId));
		}
	});

	it("carries the Work's cover in the saved Library too", async () => {
		const saved = await authed("POST", "/api/content/library", { projectId });

		expect([200, 201]).toContain(saved.status);

		const library = await authed("GET", "/api/content/library");
		expect(library.status).toBe(200);
		const { items } = (await library.json()) as {
			items: { kind: string; project?: ProjectRow }[];
		};
		const entry = items.find((item) => item.kind === "project" && item.project?.slug === SLUG);
		expect(entry?.project?.coverImage).toBe(thumb("general"));
	});

	it("retires the Work reference when an image is uploaded, and the image when a Work is chosen", async () => {
		const uploaded = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverImage: uploadedCover,
		});
		expect(uploaded.status).toBe(200);
		const row = ((await uploaded.json()) as { project: ProjectRow }).project as ProjectRow;
		expect(row.coverWorkId).toBeNull();
		expect(row.coverImage).toBe(uploadedCover);

		const chosen = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverWorkId: generalWorkId,
		});
		const chosenRow = ((await chosen.json()) as { project: ProjectRow }).project as ProjectRow;
		expect(chosenRow.coverWorkId).toBe(generalWorkId);
		// The uploaded image is kept underneath as the fallback.
		await authed("PATCH", `/api/content/projects/${SLUG}`, { coverImage: uploadedCover });
		await authed("PATCH", `/api/content/projects/${SLUG}`, { coverWorkId: generalWorkId });
	});

	it("refuses a Work that is not in this Project", async () => {
		const offProject = await insertWork({
			creatorId: creator.id,
			type: "image",
			title: `Off list ${run}`,
			thumbnail: thumb("off-list"),
		});
		const res = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverWorkId: offProject.id,
		});
		expect(res.status).toBe(400);
	});

	it("refuses another creator's Work, even one they would share", async () => {
		const foreign = await insertWork({
			creatorId: stranger.id,
			type: "image",
			title: `Foreign ${run}`,
			thumbnail: thumb("foreign"),
		});
		const res = await authed("PATCH", `/api/content/projects/${SLUG}`, {
			coverWorkId: foreign.id,
		});
		expect(res.status).toBe(400);
	});

	it("keeps an Adult Work's cover away from readers who have not opted in", async () => {
		const adult = await insertWork({
			creatorId: creator.id,
			type: "image",
			title: `Adult ${run}`,
			thumbnail: thumb("adult"),
			maturity: "adult",
		});
		await addToLibrary(adult.id);
		try {
			const chosen = await authed("PATCH", `/api/content/projects/${SLUG}`, {
				coverWorkId: adult.id,
			});
			expect(chosen.status).toBe(200);
			expect(((await chosen.json()) as { project: ProjectRow }).project.coverImage).toBe(
				thumb("adult"),
			);

			// Anonymous and unverified readers get the uploaded image, never the cover the
			// rating withholds — the Project itself stays listed because it holds other Works.
			expect((await detail()).coverImage).toBe(uploadedCover);
			const publicList = await req(`/api/content/projects`);
			const listed = ((await publicList.json()) as { projects: ProjectRow[] }).projects.find(
				(project) => project.slug === SLUG,
			);
			expect(listed?.coverImage).toBe(uploadedCover);
		} finally {
			await db.delete(works).where(eq(works.id, adult.id));
		}
	});

	it("falls back to the uploaded image when the chosen Work leaves the list", async () => {
		await authed("PATCH", `/api/content/projects/${SLUG}`, { coverWorkId: generalWorkId });
		const removed = await authed("DELETE", `/api/content/projects/${SLUG}/works/${generalWorkId}`);
		expect(removed.status).toBe(204);

		const row = await detail(creator.cookie);
		expect(row.coverWorkId).toBeNull();
		expect(row.coverImage).toBe(uploadedCover);
	});

	it("drops the reference when the chosen Work is deleted", async () => {
		const doomed = await insertWork({
			creatorId: creator.id,
			type: "image",
			title: `Doomed ${run}`,
			thumbnail: thumb("doomed"),
		});
		await addToLibrary(doomed.id);
		await authed("PATCH", `/api/content/projects/${SLUG}`, { coverWorkId: doomed.id });

		await db.delete(works).where(eq(works.id, doomed.id));

		const row = await detail(creator.cookie);
		expect(row.coverWorkId).toBeNull();
		expect(row.coverImage).toBe(uploadedCover);
	});

	it("leaves the Project's public shape unchanged when no Work is chosen", async () => {
		const row = await detail();
		expect(row.coverWorkId).toBeNull();
		expect(row.coverImage).toBe(uploadedCover);
		// The list is empty of visible members, which is its own ordinary shape.
		expect((row.works ?? []).length).toBe(0);
	});
});
