// SPDX-License-Identifier: Apache-2.0
/**
 * What the signed-in user has kept, browser side.
 *
 * A module-level store rather than per-button state, for the reason the Catalog makes
 * obvious: a page can show forty Works, each with a Save control, and forty components
 * each asking the server whether *this* one is saved is forty requests to answer one
 * question. The Library is fetched once and every button reads it.
 *
 * Same shape as `lib/public-access.ts`, and for the same second reason: saving from one
 * surface has to change the button on another. Press Save on a Work page, navigate to the
 * album, and the track row must already know.
 *
 * 🚨 **This knows nothing about access.** A saved Work may be perfectly unopenable — the
 * Library is curation and the gate is separate, which is enforced server-side and stated on
 * the table. Never infer "can play" from "is saved".
 */

import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** Which Library entries exist, by subject — enough to render every Save button. */
export interface LibraryIndex {
	/** Work id → library item id. */
	works: Map<number, number>;
	/** Project id → library item id. */
	projects: Map<number, number>;
	/** Post id → library item id. A post is saved like anything else (2026-10-11). */
	posts: Map<number, number>;
}

const EMPTY: LibraryIndex = { works: new Map(), projects: new Map(), posts: new Map() };

let current: LibraryIndex | null = null;
const listeners = new Set<(s: LibraryIndex) => void>();
let inFlight: Promise<void> | null = null;

function publish(next: LibraryIndex) {
	current = next;
	for (const fn of listeners) fn(next);
}

interface LibraryRow {
	id: number;
	kind: "work" | "project" | "post";
	work?: { id: number } | null;
	project?: { id: number } | null;
	post?: { id: number } | null;
}

async function load(): Promise<void> {
	try {
		// `hidden=1`: a hidden entry is still saved, so a Save button must show it as
		// saved. Reading only the visible Library would offer to save something already
		// there and quietly un-hide it, which looks like the button doing the wrong thing.
		const res = await client.api.content.library.$get({ query: { hidden: "1" } });
		if (!res.ok) return publish(EMPTY);
		const { items } = (await res.json()) as unknown as { items: LibraryRow[] };
		const next: LibraryIndex = { works: new Map(), projects: new Map(), posts: new Map() };
		for (const item of items) {
			if (item.work) next.works.set(item.work.id, item.id);
			else if (item.project) next.projects.set(item.project.id, item.id);
			else if (item.post) next.posts.set(item.post.id, item.id);
		}
		publish(next);
	} catch {
		// A Library we cannot read is not worth an error state on every card — the buttons
		// render as "not saved", and pressing one is idempotent server-side.
		publish(EMPTY);
	}
}

/** Re-read the Library. Call after anything that changes it outside this module. */
export function refreshLibrary(): void {
	// An explicit read rather than `??=`, which Biome counts as a write only and so reports
	// this guard as unused — and its suggested fix would delete it.
	if (inFlight) return;
	inFlight = load().finally(() => {
		inFlight = null;
	});
}

/** The Library index, loading it on first use. */
export function useLibrary(): LibraryIndex {
	const [library, setLibrary] = useState<LibraryIndex>(current ?? EMPTY);

	useEffect(() => {
		listeners.add(setLibrary);
		if (current) setLibrary(current);
		else refreshLibrary();
		return () => {
			listeners.delete(setLibrary);
		};
	}, []);

	return library;
}

/** Save a Work. Idempotent, and brings back one that was hidden. */
export async function saveWork(workId: number): Promise<boolean> {
	const res = await client.api.content.library.$post({ json: { workId } });
	if (res.ok) refreshLibrary();
	return res.ok;
}

/** Save a Post — a keep like any other, since Save is the one keep action (2026-10-11). */
export async function savePost(postId: number): Promise<boolean> {
	const res = await client.api.content.library.$post({ json: { postId } });
	if (res.ok) refreshLibrary();
	return res.ok;
}

/** Save a Project — an album, a series — as one thing rather than as its members. */
export async function saveProject(projectId: number): Promise<boolean> {
	const res = await client.api.content.library.$post({ json: { projectId } });
	if (res.ok) refreshLibrary();
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
		refreshLibrary();
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
	if (res.ok) refreshLibrary();
	return res.ok;
}
