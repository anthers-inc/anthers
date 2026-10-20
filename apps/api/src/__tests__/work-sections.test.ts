// SPDX-License-Identifier: Apache-2.0
/**
 * The reflow ebook ingest and its ladder — the two-shape design's new half
 * (Parker, 2026-10-11), landing before the vendored reader exists.
 *
 * The properties under test, one spec each:
 * - **The ingest decomposes a container**: an EPUB's spine becomes `work_sections` rows
 *   in reading order (positions contiguous across the set), its chapters carry the
 *   titles the book's own navigation gave them, and every referenced component lands in
 *   `work_section_assets` by container-relative path — the ladder's inventory, keyed the
 *   stable way so a re-ingest keeps the paths and only the keys move.
 * - **A re-run replaces, never appends** — the same replace-on-rerun rule `render-paged`
 *   holds, and for the same reason (a retry is not a duplicate story).
 * - **The caps bind**: per-component, total extraction, and entry count — each refusing
 *   with a legible message, before or during decompression, rather than spending a
 *   worker's memory on it.
 * - **The set is one shape**: a mixed set routes nowhere (the ingest fails it named),
 *   the page renderer refuses an EPUB legibly rather than through pdftoppm's complaint,
 *   the append route refuses the mix at the boundary with a 400, and `routePagedIngest`
 *   — the one decider enqueue and resume share — sends each shape onward.
 * - **The ladder gates like the page ladder**: a signed-out caller 401s; a caller with
 *   access gets the manifest and a signed redirect per unit.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	transcodingJobs,
	workSectionAssets,
	workSections,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { type Zippable, zipSync } from "fflate";
import app from "../index";
import { extractUnderCaps, ingestEbook } from "../jobs/ingest-ebook.js";
import { QUEUES, queue } from "../jobs/queue";
import { renderPaged } from "../jobs/render-paged.js";
import { parseEpub, resolveHref } from "../lib/epub.js";
import { isEpubSource, routePagedIngest } from "../lib/paged-ingest.js";
import { storage } from "../services/storage";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

let creator = { id: 0, cookie: "" };
let reader = { id: 0, cookie: "" };
const workIds: number[] = [];

function call(method: string, path: string, body?: unknown, cookie = "") {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			redirect: "manual",
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/**
 * One small, real EPUB: three chapters whose OPF declares an image and a stylesheet, an
 * EPUB 3 nav document carrying the titles (one via a fragment href), and a chapter
 * referencing the image and the css by paths relative to itself and to a sibling
 * directory. `level: 0` keeps the fixture fast and its bytes legible.
 */
