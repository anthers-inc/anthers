// SPDX-License-Identifier: Apache-2.0
/**
 * Ingest a **reflow** ebook Work's EPUB source set into private components.
 *
 * 🚨 **Why extraction rather than hosting, exactly as the design drew it.** The delivery
 * rule is that every derived media object is stored private and every URL to one is minted
 * per request at an endpoint that re-resolves access — and a container handed over as
 * ONE object defeats that, the same way a one-object PDF does (see `render-paged.ts` for
 * the full statement). An EPUB decomposes beautifully: chapters read in spine order, and
 * what each chapter references (images, stylesheets, fonts) has its own manifest row. So
 * the ingest writes two tables — `work_sections`, one row per chapter in reading order,
 * and `work_section_assets`, the ladder's inventory — and the container itself is only
 * ever reachable where a creator enabled downloads.
 *
 * 👉 This job lands BEFORE the vendored foliate-js view, so the reader's first run reads
 * real checked routes: nothing here knows, or must ever know, what the reader looks like.
 * The contract the reader builds on is the manifest endpoint (`/works/:id/sections`,
 * which maps container-relative paths to ladder routes) plus the two redirecting unit
 * routes — each with the page route's exact gate ladder.
 *
 * 🚨 **The EPUB is untrusted input.** The container is unzipped with an entry filter that
 * reads each entry's DECLARED size out of the zip's central directory and refuses, before
 * decompression, anything past the caps below — a ZIP bomb decompresses to nothing rather
 * than to its payload, and one pathological upload fails its job legibly instead of
 * filling the worker's memory or disk. Chapters are stored as-is (no sanitizing here:
 * the script-blocking posture is the reader's sandboxed iframe + CSP, and the standing
 * test proves a scripted section cannot reach the network).
 *
 * Bounds, beside the disk arithmetic that set the page render's caps: the container
 * decompresses in memory, so the source cap is what a worker can hold (256 MiB, which
 * every real book is far under), the extraction cap bounds total decompressed bytes
 * (512 MiB), a single component is capped (64 MiB), the entry count is capped, and the
 * section ceiling keeps the manifest at the page pipeline's scale (2000).
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, workSectionAssets, workSections, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { looksLikeEpub, parseEpub } from "../lib/epub.js";
import { isEpubSource } from "../lib/paged-ingest.js";
import { storage } from "../services/storage/index.js";
import { listSourceFiles } from "../services/work-source-files.js";

export interface IngestEbookData {
	jobId: number;
}

/**
 * Hard ceiling on one uploaded container. It is read whole into memory for the unzip —
 * the cap is what a worker can hold while still having room for what it extracts, and
 * every real book is far under it.
 */
const EPUB_SOURCE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Total decompressed bytes one extraction will hold, enforced on the entries' DECLARED
 * central-directory sizes before each entry decompresses — the bomb guard, stated as an
 * inventory rule.
 */
const EXTRACT_MAX_BYTES = 512 * 1024 * 1024;

/** A single component: XHTML chapters, CSS and fonts are tiny; this catches a pathological embed. */
const COMPONENT_MAX_BYTES = 64 * 1024 * 1024;

/** The most entries a container may declare — thousands of tiny entries are also a bomb's shape. */
const MAX_ENTRIES = 20_000;

/** The manifest's ceiling set-wide, parallel to the page pipeline's `MAX_PAGES`. */
const MAX_SECTIONS = 2000;

/** Progress updates, as the other jobs update them. */
async function updateProgress(jobId: number, progress: number) {
	await db
		.update(transcodingJobs)
		.set({ progress, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));
}

/**
 * Decompress a container under the extraction caps, refusing the pathological before
 * decompressing it. The filter reads each entry's declared size — the zip's own central
 * directory — so nothing past a cap is ever EXPANDED: a bomb that claims 4 GiB inside a
 * 40 KiB file dies on its first oversized declaration, having decompressed nothing.
 */
