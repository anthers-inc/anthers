// SPDX-License-Identifier: Apache-2.0
/**
 * A signed-in fixture account, created the way signup creates one and holding a real identity on
 * the test session's own AT Protocol network.
 *
 * 🚨 **The account comes from `createAccountFromSignup`, the one place an account row is written**,
 * so a fixture has the shape a real account has: an identity issued by the hosting server, its
 * credential sealed in `hosted_accounts`, and its DID, handle and server on the row. Only the
 * emailed code is skipped, because no suite can read that email. A placeholder DID used to stand
 * in for the identity, which meant every path that resolves or writes to one was untested for every
 * suite built on this.
 *
 * ⚠️ **It needs the session's network**, which every `bun test` starts (`scripts/session.ts`). The
 * identities live in memory there and go when the session ends, and the write guard refuses any
 * server that is not local, so nothing here can reach the real network.
 *
 * 🚨 **The identity is created on the session's server whatever a suite has pointed the hub at.**
 * Suites stub `fetch` and set `HOSTED_PDS_URL` to an unreachable node to test what the hub does when
 * hosting fails, and a fixture account made under those stubs would fail for the reason the suite
 * is testing. So the session's server, directory and invite are captured when this module loads —
 * before any suite's hooks run — and put back only for the length of the creation. The sealing key
 * is deliberately left alone: a suite that sets its own key reads the credential back with it.
 *
 * ⚠️ **What the ceremony does and this does not**: `email_verified` is put back to false unless a
 * suite asks otherwise, because the suites built on this assert the unverified walls; no handle is
 * claimed through `/welcome`; and no welcome email is sent. A suite testing any of those drives the
 * ceremony routes themselves.
 *
 * The account gets a password, so a suite can still exercise `POST /api/auth/sign-in`.
 */

import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type { AtprotoIdentity } from "../services/atproto";
import { createSession, hashPassword } from "../services/auth";
import { hostedHandleSuffix } from "../services/hosted-accounts";
import {
	createAccountFromSignup,
	readPendingSignup,
	startPendingSignup,
} from "../services/pending-signups";

/** The session's own hosting, as the preload set it, before any suite overrode it. */
const SESSION_HOSTING = {
	HOSTED_PDS_URL: process.env.HOSTED_PDS_URL,
	HOSTED_PDS_INVITE_CODE: process.env.HOSTED_PDS_INVITE_CODE,
	ATPROTO_PLC_URL: process.env.ATPROTO_PLC_URL,
};
const SESSION_FETCH = globalThis.fetch;

let hostingDepth = 0;
let suiteHosting: { env: Record<string, string | undefined>; fetch: typeof fetch } | null = null;

/** Run `work` against the session's server, then put back whatever the suite had set. */
async function onSessionNetwork<T>(work: () => Promise<T>): Promise<T> {
	if (hostingDepth++ === 0) {
		suiteHosting = {
			env: Object.fromEntries(Object.keys(SESSION_HOSTING).map((key) => [key, process.env[key]])),
			fetch: globalThis.fetch,
		};
		for (const [key, value] of Object.entries(SESSION_HOSTING)) setEnv(key, value);
		globalThis.fetch = SESSION_FETCH;
	}
	try {
		return await work();
	} finally {
		if (--hostingDepth === 0 && suiteHosting) {
			for (const [key, value] of Object.entries(suiteHosting.env)) setEnv(key, value);
			globalThis.fetch = suiteHosting.fetch;
			suiteHosting = null;
		}
	}
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** The password every fixture account is given unless a suite asks for another. */
export const FIXTURE_PASSWORD = "testpass123";

export interface FixtureAccount {
	/** `session=<token>`, ready for a `Cookie` header. */
	cookie: string;
	/** The session token alone, for a suite that sends it as a bearer token. */
	token: string;
	userId: number;
	username: string | null;
	email: string;
	/** The identity the hosting server issued, and the handle it issued it under. */
	did: string;
	handle: string;
	/** The whole row as the fixture left it, for a suite that needs more than the above. */
	user: typeof users.$inferSelect;
}

const passwordHashes = new Map<string, Promise<string>>();

/**
 * The hash of a fixture password, computed once per password and shared.
 *
 * ⚠️ **argon2id takes about 90 ms by design**, and nearly every fixture account has the same
 * password, so hashing it per account added minutes of nothing to a run. One hash verifies against
 * every row that stores it.
 */
function fixturePasswordHash(password: string): Promise<string> {
	let hash = passwordHashes.get(password);
	if (!hash) {
		hash = hashPassword(password);
		passwordHashes.set(password, hash);
	}
	return hash;
}

/**
 * A handle name nobody else in the session holds.
 *
 * Not the username: an Anthers username may carry an underscore and a handle may not, and the two
 * are separate names in production too.
 */
function fixtureHandleName(): string {
	return `fx${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * An identity created straight on the session's server, the way somebody arrives already holding one.
 *
 * ⚠️ **It lives on the same server Anthers hosts on**, because the session has one server. What makes
 * it "brought" is that Anthers holds no credential for it — no `hosted_accounts` row — so the hub can
 * reach it only through a grant, exactly as it reaches an identity on `bsky.social`. The address the
 * server keeps is a throwaway of its own, so a later hosted account for the same person is not refused
 * for reusing it.
 */
async function createBroughtIdentity(): Promise<AtprotoIdentity> {
	const url = process.env.HOSTED_PDS_URL ?? "";
	const handle = `${fixtureHandleName()}.${await hostedHandleSuffix()}`;
	const res = await fetch(`${url}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			handle,
			email: `brought-${crypto.randomUUID()}@example.com`,
			password: crypto.randomUUID(),
			inviteCode: process.env.HOSTED_PDS_INVITE_CODE,
		}),
	});
	const body = (await res.json()) as { did?: string; handle?: string; message?: string };
	if (!res.ok || !body.did || !body.handle) {
		throw new Error(
			`the session's server would not create a brought identity: ${body.message ?? res.status}`,
		);
	}
	return { did: body.did, handle: body.handle, pdsUrl: url };
}

