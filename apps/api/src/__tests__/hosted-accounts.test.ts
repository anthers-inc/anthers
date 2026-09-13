// SPDX-License-Identifier: Apache-2.0
/**
 * Issuing a handle: what the name rules refuse, and what the node's answers mean.
 *
 * ⭐ **The cases worth having are the ones where a wrong answer is permanent.** A handle is
 * published to a directory the moment the account exists, so a name accepted here that should
 * not have been is not a bug somebody can edit out later — which is why the refusals get more
 * coverage than the acceptances.
 *
 * 🚨 **`unknown` is the case a normal run never reaches and the one an outage produces.** A
 * node that did not answer has said nothing about whether a name is free, and reporting that
 * as "taken" would tell somebody their name was gone during an outage. Same distinction, same
 * reason, as `listHostedRepos` returning `null` rather than `[]`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const PDS_URL = "https://anthers.social";

// Set before the module is imported: every reader is a function called at use, but the tests
// below assume the door is open, and a suffix derived from an unset variable is empty.
//
// 🚨 **Put back afterwards, because `bun test` runs every file in one process.** Left set,
// these would open the handle door for the rest of the suite — pointed at the REAL node, on
// the strength of a variable this file set for its own purposes. Nothing in the suite asks
// for a handle today, so nothing would reach production; the reason to close it is that a
// test which *could* reach production is the kind of hazard that is discovered by accident.
//
// ⚠️ Nothing here touches the network regardless: every test that would goes through an
// injected `fetchImpl`. The real address is used only because a readable suffix makes the
// assertions readable.
const before = {
	url: process.env.HOSTED_PDS_URL,
	invite: process.env.HOSTED_PDS_INVITE_CODE,
};

beforeAll(() => {
	process.env.HOSTED_PDS_URL = PDS_URL;
});

afterAll(() => {
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_PDS_INVITE_CODE", before.invite);
});

/** Put a variable back exactly as it was, including having been unset. */
function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const {
	checkHandleAvailability,
	createHostedAccount,
	handleNameProblem,
	hostedHandleFor,
	HostedAccountError,
	normalizeHandleName,
} = await import("../services/hosted-accounts.js");

/** A fetch that answers a fixed response, and records what it was asked for. */
function fakeFetch(
	handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown },
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const { status = 200, body = {} } = handler(url, init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("normalizeHandleName", () => {
	it("takes a name however somebody writes it", () => {
		expect(normalizeHandleName("  @Alice  ")).toBe("alice");
		expect(normalizeHandleName("Alice.anthers.social")).toBe("alice");
		expect(normalizeHandleName("@alice.anthers.social")).toBe("alice");
	});

	// The suffix is stripped only from the end. A name that merely contains it is a name.
	it("does not strip a suffix that is not at the end", () => {
		expect(normalizeHandleName("anthers.social.fan")).toBe("anthers.social.fan");
	});
});

describe("handleNameProblem", () => {
	it("accepts an ordinary name", () => {
		expect(handleNameProblem("alice")).toBeNull();
		expect(handleNameProblem("alice-in-print")).toBeNull();
		expect(handleNameProblem("a1b2")).toBeNull();
	});

	it("refuses names that are too short or too long", () => {
		expect(handleNameProblem("ab")).toContain("at least");
		expect(handleNameProblem("a".repeat(31))).toContain("at most");
		expect(handleNameProblem("a".repeat(30))).toBeNull();
	});

	// 🚨 A handle is a domain name and an Anthers username is not, so the two alphabets differ
	// by exactly one character people actually use. Naming it beats restating the rule.
	it("names the underscore rather than restating the alphabet", () => {
		const problem = handleNameProblem("alice_in_print");
		expect(problem).toContain("underscores");
		expect(problem).toContain("hyphen");
	});

	it("refuses characters a domain name cannot carry", () => {
		expect(handleNameProblem("alice!")).toContain("letters, numbers and hyphens");
		expect(handleNameProblem("alice.smith")).toContain("letters, numbers and hyphens");
	});

	it("refuses a leading or trailing hyphen, which a DNS label cannot have", () => {
		expect(handleNameProblem("-alice")).toContain("hyphen");
		expect(handleNameProblem("alice-")).toContain("hyphen");
	});

	// The list is the node's own, copied so the answer arrives while somebody is still typing.
	it("refuses what the node reserves", () => {
		expect(handleNameProblem("admin")).toBe("That handle is reserved.");
		expect(handleNameProblem("archive")).toBe("That handle is reserved.");
		expect(handleNameProblem("pds")).toBe("That handle is reserved.");
	});

	// ⭐ The ones the node does not know to protect, because they are about Anthers.
	it("refuses names that would look official", () => {
		expect(handleNameProblem("anthers")).toBe("That handle is reserved.");
		expect(handleNameProblem("timepool")).toBe("That handle is reserved.");
	});
});

describe("checkHandleAvailability", () => {
	it("asks about the whole handle, not the name", async () => {
		const { impl, calls } = fakeFetch(() => ({ status: 400 }));
		await checkHandleAvailability("alice", { fetchImpl: impl });
		expect(calls[0].url).toContain(encodeURIComponent("alice.anthers.social"));
	});

	// A resolved handle is one that exists. This reads backwards, which is why it is pinned.
	it("reads a resolved handle as taken", async () => {
		const { impl } = fakeFetch(() => ({ status: 200, body: { did: "did:plc:x" } }));
		expect(await checkHandleAvailability("alice", { fetchImpl: impl })).toEqual({
			status: "taken",
		});
	});

	it("reads a refusal to resolve as available", async () => {
		const { impl } = fakeFetch(() => ({ status: 400 }));
		expect(await checkHandleAvailability("alice", { fetchImpl: impl })).toEqual({
			status: "available",
		});
	});

	// 🚨 The case that must never become "taken": the node is having a problem, not answering
	// a question about a name.
	it("says unknown when the node is broken, never taken", async () => {
		const { impl } = fakeFetch(() => ({ status: 502 }));
		expect(await checkHandleAvailability("alice", { fetchImpl: impl })).toEqual({
			status: "unknown",
		});
	});

	it("says unknown when the node cannot be reached at all", async () => {
		const impl = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await checkHandleAvailability("alice", { fetchImpl: impl })).toEqual({
			status: "unknown",
		});
	});

	// A bad name is answered without troubling the node, which is also what stops the check
	// becoming a way to make Anthers issue requests on somebody's behalf.
	it("refuses a bad name without asking the node", async () => {
		const { impl, calls } = fakeFetch(() => ({ status: 400 }));
		const result = await checkHandleAvailability("admin", { fetchImpl: impl });
		expect(result.status).toBe("invalid");
		expect(calls).toHaveLength(0);
	});
});

