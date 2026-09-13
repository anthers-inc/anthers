// SPDX-License-Identifier: Apache-2.0
/**
 * Seating a recovery key: what is accepted as a key, and what each of the node's answers means.
 *
 * 🚨 **The load-bearing assertions are about a key that is wrong in a way nothing would
 * notice.** A `did:key:` with a flipped byte is well-formed, base58-decodes, carries the right
 * multicodec, and names a point that is not on the curve — and if it were seated it would sit
 * at the TOP of the identity's authority list signing for nothing, discovered by the one
 * person who ever needed it, on the day they needed it. Everything else here is ordinary
 * error handling; that case is the reason the validator decodes rather than pattern-matches.
 *
 * ⭐ **The second thing worth pinning is the watcher baseline.** `watch-identities` alerts on
 * any rotation-key change, which is exactly right for a key that moved without Anthers doing
 * it — and this key moves BECAUSE Anthers did it, on the holder's instruction. If the new head
 * is not written back, the next hourly sweep pages somebody about a deliberate act.
 *
 * ⚠️ **Nothing here reaches a network.** Every node answer is an injected `fetchImpl`, and the
 * one test that exercises the directory read points at a `.invalid` host.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, hostedIdentities, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `rk${Date.now().toString(36)}`;

const before = {
	url: process.env.HOSTED_PDS_URL,
	key: process.env.HOSTED_ACCOUNT_KEY,
};

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(() => {
	process.env.HOSTED_PDS_URL = "https://node.invalid";
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(async () => {
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_ACCOUNT_KEY", before.key);
	await db.delete(hostedIdentities).where(like(hostedIdentities.did, `did:plc:${RUN}%`));
	await db.delete(hostedAccounts).where(like(hostedAccounts.did, `did:plc:${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

const { isSecp256k1DidKey, seatRecoveryKey, requestRecoveryKeyToken } = await import(
	"../services/hosted-recovery-key.js"
);
const { seal } = await import("../services/secret-box.js");

/** The vector both key generators check themselves against. Public half of a discarded pair. */
const GOOD_KEY = "did:key:zQ3shkEHrW2UqqapTySPVtXC3HpndFZjWWYL3xTHzRBwA2923";

/** The same key's compressed bytes, for building deliberately mis-prefixed variants of it. */
const GOOD_KEY_COMPRESSED = "03530c4fa8214dc3fc07f011a3b9310d06bbd55dd9b00ff17e121e495c23863c54";

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

describe("what counts as a key worth seating", () => {
	it("accepts the vector the generators are pinned to", () => {
		expect(isSecp256k1DidKey(GOOD_KEY)).toBe(true);
	});

	it("refuses anything that is not a did:key at all", () => {
		expect(isSecp256k1DidKey("")).toBe(false);
		expect(isSecp256k1DidKey("hello")).toBe(false);
		expect(isSecp256k1DidKey("did:plc:abc")).toBe(false);
	});

	// 🚨 The case a regex passes. Same prefix, same length, same alphabet — a point that is not
	// on the curve, which only asking the curve can tell.
	it("refuses a key whose point is not on the curve", () => {
		// 0x02 says "compressed, even y" over an all-zero x, which has no corresponding point.
		const bad = didKeyFor(new Uint8Array([0x02, ...new Uint8Array(32)]));
		expect(bad).toMatch(/^did:key:z/);
		expect(isSecp256k1DidKey(bad)).toBe(false);
	});

	// 🚨 **A P-256 key is the input the multicodec check exists for, and nothing else catches
	// it.** The protocol accepts P-256 rotation keys too, so one is a real thing somebody can
	// hold — and it is the same 35 bytes, its compressed form starts with the same 0x02/0x03,
	// and its point is frequently valid on secp256k1 as well. Length, shape and the curve all
	// pass; only the two prefix bytes say which curve was meant. The Ed25519 case this replaced
	// was caught by the curve check instead, so removing the multicodec check broke nothing —
	// found by sabotage on 2026-09-09, which is the entire argument for running one.
	it("refuses a P-256 key, which every other check here would let through", () => {
		const p256 = new Uint8Array([0x80, 0x24, ...hexToBytes(GOOD_KEY_COMPRESSED)]);
		const asDidKey = `did:key:z${base58(p256)}`;
		// The payload really is a valid point — so the curve check is not what refuses this.
		expect(
			isSecp256k1DidKey(
				`did:key:z${base58(new Uint8Array([0xe7, 0x01, ...hexToBytes(GOOD_KEY_COMPRESSED)]))}`,
			),
		).toBe(true);
		expect(isSecp256k1DidKey(asDidKey)).toBe(false);
	});

	it("refuses a truncated key", () => {
		expect(isSecp256k1DidKey(GOOD_KEY.slice(0, GOOD_KEY.length - 4))).toBe(false);
	});

	it("refuses a character base58 does not have", () => {
		// `0`, `O`, `I` and `l` are excluded from the alphabet precisely to stop transcription
		// errors, so one appearing means somebody retyped this by hand.
		expect(isSecp256k1DidKey(`${GOOD_KEY.slice(0, -1)}0`)).toBe(false);
	});
});

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let out = "";
	while (n > 0n) {
		out = BASE58[Number(n % 58n)] + out;
		n /= 58n;
	}
	return out;
}

