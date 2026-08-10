// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery token — the load-bearing piece of the spike.
 *
 * This is the P2P analogue of an S3 presigned URL. The existing delivery path mints a
 * short-lived signed URL that the storage backend honours; the P2P path mints a
 * short-lived signed token that the hub-hosted seeder honours. Same shape, different
 * verifier.
 *
 * The token is a compact base64url payload (workId, assetId, userId, exp) followed by an
 * HMAC-SHA256 signature over it. The signing key is `P2P_TOKEN_SECRET` (env var, random
 * default in dev). The seeder verifies the signature and the expiry on every chunk
 * request — there is no session, no cookie, no origin check. The token IS the credential.
 *
 * This is deliberately NOT a JWT: no header, no algorithm negotiation, no third-party
 * library. Two base64url strings separated by a dot, one payload, one signature.
 */

const DEFAULT_SECRET = "dev-p2p-secret-do-not-use-in-prod";

function getSecret(): string {
	return process.env.P2P_TOKEN_SECRET ?? DEFAULT_SECRET;
}

export interface P2pTokenPayload {
	workId: number;
	assetId: number;
	userId: number;
	exp: number; // unix seconds
}

function b64urlEncode(data: Uint8Array): string {
	return btoa(String.fromCharCode(...data))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmac(data: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(getSecret()),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
	return new Uint8Array(sig);
}

/** Mint a short-lived P2P delivery token for one asset on one Work for one user. */
export async function mintP2pToken(payload: P2pTokenPayload): Promise<string> {
	const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = await hmac(new TextEncoder().encode(body));
	return `${body}.${b64urlEncode(sig)}`;
}

/** Verify a P2P delivery token. Returns the payload if valid and unexpired, null otherwise. */
export async function verifyP2pToken(token: string): Promise<P2pTokenPayload | null> {
	const [body, sig] = token.split(".");
	if (!body || !sig) return null;

	const expectedSig = await hmac(new TextEncoder().encode(body));
	const providedSig = b64urlDecode(sig);

	// Constant-time comparison
	if (expectedSig.length !== providedSig.length) return null;
	let ok = 0;
	for (let i = 0; i < expectedSig.length; i++) {
		ok |= expectedSig[i] ^ providedSig[i];
	}
	if (ok !== 0) return null;

	let payload: P2pTokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
	} catch {
		return null;
	}

	// Expiry check
	if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
		return null;
	}

	return payload;
}
