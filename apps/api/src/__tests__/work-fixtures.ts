// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { db } from "@anthers/db/client";
import type { SeedAccessRow } from "@anthers/db/schema";
import { works } from "@anthers/db/schema";

let seq = 0;

/** A unique 9-digit public id, in the same range the routes mint. */
export function testPublicId(): number {
	seq += 1;
	return 100_000_000 + (((Date.now() % 800_000_000) + seq * 7919) % 800_000_000);
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
	thumbnail?: string;
	/**
	 * The content rating. Defaults to a creator-declared `general`, because a fixture Work
	 * stands for one that was properly released and release is refused while a Work is
	 * `unrated` — a fixture defaulting to `unrated` would be an impossible state, and every
	 * suite that flips one to `released` would 409 for a reason that is not its subject.
	 * Pass `"unrated"` explicitly when the rating gate is what is being tested.
	 */
	maturity?: "unrated" | "general" | "mature";
	maturityNotes?: string[];
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
			thumbnail: fixture.thumbnail ?? "",
			maturity: fixture.maturity ?? "general",
			maturityNotes: fixture.maturityNotes ?? [],
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
	return row;
}
