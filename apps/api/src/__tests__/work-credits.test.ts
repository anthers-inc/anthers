// SPDX-License-Identifier: Apache-2.0
/**
 * The credits table a Work carries — creator-asserted provenance, `POST`/`PATCH` round-trip.
 *
 * The two rules being proven are the shape of the thing: a `created` credit must name its
 * contributor (a 400, with the refusal pointing at the row), while a pure `licensed`/`ai`
 * credit may stay anonymous. Blank rows survive — credits are asserted, and a Work with
 * none is an ordinary Work, not a demonetized one.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { type WorkCredit, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = Date.now().toString(36);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

let auth: Record<string, string>;
let workId: number;

const createdWorkIds: number[] = [];
afterAll(async () => {
	await purgeWorkIds(createdWorkIds);
});

describe("Work credits", () => {
	beforeAll(async () => {
		const account = await createAccount(`wc_${RUN}`);
		auth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: account.cookie };
	}, DB_SETUP_TIMEOUT);

	it("round-trips a credits table on create", async () => {
		const credits: WorkCredit[] = [
			{ role: "Written and directed by", contributor: "A. Creator", types: ["created"] },
			{ role: "Illustrations", contributor: "", types: ["ai"] },
			{ role: "Icons", contributor: "The Noun Project", types: ["licensed"] },
		];
		const res = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				type: "image",
				title: "Credited work",
				maturityRows: rowsRatedAs("general"),
				credits,
			}),
		});
		expect(res.status).toBe(201);
		const { work } = (await res.json()) as {
			work: { id: number; credits: typeof credits };
		};
		workId = work.id;
		createdWorkIds.push(workId);
		expect(work.credits).toEqual(credits);
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		// The AI and licensed rows store the contributor as entered — blank is a real value.
		expect(row.credits).toEqual(credits);
	});

	it("refuses a created credit with no contributor — a human-made part names its human", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				type: "image",
				title: "Anonymous authorship",
				maturityRows: rowsRatedAs("general"),
				credits: [{ role: "Drawn by", contributor: "  ", types: ["created"] }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("created");
	});

	it("refuses a created+ai blend with no contributor too — blending changes nothing", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				type: "image",
				title: "Anonymous blend",
				maturityRows: rowsRatedAs("general"),
				credits: [{ role: "Cover", contributor: "", types: ["created", "ai"] }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("refuses a credit that asserts nothing — an empty types array is not a credit", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				type: "image",
				title: "Creditless credit",
				maturityRows: rowsRatedAs("general"),
				credits: [{ role: "Made by", contributor: "Someone", types: [] }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("accepts anonymous licensed and AI rows — only created forces a name", async () => {
		const credits = [
			{ role: "Sample pack", contributor: "", types: ["licensed"] },
			{ role: "Voiceover", contributor: "", types: ["ai"] },
		];
		const res = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({
				type: "audio",
				title: "Anonymous sources",
				maturityRows: rowsRatedAs("general"),
				credits,
			}),
		});
		expect(res.status).toBe(201);
		const { work } = (await res.json()) as { work: { id: number } };
		createdWorkIds.push(work.id);
	});

	it("PATCH replaces the table wholesale, and an absent PATCH leaves it alone", async () => {
		// Replace.
		const next: WorkCredit[] = [
			{ role: "Written by", contributor: "B. Editor", types: ["created"] },
		];
		const patch = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({ credits: next }),
		});
		expect(patch.status).toBe(200);
		let [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.credits).toEqual(next);

		// Unchanged when omitted.
		const noop = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({ title: "Still credited" }),
		});
		expect(noop.status).toBe(200);
		[row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.credits).toEqual(next);

		// Cleared by an empty array, which is a table of no credits rather than an omission.
		const cleared = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({ credits: [] }),
		});
		expect(cleared.status).toBe(200);
		[row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.credits).toEqual([]);
	});

	it("PATCH enforces the contributor rule as well", async () => {
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({
				credits: [{ role: "Everything", contributor: "", types: ["created"] }],
			}),
		});
		expect(res.status).toBe(400);
	});
});
