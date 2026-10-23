// SPDX-License-Identifier: Apache-2.0
/**
 * The space XRPC calls, without a generated client.
 *
 * The production PDS image tracks `main`, and `main` has no space lexicons; the
 * Spaces work lives on the open `permissioned-data` branch. The app therefore
 * cannot lean on `@atproto/api`'s generated `com.atproto.space.*` types yet, and
 * this module is the narrow raw client that stands in until the protocol ships.
 *
 * ⚠️ **The request and response shapes here are the branch's Lexicons, not an
 * invention.** When the branch changes, these types change with it; the space
 * scenarios in the lab are the regression set that says whether the shapes still
 * match. `atproto-space.test.ts` holds the transport, and the staging smoke run
 * is what holds the transport to a real PDS.
 *
 * ⚠️ **Two authentication paths share these endpoints.** A user's own space is
 * written with their ordinary session token, with the space named in the body or
 * the query. A member's space is read with a space credential and HTTP Message
 * Signatures, which is the gate's path and not this client's. This client takes a
 * `fetch` that may already add OAuth or DPoP, or a bearer token when the caller
 * holds one directly.
 */

/** A fetch that the client may call; the OAuth session's `fetchHandler` fits it. */
export type SpaceFetch = (input: URL, init?: RequestInit) => Promise<Response>;

/** How a space decides who may read it. */
export type SpacePolicy =
	| { $type: "com.atproto.simplespace.defs#publicPolicy" }
	| { $type: "com.atproto.simplespace.defs#memberListPolicy" }
	| {
			$type: "com.atproto.simplespace.defs#managingAppPolicy";
			/** The managing app's DID, optionally with a service fragment. */
			managingApp: string;
	  };

/** How a space decides which apps may access it. */
export type SpaceAppAccess =
	| { $type: "com.atproto.simplespace.defs#open" }
	| { $type: "com.atproto.simplespace.defs#allowList"; allowed: readonly string[] };

/** The input to `com.atproto.simplespace.createSpace`. */
export interface CreateSpaceInput {
	spaceType: string;
	skey?: string;
	readPolicy: SpacePolicy;
	writePolicy: SpacePolicy;
	appAccess: SpaceAppAccess;
}

/** What `getSpace` returns: the space's URI and the three policies. */
export interface SpaceDescription {
	uri: string;
	readPolicy: SpacePolicy;
	writePolicy: SpacePolicy;
	appAccess: SpaceAppAccess;
}

/** One space in `listSpaces`; the Lexicon currently promises only its URI. */
export interface SpaceView {
	uri: string;
	[extra: string]: unknown;
}

/** One member in `listMembers`. */
export interface SpaceMember {
	did: string;
	read: boolean;
	write: boolean;
	[extra: string]: unknown;
}

/** A commit in a space's permissioned repo. */
export interface SpaceCommit {
	ver: number;
	repo: string;
	space: string;
	rev: string;
	/**
	 * The 32-byte LtHash digest of the record set, base64.
	 *
	 * ⚠️ **The wire form is `{ "$bytes": "…" }`, not a bare string**, because the Lexicon's
	 * `bytes` format rides the JSON-bytes wrapper. A caller that compares this field directly
	 * across two reads is comparing two objects and will always answer no; use
	 * {@link commitDigest}.
	 */
	data: string | { $bytes: string };
	[extra: string]: unknown;
}

/** The digest's base64 string, whichever JSON form the server answered with. */
export function commitDigest(commit: Pick<SpaceCommit, "data">): string {
	return typeof commit.data === "string" ? commit.data : commit.data.$bytes;
}

/** One operation in a space repo's oplog. `cid` is null for a delete; `prev` is null for a create. */
export interface SpaceRepoOp {
	collection: string;
	rkey: string;
	cid: string | null;
	rev?: string;
	prev?: string | null;
	value?: unknown;
	[extra: string]: unknown;
}

/** One record in a space. `value` is absent when the caller asked for metadata only. */
export interface SpaceRecord {
	/**
	 * The record's address. Present from `getRecord`; **`listRecords` answers with
	 * `collection` and `rkey` instead and omits the URI**, per the branch's Lexicon.
	 */
	uri?: string;
	collection?: string;
	rkey?: string;
	cid: string;
	value?: unknown;
	[extra: string]: unknown;
}

/** Bytes from `getRepo` or `getBlob`, with the response's content type. */
export interface SpaceBytes {
	bytes: Uint8Array;
	contentType: string | null;
}

/** The fields a write needs; `createRecord` may generate the record key. */
export interface SpaceRecordWrite {
	space: string;
	repo: string;
	collection: string;
	record: Record<string, unknown>;
	rkey?: string;
	validate?: boolean;
}

