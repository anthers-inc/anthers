// SPDX-License-Identifier: Apache-2.0
/**
 * Test fixtures for Works.
 *
 * A Work now carries a public identity (`slug` + `publicId`, both NOT NULL and unique) and
 * a visibility, so every suite that used to insert a bare `content_items` row needs the
 * same four extra fields. That is exactly the kind of repetition that drifts — one suite
 * quietly seeding a `private` Work and then asserting on a 404 it misattributes to access
 * — so it lives here once.
 *
 * `visibility` defaults to `released`, because a test asserting on access wants a Work the
 * public could in principle reach; a private Work is unreachable for a reason that has
 * nothing to do with the gates under test. Pass `visibility: "private"` explicitly when
 * staging is the thing being tested.
 */

import { afterAll } from "bun:test";
import { db } from "@anthers/db/client";
import type { SeedAccessRow } from "@anthers/db/schema";
import { works } from "@anthers/db/schema";
import { needsChosenThumbnail } from "@anthers/shared/content";
import type { DeclarableMaturity } from "@anthers/shared/content-rating";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq } from "drizzle-orm";
import { purgeWorkIds } from "./cleanup";

/**
 * Every Work this file's suites inserted, swept when the file ends.
 *
 * A Work written here exists for the account an erasure suite deletes as its test — and
 * `purgeAccountsCreatedHere` then cannot reach it, because reaching a Work through a
 * deleted account is precisely the impossibility those suites assert. The ids are tracked
 * at insert and taken back in `afterAll`, where a suite that bails early still runs them.
 *
 * 🚨 **Registered at MODULE scope, which is per test file.** Bun gives each file its own
 * instance of every import, so this list and this `afterAll` belong to the file that is
 * running — never to a neighbor — on the same sequential-file guarantee the other purges
 * in `cleanup.ts` carry.
 */
const insertedWorkIds: number[] = [];
afterAll(async () => {
	await purgeWorkIds(insertedWorkIds);
});

/**
 * A random starting point for this module instance, and a counter from there.
 *
 * 🚨 **The clock is not a source of uniqueness across test files, and using it as one made
 * `works_public_id_unique` fire.** This read `Date.now() % 800_000_000 + seq * 7919`, and
 * `seq` is per module — bun gives each test file its own instance — so two files whose first
 * `insertWork` lands in the same millisecond compute the *same* id from the same clock and
 * the same `seq` of 1. It is a race that gets likelier with every suite added, which is
 * exactly how it surfaced: it had been latent for months and started failing the run after
 * two new suites began inserting Works.
 *
 * A random base fixes it because two modules now have to land within a few dozen of each
 * other rather than within a millisecond of each other, which is four orders of magnitude
 * less likely. ⚠️ It is not a guarantee, and a guarantee would mean asking the database —
 * `makeUniquePublicId` in the route does exactly that, and a fixture helper that opened a
 * transaction to mint an id would cost every suite more than the collision does.
 */
const BASE = Math.floor(Math.random() * 800_000_000);
let seq = 0;

/** A unique 9-digit public id, in the same range the routes mint. */
export function testPublicId(): number {
	seq += 1;
	return 100_000_000 + ((BASE + seq) % 800_000_000);
}

export interface WorkFixture {
	creatorId: number;
	type: string;
	title?: string;
	slug?: string;
	description?: string;
	body?: string;
	bodyHtml?: string;
	lyrics?: string;
	sourceKey?: string;
	/**
	 * Defaults, for a video, to one under its creator's own prefix, because a fixture Work stands
	 * for one that was properly released and release refuses a video without a thumbnail its
	 * creator chose (`thumbnail_missing`). Pass `""` when that refusal is what is being tested.
	 */
	thumbnail?: string;
	/**
	 * The content rating. Defaults to a creator-declared `general`, because a fixture Work
	 * stands for one that was properly released and release is refused while a Work is
	 * `unrated` — a fixture defaulting to `unrated` would be an impossible state, and every
	 * suite that flips one to `released` would 409 for a reason that is not its subject.
	 * Pass `"unrated"` explicitly when the rating gate is what is being tested.
	 */
	maturity?: "unrated" | "general" | "mature" | "adult";
	maturityNotes?: string[];
	/**
	 * The rating matrix. Defaults to a complete one that adds up to `maturity`, because a rated
	 * Work has every row answered (Parker, 2026-09-18) and release refuses one that does not. Pass
	 * `{}` to stand for a Work rated before the matrix existed.
	 */
	maturityRows?: Record<string, string>;
	/** When scans were last enqueued for this Work — the release gate's clock. */
	scanQueuedAt?: Date | null;
	embedUrl?: string;
	durationSeconds?: number;
	visibility?: "private" | "released";
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	seedAccess?: SeedAccessRow[];
	authoredAt?: Date | null;
	authoredPrecision?: "year" | "month" | "day" | null;
	metadata?: Record<string, unknown>;
}

