// SPDX-License-Identifier: Apache-2.0
/**
 * Make an account on a local session the way signup makes one: through `createAccountFromSignup`,
 * holding a real identity on the session's own AT Protocol network.
 *
 * 🚨 **The one helper every seed, fixture and browser spec makes its accounts with.** A row written
 * by hand with a made-up DID is an account nothing can resolve or write a record into, so every
 * path that does either went untested wherever one was used. The test fixture
 * (`__tests__/account-fixture.ts`) wraps this; the seeds `make dev` runs call it directly.
 *
 *   bun run db:local-account --username e2e_reader --email e2e_reader@example.com --session
 *
 * The command line prints the account as JSON, for a browser spec that cannot import the API.
 *
 * ⚠️ **It needs a session's network** — `HOSTED_PDS_URL`, `HOSTED_PDS_INVITE_CODE` and
 * `ATPROTO_PLC_URL` naming the session's own server — and the write guard refuses anything that is
 * not local, so nothing here can create an identity on the real network.
 */

import { db } from "@anthers/db/client";
import { assertDevCheckout } from "@anthers/db/dev-only";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type { AtprotoIdentity } from "../services/atproto.js";
import { createSession } from "../services/auth.js";
import { handleNameProblem, hostedHandleSuffix } from "../services/hosted-accounts.js";
import {
	createAccountFromSignup,
	readPendingSignup,
	startPendingSignup,
} from "../services/pending-signups.js";

type UserRow = typeof users.$inferSelect;

/** Anything on the row besides the identity, which is the server's to issue. */
export type LocalAccountFields = Omit<
	Partial<typeof users.$inferInsert>,
	"atprotoDid" | "atprotoHandle" | "atprotoPdsUrl"
>;

export interface LocalAccountOptions {
	/** Null for an account that has not claimed a username yet, as the ceremony leaves one. */
	username: string | null;
	email: string;
	/** `hosted` (the default) is an identity Anthers issued; `brought` is one it holds no credential for. */
	identity?: "hosted" | "brought";
	/** The handle name to ask for. A name the server would refuse falls back to a generated one. */
	handleName?: string;
	/** Already hashed, so a caller making many accounts with one password hashes it once. */
	passwordHash?: string;
	emailVerified?: boolean;
	fields?: LocalAccountFields;
}

/** A handle name nobody else in the session holds. */
function generatedHandleName(): string {
	return `fx${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * The handle name to ask for: the preferred one when the server would issue it, otherwise that
 * name with `-dev` on the end, otherwise a generated one. An Anthers username may carry an
 * underscore, and a few are reserved outright — `parkerhdavis` among them.
 */
export function localHandleName(preferred?: string): string {
	if (!preferred) return generatedHandleName();
	const name = preferred
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	for (const candidate of [name, `${name}-dev`]) {
		if (candidate && !handleNameProblem(candidate)) return candidate;
	}
	return generatedHandleName();
}

/**
 * An identity created straight on the session's server, the way somebody arrives already holding one.
 *
 * ⚠️ **It lives on the same server Anthers hosts on**, because a session has one server. What makes
 * it "brought" is that Anthers holds no credential for it, so the hub reaches it only through a
 * grant, exactly as it reaches an identity on `bsky.social`. The address the server keeps is a
 * throwaway of its own, so a later hosted account for the same person is not refused for reusing it.
 */
export async function createBroughtIdentity(handleName?: string): Promise<AtprotoIdentity> {
	const url = process.env.HOSTED_PDS_URL ?? "";
	const handle = `${handleName ?? generatedHandleName()}.${await hostedHandleSuffix()}`;
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
	const body = (await res.json().catch(() => ({}))) as {
		did?: string;
		handle?: string;
		message?: string;
	};
	if (!res.ok || !body.did || !body.handle) {
		throw new Error(
			`the session's server would not create a brought identity: ${body.message ?? res.status}`,
		);
	}
	return { did: body.did, handle: body.handle, pdsUrl: url };
}

/** Create the account, its identity on the session's network, and the row as the caller asked. */
export async function createLocalAccount(opts: LocalAccountOptions): Promise<UserRow> {
	// Checked at run time as well as in the type, because a caller's values of the wider insert type
	// pass the type check and would put a placeholder DID straight back over the real one.
	for (const column of ["atprotoDid", "atprotoHandle", "atprotoPdsUrl"] as const) {
		if (opts.fields && column in opts.fields) {
			throw new Error(`an account's ${column} is issued by the server; use the one it returns`);
		}
	}

	const handleName = localHandleName(opts.handleName);
	const pendingToken =
		opts.identity === "brought"
			? await startPendingSignup({
					email: opts.email,
					identity: await createBroughtIdentity(handleName),
				})
			: await startPendingSignup({ email: opts.email, hostedHandle: handleName });
	const pending = await readPendingSignup(pendingToken);
	if (!pending) throw new Error(`the pending signup for ${opts.email} vanished before it was used`);

	const created = await createAccountFromSignup(pending, opts.email);
	if ("refusal" in created) {
		throw new Error(
			`the account for ${opts.email} was refused: ${created.refusal.message} (${created.refusal.reason}). ` +
				"Is this running inside a session with its own network? See scripts/session.ts.",
		);
	}

	const [user] = await db
		.update(users)
		.set({
			...opts.fields,
			username: opts.username,
			...(opts.passwordHash !== undefined ? { passwordHash: opts.passwordHash } : {}),
			emailVerified: opts.emailVerified ?? true,
		})
		.where(eq(users.id, created.user.id))
		.returning();
	return user;
}

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	assertDevCheckout();
	const username = flag("username");
	if (!username)
		throw new Error(
			"usage: bun run db:local-account --username <name> [--email <address>] [--creator] [--session]",
		);
	const user = await createLocalAccount({
		username,
		email: flag("email") ?? `${username}@example.com`,
		handleName: username,
		fields: {
			isCreator: process.argv.includes("--creator"),
		},
	});
	const session = process.argv.includes("--session") ? await createSession(user.id) : undefined;
	console.log(
		JSON.stringify({
			userId: user.id,
			username: user.username,
			did: user.atprotoDid,
			handle: user.atprotoHandle,
			...(session ? { session } : {}),
		}),
	);
}

if (import.meta.main) {
	main().then(
		() => process.exit(0),
		(err) => {
			console.error(`[local-account] ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		},
	);
}
