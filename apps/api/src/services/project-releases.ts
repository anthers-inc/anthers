// SPDX-License-Identifier: Apache-2.0
/**
 * The release membership a Work carries: the published Project it belongs to, described
 * well enough to draw the release card a lens groups it under — cover, artist, title and
 * how many released members it holds.
 *
 * Two listings carry these: the **Library**, so a saved track groups under the
 * record it came from rather than standing as a loose row, and the **Network feed**, so a
 * newly released track takes its place in that same release in the Music Player lens.
 *
 * Deliberately metadata only. The Project's member list is fetched when somebody opens
 * or plays the release, never shipped with a listing — a Library request must not ship
 * every member of every Project one saved track touches, and a feed request must not
 * either.
 *
 * Only published Projects are listed. A draft Project is its creator's own business, so
 * a released Work inside one does not advertise the draft to a stranger; suspended and
 * automated-test creators' rows drop for the same reason the Project listings drop them.
 *
 * 🚨 **The counts are the viewer's counts.** They are taken with the same Adult and
 * parental visibility conditions the calling listing applied to the Works themselves, so
 * a release never advertises a track the reader will not find inside it.
 */

import { db } from "@anthers/db/client";
import { projectItems, projects, users, works } from "@anthers/db/schema";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { notSuspendedAccount, notTestAccount } from "./account-visibility.js";

/** The visibility conditions a listing has already resolved for this viewer. */
export interface ReleaseVisibility {
	/** `adultVisibility(userId).hidden` — the Adult rung's allow-list. */
	adultHidden: SQL | undefined;
	/** `parentalVisibility(userId).hidden` — a guardian's blocks. */
	parentalHidden: SQL | undefined;
}

/** One release, as a lens card reads it. Mirrors `WorkRelease` in `@anthers/web-shared`. */
export interface ReleaseMembership {
	id: number;
	slug: string;
	title: string;
	thumbnail: string | null;
	creatorId: number | null;
	creatorHandle: string | null;
	creatorDisplayName: string | null;
	/** How many released Works the Project holds, among those this viewer may see. */
	workCount: number;
	/** How many of those are music — what the release card advertises as tracks. */
	musicCount: number;
	/** How many are spoken word. The include-spoken dial adds these to a release. */
	audioCount: number;
}

/** One Project's released-member counts. */
export type ReleaseCounts = Pick<ReleaseMembership, "workCount" | "musicCount" | "audioCount">;

/**
 * Released-member counts for each Project named, as this viewer may see them.
 *
 * A Project that holds no members this viewer can see is absent from the map, which the
 * callers read as zero.
 */
export async function releaseCounts(
	projectIds: number[],
	visibility: ReleaseVisibility,
): Promise<Map<number, ReleaseCounts>> {
	if (projectIds.length === 0) return new Map();
	const rows = await db
		.select({
			projectId: projectItems.projectId,
			workCount: sql<number>`count(*)::int`,
			musicCount: sql<number>`count(*) filter (where ${works.type} = 'music')::int`,
			audioCount: sql<number>`count(*) filter (where ${works.type} = 'audio')::int`,
		})
		.from(projectItems)
		.innerJoin(works, eq(projectItems.workId, works.id))
		.where(
			and(
				inArray(projectItems.projectId, projectIds),
				eq(works.visibility, "released"),
				// Counted the way the Project page lists them, so a release never claims a
				// track the user will not find inside it.
				visibility.adultHidden,
				visibility.parentalHidden,
			),
		)
		.groupBy(projectItems.projectId);
	return new Map(rows.map((row) => [row.projectId, row]));
}

/**
 * The published Projects each of these Works belongs to, keyed by Work id.
 *
 * A Project holding no music is left out: it is not a release in this family of lenses.
 * A podcast series stays a series, and its episodes are one-track releases like any
 * other spoken-word Work.
 */
export async function releasesByWorkId(
	workIds: number[],
	visibility: ReleaseVisibility,
): Promise<{ byWork: Map<number, ReleaseMembership[]>; counts: Map<number, ReleaseCounts> }> {
	const byWork = new Map<number, ReleaseMembership[]>();
	if (workIds.length === 0) return { byWork, counts: new Map() };

	const rows = await db
		.select({
			workId: projectItems.workId,
			projectId: projects.id,
			slug: projects.slug,
			title: projects.title,
			thumbnail: projects.thumbnail,
			creatorId: projects.creatorId,
			creatorHandle: users.atprotoHandle,
			creatorDisplayName: users.displayName,
		})
		.from(projectItems)
		.innerJoin(projects, eq(projects.id, projectItems.projectId))
		.leftJoin(users, eq(projects.creatorId, users.id))
		.where(
			and(
				inArray(projectItems.workId, workIds),
				eq(projects.isPublished, true),
				notSuspendedAccount(projects.creatorId),
				notTestAccount(projects.creatorId),
			),
		)
		.orderBy(asc(projectItems.projectId), asc(projectItems.sortOrder));

	const projectIds = [...new Set(rows.map((row) => row.projectId))];
	const counts = await releaseCounts(projectIds, visibility);
	for (const row of rows) {
		const count = counts.get(row.projectId);
		// A Project with no music is not a release in this lens. A saved or newly released
		// podcast episode stays a one-track release rather than joining its series.
		if (!count || count.musicCount === 0) continue;
		const release: ReleaseMembership = {
			id: row.projectId,
			slug: row.slug,
			title: row.title,
			thumbnail: row.thumbnail,
			creatorId: row.creatorId,
			creatorHandle: row.creatorHandle,
			creatorDisplayName: row.creatorDisplayName,
			...count,
		};
		const list = byWork.get(row.workId) ?? [];
		list.push(release);
		byWork.set(row.workId, list);
	}
	return { byWork, counts };
}