function didKeyFor(compressed: Uint8Array): string {
	return `did:key:z${base58(new Uint8Array([0xe7, 0x01, ...compressed]))}`;
}

// ─── The flow itself ─────────────────────────────────────────────────────────

async function makeAccount(tag: string, opts: { openable?: boolean } = {}) {
	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
		})
		.returning();
	const did = `did:plc:${RUN}${tag}`;
	await db.insert(hostedAccounts).values({
		did,
		userId: user.id,
		handle: `${RUN}${tag}.anthers.social`,
		sealedPassword:
			opts.openable === false
				? "v1.YWFhYWFhYWFhYWFh.YmJiYmJiYmJiYmJiYmJiYg.Y2Nj"
				: seal("a-generated-password"),
	});
	return { userId: user.id, did };
}

describe("asking for a key when the account has none to put one on", () => {
	it("refuses an account with no hosted identity, without calling anything", async () => {
		const [user] = await db
			.insert(users)
			.values({
				username: `${RUN}none`,
				email: `${RUN}none@example.test`,
				emailVerified: true,
			})
			.returning();
		let called = false;
		const result = await requestRecoveryKeyToken(user.id, {
			fetchImpl: (async () => {
				called = true;
				return new Response("{}");
			}) as unknown as typeof fetch,
		});
		expect(result.status).toBe("refused");
		expect(called).toBe(false);
	});

	// ⚠️ Retrying never opens a credential this deployment's key cannot open, so this is
	// reported as Anthers' problem rather than as something to try again.
	it("refuses a credential it cannot open, before any network call", async () => {
		const { userId } = await makeAccount("shut", { openable: false });
		let called = false;
		const result = await requestRecoveryKeyToken(userId, {
			fetchImpl: (async () => {
				called = true;
				return new Response("{}");
			}) as unknown as typeof fetch,
		});
		expect(result).toMatchObject({ status: "refused", fault: "operational" });
		expect(called).toBe(false);
	});
});

