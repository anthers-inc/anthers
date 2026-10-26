// SPDX-License-Identifier: Apache-2.0
/**
 * The reset door that gives an account holder the password the hub used to keep for them.
 *
 * 🚨 **The subject is what the row holds afterwards.** The node's reset sets the person's
 * password; the hub keeps the session it opens with it and never the password itself. A test that
 * only asserted "set: true" would pass with the password written down, which is the thing this
 * whole change removes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { requestHostedPasswordReset, setHostedPassword } from "../services/hosted-password.js";
import { open } from "../services/secret-box.js";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `pw${Date.now().toString(36)}`;
const PDS_URL = "https://node.invalid";
const TOUCHED = ["FRONTEND_URL", "HOSTED_PDS_URL"] as const;
const saved = new Map<string, string | undefined>();
/** The identities this suite made, so their `hosted_accounts` rows go with the accounts. */
const dids: string[] = [];

beforeAll(() => {
	for (const key of TOUCHED) saved.set(key, process.env[key]);
	// `node.invalid` is what the write guard treats as local, so the service may talk to it; every
	// call is answered by the injected fetch and nothing leaves the box.
	delete process.env.FRONTEND_URL;
	process.env.HOSTED_PDS_URL = PDS_URL;
});

afterAll(async () => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	// `purgeAccountsCreatedHere` removes the users; `hosted_accounts.user_id` is `set null`, so the
	// credential rows would stay behind. Keyed on the DID because that is what the row is about.
	if (dids.length) await db.delete(hostedAccounts).where(inArray(hostedAccounts.did, dids));
});

type Route = (body: Record<string, unknown>) => { status?: number; body?: unknown };

/** A node that answers the three methods this door touches, and fails loudly on anything else. */
function nodeFetch(routes: Record<string, Route>) {
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const method = new URL(String(input)).pathname.replace("/xrpc/", "");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, body });
		const route = routes[method];
		if (!route) throw new Error(`unexpected call to ${method}`);
		const { status = 200, body: answer = {} } = route(body);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => answer,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

async function hosted(tag: string): Promise<FixtureAccount> {
	const account = await createAccount(`${RUN}${tag}`, { email: `${RUN}${tag}@example.test` });
	dids.push(account.did);
	return account;
}

/** The row as the door left it. */
async function credentialOf(did: string) {
	const [row] = await db
		.select({
			sealedPassword: hostedAccounts.sealedPassword,
			sealedSession: hostedAccounts.sealedSession,
		})
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did));
	return row;
}

describe("asking for the reset code", () => {
	it("mails the address the account holds, and says only that it asked", async () => {
		const account = await hosted("ask");
		const node = nodeFetch({
			"com.atproto.server.requestPasswordReset": () => ({ body: {} }),
		});

		const result = await requestHostedPasswordReset(account.userId, { fetchImpl: node.impl });
		expect(result).toEqual({ status: "sent" });
		expect(node.calls).toHaveLength(1);
		expect(node.calls[0].body.email).toBe(account.email);
	});

	it("refuses an identity Anthers does not host, without calling anything", async () => {
		const account = await createAccount(`${RUN}brought`, {
			email: `${RUN}brought@example.test`,
			identity: "brought",
		});
		dids.push(account.did);
		const node = nodeFetch({});

		const result = await requestHostedPasswordReset(account.userId, { fetchImpl: node.impl });
		expect(result).toMatchObject({ status: "refused", fault: "account" });
		expect(node.calls).toHaveLength(0);
	});

	it("reports a node that will not answer as worth retrying", async () => {
		const account = await hosted("down");
		const node = nodeFetch({
			"com.atproto.server.requestPasswordReset": () => ({
				status: 503,
				body: { error: "ServiceUnavailable" },
			}),
		});

		const result = await requestHostedPasswordReset(account.userId, { fetchImpl: node.impl });
		expect(result).toMatchObject({ status: "refused", fault: "operational" });
	});
});

describe("setting the password", () => {
	it("refuses a password the rule rejects before the node sees it", async () => {
		const account = await hosted("short");
		const node = nodeFetch({});

		const result = await setHostedPassword(
			account.userId,
			{ token: "CODE", password: "short" },
			{ fetchImpl: node.impl },
		);
		expect(result).toMatchObject({ status: "refused", fault: "password" });
		expect(node.calls).toHaveLength(0);
	});

	it("spends the token, then keeps the session the new password opens — never the password", async () => {
		const account = await hosted("set");
		const node = nodeFetch({
			"com.atproto.server.resetPassword": () => ({ body: {} }),
			"com.atproto.server.createSession": () => ({
				body: { accessJwt: "EXAMPLE-access-token", refreshJwt: "EXAMPLE-refresh-token" },
			}),
		});
		const chosen = "a longer chosen password";

		const result = await setHostedPassword(
			account.userId,
			{ token: "CODE", password: chosen },
			{ fetchImpl: node.impl },
		);
		expect(result).toEqual({ status: "set", sessionOpened: true });

		expect(node.calls.map((c) => c.method)).toEqual([
			"com.atproto.server.resetPassword",
			"com.atproto.server.createSession",
		]);
		expect(node.calls[0].body).toEqual({ token: "CODE", password: chosen });
		expect(node.calls[1].body).toEqual({ identifier: account.did, password: chosen });

		const row = await credentialOf(account.did);
		expect(row?.sealedPassword).toBe("");
		const session = JSON.parse(open(row?.sealedSession ?? "")) as { accessJwt: string };
		expect(session.accessJwt).toBe("EXAMPLE-access-token");
	});

	it("reports a spent code as the person's to fix, and changes nothing", async () => {
		const account = await hosted("expired");
		const before = await credentialOf(account.did);
		const node = nodeFetch({
			"com.atproto.server.resetPassword": () => ({
				status: 400,
				body: { error: "ExpiredToken" },
			}),
		});

		const result = await setHostedPassword(
			account.userId,
			{ token: "STALE", password: "a longer chosen password" },
			{ fetchImpl: node.impl },
		);
		expect(result).toMatchObject({ status: "refused", fault: "token" });
		expect(node.calls).toHaveLength(1);
		expect(await credentialOf(account.did)).toEqual(before);
	});

	it("still reports the password set when the hub's own session cannot be opened", async () => {
		const account = await hosted("nosession");
		const node = nodeFetch({
			"com.atproto.server.resetPassword": () => ({ body: {} }),
			"com.atproto.server.createSession": () => ({
				status: 400,
				body: { error: "InvalidRequest", message: "refused" },
			}),
		});

		const result = await setHostedPassword(
			account.userId,
			{ token: "CODE", password: "a longer chosen password" },
			{ fetchImpl: node.impl },
		);
		expect(result).toEqual({ status: "set", sessionOpened: false });

		// The old refresh pair died with the reset, so an empty row is the honest state: the next
		// write says authorization was lost rather than retrying a dead token.
		const row = await credentialOf(account.did);
		expect(row?.sealedPassword).toBe("");
		expect(row?.sealedSession).toBeNull();
	});
});
