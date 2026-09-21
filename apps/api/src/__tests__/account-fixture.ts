// SPDX-License-Identifier: Apache-2.0
/**
 * A signed-in fixture account, created the way signup creates one and holding a real identity on
 * the test session's own AT Protocol network.
 *
 * 🚨 **The account comes from `createLocalAccount`, which calls `createAccountFromSignup` — the one
 * place an account row is written** — so a fixture has the shape a real account has: an identity issued by the hosting server, its
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
 * suite asks otherwise, because the suites built on this assert the unverified walls; and no
 * welcome email is sent. A suite testing either drives the ceremony routes themselves.
 *
 * The session the fixture hands back is minted directly (`createSession`), not signed in — a
 * password does not exist to exercise, and the emailed-code path has its own suites.
 */

import type { users } from "@anthers/db/schema";
import {
	createBroughtIdentity,
	createLocalAccount,
	type LocalAccountFields,
} from "../scripts/local-accounts";
import type { AtprotoIdentity } from "../services/atproto";
import { createSession } from "../services/auth";

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

export interface FixtureAccount {
	/** `session=<token>`, ready for a `Cookie` header. */
	cookie: string;
	/** The session token alone, for a suite that sends it as a bearer token. */
	token: string;
	userId: number;
	email: string;
	/** The identity the hosting server issued, and the handle it issued it under. */
	did: string;
	handle: string;
	/** The short name the suite asked for — the account's handle is `<name>.<hosted suffix>`. */
	name: string;
	/** The whole row as the fixture left it, for a suite that needs more than the above. */
	user: typeof users.$inferSelect;
}

/**
 * A brought identity on the session's server and no account for it — what a suite driving the
 * Bluesky door binds to a pending signup, the way the OAuth callback would.
 */
export function broughtIdentity(): Promise<AtprotoIdentity> {
	return onSessionNetwork(() => createBroughtIdentity());
}

/**
 * Create an account with a live session.
 *
 * `name` is the handle name to ask the session's server for — the account's handle comes back
 * as `<name>.<hosted suffix>` (or a fallback when the name is refused; see `localHandleName`).
 * There is no username, and no usernameless account: every account's identity names it.
 *
 * The email defaults to `<name>@example.com`, which is what the suites used when they
 * signed up through HTTP, so a suite that already deletes by that address keeps working.
 */
export async function createAccount(
	name: string,
	opts: {
		email?: string;
		emailVerified?: boolean;
		/** `hosted` (the default) is an identity Anthers issued; `brought` is one it holds no credential for. */
		identity?: "hosted" | "brought";
		/**
		 * Anything else the suite needs on the row — `isCreator`, an admin flag, a date. The identity
		 * columns are the server's to set, so a suite cannot quietly put a placeholder DID back.
		 */
		fields?: LocalAccountFields;
	} = {},
): Promise<FixtureAccount> {
	const email = opts.email ?? `${name}@example.com`;
	const user = await onSessionNetwork(() =>
		createLocalAccount({
			email,
			handleName: name,
			identity: opts.identity,
			emailVerified: opts.emailVerified ?? false,
			fields: opts.fields,
		}),
	);
	const token = await createSession(user.id);
	return {
		cookie: `session=${token}`,
		token,
		userId: user.id,
		email,
		did: user.atprotoDid,
		handle: user.atprotoHandle,
		name,
		user,
	};
}
