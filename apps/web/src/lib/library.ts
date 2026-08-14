// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the signed-in user has kept, browser side.
 *
 * A module-level store rather than per-button state, for the reason the Catalog makes
 * obvious: a page can show forty Works, each with a Save control, and forty components
 * each asking the server whether *this* one is saved is forty requests to answer one
 * question. The shelf is fetched once and every button reads it.
 *
 * Same shape as `lib/public-access.ts`, and for the same second reason: saving from one
 * surface has to change the button on another. Press Save on a Work page, navigate to the
 * album, and the track row must already know.
 *
 * 🚨 **This knows nothing about access.** A saved Work may be perfectly unopenable — the
 * shelf is curation and the gate is separate, which is enforced server-side and stated on
 * the table. Never infer "can play" from "is saved".
 */

import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** Which shelf entries exist, by subject — enough to render every Save button. */
export interface ShelfIndex {
	/** Work id → library item id. */
	works: Map<number, number>;
	/** Project id → library item id. */
	projects: Map<number, number>;
}

const EMPTY: ShelfIndex = { works: new Map(), projects: new Map() };

let current: ShelfIndex | null = null;
const listeners = new Set<(s: ShelfIndex) => void>();
let inFlight: Promise<void> | null = null;

function publish(next: ShelfIndex) {
	current = next;
	for (const fn of listeners) fn(next);
}

interface ShelfRow {
	id: number;
	kind: "work" | "project";
	work?: { id: number } | null;
	project?: { id: number } | null;
}

async function load(): Promise<void> {
	try {
		// `hidden=1`: a hidden entry is still saved, so a Save button must show it as
		// saved. Reading only the visible shelf would offer to save something already
		// there and quietly un-hide it, which looks like the button doing the wrong thing.
		const res = await client.api.content.library.$get({ query: { hidden: "1" } });
		if (!res.ok) return publish(EMPTY);
		const { items } = (await res.json()) as unknown as { items: ShelfRow[] };
		const next: ShelfIndex = { works: new Map(), projects: new Map() };
		for (const item of items) {
			if (item.work) next.works.set(item.work.id, item.id);
			else if (item.project) next.projects.set(item.project.id, item.id);
		}
		publish(next);
	} catch {
		// A shelf we cannot read is not worth an error state on every card — the buttons
		// render as "not saved", and pressing one is idempotent server-side.
		publish(EMPTY);
	}
}

/** Re-read the shelf. Call after anything that changes it outside this module. */
export function refreshShelf(): void {
	inFlight ??= load().finally(() => {
		inFlight = null;
	});
}

/** The shelf index, loading it on first use. */
export function useShelf(): ShelfIndex {
	const [shelf, setShelf] = useState<ShelfIndex>(current ?? EMPTY);

	useEffect(() => {
		listeners.add(setShelf);
		if (current) setShelf(current);
		else refreshShelf();
		return () => {
			listeners.delete(setShelf);
		};
	}, []);

	return shelf;
}

/** Save a Work. Idempotent, and brings back one that was hidden. */
export async function saveWork(workId: number): Promise<boolean> {
	const res = await client.api.content.library.$post({ json: { workId } });
	if (res.ok) refreshShelf();
	return res.ok;
}

/** Save a Project — an album, a series — as one thing rather than as its members. */
export async function saveProject(projectId: number): Promise<boolean> {
	const res = await client.api.content.library.$post({ json: { projectId } });
	if (res.ok) refreshShelf();
	return res.ok;
}

/**
 * Un-save an entry.
 *
 * Returns `"purchased"` when the server refuses because it was bought — that is not an
 * error to swallow, it is the one case where the caller must offer *hide* instead.
 */
export async function removeItem(itemId: number): Promise<"ok" | "purchased" | "failed"> {
	const res = await client.api.content.library[":id"].$delete({ param: { id: String(itemId) } });
	if (res.ok) {
		refreshShelf();
		return "ok";
	}
	if (res.status === 409) return "purchased";
	return "failed";
}

/** Tidy an entry away, or bring it back. Never loses anything. */
export async function setHidden(itemId: number, hidden: boolean): Promise<boolean> {
	const res = await client.api.content.library[":id"].$patch({
		param: { id: String(itemId) },
		json: { hidden },
	});
	if (res.ok) refreshShelf();
	return res.ok;
}
