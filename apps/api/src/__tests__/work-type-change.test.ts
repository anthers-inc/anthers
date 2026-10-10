// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's kind changing on the fly, and the drafting state it is allowed from.
 *
 * The rule (Parker, 2026-10-10): a Work can be drafted before its file exists, and the kind a
 * draft starts as often isn't the kind it ends as — so `PATCH /works/:id` accepts `type` while
 * nothing kind-specific exists to strand. The properties under test, one spec each:
 * - **Creation needs no file** — a file-kind Work is creatable with no `sourceKey`, which the
 *   create-on-pick UI never exercised but the draft flow now stands on.
 * - **A kind change resets the rating**, because the rows were answered against the old kind's
 *   grid and reading them against the new one could add up to a rating nobody gave (the rating
 *   service's `resetRatingForTypeChange` is the only writer of that state).
 * - **A kind change is refused once media exists**, because a comic Work carrying a video's
 *   source is a row whose every downstream reader disagrees about what it is.
 * - **A kind change is refused on a released Work** — the kind is part of the public listing.
 * - **A kind change composes with a fresh answer**: rows sent in the same request as the change
 *   are read against the NEW grid, so a creator can change kind and rate in one save.
 *
 * ⚠️ The operator-locked refusal is not exercised here: it needs an operator correction, a
 * different fixture rail, and the guard is one readable line (`ratingOf(work).locked`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

let creator = { id: 0, cookie: "" };
const workIds: number[] = [];

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

beforeAll(async () => {
	const account = await createAccount(`typechange_creator_${run}`);
	creator = { id: account.userId as number, cookie: account.cookie };
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(eq(works.creatorId, creator.id));
});

describe("drafting a Work of a changeable kind", () => {
	it("creates a file-kind Work with no file at all", async () => {
		const res = await call("POST", "/api/content/works", creator.cookie, {
			type: "comic",
			title: "The draft with no pages yet",
			access: [{ threshold: 0, label: "Everyone", allow: true, price: "0" }],
		});
		expect(res.status).toBe(201);
		const { work } = (await res.json()) as { work: { id: number; sourceKey: string } };
		workIds.push(work.id);
		expect(work.sourceKey).toBe("");
	});

	it("changes kind on a private draft and unrates it", async () => {
		const work = insertWork({
			creatorId: creator.id,
			type: "ebook",
			visibility: "private",
			// A draft whose kind is about to change, already answered on the old grid.
			maturity: "general",
		});
		workIds.push((await work).id);
		const id = (await work).id;

		const res = await call("PATCH", `/api/content/works/${id}`, creator.cookie, { type: "video" });
		expect(res.status).toBe(200);
		const { work: updated } = (await res.json()) as {
			work: {
				type: string;
				maturity: string;
				maturityRows: Record<string, string>;
				maturityNotes: string[];
			};
		};
		expect(updated.type).toBe("video");
		// The old grid's answer does not survive a kind change: unrated, rows and notes gone.
		expect(updated.maturity).toBe("unrated");
		expect(updated.maturityRows).toEqual({});
		expect(updated.maturityNotes).toEqual([]);
	});

	it("answers a fresh rating against the NEW grid in the same request as the change", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
		});
		workIds.push(work.id);

		// A complete answer on the grid the Work is being changed TO … sent with the kind it
		// is meant for.
		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			type: "ebook",
			maturityRows: rowsRatedAs("general"),
		});
		expect(res.status).toBe(200);
		const { work: updated } = (await res.json()) as {
			work: { type: string; maturityRows: Record<string, string>; maturity: string };
		};
		expect(updated.type).toBe("ebook");
		// The rows sent with the change land on the new grid, not the old one: an answer to
		// the visual grid would have been dropped or misread here.
		expect(Object.keys(updated.maturityRows).length).toBeGreaterThan(0);
		expect(updated.maturity).toBe("general");
	});

	it("refuses a kind change once media exists", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "comic",
			visibility: "private",
			sourceKey: `creators/${creator.id}/assets/no-such-uuid.pdf`,
		});
		workIds.push(work.id);

		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			type: "video",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("type_has_media");
	});

	it("refuses a kind change on a released Work", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "video",
			visibility: "released",
		});
		workIds.push(work.id);

		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			type: "comic",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("type_not_private");
	});

	it("refuses a kind change on a piece of writing with words in it", async () => {
		const work = await insertWork({
			creatorId: creator.id,
			type: "text",
			visibility: "private",
			body: "Some prose.",
			bodyHtml: "<p>Some prose.</p>",
		});
		workIds.push(work.id);

		const res = await call("PATCH", `/api/content/works/${work.id}`, creator.cookie, {
			type: "comic",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("type_has_media");
	});
});