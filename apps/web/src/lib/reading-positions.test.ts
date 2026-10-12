// SPDX-License-Identifier: Apache-2.0
//
// Reading-position persistence, tested against a localStorage stand-in. The rules being
// pinned are the shelf-facing ones: page numbers survive round trips, a store the reader
// never wrote reads as page one for the reader but as *no marker* for the shelf, panel
// and page modes reconcile by taking the further-along page, and the whole suite stays
// total when the store itself throws (Safari private mode — the same stand-in
// `listen-positions.test.ts` runs against).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	readPage,
	readPageFraction,
	readStoredPage,
	readStoredPanel,
	writePage,
	writePanel,
} from "./reading-positions";

/** A localStorage-shaped store a test can watch and break. */
class MemoryStorage {
	private data = new Map<string, string>();
	throwing = false;

	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		if (this.throwing) throw new Error("QuotaExceededError");
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
	readRaw(key: string): string | null {
		return this.data.get(key) ?? null;
	}
}

let store: MemoryStorage;
const realStorage = globalThis.localStorage;

beforeEach(() => {
	store = new MemoryStorage();
	// Assigned rather than defineProperty'd — file-local stubbing is the shared
	// convention (`volume.test.ts` assigns the global the plain way in the same process).
	Object.assign(globalThis, { localStorage: store });
});

afterEach(() => {
	Object.assign(globalThis, { localStorage: realStorage });
});

describe("page positions", () => {
	test("a written page reads back", () => {
		writePage(7, 12);
		expect(readStoredPage(7)).toBe(12);
		expect(readPage(7)).toBe(12);
	});

	test("a never-written Work reads as no marker, and page one for the reader", () => {
		expect(readStoredPage(1)).toBeNull();
		expect(readPage(1)).toBe(1);
	});

	test("a malformed or wrong-shaped store reads as never recorded", () => {
		store.put("anthers_reading_progress", "{not json");
		expect(readStoredPage(3)).toBeNull();
		expect(readPage(3)).toBe(1);

		store.put("anthers_reading_progress", JSON.stringify({ "3": "four", "4": 0, "5": 2.5 }));
		expect(readStoredPage(3)).toBeNull();
		expect(readStoredPage(4)).toBeNull();
		expect(readStoredPage(5)).toBeNull();
	});

	test("a throwing store never takes the read down", () => {
		store.put("anthers_reading_progress", JSON.stringify({ "7": 4 }));
		store.throwing = true;
		expect(readStoredPage(7)).toBe(4);
		writePage(7, 9); // the write is dropped, not thrown
		expect(store.readRaw("anthers_reading_progress")).toBe(JSON.stringify({ "7": 4 }));
	});
});

describe("panel positions", () => {
	test("a written position reads back whole", () => {
		writePanel(7, { page: 3, panel: 2 });
		expect(readStoredPanel(7)).toEqual({ page: 3, panel: 2 });
	});

	test("never-written reads as no stored position", () => {
		expect(readStoredPanel(1)).toBeNull();
	});

	test("a malformed or wrong-shaped store reads as never recorded", () => {
		store.put("anthers_panel_progress", "{not json");
		expect(readStoredPanel(3)).toBeNull();
		store.put("anthers_panel_progress", JSON.stringify({ "3": { page: 2 } }));
		expect(readStoredPanel(3)).toBeNull();
	});
});

describe("the shelf's page fraction", () => {
	test("null when the Work is not paged or never opened", () => {
		expect(readPageFraction(1, null)).toBeNull();
		expect(readPageFraction(1, 0)).toBeNull();
		expect(readPageFraction(1, 48)).toBeNull();
	});

	test("the stored page over the page count, clamped at the end", () => {
		writePage(1, 12);
		expect(readPageFraction(1, 48)).toBe(12 / 48);
		writePage(1, 48);
		expect(readPageFraction(1, 48)).toBe(1);
	});

	test("a stale position past a shrunken page count clamps to full", () => {
		writePage(2, 50);
		expect(readPageFraction(2, 40)).toBe(1);
	});

	test("panel mode counts, by whichever key is further along", () => {
		writePage(3, 4);
		writePanel(3, { page: 9, panel: 1 });
		expect(readPageFraction(3, 10)).toBe(9 / 10);

		// The reverse: a later return to page mode further back does not drag the
		// marker backwards.
		writePage(3, 6);
		expect(readPageFraction(3, 10)).toBe(9 / 10);
	});
});
