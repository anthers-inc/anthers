// SPDX-License-Identifier: Apache-2.0
/**
 * Noticing that the server holding somebody's identity is down, without asking it on every read.
 *
 * Each case uses its own server origin, because the answer is remembered per origin for the life of
 * the process and a shared one would let an earlier case answer a later one.
 */
import { describe, expect, it } from "bun:test";
import {
	BLUESKY_STATUS_URL,
	PDS_HEALTH_TTL_MS,
	pdsHealth,
	statusPageFor,
} from "../services/pds-health";

const RUN = crypto.randomUUID().slice(0, 8);
let port = 20000;
/** A server origin no other case uses. */
const server = () => `https://pds-${RUN}-${port++}.example`;

/** A fetch that answers from a script of outcomes, counting what it was asked. */
function scripted(
	outcomes: Array<"up" | "down" | "refuse" | "error">,
	accountPage = 200,
) {
	const calls: string[] = [];
	const fetchImpl = (async (input: string) => {
		calls.push(String(input));
		// The account page is a second, independent ask in the same read.
		if (String(input).endsWith("/account")) return new Response("", { status: accountPage });
		const next = outcomes.shift() ?? "up";
		if (next === "error") throw new Error("connection refused");
		return new Response("{}", {
			status: next === "up" ? 200 : next === "refuse" ? 429 : 503,
		});
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe("the status page for a server", () => {
	it("is Bluesky's for the servers Bluesky runs, and nobody's otherwise", () => {
		expect(statusPageFor("https://morel.us-east.host.bsky.network")).toBe(BLUESKY_STATUS_URL);
		expect(statusPageFor("https://bsky.social")).toBe(BLUESKY_STATUS_URL);
		expect(statusPageFor("https://pds.example.com")).toBeNull();
		expect(statusPageFor("not a url")).toBeNull();
	});
});

describe("asking whether a server is up", () => {
	it("asks the door every PDS owes its Lexicon and reports it up", async () => {
		const url = server();
		const { calls, fetchImpl } = scripted(["up"]);
		expect(await pdsHealth(url, { now: 1, fetchImpl })).toEqual({
			reachable: true,
			downSince: null,
			statusUrl: null,
			accountPage: true,
		});
		expect(calls).toEqual([
			`${url}/xrpc/com.atproto.server.describeServer`,
			`${url}/account`,
		]);
	});

	it("counts a server that answers 4xx as up, because it answered", async () => {
		// A live PDS refusing this ask is not an outage, and a rate limit is not one either.
		const refusing = scripted(["refuse"]);
		expect(
			(await pdsHealth(server(), { now: 1, fetchImpl: refusing.fetchImpl }))?.reachable,
		).toBe(true);
	});

	it("reports whether the server answers an account page", async () => {
		const present = scripted(["up"], 200);
		expect((await pdsHealth(server(), { now: 1, fetchImpl: present.fetchImpl }))?.accountPage).toBe(
			true,
		);
		// A 404 is a server still on a release that has no account page, and a redirect is a
		// server that has one and wants the browser somewhere else.
		const absent = scripted(["up"], 404);
		expect((await pdsHealth(server(), { now: 1, fetchImpl: absent.fetchImpl }))?.accountPage).toBe(
			false,
		);
		const redirects = scripted(["up"], 302);
		expect(
			(await pdsHealth(server(), { now: 1, fetchImpl: redirects.fetchImpl }))?.accountPage,
		).toBe(true);
	});

	it("retries once before believing a failure, so one dropped connection is not an outage", async () => {
		const url = server();
		const { calls, fetchImpl } = scripted(["error", "up"]);
		expect((await pdsHealth(url, { now: 1, fetchImpl }))?.reachable).toBe(true);
		// Two probe attempts, then the account page's independent ask.
		expect(calls.filter((c) => c.includes("describeServer"))).toHaveLength(2);
	});

	it("reports a server that refuses the connection or answers with a 5xx as down", async () => {
		const refused = scripted(["error", "error"]);
		expect((await pdsHealth(server(), { now: 1, fetchImpl: refused.fetchImpl }))?.reachable).toBe(
			false,
		);
		const failing = scripted(["down", "down"]);
		expect((await pdsHealth(server(), { now: 1, fetchImpl: failing.fetchImpl }))?.reachable).toBe(
			false,
		);
	});

	// ⚠️ Thousands of creators share a bsky.social host, and every page read asks.
	it("asks one server at most once in a window", async () => {
		const url = server();
		const { calls, fetchImpl } = scripted(["up", "up"]);
		await pdsHealth(url, { now: 1000, fetchImpl });
		await pdsHealth(`${url}/some/path`, { now: 1000 + PDS_HEALTH_TTL_MS - 1, fetchImpl });
		expect(calls).toHaveLength(2);
		await pdsHealth(url, { now: 1000 + PDS_HEALTH_TTL_MS, fetchImpl });
		expect(calls).toHaveLength(4);
	});

	it("remembers when an outage began until the server answers again", async () => {
		const url = server();
		// Each read of a down server spends two attempts before it believes the refusal.
		const { fetchImpl } = scripted(["error", "error", "error", "error", "up"]);
		const first = await pdsHealth(url, { now: 10_000, fetchImpl });
		expect(first?.downSince).toBe(new Date(10_000).toISOString());
		const still = await pdsHealth(url, { now: 10_000 + PDS_HEALTH_TTL_MS, fetchImpl });
		expect(still?.downSince).toBe(new Date(10_000).toISOString());
		const back = await pdsHealth(url, { now: 10_000 + 2 * PDS_HEALTH_TTL_MS, fetchImpl });
		expect(back).toMatchObject({ reachable: true, downSince: null });
	});
});
