// SPDX-License-Identifier: Apache-2.0
/**
 * Publish an `org.anthers.*` Lexicon to the network.
 *
 * 🛑 **Publishing a Lexicon is irreversible and is Parker's decision, not an agent's.** Once
 * a schema resolves, other people's software may be reading records shaped by it: a field
 * may be added afterwards if it is optional, and nothing may ever be renamed, retyped, made
 * required, or removed. A mistake is not corrected, it is forked under a new name. This
 * script therefore **prints what it would do and stops** unless a person passes `--write`
 * from a terminal and types the NSID back.
 *
 * ⭐ **What went out is committed, and every publish is checked against it.** `lexicons-published/`
 * holds a byte-for-byte copy of each schema as it was published, which this writes when it
 * publishes and removes when it retires. `lex:check` compares `lexicons/` against those copies in
 * CI, so a breaking edit fails at the pull request; this compares them against the network before
 * writing, so a copy that no longer matches what is published stops the run rather than being
 * trusted. The rules are `lexicon-evolution.ts`.
 *
 * ⭐ **Against a local server it is a rehearsal.** Pointed at the network `make dev` starts, it
 * runs the whole write path — the same checks, the same write, the record read back — except the
 * two things only production has: the `_lexicon` DNS record, which cannot name a local account,
 * and the committed copies, which describe production and are left untouched.
 *
 * ⚠️ **Publishing a schema is not what starts Anthers writing records under it.** That is the
 * NSID's entry in `PUBLISHED_LEXICONS` (`apps/api/src/services/published-lexicons.ts`), added in
 * a code change after this has run — so the order is always review, publish, then write.
 *
 * ⚠️ **What a schema record actually is was established by reading one off the network**,
 * not from the guide, which does not say. A `com.atproto.lexicon.schema` record is the
 * Lexicon document *verbatim* — `lexicon`, `id` and `defs` — with `$type` added, written at
 * an rkey equal to the NSID. The `id` field stays: the obvious guess is that the rkey
 * replaces it, and the obvious guess is wrong.
 *
 *   bun run scripts/atproto-publish-lexicon.ts                    # show the plan, write nothing
 *   bun run scripts/atproto-publish-lexicon.ts --write \
 *     --service http://localhost:2583 --identifier alice.test     # rehearse inside make dev
 *   bun run scripts/atproto-publish-lexicon.ts --write \
 *     --service https://bsky.social --identifier anthers.org      # asks, then publishes
 *   bun run scripts/atproto-publish-lexicon.ts --write --retire <nsid> \
 *     --service https://bsky.social --identifier anthers.org      # asks, then removes one
 *
 * ⚠️ **Retiring removes a schema from the network, and is refused for anything the repository
 * still carries.** The file has to be gone from `lexicons/` — and so has everything that asks for
 * the set or writes under it — before its schema record is deleted, so a retirement can never
 * strand code that still depends on the name resolving. 🚨 **A retired NSID is never reused for
 * a different shape**: software that read the old schema may still hold records claiming it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { isOffNetworkUrl } from "../apps/api/src/lib/atproto-network.js";
import { PUBLISHED_LEXICONS } from "../apps/api/src/services/published-lexicons.js";
import type { SessionWriter } from "./atproto-writer.js";
import {
	evolutionProblems,
	LEXICON_DIR,
	type LexiconDoc,
	PUBLISHED_DIR,
	publishedPath,
	readLexiconDocs,
} from "./lexicon-evolution.js";
import { promptHidden } from "./terminal.js";

/** The collection every schema record lives in. */
export const SCHEMA_COLLECTION = "com.atproto.lexicon.schema";

export interface PublishPlan {
	nsid: string;
	/** The record key, which is the NSID itself. */
	rkey: string;
	/** The DNS name that has to carry the authority's DID for this schema to resolve. */
	authorityDomain: string;
	record: Record<string, unknown>;
	/** The Lexicon file the record was read from, copied verbatim into `lexicons-published/`. */
	sourcePath: string;
}

export type Decision = { refuse: string } | { plans: PublishPlan[]; write: boolean };

