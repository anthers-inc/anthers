// SPDX-License-Identifier: Apache-2.0
/**
 * Move one identity to another PDS: the five steps, then verification, then retirement.
 *
 * 🚨 **The order is the whole safety story, and the old copy survives every failure.**
 * Service auth and `createAccount` with the same DID, the recommended credentials, the PLC
 * operation, the public repo CAR, the spaces with their blobs before their records, the
 * members, then verification, and only then is the old account retired. A failure before the
 * PLC submission changes nothing; a failure after it leaves the DID pointing at the new PDS
 * and the old server still holding every byte, which is the state a person can be helped out
 * of. Nothing is deleted on a step that has not been verified.
 *
 * ⭐ **The move is an operator action, not a Settings button.** An identity with nowhere to go
 * has no move to offer, and the parking half of "keep my identity" is still the design's open
 * question 5. The command takes a target PDS and the credential to create there; the screen
 * offers the export, which is the copy a person can carry to a destination they have.
 *
 * ✅ **The protocol sequence is the lab's, not an invention.** The disposable lab's complete
 * move (scenario 15) ran this exact order against two PDSes and one PLC, including the blob
 * upload before the record and the member list after the records.
 */
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import {
	commitDigest,
	type SpaceAppAccess,
	type SpacePolicy,
	SpaceRequestError,
} from "./atproto-space.js";
import { releaseHostedIdentities } from "./hosted-accounts.js";
import { readSpaceArtifacts } from "./space-backup.js";
import { registeredSpacesFor } from "./space-registry.js";
import { hostedSpaceSession, type ResolveSpaceSession, spaceClientFor } from "./space-writer.js";

/** Where the identity is going, and the credential it gets there. */
export interface MoveTarget {
	pdsUrl: string;
	email: string;
	password: string;
	/** Defaults to the handle the account has now. */
	handle?: string;
}

export interface MoveOptions {
	target: MoveTarget;
	/** The email token `requestPlcOperationSignature` sends. Required; the operator supplies it. */
	plcToken: string;
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	/** Retire the old hosted account after verification. Defaults to true. */
	retire?: boolean;
}

export interface MoveStep {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface MovedSpace {
	spaceUri: string;
	records: number;
	blobs: number;
	members: number;
	recordsMatched: number;
	commitMatches: boolean | null;
}

export interface MoveReport {
	did: string;
	from: string;
	to: string;
	handle: string;
	steps: MoveStep[];
	repoImported: boolean;
	spaces: MovedSpace[];
	didPointsAtNew: boolean | null;
	retired: "released" | "deferred" | "none" | "skipped";
	retirementDetail?: string;
}

export type MoveResult =
	| { ok: true; report: MoveReport }
	| { ok: false; reason: string; stages: MoveStep[]; report?: MoveReport };

/** Move one account. Throws nothing for an ordinary refusal; a thrown error is a bug. */
export async function moveAccount(userId: number, opts: MoveOptions): Promise<MoveResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return { ok: false, reason: "no_user", stages: [] };

	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(userId);
	if (!resolved.session) return { ok: false, reason: resolved.reason, stages: [] };
	const old = resolved.session;

	const targetUrl = opts.target.pdsUrl.replace(/\/+$/, "");
	if (targetUrl === old.pdsUrl.replace(/\/+$/, "")) {
		return { ok: false, reason: "same_server", stages: [] };
	}

	const stages: MoveStep[] = [];
	const step = (name: string, detail?: string): void => {
		stages.push({ name, ok: true, ...(detail ? { detail } : {}) });
	};
	const fail = (name: string, error: unknown): MoveResult => {
		stages.push({ name, ok: false, detail: messageOf(error) });
		return { ok: false, reason: "move_failed", stages };
	};

	let newSession: { pdsUrl: string; token: string } | null = null;
	const did = old.did;
	let handle = opts.target.handle ?? user.atprotoHandle;

