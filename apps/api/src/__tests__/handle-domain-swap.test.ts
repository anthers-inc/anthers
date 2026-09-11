// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Swapping an issued handle for a domain the account holder owns.
 *
 * ⭐ **The node verifies the domain, not the hub, and that shapes every assertion here.**
 * `updateHandle` runs a non-service handle through `normalizeAndValidateHandle`, which resolves
 * it and refuses unless it already points at this DID. So there is no DNS code to test — what
 * is worth testing is that the hub reads the node's answers correctly, and above all that it
 * treats *not proven yet* as the ordinary outcome rather than as a refusal.
 *
 * 🚨 **A first attempt usually fails and the person has done nothing wrong.** A DNS record takes
 * time to propagate. A flow that reported that as an error would be wrong most of the times
 * anybody used it, so the distinction between "not proven yet" and "that name is wrong" is the
 * load-bearing one.
 *
 * ⚠️ **Branching is on the error CODE rather than the node's prose**, because the wording of an
 * unverified-domain refusal belongs to upstream and moves between versions. A test that pinned
 * the sentence would pass while the behavior it guards failed open on an upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts, hostedIdentities, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `hs${Date.now().toString(36)}`;

const before = { url: process.env.HOSTED_PDS_URL, key: process.env.HOSTED_ACCOUNT_KEY };

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeAll(() => {
	process.env.HOSTED_PDS_URL = "https://anthers.social";
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

const { swapHostedHandle } = await import("../services/hosted-accounts.js");
const { seal } = await import("../services/secret-box.js");

async function makeAccount(tag: string) {
	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			atprotoHandle: `${RUN}${tag}.anthers.social`,
		})
		.returning();
	const did = `did:plc:${RUN}${tag}`;
	await db.insert(hostedAccounts).values({
		did,
		userId: user.id,
		handle: `${RUN}${tag}.anthers.social`,
		sealedPassword: seal("a-generated-password"),
	});
	await db
		.insert(hostedIdentities)
		.values({ did, handle: `${RUN}${tag}.anthers.social`, headCid: "before" });
	return { userId: user.id, did };
}

