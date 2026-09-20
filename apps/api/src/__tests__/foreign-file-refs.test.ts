// SPDX-License-Identifier: Apache-2.0
/**
 * An account cannot point anything it owns at a file another account uploaded.
 *
 * Every column this suite writes — a Work's source and thumbnail, an asset's file, a Project's
 * cover, an account's avatar and header — is read by something that acts on the object it
 * names. Delivery signs it for the owner, release lists it under the owner's name, and deletion
 * destroys it, so until 2026-09-16 naming another creator's original and then deleting your own
 * Work destroyed theirs. `services/storage/keys.ts` carries the reasoning.
 *
 * 🚨 **Both halves are asserted, and neither may be deleted to make the other pass.** The write
 * routes refuse a foreign reference, and the purge refuses to delete outside the owner's prefix
 * even when a row names one, because a row written before the check — or by a path that forgot
 * it — must not be able to destroy somebody else's file.
 *
 * ⚠️ `queue.send` is replaced, because attaching a file enqueues a transcode and a scan and
 * pg-boss is not running under the test runner.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { projects, users, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { queue } from "../jobs/queue";
import { addUserImages, collectWorkMedia } from "../services/media-purge.js";
import { storage } from "../services/storage/index.js";
import { isOwnStorageRef } from "../services/storage/keys.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const victimName = `ffr_victim_${run}`;
const attackerName = `ffr_attacker_${run}`;

let attacker = { id: 0, cookie: "" };
let victim = { id: 0, cookie: "" };
const workIds: number[] = [];
const projectSlugs: string[] = [];
const storedKeys: string[] = [];
let sendSpy: ReturnType<typeof spyOn>;

/** A key under an account's prefix, as the upload routes mint them. */
const keyFor = (userId: number, path: string) => `creators/${userId}/${path}-${run}`;

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function refusal(res: Response): Promise<string | null> {
	return res.status === 400 ? (((await res.json()) as { code?: string }).code ?? null) : null;
}

async function createWork(cookie: string, body: Record<string, unknown>) {
	const res = await call("POST", "/api/content/works", cookie, { title: `ffr ${run}`, ...body });
	if (res.status === 201)
		workIds.push(((await res.clone().json()) as { work: { id: number } }).work.id);
	return res;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${victimName + "@example.com"}`, sql`${attackerName + "@example.com"}`], sql`, `)})`,
	);
	for (const [name, set] of [
		[victimName, (v: typeof victim) => (victim = v)],
		[attackerName, (v: typeof attacker) => (attacker = v)],
	] as const) {
		const account = await createAccount(name);
		await enablePayouts(name);
		set({ id: account.userId as number, cookie: account.cookie });
	}
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
}, DB_SETUP_TIMEOUT);

// By id, because the account purge sets `works.creator_id` null when it runs first.
afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	if (projectSlugs.length > 0)
		await db.delete(projects).where(inArray(projects.slug, projectSlugs));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

describe("isOwnStorageRef", () => {
	it("accepts the two shapes the upload routes hand back, and nothing else", async () => {
		const own = keyFor(attacker.id, "thumbnails/a.png");
		expect(await isOwnStorageRef("", attacker.id)).toBe(true);
		expect(await isOwnStorageRef(own, attacker.id)).toBe(true);
		expect(await isOwnStorageRef(await storage.getUrl(own), attacker.id)).toBe(true);

		expect(await isOwnStorageRef(keyFor(victim.id, "thumbnails/a.png"), attacker.id)).toBe(false);
		// Another host's URL whose path looks exactly like one of the attacker's own keys.
		expect(await isOwnStorageRef(`https://files.example/${own}`, attacker.id)).toBe(false);
		// A prefix test passes this, and the local backend's path join would walk out of it.
		expect(
			await isOwnStorageRef(
				`creators/${attacker.id}/../${victim.id}/videos/originals/x.mp4`,
				attacker.id,
			),
		).toBe(false);
		// `creators/1` must not own `creators/12`.
		expect(await isOwnStorageRef(`creators/${attacker.id}0/x.png`, attacker.id)).toBe(false);
	});
});