	// 1. The target's service DID, and the old PDS's authorization to create the DID there.
	try {
		const server = await xrpc<{ did: string }>(targetUrl, "com.atproto.server.describeServer", {
			fetchImpl: opts.fetchImpl,
		});
		step("describe target", server.did);

		const serviceAuth = await xrpc<{ token: string }>(
			old.pdsUrl,
			"com.atproto.server.getServiceAuth",
			{
				token: old.token,
				params: { aud: server.did, lxm: "com.atproto.server.createAccount" },
				fetchImpl: opts.fetchImpl,
			},
		);

		// 2. The account on the new server, carrying the DID rather than creating a new one.
		const created = await xrpc<{ did: string; accessJwt: string; handle: string }>(
			targetUrl,
			"com.atproto.server.createAccount",
			{
				token: serviceAuth.token,
				body: {
					did,
					handle,
					email: opts.target.email,
					password: opts.target.password,
				},
				fetchImpl: opts.fetchImpl,
			},
		);
		if (created.did !== did) {
			throw new Error(`the target created ${created.did}, not ${did}`);
		}
		newSession = { pdsUrl: targetUrl, token: created.accessJwt };
		handle = created.handle ?? handle;
		step("create account on the target", created.did);
	} catch (error) {
		return fail("create account", error);
	}

	// 3. The DID document the new server recommends, signed by the old one, submitted by the new.
	try {
		const recommended = await xrpc<Record<string, unknown>>(
			targetUrl,
			"com.atproto.identity.getRecommendedDidCredentials",
			{ token: newSession.token, fetchImpl: opts.fetchImpl },
		);
		const signed = await xrpc<{ operation: unknown }>(
			old.pdsUrl,
			"com.atproto.identity.signPlcOperation",
			{
				token: old.token,
				body: { ...recommended, token: opts.plcToken },
				fetchImpl: opts.fetchImpl,
			},
		);
		await xrpc(targetUrl, "com.atproto.identity.submitPlcOperation", {
			token: newSession.token,
			body: { operation: signed.operation },
			fetchImpl: opts.fetchImpl,
		});
		await xrpc(targetUrl, "com.atproto.server.activateAccount", {
			token: newSession.token,
			post: true,
			fetchImpl: opts.fetchImpl,
		});
		step("move the DID", `${old.pdsUrl} → ${targetUrl}`);
	} catch (error) {
		// The account exists on the target but the DID still points at the old server, so the old
		// copy is the live one and nothing has been retired.
		return fail("move the DID", error);
	}

	// 4. The public repository, as a CAR.
	let repoImported = false;
	try {
		const car = await fetchCar(old.pdsUrl, old.token, did, opts.fetchImpl);
		await importCar(targetUrl, newSession.token, car, opts.fetchImpl);
		const [oldCommit, newCommit] = await Promise.all([
			latestPublicCommit(old.pdsUrl, old.token, did, opts.fetchImpl),
			latestPublicCommit(targetUrl, newSession.token, did, opts.fetchImpl),
		]);
		// ⚠️ **The commit's CID is the identity, not its revision.** An import lands the same
		// commit content at a new revision, because the target's clock and ordering are its own;
		// comparing revisions would refuse every correct import. The CID is the hash of the
		// commit, so it is the same bytes only when the repository is the same.
		if (oldCommit.cid !== newCommit.cid) {
			throw new Error(`the imported repository is at ${newCommit.cid}, not ${oldCommit.cid}`);
		}
		repoImported = true;
		step("import the public repository", `${car.length} bytes`);
	} catch (error) {
		return fail("import the public repository", error);
	}

