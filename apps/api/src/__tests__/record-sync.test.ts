// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The part of syncing a record that every kind shares: plan, open a repository only if the plan
 * writes, carry it out, remember the address.
 *
 * 🚨 **The ordering is what this suite is for.** Opening a hosted writer is a `createSession`
 * against the account's server, which the reference PDS limits to thirty in five minutes and
 * three hundred a day per account. A reader may cast thirty votes a minute, so a sync that opened
 * a session before finding it had nothing to write would spend a busy reader's budget on drafts,
 * kept records and schemas not yet published — and the first sign of it would be their real
 * writes failing. The fake opener counts, so "nothing to write" can be asserted as "no session".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { COMMENT_KIND, POST_KIND } from "../services/atproto-record-plan.js";
import { type RecordRef, RepoAuthError, type RepoWriter } from "../services/atproto-repo.js";
import { setPublishedLexiconsForTesting } from "../services/published-lexicons.js";
import { syncOwnedRecord } from "../services/record-sync.js";
import type { AccountWriterResult } from "../services/repo-writer.js";

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const WORK_URI = `at://${DID}/org.anthers.work/3lbk2vqf7yk2a`;
const COMMENT_URI = `at://${DID}/org.anthers.comment/3lbk4mzq2rc2h`;

const visible = {
	comment: { userId: 7, body: "Worth the time.", moderationStatus: "visible" },
	subjectUri: WORK_URI,
};

/** An opener that records what it was asked for, over a writer that behaves as told. */
function harness(behavior: "ok" | "auth" | "boom" = "ok") {
	const opened: { userId: number; collections: readonly string[] }[] = [];
	const stored: (string | null)[] = [];
	const writer: RepoWriter = {
		did: DID,
		async createRecord(collection: string): Promise<RecordRef> {
			if (behavior === "auth") throw new RepoAuthError("createRecord: Forbidden", DID);
			if (behavior === "boom") throw new Error("createRecord: node went away");
			return { uri: `at://${DID}/${collection}/new`, cid: "bafy" };
		},
		async putRecord(collection: string, rkey: string): Promise<RecordRef> {
			return { uri: `at://${DID}/${collection}/${rkey}`, cid: "bafy" };
		},
		async deleteRecord(): Promise<void> {},
	};
	return {
		opened,
		stored,
		openWriter: async (
			userId: number,
			opts: { collections: readonly string[] },
		): Promise<AccountWriterResult> => {
			opened.push({ userId, collections: opts.collections });
			return { writer };
		},
		storeUri: async (uri: string | null) => {
			stored.push(uri);
		},
	};
}

describe("with every schema published", () => {
	beforeAll(() =>
		setPublishedLexiconsForTesting(["org.anthers.comment", "org.anthers.post", "org.anthers.work"]),
	);
	afterAll(() => setPublishedLexiconsForTesting(undefined));

	it("opens a writer for exactly the collection it writes, and remembers the address", async () => {
		const h = harness();
		const result = await syncOwnedRecord({
			ownerId: 7,
			kind: COMMENT_KIND,
			input: visible,
			existingUri: null,
			...h,
		});
		expect(result).toMatchObject({ status: "synced", uri: `at://${DID}/org.anthers.comment/new` });
		expect(h.opened).toEqual([{ userId: 7, collections: ["org.anthers.comment"] }]);
		expect(h.stored).toEqual([`at://${DID}/org.anthers.comment/new`]);
	});

	// 🚨 The load-bearing one. A hidden comment keeps its record and needs nothing written, so it
	// must cost no session at all.
	it("opens no writer for a record it is keeping", async () => {
		const h = harness();
		const hidden = { ...visible, comment: { ...visible.comment, moderationStatus: "hidden" } };
		const result = await syncOwnedRecord({
			ownerId: 7,
			kind: COMMENT_KIND,
			input: hidden,
			existingUri: COMMENT_URI,
			...h,
		});
		expect(result).toMatchObject({ status: "synced", plan: { action: "keep" }, uri: COMMENT_URI });
		expect(h.opened).toEqual([]);
		// And a kept address is not rewritten, since it did not change.
		expect(h.stored).toEqual([]);
	});

	it("opens no writer for a draft", async () => {
		const h = harness();
		const draft = {
			creatorId: 7,
			slug: "notes",
			publicId: 12,
			isPublished: false,
			publishedAt: null,
		};
		await syncOwnedRecord({ ownerId: 7, kind: POST_KIND, input: draft, existingUri: null, ...h });
		expect(h.opened).toEqual([]);
	});

	// A tombstoned row has nobody to open a repository for, and its record is kept.
	it("handles a row whose owner has gone without reaching for a writer", async () => {
		const h = harness();
		const orphan = { ...visible, comment: { ...visible.comment, userId: null } };
		const result = await syncOwnedRecord({
			ownerId: null,
			kind: COMMENT_KIND,
			input: orphan,
			existingUri: COMMENT_URI,
			...h,
		});
		expect(result).toMatchObject({
			status: "synced",
			plan: { action: "keep", reason: "no_author" },
		});
		expect(h.opened).toEqual([]);
	});

	// 🚨 A refused credential is not retried, because a retry cannot succeed until the owner grants
	// permission again — and the address is not touched, because whatever is out there must still
	// be findable afterwards.
	it("skips rather than fails when the owner's server refuses the credential", async () => {
		const h = harness("auth");
		const result = await syncOwnedRecord({
			ownerId: 7,
			kind: COMMENT_KIND,
			input: visible,
			existingUri: null,
			...h,
		});
		expect(result).toEqual({ status: "skipped", reason: "grant_lost" });
		expect(h.stored).toEqual([]);
	});

	it("fails, and forgets nothing, when the write goes wrong for any other reason", async () => {
		const h = harness("boom");
		const result = await syncOwnedRecord({
			ownerId: 7,
			kind: COMMENT_KIND,
			input: visible,
			existingUri: null,
			...h,
		});
		expect(result).toEqual({ status: "failed", error: "createRecord: node went away" });
		expect(h.stored).toEqual([]);
	});
});

describe("with the real set of published schemas", () => {
	// ⚠️ The case that is true in production today for every reader record: a comment that would
	// otherwise be written, under a schema that is still a draft. It costs no session.
	it("opens no writer while a comment's schema is unpublished", async () => {
		const h = harness();
		const result = await syncOwnedRecord({
			ownerId: 7,
			kind: COMMENT_KIND,
			input: visible,
			existingUri: null,
			...h,
		});
		expect(result).toMatchObject({
			status: "synced",
			plan: { action: "none", reason: "lexicon_unpublished" },
		});
		expect(h.opened).toEqual([]);
	});
});