function buildEpub(chapters = 3): Uint8Array {
	const items: string[] = [];
	const spine: string[] = [];
	for (let i = 1; i <= chapters; i++) {
		items.push(`<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
		spine.push(`<itemref idref="ch${i}"/>`);
	}
	items.push(
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
	);
	items.push(`<item id="css" href="../style/common.css" media-type="text/css"/>`);
	items.push(`<item id="cover" href="images/cover.png" media-type="image/png"/>`);
	const navAnchors = Array.from(
		{ length: chapters },
		(_, i) => `<li><a href="ch${i + 1}.xhtml${i === 1 ? "#part" : ""}">Chapter ${i + 1}</a></li>`,
	).join("");
	const epub: Zippable = {
		mimetype: new TextEncoder().encode("application/epub+zip"),
		"META-INF/container.xml": new TextEncoder().encode(
			`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
		),
		"OEBPS/content.opf": new TextEncoder().encode(
			`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:identifier id="uid">urn:uuid:1234</dc:identifier></metadata><manifest>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
		),
		"OEBPS/nav.xhtml": new TextEncoder().encode(
			`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navAnchors}</ol></nav></body></html>`,
		),
		"OEBPS/images/cover.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		"style/common.css": new TextEncoder().encode("body { margin: 0 }"),
	};
	for (let i = 1; i <= chapters; i++) {
		epub[`OEBPS/ch${i}.xhtml`] = new TextEncoder().encode(
			`<?xml version="1.0"?><html><head><link rel="stylesheet" type="text/css" href="../style/common.css"/></head><body><h1>Chapter ${i}</h1>${
				i === 1 ? `<img src="images/cover.png" alt="cover"/>` : `<p>Prose…</p>`
			}</body></html>`,
		);
	}
	return zipSync(epub, { level: 0 });
}

/** Private storage upload of the container; returns the key and byte count. */
async function putEpub(name: string): Promise<{ file: string; size: number }> {
	const bytes = buildEpub();
	const file = `creators/${creator.id}/ebook/${name}.epub`;
	await storage.upload(file, bytes, "application/epub+zip", "private");
	return { file, size: bytes.length };
}

async function putPdf(name: string): Promise<string> {
	const file = `creators/${creator.id}/ebook/${name}.pdf`;
	await storage.upload(
		file,
		Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
		"application/pdf",
		"private",
	);
	return file;
}

/** Source-set rows written directly, with honest mime types — the rail the set editor rides. */
async function setSourceRows(
	workId: number,
	rows: { file: string; filename: string; mimeType: string; size?: number }[],
) {
	await db.insert(workSourceFiles).values(
		rows.map((row, position) => ({
			workId,
			position,
			file: row.file,
			filename: row.filename,
			fileSize: row.size ?? null,
			mimeType: row.mimeType,
		})),
	);
}

/** A pending `ebook` transcoding row for `workId`, as the enqueue sites create it. */
async function pendingIngest(workId: number): Promise<number> {
	const [job] = await db
		.insert(transcodingJobs)
		.values({ workId, mediaType: "ebook", status: "pending" })
		.returning({ id: transcodingJobs.id });
	return job.id;
}

async function jobOf(jobId: number) {
	const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
	return job;
}

beforeAll(async () => {
	for (const [name, set] of [
		[`sections_creator_${RUN}`, (value: typeof creator) => (creator = value)],
		[`sections_reader_${RUN}`, (value: typeof reader) => (reader = value)],
	] as const) {
		const account = await createAccount(
			name,
			name.includes("creator") ? { fields: { isCreator: true } } : {},
		);
		set({ id: account.userId as number, cookie: account.cookie });
	}
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// `insertWork`'s registry takes the Works back (and they cascade);
	// the storage objects live in this session's disposable local store.
});

describe("extractUnderCaps — the bomb guard, on declared sizes", () => {
	it("refuses one component past the per-component cap, before expanding it", () => {
		const oneMib = crypto.getRandomValues(new Uint8Array(1024 * 1024));
		const zip = zipSync({ "OEBPS/ch1.xhtml": oneMib }, { level: 0 });
		expect(() =>
			extractUnderCaps(zip, { componentMax: 1024, totalMax: Infinity, maxEntries: 100 }),
		).toThrow("decompresses to");
	});

	it("refuses the set's total across entries", () => {
		const halfMib = crypto.getRandomValues(new Uint8Array(512 * 1024));
		const zip = zipSync({ "a.bin": halfMib, "b.bin": halfMib, "c.bin": halfMib }, { level: 0 });
		expect(() =>
			extractUnderCaps(zip, { componentMax: 1024 * 1024, totalMax: 1024 * 1024, maxEntries: 100 }),
		).toThrow("in total");
	});

	it("refuses an entry count past the ceiling", () => {
		const tiny = new TextEncoder().encode("<html/>");
		const entries: Zippable = {};
		for (let i = 0; i < 25; i++) entries[`e${i}.xhtml`] = tiny;
		const zip = zipSync(entries, { level: 0 });
		expect(() =>
			extractUnderCaps(zip, { componentMax: 1024, totalMax: Infinity, maxEntries: 20 }),
		).toThrow("entries");
	});

	it("passes a well-formed container through whole", () => {
		const zip = zipSync(
			{ "META-INF/container.xml": new TextEncoder().encode("<container/>") },
			{ level: 0 },
		);
		const result = extractUnderCaps(zip, { componentMax: 1024, totalMax: 1024, maxEntries: 2 });
		expect(Object.keys(result)).toEqual(["META-INF/container.xml"]);
	});
});

describe("parseEpub — the container's structure, on a hand-built book", () => {
	const parsed = parseEpub(extractUnderCaps(buildEpub()));

	it("reads the spine in order, resolved container-relative", () => {
		expect(parsed.sections.map((s) => s.href)).toEqual([
			"OEBPS/ch1.xhtml",
			"OEBPS/ch2.xhtml",
			"OEBPS/ch3.xhtml",
		]);
	});

	it("carries the titles the book's own navigation gives, fragment hrefs included", () => {
		expect(parsed.sections.map((s) => s.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
	});

	it("inventories the non-spine manifest components by their container paths", () => {
		const paths = parsed.assets.map((a) => a.path).sort();
		expect(paths).toEqual(["OEBPS/images/cover.png", "OEBPS/nav.xhtml", "style/common.css"]);
		expect(parsed.assets.find((a) => a.path === "OEBPS/images/cover.png")?.mediaType).toBe(
			"image/png",
		);
		expect((parsed.resources.get("OEBPS/ch1.xhtml")?.bytes ?? []).length).toBeGreaterThan(0);
	});

	it("refuses what it cannot read, named", () => {
		expect(() => parseEpub({ "ch1.xhtml": new TextEncoder().encode("<html/>") })).toThrow(
			"no META-INF/container.xml",
		);
	});
});

describe("resolveHref", () => {
	it("resolves chapter-relative references against the file's own directory", () => {
		expect(resolveHref("OEBPS", "ch2.xhtml")).toBe("OEBPS/ch2.xhtml");
	});

	it("drops fragments and climbs parents, never keeping a leading slash", () => {
		expect(resolveHref("style", "../style/common.css")).toBe("style/common.css");
		expect(resolveHref("OEBPS", "/OEBPS/ch1.xhtml#part")).toBe("OEBPS/ch1.xhtml");
	});
});

describe("routePagedIngest — one set, one shape", () => {
	const row = (mimeType: string, filename: string) => ({
		mimeType,
		filename,
		file: `k/${filename}`,
	});

	it("sends an EPUB set to the extraction queue, mime reported or not", () => {
		expect(routePagedIngest([row("application/epub+zip", "book.epub")])).toBe("ingest-ebook");
		// An octet-stream upload of an .epub file routes by name — the tell the mime misses.
		expect(routePagedIngest([row("application/octet-stream", "book.epub")])).toBe("ingest-ebook");
		expect(isEpubSource(row("application/octet-stream", "book.epub"))).toBe(true);
	});

	it("keeps the fixed shape wherever no EPUB is in the set", () => {
		expect(routePagedIngest([row("application/pdf", "book.pdf")])).toBe("render-paged");
	});

	it("refuses a mixed set, naming the page-shaped file that rode in", () => {
		expect(() =>
			routePagedIngest([
				row("application/epub+zip", "book.epub"),
				row("application/pdf", "comic.pdf"),
			]),
		).toThrow("comic.pdf");
	});

	it("names the lone EPUB that rode into a page set", () => {
		// The shape outnumbered is the one the creator can act on: a page set that gained one
		// EPUB names the EPUB, not a page file it already had.
		expect(() =>
			routePagedIngest([
				row("application/pdf", "one.pdf"),
				row("application/pdf", "two.pdf"),
				row("application/epub+zip", "book.epub"),
			]),
		).toThrow("book.epub");
	});
});

describe("the ingest job, end to end on a fixture book", () => {
	let workId = 0;

	beforeAll(async () => {
		const work = await insertWork({ creatorId: creator.id, type: "ebook", sourceKey: "" });
		workIds.push(work.id);
		workId = work.id;
		const { file } = await putEpub(`ingest_${RUN}`);
		await setSourceRows(work.id, [
			{ file, filename: `ingest_${RUN}.epub`, mimeType: "application/epub+zip" },
		]);
	});

	it("extracts the spine, the titles and the inventory — every key private and real", async () => {
		const jobId = await pendingIngest(workId);
		await ingestEbook({ jobId });

		const job = await jobOf(jobId);
		expect(job.status).toBe("completed");
		expect(job.progress).toBe(100);

		const sections = await db
			.select()
			.from(workSections)
			.where(eq(workSections.workId, workId))
			.orderBy(workSections.position);
		expect(sections.map((s) => s.position)).toEqual([1, 2, 3]);
		expect(sections.map((s) => s.href)).toEqual([
			"OEBPS/ch1.xhtml",
			"OEBPS/ch2.xhtml",
			"OEBPS/ch3.xhtml",
		]);
		expect(sections.map((s) => s.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
		for (const section of sections) {
			expect(section.sizeBytes ?? 0).toBeGreaterThan(0);
			expect(await storage.exists(section.file)).toBe(true);
			// The reader reaches the component through the ladder, never the key — the
			// private bucket is where these live, and a signed URL is the only way in.
			expect(section.file).toContain(`creators/${creator.id}/ebook/${workId}/`);
		}

		const assets = await db
			.select()
			.from(workSectionAssets)
			.where(eq(workSectionAssets.workId, workId));
		expect(assets.map((a) => a.path).sort()).toEqual([
			"OEBPS/images/cover.png",
			"OEBPS/nav.xhtml",
			"style/common.css",
		]);
		for (const asset of assets) {
			expect(asset.sizeBytes ?? 0).toBeGreaterThan(0);
			expect(await storage.exists(asset.file)).toBe(true);
		}
	});

	it("replaces the components on a re-run — keys move, paths hold", async () => {
		const before = await db.select().from(workSections).where(eq(workSections.workId, workId));
		const jobId = await pendingIngest(workId);
		await ingestEbook({ jobId });
		const after = await db.select().from(workSections).where(eq(workSections.workId, workId));
		expect(after.length).toBe(before.length);
		expect(after.map((s) => s.href)).toEqual(before.map((s) => s.href));
		// The new run minted a new prefix, so the keys are not the old keys.
		expect(after.map((s) => s.file)).not.toEqual(before.map((s) => s.file));
	});
});

describe("the shape refusals", () => {
	it("the ingest refuses a mixed set, named", async () => {
		const work = await insertWork({ creatorId: creator.id, type: "ebook", sourceKey: "" });
		workIds.push(work.id);
		const { file } = await putEpub(`mixed_${RUN}`);
		const pdfFile = await putPdf(`mixed_pdf_${RUN}`);
		await setSourceRows(work.id, [
			{ file, filename: "mixed.epub", mimeType: "application/epub+zip" },
			{ file: pdfFile, filename: "other.pdf", mimeType: "application/pdf" },
		]);
		const jobId = await pendingIngest(work.id);
		await expect(ingestEbook({ jobId })).rejects.toThrow("mix an EPUB");
		const job = await jobOf(jobId);
		expect(job.status).toBe("failed");
		expect(job.errorMessage).toContain("mix an EPUB");
		// Nothing half-processed: the guard runs before any component is written.
		expect(
			await db.select().from(workSections).where(eq(workSections.workId, work.id)),
		).toHaveLength(0);
	});

	it("the page renderer refuses an EPUB set legibly, not through pdftoppm", async () => {
		const work = await insertWork({ creatorId: creator.id, type: "ebook", sourceKey: "" });
		workIds.push(work.id);
		const { file } = await putEpub(`wrongway_${RUN}`);
		await setSourceRows(work.id, [
			{ file, filename: "wrongway.epub", mimeType: "application/epub+zip" },
		]);
		const jobId = await pendingIngest(work.id);
		await expect(renderPaged({ jobId })).rejects.toThrow("reflow ebook");
		const job = await jobOf(jobId);
		expect(job.status).toBe("failed");
		expect(job.errorMessage).toContain("reflow ebook");
	});
});

describe("the append route refuses the mix at the boundary", () => {
	it("400s a source-files add of an EPUB onto a set the legacy column holds as a PDF", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			sourceKey: "",
			visibility: "private",
		});
		workIds.push(work.id);
		await db
			.update(works)
			.set({ sourceKey: await putPdf(`legacy_${RUN}`) })
			.where(eq(works.id, work.id));

		const epubKey = (await putEpub(`add_${RUN}`)).file;
		const res = await call(
			"POST",
			`/api/content/works/${work.id}/source-files`,
			{ file: epubKey, filename: "second.epub", mimeType: "application/epub+zip" },
			creator.cookie,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("sources_mixed_shapes");

		// Refused wholesale: the set still reads as what it WAS — the legacy fallback view
		// of the one PDF — and the EPUB never attached. (One row, the column's file.)
		const read = await call(
			"GET",
			`/api/content/works/${work.id}/source-files`,
			undefined,
			creator.cookie,
		);
		const files = ((await read.json()) as { files: { file: string }[] }).files;
		expect(files).toHaveLength(1);
		expect(files[0].file).toContain(".pdf");
	});

	it("routes an EPUB set's re-render to the extraction queue, by composition", async () => {
		const sendSpy = spyOn(queue, "send").mockImplementation(
			(async () => "job") as typeof queue.send,
		);
		try {
			const work = await insertWork({
				creatorId: creator.id,
				type: "ebook",
				sourceKey: "",
				visibility: "private",
			});
			workIds.push(work.id);
			const { file, size } = await putEpub(`route_${RUN}`);
			const res = await call(
				"POST",
				`/api/content/works/${work.id}/source-files`,
				{ file, filename: `route_${RUN}.epub`, mimeType: "application/epub+zip", fileSize: size },
				creator.cookie,
			);
			expect(res.status).toBe(201);
			expect(sendSpy).toHaveBeenCalledWith(
				QUEUES.INGEST_EBOOK,
				expect.anything(),
				expect.anything(),
			);
		} finally {
			sendSpy.mockRestore();
		}
	});
});

describe("the ladder — the manifest and the two unit routes", () => {
	let workId = 0;
	let assetId = 0;

	beforeAll(async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "ebook",
			sourceKey: "",
			visibility: "released",
			// Free and open — the plain allow row, as the free fixtures everywhere declare it.
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		workIds.push(work.id);
		workId = work.id;

		const sectionFile = `creators/${creator.id}/ebook/${workId}/ladder/section-0001.xhtml`;
		await storage.upload(
			sectionFile,
			new TextEncoder().encode("<html><body>prose</body></html>"),
			"application/xhtml+xml",
			"private",
		);
		const assetFile = `creators/${creator.id}/ebook/${workId}/ladder/asset-0001.png`;
		await storage.upload(
			assetFile,
			new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			"image/png",
			"private",
		);
		const [asset] = await db
			.insert(workSectionAssets)
			.values({
				workId,
				path: "OEBPS/images/cover.png",
				file: assetFile,
				mimeType: "image/png",
				sizeBytes: 8,
			})
			.returning({ id: workSectionAssets.id });
		assetId = asset.id;
		await db.insert(workSections).values({
			workId,
			position: 1,
			href: "OEBPS/ch1.xhtml",
			file: sectionFile,
			title: "Chapter 1",
			sizeBytes: 27,
		});
	});

	it("401s every delivery route for a signed-out caller", async () => {
		for (const path of [
			`/api/content/works/${workId}/sections`,
			`/api/content/works/${workId}/sections/1`,
			`/api/content/works/${workId}/assets/${assetId}`,
		]) {
			const res = await call("GET", path);
			expect(res.status, path).toBe(401);
		}
	});

	it("404s a unit the manifest does not carry, to a caller with access", async () => {
		const res = await call(
			"GET",
			`/api/content/works/${workId}/sections/9`,
			undefined,
			creator.cookie,
		);
		expect(res.status).toBe(404);
	});

	it("serves the manifest to a signed-in caller, mapping paths to ladder routes", async () => {
		const res = await call(
			"GET",
			`/api/content/works/${workId}/sections`,
			undefined,
			reader.cookie,
		);
		expect(res.status).toBe(200);
		const manifest = (await res.json()) as {
			sections: { position: number; href: string; title: string; url: string }[];
			assets: { path: string; mimeType: string; url: string }[];
		};
		expect(manifest.sections).toHaveLength(1);
		expect(manifest.sections[0].title).toBe("Chapter 1");
		expect(manifest.sections[0].href).toBe("OEBPS/ch1.xhtml");
		expect(manifest.sections[0].url).toBe(`/api/content/works/${workId}/sections/1`);
		expect(manifest.assets.map((a) => a.path)).toContain("OEBPS/images/cover.png");
		expect(manifest.assets[0].url).toMatch(/\/api\/content\/works\/\d+\/assets\/\d+$/);
	});

	it("302s a section and an asset to fresh signed URLs, never caching the redirect", async () => {
		const section = await call(
			"GET",
			`/api/content/works/${workId}/sections/1`,
			undefined,
			reader.cookie,
		);
		expect(section.status).toBe(302);
		expect(section.headers.get("Cache-Control")).toBe("no-store");
		expect(section.headers.get("Location")).toContain("section-0001");

		const asset = await call(
			"GET",
			`/api/content/works/${workId}/assets/${assetId}`,
			undefined,
			reader.cookie,
		);
		expect(asset.status).toBe(302);
		expect(asset.headers.get("Cache-Control")).toBe("no-store");
		expect(asset.headers.get("Location")).toContain("asset-0001");
	});
});
