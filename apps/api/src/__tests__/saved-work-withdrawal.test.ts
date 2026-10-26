// SPDX-License-Identifier: Apache-2.0
/**
 * Deleting a Work somebody saved withdraws it instead of destroying it.
 *
 * 🚨 **This is the case both disposal doors used to get wrong.** The preservation program
 * promises that a Work anybody saved stays available, and `works.preserved` has been set on
 * a save since the program landed. The delete route did not ask it: it counted *completed
 * purchases*, so a released Public Access Work with a hundred readers on their shelves and
 * no buyer was flagged for preservation, purged, and deleted. Same rule as a purchase:
 * somebody chose to keep this, and the creator's decision ends its public circulation rather
 * than the bytes.
 *
 * ⚠️ **The flag is the question, and the flag means somebody OTHER than the creator kept
 * the Work.** The two cases below that must still delete are the reason: a creator keeping
 * their own draft, and a Work nobody kept at all. A test that only proved the withdrawal
 * would pass against an implementation that withdrew everything, which is the trap the
 * preservation flag was narrowed to avoid.
 *
 * The media is asserted by the object still being in storage, not by "the code ran": the
 * purge is best-effort and silent, so absence of an error proves nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, notifications, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { saveWork } from "../services/library.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

let creatorId = 0;
let creatorCookie = "";
let saverId = 0;
const workIds: number[] = [];
const storedKeys: string[] = [];

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function remove(workId: number) {
	return req(`/api/content/works/${workId}?force=1`, {
		method: "DELETE",
		headers: { Origin: ORIGIN, Cookie: creatorCookie },
	});
}

/** A Work carrying one real stored asset, so the purge has something it could destroy. */
async function workWithBytes(opts: { title: string; visibility?: "private" | "released" }) {
	const work = await insertWork({
		creatorId,
		type: "game",
		title: opts.title,
		visibility: opts.visibility,
	});
	workIds.push(work.id);
	const key = `creators/${creatorId}/assets/${work.id}/build.zip`;
	await storage.upload(key, new Uint8Array(2048), "application/octet-stream", "private");
	storedKeys.push(key);
	await db.insert(assets).values({
		workId: work.id,
		file: key,
		filename: "build.zip",
		fileSize: 2048,
		platform: "windows",
	});
	return work;
}

/** Whether the Work's stored asset still exists — the media's presence, from the object. */
async function mediaExists(workId: number): Promise<boolean> {
	const [asset] = await db
		.select({ file: assets.file })
		.from(assets)
		.where(eq(assets.workId, workId));
	if (!asset) return false;
	return await storage.exists(asset.file);
}

async function workRow(workId: number) {
	const [row] = await db.select().from(works).where(eq(works.id, workId));
	return row;
}

beforeAll(async () => {
	const creator = await createAccount(`sww_c_${RUN}`, { fields: { creatorMode: true } });
	creatorId = creator.userId;
	creatorCookie = creator.cookie;
	const saver = await createAccount(`sww_s_${RUN}`);
	saverId = saver.userId;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

describe("somebody saved it, nobody bought it", () => {
	it("withdraws the Work rather than destroying it, and the media survives", async () => {
		const work = await workWithBytes({ title: `Saved ${RUN}` });
		expect((await saveWork(saverId, work.id)).ok).toBe(true);
		expect((await workRow(work.id)).preserved).toBe(true);

		const res = await remove(work.id);

		// 200, not 204: the Work was not deleted, and the caller is told so.
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ withdrawn: true, purchaseCount: 0 });

		const row = await workRow(work.id);
		expect(row).toBeDefined();
		expect(row.visibility).toBe("withdrawn");
		expect(row.withdrawnAt).not.toBeNull();
		expect(await mediaExists(work.id)).toBe(true);
	});

	it("tells nobody they lost a purchase, because nobody bought one", async () => {
		// 🚨 The notice is for buyers. A saved-only Work has none, and a withdrawal notice
		// claiming somebody's purchase was taken away would be a lie sent by the sweep's
		// sibling path rather than the sweep.
		const notices = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(
					inArray(notifications.userId, [creatorId, saverId]),
					eq(notifications.kind, "work_withdrawn_by_creator"),
				),
			);
		expect(notices).toEqual([]);
	});
});

describe("nobody is keeping it", () => {
	it("still destroys a Work nobody saved", async () => {
		const work = await workWithBytes({ title: `Unsaved ${RUN}` });

		const res = await remove(work.id);

		// 204: the ordinary delete, unchanged for the Work the program does not hold.
		expect(res.status).toBe(204);
		expect(await workRow(work.id)).toBeUndefined();
		expect(await mediaExists(work.id)).toBe(false);
	});

	it("still destroys a creator's own saved draft", async () => {
		// 🚨 The trap in the whole design. `saveWork` lets a creator keep their own
		// unreleased Work; if that save set the flag, this draft would be undeletable.
		const draft = await workWithBytes({ title: `OwnDraft ${RUN}`, visibility: "private" });
		expect((await saveWork(creatorId, draft.id)).ok).toBe(true);
		expect((await workRow(draft.id)).preserved).toBe(false);

		const res = await remove(draft.id);

		expect(res.status).toBe(204);
		expect(await workRow(draft.id)).toBeUndefined();
		expect(await mediaExists(draft.id)).toBe(false);
	});

	it("still destroys a released Work its creator saved and nobody else did", async () => {
		// The same rule on a released Work, so an implementation that special-cased
		// `private` rather than asking who the keeper is would fail here.
		const work = await workWithBytes({ title: `OwnReleased ${RUN}` });
		expect((await saveWork(creatorId, work.id)).ok).toBe(true);
		expect((await workRow(work.id)).preserved).toBe(false);

		const res = await remove(work.id);

		expect(res.status).toBe(204);
		expect(await workRow(work.id)).toBeUndefined();
		expect(await mediaExists(work.id)).toBe(false);
	});
});