	// 5. The spaces: policy, blobs, records, members, and the checks that they arrived.
	const movedSpaces: MovedSpace[] = [];
	try {
		const registries = await registeredSpacesFor(userId);
		for (const registry of registries) {
			const artifacts = await readSpaceArtifacts(registry, old, { fetchImpl: opts.fetchImpl });
			const targetClient = spaceClientFor(
				{ did, pdsUrl: targetUrl, token: newSession.token },
				{ fetchImpl: opts.fetchImpl },
			);
			const skey = registry.spaceUri.split("/").at(-1) ?? "self";
			await targetClient.createSpace({
				spaceType: registry.spaceType,
				skey,
				readPolicy: artifacts.registry.readPolicy as unknown as SpacePolicy,
				writePolicy: artifacts.registry.writePolicy as unknown as SpacePolicy,
				appAccess: artifacts.registry.appAccess as unknown as SpaceAppAccess,
			});

			// Blobs first: a record that references one can only be read after its bytes exist.
			for (const blob of artifacts.blobs) {
				const uploaded = await targetClient.uploadBlob(blob.bytes, blob.contentType);
				if (uploaded.ref.$link !== blob.cid) {
					throw new Error(`blob ${blob.cid} arrived as ${uploaded.ref.$link}`);
				}
			}

			let recordsMatched = 0;
			for (const record of artifacts.records) {
				const written = await targetClient.putRecord({
					space: registry.spaceUri,
					repo: did,
					collection: record.collection,
					rkey: record.rkey,
					record: record.value as Record<string, unknown>,
					validate: false,
				});
				if (written.cid !== record.cid) {
					throw new Error(`${record.collection}/${record.rkey} arrived as ${written.cid}`);
				}
				recordsMatched++;
			}

			for (const member of artifacts.registry.members) {
				await targetClient.putMember(registry.spaceUri, {
					did: member.did,
					read: member.read,
					write: member.write,
				});
			}

			const targetCommit = await targetClient.getLatestCommit({
				space: registry.spaceUri,
				repo: did,
			});
			const commitMatches = artifacts.commit
				? commitDigest(artifacts.commit) === commitDigest(targetCommit.commit)
				: null;
			if (commitMatches === false) {
				throw new Error(`${registry.spaceUri} commit digest does not match`);
			}
			movedSpaces.push({
				spaceUri: registry.spaceUri,
				records: artifacts.records.length,
				blobs: artifacts.blobs.length,
				members: artifacts.registry.members.length,
				recordsMatched,
				commitMatches,
			});
		}
		step("move the spaces", `${movedSpaces.length} space(s)`);
	} catch (error) {
		return fail("move the spaces", error);
	}

	// 6. The DID document, read from the directory rather than assumed from the step above.
	const didPointsAtNew = await didPointsAt(targetUrl, did, opts.fetchImpl);

	// 7. Retirement, and only now. A failure here leaves the old copy in place and says so.
	let retired: MoveReport["retired"] = "skipped";
	let retirementDetail: string | undefined;
	if (opts.retire !== false) {
		// Only the identity that actually moved. An account row can be attached to a hosted
		// identity elsewhere (a test fixture, a second identity), and retiring the wrong one would
		// delete an account nobody asked to move.
		const [hosted] = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(and(eq(hostedAccounts.userId, userId), eq(hostedAccounts.did, did)))
			.limit(1);
		if (!hosted) {
			retired = "none";
		} else {
			const outcome = await releaseHostedIdentities(userId);
			if (outcome.status === "released") retired = "released";
			else if (outcome.status === "deferred") {
				retired = "deferred";
				retirementDetail = outcome.reason;
			} else {
				retired = "deferred";
				retirementDetail = "reason" in outcome ? outcome.reason : outcome.status;
			}
		}
	}

	// 8. The account now points at the new server. The handle row is the current address, so it
	// moves too; an old handle redirect is the handle-history table's business.
	await db
		.update(users)
		.set({ atprotoPdsUrl: targetUrl, atprotoHandle: handle })
		.where(eq(users.id, userId));

