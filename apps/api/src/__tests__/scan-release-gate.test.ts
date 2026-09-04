// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Releasing a Work waits for its safety scan, and stops waiting.
 *
 * 🚨 **Both halves are the feature, and a suite that tested only the first would be worse
 * than none.** Gating release on a completed scan closes the window in which an unscanned
 * image is public; giving way after two minutes is what stops a detection vendor's outage
 * from freezing publication for everybody on a platform whose whole function is publishing.
 * 18 U.S.C. § 2258A(f) imposes no duty to search at all, so a gate with no time limit would
 * be trading the product for an obligation nobody owes. Tests for the wait and tests for the
 * give-way therefore sit side by side here, and neither may be deleted to make the other
 * pass.
 *
 * ⚠️ **`unscannable` is not `clean`, and the assertion that says so is the fragile one.**
 * Both let a release through, so an implementation that collapsed them would pass every
 * gate test written carelessly — and "we scan uploads" would quietly stop being true while
 * the suite stayed green. The case below therefore checks the stored row as well as the
 * verdict: the release proceeds *and* the record still says the question went unasked.
 *
 * Fixtures go in through `insertWork` rather than `POST /works`, because the create route
 * enqueues the scan and pg-boss is not running under the test runner. What is under test is
 * the gate, not the enqueue.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { mediaScans, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import {
	beginScans,
	SCAN_RELEASE_GRACE_MS,
	scannableKeys,
	scanReleaseGate,
	worksOwedScans,
} from "../services/safety-scan.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `scangate_${id}`;
/** Every key this suite writes carries the run id, so teardown can find its own. */
const KEY = (name: string) => `media/scangate-${id}-${name}.png`;

async function signUp(username: string): Promise<{ cookie: string; userId: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	return { cookie: res.headers.get("Set-Cookie")!.split(";")[0], userId: body.user.id };
}

/** Record an answer for a key without going near a vendor. */
async function answer(storageKey: string, determination: string, workId: number) {
	await db
		.insert(mediaScans)
		.values({ storageKey, workId, determination, scannedAt: new Date() })
		.onConflictDoUpdate({ target: mediaScans.storageKey, set: { determination } });
}

/** Move a Work's scan clock into the past, so the grace window has run out. */
async function ageClock(workId: number, msAgo: number) {
	await db
		.update(works)
		.set({ scanQueuedAt: new Date(Date.now() - msAgo) })
		.where(eq(works.id, workId));
}

async function reload(workId: number) {
	const [row] = await db.select().from(works).where(eq(works.id, workId));
	return row;
}

describe("release waits for a safety scan, and gives way", () => {
	let creator: { cookie: string; userId: number };
	const workIds: number[] = [];

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);
		creator = await signUp(creatorName);
		await enablePayouts(creatorName);
	}, DB_SETUP_TIMEOUT);

	// Teardown in afterAll rather than a trailing `it`, so it runs whether the suite passed
	// or bailed. `media_scans.work_id` cascades, but the rows this suite writes for keys
	// with no Work behind them do not — so they go explicitly.
	afterAll(async () => {
		if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
		await db.delete(mediaScans).where(sql`${mediaScans.storageKey} LIKE ${`%scangate-${id}-%`}`);
		await purgeFixtureAccounts([creatorName]);
	});

	async function stage(fixture: {
		type: string;
		sourceKey?: string;
		thumbnail?: string;
		scanQueuedAt?: Date | null;
	}) {
		const work = await insertWork({
			creatorId: creator.userId,
			visibility: "private",
			...fixture,
		});
		workIds.push(work.id);
		return work;
	}

	describe("scannableKeys — the one definition both the gate and the enqueue read", () => {
		it("takes an image's source and any Work's thumbnail", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("src"),
				thumbnail: KEY("thumb"),
			});
			expect(
				scannableKeys(work)
					.map((o) => o.key)
					.sort(),
			).toEqual([KEY("src"), KEY("thumb")].sort());
			expect(scannableKeys(work).every((o) => o.kind === "image")).toBe(true);
		});

		it("🚨 takes a video's source AS A VIDEO, and its thumbnail as an image", async () => {
			// The kind travels with the key, and this is why: both are strings in the same
			// namespace, and a video source sent down the image path hashes container bytes,
			// fails, and records the whole video as permanently unscannable — coverage
			// removed by the machinery meant to provide it.
			const work = await stage({
				type: "video",
				sourceKey: KEY("video-src"),
				thumbnail: KEY("video-thumb"),
			});
			expect(scannableKeys(work)).toEqual([
				{ key: KEY("video-src"), kind: "video" },
				{ key: KEY("video-thumb"), kind: "image" },
			]);
		});

		it("normalizes a thumbnail held as a full URL", async () => {
			const work = await stage({
				type: "text",
				thumbnail: `https://cdn.anthers.org/content/${KEY("url-thumb")}`,
			});
			expect(scannableKeys(work)).toEqual([{ key: KEY("url-thumb"), kind: "image" }]);
		});

		it("finds nothing on a Work carrying no image at all", async () => {
			const work = await stage({ type: "text" });
			expect(scannableKeys(work)).toEqual([]);
		});
	});

	describe("beginScans", () => {
		it("starts the clock and names the objects to send", async () => {
			const work = await stage({ type: "image", sourceKey: KEY("begin") });
			expect(work.scanQueuedAt).toBeNull();

			const objects = await beginScans(work);
			expect(objects).toEqual([{ key: KEY("begin"), kind: "image" }]);
			expect((await reload(work.id)).scanQueuedAt).toBeInstanceOf(Date);
		});

		it("starts no clock on a Work that will never owe a scan", async () => {
			// A text Work with no thumbnail has nothing an image hash can read. Stamping it
			// would make the gate wait forever for an answer nobody was ever going to give.
			const work = await stage({ type: "text" });
			expect(await beginScans(work)).toEqual([]);
			expect((await reload(work.id)).scanQueuedAt).toBeNull();
		});
	});

	describe("scanReleaseGate", () => {
		it("blocks while an answer is outstanding and the window is open", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("waiting"),
				scanQueuedAt: new Date(),
			});
			const gate = await scanReleaseGate(work);
			expect(gate.blocked).toBe(true);
			expect(gate.pending).toEqual([KEY("waiting")]);
			expect(gate.waitUntil).toBeInstanceOf(Date);
		});

		it("gives way once the window has run out, leaving the scan owed", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("gaveway"),
				scanQueuedAt: new Date(Date.now() - SCAN_RELEASE_GRACE_MS - 1000),
			});
			const gate = await scanReleaseGate(work);
			expect(gate.blocked).toBe(false);
			// Still pending, and still counted as pending. Giving way is not forgetting.
			expect(gate.pending).toEqual([KEY("gaveway")]);
		});

		it("lets a clean answer straight through", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("clean"),
				scanQueuedAt: new Date(),
			});
			await answer(KEY("clean"), "clean", work.id);
			const gate = await scanReleaseGate(work);
			expect(gate.blocked).toBe(false);
			expect(gate.pending).toEqual([]);
		});

		it("lets an unscannable answer through WITHOUT recording it as clean", async () => {
			// 🚨 The assertion this file exists for. Both determinations release, and they
			// mean opposite things: `clean` is "we asked and nothing known matched",
			// `unscannable` is "the question was never askable". An implementation that
			// collapsed them would satisfy the first half of this test and make the honesty
			// of every "we scan uploads" claim we publish depend on nobody checking.
			const work = await stage({
				type: "image",
				sourceKey: KEY("unscannable"),
				scanQueuedAt: new Date(),
			});
			await answer(KEY("unscannable"), "unscannable", work.id);

			const gate = await scanReleaseGate(work);
			expect(gate.blocked).toBe(false);

			const [row] = await db
				.select()
				.from(mediaScans)
				.where(eq(mediaScans.storageKey, KEY("unscannable")));
			expect(row.determination).toBe("unscannable");
			expect(row.determination).not.toBe("clean");
		});

		it("never blocks a Work that owes nothing", async () => {
			const work = await stage({ type: "text" });
			expect((await scanReleaseGate(work)).blocked).toBe(false);
		});

		it("never blocks when no clock was ever started", async () => {
			// An object attached by a path that enqueued nothing, or before this gate existed.
			// Waiting on a scan nobody queued is an outage of our own making.
			const work = await stage({ type: "image", sourceKey: KEY("noclock") });
			const gate = await scanReleaseGate(work);
			expect(gate.blocked).toBe(false);
			expect(gate.pending).toEqual([KEY("noclock")]);
		});
	});

	describe("worksOwedScans — what makes 'still owed' true", () => {
		it("finds a Work whose answer never came back", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("owed"),
				scanQueuedAt: new Date(),
			});
			const owed = await worksOwedScans();
			expect(owed.find((o) => o.id === work.id)?.objects).toEqual([
				{ key: KEY("owed"), kind: "image" },
			]);
		});

		it("leaves alone a Work whose every object has been answered", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("settled"),
				scanQueuedAt: new Date(),
			});
			await answer(KEY("settled"), "clean", work.id);
			const owed = await worksOwedScans();
			expect(owed.find((o) => o.id === work.id)).toBeUndefined();
		});

		it("leaves alone a Work that never started a clock", async () => {
			const work = await stage({ type: "image", sourceKey: KEY("noclock-owed") });
			const owed = await worksOwedScans();
			expect(owed.find((o) => o.id === work.id)).toBeUndefined();
		});
	});

	describe("PATCH /api/content/works/:id — the route the creator actually meets", () => {
		async function release(workId: number) {
			return req(`/api/content/works/${workId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator.cookie },
				body: JSON.stringify({ visibility: "released" }),
			});
		}

		it("refuses the release while the scan is outstanding, and says so without leaking a key", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("route-wait"),
				scanQueuedAt: new Date(),
			});
			const res = await release(work.id);
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.code).toBe("scan_pending");
			// A count, not the keys. Which of a creator's objects we are still asking about
			// is not their business, and a storage key is not a thing to hand back over HTTP.
			expect(body.pending).toBe(1);
			expect(JSON.stringify(body)).not.toContain("route-wait");
			expect((await reload(work.id)).visibility).toBe("private");
		});

		it("releases once the window has run out, even with the answer still outstanding", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("route-giveway"),
				scanQueuedAt: new Date(),
			});
			expect((await release(work.id)).status).toBe(409);

			await ageClock(work.id, SCAN_RELEASE_GRACE_MS + 1000);
			const res = await release(work.id);
			expect(res.status).toBe(200);
			expect((await res.json()).work.visibility).toBe("released");
		});

		it("releases immediately once the answer is in", async () => {
			const work = await stage({
				type: "image",
				sourceKey: KEY("route-clean"),
				scanQueuedAt: new Date(),
			});
			await answer(KEY("route-clean"), "clean", work.id);
			expect((await release(work.id)).status).toBe(200);
		});

		it("does not make a Work with no image wait for anything", async () => {
			const work = await stage({ type: "text" });
			expect((await release(work.id)).status).toBe(200);
		});
	});
});