/** `putRecord` needs the key it is replacing or creating at. */
export interface SpaceRecordPut extends SpaceRecordWrite {
	rkey: string;
}

/** `getRecord` and the read-back identify a record by all four coordinates. */
export interface SpaceRecordKey {
	space: string;
	repo: string;
	collection: string;
	rkey: string;
}

/** The answer to a create or put. */
export interface SpaceWriteResult {
	uri: string;
	cid: string;
	validationStatus?: "valid" | "unknown";
}

/** What went wrong at the XRPC layer, with the server's error name when it gave one. */
export class SpaceRequestError extends Error {
	constructor(
		readonly method: string,
		readonly status: number,
		readonly error: string | undefined,
		message: string | undefined,
	) {
		super(
			`${method} failed with ${status}${error ? ` ${error}` : ""}${message ? `: ${message}` : ""}`,
		);
		this.name = "SpaceRequestError";
	}
}

export interface SpaceClientOptions {
	/** The PDS origin, such as `https://pds.example.com`. */
	baseUrl: string;
	/** The transport. Defaults to the process's `fetch`. */
	fetch?: SpaceFetch;
	/** A bearer token, when the caller holds one directly. Omit when `fetch` adds auth. */
	token?: string;
}

interface RequestOptions {
	params?: object;
	body?: unknown;
	bytes?: boolean;
}

/** A blob reference, as `com.atproto.repo.uploadBlob` answers it. */
export interface SpaceBlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

/** `putMember`'s body. */
export interface SpaceMemberGrant {
	did: string;
	read: boolean;
	write: boolean;
}

/**
 * The space endpoints a user's own space needs.
 *
 * The client is deliberately stateless: the caller decides which account it is
 * acting as, and passes the token or the authenticating fetch that says so. That
 * keeps the space path usable from a request handler, a worker, and a one-off
 * staging smoke without a second session store.
 */
