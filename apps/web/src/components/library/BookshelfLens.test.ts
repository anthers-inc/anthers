// SPDX-License-Identifier: Apache-2.0
//
// The Bookshelf's one preset — the alphabetical-by-title sort — pinned in pure form:
// case-insensitive base sensitivity, an Untitled fallback that still sorts, and a
// deterministic tie-break so a wrapped shelf never reshuffles itself between visits.
// The continue-reading rail's membership rule is pinned beside it: strictly past zero
// and strictly short of the end, server row first, device keys as the fallback.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Work } from "@anthers/web-shared/types";
import { type ServerPosition, writePage } from "../../lib/reading-positions";
import { compareByTitle, continueReading } from "./BookshelfLens";
import type { LensItem } from "./MusicLens";

/** A localStorage-shaped store, as `reading-positions.test.ts` runs against. */
class MemoryStorage {
	private data = new Map<string, string>();
	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.data.set(key, value);
	}
	removeItem(key: string): void {
		this.data.delete(key);
	}
	clear(): void {
		this.data.clear();
	}
	put(key: string, value: string): void {
		this.data.set(key, value);
	}
}

let store: MemoryStorage;
const realStorage = globalThis.localStorage;

beforeEach(() => {
	store = new MemoryStorage();
	Object.assign(globalThis, { localStorage: store });
});

afterEach(() => {
	Object.assign(globalThis, { localStorage: realStorage });
});

describe("compareByTitle", () => {
	test("orders case-insensitively", () => {
		const titles = ["zebra", "Alice", "middle", "beat"];

		expect([...titles].sort(compareByTitle)).toEqual(["Alice", "beat", "middle", "zebra"]);
	});

	test("a null title sorts as Untitled, among its alphabetical place", () => {
		expect([...["Alice", null, "beat"]].sort(compareByTitle)).toEqual(["Alice", "beat", null]);
		expect([...["b", null, "a"]].sort(compareByTitle)).toEqual(["a", "b", null]);
	});

	test("equal titles still get a deterministic, case-aware tie-break", () => {
		expect([...["note", "Note"]].sort(compareByTitle)).toEqual(["note", "Note"]);
		expect(compareByTitle("same", "same")).toBe(0);
	});
});

// The continue-reading rail, in the pure form the component renders from. A Work is
// one LensItem in these tests — the shape carries `kind: "work"` and a stub work; only
// the fields the rail reads are real.
function bookItem(id: number, title: string, pageCount?: number): LensItem {
	return {
		id,
		kind: "work",
		hidden: false,
		purchased: false,
		work: {
			id,
			title,
			type: pageCount != null ? "comic" : "text",
			pageCount,
			sectionCount: 0,
			access: { canAccess: true },
		} as unknown as Work,
	};
}

function row(workId: number, progress: number, updatedAt: string): [number, ServerPosition] {
	return [workId, { workId, progress, position: {}, updatedAt }];
}

describe("continueReading", () => {
	const books = [
		bookItem(1, "A Comic", 100),
		bookItem(2, "A Novel"),
		bookItem(3, "Another Book", 40),
	];

	test("unfinished server rows ride; finished and never-opened do not", () => {
		const rail = continueReading(books, new Map([row(1, 0.5, "2026-10-15T10:00:00Z")]));
		expect(rail.map((r) => r.item.id)).toEqual([1]);
	});

	test("a finished Work stays on the shelf below, however recent", () => {
		const rail = continueReading(books, new Map([row(2, 1, "2026-10-15T11:00:00Z")]));
		expect(rail).toEqual([]);
	});

	test("order follows last touch, newest first", () => {
		const rail = continueReading(
			books,
			new Map([row(1, 0.5, "2026-10-15T10:00:00Z"), row(3, 0.9, "2026-10-15T12:00:00Z")]),
		);
		expect(rail.map((r) => r.item.id)).toEqual([3, 1]);
	});

	test("a device-only position rides when the server row is silent", () => {
		// Local keys are the fallback store; written through the module's own writer,
		// page 40 of 100 is 40% through.
		writePage(1, 40, 100);
		const rail = continueReading(books, new Map());
		expect(rail.map((r) => r.item.id)).toEqual([1]);
		expect(rail[0].position).toBe(null);
	});

	test("the spine shows the further-along of the two stores, never a backwards step", () => {
		// This device got to 40% once, another device pushed 20% later from the row's
		// newest-write-wins: the ribbon holds at 40%.
		writePage(1, 40, 100);
		const rail = continueReading(books, new Map([row(1, 0.2, "2026-10-15T10:00:00Z")]));
		expect(rail[0].fraction).toBe(0.4);
	});

	test("a Work with no position anywhere never rides, whatever its shelf order", () => {
		const rail = continueReading(books, new Map([row(3, 0.9, "2026-10-15T12:00:00Z")]));
		expect(rail.map((r) => r.item.id)).toEqual([3]);
	});
});
