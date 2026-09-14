// SPDX-License-Identifier: Apache-2.0
/**
 * Nothing that is not a public deployment may write to the real AT Protocol network.
 *
 * 🛑 **An identity registered with the real directory is permanent and a record is public the
 * moment it lands**, so a developer's machine or a test run that reaches the real network does
 * something nobody can take back. `lib/atproto-network.ts` refuses it at the two places a write
 * leaves the hub — the identity server Anthers hosts, and the server an OAuth grant points at —
 * and this file proves both doors stay shut.
 *
 * ⚠️ **Every refusal below has a control beside it that reaches the same fake network.** A guard
 * test that asserts "nothing was called" passes just as happily when the code under test never
 * got as far as calling anything, so each one is paired with the same call against an allowed
 * destination, which must arrive. And each allowed destination is checked from a public
 * deployment as well, so the refusal is shown to be about where the process runs and not about
 * the URL alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, hostedAccounts, users } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
	atprotoWriteRefusal,
	isOffNetworkUrl,
	PRODUCTION_PLC_DIRECTORY,
	plcDirectoryUrl,
} from "../lib/atproto-network.js";
import {
	CREATOR_SCOPE_EXPANDED,
	setAtprotoClient,
	USER_SCOPE_EXPANDED,
} from "../services/atproto-client.js";
import { WORK_COLLECTION } from "../services/atproto-repo.js";
import {
	createHostedAccount,
	HostedAccountError,
	hostedIdentityOffered,
	nodeCall,
} from "../services/hosted-accounts.js";
import { writerForAccount } from "../services/repo-writer.js";
import { seal } from "../services/secret-box.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { learnHandleDomain } from "./node-fixture";

purgeAccountsCreatedHere();

const RUN = `ng${Date.now().toString(36)}`;

/** A developer's machine, as `make dev` configures one. */
const LOCAL = { FRONTEND_URL: "http://localhost:3000" };
/** Production, as the live spec configures it. */
const PUBLIC = { FRONTEND_URL: "https://anthers.org" };

const TOUCHED = [
	"BASE_URL",
	"FRONTEND_URL",
	"HOSTED_PDS_URL",
	"HOSTED_PDS_INVITE_CODE",
	"HOSTED_ACCOUNT_KEY",
	"ATPROTO_PLC_URL",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of TOUCHED) saved.set(key, process.env[key]);
	delete process.env.BASE_URL;
	process.env.HOSTED_PDS_INVITE_CODE = "EXAMPLE-not-a-real-invite";
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterEach(() => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function runAs(env: { FRONTEND_URL: string }): void {
	process.env.FRONTEND_URL = env.FRONTEND_URL;
}

/** A fetch that answers nothing useful and remembers every address it was asked for. */
function spyFetch(): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const impl = async (input: RequestInfo | URL) => {
		calls.push(String(input instanceof Request ? input.url : input));
		return new Response(JSON.stringify({ error: "InternalServerError" }), { status: 500 });
	};
	return { fetch: impl as typeof fetch, calls };
}

describe("which hosts can never be on the real network", () => {
	it("accepts loopback and the special-use names", () => {
		for (const url of [
			"http://localhost:2583",
			"http://127.0.0.1:2582",
			"http://[::1]:2583",
			"https://node.invalid",
			"https://pds.example",
			"http://alice.test",
			"http://pds.localhost:2583",
		]) {
			expect({ url, off: isOffNetworkUrl(url) }).toEqual({ url, off: true });
		}
	});

	it("refuses every public name, including ones dressed up to look local", () => {
		for (const url of [
			"https://anthers.social",
			"https://bsky.social",
			"https://morel.us-east.host.bsky.network",
			PRODUCTION_PLC_DIRECTORY,
			"https://localhost.attacker.com",
			"https://127.0.0.1.nip.io",
			"https://test.com",
			"https://example.com/.test",
			"not a url",
			"",
		]) {
			expect({ url, off: isOffNetworkUrl(url) }).toEqual({ url, off: false });
		}
	});
});