export function isRefusal(d: Decision): d is { refuse: string } {
	return "refuse" in d;
}

/**
 * The DNS name that must carry a DID for `nsid` to resolve.
 *
 * A schema's authority is everything but its last segment, reversed into a domain, so
 * `org.anthers.work` is published by whoever controls `_lexicon.anthers.org`. This is the
 * whole reason Anthers' schemas are flat: `org.anthers.catalog.work` would answer to
 * `_lexicon.catalog.anthers.org`, a second DNS record for no gain.
 */
export function lexiconAuthorityDomain(nsid: string): string {
	const segments = nsid.split(".");
	if (segments.length < 3) throw new Error(`not a publishable NSID: ${nsid}`);
	const authority = segments.slice(0, -1);
	return `_lexicon.${authority.reverse().join(".")}`;
}

/** Every Lexicon JSON file under `lexicons/`, as a publish plan each. */
export function collectPlans(root = LEXICON_DIR): PublishPlan[] {
	return [...readLexiconDocs(root)].map(([nsid, { doc, path }]) => ({
		nsid,
		rkey: nsid,
		authorityDomain: lexiconAuthorityDomain(nsid),
		// The document verbatim, with `$type` added and nothing removed.
		record: { $type: SCHEMA_COLLECTION, ...doc },
		sourcePath: path,
	}));
}

/**
 * Decide what this invocation is, or refuse it.
 *
 * Pure and exported so the refusals have tests rather than a comment claiming they exist.
 * The refusals are the point of the script: everything else is three lines of XRPC.
 */
export function decide(
	argv: string[],
	env: Record<string, string | undefined>,
	opts: { hasTty: boolean; plans: PublishPlan[] },
): Decision {
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};

	if (opts.plans.length === 0) {
		return { refuse: `no Lexicon JSON found under ${LEXICON_DIR}/` };
	}

	// A dry run is always allowed: it reads files and prints, and is what somebody wants
	// nine times out of ten.
	if (!argv.includes("--write")) return { plans: opts.plans, write: false };

	// 🚨 Everything below guards the irreversible half.
	if (env.CI) {
		return { refuse: "publishing is a person's decision and CI is not a person" };
	}
	if (!opts.hasTty) {
		return {
			refuse: "publishing needs a terminal, so that the confirmation is answered by somebody",
		};
	}
	// A password passed as a flag is refused rather than accepted: it would sit in the shell
	// history of whichever machine published, and rotating it is a worse afternoon than
	// retyping it now. The prompt that asks for it instead does not echo (`promptHidden`), or
	// the password would sit in the terminal's scrollback just the same.
	if (argv.includes("--password")) {
		return {
			refuse: "--password is refused; the password is prompted for and never read from a flag",
		};
	}
	if (!flag("service") || !flag("identifier")) {
		return {
			refuse:
				"--service and --identifier are required and have no defaults, so that this " +
				"cannot reach a real server by leaving something out",
		};
	}
	return { plans: opts.plans, write: true };
}

/**
 * Whether the authority's DNS record names the account we are about to publish from.
 *
 * 🚨 A schema published into the wrong account does not fail — it simply never resolves, and
 * looks published from the inside. The TXT record at the authority is the only thing that
 * decides which account speaks for a namespace, so checking it is the difference between
 * publishing and appearing to.
 *
 * Pure, taking the already-resolved TXT strings, so the comparison has tests without the
 * tests needing DNS.
 */
export function authorityNamesAccount(txtRecords: string[], did: string): boolean {
	return txtRecords.some((r) => r.trim().replace(/^"|"$/g, "") === `did=${did}`);
}

/** Resolve the authority's TXT records. Separated from the comparison so that is testable. */
export async function resolveAuthorityTxt(domain: string): Promise<string[]> {
	const { resolveTxt } = await import("node:dns/promises");
	try {
		return (await resolveTxt(domain)).map((chunks) => chunks.join(""));
	} catch {
		return [];
	}
}

