// SPDX-License-Identifier: Apache-2.0
/**
 * Driving the signup ceremony from a test, now that every account is created holding an identity.
 *
 * 🚨 **An account can only come into existence through a pending signup that carries an identity**,
 * so a suite that used to spend a code for a bare address and get an account has to bring one.
 * `signUp` binds a real identity on the test session's server to a pending signup the way the OAuth
 * callback would, then spends a real code against it — the ceremony, with the round trip on
 * somebody else's website left out, because no test may take it.
 *
 * 🚨 **`stubNetwork` fails loudly on any address it was not told about.** Creating a hosted identity
 * reaches the node, and recording one reads the PLC directory, both through the global `fetch`; a
 * stub that answered everything with `{}` would let a new call to a real server slip through as a
 * pass. An unexpected URL throws instead, so the test that reached it fails and names the address.
 */
import { afterAll, beforeAll } from "bun:test";
import { db } from "@anthers/db";
import { signupCodes } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { plcDirectoryUrl } from "../lib/atproto-network.js";
import { startPendingSignup } from "../services/pending-signups.js";
import { issueSignupCode } from "../services/signup-codes.js";
import { broughtIdentity } from "./account-fixture.js";

/** CSRF requires a real browser Origin — a bare Request never reaches the handler. */
export const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:3000" };

/** The token a `Set-Cookie` header binds a pending signup to, or undefined when it sets none. */
export function pendingCookie(setCookie: string | null): string | undefined {
	return (setCookie ?? "").match(/signup_pending=([^;]+)/)?.[1] || undefined;
}

/** Drop whatever code is live for an address, so the send throttle cannot answer instead. */
export async function clearThrottle(email: string): Promise<void> {
	await db.delete(signupCodes).where(eq(signupCodes.email, email.trim().toLowerCase()));
}

/** Spend a real code at a verify route, carrying the pending-signup token when there is one. */
export async function spendCode(path: string, email: string, token?: string): Promise<Response> {
	await clearThrottle(email);
	const issued = await issueSignupCode(email);
	if (!issued.code) throw new Error(`no code could be minted for ${email}`);
	return app.request(path, {
		method: "POST",
		headers: { ...JSON_HEADERS, ...(token ? { Cookie: `signup_pending=${token}` } : {}) },
		body: JSON.stringify({ email, code: issued.code }),
	});
}

/**
 * Create an account through the ceremony, with a brought identity on the session's server, and hand
 * back the response `/signup/verify` gave — which carries the session cookie.
 */
export async function signUp(email: string): Promise<Response> {
	const token = await startPendingSignup({
		email,
		identity: await broughtIdentity(),
	});
	return spendCode("/api/auth/signup/verify", email, token);
}

/** What the stubbed node does when asked to create an account. */
export type NodeCreate =
	| { kind: "ok"; did: string; handle: string }
	| { kind: "refuse"; error: string }
	| { kind: "down" };

export interface NetworkStub {
	/** How the next `createAccount` call is answered. */
	create: NodeCreate;
	/** Handles the node reports as existing, in full (`name.suffix`). */
	existing: Set<string>;
	/** Every URL requested, in order. */
	calls: string[];
}

export const NODE_URL = "https://node.invalid";

/**
 * Open the Anthers door against a node that does not exist, and stub every address signup reaches.
 *
 * Registers its own `beforeAll`/`afterAll`, so call it once at the top of a file. The environment is
 * put back exactly as it was, because `bun test` runs every file in one process.
 */
export function stubNetwork(): NetworkStub {
	const stub: NetworkStub = { create: { kind: "down" }, existing: new Set(), calls: [] };
	const realFetch = globalThis.fetch;
	const before = {
		url: process.env.HOSTED_PDS_URL,
		invite: process.env.HOSTED_PDS_INVITE_CODE,
		key: process.env.HOSTED_ACCOUNT_KEY,
	};

	beforeAll(() => {
		process.env.HOSTED_PDS_URL = NODE_URL;
		process.env.HOSTED_PDS_INVITE_CODE = "EXAMPLE-not-a-real-invite";
		process.env.HOSTED_ACCOUNT_KEY = Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("hex");

		const answer = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});

		globalThis.fetch = Object.assign(
			async (input: string | URL | Request) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				stub.calls.push(url);

				if (url === `${NODE_URL}/xrpc/com.atproto.server.describeServer`) {
					return answer({ availableUserDomains: [`.${new URL(NODE_URL).hostname}`] });
				}
				if (url.startsWith(`${NODE_URL}/xrpc/com.atproto.server.createAccount`)) {
					const create = stub.create;
					if (create.kind === "down") throw new Error("node.invalid does not resolve");
					if (create.kind === "refuse") return answer({ error: create.error }, 400);
					stub.existing.add(create.handle);
					return answer({ did: create.did, handle: create.handle });
				}
				if (url.startsWith(`${NODE_URL}/xrpc/com.atproto.identity.resolveHandle`)) {
					const handle = new URL(url).searchParams.get("handle") ?? "";
					return stub.existing.has(handle)
						? answer({ did: "did:plc:existing" })
						: answer({ error: "InvalidRequest" }, 400);
				}
				// Recording an identity reads its audit log; nothing here asserts on it.
				if (url.startsWith(`${plcDirectoryUrl()}/`)) return answer({}, 404);
				// The Bluesky profile decoration on the OAuth callback path.
				if (url.startsWith("https://public.api.bsky.app/")) return answer({});

				throw new Error(`unexpected network call in a test: ${url}`);
			},
			{ preconnect: realFetch.preconnect },
		);
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		const put = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		put("HOSTED_PDS_URL", before.url);
		put("HOSTED_PDS_INVITE_CODE", before.invite);
		put("HOSTED_ACCOUNT_KEY", before.key);
	});

	return stub;
}
