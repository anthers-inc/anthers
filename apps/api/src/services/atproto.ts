/**
 * ATProto OAuth service — handle resolution, DPoP proof creation,
 * OAuth flow (PAR, token exchange), and PDS interaction helpers.
 *
 * Ported from legacy Django: accounts/atproto_oauth.py
 */

import * as jose from "jose";
import { eq } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { users, atprotoSessions } from "@anthers/db/schema";

// ─── Handle & DID Resolution ────────────────────────────────────────────────

/** Resolve an AT Protocol handle to a DID. Tries public API first, then HTTP well-known. */
export async function resolveHandle(handle: string): Promise<string> {
	// Primary: Bluesky public API
	try {
		const res = await fetch(
			`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as { did: string };
			return data.did;
		}
	} catch {
		// Fall through to HTTP well-known
	}

	// Fallback: HTTP well-known
	const res = await fetch(`https://${handle}/.well-known/atproto-did`);
	if (!res.ok) {
		throw new Error(`Failed to resolve handle: ${handle}`);
	}
	const did = (await res.text()).trim();
	if (!did.startsWith("did:")) {
		throw new Error(`Invalid DID from well-known: ${did}`);
	}
	return did;
}

/** Resolve a DID to its DID document. */
export async function resolveDidDocument(did: string): Promise<Record<string, any>> {
	let url: string;
	if (did.startsWith("did:plc:")) {
		url = `https://plc.directory/${did}`;
	} else if (did.startsWith("did:web:")) {
		const domain = did.replace("did:web:", "");
		url = `https://${domain}/.well-known/did.json`;
	} else {
		throw new Error(`Unsupported DID method: ${did}`);
	}

	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to resolve DID document for ${did}`);
	}
	return res.json();
}

/** Extract PDS URL from a DID document. */
export function getPdsUrl(didDoc: Record<string, any>): string {
	const services = didDoc.service as Array<{ type: string; serviceEndpoint: string }> | undefined;
	const pds = services?.find((s) => s.type === "AtprotoPersonalDataServer");
	if (!pds) {
		throw new Error("No PDS service found in DID document");
	}
	return pds.serviceEndpoint;
}

/** Extract handle from a DID document's alsoKnownAs field. */
export function getHandleFromDidDocument(didDoc: Record<string, any>): string | null {
	const aliases = didDoc.alsoKnownAs as string[] | undefined;
	const atUri = aliases?.find((a) => a.startsWith("at://"));
	return atUri ? atUri.replace("at://", "") : null;
}

// ─── DPoP Key & Proof ───────────────────────────────────────────────────────

export interface DPopKeyPair {
	privatePem: string;
	jwk: jose.JWK;
}

/** Generate an ES256 (P-256) key pair for DPoP proofs. */
export async function generateDPopKey(): Promise<DPopKeyPair> {
	const { publicKey, privateKey } = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);

	// Export private key as PEM
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
	const privatePem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`;

	// Export public key as JWK
	const jwk = await crypto.subtle.exportKey("jwk", publicKey);

	return {
		privatePem,
		jwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! },
	};
}

/** Import a PEM private key for signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	return jose.importPKCS8(pem, "ES256");
}

interface DPopProofOptions {
	method: string;
	url: string;
	privatePem: string;
	jwk: jose.JWK;
	nonce?: string;
	accessToken?: string;
}

/** Create a DPoP proof JWT. */
export async function createDPopProof(opts: DPopProofOptions): Promise<string> {
	const privateKey = await importPrivateKey(opts.privatePem);

	const payload: Record<string, unknown> = {
		htm: opts.method,
		htu: opts.url,
		iat: Math.floor(Date.now() / 1000),
		jti: crypto.randomUUID(),
	};

	if (opts.nonce) {
		payload.nonce = opts.nonce;
	}

	if (opts.accessToken) {
		// ath = base64url(SHA-256(access_token))
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.accessToken));
		payload.ath = jose.base64url.encode(new Uint8Array(hash));
	}

	return new jose.SignJWT(payload)
		.setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: opts.jwk })
		.sign(privateKey);
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