/**
 * Why an NSID may not be retired from the network, or null when it may.
 *
 * 🚨 **Refused while the schema is still in `lexicons/`**, which is the one check a person cannot
 * be relied on to make by eye. A schema still in the repository is one something may still ask
 * for or write under, and deleting it from the network first would make that ask fail to resolve
 * — for a permission set, that is every sign-in that names it.
 */
export function retireRefusal(nsid: string | undefined, plans: PublishPlan[]): string | null {
	if (!nsid || nsid.startsWith("--")) return "--retire needs the NSID to retire";
	if (!nsid.startsWith("org.anthers.")) return "only an org.anthers.* schema is retired from here";
	if (plans.some((plan) => plan.nsid === nsid)) {
		return (
			`${nsid} is still in lexicons/. Remove it from the repository, and from everything that ` +
			"asks for it or writes under it, before retiring it from the network"
		);
	}
	return null;
}

/** Render a plan for a person deciding whether to go ahead. */
export function describePlan(plan: PublishPlan): string {
	return [
		`  ${plan.nsid}`,
		`    rkey       ${plan.rkey}`,
		`    resolves via  ${plan.authorityDomain}  (must hold the publishing account's DID)`,
		`    record     ${JSON.stringify(plan.record).length} bytes, ${Object.keys(plan.record).length} top-level keys`,
	].join("\n");
}

/** The committed copies of what is published. An interface so the write path can be tested. */
export interface PublishedCopies {
	read(nsid: string): LexiconDoc | null;
	/** Record that `sourcePath` is what went out, byte for byte. */
	write(nsid: string, sourcePath: string): void;
	remove(nsid: string): void;
}

/** The copies in `lexicons-published/`. */
export function publishedCopies(root = PUBLISHED_DIR): PublishedCopies {
	return {
		read(nsid) {
			const path = publishedPath(nsid, root);
			return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LexiconDoc) : null;
		},
		write(nsid, sourcePath) {
			const path = publishedPath(nsid, root);
			mkdirSync(dirname(path), { recursive: true });
			copyFileSync(sourcePath, path);
		},
		remove(nsid) {
			rmSync(publishedPath(nsid, root), { force: true });
		},
	};
}

/** Where one run publishes, and what it checks against. */
export interface PublishTarget {
	writer: SessionWriter;
	/** True against a local server: no DNS authority to check, and the committed copies are left alone. */
	rehearsal: boolean;
	resolveTxt(domain: string): Promise<string[]>;
	copies: PublishedCopies;
}

export type PublishOutcome =
	| { nsid: string; status: "published"; uri: string }
	| { nsid: string; status: "unchanged" }
	| { nsid: string; status: "retired" }
	| { nsid: string; status: "refused"; reason: string };

/** A document with its keys sorted at every level, so two copies compare by content. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
			: v,
	);
}

/** A schema record as a Lexicon document: the record without its `$type`. */
function asDoc(record: Record<string, unknown> | null): LexiconDoc | null {
	if (!record) return null;
	const { $type: _type, ...doc } = record;
	return doc as LexiconDoc;
}

/**
 * Why this account may not speak for a schema's authority, or null when it may.
 *
 * Never asked during a rehearsal: a local account is named by no DNS record, which is exactly
 * why a local server is safe to publish to.
 */
async function authorityRefusal(domain: string, target: PublishTarget): Promise<string | null> {
	if (target.rehearsal) return null;
	const txt = await target.resolveTxt(domain);
	if (authorityNamesAccount(txt, target.writer.did)) return null;
	return (
		`${domain} does not name ${target.writer.did} (it holds ` +
		`${txt.length > 0 ? txt.join(", ") : "nothing"}), so the schema would never resolve`
	);
}

/**
 * Publish one schema, after every check that can stop it.
 *
 * The order is deliberate: nothing is written until the edit is known to be compatible, the
 * account is known to speak for the namespace, and the committed copy is known to match what is
 * really out there. A schema already published exactly as it stands is left alone rather than
 * written again.
 */
