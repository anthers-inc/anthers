// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The refusals that stand between a Lexicon and the network.
 *
 * 🛑 **Publishing is irreversible and is Parker's decision.** Everything this script does
 * before the write is a gate, so the gates are what get tested — a guard nobody exercises is
 * a comment claiming a guard exists, and this one cannot be checked by trying it.
 */
import { describe, expect, it } from "bun:test";
import {
	authorityNamesAccount,
	collectPlans,
	decide,
	isRefusal,
	lexiconAuthorityDomain,
	type PublishPlan,
	retireRefusal,
} from "./atproto-publish-lexicon.js";

const plans: PublishPlan[] = [
	{
		nsid: "org.anthers.work",
		rkey: "org.anthers.work",
		authorityDomain: "_lexicon.anthers.org",
		record: { $type: "com.atproto.lexicon.schema", lexicon: 1, id: "org.anthers.work", defs: {} },
	},
];
const tty = { hasTty: true, plans };

describe("where a schema has to resolve from", () => {
	it("reverses the authority into a DNS name", () => {
		expect(lexiconAuthorityDomain("org.anthers.work")).toBe("_lexicon.anthers.org");
	});

	it("shows what grouping a name would have cost", () => {
		// The flat-namespace decision, made concrete: a grouped name answers to a second DNS
		// record nobody has created.
		expect(lexiconAuthorityDomain("org.anthers.catalog.work")).toBe("_lexicon.catalog.anthers.org");
	});

	it("refuses a name too short to have an authority", () => {
		expect(() => lexiconAuthorityDomain("org.anthers")).toThrow();
	});
});

describe("what the repository would publish", () => {
	it("reads the real Lexicon directory and keeps the document verbatim", () => {
		const found = collectPlans();
		expect(found.length).toBeGreaterThan(0);

		const work = found.find((p) => p.nsid === "org.anthers.work");
		expect(work).toBeDefined();
		expect(work?.rkey).toBe("org.anthers.work");
		expect(work?.authorityDomain).toBe("_lexicon.anthers.org");

		// 🚨 Established by reading a published record off the network rather than from the
		// guide, which does not say: the record is the document plus `$type`, and the `id`
		// field stays. Dropping it — the obvious guess — would publish a schema shaped
		// differently from every other one on the network.
		expect(work?.record.$type).toBe("com.atproto.lexicon.schema");
		expect(work?.record.id).toBe("org.anthers.work");
		expect(work?.record.lexicon).toBe(1);
		expect(work?.record.defs).toBeDefined();
	});
});

describe("the authority has to name the account publishing", () => {
	const DID = "did:plc:75xx6l27mt7a3uxoga5ka4qt";

	it("accepts the account the TXT record names", () => {
		expect(authorityNamesAccount([`did=${DID}`], DID)).toBe(true);
	});

	it("accepts it through the quoting a resolver may leave on", () => {
		expect(authorityNamesAccount([`"did=${DID}"`], DID)).toBe(true);
	});

	it("refuses a different account, which would publish a schema that never resolves", () => {
		expect(authorityNamesAccount([`did=${DID}`], "did:plc:someoneelse")).toBe(false);
	});

	it("refuses when the authority has no record at all", () => {
		// The failure this catches is silent from the publishing side: the write succeeds and
		// the schema is simply unreachable.
		expect(authorityNamesAccount([], DID)).toBe(false);
	});
});

describe("the gates in front of an irreversible write", () => {
	it("allows a dry run, which writes nothing", () => {
		const d = decide([], {}, tty);
		expect(isRefusal(d)).toBe(false);
		expect((d as { write: boolean }).write).toBe(false);
	});

	it("refuses to publish from CI, which is not a person", () => {
		const d = decide(["--write", "--service", "s", "--identifier", "i"], { CI: "true" }, tty);
		expect(isRefusal(d)).toBe(true);
	});

	it("refuses to publish without a terminal", () => {
		const d = decide(
			["--write", "--service", "s", "--identifier", "i"],
			{},
			{ hasTty: false, plans },
		);
		expect(isRefusal(d)).toBe(true);
	});

	it("refuses a password passed as a flag rather than accepting it", () => {
		// Accepting it would leave the credential in the shell history of whichever machine
		// published, and rotating it is a worse afternoon than retyping it.
		const d = decide(
			["--write", "--service", "s", "--identifier", "i", "--password", "hunter2"],
			{},
			tty,
		);
		expect(isRefusal(d)).toBe(true);
	});

	it.each([
		["no service", ["--write", "--identifier", "i"]],
		["no identifier", ["--write", "--service", "s"]],
		["neither", ["--write"]],
	])("refuses --write with %s, so omission cannot reach a real server", (_label, argv) => {
		expect(isRefusal(decide(argv, {}, tty))).toBe(true);
	});

	it("allows the write only when every gate is satisfied", () => {
		const d = decide(["--write", "--service", "s", "--identifier", "i"], {}, tty);
		expect(isRefusal(d)).toBe(false);
		expect((d as { write: boolean }).write).toBe(true);
	});

	it("refuses when there is nothing to publish", () => {
		expect(isRefusal(decide([], {}, { hasTty: true, plans: [] }))).toBe(true);
	});
});

describe("retiring a schema from the network", () => {
	const plans = collectPlans();

	// 🚨 The guard a person cannot apply by eye: a schema still in the repository may still be
	// asked for, and a permission set that stops resolving fails every sign-in that names it.
	it("refuses a schema the repository still carries", () => {
		expect(retireRefusal("org.anthers.work", plans)).toContain("still in lexicons/");
	});

	it("refuses anything outside Anthers' own namespace, and a missing NSID", () => {
		expect(retireRefusal("com.example.record", plans)).toContain("org.anthers.*");
		expect(retireRefusal(undefined, plans)).toContain("needs the NSID");
		expect(retireRefusal("--service", plans)).toContain("needs the NSID");
	});

	it("allows one that has already left the repository", () => {
		expect(retireRefusal("org.anthers.somethingRetired", plans)).toBeNull();
	});
});
