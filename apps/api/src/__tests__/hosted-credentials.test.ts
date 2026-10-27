// SPDX-License-Identifier: Apache-2.0
/**
 * Retiring the sealed password column, one row at a time.
 *
 * 🚨 **The property is the ORDER, not the count.** Dropping a password is only safe once a session
 * is on file; the reverse leaves an identity whose only remaining way in is the node's admin
 * password, which is the state the runbook calls out and does not want repeated on purpose. A
 * conversion that dropped first and opened second would pass a "converted" assertion and strand
 * anybody whose node refused.
 *
 * ⚠️ **Every case here is a real `hosted_accounts` row**, because the function's whole job is the
 * column: a stub that answered with objects would not be testing the thing that changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { convertSealedPasswords, sealedPasswordRows } from "../services/hosted-credentials.js";
import { seal } from "../services/secret-box.js";
import { learnHandleDomain } from "./node-fixture.js";

const PDS_URL = "https://credentials.test";
const RUN = `hc${Date.now().toString(36)}`;

// 🚨 Restored afterwards, because `bun test` runs every file in one process. Nothing here reaches
// the network: every node conversation goes through an injected `fetchImpl`.
const before = {
	url: process.env.HOSTED_PDS_URL,
	key: process.env.HOSTED_ACCOUNT_KEY,
};

beforeAll(async () => {
	await learnHandleDomain(PDS_URL, "credentials.test");
	process.env.HOSTED_PDS_URL = PDS_URL;
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

const dids: string[] = [];

afterAll(async () => {
	if (dids.length) await db.delete(hostedAccounts).where(inArray(hostedAccounts.did, dids));
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_ACCOUNT_KEY", before.key);
});

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** A row holding a sealed password and no session, which is what every legacy row looks like. */
async function legacyRow(tag: string, sealedPassword = seal("a chosen password")): Promise<string> {
	const did = `did:plc:${RUN}${tag}`;
	dids.push(did);
	await db
		.insert(hostedAccounts)
		.values({ did, handle: `${RUN}${tag}.credentials.test`, sealedPassword, sealedSession: null })
		.onConflictDoUpdate({
			target: hostedAccounts.did,
			set: { sealedPassword, sealedSession: null },
		});
	return did;
}

/**
 * A node that answers a login with a session, and records that it was asked.
 *
 * `only` names the DIDs it will answer for; every other row in the database gets an outage. A
 * convert run walks the whole column, so without this the test would be reaching into rows other
 * files own and quietly rewriting their fixtures.
 */
function loginNode(answer: { status?: number; body?: unknown } = {}, only: string[] = []) {
	const calls: string[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		calls.push(new URL(String(input)).pathname.replace("/xrpc/", ""));
		const sent = init?.body ? (JSON.parse(String(init.body)) as { identifier?: string }) : {};
		if (only.length > 0 && !only.includes(sent.identifier ?? "")) {
			return {
				ok: false,
				status: 503,
				json: async () => ({ error: "ServiceUnavailable" }),
			} as unknown as Response;
		}
		const { status = 200, body = { accessJwt: "EXAMPLE-access", refreshJwt: "EXAMPLE-refresh" } } =
			answer;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

async function passwordOn(did: string): Promise<string | null> {
	const [row] = await db
		.select({ sealedPassword: hostedAccounts.sealedPassword })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did));
	return row?.sealedPassword ?? null;
}

describe("retiring the sealed password", () => {
	it("reports a row that holds one, and one whose value this key cannot open", async () => {
		const openableDid = await legacyRow("rep");
		const sealedElsewhere = await legacyRow(
			"repblind",
			"v1.YWFhYWFhYWFhYWFh.YmJiYmJiYmJiYmJiYmJiYg.Y2Nj",
		);

		const rows = await sealedPasswordRows();
		const mine = rows.filter((r) => r.did === openableDid || r.did === sealedElsewhere);
		expect(mine.find((r) => r.did === openableDid)?.openable).toBe(true);
		expect(mine.find((r) => r.did === sealedElsewhere)?.openable).toBe(false);
		expect(mine.every((r) => r.hasSession === false)).toBe(true);
	});

	it("drops the password only once the session it opened is on file", async () => {
		const did = await legacyRow("convert");
		const node = loginNode({}, [did]);

		const outcomes = await convertSealedPasswords({ fetchImpl: node.impl });
		const mine = outcomes.find((o) => o.did === did);
		expect(mine?.converted).toBe(true);
		expect(await passwordOn(did)).toBe("");

		const [row] = await db
			.select({ sealedSession: hostedAccounts.sealedSession })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, did));
		expect(row?.sealedSession, "the session is what replaced the password").toBeTruthy();
	});

	// 🚨 The safety property. A node that refuses the login leaves the row exactly as it was,
	// because that password is still the only way into the identity behind it.
	it("keeps the password when the node refuses the login, and says why", async () => {
		const did = await legacyRow("refused");
		const node = loginNode({ status: 401, body: { error: "AuthenticationRequired" } }, [did]);

		const outcomes = await convertSealedPasswords({ fetchImpl: node.impl });
		const mine = outcomes.find((o) => o.did === did);
		expect(mine?.converted).toBe(false);
		expect(mine?.refused).toBeTruthy();
		expect(await passwordOn(did)).not.toBe("");
	});

	it("writes nothing at all in a dry run", async () => {
		const did = await legacyRow("dry");
		const node = loginNode({}, [did]);

		const outcomes = await convertSealedPasswords({ dryRun: true, fetchImpl: node.impl });
		expect(outcomes.find((o) => o.did === did)?.converted).toBe(false);
		expect(await passwordOn(did)).not.toBe("");
		expect(node.calls).toHaveLength(0);
	});
});