export interface PkceChallenge {
	codeVerifier: string;
	codeChallenge: string;
}

/** Generate a PKCE challenge pair. */
export async function generatePkce(): Promise<PkceChallenge> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const codeVerifier = jose.base64url.encode(verifierBytes);

	const challengeHash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(codeVerifier),
	);
	const codeChallenge = jose.base64url.encode(new Uint8Array(challengeHash));

	return { codeVerifier, codeChallenge };
}

// ─── Authorization Server Discovery ─────────────────────────────────────────

export interface ASMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	pushed_authorization_request_endpoint?: string;
	dpop_signing_alg_values_supported?: string[];
	[key: string]: unknown;
}

/** Discover the Authorization Server metadata for a PDS. */
export async function discoverAuthorizationServer(pdsUrl: string): Promise<ASMetadata> {
	// Step 1: Get the AS URL from the PDS's protected resource metadata
	const prRes = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`);
	if (!prRes.ok) {
		throw new Error(`Failed to fetch protected resource metadata from ${pdsUrl}`);
	}
	const prData = (await prRes.json()) as { authorization_servers?: string[] };
	const asUrl = prData.authorization_servers?.[0];
	if (!asUrl) {
		throw new Error("No authorization server found in protected resource metadata");
	}

	// Step 2: Get the AS metadata
	const asRes = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
	if (!asRes.ok) {
		throw new Error(`Failed to fetch AS metadata from ${asUrl}`);
	}
	return asRes.json() as Promise<ASMetadata>;
}

// ─── OAuth Flow ──────────────────────────────────────────────────────────────

export interface OAuthInitResult {
	authorizationUrl: string;
	state: string;
	codeVerifier: string;
	dpopPrivatePem: string;
	dpopJwk: jose.JWK;
	did: string;
	handle: string;
	pdsUrl: string;
	asMetadata: ASMetadata;
	clientId: string;
	redirectUri: string;
}

interface OAuthInitOptions {
	handle: string;
	clientId?: string;
	redirectUri: string;
	baseUrl: string;
}

/**
 * Initiate the ATProto OAuth flow.
 * Resolves handle → DID → PDS → AS, generates PKCE + DPoP key, performs PAR.
 */
export async function initiateOAuth(opts: OAuthInitOptions): Promise<OAuthInitResult> {
	// 1. Resolve handle → DID → DID doc → PDS URL
	const did = await resolveHandle(opts.handle);
	const didDoc = await resolveDidDocument(did);
	const pdsUrl = getPdsUrl(didDoc);
	const resolvedHandle = getHandleFromDidDocument(didDoc) ?? opts.handle;

	// 2. Discover AS
	const asMetadata = await discoverAuthorizationServer(pdsUrl);

	// 3. Generate PKCE + DPoP key
	const pkce = await generatePkce();
	const dpopKey = await generateDPopKey();

	// 4. Generate state
	const stateBytes = crypto.getRandomValues(new Uint8Array(16));
	const state = Array.from(stateBytes, (b) => b.toString(16).padStart(2, "0")).join("");

	// 5. Build client_id and redirect_uri
	let clientId: string;
	let redirectUri: string;

	if (opts.clientId) {
		// Production: client_id is the URL to the client metadata document
		clientId = opts.clientId;
		redirectUri = opts.redirectUri;
	} else {
		// Dev: loopback client per RFC 8252
		redirectUri = opts.redirectUri.replace("localhost", "127.0.0.1");
		clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=atproto`;
	}

	// 6. Pushed Authorization Request (PAR)
	let authorizationUrl: string;

	if (asMetadata.pushed_authorization_request_endpoint) {
		const parUrl = asMetadata.pushed_authorization_request_endpoint;
		const parBody = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "atproto",
			code_challenge: pkce.codeChallenge,
			code_challenge_method: "S256",
			state,
			login_hint: resolvedHandle,
		});

		// First attempt (no nonce)
		let dpopProof = await createDPopProof({
			method: "POST",
			url: parUrl,
			privatePem: dpopKey.privatePem,
			jwk: dpopKey.jwk,
		});

		let parRes = await fetch(parUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				DPoP: dpopProof,
			},
			body: parBody.toString(),
		});

		// Handle DPoP nonce requirement
		if (parRes.status === 400) {
			const errData = (await parRes.json()) as { error?: string };
			if (errData.error === "use_dpop_nonce") {
				const nonce = parRes.headers.get("DPoP-Nonce");
				if (nonce) {
					dpopProof = await createDPopProof({
						method: "POST",
						url: parUrl,
						privatePem: dpopKey.privatePem,
						jwk: dpopKey.jwk,
						nonce,
					});
					parRes = await fetch(parUrl, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							DPoP: dpopProof,
						},
						body: parBody.toString(),
					});
				}
			}
		}

		if (!parRes.ok) {
			const errText = await parRes.text();
			throw new Error(`PAR request failed: ${parRes.status} ${errText}`);
		}

		const parData = (await parRes.json()) as { request_uri: string };
		authorizationUrl =
			`${asMetadata.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
	} else {
		// Fallback: direct authorization endpoint
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "atproto",
			code_challenge: pkce.codeChallenge,
			code_challenge_method: "S256",
			state,
			login_hint: resolvedHandle,
		});
		authorizationUrl = `${asMetadata.authorization_endpoint}?${params.toString()}`;
	}

	return {
		authorizationUrl,
		state,
		codeVerifier: pkce.codeVerifier,
		dpopPrivatePem: dpopKey.privatePem,
		dpopJwk: dpopKey.jwk,
		did,
		handle: resolvedHandle,
		pdsUrl,
		asMetadata,
		clientId,
		redirectUri,
	};
}

export interface TokenResponse {
	access_token: string;
	token_type: string;
	sub: string; // DID
	refresh_token?: string;
	dpopNonce?: string;
	[key: string]: unknown;
}

/** Exchange an authorization code for tokens. Handles DPoP nonce retry. */
export async function exchangeCode(
	tokenEndpoint: string,
	code: string,
	redirectUri: string,
	codeVerifier: string,
	clientId: string,
	dpopPrivatePem: string,
	dpopJwk: jose.JWK,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
		client_id: clientId,
	});

	let dpopProof = await createDPopProof({
		method: "POST",
		url: tokenEndpoint,
		privatePem: dpopPrivatePem,
		jwk: dpopJwk,
	});

	let res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			DPoP: dpopProof,
		},
		body: body.toString(),
	});

	// Handle DPoP nonce retry
	if (res.status === 400) {
		const errData = (await res.json()) as { error?: string };
		if (errData.error === "use_dpop_nonce") {
			const nonce = res.headers.get("DPoP-Nonce");
			if (nonce) {
				dpopProof = await createDPopProof({
					method: "POST",
					url: tokenEndpoint,
					privatePem: dpopPrivatePem,
					jwk: dpopJwk,
					nonce,
				});
				res = await fetch(tokenEndpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						DPoP: dpopProof,
					},
					body: body.toString(),
				});
			}
		}
	}

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Token exchange failed: ${res.status} ${errText}`);
	}

	const tokenData = (await res.json()) as TokenResponse;
	const dpopNonce = res.headers.get("DPoP-Nonce") ?? undefined;

	return { ...tokenData, dpopNonce };
}

