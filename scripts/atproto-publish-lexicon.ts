// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *     --service https://bsky.social --identifier anthers.org      # asks, then publishes
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the Lexicon JSON lives, relative to the repository root. */
const LEXICON_DIR = "lexicons";

export interface PublishPlan {
	nsid: string;
	/** The record key, which is the NSID itself. */
	rkey: string;
	/** The DNS name that has to carry the authority's DID for this schema to resolve. */
	authorityDomain: string;
	record: Record<string, unknown>;
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
	const plans: PublishPlan[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.endsWith(".json")) continue;
			const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const nsid = doc.id as string;
			if (typeof nsid !== "string") throw new Error(`${path} has no \`id\``);
			plans.push({
				nsid,
				rkey: nsid,
				authorityDomain: lexiconAuthorityDomain(nsid),
				// The document verbatim, with `$type` added and nothing removed.
				record: { $type: "com.atproto.lexicon.schema", ...doc },
			});
		}
	};
	walk(root);
	return plans;
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
	// retyping it now.
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

/** Render a plan for a person deciding whether to go ahead. */
export function describePlan(plan: PublishPlan): string {
	return [
		`  ${plan.nsid}`,
		`    rkey       ${plan.rkey}`,
		`    resolves via  ${plan.authorityDomain}  (must hold the publishing account's DID)`,
		`    record     ${JSON.stringify(plan.record).length} bytes, ${Object.keys(plan.record).length} top-level keys`,
	].join("\n");
}

if (import.meta.main) {
	const plans = collectPlans();
	const decision = decide(Bun.argv.slice(2), process.env, {
		hasTty: Boolean(process.stdin.isTTY),
		plans,
	});

	if (isRefusal(decision)) {
		console.error(`\nrefused: ${decision.refuse}\n`);
		process.exit(1);
	}

	console.log(`\nLexicons found (${decision.plans.length}):\n`);
	for (const plan of decision.plans) console.log(`${describePlan(plan)}\n`);

	if (!decision.write) {
		console.log("Nothing was written. Pass --write, --service and --identifier to publish.\n");
		console.log("🛑 Publishing is irreversible: a published field can never be renamed,");
		console.log("   retyped, made required or removed. Read the Lexicon first.\n");
		process.exit(0);
	}

	// The write path is deliberately the shortest part of this file, and it is not reached
	// without a person having typed the NSID back at the prompt below.
	const { sessionWriter } = await import("./atproto-writer.js");
	const argv = Bun.argv.slice(2);
	const flag = (n: string) => argv[argv.indexOf(`--${n}`) + 1];

	const published: string[] = [];
	for (const plan of decision.plans) {
		const typed = prompt(
			`\nType the NSID to publish it, or anything else to skip:\n  ${plan.nsid}\n> `,
		);
		if (typed !== plan.nsid) {
			console.log(`  skipped ${plan.nsid}`);
			continue;
		}
		const password = prompt("  password: ");
		if (!password) {
			console.log("  skipped (no password given)");
			continue;
		}
		const writer = await sessionWriter({
			service: flag("service"),
			identifier: flag("identifier"),
			password,
		});

		// The last gate, and the one a person cannot check by eye. Publishing into an account
		// the authority does not name produces a schema that never resolves while looking
		// entirely successful from this side.
		const txt = await resolveAuthorityTxt(plan.authorityDomain);
		if (!authorityNamesAccount(txt, writer.did)) {
			console.error(
				`  refused: ${plan.authorityDomain} does not name ${writer.did}\n` +
					`           it holds: ${txt.length > 0 ? txt.join(", ") : "(nothing)"}\n` +
					`           publishing here would produce a schema that never resolves.`,
			);
			continue;
		}

		console.log(`  publishing as ${writer.did}, named by ${plan.authorityDomain}`);
		const ref = await writer.putRecord("com.atproto.lexicon.schema", plan.rkey, plan.record);
		console.log(`  published ${ref.uri}`);
		published.push(plan.nsid);
	}

	// ⚠️ Publishing a schema does not start Anthers writing records under it, on purpose: that is
	// a separate decision made in code. Said here because this is the moment somebody needs it.
	const collections = published.filter((nsid) => !nsid.endsWith("Permissions"));
	if (collections.length > 0) {
		console.log(
			"\nAnthers writes no records under these until they are added to PUBLISHED_LEXICONS in\n" +
				"apps/api/src/services/published-lexicons.ts:\n" +
				collections.map((nsid) => `  ${nsid}`).join("\n"),
		);
	}
}
