// SPDX-License-Identifier: Apache-2.0
/**
 * Reading the service-auth JWT a space authority sends when it asks us about a reader.
 *
 * This is the whole authentication of `checkUserAccess`. A space authority mints a JWT signed
 * by its own `#atproto` key, addressed to the managing app's service identifier (`aud`) and
 * naming the method it is for (`lxm`); the route has no session, no cookie and no header a
 * browser could set, because the caller is a PDS rather than a person. Verifying it is the
 * difference between answering the network and answering anyone who can reach the path.
 *
 * 🚨 **Every failure denies.** The route is the strictest gate the product has, and the
 * protocol's own caller treats an error as a refusal — but the direction matters here too: a
 * request we cannot verify must never reach the access resolver as though it were the space's
 * authority asking. The claims are checked before the key is fetched, and the key is fetched
 * from the DID the token names, never from anything in the request body.
 *
 * The shape follows the protocol's own `verifyJwt` (`@atproto/xrpc-server`), which this app
 * does not depend on: the checks, the accepted `typ` refusal list, and the one retry with a
 * freshly resolved key after a signature failure are the same, so an authority's valid token
 * verifies here for the same reasons it verifies at a PDS.
 */
import { didKeyFromVerificationMethod, verifyDidKeySignature } from "../lib/did-key.js";
import { getAtprotoClient } from "./atproto-client.js";

/** The pieces of a DID document this verifier reads. */
export interface ServiceAuthDidDocument {
	id?: string;
	verificationMethod?: Array<{
		id?: string;
		type?: string;
		publicKeyMultibase?: string;
	}>;
}

/**
 * Resolve a DID to its document.
 *
 * `fresh` asks for a resolution that bypasses whatever cache sits behind the resolver, which
 * is the protocol's answer to a key rotation: a signature that fails against a cached key is
 * retried once against a newly fetched one.
 */
export type ResolveDid = (
	did: string,
	options?: { fresh?: boolean },
) => Promise<ServiceAuthDidDocument | null>;

/** The claims this route relies on, as `verifyServiceAuth` returns them. */
export interface ServiceAuthClaims {
	iss: string;
	aud: string;
	lxm?: string;
	jti?: string;
	iat?: number;
	exp: number;
}

export type ServiceAuthErrorCode =
	| "BadJwt"
	| "BadJwtType"
	| "JwtExpired"
	| "BadJwtAudience"
	| "BadJwtLexiconMethod"
	| "BadJwtIss"
	| "BadJwtSignature"
	| "DidNotResolve"
	| "MissingSigningKey";

/** A refusal the route can turn into a 401 without re-deriving what went wrong. */
export class ServiceAuthError extends Error {
	constructor(
		readonly code: ServiceAuthErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ServiceAuthError";
	}
}

/** The JWT types that are valid AT Protocol tokens but never service auth. */
const NOT_SERVICE_AUTH = new Set(["at+jwt", "refresh+jwt", "dpop+jwt"]);

/** Five seconds of clock skew, the protocol verifier's own allowance. */
const CLOCK_SKEW_SEC = 5;

/**
 * Verify a service-auth JWT and return its claims.
 *
 * `serviceId` is this app's full identifier including the fragment
 * (`did:web:anthers.org#anthers`), because that is what the authority puts in `aud` when the
 * space names a fragment-bearing `managingApp`.
 */
