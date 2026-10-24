// SPDX-License-Identifier: Apache-2.0
/**
 * The manifest route's answers a page can act on, without a space server in the path.
 *
 * The protocol half is `space-credential-staging.test.ts`. What this holds is the shell: an
 * unauthenticated caller is refused, a Work with no manifest is a 404 rather than a read, and
 * a reader the gate does not admit is refused **before** any delegation or credential request
 * — which is the property that keeps a refusal from costing a network round trip and keeps the
 * route from being an oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
let readerCookie = "";
let creatorId = 0;
let creatorDid = "";

function get(path: string, cookie?: string) {
	return app.fetch(
		new Request(`${ORIGIN}${path}`, {
			headers: cookie ? { Cookie: cookie } : {},
		}),
	);
}

beforeAll(async () => {
	const creator = await createAccount(`manifest-creator-${Date.now().toString(36)}`);
	creatorId = creator.userId;
	creatorDid = creator.did;
	const reader = await createAccount(`manifest-reader-${Date.now().toString(36)}`);
	readerCookie = reader.cookie;
});

afterAll(async () => {
	await db
		.delete(works)
		.where(eq(works.creatorId, creatorId))
		.catch(() => undefined);
});

describe("GET /works/:id/manifest", () => {
	it("refuses a signed-out caller", async () => {
		const work = await insertWork({ creatorId, type: "text", title: "No session" });
		const response = await get(`/api/content/works/${work.id}/manifest`);
		expect(response.status).toBe(401);
	});

	it("answers 404 for a Work with no manifest", async () => {
		const work = await insertWork({
			creatorId,
			type: "text",
			title: "No manifest",
			visibility: "private",
		});
		const response = await get(`/api/content/works/${work.id}/manifest`, readerCookie);
		expect(response.status).toBe(404);
		expect((await response.json()).code).toBe("manifest_missing");
	});

	it("refuses a reader the gate does not admit, before any space call", async () => {
		const work = await insertWork({
			creatorId,
			type: "text",
			title: "Gated",
			visibility: "released",
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		});
		await db
			.update(works)
			.set({
				gatedSpaceUri: `at://${creatorDid}/space/org.anthers.creatorSpace/${work.publicId}`,
				manifestUri: `at://${creatorDid}/space/org.anthers.creatorSpace/${work.publicId}/org.anthers.manifest/manifest`,
			})
			.where(eq(works.id, work.id));

		const response = await get(`/api/content/works/${work.id}/manifest`, readerCookie);
		expect(response.status).toBe(403);
		expect((await response.json()).code).toBe("not_entitled");
	});
});
