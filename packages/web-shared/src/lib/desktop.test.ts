// SPDX-License-Identifier: Apache-2.0
/**
 * `desktopHome`'s stored value, including the one legacy spelling it must still read.
 *
 * ⚠️ **The legacy case is the point of the file.** Installs wrote `"feed"` before the user
 * side was renamed to "your tabs" (2026-10-20), and that value still means the user's tabs.
 * A reader that treated it as unknown would be harmless — it falls back to the same place —
 * but a reader that treated *every* unknown value as the user side is what makes the
 * distinction worth pinning: `"studio"` must survive, and `""` must not.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { desktopHome, setDesktopHome } from "./desktop";

const stored = new Map<string, string>();

interface MemoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

beforeEach(() => {
	stored.clear();
	(globalThis as { localStorage?: MemoryStorage }).localStorage = {
		getItem: (key) => stored.get(key) ?? null,
		setItem: (key, value) => {
			stored.set(key, value);
		},
	};
});

afterAll(() => {
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the desktop's opening surface", () => {
	it("defaults to the user's tabs when nothing is stored", () => {
		expect(desktopHome()).toBe("user");
	});

	it("round-trips the Studio", () => {
		setDesktopHome("studio");
		expect(desktopHome()).toBe("studio");
	});

	it("reads the retired 'feed' value as the user's tabs", () => {
		stored.set("anthers_desktop_home", "feed");
		expect(desktopHome()).toBe("user");
	});

	it("treats an empty or unknown value as never answered", () => {
		for (const value of ["", "catalog", "STUDIO"]) {
			stored.set("anthers_desktop_home", value);
			expect(desktopHome(), `"${value}" is not a stored answer`).toBe("user");
		}
	});
});
