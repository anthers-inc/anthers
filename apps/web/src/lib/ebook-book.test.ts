// SPDX-License-Identifier: Apache-2.0
//
// The ebook reader's ladder glue, tested against a fetch stand-in — the unit floor of
// what the e2e suite exercises against a real browser and a real ingest. The contracts
// pinned here are the ones that would fail silently if regressed: every load goes out to
// exactly the manifest's ladder URL with the session's credentials and the share token
// riding the query, a 402 reads as a legible refusal rather than an empty book, an asset
// path the manifest does not hold refuses instead of guessing, and the href resolution
// the view navigates through agrees with the manifest's container-relative paths.
import { afterEach, describe, expect, test } from "bun:test";
import {
	buildEbookBook,
	fetchSectionManifest,
	LadderRefusal,
	makeLadderLoader,
	type SectionManifest,
} from "./ebook-book";

const API = "https://api.example.test";

/** What `ladderFetch` is called with, recorded so each test asserts the exact shape. */
interface RecordedFetch {
	url: string;
	credentials?: string;
}

function stubFetch(
	respond: (url: string) => { status: number; body?: string; json?: unknown } | undefined,
): RecordedFetch[] {
	const calls: RecordedFetch[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: a test double standing in for globalThis.fetch
	(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		calls.push({ url, credentials: init?.credentials });
		const answer = respond(url) ?? { status: 404 };
		return new Response(answer.body ?? "", { status: answer.status });
	};
	return calls;
}

const MANIFEST: SectionManifest = {
	sections: [
		{
			position: 1,
			href: "OEBPS/title.xhtml",
			title: "Title page",
			size: 1200,
			url: "/api/content/works/7/sections/1",
		},
		{
			position: 2,
			href: "OEBPS/ch1.xhtml",
			title: "Chapter 1",
			size: 48000,
			url: "/api/content/works/7/sections/2",
		},
	],
	assets: [
		{
			path: "OEBPS/images/cover.png",
			mimeType: "image/png",
			url: "/api/content/works/7/assets/11",
		},
		{ path: "OEBPS/styles/book.css", mimeType: "text/css", url: "/api/content/works/7/assets/12" },
	],
};

// 🚨 **Restored, never deleted.** One Bun process runs every test file, and a *deleted*
// fetch leaves every later suite's fixture (which captures `fetch` at its module load)
// holding `undefined` — 52 downstream failures in one full-suite run. The double below
// saves the global before the first stub, and the afterEach puts the original back
// whatever a test did to it.
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fetchSectionManifest", () => {
	test("rides the session credentials and the share token the way the page reader composes its fetches", async () => {
		const calls = stubFetch(() => ({ status: 200, body: JSON.stringify(MANIFEST) }));
		const manifest = await fetchSectionManifest(7, API, "tok-123");
		expect(manifest.sections).toHaveLength(2);
		expect(calls).toEqual([
			{
				url: `${API}/api/content/works/7/sections?share=tok-123`,
				credentials: "include",
			},
		]);
	});

	test("without a share token the URL carries none", async () => {
		const calls = stubFetch(() => ({ status: 200, body: JSON.stringify(MANIFEST) }));
		await fetchSectionManifest(7, API, null);
		expect(calls[0]?.url).toBe(`${API}/api/content/works/7/sections`);
		expect(calls[0]?.credentials).toBe("include");
	});
});

describe("an expired Public Access allowance", () => {
	test("surfaces as a LadderRefusal, never as a silently empty book", async () => {
		stubFetch(() => ({ status: 402 }));
		let caught: unknown = null;
		try {
			await fetchSectionManifest(7, API, null);
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof LadderRefusal).toBe(true);
		expect((caught as LadderRefusal).status).toBe(402);
	});
});

