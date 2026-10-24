// SPDX-License-Identifier: Apache-2.0
/**
 * The reader's side of a gated space read, from the delegation token to a MAC-verified record.
 *
 * The order is the protocol's and none of it can be skipped: the reader's own server mints a
 * single-use delegation token for the space, the space's authority exchanges it (with the app's
 * attestation) for a credential bound to an ephemeral P-256 key, that key signs the record
 * request, and the request carries a key share the authority uses to MAC the answer for the
 * author's KEM key. A read that skips a step is not a read with less proof; it is a different
 * request the authority refuses.
 *
 * ⚠️ **The credential request goes to the creator's PDS, not the reader's.** The reader's
 * server knows the reader's DID and can sign a delegation because the token names the space's
 * authority; the authority is the one that asks the managing app and issues the credential.
 * Two servers, two different calls.
 */
import type { SpaceRecord } from "./atproto-space.js";
import { SpaceRequestError } from "./atproto-space.js";
import type { ClientSigningKey } from "./client-attestation.js";
import {
	encapsulate,
	formatWantMacHeader,
	generateP256Key,
	MAC_HEADER,
	mintClientAttestation,
	type P256Key,
	parseRecordMacHeader,
	signSpaceRequest,
	verifyRecordMac,
	WANT_MAC_HEADER,
} from "./space-crypto.js";

/** Everything the reader's session has to know: whose server, and the bearer it answers to. */
export interface SpaceReaderSession {
	did: string;
	pdsUrl: string;
	token: string;
}

export interface SpaceReadInput {
	reader: SpaceReaderSession;
	creatorDid: string;
	/** The space authority's host — the creator's PDS. */
	creatorPdsUrl: string;
	space: string;
	collection: string;
	rkey: string;
	/** The expected record address, which the MAC covers. */
	expectedUri: string;
	/** The creator's `#atproto_kem` key, resolved from their DID document. */
	authorKemDidKey: string;
	/** The app's client id and key; both are null when the app cannot attest. */
	clientId: string | null;
	clientKey: ClientSigningKey | null;
	fetchImpl?: typeof fetch;
	now?: Date;
}

export interface SpaceReadResult {
	record: SpaceRecord & { value: unknown };
	credential: string;
	key: P256Key;
}

export interface CredentialReadInput {
	credential: string;
	key: P256Key;
	creatorDid: string;
	creatorPdsUrl: string;
	space: string;
	collection: string;
	rkey: string;
	expectedUri: string;
	authorKemDidKey: string;
	fetchImpl?: typeof fetch;
}

/** Why a gated read could not be completed. The route maps these, never a raw message. */
export type SpaceReadFailure =
	| "client_not_configured"
	| "no_kem_key"
	| "mac_mismatch"
	| "wrong_record";

export class SpaceReadError extends Error {
	constructor(
		readonly code: SpaceReadFailure | "request",
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "SpaceReadError";
	}
}

export async function readSpaceRecord(input: SpaceReadInput): Promise<SpaceReadResult> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const key = generateP256Key();

	const delegationToken = await delegationTokenFor(input, fetchImpl);
	const clientAttestation = attestationFor(input);
	const credential = await spaceCredentialFor(input, fetchImpl, {
		credentialKid: key.didKey,
		delegationToken,
		clientAttestation,
	});

	const record = await readRecordWithCredential({
		credential,
		key,
		creatorDid: input.creatorDid,
		creatorPdsUrl: input.creatorPdsUrl,
		space: input.space,
		collection: input.collection,
		rkey: input.rkey,
		expectedUri: input.expectedUri,
		authorKemDidKey: input.authorKemDidKey,
		fetchImpl: input.fetchImpl,
	});
	return { record, credential, key };
}

/**
 * Read one record with a credential already in hand, and verify its MAC.
 *
 * ⭐ **The credential outlives the delegation that made it, and this is the function that says
 * so.** A reader who is removed from a space loses the next credential immediately, but the one
 * already issued keeps reading until it expires — the tail the design promises and the lab's 05
 * measures. It is also the seam a test uses to read with the credential it already holds.
 */
