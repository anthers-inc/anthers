// SPDX-License-Identifier: Apache-2.0
/**
 * A PDS in memory, for driving the space outbox without a server.
 *
 * The real round trip is held by `scripts/atproto-space-smoke.ts` (a transport smoke against
 * the branch's PDS) and by `space-staging.test.ts` when a staging PDS is pointed at. This
 * fake exists for the failures a real server will not produce on demand: a read-back that
 * answers the wrong CID, and a process that dies after the write landed and before the
 * verification finished. Those are the two paths the outbox exists for, and neither can be
 * scheduled against a healthy PDS.
 *
 * ⚠️ **It speaks the branch's shapes and nothing else.** The space record URI nests under
 * the space (`at://spaceDid/space/type/skey/authorDid/collection/rkey`), the oplog's `cid` is
 * null for a delete, and `createSpace` refuses a second space at the same address. A change
 * to those shapes should break this file, which is the point of writing them down here.
 */

interface FakeSpace {
	uri: string;
	ownerDid: string;
	spaceType: string;
	skey: string;
	readPolicy: unknown;
	writePolicy: unknown;
	appAccess: unknown;
}

interface FakeRecord {
	uri: string;
	cid: string;
	value: unknown;
	rev: string;
}

interface FakeOp {
	collection: string;
	rkey: string;
	cid: string | null;
	rev: string;
	value?: unknown;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fail(error: string, status = 400): Response {
	return json({ error, message: error }, status);
}

export class FakeSpacePds {
	readonly spaces = new Map<string, FakeSpace>();
	/** space URI → `collection/rkey` → record. */
	readonly records = new Map<string, Map<string, FakeRecord>>();
	/** space URI → operations, oldest first. */
	readonly ops = new Map<string, FakeOp[]>();

	/** Make the next N `getRecord` answers report a CID the write did not produce. */
	corruptReads = 0;
	/** Store the next N writes and then throw, as a worker killed mid-verification would. */
	throwAfterWrite = 0;

	private clock = 0;
	private cids = 0;

