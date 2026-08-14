// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Seed the **media fixture**: a creator, a video Work, and an album of four audio tracks
 * (one of them gated), all carrying media produced by the real transcode jobs.
 *
 * Why this exists rather than reusing the gauntlet's media — and why that is not a
 * preference — is written down in `packages/db/src/media-fixture.ts`. In one line: the
 * gauntlet fixture is deleted and rebuilt by a suite that runs alongside the one that
 * needs to play it.
 *
 * 🚨 **Idempotent by design, and that is the load-bearing property.** A Work already
 * carrying a `completed` transcode is skipped entirely — no clip, no upload, no ffmpeg. So
 * this is instant on every run after the first, which is what lets a spec call it in
 * `beforeAll` without either paying for an encode or opening a window in which the media
 * is briefly absent. Pass `--force` to rebuild anyway.
 *
 * Uses the same trick as `seed-gauntlet-media.ts`: call `transcodeVideo` / `processAudio`
 * directly rather than through pg-boss, which is not running here. Same code the worker
 * runs, so the output is a genuine HLS ladder and a genuine normalized MP3 with a real
 * waveform.
 *
 * Usage: `bun run db:media-fixture` (or `--force` to re-encode).
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import {
	MEDIA_FIXTURE_DISPLAY_NAME,
	MEDIA_FIXTURE_EMAIL,
	MEDIA_FIXTURE_PASSWORD,
	MEDIA_FIXTURE_PROJECT,
	MEDIA_FIXTURE_USERNAME,
	MEDIA_FIXTURE_WORKS,
	type MediaFixtureWork,
} from "@anthers/db/media-fixture";
import { projectItems, projects, transcodingJobs, users, works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { processAudio } from "../jobs/process-audio.js";
import { rasterizeEbook } from "../jobs/rasterize-ebook.js";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { storage } from "../services/storage/index.js";

const TAG = "[media-fixture]";
const FORCE = process.argv.includes("--force");

/** Matches the gauntlet's clip: short enough to encode fast, tall enough to make a rung. */
const CLIP_SECONDS = 3;
/** Pages in the fixture comic. Four, so a spread view has two full spreads to turn between. */
export const EBOOK_PAGES = 4;
const VIDEO_SIZE = "640x360";

/** Ungated, free, streaming — i.e. Public Access, which is what a player spec wants. */
const OPEN_ACCESS = [{ threshold: 0, allow: true, price: "0" }];
/**
 * Behind one Seed given to this creator. The baseline row is present and DENIES, which is
 * what makes it a gate rather than an absence — a Work with no baseline row at all is
 * "free but fully locked", a different state with a different meaning.
 */
const SEED_GATED = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 1, allow: true, price: "0" },
];

async function ffmpegAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/**
 * Generate a clip from ffmpeg's synthetic sources — nothing binary is committed.
 *
 * Each audio track gets its own frequency, so the three are distinguishable by ear when
 * somebody is checking a queue by hand rather than by assertion.
 */
/**
 * A multi-page PDF, generated rather than committed.
 *
 * Four pages of coloured test cards, so a reader spec can tell page 2 from page 3 by
 * eye — a fixture whose pages are identical cannot show that a page turn happened.
 * Built by rendering images with ffmpeg and stitching with `img2pdf`-free plumbing:
 * ffmpeg writes a PDF directly via its `pdf` muxer where available, and we fall back to
 * a minimal hand-built PDF otherwise, because a system without a PDF writer is common
 * and a fixture that needs one is a fixture that does not run.
 */
