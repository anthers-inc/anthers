// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Quarantine for material that belongs to no Work — badge art, avatars, headers, covers,
 * gallery shots and inline post images.
 *
 * 🚨 **The defect this suite exists for is an asymmetry, and an asymmetry is invisible to a
 * test that only looks at one side.** The same person uploading the same bytes got a
 * preserved finding and a preservation hold if they attached them to a Work, and silence if
 * they used them as a badge — the outcome turned on where the file was going rather than on
 * what it was. § 2258A attaches on actual knowledge however that knowledge arrives, and a
 * scan we ran and recorded is knowledge. So the shape of the cases here is: **the same three
 * things a Work's match produces — the object out of reach, the record, the hold — for an
 * object with no Work behind it.**
 *
 * ⭐ **The scanner is the subject rather than any one route.** The old code read
 * `if (outcome.quarantine && options.workId)`, which is a discard wearing a guard's clothes:
 * the match was computed, recorded in `media_scans`, and then dropped. Testing through
 * `scanStoredImage` is what proves every caller with no Work behind it is covered, rather
 * than proving one route remembered.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { mediaQuarantine, mediaScans, moderationActions, users } from "@anthers/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import app from "../index";
import { MIN_PDQ_QUALITY } from "../lib/pdq.js";
import { isUnderHold } from "../services/legal-hold.js";
import {
	clearObjectQuarantine,
	quarantineObject,
	quarantineSummary,
	quarantineWork,
} from "../services/quarantine.js";
import { scanInlineUpload, scanStoredImage } from "../services/safety-scan.js";
import { QUARANTINE_PREFIX, scannedObjectKind } from "../services/storage/acl.js";
import { storage } from "../services/storage/index.js";
import { artworkBytes, stubShield } from "./scan-fixtures.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const creatorName = `qo_creator_${RUN}`;

let creatorCookie: string;
let creatorId = 0;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
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
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

/** A real object on disk at a chrome key, so a move that moves nothing cannot pass. */
async function putObject(name: string, seed = 7): Promise<string> {
	const key = `creators/${creatorId}/avatars/${RUN}-${name}.png`;
	await storage.upload(key, await artworkBytes(seed), "image/png", "public");
	return key;
}

function findingFor(storageKey: string) {
	return db
		.select()
		.from(mediaQuarantine)
		.where(eq(mediaQuarantine.originalKey, storageKey))
		.limit(1);
}

beforeAll(async () => {
	creatorCookie = await signUp(creatorName);
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, creatorName));
	creatorId = row.id;
}, DB_SETUP_TIMEOUT);

describe("An object with no Work behind it", () => {
	it("moves out of reach, records the finding, and holds the uploader", async () => {
		const key = await putObject("held", 11);
		expect(await storage.exists(key)).toBe(true);

		const result = await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "avatar",
			source: "scan",
			classification: "apparent-csam",
		});
		expect(result.objectsMoved).toBe(1);

		// Gone from where it was, and still in existence — the two halves § 2258A(h) and
		// "removal is a state, never a delete" each require independently.
		expect(await storage.exists(key)).toBe(false);
		expect(await storage.exists(`${QUARANTINE_PREFIX}${key}`)).toBe(true);

		const [row] = await findingFor(key);
		expect(row).toBeDefined();
		// 🚨 The column has always allowed null and nothing ever wrote one. Inventing a Work
		// to hang this from would put a `quarantine_status` on a row no creator can see.
		expect(row.workId).toBeNull();
		expect(row.uploaderId).toBe(creatorId);
		expect(row.objectKind).toBe("avatar");
		expect(row.priorVisibility).toBe("");

		// The hold is the half that is easiest to leave out and the half that matters: an
		// object parked in the quarantine prefix with nothing holding it is reachable by
		// every sweep, and nothing watches that prefix.
		expect(await isUnderHold("user", creatorId)).toBe(true);
	});

	it("🚨 writes no moderation action, because the only subject left is a person", async () => {
		const key = await putObject("no-log", 12);
		await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "cover",
			source: "scan",
			classification: "apparent-csam",
		});

		// 🚨 **This is a regression test for a plausible wrong answer rather than for a bug
		// that shipped.** `quarantineWork` writes `subject_type: "work"` so an operator
		// reading a Work's history sees the quarantine beside the hides; a Work-less object
		// has no such history, and the tempting substitute is the uploader. It would be
		// worse than writing nothing: `loadModerationQueue` attaches the newest action to a
		// queue item by `(subject_type, subject_id)`, so a *reported person* would render as
		// hidden with reason `quarantine` when nothing whatever happened to their account —
		// and suspending a person is exactly the decision 40.06 records as not taken.
		const actions = await db
			.select({ id: moderationActions.id })
			.from(moderationActions)
			.where(
				and(eq(moderationActions.subjectType, "user"), eq(moderationActions.subjectId, creatorId)),
			);
		expect(actions).toHaveLength(0);
	});

	it("is safe to run twice, because the caller is an operator during an incident", async () => {
		const key = await putObject("twice", 13);
		const first = await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "avatar",
			source: "operator",
			classification: "apparent-csam",
		});
		const second = await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "avatar",
			source: "operator",
			classification: "apparent-csam",
		});

		expect(second.findingId).toBe(first.findingId);
		const rows = await db
			.select({ id: mediaQuarantine.id })
			.from(mediaQuarantine)
			.where(eq(mediaQuarantine.originalKey, key));
		expect(rows, "a second press must not stack a second finding").toHaveLength(1);
	});
});

