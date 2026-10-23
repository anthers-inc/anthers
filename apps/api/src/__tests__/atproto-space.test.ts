// SPDX-License-Identifier: Apache-2.0
/**
 * The space client's transport, held to the branch's request and response shapes.
 *
 * The client has no generated types to lean on, so these tests are the only thing
 * that says the method names, the space parameter and the binary reads are the
 * ones the protocol actually defines. The real-PDS smoke run is the other half;
 * this half runs on every change.
 */
import { describe, expect, it } from "bun:test";
import { SpaceClient, type SpaceFetch, SpaceRequestError } from "../services/atproto-space.js";

const SPACE = "at://did:plc:abc123xyz/space/org.anthers.userSpace/self";
const DID = "did:plc:abc123xyz";
const BASE = "https://pds.example.com";

interface Call {
	url: URL;
	init: RequestInit | undefined;
}

function fakeFetch(
	handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: Call[]; fetch: SpaceFetch } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		},
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("SpaceClient", () => {
	it("creates a space with the session token and the Lexicon body", async () => {
		const { calls, fetch } = fakeFetch(() => json({ uri: SPACE }));
		const client = new SpaceClient({ baseUrl: BASE, fetch, token: "access-jwt" });

		const input = {
			spaceType: "org.anthers.userSpace",
			skey: "self",
			readPolicy: {
				$type: "com.atproto.simplespace.defs#memberListPolicy",
			} as const,
			writePolicy: {
				$type: "com.atproto.simplespace.defs#memberListPolicy",
			} as const,
			appAccess: { $type: "com.atproto.simplespace.defs#open" } as const,
		};

		await expect(client.createSpace(input)).resolves.toEqual({ uri: SPACE });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.pathname).toBe("/xrpc/com.atproto.simplespace.createSpace");
		expect(calls[0]?.init?.method).toBe("POST");
		expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer access-jwt",
		);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
	});

	it("writes at a known key and reads the record back at the same coordinates", async () => {
		const record = {
			$type: "org.anthers.libraryItem",
			work: "at://did:plc:example/org.anthers.work/nightjar",
			createdAt: "2026-10-22T00:00:00.000Z",
		};
		const { calls, fetch } = fakeFetch((url) => {
			if (url.pathname.endsWith("putRecord")) {
				return json({ uri: `${SPACE}/org.anthers.libraryItem/one`, cid: "bafyone" });
			}
			return json({
				uri: `${SPACE}/org.anthers.libraryItem/one`,
				cid: "bafyone",
				value: record,
			});
		});
		const client = new SpaceClient({ baseUrl: BASE, fetch, token: "access-jwt" });

		const written = await client.putRecord({
			space: SPACE,
			repo: DID,
			collection: "org.anthers.libraryItem",
			rkey: "one",
			record,
		});
		expect(written).toEqual({ uri: `${SPACE}/org.anthers.libraryItem/one`, cid: "bafyone" });

		const read = await client.getRecord({
			space: SPACE,
			repo: DID,
			collection: "org.anthers.libraryItem",
			rkey: "one",
		});
		expect(read.value).toEqual(record);
		expect(calls[1]?.url.searchParams.get("space")).toBe(SPACE);
		expect(calls[1]?.url.searchParams.get("repo")).toBe(DID);
		expect(calls[1]?.url.searchParams.get("collection")).toBe("org.anthers.libraryItem");
		expect(calls[1]?.url.searchParams.get("rkey")).toBe("one");
	});

	it("reads the commit and the oplog the read-back compares", async () => {
		const commit = {
			ver: 1,
			repo: DID,
			space: SPACE,
			rev: "3jui7kd54zh2y",
			data: "AAAA",
		};
		const { calls, fetch } = fakeFetch((url) => {
			if (url.pathname.endsWith("getLatestCommit")) return json({ commit });
			return json({
				ops: [
					{
						collection: "org.anthers.libraryItem",
						rkey: "one",
						cid: "bafyone",
						rev: commit.rev,
					},
				],
				commit,
			});
		});
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await expect(client.getLatestCommit({ space: SPACE, repo: DID })).resolves.toEqual({
			commit,
		});
		const ops = await client.listRepoOps({ space: SPACE, repo: DID, limit: 10 });
		expect(ops.ops[0]?.cid).toBe("bafyone");
		expect(calls[1]?.url.searchParams.get("limit")).toBe("10");
	});

	it("lists spaces and members with the registry's filters", async () => {
		const { calls, fetch } = fakeFetch((url) => {
			if (url.pathname.endsWith("listSpaces")) {
				return json({ spaces: [{ uri: SPACE }] });
			}
			return json({ members: [{ did: DID, read: true, write: true }] });
		});
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await expect(client.listSpaces({ did: DID, limit: 50 })).resolves.toEqual({
			spaces: [{ uri: SPACE }],
		});
		await expect(client.listMembers(SPACE, { limit: 100 })).resolves.toEqual({
			members: [{ did: DID, read: true, write: true }],
		});
		expect(calls[0]?.url.pathname).toBe("/xrpc/com.atproto.space.listSpaces");
		expect(calls[0]?.url.searchParams.get("did")).toBe(DID);
		expect(calls[1]?.url.pathname).toBe("/xrpc/com.atproto.simplespace.listMembers");
		expect(calls[1]?.url.searchParams.get("space")).toBe(SPACE);
	});

	it("lists records and blob CIDs for the projection and the backup", async () => {
		const { calls, fetch } = fakeFetch((url) => {
			if (url.pathname.endsWith("listRecords")) {
				return json({
					records: [{ uri: `${SPACE}/org.anthers.libraryItem/one`, cid: "bafyone" }],
				});
			}
			return json({ cids: ["bafyblob"] });
		});
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await expect(
			client.listRecords({ space: SPACE, repo: DID, collection: "org.anthers.libraryItem" }),
		).resolves.toEqual({
			records: [{ uri: `${SPACE}/org.anthers.libraryItem/one`, cid: "bafyone" }],
		});
		await expect(client.listBlobs({ space: SPACE, repo: DID })).resolves.toEqual({
			cids: ["bafyblob"],
		});
		expect(calls[0]?.url.searchParams.get("collection")).toBe("org.anthers.libraryItem");
	});

	it("returns repo and blob bytes with their content type", async () => {
		const { fetch } = fakeFetch(
			() =>
				new Response(new Uint8Array([1, 2, 3]), {
					headers: { "content-type": "image/png" },
				}),
		);
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		const repo = await client.getRepo({ space: SPACE, repo: DID });
		expect([...repo.bytes]).toEqual([1, 2, 3]);
		expect(repo.contentType).toBe("image/png");

		const blob = await client.getBlob({ space: SPACE, repo: DID, cid: "bafyblob" });
		expect([...blob.bytes]).toEqual([1, 2, 3]);
	});

	it("surfaces the server's error name and status", async () => {
		const { fetch } = fakeFetch(() =>
			json({ error: "SpaceNotFound", message: "no such space" }, 400),
		);
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await expect(client.getSpace(SPACE)).rejects.toBeInstanceOf(SpaceRequestError);
		try {
			await client.getSpace(SPACE);
		} catch (error) {
			expect(error).toBeInstanceOf(SpaceRequestError);
			const spaceError = error as SpaceRequestError;
			expect(spaceError.method).toBe("com.atproto.simplespace.getSpace");
			expect(spaceError.status).toBe(400);
			expect(spaceError.error).toBe("SpaceNotFound");
			expect(spaceError.message).toContain("no such space");
		}
	});

	it("sets no Authorization header when the fetch already authenticates", async () => {
		const { calls, fetch } = fakeFetch(() => json({ uri: SPACE }));
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await client.getSpace(SPACE);
		expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	it("omits undefined query parameters rather than sending the word", async () => {
		const { calls, fetch } = fakeFetch(() => json({ spaces: [] }));
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await client.listSpaces({ did: undefined, limit: 5 });
		expect(calls[0]?.url.searchParams.has("did")).toBe(false);
		expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
	});

	it("deletes a record by its four coordinates", async () => {
		const { calls, fetch } = fakeFetch(() => json({}));
		const client = new SpaceClient({ baseUrl: BASE, fetch });

		await expect(
			client.deleteRecord({
				space: SPACE,
				repo: DID,
				collection: "org.anthers.libraryItem",
				rkey: "one",
			}),
		).resolves.toEqual({});
		expect(calls[0]?.url.pathname).toBe("/xrpc/com.atproto.space.deleteRecord");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			space: SPACE,
			repo: DID,
			collection: "org.anthers.libraryItem",
			rkey: "one",
		});
	});
});