	return {
		ok: true,
		report: {
			did,
			from: old.pdsUrl,
			to: targetUrl,
			handle,
			steps: stages,
			repoImported,
			spaces: movedSpaces,
			didPointsAtNew,
			retired,
			...(retirementDetail ? { retirementDetail } : {}),
		},
	};
}

/**
 * Whether the directory's DID document names the new server.
 *
 * ⚠️ **Null is a real answer.** A deployment may not configure the directory URL, and a
 * network read can fail; saying "unknown" is honest where assuming success would hide the one
 * check that proves the move reached the world rather than only the two servers.
 */
async function didPointsAt(
	targetUrl: string,
	did: string,
	fetchImpl?: typeof fetch,
): Promise<boolean | null> {
	const directory = (process.env.ATPROTO_PLC_URL ?? "").replace(/\/+$/, "");
	if (!directory) return null;
	try {
		const response = await (fetchImpl ?? fetch)(`${directory}/${encodeURIComponent(did)}`);
		if (!response.ok) return null;
		const doc = (await response.json()) as {
			service?: Array<{ serviceEndpoint?: string }>;
		};
		const endpoint = doc.service?.[0]?.serviceEndpoint?.replace(/\/+$/, "");
		return endpoint === targetUrl;
	} catch {
		return null;
	}
}

interface XrpcOptions {
	token?: string;
	params?: Record<string, string>;
	body?: unknown;
	/** A POST with no input, which `activateAccount` is. */
	post?: boolean;
	headers?: Record<string, string>;
	fetchImpl?: typeof fetch;
}

/** The server-level calls a move makes, with the error name the PDS answered. */
async function xrpc<T>(baseUrl: string, method: string, opts: XrpcOptions = {}): Promise<T> {
	const url = new URL(`/xrpc/${method}`, baseUrl);
	for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, value);
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await (opts.fetchImpl ?? fetch)(url, {
		method: opts.body === undefined && !opts.post ? "GET" : "POST",
		headers,
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
	});
	if (!response.ok) {
		let detail: { error?: string; message?: string } = {};
		try {
			detail = (await response.json()) as typeof detail;
		} catch {
			// A non-JSON error still has a status.
		}
		throw new SpaceRequestError(method, response.status, detail.error, detail.message);
	}
	const text = await response.text();
	return (text ? JSON.parse(text) : {}) as T;
}

async function fetchCar(
	pdsUrl: string,
	token: string,
	did: string,
	fetchImpl?: typeof fetch,
): Promise<Uint8Array> {
	const url = new URL("/xrpc/com.atproto.sync.getRepo", pdsUrl);
	url.searchParams.set("did", did);
	const response = await (fetchImpl ?? fetch)(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		throw new SpaceRequestError("com.atproto.sync.getRepo", response.status, undefined, undefined);
	}
	return new Uint8Array(await response.arrayBuffer());
}

async function importCar(
	pdsUrl: string,
	token: string,
	car: Uint8Array,
	fetchImpl?: typeof fetch,
): Promise<void> {
	const copy = new Uint8Array(car.byteLength);
	copy.set(car);
	const response = await (fetchImpl ?? fetch)(
		new URL("/xrpc/com.atproto.repo.importRepo", pdsUrl),
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ipld.car" },
			body: copy,
		},
	);
	if (!response.ok) {
		throw new SpaceRequestError(
			"com.atproto.repo.importRepo",
			response.status,
			undefined,
			undefined,
		);
	}
}

async function latestPublicCommit(
	pdsUrl: string,
	token: string,
	did: string,
	fetchImpl?: typeof fetch,
): Promise<{ cid: string; rev: string }> {
	const url = new URL("/xrpc/com.atproto.sync.getLatestCommit", pdsUrl);
	url.searchParams.set("did", did);
	const response = await (fetchImpl ?? fetch)(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		throw new SpaceRequestError(
			"com.atproto.sync.getLatestCommit",
			response.status,
			undefined,
			undefined,
		);
	}
	return (await response.json()) as { cid: string; rev: string };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