describe("The scanner routes a match by its subject", () => {
	it("🚨 quarantines a match that has an uploader and no Work", async () => {
		const key = await putObject("scanned", 21);
		const stub = stubShield("csam");
		try {
			const outcome = await scanStoredImage(key, { uploaderId: creatorId, objectKind: "avatar" });
			expect(outcome.determination).toBe("apparent-csam");
			expect(outcome.quarantine).toBe(true);
		} finally {
			stub.restore();
		}

		// The `media_scans` row was always written; it was the only thing that happened.
		const [scan] = await db
			.select({ determination: mediaScans.determination })
			.from(mediaScans)
			.where(eq(mediaScans.storageKey, key));
		expect(scan.determination).toBe("apparent-csam");

		// And now the material is out of reach and somebody can act on it, which is the part
		// that did not exist.
		const [row] = await findingFor(key);
		expect(row, "a scan that matched must leave a finding").toBeDefined();
		expect(row.source).toBe("scan");
		expect(await storage.exists(`${QUARANTINE_PREFIX}${key}`)).toBe(true);
	});

	it("keeps our determination and the vendor's apart on this path too", async () => {
		// 🚨 Asserted here as well as on the Work path because this writer is new. § 7.6:
		// a detection vendor's data is an input to our determination and never a substitute,
		// and the two columns exist so one can be permanent and agent-readable while the
		// other is neither.
		const key = await putObject("vendor", 22);
		const stub = stubShield("harmful-abusive-material");
		try {
			await scanStoredImage(key, { uploaderId: creatorId, objectKind: "gallery" });
		} finally {
			stub.restore();
		}

		const [row] = await findingFor(key);
		expect(row.classification).toBe("harmful-abusive");
		expect(row.classification).not.toBe(row.vendorMatch?.classification);
		expect(row.vendorMatch?.classification).toBe("harmful-abusive-material");
	});

	it("🚨 keeps the fingerprint when the vendor does not answer, so the row is re-askable", async () => {
		// ⭐ **This is the row a deferred-scan sweep will have to select on**, and getting it
		// wrong is silent. `unscannable` has three causes and only one of them is worth
		// re-asking: an object we could not fingerprint (no hash), one whose fingerprint
		// carried no signal (hash, low quality), and one we had a good fingerprint for and
		// never got an answer about. Discarding the hash on the outage path collapsed the
		// first and third into the same row — so a sweep would either re-ask images that can
		// never be hashed, forever, or skip the ones it exists for.
		const key = await putObject("unanswered", 24);
		const original = globalThis.fetch;
		const priorUser = process.env.ARACHNID_SHIELD_USERNAME;
		const priorPass = process.env.ARACHNID_SHIELD_PASSWORD;
		process.env.ARACHNID_SHIELD_USERNAME = "test";
		process.env.ARACHNID_SHIELD_PASSWORD = "test";
		// The vendor is reachable and unhappy, which is the outage this has to survive.
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response("upstream is down", { status: 503 })) as typeof fetch;
		try {
			const outcome = await scanInlineUpload(key, { uploaderId: creatorId, objectKind: "avatar" });
			// The upload is not failed. § 2258A(f) owes no search, so a third party being down
			// must not stop somebody changing their avatar.
			expect(outcome.determination).toBe("unscannable");
			expect(outcome.quarantine).toBe(false);
		} finally {
			globalThis.fetch = original;
			if (priorUser === undefined) delete process.env.ARACHNID_SHIELD_USERNAME;
			else process.env.ARACHNID_SHIELD_USERNAME = priorUser;
			if (priorPass === undefined) delete process.env.ARACHNID_SHIELD_PASSWORD;
			else process.env.ARACHNID_SHIELD_PASSWORD = priorPass;
		}

		const [row] = await db
			.select({
				determination: mediaScans.determination,
				pdqHash: mediaScans.pdqHash,
				pdqQuality: mediaScans.pdqQuality,
			})
			.from(mediaScans)
			.where(eq(mediaScans.storageKey, key));
		expect(row.determination).toBe("unscannable");
		// 🚨 The assertion that matters: a hash, at a quality worth asking about. Both halves,
		// because either alone is satisfied by an image nobody could ever scan.
		expect(row.pdqHash, "the fingerprint we already computed was discarded").toBeTruthy();
		expect(row.pdqQuality).toBeGreaterThanOrEqual(MIN_PDQ_QUALITY);

		// And the object is left where it is — an unanswered question is not a finding.
		expect(await storage.exists(key)).toBe(true);
	});

	it("🚨 does not quarantine a match it was told nothing about", async () => {
		// The contract of `ScanSubject`: a caller that names neither a Work nor an object
		// kind has given the finding nowhere to live and nobody to hold. That case is logged
		// loudly rather than swallowed, and it must not silently write a finding against
		// nobody — which is the other way this could have been made to "work".
		const key = await putObject("subjectless", 23);
		const stub = stubShield("csam");
		try {
			const outcome = await scanStoredImage(key);
			expect(outcome.quarantine).toBe(true);
		} finally {
			stub.restore();
		}

		expect(await findingFor(key)).toHaveLength(0);
		expect(await storage.exists(key)).toBe(true);
	});
});