/** Fetch a user's Bluesky profile (public, no auth needed). */
export async function getBlueskyProfile(
	did: string,
): Promise<{ displayName?: string; avatar?: string }> {
	try {
		const res = await fetch(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as { displayName?: string; avatar?: string };
			return { displayName: data.displayName, avatar: data.avatar };
		}
	} catch {
		// Non-fatal
	}
	return {};
}

// ─── ATProto User Management ─────────────────────────────────────────────────

/**
 * Find or create a user from ATProto OAuth.
 * If a user with the DID exists, update their handle/PDS info.
 * Otherwise, create a new user (no password, ATProto-only).
 */
export async function findOrCreateAtprotoUser(
	did: string,
	handle: string,
	pdsUrl: string,
	displayName?: string,
): Promise<typeof users.$inferSelect> {
	// Check for existing user with this DID
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.atprotoDid, did))
		.limit(1);

	if (existing) {
		// Update handle/PDS if changed
		const updates: Record<string, string> = {};
		if (existing.atprotoHandle !== handle) updates.atprotoHandle = handle;
		if (existing.atprotoPdsUrl !== pdsUrl) updates.atprotoPdsUrl = pdsUrl;
		if (displayName && !existing.displayName) updates.displayName = displayName;

		if (Object.keys(updates).length > 0) {
			await db.update(users).set(updates).where(eq(users.id, existing.id));
		}

		return { ...existing, ...updates };
	}

	// Create new user
	const username = await generateUniqueUsername(handle);
	const [newUser] = await db
		.insert(users)
		.values({
			username,
			email: `${did}@atproto.invalid`, // placeholder, no real email
			atprotoDid: did,
			atprotoHandle: handle,
			atprotoPdsUrl: pdsUrl,
			displayName: displayName ?? "",
			emailVerified: false,
		})
		.returning();

	return newUser;
}

