// SPDX-License-Identifier: Apache-2.0
//
// Resume-from-position, tested against a localStorage stand-in. The rules being pinned
// are the ones that make a resume feel right rather than creepy: what expires, when a
// write is refused, what finishing does, and what happens when the store itself throws
// (Safari private mode — the whole suite must stay total under it).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearPosition,
	LISTEN_FINISH_MARGIN_SECONDS,
	LISTEN_POSITION_TTL_MS,
	LISTEN_RESUME_FLOOR_SECONDS,
	LISTEN_WRITE_INTERVAL_MS,
	readPosition,
	writePosition,
} from "./listen-positions";

const KEY = "anthers_listen_positions";

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
	seed(key: string, value: string): void {
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
	Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
});

afterEach(() => {
	Object.defineProperty(globalThis, "localStorage", { value: realStorage, configurable: true });
});

const NOW = 1_800_000_000_000;

describe("readPosition", () => {
	test("absent work reads as null", () => {
		expect(readPosition(1, NOW)).toBeNull();
	});

	test("a stored position round-trips", () => {
		writePosition(1, 600, null, { force: true, now: NOW });
		expect(readPosition(1, NOW)).toBe(600);
	});

	test("an entry older than the TTL reads as absent", () => {
		store.seed(KEY, JSON.stringify({ 1: { t: 600, at: NOW - LISTEN_POSITION_TTL_MS - 1 } }));
		expect(readPosition(1, NOW)).toBeNull();
	});

	test("an entry at or below the resume floor reads as absent", () => {
		writePosition(1, LISTEN_RESUME_FLOOR_SECONDS, null, { force: true, now: NOW });
		expect(readPosition(1, NOW)).toBeNull();
	});

	test("corrupt JSON reads as absent rather than throwing", () => {
		store.seed(KEY, "not json at all {");
		expect(readPosition(1, NOW)).toBeNull();
	});

	test("a store that throws on read is absent", () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("denied");
				},
				setItem: () => {},
			},
			configurable: true,
		});
		expect(readPosition(1, NOW)).toBeNull();
	});
});

describe("writePosition throttling", () => {
	test("a second write inside the interval is refused, a later one lands", () => {
		expect(writePosition(1, 60, null, { now: NOW })).toBe(true);
		expect(writePosition(1, 62, null, { now: NOW + LISTEN_WRITE_INTERVAL_MS - 1 })).toBe(false);
		expect(readPosition(1, NOW + LISTEN_WRITE_INTERVAL_MS - 1)).toBe(60);
		expect(writePosition(1, 62, null, { now: NOW + LISTEN_WRITE_INTERVAL_MS })).toBe(true);
		expect(readPosition(1, NOW + LISTEN_WRITE_INTERVAL_MS)).toBe(62);
	});

	test("force bypasses the throttle — the pause and pagehide flush points", () => {
		writePosition(1, 60, null, { now: NOW });
		expect(writePosition(1, 63, null, { force: true, now: NOW + 100 })).toBe(true);
		expect(readPosition(1, NOW + 100)).toBe(63);
	});

	test("a refilled entry survives a refused write rather than blanking", () => {
		writePosition(1, 60, null, { now: NOW });
		writePosition(1, 61, null, { now: NOW + 1 });
		expect(JSON.parse(store.readRaw(KEY) ?? "{}")[1].t).toBe(60);
	});
});

describe("the TTL and eviction on write", () => {
	test("writing evicts every expired entry, not just the one being written", () => {
		store.seed(
			KEY,
			JSON.stringify({
				1: { t: 300, at: NOW - LISTEN_POSITION_TTL_MS - 1 },
				2: { t: 400, at: NOW - 1000 },
			}),
		);
		writePosition(3, 50, null, { force: true, now: NOW });
		const stored = JSON.parse(store.readRaw(KEY) ?? "{}");
		expect(stored[1]).toBeUndefined();
		expect(stored[2]).toEqual({ t: 400, at: NOW - 1000 });
		expect(stored[3].t).toBe(50);
	});
});

describe("clear-on-finish", () => {
	test("within the finish margin of the end, the position is cleared, not stored", () => {
		writePosition(1, 300, null, { force: true, now: NOW });
		const t = 1200 - LISTEN_FINISH_MARGIN_SECONDS;
		expect(writePosition(1, t, 1200, { force: true, now: NOW + 1 })).toBe(true);
		expect(readPosition(1, NOW + 1)).toBeNull();
		expect(JSON.parse(store.readRaw(KEY) ?? "{}")[1]).toBeUndefined();
	});

	test("just short of the margin stores normally", () => {
		const t = 1200 - LISTEN_FINISH_MARGIN_SECONDS - 1;
		writePosition(1, t, 1200, { force: true, now: NOW });
		expect(readPosition(1, NOW)).toBe(t);
	});

	test("unknown duration stores rather than guessing at an end", () => {
		writePosition(1, 9999, null, { force: true, now: NOW });
		expect(readPosition(1, NOW)).toBe(9999);
	});
});

describe("clearPosition", () => {
	test("drops only the named Work", () => {
		writePosition(1, 60, null, { force: true, now: NOW });
		writePosition(2, 60, null, { force: true, now: NOW });
		clearPosition(1, NOW);
		expect(readPosition(1, NOW)).toBeNull();
		expect(readPosition(2, NOW)).toBe(60);
	});
});

describe("under localStorage failure", () => {
	test("a throwing setItem refuses the write and leaves reads absent", () => {
		store.throwing = true;
		expect(writePosition(1, 60, null, { force: true, now: NOW })).toBe(false);
		expect(() => clearPosition(1, NOW)).not.toThrow();
	});
});
