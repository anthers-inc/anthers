// SPDX-License-Identifier: Apache-2.0
/**
 * Deciding whether a Work's listing should be created, replaced or removed.
 *
 * 🚨 **The assertion that earns this file is the delete branch.** A record is public the
 * moment it is written and a deletion does not unsay it, so the expensive mistake is not a
 * missing listing — it is a listing that outlives the thing it advertises. Every test below
 * that names a withdrawn, taken-down or quarantined Work is checking that the record is
 * actively removed rather than merely not written.
 *
 * ⭐ These run against a fake repository on purpose. The decision is a pure function, so it
 * can be checked exhaustively here without a server, and what a real server does with the
 * result is a separate and much smaller question.
 */
import { describe, expect, it } from "bun:test";
import type { PublishableWork } from "../services/atproto-records.js";
import {
	planWorkRecord,
	type RecordRef,
	type RepoWriter,
	rkeyFromAtUri,
	syncWorkRecord,
	WORK_COLLECTION,
} from "../services/atproto-repo.js";

const BASE = "https://anthers.org";
const DID = "did:plc:75xx6l27mt7a3uxoga5ka4qt";
const RKEY = "3lbk2vqf7yk2a";
const URI = `at://${DID}/${WORK_COLLECTION}/${RKEY}`;

function openWork(overrides: Partial<PublishableWork> = {}): PublishableWork {
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
		type: "video",
		title: "A Short Film",
		description: "Ten minutes of something.",
		slug: "a-short-film",
		publicId: 90210,
		releasedAt: new Date("2026-07-01T00:00:00.000Z"),
		...overrides,
	};
}

/** Records every call, so a test can assert what reached the network and what did not. */
function fakeWriter(): RepoWriter & { calls: string[]; records: object[] } {
	const calls: string[] = [];
	const records: object[] = [];
	return {
		did: DID,
		calls,
		records,
		async createRecord(collection: string, record: object): Promise<RecordRef> {
			calls.push(`create ${collection}`);
			records.push(record);
			return { uri: URI, cid: "bafyreiexamplecid" };
		},
		async putRecord(collection: string, rkey: string, record: object): Promise<RecordRef> {
			calls.push(`put ${collection} ${rkey}`);
			records.push(record);
			return { uri: `at://${DID}/${collection}/${rkey}`, cid: "bafyreiexamplecid" };
		},
		async deleteRecord(collection: string, rkey: string): Promise<void> {
			calls.push(`delete ${collection} ${rkey}`);
		},
	};
}

describe("a Work corrected to Adult", () => {
	// 🚨 **The case that matters, and the one a "skip Adult works" fix would miss.** An operator
	// may correct a Work into Adult without its creator's agreement, which means a Work that
	// already has a public record can become one that must not have one. Leaving the record in
	// place would publish the title of something Anthers now hides the existence of.
	it("has its existing record DELETED rather than merely skipped", () => {
		const plan = planWorkRecord(openWork({ maturity: "adult" }), {
			baseUrl: BASE,
			existingUri: "at://did:plc:example/org.anthers.work/abc123",
		});
		expect(plan).toEqual({ action: "delete", rkey: "abc123", reason: "adult_rung" });
	});

	it("is simply never published when it never had a record", () => {
		const plan = planWorkRecord(openWork({ maturity: "adult" }), { baseUrl: BASE });
		expect(plan).toEqual({ action: "none", reason: "adult_rung" });
	});
});

describe("reading a record's address", () => {
	it("takes the rkey out of a well-formed URI", () => {
		expect(rkeyFromAtUri(URI, WORK_COLLECTION)).toBe(RKEY);
	});

	it("refuses a URI for a different collection", () => {
		// Not pedantry: the rkey would parse fine, and using it would replace whatever record
		// happened to share that key in OUR collection.
		//
		// ⚠️ The other collection is deliberately one of ours. Naming a real Bluesky posting
		// record here — the obvious illustration — trips `social-posting-guard.test.ts`, which
		// searches source files for those NSIDs as literals and cannot tell an example from a
		// call. That guard enforces Parker's rule rather than an engineering one, so the fix
		// is to pick a different example rather than to widen the guard.
		expect(rkeyFromAtUri(`at://${DID}/org.anthers.post/${RKEY}`, WORK_COLLECTION)).toBeNull();
	});

	it.each([
		["not-a-uri"],
		["at://did:plc:abc/only-two-parts"],
		[""],
	])("refuses the malformed URI %p", (bad) => {
		expect(rkeyFromAtUri(bad, WORK_COLLECTION)).toBeNull();
	});
});