/** Generate a unique username from an ATProto handle. */
async function generateUniqueUsername(handle: string): Promise<string> {
	// Strip common Bluesky suffixes
	let base = handle
		.replace(/\.bsky\.social$/, "")
		.replace(/\.bsky\.network$/, "")
		.replace(/\.bsky\.app$/, "");

	// Sanitize to allowed chars, truncate
	base = base.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);

	if (!base) base = "user";

	// Check uniqueness
	const [exists] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, base))
		.limit(1);

	if (!exists) return base;

	// Try numbered suffixes
	for (let i = 1; i <= 999; i++) {
		const candidate = `${base.slice(0, 26)}-${i}`;
		const [taken] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, candidate))
			.limit(1);
		if (!taken) return candidate;
	}

	// Final fallback
	return `user-${crypto.randomUUID().slice(0, 8)}`;
}

/** Link an ATProto DID to an existing user account. */
export async function linkAtprotoToUser(
	userId: number,
	did: string,
	handle: string,
	pdsUrl: string,
): Promise<{ error?: string }> {
	// Check if DID is already linked to another account
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoDid, did))
		.limit(1);

	if (existing && existing.id !== userId) {
		return { error: "This Bluesky account is already linked to another user" };
	}

	await db
		.update(users)
		.set({ atprotoDid: did, atprotoHandle: handle, atprotoPdsUrl: pdsUrl })
		.where(eq(users.id, userId));

	return {};
}

/** Unlink ATProto from a user. Refuses if user has no password (would lock them out). */
export async function unlinkAtprotoFromUser(
	userId: number,
): Promise<{ error?: string }> {
	const [user] = await db
		.select({ passwordHash: users.passwordHash })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user?.passwordHash) {
		return { error: "Cannot unlink Bluesky from an ATProto-only account (no password set)" };
	}

	await db
		.update(users)
		.set({ atprotoDid: null, atprotoHandle: "", atprotoPdsUrl: "" })
		.where(eq(users.id, userId));

	// Also delete the ATProto session
	await db.delete(atprotoSessions).where(eq(atprotoSessions.userId, userId));

	return {};
}

/** Save ATProto session tokens for a user. */
export async function saveAtprotoSession(
	userId: number,
	tokenData: TokenResponse,
	dpopPrivatePem: string,
	dpopJwk: jose.JWK,
	tokenEndpoint: string,
): Promise<void> {
	// Upsert: delete existing then insert
	await db.delete(atprotoSessions).where(eq(atprotoSessions.userId, userId));

	await db.insert(atprotoSessions).values({
		userId,
		accessToken: tokenData.access_token,
		refreshToken: tokenData.refresh_token ?? "",
		dpopPrivatePem,
		dpopJwk,
		tokenEndpoint,
		dpopNonce: tokenData.dpopNonce ?? "",
	});
}