describe("The direct-upload door", () => {
	async function directUpload(mediaType: string, seed: number) {
		const body = new FormData();
		body.append(
			"file",
			new File([new Uint8Array(await artworkBytes(seed))], "a.png", { type: "image/png" }),
		);
		body.append("mediaType", mediaType);
		return req("/api/content/media-upload/direct", {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
			body,
		});
	}

	it("🚨 scans an avatar, which this door never did", async () => {
		// ⚠️ Wiki 40.12 § *The shape* has always said avatars and covers scan inline here.
		// They did not — badge art got its own endpoint precisely so that it could — so this
		// is a documented claim being made true rather than a new feature.
		//
		// 🚨 **The new finding is identified by difference, and asking "is there an avatar
		// finding for this creator?" is the version that does not work.** Earlier cases in
		// this file quarantine avatars belonging to the same person, so that question is
		// already answered yes before this route is called — and the test passed under a
		// sabotage that removed the whole object path. Predicting the failure count is what
		// surfaced it.
		const avatarFindings = () =>
			db
				.select({ id: mediaQuarantine.id, originalKey: mediaQuarantine.originalKey })
				.from(mediaQuarantine)
				.where(
					and(eq(mediaQuarantine.uploaderId, creatorId), eq(mediaQuarantine.objectKind, "avatar")),
				);
		const before = await avatarFindings();

		const stub = stubShield("csam");
		let res: Response;
		try {
			res = await directUpload("avatar", 31);
		} finally {
			stub.restore();
		}
		expect(res.status).toBe(422);
		expect((await res.json()).code).toBe("refused");

		const after = await avatarFindings();
		expect(after).toHaveLength(before.length + 1);
		const created = after.find((row) => !before.some((b) => b.id === row.id))!;
		// And it names the object this route actually minted, rather than any older one.
		expect(created.originalKey).toStartWith(`creators/${creatorId}/avatars/`);
		expect(created.originalKey).not.toContain(RUN);
		expect(await storage.exists(`${QUARANTINE_PREFIX}${created.originalKey}`)).toBe(true);
	});

	it("lets a clean image through, and hands back the url it always did", async () => {
		// Without this the suite above would pass against a route that refuses everything.
		const stub = stubShield("no-known-match");
		let res: Response;
		try {
			res = await directUpload("cover", 32);
		} finally {
			stub.restore();
		}
		expect(res.status).toBe(201);
		const body = (await res.json()) as { key: string; url: string };
		expect(body.url).toBeTruthy();
		expect(await storage.exists(body.key)).toBe(true);
		await storage.delete(body.key).catch(() => {});
	});

	it("🚨 leaves video, audio and assets to the queued scan", async () => {
		// Not an oversight: PDQ has nothing to say about audio or a game archive, a video
		// has to be decoded into frames rather than hashed whole, and all three arrive at up
		// to 500 MB. They are scanned by `QUEUES.SCAN_MEDIA` once a key is attached to a
		// Work, which is also the only path available for the presigned door.
		expect(scannedObjectKind("video")).toBeNull();
		expect(scannedObjectKind("audio")).toBeNull();
		expect(scannedObjectKind("asset")).toBeNull();
		// ⭐ And an unrecognized media type IS scanned, which is the opposite direction from
		// the ACL allowlist next door — failing closed means "withhold" for an ACL and
		// "look" for detection.
		expect(scannedObjectKind("something-invented")).toBe("upload");
	});
});

