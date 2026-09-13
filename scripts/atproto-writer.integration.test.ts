// SPDX-License-Identifier: Apache-2.0
/**
 * The record-writing path, against a real Personal Data Server.
 *
 * `atproto-repo.test.ts` proves the *decision* — what should happen to a listing — against a
 * fake repository, exhaustively and in milliseconds. This proves the other half: that the
 * decision, carried out over the wire, produces the record we validated and removes it again
 * when the Work stops being publicly listed.
 *
 * 🚨 **It refuses to run unless `ATPROTO_TEST_PDS` names a server**, and that is the safety
 * property rather than a convenience. A record written to a real server is world-readable
 * the moment it lands and is broadcast to everyone listening, and deleting it afterwards
 * broadcasts only the deletion — anybody who kept a copy keeps it. Requiring the operator to
 * name the target means this can never reach production by defaulting to something.
 *
 *   make pds-up && make pds-test
 *
 * ⚠️ **The account this creates is deactivated rather than deleted.** Deleting an account
 * needs a token the server emails, which a throwaway PDS has nowhere to send. The records
 * are removed properly in `afterAll`, which is the part that matters, and `compose.pds.yaml`
 * keeps its data in a tmpfs so the account dies with the container anyway.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { AtpAgent } from "@atproto/api";
import type { PublishableWork } from "../apps/api/src/services/atproto-records.js";
import {
	planWorkRecord,
	type RepoWriter,
	rkeyFromAtUri,
	syncWorkRecord,
	WORK_COLLECTION,
} from "../apps/api/src/services/atproto-repo.js";
import { readRecord, sessionWriter } from "./atproto-writer.js";

const SERVICE = process.env.ATPROTO_TEST_PDS;
const BASE = "https://anthers.org";

/**
 * Handles must sit under a domain the server offers; a dev PDS offers `.test`.
 *
 * ⚠️ Base-36 rather than a plain timestamp because the server rejects a long first segment
 * outright — `InvalidHandle: Handle too long` — and a spelled-out `anthers-probe-<millis>`
 * is over the limit.
 */
const handle = `probe-${Date.now().toString(36)}.test`;
const password = `probe-${crypto.randomUUID()}`;

function releasedWork(overrides: Partial<PublishableWork> = {}): PublishableWork {
	return {
		id: 1,
		creatorId: 42,
		streamEnabled: true,
		downloadEnabled: false,
		maturity: "general",
		takedownStatus: "active",
		quarantineStatus: "none",
		visibility: "released",
		seedAccess: [{ threshold: 0, allow: true, price: "0" }] as never,
		type: "game",
		title: "The Weight of Small Hours",
		description: "A short game.",
		slug: "the-weight-of-small-hours",
		publicId: 4192,
		releasedAt: new Date("2026-08-14T00:00:00.000Z"),
		...overrides,
	};
}

/** Everything this suite wrote, so teardown can remove it whether or not the tests passed. */
const written: { rkey: string }[] = [];
let writer: RepoWriter | null = null;

afterAll(async () => {
	if (!SERVICE || !writer) return;
	for (const { rkey } of written) {
		// Best effort per record: a test that already failed must still clear what it wrote,
		// and one stubborn record must not stop the rest being cleaned up.
		await writer.deleteRecord(WORK_COLLECTION, rkey).catch(() => {});
	}
	const agent = new AtpAgent({ service: SERVICE });
	await agent
		.login({ identifier: handle, password })
		.then(() => agent.com.atproto.server.deactivateAccount({}))
		.catch(() => {});
});

describe.skipIf(!SERVICE)("writing a listing to a real repository", () => {
	it("creates an account to write into", async () => {
		const agent = new AtpAgent({ service: SERVICE as string });
		await agent.com.atproto.server.createAccount({
			handle,
			email: `${handle}@example.invalid`,
			password,
		});
		writer = await sessionWriter({ service: SERVICE as string, identifier: handle, password });
		expect(writer.did).toStartWith("did:");
	});

	it("writes exactly the record the mapper produced", async () => {
		const out = await syncWorkRecord(writer as RepoWriter, releasedWork(), { baseUrl: BASE });
		expect(out.plan.action).toBe("create");
		expect(out.uri).toBeTruthy();

		const rkey = rkeyFromAtUri(out.uri as string, WORK_COLLECTION);
		expect(rkey).toBeTruthy();
		written.push({ rkey: rkey as string });

		// Read back over the wire rather than trusting what we sent. The plan is the local
		// expectation; this is the only assertion about what the network actually holds.
		const stored = await readRecord({
			service: SERVICE as string,
			identifier: handle,
			password,
			collection: WORK_COLLECTION,
			rkey: rkey as string,
		});
		const plan = planWorkRecord(releasedWork(), { baseUrl: BASE });
		expect(plan.action).toBe("create");
		expect(stored).toEqual((plan as { record: unknown }).record as never);
	});

	it("replaces at the same key rather than adding a second listing", async () => {
		const existingUri = `at://${(writer as RepoWriter).did}/${WORK_COLLECTION}/${written[0].rkey}`;
		const out = await syncWorkRecord(writer as RepoWriter, releasedWork({ title: "Renamed" }), {
			baseUrl: BASE,
			existingUri,
		});
		expect(out.plan).toMatchObject({ action: "replace", rkey: written[0].rkey });
		expect(out.uri).toBe(existingUri);
	});

	// 🚨 The assertion the whole path exists to support. A withdrawn Work must not keep a
	// listing advertising it on a network Anthers does not control.
	it("takes the listing down when the Work is withdrawn, and reports it gone", async () => {
		const existingUri = `at://${(writer as RepoWriter).did}/${WORK_COLLECTION}/${written[0].rkey}`;
		const out = await syncWorkRecord(
			writer as RepoWriter,
			releasedWork({ visibility: "withdrawn" }),
			{ baseUrl: BASE, existingUri },
		);
		expect(out.plan.action).toBe("delete");
		expect(out.uri).toBeNull();

		await expect(
			readRecord({
				service: SERVICE as string,
				identifier: handle,
				password,
				collection: WORK_COLLECTION,
				rkey: written[0].rkey,
			}),
		).rejects.toThrow();
	});

	// ⭐ A fact about the world, found by running it rather than by reading about it: asking
	// the server to validate a record whose Lexicon has never been published fails, because
	// there is nothing on the network for it to resolve. It is why `sessionWriter` sends
	// `validate: false`, and it should stop being true once the schema is published.
	it("is refused by server-side validation while the Lexicon is unpublished", async () => {
		const agent = new AtpAgent({ service: SERVICE as string });
		await agent.login({ identifier: handle, password });
		await expect(
			agent.com.atproto.repo.createRecord({
				repo: agent.did as string,
				collection: WORK_COLLECTION,
				record: {
					$type: WORK_COLLECTION,
					kind: "game",
					title: "validation probe",
					url: `${BASE}/works/probe-1`,
					releasedAt: "2026-08-14T00:00:00.000Z",
				},
				validate: true,
			}),
		).rejects.toThrow(/[Uu]nknown lexicon/);
	});
});
