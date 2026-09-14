// SPDX-License-Identifier: Apache-2.0
/**
 * Publishing and retiring schemas, against the private network `make pds-up` starts.
 *
 * `atproto-publish-lexicon.test.ts` proves every refusal against an in-memory repository. This
 * proves the part that talks to a server: that each of Anthers' real schemas goes out and reads
 * back exactly as written, that a second run leaves an unchanged schema alone, and that retiring
 * one removes both the record and its committed copy. The production path runs here too, with
 * only the DNS answer stubbed — pointed at a temporary directory rather than `lexicons-published/`,
 * which describes production and is never touched by a test.
 *
 * 🚨 **It refuses to run unless `ATPROTO_TEST_PDS` names a server**, which `make pds-test` sets to
 * the local network; the writer underneath refuses a real server regardless.
 *
 *   make pds-up && make pds-test
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtpAgent } from "@atproto/api";
import {
	collectPlans,
	type PublishTarget,
	publishedCopies,
	publishPlan,
	retireSchema,
	SCHEMA_COLLECTION,
} from "./atproto-publish-lexicon.js";
import { type SessionWriter, sessionWriter } from "./atproto-writer.js";
import { publishedPath } from "./lexicon-evolution.js";

const SERVICE = process.env.ATPROTO_TEST_PDS;
const handle = `lex-${Date.now().toString(36)}.test`;
const password = `EXAMPLE-${crypto.randomUUID()}`;
const plans = collectPlans();

let writer: SessionWriter;
let scratch = "";

beforeAll(async () => {
	if (!SERVICE) return;
	await new AtpAgent({ service: SERVICE }).com.atproto.server.createAccount({
		handle,
		email: `${handle}@example.invalid`,
		password,
	});
	writer = await sessionWriter({ service: SERVICE, identifier: handle, password });
	scratch = mkdtempSync(join(tmpdir(), "anthers-lexicons-published-"));
}, 60_000);

afterAll(async () => {
	if (!SERVICE) return;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	for (const plan of plans)
		await writer?.deleteRecord(SCHEMA_COLLECTION, plan.rkey).catch(() => {});
});

describe.skipIf(!SERVICE)("publishing Anthers' schemas to a real server", () => {
	it("rehearses every schema: each goes out and reads back as written, and no copy is touched", async () => {
		const committed = publishedCopies();
		const touched: string[] = [];
		const target: PublishTarget = {
			writer,
			rehearsal: true,
			resolveTxt: async () => {
				throw new Error("a rehearsal never consults DNS");
			},
			copies: {
				read: (nsid) => committed.read(nsid),
				write: (nsid) => void touched.push(nsid),
				remove: (nsid) => void touched.push(nsid),
			},
		};

		for (const plan of plans) {
			expect(await publishPlan(plan, target)).toMatchObject({
				nsid: plan.nsid,
				status: "published",
			});
			const { $type: _type, ...doc } = plan.record;
			expect(await writer.getRecord(SCHEMA_COLLECTION, plan.rkey)).toMatchObject(doc);
		}
		expect(touched).toEqual([]);
	});

	it("runs the production path: records the copy, then leaves an unchanged schema alone", async () => {
		const plan = plans.find((p) => p.nsid === "org.anthers.post");
		if (!plan) throw new Error("org.anthers.post is missing from lexicons/");
		await writer.deleteRecord(SCHEMA_COLLECTION, plan.rkey);

		const target: PublishTarget = {
			writer,
			rehearsal: false,
			resolveTxt: async () => [`did=${writer.did}`],
			copies: publishedCopies(scratch),
		};

		expect(await publishPlan(plan, target)).toMatchObject({ status: "published" });
		const copy = publishedPath(plan.nsid, scratch);
		expect(readFileSync(copy, "utf8")).toBe(readFileSync(plan.sourcePath, "utf8"));

		expect(await publishPlan(plan, target)).toEqual({ nsid: plan.nsid, status: "unchanged" });

		expect(await retireSchema(plan.nsid, target)).toEqual({ nsid: plan.nsid, status: "retired" });
		expect(await writer.getRecord(SCHEMA_COLLECTION, plan.rkey)).toBeNull();
		expect(publishedCopies(scratch).read(plan.nsid)).toBeNull();
	});

	it("writes nothing for an edit that breaks the published copy", async () => {
		const plan = structuredClone(plans.find((p) => p.nsid === "org.anthers.project"));
		if (!plan) throw new Error("org.anthers.project is missing from lexicons/");
		await writer.deleteRecord(SCHEMA_COLLECTION, plan.rkey);
		const main = (plan.record.defs as Record<string, Record<string, unknown>>).main;
		const record = main.record as { properties: Record<string, unknown> };
		const [first] = Object.keys(record.properties);
		delete record.properties[first];

		const outcome = await publishPlan(plan, {
			writer,
			rehearsal: true,
			resolveTxt: async () => [],
			copies: publishedCopies(),
		});
		expect(outcome).toMatchObject({ status: "refused" });
		expect(await writer.getRecord(SCHEMA_COLLECTION, plan.rkey)).toBeNull();
	});
});