describe("The operator's view of a Work-less finding", () => {
	it("counts it as an object rather than as a phantom Work", async () => {
		const key = await putObject("counted", 41);
		const before = await quarantineSummary();
		await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "header",
			source: "operator",
			classification: "apparent-csam",
		});
		const after = await quarantineSummary();

		expect(after.openFindings).toBe(before.openFindings + 1);
		expect(after.objects).toBe(before.objects + 1);

		// 🚨 **The delta is not enough, and reaching for it first is the trap.** Every
		// Work-less row carries `work_id = null`, so `new Set(rows.map(r => r.workId))` folds
		// *all* of them into one phantom entry — which means the count is already inflated by
		// the rows this suite wrote earlier, and adding one more leaves the delta at zero. A
		// before-and-after comparison would pass against exactly the bug it is here to catch.
		// So the count is checked against the table instead.
		const distinct = (
			(await db.execute(sql`
				SELECT COUNT(DISTINCT work_id)::int AS n
				FROM media_quarantine WHERE cleared_at IS NULL AND work_id IS NOT NULL
			`)) as unknown as { n: number }[]
		)[0].n;
		expect(after.works).toBe(distinct);
	});
});

describe("Clearing a Work-less finding", () => {
	it("puts the object back and closes the row", async () => {
		const key = await putObject("cleared", 51);
		const { findingId } = await quarantineObject({
			storageKey: key,
			uploaderId: creatorId,
			objectKind: "avatar",
			source: "scan",
			classification: "apparent-csam",
		});
		expect(await storage.exists(key)).toBe(false);

		const result = await clearObjectQuarantine({
			findingId: findingId!,
			actorId: creatorId,
			note: "mistake",
		});
		expect(result.cleared).toBe(true);
		expect(result.objectsRestored).toBe(1);
		// The key is echoed back so an operator is shown *what* they cleared rather than a
		// tick — the same lesson the legal-hold console learned about acting on an id.
		expect(result.storageKey).toBe(key);
		expect(await storage.exists(key)).toBe(true);
	});

	it("🚨 refuses a finding id that matches nothing instead of reporting success", async () => {
		// Every integer is a plausible finding id. A clear that quietly does nothing and
		// answers `objectsRestored: 0` is indistinguishable from one that worked on an object
		// storage had already lost, and that is precisely how a hold on a typo used to look.
		const result = await clearObjectQuarantine({ findingId: 2_000_000_000, actorId: creatorId });
		expect(result.cleared).toBe(false);
		expect(result.storageKey).toBe("");
	});

	it("refuses a finding that names a Work, which the other door owns", async () => {
		// 🚨 Clearing a Work's quarantine also restores the visibility the creator chose, and
		// this path cannot do that. Half-clearing it would leave the Work delisted forever
		// with no open finding left to say why.
		const work = await insertWork({ creatorId, type: "image", title: `Owned by a Work ${RUN}` });
		const key = `creators/${creatorId}/thumbnails/${work.publicId}/${RUN}-work.png`;
		await storage.upload(key, await artworkBytes(61), "image/png", "public");
		await db.execute(sql`UPDATE works SET thumbnail = ${key} WHERE id = ${work.id}`);

		await quarantineWork({ workId: work.id, source: "operator", classification: "apparent-csam" });
		const [row] = await findingFor(key);
		expect(row, "the fixture must actually have produced a Work finding").toBeDefined();

		const result = await clearObjectQuarantine({ findingId: row.id, actorId: creatorId });
		expect(result.cleared).toBe(false);
		// And the finding is still open, so the right door can still close it.
		const [after] = await db
			.select({ clearedAt: mediaQuarantine.clearedAt })
			.from(mediaQuarantine)
			.where(eq(mediaQuarantine.id, row.id));
		expect(after.clearedAt).toBeNull();
	});
});

afterAll(async () => {
	// ⚠️ **Ask what does NOT cascade.** `media_quarantine.uploader_id` and `work_id` are both
	// `set null` by design, a parked object is a file rather than a row, and `legal_holds`
	// carries no foreign key to its subject at all — so deleting the account leaves every
	// one of the three, and a stale hold suspends real sweeps in later runs.
	const rows = await db
		.select({
			originalKey: mediaQuarantine.originalKey,
			quarantineKey: mediaQuarantine.quarantineKey,
		})
		.from(mediaQuarantine)
		.where(eq(mediaQuarantine.uploaderId, creatorId));
	for (const r of rows) {
		await storage.delete(r.quarantineKey).catch(() => {});
		await storage.delete(r.originalKey).catch(() => {});
	}
	// Findings whose uploader is already null are found by the run id in their key instead.
	await db.execute(sql`DELETE FROM media_quarantine WHERE original_key LIKE ${`%${RUN}%`}`);
	await db.execute(sql`DELETE FROM media_scans WHERE storage_key LIKE ${`%${RUN}%`}`);
	await db.execute(sql`DELETE FROM legal_holds WHERE reason LIKE ${`%${RUN}%`}`);
	await db.execute(
		sql`DELETE FROM legal_holds WHERE subject_type = 'user' AND subject_id = ${creatorId}`,
	);
	await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);
});