describe("when a write is refused", () => {
	it("refuses a real server off a public deployment", () => {
		expect(atprotoWriteRefusal("https://anthers.social", LOCAL)).toContain(
			"https://anthers.social",
		);
		// No origin configured at all is the direction a lost variable fails in.
		expect(atprotoWriteRefusal("https://anthers.social", {})).not.toBeNull();
	});

	it("allows a local server anywhere, and a real one only from a public deployment", () => {
		expect(atprotoWriteRefusal("http://localhost:2583", LOCAL)).toBeNull();
		expect(atprotoWriteRefusal("https://anthers.social", PUBLIC)).toBeNull();
	});

	it("resolves identities in the production directory unless told otherwise", () => {
		expect(plcDirectoryUrl({})).toBe(PRODUCTION_PLC_DIRECTORY);
		expect(plcDirectoryUrl({ ATPROTO_PLC_URL: "http://localhost:2582/" })).toBe(
			"http://localhost:2582",
		);
	});
});

describe("the identity server Anthers hosts", () => {
	beforeAll(() => learnHandleDomain("https://node.invalid", "node.invalid"));

	it("creates no account on a real server from a developer's machine", async () => {
		runAs(LOCAL);
		process.env.HOSTED_PDS_URL = "https://anthers.social";
		const spy = spyFetch();

		expect(await hostedIdentityOffered()).toBe(false);
		const attempt = createHostedAccount(
			{ handleName: `${RUN}a`, email: `${RUN}a@example.test` },
			{ fetchImpl: spy.fetch },
		);
		await expect(attempt).rejects.toBeInstanceOf(HostedAccountError);
		const call = await nodeCall(
			"/xrpc/com.atproto.repo.createRecord",
			{ method: "POST", body: "{}" },
			spy.fetch,
		);
		expect(call).toMatchObject({ ok: false, retryable: false, error: "NoNode" });
		expect(spy.calls).toEqual([]);
	});

	it("does reach a local server, so the refusal above is not a door that never opens", async () => {
		runAs(LOCAL);
		process.env.HOSTED_PDS_URL = "https://node.invalid";
		const spy = spyFetch();

		expect(await hostedIdentityOffered()).toBe(true);
		await expect(
			createHostedAccount(
				{ handleName: `${RUN}b`, email: `${RUN}b@example.test` },
				{ fetchImpl: spy.fetch },
			),
		).rejects.toBeInstanceOf(HostedAccountError);
		expect(spy.calls).toEqual(["https://node.invalid/xrpc/com.atproto.server.createAccount"]);
	});

	it("reaches the real server from a public deployment", async () => {
		runAs(PUBLIC);
		process.env.HOSTED_PDS_URL = "https://anthers.social";
		const spy = spyFetch();

		await nodeCall("/xrpc/_health", { method: "GET" }, spy.fetch);
		expect(spy.calls).toEqual(["https://anthers.social/xrpc/_health"]);
	});

	describe("writing a record into a hosted repository", () => {
		const dids: string[] = [];

		afterAll(async () => {
			if (dids.length) await db.delete(hostedAccounts).where(inArray(hostedAccounts.did, dids));
		});

		async function hostedCreator(tag: string): Promise<number> {
			const account = await createAccount(`${RUN}${tag}`);
			const [user] = await db
				.select({ did: users.atprotoDid })
				.from(users)
				.where(eq(users.id, account.userId));
			dids.push(user.did);
			await db.insert(hostedAccounts).values({
				did: user.did,
				userId: account.userId,
				handle: `${RUN}${tag}.anthers.social`,
				sealedPassword: seal("EXAMPLE-not-a-real-password"),
			});
			return account.userId;
		}

		it("opens no writer onto a real server from a developer's machine", async () => {
			runAs(LOCAL);
			process.env.HOSTED_PDS_URL = "https://anthers.social";
			const userId = await hostedCreator("hw");
			const spy = spyFetch();

			const opened = await writerForAccount(userId, {
				collections: [WORK_COLLECTION],
				fetchImpl: spy.fetch,
			});
			expect(opened).toEqual({ writer: null, reason: "no_node" });
			expect(spy.calls).toEqual([]);
		});

		it("asks a local server for a session, so the refusal above is about the server", async () => {
			runAs(LOCAL);
			process.env.HOSTED_PDS_URL = "https://node.invalid";
			const userId = await hostedCreator("hl");
			const spy = spyFetch();

			const opened = await writerForAccount(userId, {
				collections: [WORK_COLLECTION],
				fetchImpl: spy.fetch,
			});
			expect(opened).toEqual({ writer: null, reason: "node_unreachable" });
			expect(spy.calls).toEqual(["https://node.invalid/xrpc/com.atproto.server.createSession"]);
		});
	});
});

