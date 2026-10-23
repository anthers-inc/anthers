// SPDX-License-Identifier: Apache-2.0
/**
 * The identity bundle: the public repository, the spaces and their files, and the JSON export.
 *
 * The bundle is what stands between a deletion and a destroyed actor store, so the test reads
 * it back from the ZIP rather than trusting the builder's return value: every artifact the
 * deletion gate promises has to be in the bytes.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import app from "../index";
import { buildAtprotoExport } from "../services/atproto-export.js";
import { USER_SPACE_COLLECTIONS } from "../services/space-records.js";
import { spaceClientFor } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { spaceContext } from "./space-fixtures.js";

purgeAccountsCreatedHere();

const SAVE = new TextEncoder().encode("a reader's save\n".repeat(10));

describe("the AT Protocol export", () => {
	it("carries the public repo, the space, its records, its blob and the JSON export", async () => {
		const ctx = await spaceContext();
		const client = spaceClientFor(ctx.session, { fetchImpl: ctx.pds.fetch });

		const blob = await client.uploadBlob(SAVE, "text/plain");
		await client.putRecord({
			space: ctx.spaceUri,
			repo: ctx.did,
			collection: USER_SPACE_COLLECTIONS.workSave,
			rkey: "work-1",
			record: { $type: USER_SPACE_COLLECTIONS.workSave, blob },
			validate: false,
		});

		const built = await buildAtprotoExport(ctx.userId, {
			resolveSession: ctx.resolveSession,
			fetchImpl: ctx.pds.fetch,
		});
		if (!built.ok) throw new Error(`export failed: ${built.reason}`);

		expect(built.manifest.publicRepo.present).toBe(true);
		expect(built.manifest.publicRepo.bytes).toBeGreaterThan(0);
		expect(built.manifest.spaces).toHaveLength(1);
		expect(built.manifest.spaces[0]).toMatchObject({
			spaceUri: ctx.spaceUri,
			recordCount: 1,
			blobCount: 1,
		});

		const files = unzipSync(built.zip);
		const names = Object.keys(files);
		expect(names).toContain("manifest.json");
		expect(names).toContain("account.json");
		expect(names).toContain("public-repo.car");

		const dir = `spaces/${built.manifest.spaces[0].spaceType}/self`;
		expect(names).toContain(`${dir}/registry.json`);
		expect(names).toContain(`${dir}/records.json`);
		expect(names).toContain(`${dir}/blobs.json`);
		expect(names).toContain(`${dir}/star.car`);
		expect(names).toContain(`${dir}/blobs/${blob.ref.$link}`);

		const records = JSON.parse(new TextDecoder().decode(files[`${dir}/records.json`]));
		expect(records.records).toHaveLength(1);
		expect([...files[`${dir}/blobs/${blob.ref.$link}`]]).toEqual([...SAVE]);

		const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
		expect(manifest.format).toBe("anthers-atproto-export");
		expect(manifest.did).toBe(ctx.did);

		// The gate's evidence: the account now knows it holds a bundle.
		const [row] = await db
			.select({ atprotoExportedAt: users.atprotoExportedAt })
			.from(users)
			.where(eq(users.id, ctx.userId));
		expect(row?.atprotoExportedAt).not.toBeNull();
	});

	it("serves the bundle from the route as a ZIP", async () => {
		const account = await createAccount("exporter-route");
		const response = await app.fetch(
			new Request("http://localhost:3000/api/accounts/me/export/atproto", {
				method: "POST",
				headers: { cookie: account.cookie, origin: "http://localhost:3000" },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/zip");

		const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
		expect(Object.keys(files)).toContain("manifest.json");
		expect(Object.keys(files)).toContain("account.json");

		const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
		expect(manifest.did).toBe(account.did);
		// A fixture account has no registered space, so the bundle is its public repo and the
		// JSON export; the public repo exists because the fixture created the identity.
		expect(manifest.spaces).toEqual([]);
		expect(manifest.publicRepo.present).toBe(true);
	});
});