/**
 * A brought identity on the session's server and no account for it — what a suite driving the
 * Bluesky door binds to a pending signup, the way the OAuth callback would.
 */
export function broughtIdentity(): Promise<AtprotoIdentity> {
	return onSessionNetwork(createBroughtIdentity);
}

/**
 * Create an account with a live session.
 *
 * The email defaults to `<username>@example.com`, which is what the suites used when they
 * signed up through HTTP, so a suite that already deletes by that address keeps working.
 *
 * Pass `null` for an account that has not claimed a username yet — the state the ceremony leaves
 * somebody in until `/welcome` — so a suite can drive the claim, and the terms acceptance that
 * rides on it, through the real route.
 */
export async function createAccount(
	username: string | null,
	opts: {
		email?: string;
		password?: string;
		emailVerified?: boolean;
		/** `hosted` (the default) is an identity Anthers issued; `brought` is one it holds no credential for. */
		identity?: "hosted" | "brought";
		/**
		 * Anything else the suite needs on the row — `isCreator`, an admin flag, a date. The identity
		 * columns are the fixture's to set, so a suite cannot quietly put a placeholder DID back.
		 */
		fields?: Omit<
			Partial<typeof users.$inferInsert>,
			"atprotoDid" | "atprotoHandle" | "atprotoPdsUrl"
		>;
	} = {},
): Promise<FixtureAccount> {
	const email =
		opts.email ?? `${username ?? `unclaimed_${crypto.randomUUID().slice(0, 8)}`}@example.com`;
	// Checked at run time as well as in the type, because a suite's `values` of the wider insert type
	// passes the type check and would put a placeholder DID straight back over the real one.
	for (const column of ["atprotoDid", "atprotoHandle", "atprotoPdsUrl"] as const) {
		if (opts.fields && column in opts.fields) {
			throw new Error(
				`a fixture account's ${column} is issued by the server; use the one it returns`,
			);
		}
	}

	const created = await onSessionNetwork(async () => {
		const pendingToken =
			opts.identity === "brought"
				? await startPendingSignup({ email, identity: await createBroughtIdentity() })
				: await startPendingSignup({ email, hostedHandle: fixtureHandleName() });
		const pending = await readPendingSignup(pendingToken);
		if (!pending) throw new Error(`the pending signup for ${email} vanished before it was used`);
		return createAccountFromSignup(pending, email);
	});
	if ("refusal" in created) {
		throw new Error(
			`fixture account ${email} was refused: ${created.refusal.message} (${created.refusal.reason}). ` +
				"Is this run inside a session with its own network? See scripts/session-preload.ts.",
		);
	}

	const passwordHash = await fixturePasswordHash(opts.password ?? FIXTURE_PASSWORD);
	const [user] = await db
		.update(users)
		.set({
			...opts.fields,
			username,
			passwordHash,
			emailVerified: opts.emailVerified ?? false,
		})
		.where(eq(users.id, created.user.id))
		.returning();
	const token = await createSession(user.id);
	return {
		cookie: `session=${token}`,
		token,
		userId: user.id,
		username,
		email,
		did: user.atprotoDid,
		handle: user.atprotoHandle ?? "",
		user,
	};
}
