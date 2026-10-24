// SPDX-License-Identifier: Apache-2.0
/**
 * The short-lived access grant: Anthers' permission to hand over the bytes of one Work now.
 *
 * ⭐ **A grant expires, which is what makes revocation non-renewal.** The receipt is a
 * permanent statement about the past and is never revoked; the grant is a statement about
 * the present, so a refund, a takedown or a quarantine simply stops minting the next one. A
 * single artifact doing both jobs is either an unrevocable permission or a receipt that
 * expires, and neither is honest.
 *
 * 🚨 **A grant does not replace the ledger read.** The delivery route resolves access from
 * `purchases` on every request and refuses first, exactly as it did before; the grant then
 * proves the permission was issued for *this* reader, *this* Work and *these* files, and that
 * it has not expired. The lab's scenario 03 makes the same point — a refund denies delivery
 * even with a grant that still verifies — and that is the order the route keeps.
 *
 * ⚠️ **The grant is a bearer token, and it names the files it authorizes.** It rides a
 * request header on the download route, so a leaked grant is usable by anyone who also
 * passes the ledger check, which is the purchaser. The file list is what keeps a grant for
 * one asset from opening another.
 *
 * The first build mints grants in the API's own process because Anthers is today both the
 * issuer and the host. The shape — signed, scoped, expiring, with the public key published —
 * is what a third-party host would need to serve the same bytes without Anthers in the path;
 * that handoff is the federation step, not this one. Streamed media keeps its per-request
 * ledger check and receives short-lived storage signatures of its own, because an `<audio>`
 * element cannot carry a header.
 */
import {
	accessSigningKey,
	canonicalJson,
	signAccessPayload,
	verifyAccessPayload,
} from "./access-signing.js";

export const GRANT_TYPE = "org.anthers.grant";

/** Ten minutes: long enough for a download to start, short enough to be the revocation tail. */
export const GRANT_LIFETIME_MS = 10 * 60 * 1000;

export interface AccessGrantPayload {
	$type: typeof GRANT_TYPE;
	/** A fresh id per mint, so two grants for one reader are distinguishable in a log. */
	id: string;
	/** The public listing address when there is one, so a host can name what it serves. */
	work: string | null;
	/** Anthers' handle on the Work, present even after the listing is gone. */
	workId: number;
	/** The receipt this grant backs, when a purchase is the basis; null for another entitlement. */
	receipt: string | null;
	/** The reader's DID. */
	reader: string;
	/** How the ledger said yes: `purchased`, `entitled`, `free` or `owner`. */
	basis: string;
	/** The storage keys this grant authorizes — the files, not the Work's whole catalog. */
	files: string[];
	issuedAt: string;
	expiresAt: string;
}

export interface MintGrantInput {
	workId: number;
	workUri: string | null;
	receipt: string | null;
	reader: string;
	basis: string;
	files: string[];
	now?: Date;
}

/** Mint one grant. Throws `AccessSigningUnavailable` when this process cannot sign. */
export function mintAccessGrant(input: MintGrantInput): {
	token: string;
	payload: AccessGrantPayload;
} {
	const now = input.now ?? new Date();
	const payload: AccessGrantPayload = {
		$type: GRANT_TYPE,
		id: `grant-${crypto.randomUUID()}`,
		work: input.workUri,
		workId: input.workId,
		receipt: input.receipt,
		reader: input.reader,
		basis: input.basis,
		files: [...input.files],
		issuedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + GRANT_LIFETIME_MS).toISOString(),
	};
	const { signature } = signAccessPayload(payload as unknown as Record<string, unknown>);
	const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
	return { token: `${encoded}.${signature}`, payload };
}

export type GrantRefusal =
	| "issuer_unavailable"
	| "malformed"
	| "wrong_type"
	| "bad_signature"
	| "expired"
	| "wrong_work"
	| "wrong_reader"
	| "wrong_file";

export interface VerifyGrantOptions {
	/** The reader the request is authenticated as. */
	readerDid: string;
	workId: number;
	/** The storage key the request is about to serve. */
	fileKey: string;
	now?: Date;
	/** Test seam; defaults to this process's published key. */
	publicKey?: Uint8Array;
}

/**
 * Check one presented grant against the request it arrived with.
 *
 * The order is signature, then type, then expiry, then the three claims. A token that does
 * not verify is malformed whatever else it says, and an expired token is not a token for
 * this request even though it was issued by us.
 */
export function verifyAccessGrant(
	token: string,
	opts: VerifyGrantOptions,
): { ok: true; payload: AccessGrantPayload } | { ok: false; reason: GrantRefusal } {
	const publicKey = opts.publicKey ?? accessSigningKey()?.publicKey;
	if (!publicKey) return { ok: false, reason: "issuer_unavailable" };
	if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "malformed" };
	const [encoded, signature, ...extra] = token.split(".");
	if (!encoded || !signature || extra.length > 0) return { ok: false, reason: "malformed" };
	let payload: AccessGrantPayload;
	try {
		payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AccessGrantPayload;
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!payload || typeof payload !== "object" || payload.$type !== GRANT_TYPE) {
		return { ok: false, reason: "wrong_type" };
	}
	if (!verifyAccessPayload(payload, signature, publicKey)) {
		return { ok: false, reason: "bad_signature" };
	}
	const now = (opts.now ?? new Date()).getTime();
	const expiresAt = Date.parse(payload.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: "expired" };
	if (payload.workId !== opts.workId) return { ok: false, reason: "wrong_work" };
	if (payload.reader !== opts.readerDid) return { ok: false, reason: "wrong_reader" };
	if (!Array.isArray(payload.files) || !payload.files.includes(opts.fileKey)) {
		return { ok: false, reason: "wrong_file" };
	}
	return { ok: true, payload };
}