export function extractUnderCaps(
	container: Uint8Array,
	caps?: {
		sourceMax?: number;
		totalMax?: number;
		componentMax?: number;
		maxEntries?: number;
	},
): Record<string, Uint8Array> {
	const totalMax = caps?.totalMax ?? EXTRACT_MAX_BYTES;
	const componentMax = caps?.componentMax ?? COMPONENT_MAX_BYTES;
	const maxEntries = caps?.maxEntries ?? MAX_ENTRIES;
	let total = 0;
	let count = 0;
	return unzipSync(container, {
		filter: ({ name, size }) => {
			if (name.endsWith("/")) return false; // directory entries carry no bytes
			count += 1;
			if (count > maxEntries) {
				throw new Error(
					`This EPUB declares over ${maxEntries} entries; it may be malformed or hostile`,
				);
			}
			if (size > componentMax) {
				throw new Error(
					`A component of this EPUB (${name}) decompresses to ${size} bytes; the limit for one component is ${componentMax}`,
				);
			}
			total += size;
			if (total > totalMax) {
				throw new Error(
					`This EPUB would extract ${total} bytes in total; the limit for one book is ${totalMax}`,
				);
			}
			return true;
		},
	});
}

/** The storage extension a component keeps, from its container path ("" when it has none). */
function extOf(path: string): string {
	const name = path.split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export async function ingestEbook(data: IngestEbookData) {
	const { jobId } = data;

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency, exactly as renderPaged treats it: a late pg-boss retry of a job already
	// finished (e.g. by the worker's startup-resume path) is a no-op.
	if (job.status === "completed") {
		console.log(`[ingest-ebook] job ${jobId} already completed; skipping`);
		return;
	}
	// A canceled row is final: the creator stopped it, and a stale redelivery must not
	// resume what they stopped — the same guard the three other handlers claim with.
	if (job.status === "canceled") {
		console.log(`[ingest-ebook] job ${jobId} canceled; skipping`);
		return;
	}

	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));

	const [work] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!work) throw new Error(`Work ${job.workId} not found`);

	const sources = await listSourceFiles(work);
	if (sources.length === 0) throw new Error("No source file on this Work");

	interface SectionRow {
		href: string;
		title: string;
		bytes: Uint8Array;
		size: number;
	}
	interface AssetRow {
		path: string;
		bytes: Uint8Array;
		mediaType: string;
		size: number;
	}
	const allSections: SectionRow[] = [];
	const assets = new Map<string, AssetRow>();
	const downloaded: string[] = [];
	const scratch: string[] = [];

	try {
		// 🚨 **The set is one shape.** `routePagedIngest` is what routed this job here, but the
		// job remains its own last line — a set that mixed an EPUB in through any path (a
		// legacy attach, a resume onto the wrong handler) fails here, named, never
		// half-processed. These guards live INSIDE the try, so their failure lands on the
		// row the status badge reads; throwing above the try would strand the row at
		// "processing" with its message nowhere.
		const epubSources = sources.filter((s) => isEpubSource(s));
		if (epubSources.length === 0) {
			throw new Error(
				"This set contains no EPUB, so it is not a reflow ebook's source set — it renders as fixed pages instead",
			);
		}
		if (epubSources.length !== sources.length) {
			const offender = sources.find((s) => !isEpubSource(s));
			throw new Error(
				`A reflow ebook cannot mix an EPUB with other file types, and this set mixes one in: ${offender?.filename || offender?.file} — upload the EPUB on its own, or keep the set to PDFs and page images`,
			);
		}

		// Read each container once (one temp file per source, dying at its pass's end),
		// and extract under the caps. Two EPUBs in one set are one book's volumes; the
		// spine positions run contiguously across them.
		for (const source of sources) {
			const dir = await mkdtemp(join(tmpdir(), "epub_ingest_"));
			scratch.push(dir);
			const containerPath = await storage.downloadToTemp(source.file);
			downloaded.push(containerPath);
			const bytes = new Uint8Array(await readFile(containerPath));
			// 🚨 This container's temp copy dies HERE — its only reader is the unzip below,
			// in the same breath; holding a delivered file's copy past that is residency
			// the caps have no reason to pay for (renderPaged's rule).
			await rm(containerPath, { force: true }).catch(() => {});
			downloaded[downloaded.length - 1] = "";

			if (bytes.length > EPUB_SOURCE_MAX_BYTES) {
				throw new Error(
					`This EPUB is ${bytes.length} bytes; the limit for one source file is ${EPUB_SOURCE_MAX_BYTES}`,
				);
			}
			if (!looksLikeEpub(bytes)) {
				throw new Error(
					`Not a readable EPUB: ${source.filename || source.file} (a DRM-protected EPUB cannot be extracted either)`,
				);
			}

			const parsed = parseEpub(extractUnderCaps(bytes));
			for (const section of parsed.sections) {
				const resource = parsed.resources.get(section.href);
				if (!resource) continue; // the caps filtered it out; the inventory stays honest
				allSections.push({
					href: section.href,
					title: section.title,
					bytes: resource.bytes,
					size: resource.bytes.length,
				});
			}
			for (const resource of parsed.assets) {
				// A path two volumes share takes the first one's bytes — a collision means
				// ambiguity the reader could not resolve either, and the first is what the
				// set's spine order reads first.
				if (!assets.has(resource.path)) {
					assets.set(resource.path, {
						path: resource.path,
						bytes: resource.bytes,
						mediaType: resource.mediaType || "application/octet-stream",
						size: resource.bytes.length,
					});
				}
			}
		}
		if (allSections.length > MAX_SECTIONS) {
			throw new Error(
				`This set would extract ${allSections.length} sections; the limit is ${MAX_SECTIONS}`,
			);
		}
		if (allSections.length === 0) {
			throw new Error("This EPUB has no readable spine (no chapters) — it cannot be read");
		}
		await updateProgress(jobId, 40);

		// A re-run replaces the components rather than appending to them, exactly as
		// renderPaged replaces pages — a unique-index violation is not a retry story.
		// 🚨 Their storage leaves with them: only the current version keeps the reflow
		// components (the 2026-10-23 version ruling), and the archive holds originals.
		const [priorSections, priorAssets] = await Promise.all([
			db
				.select({ file: workSections.file })
				.from(workSections)
				.where(eq(workSections.workId, work.id)),
			db
				.select({ file: workSectionAssets.file })
				.from(workSectionAssets)
				.where(eq(workSectionAssets.workId, work.id)),
		]);
		await db.delete(workSections).where(eq(workSections.workId, work.id));
		await db.delete(workSectionAssets).where(eq(workSectionAssets.workId, work.id));
		for (const row of [...priorSections, ...priorAssets]) {
			await storage.delete(row.file).catch(() => {});
		}

		const prefix = `creators/${work.creatorId}/ebook/${work.id}/${randomUUID().replace(/-/g, "")}`;
		const totalUnits = allSections.length + assets.size;
		let unitsDone = 0;
		// 🚨 Every progress write is awaited: a straggler un-awaited write would land after
		// the completion's own 100 and leave the row reading 95 forever.
		const bump = async () => {
			unitsDone += 1;
			if (unitsDone % 5 === 0 || unitsDone === totalUnits) {
				await updateProgress(jobId, 40 + Math.round((unitsDone / Math.max(totalUnits, 1)) * 55));
			}
		};

		for (const [i, section] of allSections.entries()) {
			const ext = extOf(section.href) || "xhtml";
			const key = `${prefix}/section-${String(i + 1).padStart(4, "0")}.${ext}`;
			// 🚨 PRIVATE, like every other derived object — the whole reason this table exists.
			await storage.upload(key, section.bytes, "application/xhtml+xml", "private");
			await db.insert(workSections).values({
				workId: work.id,
				position: i + 1,
				href: section.href,
				file: key,
				title: section.title,
				sizeBytes: section.size,
			});
			await bump();
		}

		for (const asset of assets.values()) {
			const ext = extOf(asset.path);
			const key = `${prefix}/asset-${String(unitsDone + 1).padStart(4, "0")}${ext ? `.${ext}` : ""}`;
			await storage.upload(key, asset.bytes, asset.mediaType, "private");
			await db.insert(workSectionAssets).values({
				workId: work.id,
				path: asset.path,
				file: key,
				mimeType: asset.mediaType,
				sizeBytes: asset.size,
			});
			await bump();
		}

		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100, etaSeconds: null, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		console.log(
			`[ingest-ebook] work ${work.id} → ${allSections.length} section(s), ${assets.size} asset(s) from ${sources.length} EPUB file(s)`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		// Containers were emptied at each pass's end; a failure before that still leaves
		// the copy holding — the guard keeps the finally from rm-ing empty strings.
		for (const path of downloaded) if (path) await rm(path, { force: true });
		for (const dir of scratch) await rm(dir, { recursive: true, force: true });
	}
}