/** A node that answers `updateHandle` however a test needs, and a directory behind it. */
function router(
	opts: {
		updateError?: { error: string; message?: string; status?: number };
		nodeDown?: boolean;
	} = {},
): typeof fetch {
	return (async (input: string | URL) => {
		const url = String(input);
		if (url.includes("plc.directory")) {
			// ⚠️ **Always the post-change state, because this flow reads the directory exactly
			// once and only after the handle has moved.** Modelling it on the recovery-key fake,
			// which reads twice and switches on the second, made this return the OLD head and
			// look like a missing baseline write.
			return json([
				{
					cid: "after",
					nullified: false,
					operation: {
						alsoKnownAs: ["at://alice.example.com"],
						rotationKeys: ["did:key:zAnthersOnline"],
						services: { atproto_pds: { endpoint: "https://anthers.social" } },
					},
				},
			]);
		}
		if (opts.nodeDown) throw new Error("connect ECONNREFUSED");
		if (url.includes("createSession")) return json({ accessJwt: "token" });
		if (url.includes("updateHandle")) {
			if (opts.updateError) {
				return json(
					{ error: opts.updateError.error, message: opts.updateError.message },
					opts.updateError.status ?? 400,
				);
			}
			return json({});
		}
		return json({}, 404);
	}) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("what this door is not for", () => {
	// 🚨 Changing which anthers.social name you hold is a different feature. The node would
	// accept it, so refusing is the hub's job — otherwise this becomes a second way to take an
	// issued name, through a door built for domains somebody already owns.
	it("refuses another anthers.social name, without asking the node", async () => {
		const { userId } = await makeAccount("suffix");
		let called = false;
		const result = await swapHostedHandle(
			userId,
			{ handle: "someoneelse.anthers.social" },
			{
				fetchImpl: (async () => {
					called = true;
					return json({});
				}) as unknown as typeof fetch,
			},
		);
		expect(result).toMatchObject({ status: "refused", fault: "name" });
		expect(called).toBe(false);
	});

	it("refuses something that is not a domain at all", async () => {
		const { userId } = await makeAccount("nodot");
		const result = await swapHostedHandle(userId, { handle: "alice" }, { fetchImpl: router() });
		expect(result).toMatchObject({ status: "refused", fault: "name" });
	});

	it("refuses an account with no identity Anthers issued", async () => {
		const [user] = await db
			.insert(users)
			.values({ username: `${RUN}none`, email: `${RUN}none@example.test`, emailVerified: true })
			.returning();
		const result = await swapHostedHandle(
			user.id,
			{ handle: "alice.example.com" },
			{ fetchImpl: router() },
		);
		expect(result).toMatchObject({ status: "refused", fault: "account" });
	});
});

describe("a domain that has not proved itself yet", () => {
	// 🚨 The whole point. This is what a first attempt looks like while DNS propagates, and
	// reporting it as a refusal would be wrong most of the time somebody used this.
	it("comes back as unproven, carrying the DID they need to publish", async () => {
		const { userId, did } = await makeAccount("waiting");
		const result = await swapHostedHandle(
			userId,
			{ handle: "alice.example.com" },
			{
				fetchImpl: router({
					updateError: {
						error: "InvalidRequest",
						message: "External handle did not resolve to DID",
					},
				}),
			},
		);
		expect(result).toEqual({ status: "unproven", handle: "alice.example.com", did });

		// And nothing moved. An unproven attempt must leave the identity exactly as it was.
		const [row] = await db
			.select({ handle: hostedAccounts.handle })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, did));
		expect(row.handle).toBe(`${RUN}waiting.anthers.social`);
	});

	// ⚠️ Upstream's wording is not ours to depend on. An unrecognized refusal is read as "not
	// proven yet", which is the safe direction: it invites another attempt rather than telling
	// somebody their domain is wrong when it is only slow.
	it("reads an unfamiliar refusal as unproven rather than as a bad name", async () => {
		const { userId } = await makeAccount("unfamiliar");
		const result = await swapHostedHandle(
			userId,
			{ handle: "alice.example.com" },
			{ fetchImpl: router({ updateError: { error: "SomethingNewUpstream" } }) },
		);
		expect(result).toMatchObject({ status: "unproven" });
	});

	it("still calls a malformed name what it is", async () => {
		const { userId } = await makeAccount("malformed");
		const result = await swapHostedHandle(
			userId,
			{ handle: "alice.example.com" },
			{ fetchImpl: router({ updateError: { error: "InvalidHandle" } }) },
		);
		expect(result).toMatchObject({ status: "refused", fault: "name" });
	});

	it("reports an unreachable node as ours rather than as their domain", async () => {
		const { userId } = await makeAccount("down");
		const result = await swapHostedHandle(
			userId,
			{ handle: "alice.example.com" },
			{ fetchImpl: router({ nodeDown: true }) },
		);
		expect(result).toMatchObject({ status: "refused", fault: "operational" });
	});
});

describe("a domain that has", () => {
	it("takes the new handle everywhere the hub keeps one", async () => {
		const { userId, did } = await makeAccount("proved");
		const result = await swapHostedHandle(
			userId,
			{ handle: "alice.example.com" },
			{ fetchImpl: router() },
		);
		expect(result).toEqual({ status: "swapped", handle: "alice.example.com" });

		const [row] = await db
			.select({ handle: hostedAccounts.handle })
			.from(hostedAccounts)
			.where(eq(hostedAccounts.did, did));
		expect(row.handle).toBe("alice.example.com");

		// 🚨 The account's own handle too. This is what every public surface renders, so a swap
		// that updated only the credential row would leave somebody's old name on their profile
		// with nothing disagreeing about it.
		const [account] = await db
			.select({ handle: users.atprotoHandle })
			.from(users)
			.where(eq(users.id, userId));
		expect(account.handle).toBe("alice.example.com");
	});

	// ⭐ Changing a handle writes a PLC operation, so the identity's head moves — and
	// `watch-identities` alerts on a moved head, correctly, because a handle changing without
	// Anthers doing it is what it exists to catch. This one moved because Anthers did it.
	it("moves the watcher's baseline, so the next sweep sees no change", async () => {
		const { userId, did } = await makeAccount("baseline");
		await swapHostedHandle(userId, { handle: "alice.example.com" }, { fetchImpl: router() });

		const [row] = await db
			.select({ head: hostedIdentities.headCid, handle: hostedIdentities.handle })
			.from(hostedIdentities)
			.where(eq(hostedIdentities.did, did));
		expect(row.head).toBe("after");
		expect(row.handle).toBe("alice.example.com");
	});

	it("takes a name however somebody typed it", async () => {
		const { userId } = await makeAccount("typed");
		const result = await swapHostedHandle(
			userId,
			{ handle: "  @Alice.Example.Com.  " },
			{ fetchImpl: router() },
		);
		expect(result).toEqual({ status: "swapped", handle: "alice.example.com" });
	});
});