describe("createHostedAccount", () => {
	beforeAll(() => {
		process.env.HOSTED_PDS_INVITE_CODE = "anthers.social-testcode";
	});

	it("sends the full handle, the address and the invite, and no recovery key", async () => {
		const { impl, calls } = fakeFetch(() => ({
			body: { did: "did:plc:new", handle: hostedHandleFor("alice") },
		}));
		const account = await createHostedAccount(
			{ handleName: "alice", email: "alice@example.com" },
			{ fetchImpl: impl },
		);

		expect(account.did).toBe("did:plc:new");
		expect(account.handle).toBe("alice.anthers.social");
		expect(account.password.length).toBeGreaterThan(20);

		const sent = JSON.parse(String(calls[0].init?.body));
		expect(sent.handle).toBe("alice.anthers.social");
		expect(sent.email).toBe("alice@example.com");
		expect(sent.inviteCode).toBe("anthers.social-testcode");
		// 🚨 The custody decision, pinned. Passing a `recoveryKey` here would hand somebody a
		// key at the moment they are least able to keep it — see the module note.
		expect(sent).not.toHaveProperty("recoveryKey");
	});

	it("gives a different password every time", async () => {
		const { impl } = fakeFetch(() => ({ body: { did: "did:plc:x", handle: "x.anthers.social" } }));
		const a = await createHostedAccount(
			{ handleName: "aaa", email: "a@x.com" },
			{ fetchImpl: impl },
		);
		const b = await createHostedAccount(
			{ handleName: "bbb", email: "b@x.com" },
			{ fetchImpl: impl },
		);
		expect(a.password).not.toBe(b.password);
	});

	// ⭐ **The fault matters more than the message.** A spent invite code is not something the
	// person retyping their name can fix, and telling them it is would leave them trying.
	it("blames the name for a taken handle and Anthers for a spent invite", async () => {
		const taken = fakeFetch(() => ({ status: 400, body: { error: "HandleNotAvailable" } }));
		await expect(
			createHostedAccount({ handleName: "alice", email: "a@x.com" }, { fetchImpl: taken.impl }),
		).rejects.toMatchObject({ fault: "name" });

		const spent = fakeFetch(() => ({ status: 400, body: { error: "InvalidInviteCode" } }));
		await expect(
			createHostedAccount({ handleName: "alice", email: "a@x.com" }, { fetchImpl: spent.impl }),
		).rejects.toMatchObject({ fault: "operational" });
	});

	it("treats an unreachable node as operational rather than as a bad name", async () => {
		const impl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		await expect(
			createHostedAccount({ handleName: "alice", email: "a@x.com" }, { fetchImpl: impl }),
		).rejects.toMatchObject({ fault: "operational" });
	});

	// A 200 that carries no DID is a server saying something went wrong in a way the status
	// line did not. Reading it as success would store a row with no identity in it.
	it("refuses an answer with no identity in it", async () => {
		const { impl } = fakeFetch(() => ({ body: { handle: "alice.anthers.social" } }));
		await expect(
			createHostedAccount({ handleName: "alice", email: "a@x.com" }, { fetchImpl: impl }),
		).rejects.toBeInstanceOf(HostedAccountError);
	});

	it("refuses a bad name before creating anything", async () => {
		const { impl, calls } = fakeFetch(() => ({ body: {} }));
		await expect(
			createHostedAccount({ handleName: "admin", email: "a@x.com" }, { fetchImpl: impl }),
		).rejects.toMatchObject({ fault: "name" });
		expect(calls).toHaveLength(0);
	});
});
