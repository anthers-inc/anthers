// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The identity watcher's decisions, against a fake directory and a fake server.
 *
 * ⭐ **The cases worth having are the ones a normal run never reaches.** A healthy sweep
 * exercises exactly one branch — unchanged — and every expensive mistake lives in the
 * others: an outage read as a disappearance, a recovery read as an attack, a page of
 * accounts silently unwatched. None of those would be met before an incident, which is
 * precisely when nobody wants to discover them.
 *
 * 🚨 **Sabotage-verified 2026-09-07. Three predictions matched; one was wrong, and the
 * wrong one is the useful part.**
 * - Deleting the `listed === false` guard so any absence counts: predicted **2 fail**, got
 *   **1**. The migration case was expected to fail with it and does not — it passes
 *   `listed: false`, which the sabotage leaves alone. What the miss actually exposed is
 *   that the outage path rested on a single case, so a second one was added covering the
 *   shape an outage really takes: every identity at once, not one.
 * - Taking the last log entry instead of filtering nullified ones: **1 fail** — the
 *   recovery case, which reads the clobbered operation as current.
 * - Returning `[]` instead of `null` when a listing request fails: **1 fail** — the outage
 *   case again, from the other side.
 * - Dropping pagination after the first page: **1 fail** — the second-page account.
 *
 * 🚨 **Sabotaged again 2026-09-08 when the rotation keys were added. Three of four predictions
 * matched; the fourth is the one worth reading.**
 * - Treating an unrecorded past as an empty list: **1 fail** — every key would be reported as
 *   newly added, on every identity, on the first run after this shipped.
 * - Comparing the key lists as sets, so a reordering reads as no change: **1 fail**.
 * - Rendering a key without escaping it: **1 fail** — `<code>` escapes nothing on its own.
 * - Sorting the keys on read: predicted **1 fail**, got **0**. The fixture keys were called
 *   `zHOLDER`/`zOFFLINE`/`zONLINE`, which is already alphabetical order, so a sort was a
 *   no-op on them. **A fixture that agrees with the alphabet cannot detect sorting**, and the
 *   property being tested — that order is authority — was the whole reason for the test. The
 *   keys were renamed so that authority order and alphabetical order disagree, and the
 *   sabotage then failed as it should.
 */
import { describe, expect, it } from "bun:test";
import { describeFinding } from "../jobs/watch-identities.js";
import {
	assessIdentity,
	type IdentityFinding,
	isAlertable,
	listHostedRepos,
	readIdentityHead,
	type StoredIdentity,
} from "../services/hosted-identity.js";

const DID = "did:plc:u3upndjztvoctq6ccb34of6j";

/**
 * Stand-ins for the three keys a hosted identity carries: holder, offline, online.
 *
 * ⚠️ **Named so that authority order is NOT alphabetical order**, which is load-bearing rather
 * than cosmetic. A sabotage that sorted the keys on read passed every test here while they
 * were called `zHOLDER`/`zOFFLINE`/`zONLINE` — a fixture already in sorted order cannot
 * detect sorting. Real keys are `did:key:zQ3sh…` and their authority order has nothing to do
 * with their spelling, so a fixture that agrees with the alphabet is a fixture that agrees
 * with the bug.
 */
const HOLDER = "did:key:zTOP";
const OFFLINE = "did:key:zMIDDLE";
const ONLINE = "did:key:zBOTTOM";
const KEYS = [HOLDER, OFFLINE, ONLINE];

function stored(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
	return {
		did: DID,
		headCid: "bafyOLD",
		handle: "probe.anthers.social",
		pdsEndpoint: "https://anthers.social",
		rotationKeys: KEYS,
		...overrides,
	};
}

const seen = {
	headCid: "bafyOLD",
	handle: "probe.anthers.social",
	pdsEndpoint: "https://anthers.social",
	rotationKeys: KEYS,
};

