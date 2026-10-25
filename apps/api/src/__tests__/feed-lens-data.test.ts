// SPDX-License-Identifier: Apache-2.0
/**
 * The feed's release memberships — what lets the Network's Music Player lens group a
 * newly released track under its record the way the Library's groups a saved one.
 *
 * The feed ships metadata only: the Project's card fields and the released-member counts,
 * never its members. This suite pins the membership and the one exclusion that keeps the
 * lens honest — a Project holding no music is not a release, so an episode of a podcast
 * series stays a one-track release rather than joining the series.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { projectItems, projects, works } from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

function feed(cookie: string) {
	return app.fetch(
		new Request("http://localhost/api/accounts/me/feed", {
			headers: { Origin: ORIGIN, Cookie: cookie },
		}),
	);
}

interface FeedRelease {
	kind: "post" | "release";
	id: number;
	title: string;
	releases?: Array<{ id: number; title: string; musicCount: number; workCount: number }>;
}

let cookie = "";
let creatorId = 0;
const workIds: number[] = [];
const projectIds: number[] = [];

beforeAll(async () => {
	const creator = await createAccount(`feedlens_${run}`, { fields: { creatorMode: true } });
	cookie = creator.cookie;
	creatorId = creator.userId;

	const album = await insertWork({ creatorId, type: "music", title: `Album track ${run}` });
	const series = await insertWork({ creatorId, type: "music", title: `Series theme ${run}` });
	const prose = await insertWork({ creatorId, type: "text", title: `Prose ${run}` });
	workIds.push(album.id, series.id, prose.id);

	const [record] = await db
		.insert(projects)
		.values({
			creatorId,
			slug: `feedlens-record-${run}`,
			title: `The Record ${run}`,
			description: "",
			isPublished: true,
		})
		.returning({ id: projects.id });
	const [podcast] = await db
		.insert(projects)
		.values({
			creatorId,
			slug: `feedlens-podcast-${run}`,
			title: `The Series ${run}`,
			description: "",
			isPublished: true,
		})
		.returning({ id: projects.id });
	projectIds.push(record.id, podcast.id);
	await db.insert(projectItems).values([
		{ projectId: record.id, workId: album.id, sortOrder: 0 },
		{ projectId: podcast.id, workId: prose.id, sortOrder: 0 },
	]);
});

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.id, projectIds));
});

describe("the feed's release memberships", () => {
	it("groups a released track under its published Project, with the viewer's counts", async () => {
		const res = await feed(cookie);
		expect(res.status).toBe(200);
		const { entries } = (await res.json()) as { entries: FeedRelease[] };
		const track = entries.find((entry) => entry.title === `Album track ${run}`);
		expect(track, "the released track is in the feed").toBeDefined();

		expect(track!.releases).toHaveLength(1);
		expect(track!.releases![0]).toMatchObject({
			id: projectIds[0],
			title: `The Record ${run}`,
			workCount: 1,
			musicCount: 1,
		});
	});

	it("leaves a Project holding no music out: a series is not a record", async () => {
		const res = await feed(cookie);
		const { entries } = (await res.json()) as { entries: FeedRelease[] };
		const prose = entries.find((entry) => entry.title === `Prose ${run}`);
		const album = entries.find((entry) => entry.title === `Album track ${run}`);
		expect(prose, "the released text Work is in the feed").toBeDefined();

		// Named beside a release that did get its membership, so an empty translation
		// fails here rather than passing as "nothing to exclude".
		expect(album!.releases).toHaveLength(1);
		expect(prose!.releases).toEqual([]);
	});
});