/** Insert a Work with the identity fields filled in. Returns the inserted row. */
export async function insertWork(fixture: WorkFixture) {
	const publicId = testPublicId();
	const slug = fixture.slug ?? `test-work-${publicId}`;
	const visibility = fixture.visibility ?? "released";
	const [row] = await db
		.insert(works)
		.values({
			creatorId: fixture.creatorId,
			publicId,
			slug,
			type: fixture.type,
			title: fixture.title ?? "Test Work",
			description: fixture.description ?? "",
			body: fixture.body ?? "",
			bodyHtml: fixture.bodyHtml ?? "",
			lyrics: fixture.lyrics ?? "",
			sourceKey: fixture.sourceKey ?? "",
			thumbnail:
				fixture.thumbnail ??
				(needsChosenThumbnail(fixture.type)
					? `creators/${fixture.creatorId}/thumbnails/fixture-${publicId}.jpg`
					: ""),
			maturity: fixture.maturity ?? "general",
			maturityNotes: fixture.maturityNotes ?? [],
			maturityRows:
				fixture.maturityRows ??
				((fixture.maturity ?? "general") === "unrated"
					? {}
					: rowsRatedAs((fixture.maturity ?? "general") as DeclarableMaturity)),
			maturitySource: (fixture.maturity ?? "general") === "unrated" ? null : "creator",
			maturitySetAt: (fixture.maturity ?? "general") === "unrated" ? null : new Date(),
			scanQueuedAt: fixture.scanQueuedAt ?? null,
			embedUrl: fixture.embedUrl ?? "",
			durationSeconds: fixture.durationSeconds ?? null,
			visibility,
			releasedAt: visibility === "released" ? new Date() : null,
			streamEnabled: fixture.streamEnabled ?? true,
			downloadEnabled: fixture.downloadEnabled ?? false,
			seedAccess: fixture.seedAccess ?? [],
			authoredAt: fixture.authoredAt ?? null,
			authoredPrecision: fixture.authoredPrecision ?? null,
			metadata: fixture.metadata ?? {},
		})
		.returning();
	insertedWorkIds.push(row.id);
	return row;
}

/**
 * Give a Work its file, as though the upload landed and processing finished long ago, and give
 * a video the thumbnail its creator would have chosen by then.
 *
 * A video, audio, image, comic or ebook Work is created with no file and refused release until
 * one arrives (`media_missing`), because the Studio creates the Work the moment its file is
 * picked, and a video is refused until it has a thumbnail (`thumbnail_missing`). A suite whose
 * subject is not the upload writes the keys straight onto the row rather than through `PATCH`:
 * the route would enqueue a transcode and a scan, pg-boss is not running under the test runner,
 * and a transcode left pending would refuse the release for a second reason that is not the
 * suite's subject either.
 */
export async function giveWorkAFile(workId: number): Promise<void> {
	const [row] = await db
		.select({ type: works.type, thumbnail: works.thumbnail })
		.from(works)
		.where(eq(works.id, workId));
	await db
		.update(works)
		.set({
			sourceKey: `creators/0/media/fixture-file-${workId}`,
			...(row && needsChosenThumbnail(row.type) && !row.thumbnail
				? { thumbnail: `creators/0/thumbnails/fixture-thumbnail-${workId}.jpg` }
				: {}),
		})
		.where(eq(works.id, workId));
}
