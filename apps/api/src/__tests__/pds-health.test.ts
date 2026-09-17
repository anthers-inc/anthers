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
function scripted(outcomes: Array<"up" | "down" | "error">) {
	const calls: string[] = [];
	const fetchImpl = (async (input: string) => {
		calls.push(String(input));
		const next = outcomes.shift() ?? "up";
		if (next === "error") throw new Error("connection refused");
		return new Response("{}", { status: next === "up" ? 200 : 503 });
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
	it("pings the server's health endpoint and reports it up", async () => {
		const url = server();
		const { calls, fetchImpl } = scripted(["up"]);
		expect(await pdsHealth(url, { now: 1, fetchImpl })).toEqual({
			reachable: true,
			downSince: null,
			statusUrl: null,
		});
		expect(calls).toEqual([`${url}/xrpc/_health`]);
	});

	it("reports a server that refuses the connection or answers with an error as down", async () => {
		const refused = scripted(["error"]);
		expect((await pdsHealth(server(), { now: 1, fetchImpl: refused.fetchImpl }))?.reachable).toBe(
			false,
		);
		const failing = scripted(["down"]);
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
		expect(calls).toHaveLength(1);
		await pdsHealth(url, { now: 1000 + PDS_HEALTH_TTL_MS, fetchImpl });
		expect(calls).toHaveLength(2);
	});

	it("remembers when an outage began until the server answers again", async () => {
		const url = server();
		const { fetchImpl } = scripted(["error", "error", "up"]);
		const first = await pdsHealth(url, { now: 10_000, fetchImpl });
		expect(first?.downSince).toBe(new Date(10_000).toISOString());
		const still = await pdsHealth(url, { now: 10_000 + PDS_HEALTH_TTL_MS, fetchImpl });
		expect(still?.downSince).toBe(new Date(10_000).toISOString());
		const back = await pdsHealth(url, { now: 10_000 + 2 * PDS_HEALTH_TTL_MS, fetchImpl });
		expect(back).toMatchObject({ reachable: true, downSince: null });
	});
});