describe("the ladder loader", () => {
	test("a section's container-relative path goes out to that section's route", async () => {
		const loader = makeLadderLoader(MANIFEST, API, null);
		const calls = stubFetch(() => ({ status: 200, body: "<html><body/></html>" }));
		const text = await loader.loadText("OEBPS/ch1.xhtml");
		expect(text).toContain("<body/>");
		expect(calls.map((c) => c.url)).toEqual([`${API}/api/content/works/7/sections/2`]);
	});

	test("an asset's path goes out to the asset route, and its blob keeps the manifest's media type", async () => {
		const loader = makeLadderLoader(MANIFEST, API, "tok-9");
		const calls = stubFetch(() => ({ status: 200, body: "PNG" }));
		const blob = await loader.loadBlob("OEBPS/styles/book.css");
		// The blob foliate ultimately creates re-types itself from the manifest's own
		// media type; ours only needs to agree on the base type, charset noise included.
		expect(blob.type.startsWith("text/css")).toBe(true);
		expect(calls[0]?.credentials).toBe("include");
		expect(calls[0]?.url).toBe(`${API}/api/content/works/7/assets/12?share=tok-9`);
	});

	test("a path the manifest does not hold refuses — the loader has no other way to load a byte", async () => {
		const loader = makeLadderLoader(MANIFEST, API, null);
		const calls = stubFetch(() => ({ status: 200, body: "should never be reached" }));
		let caught: unknown = null;
		try {
			await loader.loadText("../META-INF/container.xml");
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof LadderRefusal).toBe(true);
		expect((caught as LadderRefusal).status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("a ladder 402 on a unit reads as the allowance refusal", async () => {
		const loader = makeLadderLoader(MANIFEST, API, null);
		stubFetch(() => ({ status: 402 }));
		let caught: unknown = null;
		try {
			await loader.loadText("OEBPS/ch1.xhtml");
		} catch (err) {
			caught = err;
		}
		expect((caught as LadderRefusal).status).toBe(402);
	});
});

describe("the book object's navigation surface", () => {
	// Built without loading anything — the navigation half of the book interface is pure
	// manifest arithmetic, which is exactly what makes it testable here.
	const book = buildEbookBook("Test Book", MANIFEST, API, null) as {
		sections: { id: string; size: number }[];
		toc: { label: string; href: string }[];
		resolveHref(href: string): { index: number; anchor(doc: unknown): unknown };
		splitTOCHref(href: string): [string, string | null];
		isExternal(href: string): boolean;
	};

	test("spine order, identities and sizes come from the manifest", () => {
		expect(book.sections.map((s) => s.id)).toEqual(["OEBPS/title.xhtml", "OEBPS/ch1.xhtml"]);
		expect(book.sections.map((s) => s.size)).toEqual([1200, 48000]);
	});

	test("the TOC is the titled sections of the book, in spine order", () => {
		expect(book.toc).toEqual([
			{ label: "Title page", href: "OEBPS/title.xhtml" },
			{ label: "Chapter 1", href: "OEBPS/ch1.xhtml" },
		]);
	});

	test("a TOC href resolves to its section id (the container path) plus its fragment", () => {
		// The split's first half is the section **id** — upstream's TOC progress matches it
		// as a string against the spine — never a spine index.
		expect(book.splitTOCHref("OEBPS/ch1.xhtml#note-1")).toEqual(["OEBPS/ch1.xhtml", "note-1"]);
		expect(book.splitTOCHref("OEBPS/title.xhtml")).toEqual(["OEBPS/title.xhtml", null]);
	});

	test("a scheme is external, a container path is not", () => {
		expect(book.isExternal("https://elsewhere.example.test/")).toBe(true);
		expect(book.isExternal("mailto:reader@example.test")).toBe(true);
		expect(book.isExternal("OEBPS/ch1.xhtml")).toBe(false);
		expect(book.isExternal("OEBPS/ch1.xhtml#frag")).toBe(false);
	});

	test("a href the spine does not hold resolves nowhere, never to the book's start", () => {
		const resolved = book.resolveHref("OEBPS/missing.xhtml");
		expect(resolved.index).toBe(-1);
		expect(resolved.anchor(null)).toBeNull();
	});
});