async function generatePdf(pages: number): Promise<string> {
	const path = join(tmpdir(), `media_fixture_ebook_${randomUUID()}.pdf`);
	// A minimal, valid, multi-page PDF written by hand. No dependency, no encoder, and
	// completely deterministic — which matters more for a fixture than fidelity does:
	// what the reader spec asserts is that page N renders and page N+1 is different.
	const objects: string[] = [];
	const kids: string[] = [];
	for (let i = 0; i < pages; i++) {
		const contentId = 4 + i * 2;
		const pageId = 3 + i * 2;
		kids.push(`${pageId} 0 R`);
		const text = `Page ${i + 1}`;
		const stream = `BT /F1 48 Tf 72 500 Td (${text}) Tj ET`;
		objects.push(
			`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
				`/Resources << /Font << /F1 1 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
		);
		objects.push(
			`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
		);
	}
	const header = "%PDF-1.4\n";
	const font = "1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
	const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>\nendobj\n`;
	const catalogId = 3 + pages * 2;
	const catalog = `${catalogId} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
	const body = header + font + pagesObj + objects.join("") + catalog;
	// A `startxref` of 0 with no xref table is tolerated by poppler, which rebuilds the
	// table when it cannot find one — the documented recovery path, and enough for a
	// fixture. `pdfinfo` is what the job calls first, so if this were unreadable the
	// seeder would fail loudly rather than producing a book with no pages.
	const trailer = `trailer\n<< /Size ${catalogId + 1} /Root ${catalogId} 0 R >>\nstartxref\n0\n%%EOF\n`;
	await Bun.write(path, body + trailer);
	return path;
}

async function generateClip(kind: "video" | "audio", hz: number): Promise<string> {
	const path = join(
		tmpdir(),
		`media_fixture_${kind}_${randomUUID()}.${kind === "video" ? "mp4" : "mp3"}`,
	);
	const args =
		kind === "video"
			? [
					"ffmpeg",
					"-y",
					"-f",
					"lavfi",
					"-i",
					`testsrc=duration=${CLIP_SECONDS}:size=${VIDEO_SIZE}:rate=15`,
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${hz}:duration=${CLIP_SECONDS}`,
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-shortest",
					path,
				]
			: [
					"ffmpeg",
					"-y",
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${hz}:duration=${CLIP_SECONDS}`,
					"-c:a",
					"libmp3lame",
					path,
				];

	const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) {
		throw new Error(
			`ffmpeg failed generating the ${kind} clip:\n${await new Response(proc.stderr).text()}`,
		);
	}
	return path;
}

/** Create the fixture creator if absent; return its id either way. */
async function ensureCreator(): Promise<number> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, MEDIA_FIXTURE_USERNAME))
		.limit(1);
	if (existing) return existing.id;

	const [created] = await db
		.insert(users)
		.values({
			username: MEDIA_FIXTURE_USERNAME,
			email: MEDIA_FIXTURE_EMAIL,
			passwordHash: await Bun.password.hash(MEDIA_FIXTURE_PASSWORD, "argon2id"),
			displayName: MEDIA_FIXTURE_DISPLAY_NAME,
			bio: "A fixture creator whose Works carry real, playable media.",
			isCreator: true,
			emailVerified: true,
		})
		.returning({ id: users.id });
	console.log(`${TAG} created creator "${MEDIA_FIXTURE_USERNAME}" (id ${created.id})`);
	return created.id;
}

/**
 * Create the Work row if absent, and **reconcile** it if present.
 *
 * 🚨 Reconcile rather than skip. The fields below are what the fixture *declares* — its
 * title, its gates, its words — so a create-if-missing seeder means changing the
 * declaration diverges silently: a fresh machine gets the new fixture while yours keeps
 * the old one, and a spec that passes here fails in CI for reasons neither of you can see.
 * Same defect the dev-account bootstrap had until it started reconciling.
 *
 * The media is deliberately NOT reconciled here — that is the expensive part, and
 * `alreadyPlayable` decides it separately.
 */
async function ensureWork(spec: MediaFixtureWork, creator: number): Promise<number> {
	const access = spec.gated ? SEED_GATED : OPEN_ACCESS;
	// 🚨 Looked up by SLUG ALONE, not by (creator, slug). `works.slug` is globally unique
	// and these are namespaced with `media-fixture-`, so slug is the real identity — while
	// matching on the creator too makes the seeder unable to find a Work whose creator has
	// changed, so it tries to INSERT and dies on the unique index instead. That is not
	// hypothetical: reassigning one by hand to try something out was enough to wedge the
	// whole fixture, and the error named the insert rather than the cause. `creatorId` is
	// reconciled below for the same reason everything else here is.
	const [existing] = await db
		.select({ id: works.id })
		.from(works)
		.where(eq(works.slug, spec.slug))
		.limit(1);
	if (existing) {
		await db
			.update(works)
			.set({
				creatorId: creator,
				title: spec.title,
				seedAccess: access,
				lyrics: spec.lyrics ?? "",
			})
			.where(eq(works.id, existing.id));
		return existing.id;
	}

	const [created] = await db
		.insert(works)
		.values({
			creatorId: creator,
			publicId: spec.publicId,
			slug: spec.slug,
			type: spec.media,
			title: spec.title,
			description: "Fixture media, generated by ffmpeg's synthetic sources.",
			lyrics: spec.lyrics ?? "",
			visibility: "released",
			releasedAt: new Date(),
			streamEnabled: true,
			downloadEnabled: false,
			seedAccess: access,
		})
		.returning({ id: works.id });
	return created.id;
}

/** Whether this Work already has media we can trust, so the encode can be skipped. */
async function alreadyPlayable(workId: number): Promise<boolean> {
	const [job] = await db
		.select({ status: transcodingJobs.status })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.workId, workId))
		.limit(1);
	return job?.status === "completed";
}

async function seedMediaFor(spec: MediaFixtureWork, creator: number): Promise<void> {
	const workId = await ensureWork(spec, creator);

	if (!FORCE && (await alreadyPlayable(workId))) {
		console.log(`${TAG} ${spec.key} already playable — skipped`);
		return;
	}

	await db.delete(transcodingJobs).where(eq(transcodingJobs.workId, workId));

	// 440 Hz for the video, then a rising scale for the tracks, so a person listening to
	// the queue can hear it advance.
	const hz = spec.media === "video" ? 440 : 440 + spec.trackNumber * 110;
	const clipPath =
		spec.media === "ebook" ? await generatePdf(EBOOK_PAGES) : await generateClip(spec.media, hz);
	try {
		const ext = spec.media === "video" ? "mp4" : spec.media === "ebook" ? "pdf" : "mp3";
		const sourceKey = `creators/${creator}/${spec.media}/source/${randomUUID().replace(/-/g, "")}.${ext}`;
		// Sources are private: only derived, access-checked deliverables are ever served.
		await storage.upload(
			sourceKey,
			new Uint8Array(await Bun.file(clipPath).arrayBuffer()),
			spec.media === "video"
				? "video/mp4"
				: spec.media === "ebook"
					? "application/pdf"
					: "audio/mpeg",
			"private",
		);
		await db.update(works).set({ sourceKey, updatedAt: new Date() }).where(eq(works.id, workId));

		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: spec.media, status: "pending", progress: 0 })
			.returning({ id: transcodingJobs.id });

		if (spec.media === "video") await transcodeVideo({ jobId: job.id });
		else if (spec.media === "ebook") await rasterizeEbook({ jobId: job.id });
		else await processAudio({ jobId: job.id });

		const [done] = await db
			.select()
			.from(transcodingJobs)
			.where(eq(transcodingJobs.id, job.id))
			.limit(1);
		if (done?.status !== "completed") {
			throw new Error(
				`${TAG} ${spec.key} ${spec.media} job finished as "${done?.status}": ${done?.errorMessage || "no error recorded"}`,
			);
		}
		console.log(`${TAG} ${spec.key} (${spec.slug}) → real ${spec.media}, work ${workId}`);
	} finally {
		await rm(clipPath, { force: true });
	}
}

/** Put the audio Works on the album's shelf, in track order. */
async function ensureProject(creator: number): Promise<void> {
	let [project] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.creatorId, creator), eq(projects.slug, MEDIA_FIXTURE_PROJECT.slug)))
		.limit(1);
	if (!project) {
		[project] = await db
			.insert(projects)
			.values({
				creatorId: creator,
				slug: MEDIA_FIXTURE_PROJECT.slug,
				title: MEDIA_FIXTURE_PROJECT.title,
				description: MEDIA_FIXTURE_PROJECT.description,
				isPublished: true,
			})
			.returning({ id: projects.id });
	}

	for (const spec of MEDIA_FIXTURE_WORKS) {
		if (spec.media !== "audio") continue;
		const [work] = await db
			.select({ id: works.id })
			.from(works)
			.where(and(eq(works.creatorId, creator), eq(works.slug, spec.slug)))
			.limit(1);
		if (!work) continue;
		// Upsert on the pair, so a re-run corrects an order rather than duplicating a row.
		await db
			.insert(projectItems)
			.values({ projectId: project.id, workId: work.id, sortOrder: spec.trackNumber })
			.onConflictDoUpdate({
				target: [projectItems.projectId, projectItems.workId],
				set: { sortOrder: spec.trackNumber },
			});
	}
}

async function main() {
	if (!(await ffmpegAvailable())) {
		console.warn(
			`${TAG} ffmpeg not found — SKIPPING media seeding.\n${TAG} Specs that need playable bytes will fail; install ffmpeg to cover them.`,
		);
		return;
	}

	const creator = await ensureCreator();
	for (const spec of MEDIA_FIXTURE_WORKS) await seedMediaFor(spec, creator);
	await ensureProject(creator);
	console.log(
		`${TAG} ${MEDIA_FIXTURE_WORKS.length} Work(s) ready under "${MEDIA_FIXTURE_USERNAME}"`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(`${TAG} failed:`, error);
		process.exit(1);
	});