describe("the write routes refuse another account's file", () => {
	const victimSource = () => keyFor(victim.id, "videos/originals/original.mp4");

	it("refuses it as a new Work's source or thumbnail", async () => {
		expect(
			await refusal(
				await createWork(attacker.cookie, { type: "video", sourceKey: victimSource() }),
			),
		).toBe("foreign_file");
		const victimThumb = await storage.getUrl(keyFor(victim.id, "thumbnails/cover.png"));
		expect(
			await refusal(await createWork(attacker.cookie, { type: "game", thumbnail: victimThumb })),
		).toBe("foreign_file");
	});

	it("accepts the account's own file", async () => {
		const res = await createWork(attacker.cookie, {
			type: "video",
			sourceKey: keyFor(attacker.id, "videos/originals/mine.mp4"),
		});
		expect(res.status).toBe(201);
	});

	it("refuses it as an edit, and stores nothing else the request carried", async () => {
		const res = await createWork(attacker.cookie, { type: "video" });
		const { work } = (await res.json()) as { work: { id: number } };
		const patched = await call("PATCH", `/api/content/works/${work.id}`, attacker.cookie, {
			sourceKey: victimSource(),
			maturityRows: rowsRatedAs("general"),
		});
		expect(await refusal(patched)).toBe("foreign_file");
		const [row] = await db.select().from(works).where(eq(works.id, work.id));
		expect(row.sourceKey).toBe("");
		// The rating is written ahead of the release gates on this route, so a refusal placed
		// after it would have kept it.
		expect(row.maturity).toBe("unrated");
	});

	it("leaves a row written before the check editable when the request repeats it", async () => {
		const legacy = await insertWork({
			creatorId: attacker.id,
			type: "video",
			visibility: "private",
			sourceKey: victimSource(),
		});
		workIds.push(legacy.id);
		const res = await call("PATCH", `/api/content/works/${legacy.id}`, attacker.cookie, {
			title: "Renamed",
			sourceKey: victimSource(),
		});
		expect(res.status).toBe(200);
	});

	it("refuses it as an asset, which the download route would sign for the owner", async () => {
		const res = await createWork(attacker.cookie, { type: "game" });
		const { work } = (await res.json()) as { work: { id: number } };
		const asset = (file: string) =>
			call("POST", `/api/content/works/${work.id}/assets`, attacker.cookie, {
				file,
				filename: "build.zip",
			});
		expect(await refusal(await asset(keyFor(victim.id, "assets/paid-build.zip")))).toBe(
			"foreign_file",
		);
		expect((await asset(keyFor(attacker.id, "assets/own-build.zip"))).status).toBe(201);
	});

	it("refuses it as an avatar or a header", async () => {
		const foreign = await storage.getUrl(keyFor(victim.id, "avatars/face.png"));
		expect(
			await refusal(await call("PATCH", "/api/accounts/me", attacker.cookie, { avatar: foreign })),
		).toBe("foreign_file");
		expect(
			await refusal(
				await call("PATCH", "/api/accounts/me", attacker.cookie, { headerImage: foreign }),
			),
		).toBe("foreign_file");
		const own = await storage.getUrl(keyFor(attacker.id, "avatars/face.png"));
		expect((await call("PATCH", "/api/accounts/me", attacker.cookie, { avatar: own })).status).toBe(
			200,
		);
		const [row] = await db
			.select({ avatar: users.avatar })
			.from(users)
			.where(eq(users.id, attacker.id));
		expect(row.avatar).toBe(own);
	});

	it("refuses it as a Project's cover, on create and on edit", async () => {
		const foreign = await storage.getUrl(keyFor(victim.id, "covers/album.png"));
		const slug = `ffr-${run}`;
		projectSlugs.push(slug);
		const create = (coverImage: string) =>
			call("POST", "/api/content/projects", attacker.cookie, { title: "ffr", slug, coverImage });
		expect(await refusal(await create(foreign))).toBe("foreign_file");
		expect((await create("")).status).toBe(201);
		const edit = await call("PATCH", `/api/content/projects/${slug}`, attacker.cookie, {
			coverImage: foreign,
		});
		expect(await refusal(edit)).toBe("foreign_file");
	});
});

describe("deletion never reaches another account's file", () => {
	it("leaves the victim's original in place when a Work naming it is deleted", async () => {
		// The attack as it worked: a row naming the victim's file, then deleting that row's Work.
		// Inserted directly, because the write routes now refuse to create it.
		const victimKey = keyFor(victim.id, "videos/originals/precious.mp4");
		const ownKey = keyFor(attacker.id, "thumbnails/own.png");
		for (const key of [victimKey, ownKey]) {
			await storage.upload(key, new Uint8Array([1, 2, 3]), "application/octet-stream");
			storedKeys.push(key);
		}
		const bait = await insertWork({
			creatorId: attacker.id,
			type: "video",
			visibility: "private",
			sourceKey: victimKey,
			thumbnail: await storage.getUrl(ownKey),
		});

		const collected = await collectWorkMedia([bait.id]);
		expect([...collected.keys]).toEqual([ownKey]);

		const res = await call("DELETE", `/api/content/works/${bait.id}`, attacker.cookie);
		expect(res.status).toBe(204);
		expect(await storage.exists(victimKey)).toBe(true);
		// And the attacker's own file did go, so the filter is not simply sweeping nothing.
		expect(await storage.exists(ownKey)).toBe(false);
	});

	it("does not collect another account's image as this account's avatar", () => {
		const collected = addUserImages(
			{ keys: new Set(), prefixes: new Set() },
			{
				id: attacker.id,
				avatar: keyFor(victim.id, "avatars/face.png"),
				headerImage: keyFor(attacker.id, "headers/own.png"),
			},
		);
		expect([...collected.keys]).toEqual([keyFor(attacker.id, "headers/own.png")]);
	});
});
