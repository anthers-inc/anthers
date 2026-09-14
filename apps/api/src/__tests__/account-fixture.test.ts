// SPDX-License-Identifier: Apache-2.0
/**
 * The fixture every suite builds its accounts on, held to what it promises.
 *
 * 🚨 **Every other suite passes whether or not a fixture account is a real identity**, because most
 * of them never ask the network about it. So this is the one place that asks: the directory knows
 * the DID, the server holds the repository, and the sealed credential opens a session on it — the
 * three things a placeholder DID could never do.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { hostedAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { open } from "../services/secret-box.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `af${Date.now().toString(36)}`;
const SERVER = process.env.HOSTED_PDS_URL ?? "";
const DIRECTORY = process.env.ATPROTO_PLC_URL ?? "";
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

async function describeRepo(did: string): Promise<{ handle?: string } | null> {
	const res = await realFetch(`${SERVER}/xrpc/com.atproto.repo.describeRepo?repo=${did}`);
	return res.ok ? ((await res.json()) as { handle?: string }) : null;
}

describe("a hosted fixture account", () => {
	it("is an identity the session's directory and server both know", async () => {
		const account = await createAccount(`${RUN}hosted`);
		expect(account.did).toStartWith("did:plc:");

		const doc = await realFetch(`${DIRECTORY}/${account.did}`);
		expect(doc.status).toBe(200);
		expect((await describeRepo(account.did))?.handle).toBe(account.handle);
		expect(account.user.atprotoPdsUrl).toBe(SERVER);
	});

	it("keeps a credential that really opens a session on the server", async () => {
		const account = await createAccount(`${RUN}opens`);
		const [row] = await db
			.select({ sealed: hostedAccounts.sealedPassword })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));
		expect(row).toBeDefined();

		const session = await realFetch(`${SERVER}/xrpc/com.atproto.server.createSession`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: account.did, password: open(row.sealed) }),
		});
		expect(session.status).toBe(200);
	});
});

describe("a brought fixture account", () => {
	it("is a real identity that Anthers holds no credential for", async () => {
		const account = await createAccount(`${RUN}brought`, { identity: "brought" });
		expect(await describeRepo(account.did)).not.toBeNull();

		const rows = await db
			.select({ did: hostedAccounts.did })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, account.did));
		expect(rows).toEqual([]);
	});
});

describe("what a suite cannot do to it", () => {
	// 🚨 A suite testing an unreachable node sets these before it makes its accounts, and an
	// account made under them would fail for the reason that suite is testing.
	it("creates the identity on the session's server whatever the suite has stubbed, then puts the stubs back", async () => {
		const stub = (async () => {
			throw new Error("the suite's stub was reached");
		}) as unknown as typeof fetch;
		globalThis.fetch = stub;
		const before = process.env.HOSTED_PDS_URL;
		process.env.HOSTED_PDS_URL = "https://node.invalid";
		try {
			const account = await createAccount(`${RUN}stubbed`);
			expect(await describeRepo(account.did)).not.toBeNull();
			expect(globalThis.fetch).toBe(stub);
			expect(process.env.HOSTED_PDS_URL).toBe("https://node.invalid");
		} finally {
			process.env.HOSTED_PDS_URL = before;
		}
	});

	it("refuses to put a placeholder DID over the one the server issued", async () => {
		const values: Record<string, unknown> = { isCreator: true, atprotoDid: "did:plc:placeholder" };
		await expect(
			createAccount(`${RUN}override`, { fields: values as { isCreator: boolean } }),
		).rejects.toThrow(/issued by the server/);
	});
});
