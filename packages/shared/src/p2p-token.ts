// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The P2P delivery token — format and **verification** (45.05). Shared, deliberately.
 *
 * 45.05's security model is "both sides check": the hub gates introduction, and the peer
 * serving the bytes independently verifies the token against the hub's public key. That is
 * two *checks*, and it must not become two *implementations* — a verifier that is a shade
 * more permissive than the hub's is a hole that only opens on the peer, which is precisely
 * where nobody is looking. So the verifier lives here and every party imports it: the hub,
 * the CLI seeder, and any future peer.
 *
 * **Minting is NOT here, and its absence is the point.** Signing needs the private key,
 * which never leaves the hub — that asymmetry is the whole reason 45.05 chose Ed25519 over
 * the spike's HMAC. A peer that could mint could manufacture its own entitlements, and the
 * cleanest way to guarantee it cannot is for the minting code to be somewhere it cannot
 * reach. `apps/api/src/p2p/token.ts` keeps it.
 *
 * **Verification takes the public key as an argument, with no fallback.** The hub can
 * derive its key from the environment; a peer has no environment and must fetch it from
 * `/api/p2p/pubkey` over TLS. Making the parameter required means a peer cannot accidentally
 * verify against nothing.
 *
 * Browser-safe: `crypto.subtle` only, present in Bun, browsers and Workers.
 */

/** Token TTL: 15 minutes (45.05 § Token lifetime). */
export const P2P_TOKEN_TTL_SECONDS = 15 * 60;

export interface P2pTokenPayload {
	/** Work ID (short name to keep the payload compact). */
	w: number;
	/** Asset ID — the scoping boundary. */
	a: number;
	/** User ID. NOT an identity claim about whoever presents the token; see below. */
	u: number;
	/** Expiry, unix seconds. */
	e: number;
	/** Key ID. Omitted or 1 for the initial key. */
	k?: number;
}

function b64urlDecode(str: string): Uint8Array {
	return Buffer.from(str, "base64url");
}

/**
 * Verify a token against the hub's public key.
 *
 * Returns the payload when the signature is genuine and the token is unexpired, and null
 * for every failure — a peer has no use for the distinction, and reporting *why* a token
 * failed tells a prober which half to work on.
 *
 * 🚨 **A valid token does not authenticate the party presenting it.** It is a bearer
 * credential for its 15-minute life (45.05 § bearer), so `payload.u` is "the user the hub
 * vouched for", not "who you are talking to". Nothing may make a decision about a *person*
 * with it, and no peer should display it.
 *
 * The caller still has to check scope: this verifies the signature and the clock, and the
 * `a` field is meaningless until someone compares it against the asset actually requested.
 * `verifyForAsset` below does both so the check cannot be half-done.
 */
export async function verifyP2pToken(
	token: string,
	publicKeyB64: string,
): Promise<P2pTokenPayload | null> {
	const [payloadB64, sigB64] = token.split(".");
	if (!payloadB64 || !sigB64) return null;

	let sig: Uint8Array;
	let payloadBytes: Uint8Array;
	let pubKeyBytes: Uint8Array;
	try {
		sig = b64urlDecode(sigB64);
		payloadBytes = b64urlDecode(payloadB64);
		pubKeyBytes = b64urlDecode(publicKeyB64);
	} catch {
		return null;
	}

	// Ed25519: 64-byte signature, 32-byte public key. Checked before importKey so a
	// malformed key is a null rather than a thrown DOMException a caller might not catch.
	if (sig.length !== 64 || pubKeyBytes.length !== 32) return null;

	let valid: boolean;
	try {
		const pubKey = await crypto.subtle.importKey(
			"raw",
			pubKeyBytes as BufferSource,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		// Signed over the base64url payload STRING, not the decoded JSON — so verification is
		// byte-identical without anyone needing to agree on JSON canonicalization.
		valid = await crypto.subtle.verify(
			"Ed25519",
			pubKey,
			sig as BufferSource,
			new TextEncoder().encode(payloadB64) as BufferSource,
		);
	} catch {
		return null;
	}
	if (!valid) return null;

	let payload: P2pTokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return null;
	}

	if (typeof payload.e !== "number" || payload.e < Math.floor(Date.now() / 1000)) return null;
	if (
		typeof payload.w !== "number" ||
		typeof payload.a !== "number" ||
		typeof payload.u !== "number"
	) {
		return null;
	}

	return payload;
}

/**
 * Verify a token AND confirm it covers the asset being asked for.
 *
 * Exists because the signature check alone is not the authorization check, and separating
 * them invites serving asset B to a token minted for asset A — the token is scoped to one
 * asset and that scope is only enforced if someone compares it. Every serving peer should
 * call this rather than `verifyP2pToken` directly.
 */
export async function verifyForAsset(
	token: string,
	publicKeyB64: string,
	assetId: number,
): Promise<P2pTokenPayload | null> {
	const payload = await verifyP2pToken(token, publicKeyB64);
	if (!payload || payload.a !== assetId) return null;
	return payload;
}

/** Pull the raw token out of an `Authorization: Bearer <token>` header. */
export function bearerFromHeader(header: string | null | undefined): string | null {
	if (!header) return null;
	const [scheme, ...rest] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer") return null;
	const token = rest.join(" ").trim();
	return token.length > 0 ? token : null;
}