	readonly fetch = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input.toString());
		const method = url.pathname.replace(/^\/xrpc\//, "");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		return this.handle(method, url, body);
	}) as typeof fetch;

	/** Every record the fake holds for a space and collection, for assertions. */
	recordsIn(spaceUri: string, collection: string): FakeRecord[] {
		const store = this.records.get(spaceUri);
		if (!store) return [];
		return [...store.entries()]
			.filter(([key]) => key.startsWith(`${collection}/`))
			.map(([, record]) => record);
	}

	private nextRev(): string {
		this.clock += 1;
		return String(this.clock).padStart(12, "0");
	}

	private nextCid(): string {
		this.cids += 1;
		return `bafyfake${this.cids}`;
	}

	private store(spaceUri: string): Map<string, FakeRecord> {
		let store = this.records.get(spaceUri);
		if (!store) {
			store = new Map();
			this.records.set(spaceUri, store);
		}
		return store;
	}

	private opLog(spaceUri: string): FakeOp[] {
		let log = this.ops.get(spaceUri);
		if (!log) {
			log = [];
			this.ops.set(spaceUri, log);
		}
		return log;
	}

	private handle(method: string, url: URL, body: Record<string, unknown>): Response {
		const param = (key: string) => url.searchParams.get(key) ?? undefined;

		switch (method) {
			case "com.atproto.simplespace.createSpace": {
				const spaceType = String(body.spaceType);
				const skey = String(body.skey ?? "self");
				// The caller's DID is implied by the token on the real server; the fake takes it
				// from the session a test installed, because that is the only identity it has.
				const owner = this.sessionDid;
				const uri = `at://${owner}/space/${spaceType}/${skey}`;
				if (this.spaces.has(uri)) return fail("SpaceAlreadyExists");
				this.spaces.set(uri, {
					uri,
					ownerDid: owner,
					spaceType,
					skey,
					readPolicy: body.readPolicy,
					writePolicy: body.writePolicy,
					appAccess: body.appAccess,
				});
				return json({ uri });
			}

			case "com.atproto.simplespace.getSpace": {
				const space = this.spaces.get(param("space") ?? "");
				if (!space) return fail("SpaceNotFound");
				return json({
					uri: space.uri,
					readPolicy: space.readPolicy,
					writePolicy: space.writePolicy,
					appAccess: space.appAccess,
				});
			}

			case "com.atproto.space.listSpaces": {
				const did = param("did");
				const spaceType = param("spaceType");
				const spaces = [...this.spaces.values()]
					.filter((space) => !did || space.ownerDid === did)
					.filter((space) => !spaceType || space.spaceType === spaceType)
					.map((space) => ({ uri: space.uri }));
				return json({ spaces });
			}

			case "com.atproto.simplespace.listMembers":
				return json({ members: [] });

			case "com.atproto.space.putRecord": {
				const space = this.spaces.get(String(body.space));
				if (!space) return fail("SpaceNotFound");
				const collection = String(body.collection);
				const rkey = String(body.rkey);
				const record = body.record as Record<string, unknown>;
				const cid = this.nextCid();
				const rev = this.nextRev();
				const uri = `${space.uri}/${this.sessionDid}/${collection}/${rkey}`;
				this.store(space.uri).set(`${collection}/${rkey}`, { uri, cid, value: record, rev });
				this.opLog(space.uri).push({ collection, rkey, cid, rev, value: record });
				if (this.throwAfterWrite > 0) {
					this.throwAfterWrite -= 1;
					throw new Error("simulated kill after the write landed");
				}
				return json({ uri, cid });
			}

			case "com.atproto.space.deleteRecord": {
				const space = this.spaces.get(String(body.space));
				if (!space) return fail("SpaceNotFound");
				const collection = String(body.collection);
				const rkey = String(body.rkey);
				const existing = this.store(space.uri).get(`${collection}/${rkey}`);
				if (!existing) return fail("RecordNotFound");
				this.store(space.uri).delete(`${collection}/${rkey}`);
				this.opLog(space.uri).push({ collection, rkey, cid: null, rev: this.nextRev() });
				return json({});
			}

			case "com.atproto.space.getRecord": {
				const space = this.spaces.get(param("space") ?? "");
				if (!space) return fail("SpaceNotFound");
				const key = `${param("collection")}/${param("rkey")}`;
				const record = this.store(space.uri).get(key);
				if (!record) return fail("RecordNotFound");
				const cid = this.corruptReads > 0 ? this.nextCid() : record.cid;
				if (this.corruptReads > 0) this.corruptReads -= 1;
				return json({ uri: record.uri, cid, value: record.value });
			}

			case "com.atproto.space.listRecords": {
				const space = this.spaces.get(param("space") ?? "");
				if (!space) return fail("SpaceNotFound");
				const collection = param("collection");
				const records = [...this.store(space.uri).entries()]
					.filter(([key]) => !collection || key.startsWith(`${collection}/`))
					.map(([key, record]) => ({
						collection: key.split("/")[0],
						rkey: key.split("/")[1],
						cid: record.cid,
						value: record.value,
					}));
				return json({ records });
			}

			case "com.atproto.space.getLatestCommit": {
				const space = this.spaces.get(param("space") ?? "");
				if (!space) return fail("SpaceNotFound");
				// A space has no repo until something is written into it. The real branch answers
				// RepoNotFound here, and the outbox must treat that as "no previous commit".
				if (!this.records.get(space.uri)?.size && !this.ops.get(space.uri)?.length) {
					return fail("RepoNotFound");
				}
				return json({
					commit: {
						ver: 3,
						repo: this.sessionDid,
						space: space.uri,
						rev: String(this.clock).padStart(12, "0"),
						data: "ZmFrZQ==",
					},
				});
			}

			case "com.atproto.space.listRepoOps": {
				const space = this.spaces.get(param("space") ?? "");
				if (!space) return fail("SpaceNotFound");
				const since = param("since");
				const ops = this.opLog(space.uri).filter((op) => !since || op.rev > since);
				return json({ ops });
			}

			default:
				return fail(`unknown method ${method}`, 404);
		}
	}

	/** The DID the fake treats as the authenticated caller. Set by a test's session. */
	sessionDid = "did:plc:fake";
}
