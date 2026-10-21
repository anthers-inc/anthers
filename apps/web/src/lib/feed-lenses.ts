// SPDX-License-Identifier: Apache-2.0
/**
 * Turning the Network's feed into the corpus its lenses draw on.
 *
 * A lens is a view over a corpus, and the corpus is the tab's: the Library's lenses draw
 * on the shelf, the Network's draw on the feed. The two are different *shapes* of the same
 * fact, and this module is the one translation between a feed entry and the `LensItem` the
 * Music Player and Bookshelf lenses render.
 *
 * ⭐ **Only releases are items.** A lens organizes Works; a post is not a Work and has no
 * shape in one, exactly as it sits out the Library's lenses. A feed post announcing an
 * album is how a reader hears about it, not a second copy of the record.
 *
 * 🚨 **The feed ships no payload, so the lens composes the delivery address.** A feed
 * entry carries the card and the access verdict, never a transcode URL — the rule the
 * route states and the tile preview already obeys (`lib/tile-preview.ts`). A listened
 * Work therefore gets `transcoding.outputFileUrl` from `previewSourceFor`, which is the
 * `/api/content/works/:id/audio` endpoint: the address re-resolves access on every
 * request, so holding it in a queue is safe for exactly the reason `tracks.ts` gives.
 * Nothing here is a signed URL and nothing caches bytes.
 */
import { isListened } from "@anthers/shared/content";
import type { AccessResult, Work, WorkRelease } from "@anthers/web-shared/types";
import type { LensItem } from "../components/library/MusicLens";
import { previewSourceFor } from "./tile-preview";

/**
 * The feed entry as this translation reads it — the page's own entry type is an index
 * signature, so the fields arrive unknown and are narrowed here rather than cast at the
 * call site.
 */
export interface FeedLensEntry {
	kind: "post" | "release";
	id: number;
	type?: unknown;
	access?: unknown;
	releases?: unknown;
	creator?: unknown;
}

function isAccessResult(value: unknown): value is AccessResult {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function creatorOf(value: unknown): {
	handle: string | null;
	displayName: string | null;
	avatar: string | null;
} | null {
	if (!value || typeof value !== "object") return null;
	const creator = value as { handle?: unknown; displayName?: unknown; avatar?: unknown };
	return {
		handle: typeof creator.handle === "string" ? creator.handle : null,
		displayName: typeof creator.displayName === "string" ? creator.displayName : null,
		avatar: typeof creator.avatar === "string" ? creator.avatar : null,
	};
}

/**
 * The feed's releases as the lenses' corpus, in feed order.
 *
 * Each entry becomes an unsaved, unhidden item — the Network is what arrived, not what a
 * reader kept, so `purchased` and `hidden` have no meaning here and stay false. The
 * creator's display surface is flattened onto the Work because that is the shape the
 * lenses read a channel or an artist from.
 */
export function feedLensItems(entries: readonly FeedLensEntry[]): LensItem[] {
	const items: LensItem[] = [];
	for (const entry of entries) {
		if (entry.kind !== "release") continue;
		const type = typeof entry.type === "string" ? entry.type : "";
		// A Work type is what every lens keys on; an entry without one cannot be drawn.
		if (!type) continue;
		const creator = creatorOf(entry.creator);
		const access = isAccessResult(entry.access) ? entry.access : null;
		const work = {
			...entry,
			type,
			creatorHandle: creator?.handle ?? null,
			creatorDisplayName: creator?.displayName ?? null,
			creatorAvatar: creator?.avatar ?? null,
			// The published Projects the Work belongs to — what groups a track under its
			// release. The feed sends metadata only, as the shelf does.
			releases: Array.isArray(entry.releases) ? (entry.releases as WorkRelease[]) : [],
			// The commons, read off the verdict rather than fetched: a free, streaming,
			// released Work is what draws the Public Access allowance (the serializer's
			// own rule for `publicAccess`), and the feed's Works are released by query.
			publicAccess: !!access?.isFree && !!access.streamEnabled,
			// See the file docblock: the delivery endpoint, composed rather than shipped.
			...(isListened(type)
				? { transcoding: { outputFileUrl: previewSourceFor({ id: entry.id, type }) } }
				: {}),
		} as unknown as Work;
		items.push({ id: entry.id, kind: "work", hidden: false, purchased: false, work });
	}
	return items;
}
