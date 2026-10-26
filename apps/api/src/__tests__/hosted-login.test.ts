// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in with the password an identity's holder chose.
 *
 * 🚨 **This is the first-party door, and the subject is the session it leaves behind.** The
 * password goes to the node in one request and is not written down; what the row keeps is the
 * session that answered, which is what every writer uses afterwards. A test that only checked
 * `status: "ok"` would pass with the password stored, so the row is asserted directly.
 *
 * ⚠️ **The happy path uses the session's own server**, not a stub: the account was created there
 * by the fixture with a known password, and the real `createSession` is the thing under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { loginHostedAccount } from "../services/hosted-login.js";
import { open } from "../services/secret-box.js";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `li${Date.now().toString(36)}`;
const PASSWORD = "a longer chosen password";
const TOUCHED = ["FRONTEND_URL", "HOSTED_PDS_URL"] as const;
const saved = new Map<string, string | undefined>();
const dids: string[] = [];

beforeAll(() => {
	for (const key of TOUCHED) saved.set(key, process.env[key]);
});

afterAll(async () => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (dids.length) await db.delete(hostedAccounts).where(inArray(hostedAccounts.did, dids));
});

async function hosted(tag: string): Promise<FixtureAccount> {
	const account = await createAccount(`${RUN}${tag}`, {
		email: `${RUN}${tag}@example.test`,
		password: PASSWORD,
	});
	dids.push(account.did);
	return account;
}

/** A node that answers only the session call, and records what it was sent. */
function fakeNode(answer: { status?: number; body?: unknown }) {
	const calls: Record<string, unknown>[] = [];
	const impl = (async (_input: string | URL, init?: RequestInit) => {
		calls.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
		const { status = 200, body = {} } = answer;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("the account's own password", () => {
	it("opens a session, keeps it on the row, and never keeps the password", async () => {
		const account = await hosted("ok");

		const result = await loginHostedAccount(account.handle, PASSWORD);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.user.id).toBe(account.userId);

		const [row] = await db
			.select({
				sealedPassword: hostedAccounts.sealedPassword,
				sealedSession: hostedAccounts.sealedSession,
			})
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));
		expect(row?.sealedPassword).toBe("");
		const session = JSON.parse(open(row?.sealedSession ?? "")) as { accessJwt: string };
		expect(session.accessJwt).toBeTruthy();
	});

	it("answers a wrong password as the credentials, not as an outage", async () => {
		const account = await hosted("wrong");
		const result = await loginHostedAccount(account.handle, "not the password");
		expect(result).toMatchObject({ status: "refused", reason: "credentials" });
	});

	it("answers an unknown identifier the same way, so the form is not a directory", async () => {
		const result = await loginHostedAccount(`${RUN}nobody.example.test`, PASSWORD);
		expect(result).toMatchObject({ status: "refused", reason: "credentials" });
	});

	it("refuses a suspended Anthers account without touching its session", async () => {
		const account = await hosted("suspended");
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, account.userId));
		const before = await db
			.select({ sealedSession: hostedAccounts.sealedSession })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));

		const result = await loginHostedAccount(account.handle, PASSWORD);
		expect(result).toMatchObject({ status: "refused", reason: "suspended" });

		const after = await db
			.select({ sealedSession: hostedAccounts.sealedSession })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));
		expect(after[0]?.sealedSession).toBe(before[0]?.sealedSession ?? null);
	});

	it("puts the session's email code behind a second attempt when the node asks", async () => {
		const node = fakeNode({
			status: 401,
			body: { error: "AuthFactorTokenRequired" },
		});
		process.env.HOSTED_PDS_URL = "https://node.invalid";

		const result = await loginHostedAccount(`${RUN}factor`, PASSWORD, {
			fetchImpl: node.impl,
		});
		expect(result).toEqual({ status: "two-factor" });
	});

	it("refuses when the identity is on the node but holds no Anthers account", async () => {
		process.env.HOSTED_PDS_URL = "https://node.invalid";
		const node = fakeNode({
			body: {
				did: "did:plc:noanthers",
				handle: "stranger.invalid",
				accessJwt: "EXAMPLE-access-token",
				refreshJwt: "EXAMPLE-refresh-token",
			},
		});

		const result = await loginHostedAccount("stranger.invalid", PASSWORD, {
			fetchImpl: node.impl,
		});
		expect(result).toMatchObject({ status: "refused", reason: "no_account" });
	});

	it("reports a node that will not answer as worth retrying", async () => {
		const node = fakeNode({ status: 503, body: { error: "ServiceUnavailable" } });
		const result = await loginHostedAccount(`${RUN}down`, PASSWORD, { fetchImpl: node.impl });
		expect(result).toMatchObject({ status: "refused", reason: "unreachable" });
	});
});