export class SpaceClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: SpaceFetch;
	private readonly token: string | undefined;

	constructor(options: SpaceClientOptions) {
		this.baseUrl = options.baseUrl;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.token = options.token;
	}

	/** Create the space, owned by the authenticated account. */
	async createSpace(input: CreateSpaceInput): Promise<{ uri: string }> {
		return this.request("com.atproto.simplespace.createSpace", { body: input });
	}

	/** Read a space's URI and policies. */
	async getSpace(space: string): Promise<SpaceDescription> {
		return this.request("com.atproto.simplespace.getSpace", { params: { space } });
	}

	/** Remove a space and everything in it. The restore drill's delete half. */
	async deleteSpace(space: string): Promise<Record<string, never>> {
		return this.request("com.atproto.simplespace.deleteSpace", { body: { space } });
	}

	/** Add or update one member's read and write flags. */
	async putMember(space: string, member: SpaceMemberGrant): Promise<Record<string, never>> {
		return this.request("com.atproto.simplespace.putMember", {
			body: { space, ...member },
		});
	}

	/**
	 * Upload bytes through the normal repository, which is the only upload route a space has.
	 *
	 * ⚠️ **The space namespace has no upload.** The bytes go to the account's ordinary blob
	 * store and a space record references the CID; `space.listBlobs` then enumerates it. This
	 * is why a space backup's blob half is an upload plus a record replay rather than a STAR
	 * import, and why a restoring app needs a `blob:` permission alongside its `space:` one.
	 */
	async uploadBlob(bytes: Uint8Array, contentType: string): Promise<SpaceBlobRef> {
		const url = new URL("/xrpc/com.atproto.repo.uploadBlob", this.baseUrl);
		const headers: Record<string, string> = {};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		// A fresh view over a plain ArrayBuffer: the bytes may arrive as a view on a shared or
		// over-sized buffer, which `Blob` and `BodyInit` refuse.
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		const response = await this.fetchImpl(url, {
			method: "POST",
			headers,
			body: new Blob([copy], { type: contentType }),
		});
		if (!response.ok) {
			throw await this.errorFor("com.atproto.repo.uploadBlob", response);
		}
		// The endpoint answers `{ blob: BlobRef }`; the reference is what a record embeds.
		const body = (await response.json()) as { blob: SpaceBlobRef };
		return body.blob;
	}

	/** List spaces under an owner or a type, with the protocol's paging. */
	async listSpaces(
		params: { spaceType?: string; did?: string; limit?: number; cursor?: string } = {},
	): Promise<{ spaces: SpaceView[]; cursor?: string }> {
		return this.request("com.atproto.space.listSpaces", { params });
	}

	/** List a space's members, the registry's second source beside `listSpaces`. */
	async listMembers(
		space: string,
		params: { limit?: number; cursor?: string } = {},
	): Promise<{ members: SpaceMember[]; cursor?: string }> {
		return this.request("com.atproto.simplespace.listMembers", {
			params: { space, ...params },
		});
	}

	/** Create a record at a generated or supplied key. */
	async createRecord(input: SpaceRecordWrite): Promise<SpaceWriteResult> {
		return this.request("com.atproto.space.createRecord", { body: input });
	}

	/** Write a record at a known key, which is what an idempotent outbox needs. */
	async putRecord(input: SpaceRecordPut): Promise<SpaceWriteResult> {
		return this.request("com.atproto.space.putRecord", { body: input });
	}

	/** Remove a record. */
	async deleteRecord(input: SpaceRecordKey): Promise<Record<string, never>> {
		return this.request("com.atproto.space.deleteRecord", { body: input });
	}

	/** Read one record, the read-back half of the outbox. */
	async getRecord(input: SpaceRecordKey): Promise<SpaceRecord & { value: unknown }> {
		return this.request("com.atproto.space.getRecord", { params: input });
	}

	/** List records in a space repo, optionally one collection. */
	async listRecords(params: {
		space: string;
		repo: string;
		collection?: string;
		limit?: number;
		cursor?: string;
		reverse?: boolean;
		excludeValues?: boolean;
	}): Promise<{ records: SpaceRecord[]; cursor?: string }> {
		return this.request("com.atproto.space.listRecords", { params });
	}

	/** The repo's latest commit, which the read-back compares against. */
	async getLatestCommit(input: { space: string; repo: string }): Promise<{ commit: SpaceCommit }> {
		return this.request("com.atproto.space.getLatestCommit", { params: input });
	}

	/** The repo's oplog, which is the second half of the read-back's agreement. */
	async listRepoOps(params: {
		space: string;
		repo: string;
		since?: string;
		limit?: number;
		cursor?: string;
		excludeValues?: boolean;
	}): Promise<{ ops: SpaceRepoOp[]; commit?: SpaceCommit; cursor?: string }> {
		return this.request("com.atproto.space.listRepoOps", { params });
	}

	/**
	 * The account's public repository as a CAR, which is the export's public half.
	 *
	 * ⚠️ **This is `sync.getRepo`, not a space call.** It lives here because it shares this
	 * client's base URL and credential, and because an export that read the public repository
	 * with a second client would be one more place for the two to disagree about the server.
	 */
	async getPublicRepo(did: string): Promise<SpaceBytes> {
		return this.request("com.atproto.sync.getRepo", { params: { did }, bytes: true });
	}

	/** Download the space repo as a CAR. */
	async getRepo(input: { space: string; repo: string }): Promise<SpaceBytes> {
		return this.request("com.atproto.space.getRepo", { params: input, bytes: true });
	}

	/** List the CIDs of the blobs referenced by a space repo. */
	async listBlobs(params: {
		space: string;
		repo: string;
		since?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{ cids: string[]; cursor?: string }> {
		return this.request("com.atproto.space.listBlobs", { params });
	}

	/** Download one blob from a space repo. */
	async getBlob(input: { space: string; repo: string; cid: string }): Promise<SpaceBytes> {
		return this.request("com.atproto.space.getBlob", { params: input, bytes: true });
	}

	private async request<T>(method: string, options: RequestOptions = {}): Promise<T> {
		const url = new URL(`/xrpc/${method}`, this.baseUrl);
		for (const [key, value] of Object.entries(options.params ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}

		const headers: Record<string, string> = {};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		if (options.body !== undefined) headers["Content-Type"] = "application/json";

		const response = await this.fetchImpl(url, {
			method: options.body === undefined ? "GET" : "POST",
			headers,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});

		if (!response.ok) {
			throw await this.errorFor(method, response);
		}

		if (options.bytes) {
			return {
				bytes: new Uint8Array(await response.arrayBuffer()),
				contentType: response.headers.get("content-type"),
			} as T;
		}

		const text = await response.text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	/**
	 * Turn a non-OK response into the error the callers branch on.
	 *
	 * The server's own error name is what the outbox and the registry match on (`RepoNotFound`,
	 * `SpaceAlreadyExists`, `RecordNotFound`), so it is read off the body wherever the body is
	 * JSON. A non-JSON error still has a status, which is the useful part.
	 */
	private async errorFor(method: string, response: Response): Promise<SpaceRequestError> {
		let detail: { error?: string; message?: string } = {};
		try {
			detail = (await response.json()) as typeof detail;
		} catch {
			// Nothing to add; the status is the fact.
		}
		return new SpaceRequestError(method, response.status, detail.error, detail.message);
	}
}