export async function verifyServiceAuth(
	jwt: string,
	options: {
		serviceId: string;
		lxm: string;
		resolveDid: ResolveDid;
		now?: number;
	},
): Promise<ServiceAuthClaims> {
	const parts = jwt.split(".");
	if (parts.length !== 3) throw new ServiceAuthError("BadJwt", "poorly formatted jwt");

	const header = parseJsonPart(parts[0] as string);
	if (!header || typeof header.alg !== "string") {
		throw new ServiceAuthError("BadJwt", "poorly formatted jwt header");
	}
	if (typeof header.typ === "string" && NOT_SERVICE_AUTH.has(header.typ)) {
		throw new ServiceAuthError("BadJwtType", `invalid jwt type "${header.typ}"`);
	}

	const payload = parseJsonPart(parts[1] as string);
	if (
		!payload ||
		typeof payload.iss !== "string" ||
		typeof payload.aud !== "string" ||
		typeof payload.exp !== "number"
	) {
		throw new ServiceAuthError("BadJwt", "poorly formatted jwt payload");
	}
	const claims: ServiceAuthClaims = {
		iss: payload.iss,
		aud: payload.aud,
		...(typeof payload.lxm === "string" ? { lxm: payload.lxm } : {}),
		...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
		...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
		exp: payload.exp,
	};

	const now = (options.now ?? Date.now()) / 1000;
	if (now > claims.exp + CLOCK_SKEW_SEC) {
		throw new ServiceAuthError("JwtExpired", "jwt expired");
	}
	if (claims.aud !== options.serviceId) {
		throw new ServiceAuthError("BadJwtAudience", "jwt audience does not match this service");
	}
	if (claims.lxm !== options.lxm) {
		throw new ServiceAuthError(
			"BadJwtLexiconMethod",
			claims.lxm === undefined
				? `missing jwt lexicon method ("lxm"). must match: ${options.lxm}`
				: `bad jwt lexicon method ("lxm"). must match: ${options.lxm}`,
		);
	}
	if (!isBareDid(claims.iss)) {
		throw new ServiceAuthError("BadJwtIss", "jwt issuer is not a DID");
	}

	const message = new TextEncoder().encode(parts.slice(0, 2).join("."));
	const signature = base64urlBytes(parts[2] as string);

	const first = await resolveSigningKey(claims.iss, options.resolveDid, false);
	if (verifyDidKeySignature(first, message, signature)) return claims;

	// A cached key may predate a rotation. One fresh read is the protocol's own remedy; a
	// second failure is a bad signature rather than a stale cache.
	const fresh = await resolveSigningKey(claims.iss, options.resolveDid, true);
	if (fresh !== first && verifyDidKeySignature(fresh, message, signature)) return claims;

	throw new ServiceAuthError("BadJwtSignature", "jwt signature does not match jwt issuer");
}

/** Fetch the `#atproto` key the issuer signs with, as a `did:key:`. */
async function resolveSigningKey(
	did: string,
	resolveDid: ResolveDid,
	fresh: boolean,
): Promise<string> {
	const document = await resolveDid(did, fresh ? { fresh: true } : undefined);
	if (!document) throw new ServiceAuthError("DidNotResolve", `could not resolve DID: ${did}`);

	const method = document.verificationMethod?.find(
		(item) => item.id === "#atproto" || item.id === `${did}#atproto`,
	);
	if (!method) {
		throw new ServiceAuthError("MissingSigningKey", `missing or bad key (#atproto) in DID: ${did}`);
	}
	const didKey = didKeyFromVerificationMethod(method);
	if (!didKey) {
		throw new ServiceAuthError("MissingSigningKey", `missing or bad key (#atproto) in DID: ${did}`);
	}
	return didKey;
}

/** A DID with no fragment — a service issuer, not an account-and-service pair. */
function isBareDid(value: string): boolean {
	if (value.includes("#") || /\s/.test(value)) return false;
	return /^did:[a-z0-9]+:.+$/.test(value);
}

function parseJsonPart(part: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(base64urlBytes(part)));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function base64urlBytes(part: string): Uint8Array {
	return new Uint8Array(Buffer.from(part, "base64url"));
}

/**
 * The real resolver: the OAuth client's identity resolver, which knows the session's private
 * network in a checkout and the public directory otherwise.
 *
 * 🚨 **A resolution failure is not a verification shortcut.** It throws, and the route answers
 * 401 — failing closed, because a managing app that cannot see who is asking is exactly the
 * caller that must not be believed.
 */
export const networkDidResolver: ResolveDid = async (did, options) => {
	// The OAuth client's resolver is a facade over the DID and handle resolvers, and
	// `noCache` is its equivalent of the protocol verifier's `forceRefresh`.
	const resolved = await getAtprotoClient().identityResolver.resolve(
		did,
		options?.fresh ? { noCache: true } : undefined,
	);
	return (resolved.didDoc as ServiceAuthDidDocument | null) ?? null;
};