export async function publishPlan(
	plan: PublishPlan,
	target: PublishTarget,
): Promise<PublishOutcome> {
	const { nsid } = plan;
	const doc = asDoc(plan.record) as LexiconDoc;
	const committed = target.copies.read(nsid);

	if (committed) {
		const breaking = evolutionProblems(committed, doc);
		if (breaking.length > 0) {
			return {
				nsid,
				status: "refused",
				reason: `it breaks what is published: ${breaking.join("; ")}`,
			};
		}
	}

	const authority = await authorityRefusal(plan.authorityDomain, target);
	if (authority) return { nsid, status: "refused", reason: authority };

	if (!target.rehearsal) {
		const live = asDoc(await target.writer.getRecord(SCHEMA_COLLECTION, plan.rkey));
		if (committed && !live) {
			return {
				nsid,
				status: "refused",
				reason: `${PUBLISHED_DIR}/ says it is published, and the network has no record of it`,
			};
		}
		if (!committed && live) {
			return {
				nsid,
				status: "refused",
				reason:
					`the network has a published copy that ${PUBLISHED_DIR}/ does not, so something ` +
					"published it without this script — commit what is out there before changing it",
			};
		}
		if (committed && live && canonical(live) !== canonical(committed)) {
			return {
				nsid,
				status: "refused",
				reason: `the copy in ${PUBLISHED_DIR}/ no longer matches what is published`,
			};
		}
		if (live && canonical(live) === canonical(doc)) return { nsid, status: "unchanged" };
	}

	const ref = await target.writer.putRecord(SCHEMA_COLLECTION, plan.rkey, plan.record);
	const stored = asDoc(await target.writer.getRecord(SCHEMA_COLLECTION, plan.rkey));
	if (canonical(stored) !== canonical(doc)) {
		return {
			nsid,
			status: "refused",
			reason: `the server stored something other than what was sent, at ${ref.uri} — inspect it by hand`,
		};
	}
	if (!target.rehearsal) target.copies.write(nsid, plan.sourcePath);
	return { nsid, status: "published", uri: ref.uri };
}