describe("what should happen to a listing", () => {
	it("creates one for a released Work that has none", () => {
		const plan = planWorkRecord(openWork(), { baseUrl: BASE });
		expect(plan.action).toBe("create");
	});

	it("replaces the existing record rather than adding a second", () => {
		const plan = planWorkRecord(openWork(), { baseUrl: BASE, existingUri: URI });
		expect(plan).toMatchObject({ action: "replace", rkey: RKEY });
	});

	// 🚨 The whole point of the module. Each of these is a Work that stopped being publicly
	// listed, and each must take its record down with it.
	it.each([
		["withdrawn", { visibility: "withdrawn" }],
		["returned to private", { visibility: "private" }],
		["taken down", { takedownStatus: "taken_down" }],
		["quarantined", { quarantineStatus: "quarantined" }],
	])("deletes the record when a Work is %s", (_label, overrides) => {
		const work = openWork(overrides as Partial<PublishableWork>);
		const plan = planWorkRecord(work, { baseUrl: BASE, existingUri: URI });
		expect(plan).toMatchObject({ action: "delete", rkey: RKEY });
	});

	it("does nothing for an unpublishable Work that never had a record", () => {
		const work = openWork({ visibility: "private" });
		expect(planWorkRecord(work, { baseUrl: BASE }).action).toBe("none");
	});

	it("refuses rather than duplicating when the stored URI cannot be read", () => {
		// Treating an unreadable URI as "no record" would mint a second public listing and
		// orphan the first, which is much worse than stopping to look at one row.
		const plan = planWorkRecord(openWork(), { baseUrl: BASE, existingUri: "at://garbage" });
		expect(plan.action).toBe("invalid");
	});

	it("refuses a record that fails its own Lexicon", () => {
		// `url` is a `uri`-format field, so a Work whose base URL is not one produces a record
		// the schema rejects. Catching it here is the last moment it is free.
		const plan = planWorkRecord(openWork(), { baseUrl: "not a url" });
		expect(plan.action).toBe("invalid");
	});
});

describe("carrying the plan out against a repository", () => {
	it("sends exactly the record the mapper produced, and returns its address", async () => {
		const writer = fakeWriter();
		const out = await syncWorkRecord(writer, openWork(), { baseUrl: BASE });

		expect(writer.calls).toEqual([`create ${WORK_COLLECTION}`]);
		expect(out.uri).toBe(URI);
		// Asserted whole rather than field by field: anything the writer adds or drops on the
		// way to the network is a difference between what we validated and what we published.
		expect(writer.records[0]).toEqual({
			$type: "org.anthers.work",
			kind: "video",
			title: "A Short Film",
			url: `${BASE}/works/a-short-film-90210`,
			releasedAt: "2026-07-01T00:00:00.000Z",
			description: "Ten minutes of something.",
			access: { state: "open" },
		});
	});

	it("clears the stored address when it removes a record", async () => {
		const writer = fakeWriter();
		const work = openWork({ visibility: "withdrawn" });
		const out = await syncWorkRecord(writer, work, { baseUrl: BASE, existingUri: URI });

		expect(writer.calls).toEqual([`delete ${WORK_COLLECTION} ${RKEY}`]);
		expect(out.uri).toBeNull();
	});

	it("writes nothing at all when the plan refuses", async () => {
		const writer = fakeWriter();
		const out = await syncWorkRecord(writer, openWork(), {
			baseUrl: BASE,
			existingUri: "at://garbage",
		});

		expect(writer.calls).toEqual([]);
		// The unreadable URI is handed back untouched. Forgetting it here would turn one row
		// somebody has to look at into a record nobody can find.
		expect(out.uri).toBe("at://garbage");
	});

	it("writes nothing for an unpublishable Work with no record", async () => {
		const writer = fakeWriter();
		const out = await syncWorkRecord(writer, openWork({ visibility: "private" }), {
			baseUrl: BASE,
		});
		expect(writer.calls).toEqual([]);
		expect(out.uri).toBeNull();
	});

	it("gates a gated Work in the record it publishes", async () => {
		const writer = fakeWriter();
		const gated = openWork({ seedAccess: [{ threshold: 300, allow: true, price: "0" }] as never });
		await syncWorkRecord(writer, gated, { baseUrl: BASE });
		expect(writer.records[0]).toMatchObject({ access: { state: "gated" } });
	});
});
