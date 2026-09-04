/**
 * The scan's policy mapping and its vendor client.
 *
 * These tests are unusually assertive about *why* each expectation holds, because the
 * mapping is a transcription of § 7.3 of the Child Safety Reporting Policy rather than a design anyone is free to
 * adjust. A change that makes one of these fail is a change to what Anthers reports to a
 * federal clearinghouse, and it should be made in the policy first.
 */

import { describe, expect, it } from "bun:test";
import { pdqHexToBase64, ShieldError, scanPdqHashes } from "../lib/arachnid-shield";
import { determinationFor, scanPdqHash, VENDOR } from "../services/safety-scan";
import { purgeAccountsCreatedHere } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const CREDS = { username: "u", password: "p" };
const HASH = "d8f8f0cee0f4a84f0637022a078f67f0b36e2ed596621e1d33e6339c4e9c9b22";
const GOOD = { hash: HASH, quality: 100 };

/** A Shield stand-in. Returns whatever classification the test names. */
function stubShield(
	body: unknown,
	init: { status?: number } = {},
): { url: string; restore: () => void; calls: Request[] } {
	const calls: Request[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, req?: RequestInit) => {
		calls.push(new Request(input as string, req));
		return new Response(JSON.stringify(body), {
			status: init.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return {
		url: "https://shield.test",
		restore: () => {
			globalThis.fetch = original;
		},
		calls,
	};
}

function answering(classification: string, matchType: string | null = "near") {
	return { scanned_hashes: { [pdqHexToBase64(HASH)]: { classification, match_type: matchType } } };
}

describe("determinationFor — § 7.3 of the Child Safety Reporting Policy", () => {
	it("treats child sexual abuse material as reportable and quarantines it", () => {
		expect(determinationFor("csam")).toEqual({
			determination: "apparent-csam",
			reportable: true,
			quarantine: true,
		});
	});

	it("quarantines harmful-abusive material but NEVER reports it", () => {
		// The whole point of § 7.3. Shield defines this classification as material that
		// "may not meet the legal definition of CSAM or be classified as illegal in all
		// countries" — reporting it would be reporting material the vendor says may be
		// lawful, which is the Lawshe exposure pointed backwards.
		const result = determinationFor("harmful-abusive-material");
		expect(result.quarantine).toBe(true);
		expect(result.reportable).toBe(false);
	});

	it("does nothing at all on the vendor's own test classification", () => {
		// `test` is a match in Shield's vocabulary. A naive "not no-known-match means hit"
		// check quarantines somebody's upload on a fixture.
		expect(determinationFor("test")).toEqual({
			determination: "clean",
			reportable: false,
			quarantine: false,
		});
	});

	it("does nothing when nothing matched", () => {
		expect(determinationFor("no-known-match").determination).toBe("clean");
	});
});

describe("scanPdqHash", () => {
	it("records the vendor's own word and match type, kept apart from our determination", async () => {
		const stub = stubShield(answering("csam", "near"));
		try {
			const out = await scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url });
			expect(out.determination).toBe("apparent-csam");
			expect(out.reportable).toBe(true);
			expect(out.vendorMatch).toMatchObject({
				vendor: VENDOR,
				classification: "csam",
				matchType: "near",
			});
		} finally {
			stub.restore();
		}
	});

	it("keeps exact and near apart, because § 7.3 requires recording which was obtained", async () => {
		const stub = stubShield(answering("csam", "exact"));
		try {
			const out = await scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url });
			expect(out.vendorMatch?.matchType).toBe("exact");
		} finally {
			stub.restore();
		}
	});

	it("quarantines harmful-abusive material without making it reportable, end to end", async () => {
		// Asserted here as well as on `determinationFor`, because this is the path that
		// actually runs and the one whose answer reaches a federal clearinghouse. The unit
		// test alone leaves the wiring between them unguarded.
		const stub = stubShield(answering("harmful-abusive-material", "near"));
		try {
			const out = await scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url });
			expect(out.determination).toBe("harmful-abusive");
			expect(out.quarantine).toBe(true);
			expect(out.reportable).toBe(false);
			expect(out.vendorMatch?.classification).toBe("harmful-abusive-material");
		} finally {
			stub.restore();
		}
	});

	it("carries no vendor match when nothing matched", async () => {
		const stub = stubShield(answering("no-known-match", null));
		try {
			const out = await scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url });
			expect(out.determination).toBe("clean");
			expect(out.vendorMatch).toBeNull();
		} finally {
			stub.restore();
		}
	});

	it("sends the hash base64-encoded, never as hex", async () => {
		const stub = stubShield(answering("no-known-match", null));
		try {
			await scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url });
			const body = (await stub.calls[0]!.json()) as { hashes: string[] };
			expect(body.hashes).toEqual([pdqHexToBase64(HASH)]);
			expect(body.hashes[0]).not.toBe(HASH);
		} finally {
			stub.restore();
		}
	});

	it("never sends a low-quality hash, and says the question went unasked", async () => {
		const stub = stubShield(answering("csam"));
		try {
			const out = await scanPdqHash(
				{ hash: HASH, quality: 10 },
				{ credentials: CREDS, baseUrl: stub.url },
			);
			expect(out.determination).toBe("unscannable");
			expect(stub.calls).toHaveLength(0);
		} finally {
			stub.restore();
		}
	});

	it("reports unscannable rather than clean when no credential is configured", async () => {
		const out = await scanPdqHash(GOOD, { credentials: null });
		expect(out.determination).toBe("unscannable");
	});

	it("throws when the vendor answers about nothing, rather than calling it clean", async () => {
		const stub = stubShield({ scanned_hashes: {} });
		try {
			await expect(scanPdqHash(GOOD, { credentials: CREDS, baseUrl: stub.url })).rejects.toThrow(
				ShieldError,
			);
		} finally {
			stub.restore();
		}
	});
});

describe("scanPdqHashes — the vendor client", () => {
	it("throws on an HTTP error instead of reporting no matches", async () => {
		const stub = stubShield({}, { status: 503 });
		try {
			await expect(scanPdqHashes([HASH], CREDS, { baseUrl: stub.url })).rejects.toThrow(
				ShieldError,
			);
		} finally {
			stub.restore();
		}
	});

	it("throws on a classification it does not recognize", async () => {
		// A value Shield adds later must not be silently swallowed as "not a match".
		const stub = stubShield(answering("something-new"));
		try {
			await expect(scanPdqHashes([HASH], CREDS, { baseUrl: stub.url })).rejects.toThrow(
				/unknown classification/,
			);
		} finally {
			stub.restore();
		}
	});

	it("ignores an answer about a hash it never asked about", async () => {
		const other = pdqHexToBase64("00".repeat(32));
		const stub = stubShield({
			scanned_hashes: { [other]: { classification: "csam", match_type: "exact" } },
		});
		try {
			const answers = await scanPdqHashes([HASH], CREDS, { baseUrl: stub.url });
			expect(answers.size).toBe(0);
		} finally {
			stub.restore();
		}
	});

	it("sends Basic auth", async () => {
		const stub = stubShield(answering("no-known-match", null));
		try {
			await scanPdqHashes([HASH], CREDS, { baseUrl: stub.url });
			const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
			expect(stub.calls[0]!.headers.get("Authorization")).toBe(expected);
		} finally {
			stub.restore();
		}
	});

	it("asks nothing and calls nobody for an empty batch", async () => {
		const stub = stubShield(answering("csam"));
		try {
			expect((await scanPdqHashes([], CREDS, { baseUrl: stub.url })).size).toBe(0);
			expect(stub.calls).toHaveLength(0);
		} finally {
			stub.restore();
		}
	});
});