/** A fetch that answers a fixed body, and records what it was asked for. */
function fakeFetch(handler: (url: string) => { ok?: boolean; body?: unknown }) {
	const calls: string[] = [];
	const impl = (async (input: string | URL) => {
		const url = String(input);
		calls.push(url);
		const { ok = true, body = [] } = handler(url);
		return { ok, json: async () => body } as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("assessIdentity", () => {
	it("records a first sighting without alerting, because there is nothing to compare", () => {
		const out = assessIdentity({ did: DID, stored: null, observed: seen, listed: true });
		expect(out.map((f) => f.kind)).toEqual(["first-seen"]);
		expect(out.every((f) => !isAlertable(f))).toBe(true);
	});

	it("says nothing when nothing moved", () => {
		const out = assessIdentity({ did: DID, stored: stored(), observed: seen, listed: true });
		expect(out.map((f) => f.kind)).toEqual(["unchanged"]);
		expect(out.every((f) => !isAlertable(f))).toBe(true);
	});

	it("alerts on a new operation, and carries what changed", () => {
		const out = assessIdentity({
			did: DID,
			stored: stored(),
			observed: { ...seen, headCid: "bafyNEW", pdsEndpoint: "https://elsewhere.example" },
			listed: true,
		});
		expect(out).toHaveLength(1);
		const f = out[0];
		expect(f.kind).toBe("changed");
		expect(isAlertable(f)).toBe(true);
		if (f.kind !== "changed") throw new Error("unreachable");
		expect(f.from).toBe("bafyOLD");
		expect(f.to).toBe("bafyNEW");
		expect(f.endpointTo).toBe("https://elsewhere.example");
	});

	// 🚨 The case the whole `listed: null` distinction exists for. A directory or a server
	// that did not answer is not evidence about anybody's identity, and a watcher that
	// alerted on it would be teaching its reader to ignore it within a week.
	it("does NOT treat an unreachable server as a disappearance", () => {
		const out = assessIdentity({ did: DID, stored: stored(), observed: seen, listed: null });
		expect(out.map((f) => f.kind)).toEqual(["unchanged"]);
		expect(out.some(isAlertable)).toBe(false);
	});

	// ⭐ **Added because a sabotage run said the outage path had exactly one test.** Removing
	// the `listed === false` guard failed one case, not the two predicted — and one test is
	// thin for the property that decides whether this job is trusted. The real shape of an
	// outage is not one identity, it is every identity at once, and the failure mode is the
	// loudest false alarm available: an alert per account, all of them wrong.
	it("stays silent for EVERY identity when the server is unreachable, not just one", () => {
		const dids = ["did:plc:aaa", "did:plc:bbb", "did:plc:ccc"];
		const alerts = dids.flatMap((did) =>
			assessIdentity({
				did,
				stored: stored({ did }),
				observed: seen,
				listed: null,
			}).filter(isAlertable),
		);
		expect(alerts).toEqual([]);
	});

	it("does NOT conclude anything when the directory cannot be read", () => {
		const out = assessIdentity({ did: DID, stored: stored(), observed: null, listed: true });
		expect(out.map((f) => f.kind)).toEqual(["unreadable"]);
		expect(out.some(isAlertable)).toBe(false);
	});

	// The other side of the same coin: a listing that SUCCEEDED and left this out is the
	// one shape that means somebody may be hiding an account.
	it("alerts when a successful listing omits an identity it has held before", () => {
		const out = assessIdentity({ did: DID, stored: stored(), observed: seen, listed: false });
		expect(out.map((f) => f.kind)).toEqual(["vanished", "unchanged"]);
		expect(out.some(isAlertable)).toBe(true);
	});

	it("reports both halves of a migration away, rather than the first one it finds", () => {
		const out = assessIdentity({
			did: DID,
			stored: stored(),
			observed: { ...seen, headCid: "bafyNEW", pdsEndpoint: "https://elsewhere.example" },
			listed: false,
		});
		expect(out.map((f) => f.kind).sort()).toEqual(["changed", "vanished"]);
	});

	it("treats a row that has never had a head as a first sighting", () => {
		const out = assessIdentity({
			did: DID,
			stored: stored({ headCid: null }),
			observed: seen,
			listed: true,
		});
		expect(out.map((f) => f.kind)).toEqual(["first-seen"]);
	});
});

describe("readIdentityHead", () => {
	it("reads the newest operation, its handle and its server", async () => {
		const { impl } = fakeFetch(() => ({
			body: [
				{ cid: "bafyONE", nullified: false, operation: { alsoKnownAs: ["at://old.example"] } },
				{
					cid: "bafyTWO",
					nullified: false,
					operation: {
						alsoKnownAs: ["at://probe.anthers.social"],
						rotationKeys: KEYS,
						services: { atproto_pds: { endpoint: "https://anthers.social" } },
					},
				},
			],
		}));
		const out = await readIdentityHead(DID, { fetchImpl: impl });
		expect(out?.headCid).toBe("bafyTWO");
		expect(out?.handle).toBe("probe.anthers.social");
		expect(out?.pdsEndpoint).toBe("https://anthers.social");
		// ⚠️ In the order the document lists them. Order is authority here, so sorting would
		// throw away the difference between holding a key and holding the top key.
		expect(out?.rotationKeys).toEqual(KEYS);
	});

	// 🚨 A nullified entry is an operation a higher key already clobbered — it is history,
	// not current state. Taking the last entry blindly reads a successful *recovery* as the
	// newest thing that happened, which would alert on the fix rather than the attack and
	// leave the real current state unwatched.
	it("ignores operations that were already clobbered by a recovery", async () => {
		const { impl } = fakeFetch(() => ({
			body: [
				{ cid: "bafyGOOD", nullified: false, operation: {} },
				{ cid: "bafyHOSTILE", nullified: true, operation: {} },
			],
		}));
		const out = await readIdentityHead(DID, { fetchImpl: impl });
		expect(out?.headCid).toBe("bafyGOOD");
	});

	it("returns null rather than throwing when the directory refuses", async () => {
		const { impl } = fakeFetch(() => ({ ok: false }));
		expect(await readIdentityHead(DID, { fetchImpl: impl })).toBeNull();
	});

	it("returns null on an empty log rather than inventing a head", async () => {
		const { impl } = fakeFetch(() => ({ body: [] }));
		expect(await readIdentityHead(DID, { fetchImpl: impl })).toBeNull();
	});
});

describe("listHostedRepos", () => {
	// A server with more accounts than one page would otherwise have its tail silently
	// unwatched — which looks exactly like the attack this job exists to detect.
	it("follows the cursor, so the second page is watched too", async () => {
		const { impl } = fakeFetch((url) =>
			url.includes("cursor=p2")
				? { body: { repos: [{ did: "did:plc:second" }] } }
				: { body: { repos: [{ did: "did:plc:first" }], cursor: "p2" } },
		);
		expect(await listHostedRepos("https://pds.example", { fetchImpl: impl })).toEqual([
			"did:plc:first",
			"did:plc:second",
		]);
	});

	// 🚨 `null` and `[]` mean opposite things to the caller: one is "I could not ask", the
	// other is "it holds nothing". Collapsing them turns every outage into a disappearance
	// alert for every account.
	it("returns null when it could not ask, never an empty list", async () => {
		const { impl } = fakeFetch(() => ({ ok: false }));
		expect(await listHostedRepos("https://pds.example", { fetchImpl: impl })).toBeNull();
	});

	it("returns an empty list when the server genuinely holds nothing", async () => {
		const { impl } = fakeFetch(() => ({ body: { repos: [] } }));
		expect(await listHostedRepos("https://pds.example", { fetchImpl: impl })).toEqual([]);
	});
});

describe("describeFinding", () => {
	// The values in an alert come from a third party's directory, and the recipient is
	// whoever operates Anthers. Markup arriving from there and rendering in their mail
	// client is a small hole in an unusually bad place — the one message they are meant to
	// trust on the worst day.
	/** A `changed` finding, with only the parts a given test cares about spelled out. */
	function changed(overrides: Partial<Extract<IdentityFinding, { kind: "changed" }>> = {}) {
		return describeFinding({
			kind: "changed",
			did: "did:plc:x",
			from: "old",
			to: "new",
			handleFrom: null,
			handleTo: null,
			endpointFrom: null,
			endpointTo: null,
			rotationFrom: KEYS,
			rotationTo: KEYS,
			...overrides,
		});
	}

	it("escapes what the directory told us rather than rendering it", () => {
		const { html } = changed({
			handleTo: "<img src=x onerror=alert(1)>",
			endpointTo: 'https://evil.example/"><script>',
		});
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;img src=x");
	});

	// The keys come from the same third-party document as everything else, so they get the
	// same treatment — and they are rendered inside a `<code>`, which escapes nothing on its own.
	it("escapes a rotation key rather than rendering it", () => {
		const { html } = changed({ rotationTo: ["<script>alert(1)</script>"] });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("puts the 72-hour window in the subject, which is all a phone shows", () => {
		const { subject } = changed();
		expect(subject).toContain("72 hours");
		expect(subject).toContain("did:plc:x");
	});

	// 🚨 **The defect this whole change exists for.** The first two live alerts reported the
	// handle and the server as unchanged — correctly — while the rotation keys had been
	// replaced, and the mail did not mention them. A reader was told everything except what
	// they would be recovering from.
	it("says the signing keys changed, in the subject and in the body", () => {
		const { subject, html } = changed({
			rotationFrom: KEYS,
			rotationTo: [HOLDER, "did:key:zNEWHOST"],
		});
		expect(subject).toContain("SIGNING KEYS CHANGED");
		expect(html).toContain("keys that can sign for this identity have changed");
		// Both halves of the answer to "can I still fix this?": what is there now, and what is
		// gone. A key that has been removed cannot act, including to undo the removal.
		expect(html).toContain("did:key:zNEWHOST");
		expect(html).toContain(OFFLINE);
		expect(html).toContain(ONLINE);
		expect(html).toContain("No longer listed");
	});

	// ⚠️ Order is authority — a key can only undo an operation signed by one ranked below it —
	// so the same keys in a new order is a real change, and "nothing added or removed" would
	// read as reassuring when it is not.
	it("reports a reordering as a change, not as nothing", () => {
		const { subject, html } = changed({
			rotationFrom: [HOLDER, OFFLINE, ONLINE],
			rotationTo: [ONLINE, OFFLINE, HOLDER],
		});
		expect(subject).toContain("SIGNING KEYS CHANGED");
		expect(html).toContain("different order");
		expect(html).not.toContain("No longer listed");
	});

	it("says nothing about keys that did not move", () => {
		const { subject, html } = changed({ handleTo: "renamed.anthers.social" });
		expect(subject).not.toContain("SIGNING KEYS");
		expect(html).not.toContain("keys that can sign");
	});

	// A row written before the keys were ever recorded has no past to compare against.
	// Treating that as an empty list would report every key as newly added, on every identity,
	// on the first run after this shipped.
	it("does not invent a key change for a row that never recorded any", () => {
		const { subject, html } = changed({ rotationFrom: null, rotationTo: KEYS });
		expect(subject).not.toContain("SIGNING KEYS");
		expect(html).not.toContain("keys that can sign");
	});
});