export async function readRecordWithCredential(
	input: CredentialReadInput,
): Promise<SpaceRecord & { value: unknown }> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const { keyShare, sharedSecret } = encapsulate(input.authorKemDidKey);
	const authorization = `Atproto-Space-Credential ${input.credential}`;
	const signatureHeaders = signSpaceRequest(input.key, {
		authorization,
		audience: input.creatorDid,
	});

	const url = new URL("/xrpc/com.atproto.space.getRecord", input.creatorPdsUrl);
	url.searchParams.set("space", input.space);
	url.searchParams.set("repo", input.creatorDid);
	url.searchParams.set("collection", input.collection);
	url.searchParams.set("rkey", input.rkey);
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			...signatureHeaders,
			[WANT_MAC_HEADER]: formatWantMacHeader(keyShare),
		},
	});
	if (!response.ok) throw await requestError("com.atproto.space.getRecord", response);

	const macHeader = response.headers.get(MAC_HEADER);
	const record = (await response.json()) as SpaceRecord & { value: unknown };
	if (record.uri !== input.expectedUri) {
		throw new SpaceReadError("wrong_record", `read ${String(record.uri)} for ${input.expectedUri}`);
	}
	let mac: Uint8Array;
	try {
		mac = parseRecordMacHeader(macHeader);
	} catch (error) {
		throw new SpaceReadError("mac_mismatch", "the response MAC could not be read", error);
	}
	if (!verifyRecordMac(sharedSecret, record.uri, record.cid, mac)) {
		throw new SpaceReadError("mac_mismatch", "the response MAC does not cover this record");
	}
	return record;
}

async function delegationTokenFor(input: SpaceReadInput, fetchImpl: typeof fetch): Promise<string> {
	const url = new URL("/xrpc/com.atproto.space.getDelegationToken", input.reader.pdsUrl);
	url.searchParams.set("space", input.space);
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${input.reader.token}` },
	});
	if (!response.ok) throw await requestError("com.atproto.space.getDelegationToken", response);
	const body = (await response.json()) as { token?: unknown };
	if (typeof body.token !== "string" || body.token.length === 0) {
		throw new SpaceReadError("request", "the delegation answer carried no token");
	}
	return body.token;
}

function attestationFor(input: SpaceReadInput): string | null {
	// No client id is the open-space case: the authority's app perimeter has nothing to check,
	// so no attestation goes on the request. An id with no key is a deployment that names
	// itself in an allow-list and cannot prove it — a misconfiguration, refused rather than
	// downgraded to an unattested request.
	if (!input.clientId) return null;
	if (!input.clientKey) {
		throw new SpaceReadError(
			"client_not_configured",
			"the app has an attestable client id but no key to sign an attestation",
		);
	}
	return mintClientAttestation({
		clientId: input.clientId,
		kid: input.clientKey.publicJwk.kid,
		secretKey: input.clientKey.secretKey,
		spaceDid: input.creatorDid,
		now: input.now,
	});
}

async function spaceCredentialFor(
	input: SpaceReadInput,
	fetchImpl: typeof fetch,
	delegation: { credentialKid: string; delegationToken: string; clientAttestation: string | null },
): Promise<string> {
	const response = await fetchImpl(
		new URL("/xrpc/com.atproto.space.getSpaceCredential", input.creatorPdsUrl),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				space: input.space,
				credentialKid: delegation.credentialKid,
				delegationToken: delegation.delegationToken,
				...(delegation.clientAttestation
					? { clientAttestation: delegation.clientAttestation }
					: {}),
			}),
		},
	);
	if (!response.ok) throw await requestError("com.atproto.space.getSpaceCredential", response);
	const body = (await response.json()) as { credential?: unknown };
	if (typeof body.credential !== "string" || body.credential.length === 0) {
		throw new SpaceReadError("request", "the credential answer carried no credential");
	}
	return body.credential;
}

async function requestError(method: string, response: Response): Promise<SpaceReadError> {
	let detail: { error?: string; message?: string } = {};
	try {
		detail = (await response.json()) as typeof detail;
	} catch {
		// The status is the fact when the body is not JSON.
	}
	return new SpaceReadError(
		"request",
		`${method} failed with ${response.status}${detail.error ? ` ${detail.error}` : ""}`,
		new SpaceRequestError(method, response.status, detail.error, detail.message),
	);
}
