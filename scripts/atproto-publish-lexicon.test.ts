// SPDX-License-Identifier: Apache-2.0
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
	type PublishTarget,
	publishPlan,
	retireRefusal,
	retireSchema,
	SCHEMA_COLLECTION,
} from "./atproto-publish-lexicon.js";
import type { LexiconDoc } from "./lexicon-evolution.js";

const plans: PublishPlan[] = [
	{
		nsid: "org.anthers.work",
		rkey: "org.anthers.work",
		authorityDomain: "_lexicon.anthers.org",
		record: { $type: "com.atproto.lexicon.schema", lexicon: 1, id: "org.anthers.work", defs: {} },
		sourcePath: "lexicons/org/anthers/work.json",
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

describe("the write path, against an in-memory repository", () => {
	const DID = "did:plc:publisher";
	const WORK = collectPlans().find((p) => p.nsid === "org.anthers.work") as PublishPlan;
	const { $type: _type, ...WORK_DOC } = WORK.record;
	const doc = WORK_DOC as LexiconDoc;

	/** The same plan with its document edited. */
	function planWith(edit: (record: Record<string, Record<string, unknown>>) => void): PublishPlan {
		const plan = structuredClone(WORK);
		const main = (plan.record.defs as Record<string, Record<string, unknown>>).main;
		edit((main.record as Record<string, Record<string, unknown>>).properties as never);
		return plan;
	}

	function target(opts: {
		live?: LexiconDoc;
		copy?: LexiconDoc;
		txt?: string[];
		rehearsal?: boolean;
		storesSomethingElse?: boolean;
	}) {
		const records = new Map<string, Record<string, unknown>>();
		if (opts.live) records.set(WORK.nsid, { $type: SCHEMA_COLLECTION, ...opts.live });
		const copies = new Map<string, LexiconDoc>();
		if (opts.copy) copies.set(WORK.nsid, opts.copy);
		const writes: string[] = [];
		const copyWrites: string[] = [];
		const lookups: string[] = [];
		const t: PublishTarget = {
			rehearsal: opts.rehearsal ?? false,
			resolveTxt: async (domain) => {
				lookups.push(domain);
				return opts.txt ?? [`did=${DID}`];
			},
			copies: {
				read: (nsid) => copies.get(nsid) ?? null,
				write: (nsid) => void copyWrites.push(`write ${nsid}`),
				remove: (nsid) => void copyWrites.push(`remove ${nsid}`),
			},
			writer: {
				did: DID,
				createRecord: async () => {
					throw new Error("a schema is never created, only put at its NSID");
				},
				putRecord: async (_collection, rkey, record) => {
					writes.push(`put ${rkey}`);
					const stored = opts.storesSomethingElse ? { ...record, lexicon: 2 } : record;
					records.set(rkey, stored as Record<string, unknown>);
					return { uri: `at://${DID}/${SCHEMA_COLLECTION}/${rkey}`, cid: "bafyEXAMPLE" };
				},
				deleteRecord: async (_collection, rkey) => {
					writes.push(`delete ${rkey}`);
					records.delete(rkey);
				},
				getRecord: async (_collection, rkey) => records.get(rkey) ?? null,
			},
		};
		return { t, writes, copyWrites, lookups };
	}

	it("publishes a schema for the first time and records the copy", async () => {
		const { t, writes, copyWrites } = target({});
		expect(await publishPlan(WORK, t)).toMatchObject({ status: "published" });
		expect(writes).toEqual([`put ${WORK.nsid}`]);
		expect(copyWrites).toEqual([`write ${WORK.nsid}`]);
	});

	it("leaves a schema published exactly as it stands alone", async () => {
		const { t, writes, copyWrites } = target({ live: doc, copy: doc });
		expect(await publishPlan(WORK, t)).toEqual({ nsid: WORK.nsid, status: "unchanged" });
		expect(writes).toEqual([]);
		expect(copyWrites).toEqual([]);
	});

	it("publishes a compatible change", async () => {
		const plan = planWith((props) => {
			props.subtitle = { type: "string" };
		});
		const { t, writes } = target({ live: doc, copy: doc });
		expect(await publishPlan(plan, t)).toMatchObject({ status: "published" });
		expect(writes).toEqual([`put ${WORK.nsid}`]);
	});

	const refusals: [string, Parameters<typeof target>[0], PublishPlan, string][] = [
		[
			"a change that breaks what is published",
			{ live: doc, copy: doc },
			planWith((props) => {
				delete props.description;
			}),
			"breaks what is published",
		],
		[
			"an account the authority does not name",
			{ txt: ["did=did:plc:someoneelse"] },
			WORK,
			"does not name",
		],
		["a copy the network has no record of", { copy: doc }, WORK, "the network has no record"],
		["a published schema with no copy", { live: doc }, WORK, "without this script"],
		[
			"a copy that has drifted from what is published",
			{ live: { ...doc, lexicon: 2 }, copy: doc },
			planWith((props) => {
				props.subtitle = { type: "string" };
			}),
			"no longer matches",
		],
	];

	for (const [name, opts, plan, reason] of refusals) {
		it(`refuses ${name}, and writes nothing`, async () => {
			const { t, writes, copyWrites } = target(opts);
			const outcome = await publishPlan(plan, t);
			expect(outcome.status).toBe("refused");
			expect((outcome as { reason: string }).reason).toContain(reason);
			expect(writes).toEqual([]);
			expect(copyWrites).toEqual([]);
		});
	}

	it("does not record a copy of something the server stored differently", async () => {
		const { t, copyWrites } = target({ storesSomethingElse: true });
		const outcome = await publishPlan(WORK, t);
		expect((outcome as { reason: string }).reason).toContain("stored something other");
		expect(copyWrites).toEqual([]);
	});

	describe("as a rehearsal against a local server", () => {
		it("writes without consulting DNS or touching the committed copies", async () => {
			const { t, writes, copyWrites, lookups } = target({
				rehearsal: true,
				txt: ["did=did:plc:someoneelse"],
				copy: doc,
			});
			expect(await publishPlan(WORK, t)).toMatchObject({ status: "published" });
			expect(writes).toEqual([`put ${WORK.nsid}`]);
			expect(lookups).toEqual([]);
			expect(copyWrites).toEqual([]);
		});

		it("still refuses a change that would break what is published", async () => {
			const plan = planWith((props) => {
				delete props.description;
			});
			const { t, writes } = target({ rehearsal: true, copy: doc });
			expect(await publishPlan(plan, t)).toMatchObject({ status: "refused" });
			expect(writes).toEqual([]);
		});
	});

	describe("retiring", () => {
		it("deletes the record and its copy", async () => {
			const { t, writes, copyWrites } = target({ live: doc, copy: doc });
			expect(await retireSchema(WORK.nsid, t)).toEqual({ nsid: WORK.nsid, status: "retired" });
			expect(writes).toEqual([`delete ${WORK.nsid}`]);
			expect(copyWrites).toEqual([`remove ${WORK.nsid}`]);
		});

		it("refuses an account the authority does not name", async () => {
			const { t, writes } = target({ live: doc, txt: [] });
			expect(await retireSchema(WORK.nsid, t)).toMatchObject({ status: "refused" });
			expect(writes).toEqual([]);
		});

		it("leaves the copy alone in a rehearsal", async () => {
			const { t, copyWrites } = target({ rehearsal: true, live: doc, copy: doc });
			await retireSchema(WORK.nsid, t);
			expect(copyWrites).toEqual([]);
		});
	});
});