describe("a repository somebody granted Anthers permission over", () => {
	const GRANTED = `atproto ${USER_SCOPE_EXPANDED} ${CREATOR_SCOPE_EXPANDED}`;
	const handled: string[] = [];
	let audience: string | (() => never) = "";
	const dids: string[] = [];

	beforeAll(() => {
		setAtprotoClient({
			restore: async (did: string) => ({
				did,
				getTokenInfo: async () => {
					if (typeof audience === "function") audience();
					return { aud: audience, scope: GRANTED };
				},
				fetchHandler: async (path: string) => {
					handled.push(path);
					return new Response("{}");
				},
			}),
		} as never);
	});

	afterAll(async () => {
		setAtprotoClient(undefined);
		if (dids.length) await db.delete(atprotoSessions).where(inArray(atprotoSessions.did, dids));
	});

	async function grantingCreator(tag: string): Promise<number> {
		const account = await createAccount(`${RUN}${tag}`);
		const [user] = await db
			.select({ did: users.atprotoDid })
			.from(users)
			.where(eq(users.id, account.userId));
		dids.push(user.did);
		await db
			.insert(atprotoSessions)
			.values({ did: user.did, userId: account.userId, session: {}, scope: GRANTED });
		return account.userId;
	}

	async function writeListing(userId: number) {
		const opened = await writerForAccount(userId, { collections: [WORK_COLLECTION] });
		if (opened.writer) await opened.writer.deleteRecord(WORK_COLLECTION, "3kexample");
		return opened;
	}

	it("opens no writer onto a server on the real network from a developer's machine", async () => {
		runAs(LOCAL);
		audience = "https://morel.us-east.host.bsky.network";
		handled.length = 0;

		expect(await writeListing(await grantingCreator("ow"))).toEqual({
			writer: null,
			reason: "off_network",
		});
		expect(handled).toEqual([]);
	});

	it("refuses when the token will not say where it points", async () => {
		runAs(LOCAL);
		audience = () => {
			throw new Error("no token on file");
		};
		handled.length = 0;

		expect(await writeListing(await grantingCreator("ou"))).toEqual({
			writer: null,
			reason: "off_network",
		});
		expect(handled).toEqual([]);
	});

	it("writes to a local server, so the refusal above is not a writer that never opens", async () => {
		runAs(LOCAL);
		audience = "http://localhost:2584";
		handled.length = 0;

		const opened = await writeListing(await grantingCreator("ol"));
		expect(opened.writer).not.toBeNull();
		expect(handled).toEqual(["/xrpc/com.atproto.repo.deleteRecord"]);
	});

	it("writes to the real network from a public deployment", async () => {
		runAs(PUBLIC);
		audience = "https://morel.us-east.host.bsky.network";
		handled.length = 0;

		const opened = await writeListing(await grantingCreator("op"));
		expect(opened.writer).not.toBeNull();
		expect(handled).toEqual(["/xrpc/com.atproto.repo.deleteRecord"]);
	});
});