describe("seating the key", () => {
	it("refuses a bad key before opening a credential or calling the node", async () => {
		const { userId } = await makeAccount("badkey");
		let called = false;
		const result = await seatRecoveryKey(
			userId,
			{ token: "ABCDE-FGHIJ", didKey: "did:key:znot-a-real-key" },
			{
				fetchImpl: (async () => {
					called = true;
					return new Response("{}");
				}) as unknown as typeof fetch,
			},
		);
		expect(result).toMatchObject({ status: "refused", fault: "key" });
		expect(called).toBe(false);
	});

	// 🚨 A spent or mistyped code is the ordinary case and is the person's to fix. Reporting it
	// as an outage would tell somebody to wait when what they need is a new code.
	it("blames the code rather than the server when the node refuses to sign", async () => {
		const { userId, did } = await makeAccount("badtok");
		await db.insert(hostedIdentities).values({
			did,
			rotationKeys: ["did:key:zAnthersOnline", "did:key:zAnthersOffline"],
			headCid: "before",
		});

		const result = await seatRecoveryKey(
			userId,
			{ token: "EXPIRED", didKey: GOOD_KEY },
			{ fetchImpl: router({ signRefuses: true }) },
		);
		expect(result).toMatchObject({ status: "refused", fault: "token" });
	});

	it("puts the key at the head of the list and keeps Anthers' own beneath it", async () => {
		const { userId, did } = await makeAccount("seat");
		await db.insert(hostedIdentities).values({
			did,
			rotationKeys: ["did:key:zAnthersOnline", "did:key:zAnthersOffline"],
			headCid: "before",
		});

		const sent: unknown[] = [];
		const result = await seatRecoveryKey(
			userId,
			{ token: "ABCDE-FGHIJ", didKey: GOOD_KEY },
			{ fetchImpl: router({ record: sent }) },
		);
		expect(result).toMatchObject({ status: "seated", didKey: GOOD_KEY });

		// 🚨 The whole list is sent, the new key first. Sending only the new key would drop
		// Anthers' own two — which `submitPlcOperation` refuses in production, and which a fake
		// would happily accept, so it is asserted here rather than trusted to the server.
		const signed = sent.find((b) => (b as { rotationKeys?: string[] }).rotationKeys) as {
			rotationKeys: string[];
		};
		expect(signed.rotationKeys).toEqual([
			GOOD_KEY,
			"did:key:zAnthersOnline",
			"did:key:zAnthersOffline",
		]);
	});

	// ⭐ The interaction that would page somebody at 3am. `watch-identities` alerts on any
	// rotation-key change; this one changed because Anthers changed it, on the holder's
	// instruction, so the baseline has to move with it or the next hourly sweep reports a
	// deliberate act as a suspected compromise.
	it("moves the watcher's baseline, so the next sweep sees no change", async () => {
		const { userId, did } = await makeAccount("base");
		await db.insert(hostedIdentities).values({
			did,
			rotationKeys: ["did:key:zAnthersOnline", "did:key:zAnthersOffline"],
			headCid: "before",
		});

		await seatRecoveryKey(
			userId,
			{ token: "ABCDE-FGHIJ", didKey: GOOD_KEY },
			{ fetchImpl: router({ afterCid: "after", afterKeys: [GOOD_KEY, "did:key:zAnthersOnline"] }) },
		);

		const [row] = await db
			.select({ keys: hostedIdentities.rotationKeys, head: hostedIdentities.headCid })
			.from(hostedIdentities)
			.where(eq(hostedIdentities.did, did));
		expect(row.head).toBe("after");
		expect(row.keys?.[0]).toBe(GOOD_KEY);
	});

	it("says so rather than seating a second copy when the key is already held", async () => {
		const { userId, did } = await makeAccount("dup");
		await db.insert(hostedIdentities).values({ did, rotationKeys: [GOOD_KEY], headCid: "before" });

		let signed = false;
		const result = await seatRecoveryKey(
			userId,
			{ token: "ABCDE", didKey: GOOD_KEY },
			{ fetchImpl: router({ initialKeys: [GOOD_KEY], onSign: () => (signed = true) }) },
		);
		expect(result).toMatchObject({ status: "already-held" });
		expect(signed).toBe(false);
	});

	it("reports an unreachable node as ours, not as a bad code", async () => {
		const { userId } = await makeAccount("down");
		const result = await seatRecoveryKey(
			userId,
			{ token: "ABCDE", didKey: GOOD_KEY },
			{ fetchImpl: router({ nodeDown: true }) },
		);
		expect(result).toMatchObject({ status: "refused", fault: "operational" });
	});
});

/**
 * A node that answers the four calls this flow makes, and a directory that answers the two
 * reads around them.
 *
 * ⚠️ The directory read is what supplies the CURRENT rotation list, and the operation is built
 * by prepending to it — so `asked` records what was actually sent, because sending only the new
 * key would silently drop Anthers' own and is the one mistake `submitPlcOperation` would catch
 * in production and a fake would not.
 */
function router(
	opts: {
		signRefuses?: boolean;
		nodeDown?: boolean;
		/** Bodies the node was sent, so a test can assert what was actually signed. */
		record?: unknown[];
		/** What the directory reports BEFORE the operation. Anthers' two keys unless given. */
		initialKeys?: string[];
		/** What it reports on the SECOND read, once the operation has landed. */
		afterCid?: string;
		afterKeys?: string[];
		onSign?: () => void;
	} = {},
): typeof fetch {
	// The directory is read twice — once to build the operation, once to move the baseline —
	// and the second read must reflect the change, or the baseline assertion passes against a
	// fake that never moved. Which read this is, is the only thing that varies.
	const ANTHERS_KEYS = ["did:key:zAnthersOnline", "did:key:zAnthersOffline"];
	let directoryReads = 0;
	return (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("plc.directory")) {
			directoryReads += 1;
			const first = directoryReads === 1;
			return json([
				{
					cid: first ? "before" : (opts.afterCid ?? "before"),
					nullified: false,
					operation: {
						alsoKnownAs: ["at://someone.anthers.social"],
						rotationKeys: first
							? (opts.initialKeys ?? ANTHERS_KEYS)
							: (opts.afterKeys ?? opts.initialKeys ?? ANTHERS_KEYS),
						services: { atproto_pds: { endpoint: "https://anthers.social" } },
					},
				},
			]);
		}
		if (opts.nodeDown) throw new Error("connect ECONNREFUSED");
		if (init?.body && opts.record) opts.record.push(JSON.parse(String(init.body)));
		if (url.includes("createSession")) return json({ accessJwt: "token" });
		if (url.includes("signPlcOperation")) {
			opts.onSign?.();
			if (opts.signRefuses) {
				return json({ error: "InvalidToken", message: "token is invalid" }, 400);
			}
			return json({ operation: { sig: "x" } });
		}
		if (url.includes("submitPlcOperation")) return json({});
		if (url.includes("requestPlcOperationSignature")) return json({});
		return json({}, 404);
	}) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