/** Take one schema off the network, and its committed copy with it. `retireRefusal` runs first. */
export async function retireSchema(nsid: string, target: PublishTarget): Promise<PublishOutcome> {
	const authority = await authorityRefusal(lexiconAuthorityDomain(nsid), target);
	if (authority) return { nsid, status: "refused", reason: authority };
	await target.writer.deleteRecord(SCHEMA_COLLECTION, nsid);
	if (!target.rehearsal) target.copies.remove(nsid);
	return { nsid, status: "retired" };
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const flag = (n: string) => argv[argv.indexOf(`--${n}`) + 1];
	const plans = collectPlans();
	const decision = decide(argv, process.env, { hasTty: Boolean(process.stdin.isTTY), plans });

	if (isRefusal(decision)) {
		console.error(`\nrefused: ${decision.refuse}\n`);
		process.exit(1);
	}

	const copies = publishedCopies();
	const service = decision.write ? flag("service") : "";
	const rehearsal = decision.write && isOffNetworkUrl(service);
	if (rehearsal) {
		console.log(`\n⭐ REHEARSAL against ${service}: the _lexicon DNS check is skipped and`);
		console.log(`   ${PUBLISHED_DIR}/ is left untouched, because both describe production.\n`);
	}

	/** One login for the whole run, after the person has said what they want. */
	async function openTarget(): Promise<PublishTarget> {
		const password = await promptHidden("  password: ");
		if (!password) {
			console.log("  stopped (no password given)");
			process.exit(0);
		}
		const { sessionWriter } = await import("./atproto-writer.js");
		// Every gate in `decide` has passed and a person has typed back what is about to go out,
		// which is the one situation this writer may reach the real network in.
		const writer = await sessionWriter({
			service,
			identifier: flag("identifier"),
			password,
			realNetwork: true,
		});
		return { writer, rehearsal, resolveTxt: resolveAuthorityTxt, copies };
	}

	const retiring = argv.includes("--retire") ? flag("retire") : null;
	if (retiring !== null) {
		const refusal = retireRefusal(retiring, decision.plans);
		if (refusal) {
			console.error(`\nrefused: ${refusal}\n`);
			process.exit(1);
		}
		console.log(
			`\nWould retire ${retiring}, which resolves via ${lexiconAuthorityDomain(retiring)}.\n`,
		);
		if (!decision.write) {
			console.log("Nothing was removed. Pass --write, --service and --identifier to retire it.\n");
			process.exit(0);
		}
		if (
			prompt(`Type the NSID to retire it, or anything else to stop:\n  ${retiring}\n> `) !==
			retiring
		) {
			console.log("  stopped; nothing was removed");
			process.exit(0);
		}
		const outcome = await retireSchema(retiring, await openTarget());
		if (outcome.status === "refused") {
			console.error(`  refused: ${outcome.reason}`);
			process.exit(1);
		}
		console.log(`  retired ${retiring}`);
		if (!rehearsal) console.log(`  removed its copy from ${PUBLISHED_DIR}/ — commit that`);
		console.log("  🚨 Never publish a different shape under this NSID again.");
		process.exit(0);
	}

	console.log(`\nLexicons found (${decision.plans.length}):\n`);
	const candidates: PublishPlan[] = [];
	for (const plan of decision.plans) {
		console.log(describePlan(plan));
		const committed = copies.read(plan.nsid);
		const doc = asDoc(plan.record);
		if (!committed) {
			console.log("    status     not published yet");
			candidates.push(plan);
		} else if (canonical(committed) === canonical(doc)) {
			console.log("    status     published, unchanged");
			if (rehearsal) candidates.push(plan);
		} else {
			const breaking = evolutionProblems(committed, doc as LexiconDoc);
			if (breaking.length > 0) {
				console.log("    status     🛑 BREAKS what is published, and will not be offered:");
				for (const problem of breaking) console.log(`                 ${problem}`);
			} else {
				console.log("    status     published, with compatible changes");
				candidates.push(plan);
			}
		}
		console.log("");
	}

	if (!decision.write) {
		console.log("Nothing was written. Pass --write, --service and --identifier to publish.\n");
		console.log("🛑 Publishing is irreversible: a published field can never be renamed,");
		console.log("   retyped, made required or removed. Read the Lexicon first.\n");
		process.exit(0);
	}
	if (candidates.length === 0) {
		console.log("Nothing to publish: every schema is published as it stands.\n");
		process.exit(0);
	}

	// The write path is not reached without a person having typed each NSID back.
	const chosen = candidates.filter(
		(plan) =>
			prompt(`\nType the NSID to publish it, or anything else to skip:\n  ${plan.nsid}\n> `) ===
			plan.nsid,
	);
	if (chosen.length === 0) {
		console.log("  nothing chosen; nothing was written");
		process.exit(0);
	}

	const target = await openTarget();
	const published: string[] = [];
	for (const plan of chosen) {
		const outcome = await publishPlan(plan, target);
		if (outcome.status === "published") {
			console.log(`  published ${outcome.uri}`);
			published.push(plan.nsid);
		} else if (outcome.status === "unchanged") {
			console.log(`  ${plan.nsid} is already published exactly as it stands`);
		} else if (outcome.status === "refused") {
			console.error(`  refused ${plan.nsid}: ${outcome.reason}`);
		}
	}

	if (published.length > 0 && !rehearsal) {
		console.log(
			`\nCopied what went out into ${PUBLISHED_DIR}/ — commit it with the Lexicon change.`,
		);
	}
	// ⚠️ Publishing a schema does not start Anthers writing records under it, on purpose: that is
	// a separate decision made in code. Said here because this is the moment somebody needs it,
	// and only of a collection Anthers is not already writing, since re-publishing one it writes
	// changes nothing about that.
	const writing = new Set<string>(PUBLISHED_LEXICONS);
	const collections = published.filter(
		(nsid) => !nsid.endsWith("Permissions") && !writing.has(nsid),
	);
	if (collections.length > 0 && !rehearsal) {
		console.log(
			"\nAnthers writes no records under these until they are added to PUBLISHED_LEXICONS in\n" +
				"apps/api/src/services/published-lexicons.ts:\n" +
				collections.map((nsid) => `  ${nsid}`).join("\n"),
		);
	}
}
