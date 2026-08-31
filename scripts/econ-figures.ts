// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Render every published money figure from the model, into both places that quote it.
 *
 *   bun run econ:figures           # write — the repo's own figures and blocks
 *   bun run econ:figures --check   # fail if anything has drifted (CI / make verify)
 *   make wiki-figures              # ALSO render the wiki's blocks, into the vault
 *   make wiki-figures CHECK=1      # ...and fail if any of those has drifted
 *
 * ⚠️ **The wiki half is opt-in and deliberately outside `make verify`** (2026-08-30). It
 * needs an Obsidian vault that only Parker has, so CI took the skip path on every run it
 * ever had — while on the machine that does have one, reorganizing the notes broke the
 * build twice in a day. Run it before publishing anything that quotes a wiki table. The
 * full reasoning is at the bottom of this file, beside the code it governs.
 *
 * Three outputs, of which only the third needs a vault:
 *
 *  1. `packages/shared/src/figures.generated.ts` — plain numbers for the app. Plain,
 *     because **the SPA bundle must never import `fees.ts`**: that is the one import
 *     that pulls decimal.js in. Generating the figures gets derivation without the
 *     dependency, which is why this is a codegen step rather than a runtime import.
 *
 *     To check that it stayed out, grep the built bundle for **`toFraction`** — 0 on a
 *     clean build, and the only one of these that still means anything.
 *
 *     Two obvious checks are WRONG, both because another dependency ships the string:
 *     `toDecimalPlaces` is decimal.js-light's own method, which recharts pulls in (it
 *     fooled me on 2026-08-08), and `cbrt` is a Stan built-in sitting in the keyword
 *     list `react-syntax-highlighter` ships — it reads `…,"cauchy_rng","cbrt","ceil",…`
 *     in the highlighter chunk. Each returns 1 on a bundle with no leak in it.
 *
 *     This block recommended `cbrt` until 2026-08-19, by which point it had been a
 *     false positive for a week. **A leak check is only as good as its last run**: if
 *     one of these ever returns a hit, confirm what the hit IS before believing it.
 *
 *  2. The money section of this repo's own `README.md`, written between HTML-comment
 *     markers. Every clone has it and CI checks it, so it runs unconditionally.
 *
 * And one guard, which is neither:
 *
 *  3. A scan of the app source and the repo's published markdown for figures that were
 *     TYPED rather than read from (1), plus copy describing a mechanism the code no
 *     longer has. Markers are how a generated region gets covered, because markdown
 *     cannot import; everything around it needs the opposite shape — not "regenerate
 *     this region" but "no region may hold a typed figure at all". See `scanApp` /
 *     `scanDocs`, which share `scanText`.
 *
 * And the opt-in half:
 *
 *  4. The wiki's tables and sample receipts — 18 blocks across 9 documents in the
 *     Obsidian vault, written between the same HTML-comment markers, and only with
 *     `--wiki`. Same pattern the vault already uses for roadmap bars: generated regions
 *     are never hand-edited. `findWiki` locates the project root, and everything that
 *     apparatus needs — `ANTHERS_VAULT`, `PROJECT_DIR`, `isProjectRoot` — exists solely
 *     to serve this one job, and would be deleted outright by moving the wiki into the
 *     repository.
 *
 * Why it exists: the 2026-08-03 pricing revamp swept these by hand and missed three
 * of them, which then sat in the "source of truth" doc overstating the remainder by
 * exactly the card fee for five days. A sweep cannot be trusted to be complete.
 *
 * Why (3) exists: because (1) and (2) were both green on 2026-08-12 while five
 * marketing pages published $9.40 against a model that said $9.41, and still called
 * the buyer's first download a deduction four months after it stopped being one.
 * A generated-figures guard only covers what it is pointed at, and nothing said the
 * app was outside it.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	CARD_FLAT,
	CARD_RATE,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	formatMultiple,
	PUBLIC_ACCESS_PRICE,
	SALES_TAX_RATE,
	stickerBudgetFor,
	storageGibFor,
	TIME_POOL_RATE,
	timePoolFor,
} from "../packages/shared/src/constants.js";
import { FREE_PUBLIC_ACCESS_HOURS } from "../packages/shared/src/public-access.js";
import {
	badgeTable,
	cartSaving,
	creatorReceipt,
	creatorSegments,
	directedSupportWorstCase,
	edBandSensitivity,
	freePotSensitivity,
	growthLadder,
	MODELLED_PAYING_SHARE,
	PAYING_BADGE_MIX,
	payingShareSensitivity,
	purchaseExamples,
	RIVAL_STOREFRONTS,
	salaryLandmarks,
	saleTable,
	sampleReceipt,
	seedMixSensitivity,
	selfSufficiency,
	takeHomeComparison,
} from "../packages/shared/src/scenarios.js";

const REPO = join(import.meta.dir, "..");

/** The Obsidian vault, if this machine has one. Its *contents* move; this doesn't. */
const OBSIDIAN = join(process.env.HOME ?? "", "Obsidian");

/**
 * The **public** wiki — a second Obsidian vault, holding the documentation written to be
 * read by anyone rather than by us. Added 2026-08-30, when the Anthers documentation began
 * moving out of Parker's personal vault into a vault of its own.
 *
 * ⭐ **It needs none of `findWiki`'s discovery apparatus, and that is the point of it being
 * separate rather than a second entry in the same search.** Everything below `findWiki` — the
 * project-root regex, the area-directory marker, the found-twice failure — exists because the
 * project's folder *moves inside a personal vault whose shape is nobody's build input*. This
 * vault **is** the project root, at a path that is its own reason to exist, so the resolution
 * is one `existsSync`.
 *
 * ⚠️ **The absent-versus-broken discipline still applies and is what the override is for.**
 * No vault on this machine (CI, a contributor's clone) skips silently and correctly. But
 * `ANTHERS_WIKI` set to a path that does not exist is a **failure**, exactly as `ANTHERS_VAULT`
 * is — an explicit pointer must never degrade into a skip. And a vault that *is* present with a
 * block target missing fails in `writeBlocks`, which is the behavior that already catches a
 * renamed document.
 */
const PUBLIC_WIKI = join(process.env.HOME ?? "", "Anthers-Wiki");

/**
 * Where the wiki lives — **discovered, never hardcoded**.
 *
 * 🚨 **This was a literal path until 2026-08-28, and moving the project inside the vault
 * silently switched half of this script off.** `--check` printed *"(vault not present —
 * skipping wiki blocks)"* and **exited 0**, so every generated money table in the wiki
 * stopped being regenerated and stopped being checked, with nothing to notice. That is the
 * exact failure this file exists to prevent, one level up from the ones it catches — and
 * the same shape as the renamed document that `writeBlocks` was taught to fail on, except
 * that losing the *root* loses every target at once.
 *
 * ⚠️ **The bug was conflating two states that look alike and mean opposite things.** A
 * machine with no vault (CI, any contributor's clone) *should* skip the wiki silently.
 * A machine with a vault we cannot find inside is **broken**, and must say so. One
 * `existsSync` on a path that encoded both the vault and the project answered "skip" to
 * both, so a wrong path was indistinguishable from no path.
 *
 * Resolution, in order:
 *   1. `ANTHERS_VAULT`, for an explicit override. If it is set and wrong, that is a
 *      **failure** — an explicit pointer must never degrade into a skip.
 *   2. No `~/Obsidian` at all → skip, silently and correctly.
 *   3. Otherwise search the vault for the project root. Not found, or found twice → a
 *      failure naming what was searched.
 */
function findWiki(): { path: string } | { skip: true } | { error: string } {
	const override = process.env.ANTHERS_VAULT;
	if (override) {
		return existsSync(override)
			? { path: override }
			: { error: `ANTHERS_VAULT is set to "${override}", which does not exist` };
	}
	if (!existsSync(OBSIDIAN)) return { skip: true };

	const found = searchVault(OBSIDIAN, 4);
	if (found.length === 1) return { path: found[0] };
	if (found.length === 0) {
		return {
			error:
				`the vault at ${OBSIDIAN} has no project root matching ${PROJECT_DIR} in it ` +
				`(moved out of the vault, or renamed? set ANTHERS_VAULT to point at it)`,
		};
	}
	return {
		error:
			`found ${found.length} candidate project roots and cannot choose between them ` +
			`(${found.map((p) => relative(OBSIDIAN, p)).join(", ")}) — set ANTHERS_VAULT`,
	};
}

/**
 * The folder the project lives in, wherever inside the vault it has been filed.
 *
 * ⚠️ **The name carries an optional Johnny-Decimal number**, because on 2026-08-30 the root
 * became `30-39 Anthers Projects/30 Anthers` and an exact match on `Anthers` stopped finding
 * it. The guard behaved correctly — it failed loudly and said the root had been "moved out of
 * the vault, or renamed?" rather than skipping — but every `make verify` on a machine with the
 * vault went red, including the pre-push hook, so it had to be taught the new shape.
 *
 * 🚨 **Matching "any directory whose name contains Anthers" was considered and rejected.** The
 * same reorganization created `31 Anthers-Brand`, `32 Anthers-Desktop`, `33 Anthers-Meta`,
 * `34 Anthers-Node` and `35 Anthers-Wiki` as siblings. They are empty today, so the area-
 * directory marker below would exclude them — but they are obviously going to be filled, and
 * the first one that gains a `00-09 Meta` would turn this into a permanent found-twice
 * failure. A tight pattern that fails loudly when the name changes again is better than a
 * loose one that starts matching the neighbours.
 */
const PROJECT_DIR = /^(?:\d{2} )?Anthers$/;

/**
 * The public wiki, or a reason there is nothing to do. See {@link PUBLIC_WIKI}.
 */
function findPublicWiki(): { path: string } | { skip: true } | { error: string } {
	const override = process.env.ANTHERS_WIKI;
	if (override) {
		return existsSync(override)
			? { path: override }
			: { error: `ANTHERS_WIKI is set to "${override}", which does not exist` };
	}
	return existsSync(PUBLIC_WIKI) ? { path: PUBLIC_WIKI } : { skip: true };
}

/**
 * Every `Anthers/` folder in the vault that looks like the project root.
 *
 * ⚠️ **The marker is a Johnny-Decimal area (`00-09 Meta`, `40-49 Architecture`, …),
 * deliberately not one of the files in `BLOCKS`.** Validating against a block target would
 * make *renaming a document* read as *losing the vault*, which reports the wrong problem —
 * and `writeBlocks` already fails loudly and by name on a renamed target, so that case is
 * covered better one layer down. An area prefix survives every renumbering below it.
 */
function searchVault(dir: string, depth: number): string[] {
	if (depth < 0) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // Unreadable (permissions, a broken symlink) is not a match.
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (PROJECT_DIR.test(entry.name) && isProjectRoot(path)) out.push(path);
		else out.push(...searchVault(path, depth - 1));
	}
	return out;
}

/**
 * A Johnny-Decimal area directory inside it — `00-09 Meta`, `50-59 Business and Finance` —
 * **and at least one document under it.**
 *
 * 🚨 **The second half was added on 2026-08-30, after an empty husk broke every local
 * `make verify` on the machine that had the vault.** Reorganizing the vault in Obsidian
 * left `40-59 PhD Projects/Anthers/00-09 Meta/Tasks/Active` behind — three nested
 * directories and **zero files** — beside the real root at its new home. The area test
 * above passed on both, `findWiki` reported two candidates and refused to choose, and it
 * was right to: on the evidence it had, they were indistinguishable.
 *
 * ⭐ **An empty directory tree is the characteristic residue of a move**, so this will
 * happen again every time the vault is reorganized; a wiki with no documents in it is not
 * a wiki, and saying so is what makes the discovery survive the next one. Note the
 * refusal is still the correct behavior for two *real* roots — this narrows what counts
 * as a root rather than loosening what happens when there are two.
 *
 * The scan is recursive and unbounded, which is affordable because it runs only on a
 * directory that already matched `PROJECT_DIR`, and it stops at the first hit.
 */
function isProjectRoot(path: string): boolean {
	try {
		const hasArea = readdirSync(path, { withFileTypes: true }).some(
			(e) => e.isDirectory() && /^\d{2}-\d{2} /.test(e.name),
		);
		if (!hasArea) return false;
		for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) return true;
		}
		return false;
	} catch {
		return false;
	}
}

const check = process.argv.includes("--check");
/**
 * Whether to render the wiki's generated blocks, which live in Parker's Obsidian vault.
 *
 * Opt-in since 2026-08-30, and **`make verify` does not pass it** — see the long note at
 * the bottom of this file for why. In short: a runner has no vault, so this half was never
 * enforced in CI, while on the one machine that does have a vault it failed whenever the
 * notes were reorganized. Run `make wiki-figures` to write them, and `make wiki-figures
 * CHECK=1` to assert they are current before publishing anything that quotes them.
 */
const wikiRequested = process.argv.includes("--wiki");
/** Generated regions that no longer match what the model says. */
const failures: string[] = [];
/** Published figures found typed into the app by hand. */
const typed: string[] = [];
/** App copy describing a charge the model no longer has. */
const retired: string[] = [];
/** Files carrying `econ:allow-file`, reported every run so an exemption stays visible. */
const exempt: string[] = [];

/**
 * Run the rendered module through Biome before writing it.
 *
 * Without this the generator and the linter disagree — `--check` passes while
 * `bun run lint` fails on the file the generator just produced, which is a
 * maddening way to break the build. Formatting here means the two can never
 * diverge, whatever Biome's style settings become later.
 */
async function formatted(source: string): Promise<string> {
	const proc = Bun.spawn(["bunx", "biome", "format", "--stdin-file-path=figures.generated.ts"], {
		stdin: new TextEncoder().encode(source),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) {
		console.error(await new Response(proc.stderr).text());
		throw new Error("biome format failed on the generated module");
	}
	return out;
}

// ── 1. The generated module the app reads ────────────────────────────────────
function renderModule(): string {
	const badges = badgeTable();
	const sales = saleTable();
	const receipt = sampleReceipt();
	const seed = directedSupportWorstCase();
	const j = (v: unknown) => JSON.stringify(v, null, "\t").replace(/\n/g, "\n");
	return `// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GENERATED by scripts/econ-figures.ts — do not edit.
// Run \`bun run econ:figures\` after changing a dial in constants.ts or a formula
// in fees.ts. \`make verify\` fails if this file is stale.
//
// These are plain numbers on purpose: the app must not import fees.ts, which would
// pull decimal.js into the SPA bundle. Derivation happens at build time instead.

/**
 * Per-Badge decomposition of the monthly charge. Exact, not illustrative — it stopped
 * depending on a reference streamer's watch-hours when the bandwidth term went.
 */
export const BADGE_TABLE = ${j(badges)} as const;

/**
 * Direct-sale take-homes. \`sizeGiB\` is context for the row, NOT an input to the money:
 * delivery is free, so two rows at the same price agree whatever their size.
 */
export const SALE_TABLE = ${j(sales)} as const;

/** The sample monthly receipt: a Sprout who also directs $6 to creators. */
export const SAMPLE_RECEIPT = ${j(receipt)} as const;

/** A lone $3 to one creator — the worst case, and what creator-facing copy quotes. */
export const DIRECTED_SUPPORT_WORST_CASE = ${j(seed)} as const;

/**
 * The storefronts a creator actually compares us with, and their revenue share.
 *
 * Generated rather than typed into the Studio because 63.01 § Comparisons binds every
 * comparison to **all-in against all-in** — a rival's take-home has to be computed from
 * the same card fee ours is, and must move when that fee moves. \`absorbsProcessing\` is
 * Valve's model: their 30% covers the card cost, so nothing further comes off.
 *
 * ⚠️ **The rates themselves are perishable** and hand-maintained in \`scenarios.ts\`
 * (checked 2026-08-03). Generation guarantees the arithmetic, never the inputs.
 */
export const RIVAL_STOREFRONTS = ${j(RIVAL_STOREFRONTS)} as const;
`;
}

// ── 2. The wiki blocks ───────────────────────────────────────────────────────

/**
 * Emit a table in the vault's house style: an empty trailing column and an empty
 * trailing row.
 *
 * Not decoration — it is a legibility rule for **edit mode**, which is where this
 * vault is actually read and written. Without them the rightmost column runs to the
 * edge of the pane and the last row abuts whatever follows. The vault's CLAUDE.md
 * requires generators to emit them precisely so a generated table doesn't fight the
 * convention on every run and produce a diff the moment a human touches the file.
 */
function table(head: string[], align: string[], rows: string[][]): string {
	const line = (cells: string[]) => `| ${cells.join(" | ")} |     |`;
	return [
		line(head),
		`|${align.map((a) => `${a}|`).join("")}---|`,
		...rows.map(line),
		`|${head.map(() => "  |").join("")}     |`,
	].join("\n");
}

/**
 * A plain markdown table, for the files that are read on GitHub rather than in Obsidian.
 *
 * Deliberately not `table()` above: that one emits the vault's trailing empty column and
 * row, which is a legibility rule for Obsidian's **edit mode** and reads as a rendering
 * bug anywhere else. Same data, different house style — so the README gets its own.
 */
function plainTable(head: string[], align: string[], rows: string[][]): string {
	return [
		`| ${head.join(" | ")} |`,
		`|${align.map((a) => `${a}|`).join("")}`,
		...rows.map((cells) => `| ${cells.join(" | ")} |`),
	].join("\n");
}

/**
 * The money section of the repo's own README.
 *
 * The README is the file most likely to be read by someone who has neither the vault nor
 * the app running, and until 2026-08-14 it was the *only* published surface with no guard
 * at all — so it taught a bandwidth allowance, a per-GiB rate and a pay-by-watch-time
 * Time Pool for two days after all three were deleted, in the repo's shop window. It has
 * a generated region now for the same reason the wiki does: a sweep cannot be trusted to
 * be complete, and the only figure that cannot drift is one nobody typed.
 */
function renderReadmeModelMarkdown(): string {
	const badges = badgeTable();
	const sales = [...new Map(saleTable().map((r) => [r.price, r])).values()];
	const seed = directedSupportWorstCase();
	return [
		`**Where what you give Anthers goes.** Every row conserves exactly — creator pay plus the at-cost card line plus what is left equals what you paid. The remainder is the residual, so it absorbs any change in the other two while creator pay stays fixed.`,
		"",
		plainTable(
			["Badge", "You pay", "Time Pool → creators", "Payments\\*", "Free access & programs"],
			[":--", "--:", "--:", "--:", "--:"],
			badges.map((r) => [
				`**${r.badge}**`,
				`$${r.charge}`,
				`$${r.timePool}`,
				`$${r.payments}`,
				`**$${r.remainder}**`,
			]),
		),
		"",
		`\\* Card processing, at ${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)}, paid to Stripe and charged once per transaction. The flat part does not scale with the amount, which is why the remainder grows faster than linearly. **No row depends on how much anyone watches** — delivery costs $0 at any volume, so these are exact figures rather than a scenario.`,
		"",
		`Every account watches **${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, free forever** — no trial, no expiry. **$${PUBLIC_ACCESS_PRICE} a month to Anthers removes the limit**, and nothing above it buys any more access.`,
		"",
		`**What a creator takes home.** Anthers keeps **$0.00** from every row; the only deduction is Stripe's card fee.`,
		"",
		plainTable(
			["Sale", "Creator receives", "Card"],
			[":--", "--:", "--:"],
			sales.map((r) => [
				`$${r.price} ${r.sizeGiB > 0 ? "digital" : "physical"}`,
				`**$${r.creatorReceives}**`,
				`$${r.cardFee}`,
			]),
		),
		"",
		`A directed $${seed.gross} a month is the same shape: $${seed.gross} gross, $${seed.cardFee} card, **$${seed.net}** to the creator — that being the worst case, since batching several destinations onto one monthly charge pays every creator on it more. Download size does not appear because it changes nothing: every download of a purchased work is included, forever, on any number of devices. Creator storage is the only creator-side charge — the first ${FREE_STORAGE_GIB} GiB free, then the object-store rate plus half again, and that half is what funds free access and the programs.`,
	].join("\n");
}

/**
 * The Badge ladder, for a reader who already holds the context.
 *
 * ⚠️ **The public wiki gets {@link renderBadgePublicMarkdown} instead, and the difference is
 * not tone.** The last paragraph here explains the table by naming a *Bandwidth* column that
 * was removed on 2026-08-12 — which is exactly the edit history a public document must not
 * carry, and it is unusually hard to notice, because a generated block is the one part of a
 * page nobody proofreads. It published into the public wiki once, on the first run after that
 * vault was wired up, which is how this was found.
 *
 * 🚨 **A renderer is copy, and copy has an audience.** Any block rendered into both vaults has
 * to be read as though it were written fresh for the public one, because that is where it will
 * be judged.
 */
function renderBadgeMarkdown(): string {
	const rows = badgeTable();
	return [
		table(
			["Badge", "Monthly to Anthers", "Charge", "Time Pool", "Payments\\*", "→ Remainder"],
			[":--", "--:", "--:", "--:", "--:", "--:"],
			rows.map((r) => [
				`**${r.badge}**`,
				`$${r.monthly}`,
				`$${r.charge}`,
				`$${r.timePool}`,
				`$${r.payments}`,
				`**$${r.remainder}**`,
			]),
		),
		"",
		`\\* **Payments is INSIDE the charge** (since 2026-08-03), charged once per transaction at ${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)} and split pro-rata. Because the $${CARD_FLAT.toFixed(2)} is fixed per charge rather than per destination, it does not scale with the amount — which is why the remainder grows faster than linearly.`,
		"",
		`Every row conserves exactly: Time Pool + Payments + remainder = the charge. **The remainder is the residual**, so it absorbs any change in the other two while creator pay stays fixed.`,
		"",
		`**No row depends on how much anyone watches.** A *Bandwidth* column sat between the charge and the Time Pool until 2026-08-12, priced off a representative streamer's hours — so every remainder here was a scenario rather than a figure. Delivery costs $0 on R2 at any volume, so the column is gone and these numbers are exact. Watching more is free, and it takes nothing from the mission.`,
	].join("\n");
}

/**
 * The same ladder, for someone who has never read anything else we wrote. See the warning on
 * {@link renderBadgeMarkdown} for why this exists rather than the two sharing one renderer.
 *
 * The figures are identical and come from the same `badgeTable()` — what differs is that
 * nothing here dates a change, names a mechanism we no longer have, or names a vendor.
 */
function renderBadgePublicMarkdown(): string {
	const rows = badgeTable();
	return [
		table(
			[
				"Badge",
				"A month to Anthers",
				"To the Time Pool",
				"Card processing",
				"Free access & programs",
			],
			[":--", "--:", "--:", "--:", "--:"],
			rows.map((r) => [
				`**${r.badge}**`,
				`$${r.charge}`,
				`$${r.timePool}`,
				`$${r.payments}`,
				`**$${r.remainder}**`,
			]),
		),
		"",
		`Every row adds up exactly: what reaches creators, plus the cost of processing the card, plus what funds free access and the programs, equals what you paid. Card processing is ${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)}, charged once on your whole monthly payment rather than once per destination, and paid to the payment processor rather than kept.`,
		"",
		`Because that $${CARD_FLAT.toFixed(2)} is fixed per payment, it does not grow with the amount — which is why the last column grows faster than the rung does. **No row depends on how much you watch**, because delivery costs nothing at any volume.`,
	].join("\n");
}

/**
 * What each rung of Anthers' own ladder carries, for a public reader.
 *
 * 🚨 **Two of these five columns are LIVE and three are COMMITTED AND UNBUILT**, and the
 * table says so per column rather than in a footnote, because a reader scanning rows would
 * otherwise take the whole thing as a description of today. Public Access and the Time Pool
 * ship; the Sticker budget, the storage floor and purchase preservation do not.
 *
 * ⚠️ **This block exists so the unbuilt figures are DERIVED rather than typed.**
 * `stickerBudgetFor` and `storageGibFor` both carry that instruction in their own doc
 * comments — a marketing page quoting a Sticker budget must get it from the dial, not from
 * a document that was right when it was written. It is not evidence any of it ships.
 *
 * ⭐ **The Sticker budget is carved OUT of the Time Pool, not added beside it**, so those
 * two columns overlap by design and the note under the table has to say so — otherwise the
 * row reads as though a Root account sends $2.00 to creators when it sends $1.50.
 */
function renderPerkLadderMarkdown(): string {
	const rows = badgeTable();
	return [
		table(
			["Rung", "A month to Anthers", "Free viewing", "To the Time Pool", "Stickers", "Storage"],
			[":--", "--:", ":--", "--:", "--:", "--:"],
			[
				[
					"*(no Badge)*",
					"$0",
					`${FREE_PUBLIC_ACCESS_HOURS} hrs/mo`,
					`$${FREE_TIME_POOL.toFixed(2)}`,
					"—",
					`${FREE_STORAGE_GIB} GiB`,
				],
				...rows.map((r) => [
					`**${r.badge}**`,
					`$${r.monthly}`,
					"unlimited",
					`$${r.timePool}`,
					`$${stickerBudgetFor(r.monthly).toFixed(2)}`,
					`${storageGibFor(r.monthly)} GiB`,
				]),
			],
		),
		"",
		"**Free viewing and the Time Pool are live today. Stickers and the storage floor are committed and not built yet.**",
		"",
		`A free account's Time Pool is paid by Anthers on its behalf, and its ${FREE_STORAGE_GIB} GiB holds a creator's catalog only — so an account that has never published anything has no storage of its own until the first rung, where the same floor becomes usable for what you keep.`,
		"",
		"**The Sticker budget is carved out of the Time Pool rather than added to it.** A Sticker is money already on its way to creators, redirected by you to a particular one; anything you do not spend rejoins the pool at the end of the month and is shared out by time as usual. So the two columns overlap on purpose, and giving no Stickers costs creators nothing.",
	].join("\n");
}

function renderReceiptMarkdown(): string {
	const r = sampleReceipt();
	const pad = (label: string, amount: string) =>
		`${label}${" ".repeat(Math.max(1, 62 - label.length - amount.length))}${amount}`;
	return [
		"```",
		"Your Anthers — February 2026",
		"",
		"━".repeat(66),
		pad(`To creators (directed by you)`, `$${r.directedGross}`),
		pad(
			`  → reaching them, less their $${r.paymentsCreator} share of the card fee`,
			`$${r.directedNet}`,
		),
		"",
		pad(`To Anthers (Sprout)`, `$${r.anthersDollars.toFixed(2)}`),
		// "creators you spent time with", not "creators you watched", and "by time" rather
		// than "by watch-time": the platform hosts four media and measures them on one
		// clock. Naming the video one makes it the default unit of a thing it is a quarter
		// of. This is a GENERATED block, so editing the wiki by hand is worse than useless —
		// the next `econ:figures` run puts the old wording straight back.
		pad("  Time Pool → creators you spent time with (by time)", `$${r.timePool}`),
		pad("  Payments → this side's share of the card fee (at cost)", `$${r.paymentsAnthers}`),
		pad("  Free access & programs (the remainder)", `$${r.remainder}`),
		"─".repeat(66),
		pad("Support subtotal (all-in)", `$${r.supportSubtotal}`),
		pad(
			`Sales tax (${(SALES_TAX_RATE * 100).toFixed(1)}%, the only thing added on top)`,
			`+$${r.salesTax}`,
		),
		`${" ".repeat(56)}──────`,
		pad("Total billed (prepaid, monthly)", `$${r.totalBilled}`),
		"",
		`To creators this month: $${r.toCreators}  ·  Free access & programs: $${r.remainder}  ·  Anthers keeps: $0.00`,
		"```",
	].join("\n");
}

function renderSaleMarkdown(): string {
	// One row per list price. Size used to split them — a $10 1 GiB game and a $10
	// 2 GiB game took home different amounts — and since 2026-08-12 it doesn't, so
	// keeping both would print the same row twice.
	const rows = [...new Map(saleTable().map((r) => [r.price, r])).values()];
	const seed = directedSupportWorstCase();
	return [
		table(
			["Sale", "Creator receives", "Card"],
			[":--", "--:", "--:"],
			rows.map((r) => [
				`$${r.price} ${r.sizeGiB > 0 ? "digital" : "physical"}`,
				`**$${r.creatorReceives}**`,
				`$${r.cardFee}`,
			]),
		),
		"",
		`**Download size does not appear, because it no longer changes anything.** A digital sale used to carry the first download's bandwidth at cost, and redownloads drew the buyer's own allowance; delivery is free on R2, so every download of a purchased work is included, forever, on any number of devices.`,
		"",
		`A lone directed $${seed.gross} a month is the same shape: $${seed.gross} gross, $${seed.cardFee} card, **$${seed.net}** to the creator. Batching every destination onto one monthly charge pays each creator on it more, because the $${CARD_FLAT.toFixed(2)} is fixed per charge.`,
		"",
		`Anthers keeps **$0.00** from every row. Creator storage is the only creator-side charge: the first ${FREE_STORAGE_GIB} GiB free, then the object-store rate plus half again.`,
	].join("\n");
}

/**
 * The same sale figures, for the public wiki. Sibling of {@link renderBadgePublicMarkdown},
 * and the second instance of the same lesson.
 *
 * ⭐ **`allowRetired` on a public-wiki block is a contradiction, and it is the signal to
 * watch for.** The exemption exists to license a deliberately historical sentence for a
 * reader who was there — the paragraph above explaining that download size *used to* split
 * these rows. A public document has no such license: it states what is true and deletes what
 * is not, so a public block that needs the exemption is a public block carrying somebody
 * else's changelog. **Reach for a public renderer rather than an exemption.**
 */
function renderSalePublicMarkdown(): string {
	const rows = [...new Map(saleTable().map((r) => [r.price, r])).values()];
	const seed = directedSupportWorstCase();
	return [
		table(
			["Sale price", "The creator receives", "Card processing"],
			[":--", "--:", "--:"],
			rows.map((r) => [
				`$${r.price} ${r.sizeGiB > 0 ? "digital" : "physical"}`,
				`**$${r.creatorReceives}**`,
				`$${r.cardFee}`,
			]),
		),
		"",
		`**Anthers keeps $0.00 from every row.** The only deduction is card processing, which is paid to the payment processor rather than kept, and it is inside the price the buyer saw rather than added to it.`,
		"",
		`Monthly support has the same shape: of $${seed.gross} a month pointed at one creator, $${seed.cardFee} is card processing and **$${seed.net}** reaches them. Everything given in a month rides on one payment, so the $${CARD_FLAT.toFixed(2)} flat portion is paid once across every destination rather than once each — which is why supporting several creators together pays each of them more than supporting them separately would.`,
		"",
		`**File size does not appear here, because it changes nothing.** Delivery costs nothing at any volume, so every download of a purchased Work is included, forever, on as many devices as the buyer likes.`,
	].join("\n");
}

/**
 * The creator-facing worked examples, and what a cart is worth at the small end.
 *
 * This table is the one a creator reads before deciding whether to sell here, and it
 * was typed by hand in two docs — including the Copy Style Guide, inside the very rule
 * that forbids re-typing a figure from another page.
 */
function renderPurchaseExamplesMarkdown(): string {
	const rows = purchaseExamples();
	const cart = cartSaving();
	return [
		table(
			["Item", "List", "Size", "Card", "**Creator receives**", "Deduction"],
			[":--", "--:", "--:", "--:", "--:", "--:"],
			rows.map((r) => [
				r.item,
				`$${r.price}`,
				r.sizeLabel,
				`$${r.cardFee}`,
				`**$${r.creatorReceives}**`,
				r.deductionPct,
			]),
		),
		"",
		`**The deduction is Stripe's card fee and nothing else** — ${(CARD_RATE * 100).toFixed(1)}% + a flat $${CARD_FLAT.toFixed(2)}, paid to Stripe, with Anthers keeping $0.00 from every row. The flat part is what the percentages track: it is the whole reason a $${rows[0].price} track loses ${rows[0].deductionPct} while a $${rows[rows.length - 1].price} game loses ${rows[rows.length - 1].deductionPct}.`,
		"",
		`**Size is in the table for scale, not for money.** A digital sale used to deduct the first download's delivery at cost as well; delivery is free since 2026-08-12, so a ${rows[rows.length - 1].sizeLabel} work and a ${rows[0].sizeLabel} one at the same price pay their creator exactly the same, and every later download costs nobody anything.`,
		"",
		`**The cart is the mechanism that fixes the small end.** ${cart.count} $${cart.unitPrice} tracks bought separately lose **$${cart.separately}** to card fees; bought in one cart they lose **$${cart.inOneCart}**, and every cent of that difference goes to the creators.`,
	].join("\n");
}

/**
 * The same purchase examples, for a creator reading the public wiki. Third sibling of
 * {@link renderBadgePublicMarkdown}, and it was predicted by the same signal both times
 * before it: this block carries an `allowRetired`, so it was always going to be carrying a
 * sentence about a charge that no longer exists.
 *
 * ⚠️ **The size column stays and its caption changes.** Size is genuinely useful to a creator
 * sizing up the table — it is how they find the row that looks like their work — so the column
 * is not the problem. What had to go is the paragraph explaining that size *used to* change the
 * arithmetic, which answers a question only somebody who remembers the old model would ask.
 */
function renderPurchaseExamplesPublicMarkdown(): string {
	const rows = purchaseExamples();
	const cart = cartSaving();
	return [
		table(
			["Item", "You price it", "Size", "Card processing", "**You receive**", "Deduction"],
			[":--", "--:", "--:", "--:", "--:", "--:"],
			rows.map((r) => [
				r.label,
				`$${r.price}`,
				r.sizeLabel,
				`$${r.cardFee}`,
				`**$${r.creatorReceives}**`,
				r.deductionPct,
			]),
		),
		"",
		`**The deduction is card processing and nothing else** — ${(CARD_RATE * 100).toFixed(1)}% plus a flat $${CARD_FLAT.toFixed(2)}, paid to the payment processor, with Anthers keeping $0.00 from every row. The flat part is what the percentages track, and it is the whole reason a $${rows[0].price} track loses ${rows[0].deductionPct} while a $${rows[rows.length - 1].price} game loses ${rows[rows.length - 1].deductionPct}.`,
		"",
		`**Size is shown so you can find the row that looks like your work, and it does not affect what you earn.** A ${rows[rows.length - 1].sizeLabel} work and a ${rows[0].sizeLabel} one at the same price pay you exactly the same, and every download after the first costs nobody anything.`,
		"",
		`**Selling several things together is what fixes the small end.** ${cart.count} $${cart.unitPrice} tracks bought separately lose **$${cart.separately}** to card fees; bought in one basket they lose **$${cart.inOneCart}**, and every cent of that difference reaches you.`,
	].join("\n");
}

/** A mid-size creator's monthly earnings, and the only cost that comes out of them. */
function renderCreatorReceiptMarkdown(): string {
	const r = creatorReceipt();
	const pad = (label: string, amount: string) =>
		`${label}${" ".repeat(Math.max(1, 62 - label.length - amount.length))}${amount}`;
	return [
		"```",
		"Your Earnings — February 2026                              @saltandcompass",
		"",
		"━".repeat(66),
		pad("Time Pool (by time spent) + directed support (net of card)", `$${r.gross}`),
		pad(
			`Storage (${r.libraryGiB} GiB library − ${r.freeGiB} GiB free = ${r.billableGiB} GiB, at cost)`,
			`−$${r.storage}`,
		),
		pad("Delivery (unlimited, at any volume)", "$0.00"),
		pad("Storage charge (half again)", `−$${r.storageCharge}`),
		`${" ".repeat(54)}──────────`,
		pad("Net earnings", `$${r.net}`),
		"",
		"Payouts carry no processing (Connect transfers are free); the only",
		"deduction from directed support is its share of the card fee.",
		"```",
	].join("\n");
}

/** Whether the charitable budget funds itself, as a function of the paying share. */
function renderSelfSufficiencyMarkdown(): string {
	const s = selfSufficiency();
	// 🚨 **The keys are DOLLARS and the `$` is load-bearing.** This destructured them as
	// `seeds` and printed a bare number until 2026-08-29, so the block published "45% at 3,
	// 25% at 6, 14% at 9" one line below the words "$6.59 a month" — every figure correct and
	// every one of them reading as a count of the retired $3 Seed. The mix has been keyed in
	// dollars since 2026-08-16; nothing was wrong but the notation, which is the only part a
	// reader sees.
	//
	// Only the rungs carrying a whole percent: the mix spans ten and printing a rung at "0%"
	// would teach the reader it stops there, which is the opposite of true.
	const mix = Object.entries(PAYING_BADGE_MIX)
		.filter(([, share]) => Number(share) >= 0.01)
		.map(([amount, share]) => `${(Number(share) * 100).toFixed(0)}% at $${amount}`)
		.join(", ")
		.concat(", trailing off beyond that");
	return [
		`Charitable revenue is **$${s.revenuePerPayingUser} per paying user per month**, and each paying user also carries the free-access cost of the free users beside them — **$${s.freeUserCost}/month each**, which is the subsidized Time Pool a free account funds for the creators it watches. So everything turns on the **paying share**:`,
		"",
		table(
			["Paying share", "Net per paying user", "Self-funding at", "Full-time at"],
			["--:", "--:", "--:", "--:"],
			s.rows.map((r) => [
				r.sharePct,
				r.net.startsWith("-") ? `−$${r.net.slice(1)}` : `$${r.net}`,
				accounts(r.selfFunding),
				accounts(r.fullTime),
			]),
		),
		"",
		`**Below roughly ${s.breakEvenPct} paying, growth never closes the gap** — each new cohort costs more in free access than it brings in, so scale makes the problem worse rather than better. Above it the model self-funds, and the scale required falls away quickly.`,
		"",
		`**That floor no longer moves with how much free users watch**, and until 2026-08-12 it did. A free account's cost was its streaming bandwidth plus its Time Pool, so the generosity of the free floor and the platform's self-sufficiency were the same dial and raising one priced the other. Delivery is free on R2, the floor is gone, and what remains — the $${s.freeUserCost} Time Pool — is a flat cost per free account however much it watches. **Free access stopped having a usage-dependent price.**`,
		"",
		`**Self-funding** is where the budget covers its obligations with no salary drawn; **full-time** is where it also affords an ED inside the Admin ceiling — 61.01's inflection 1. Both come from the same growth model the ladder does, so the two documents cannot disagree.`,
		"",
		`One ASSUMPTION drives every number here and it is not a dial: the paying-user Badge mix, a decay putting the average payer at **$${s.averageSupport} a month** (${mix}). It matters more than it looks — the remainder a paying user generates rises **faster than linearly** with the amount, because the fixed $${CARD_FLAT.toFixed(2)} of the card fee does not scale with it. Until 2026-08-16 this document and 61.01 assumed **different mixes** and so published different floors; there is one model now.`,
	].join("\n");
}

/**
 * 62.04's headline table: what reaches a creator here versus on each storefront.
 *
 * This block is why the task existed. The Anthers column was a **hand-mirror** of the
 * generated figures — the doc said so in its own warning — and it went a cent low
 * everywhere the day the delivery charge was retired, because a mirror only reflects
 * when someone remembers to polish it. Two competitor cells were a cent out too, in
 * the other direction: they rounded the card fee at the end of the row while ours
 * rounded it first, so a single table disagreed with itself about one number.
 */
function renderTakeHomeMarkdown(): string {
	const rows = takeHomeComparison();
	const bold = (v: string | null, best: string) =>
		v === null ? "—" : v === best ? `**$${v}**` : `$${v}`;
	return [
		table(
			["List price", "**Anthers**", ...RIVAL_STOREFRONTS.map((r) => r.name)],
			["--:", ...RIVAL_STOREFRONTS.map(() => "--:"), "--:"],
			rows.map((r) => [
				`$${r.price}`,
				bold(r.anthers, r.best),
				...r.rivals.map((v) => bold(v.net, r.best)),
			]),
		),
		"",
		`Every column is **all-in take-home at the same list price** — each rival's figure includes the same ${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)} card cost we itemize, because every platform pays it. Comparing our all-in against a competitor's headline cut would flatter us exactly where a creator would check.`,
		"",
		`**The bold cell is the best row, and it is computed rather than chosen.** Steam returns more than us at $${rows[0].price}: their ${(RIVAL_STOREFRONTS[0].share * 100).toFixed(0)}% of a small sale is less than the flat card fee they absorb, so a percentage model beats a flat-fee model at the very bottom. Conceding that is what makes the rest of the table believable, and generating it means we cannot quietly stop conceding it when a dial moves.`,
		"",
		`⚠️ **Competitor rates are perishable** — they live in \`RIVAL_STOREFRONTS\` in \`packages/shared/src/scenarios.ts\`, were last checked 2026-08-03, and a storefront can change one without telling us. Re-check before anything ships. Only the arithmetic is guaranteed here; the rates are an input.`,
	].join("\n");
}

// ── The growth ladder (61.01) ────────────────────────────────────────────────
//
// These landmarks were hand-typed derived figures until 2026-08-16, produced by running a
// RETIRED HTML playground's `computeAll` headless and copying the answers across. 61.01
// said so in its own standing instruction, and had rotted twice in three days by the time
// it was acted on. The playground was also the only model carrying the per-rung ladder, so
// re-deriving a number meant reviving a file that had been retired to the Graveyard.
//
// The ceilings themselves are NOT generated and must not become so — they are policy,
// chosen in 61.01, and that is exactly what makes them safe to quote.

/**
 * Accounts, rounded the way a landmark should be read: to a scale, not to a person.
 *
 * Three significant figures rather than a fixed step, because these span four orders of
 * magnitude. A flat round-to-100 reads fine at 33,100 and **destroys** the small end —
 * the "platform stops costing Parker money" landmark at 239 accounts came out as ~200,
 * which is a different claim about the smallest and most decision-dense rung on the ladder.
 */
const accounts = (n: number | null) => {
	if (n === null) return "**never**";
	const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 2);
	return `~${(Math.round(n / mag) * mag).toLocaleString("en-US")}`;
};

/** A money string from `scenarios.ts` (always 2dp), grouped for reading. */
const usd = (s: string) =>
	`$${Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function renderLandmarksMarkdown(): string {
	const s = selfSufficiency();
	return [
		`Every figure below is derived from \`fees.ts\` through \`packages/shared/src/growth.ts\`, at the model's **${(MODELLED_PAYING_SHARE * 100).toFixed(0)}% paying share** and the shipped free-account Time Pool of **$${s.freeUserCost}**. They move when a dial moves, and \`bun run econ:figures --check\` fails CI if this block and the model disagree.`,
		"",
		table(
			["Landmark", "Accounts", "What it means"],
			[":--", "--:", ":--"],
			salaryLandmarks().map((l) => [l.label, accounts(l.accounts), l.note]),
		),
		"",
		`**Solvency and charity-health are different lines, and the gap is the whole design.** A full-time salary is affordable at ${accounts(salaryLandmarks()[2].accounts)} accounts and *responsible* at ${accounts(salaryLandmarks()[3].accounts)} — a factor of about ${(
			(salaryLandmarks()[3].accounts as number) / (salaryLandmarks()[2].accounts as number)
		).toFixed(
			1,
		)}. Paying at the solvency point would run Admin near two-thirds of charitable revenue in the same years the Form 1023 narrative is examined and the first 990s are filed, so **every salary landmark here uses the charity-health line.**`,
	].join("\n");
}

function renderLadderVerdictMarkdown(): string {
	return [
		`What the books say when standing on each ceiling, carrying that rung's own planned staffing. **The ceilings are policy and are not derived** — this is only the verdict beside them.`,
		"",
		table(
			["Phs", "Accounts", "Creators", "Staff/mo", "Admin", "Charity-healthy"],
			["--:", "--:", "--:", "--:", "--:", ":-:"],
			growthLadder().map((r) => [
				String(r.phase),
				r.accounts.toLocaleString("en-US"),
				r.creators.toLocaleString("en-US"),
				r.staff === 0 ? "—" : `$${r.staff.toLocaleString("en-US")}`,
				r.adminPct,
				r.adminHealthy ? "✅" : r.solvent ? "⚠️ solvent only" : "🚫 underwater",
			]),
		),
		"",
		`**Rungs 1–3 come back underwater on purpose.** That is Parker's own subsidy, and a model that hid it — by sizing each rung's plan to what that rung can afford — could only ever confirm itself. Admin's share then *declines* with scale, which is 50.01's stated design target.`,
	].join("\n");
}

function renderPayingShareMarkdown(): string {
	const rows = payingShareSensitivity();
	const floor = selfSufficiency().breakEvenPct;
	return [
		table(
			["Paying share", "Inflection 1"],
			["--:", "--:"],
			rows.map((r) => [
				r.share === MODELLED_PAYING_SHARE ? `**${r.sharePct}** *(model default)*` : r.sharePct,
				r.share === MODELLED_PAYING_SHARE ? `**${accounts(r.accounts)}**` : accounts(r.accounts),
			]),
		),
		"",
		`**Violently non-linear near the floor, and the reason is structural.** Above roughly 15% paying the binding constraint is the **Admin ≤ 30% ceiling**, which is a ratio of overhead to charitable *revenue* and cannot see the free-access pot at all — so the curve is gentle. Below that **solvency** binds, the pot enters, and the threshold runs away. Below **${floor} paying there is no scale that works**: each new cohort costs more in free access than it brings in, so growth makes the gap worse rather than better.`,
	].join("\n");
}

function renderSeedMixMarkdown(): string {
	const rows = seedMixSensitivity();
	const current = rows.find((r) => r.current);
	const collapse = rows[rows.length - 1];
	return [
		table(
			["Avg monthly support / payer", "Inflection 1"],
			["--:", "--:"],
			rows.map((r) => [
				r.current ? `**$${r.avgSeeds}** *(current assumption)*` : `$${r.avgSeeds}`,
				r.current ? `**${accounts(r.accounts)}**` : accounts(r.accounts),
			]),
		),
		"",
		`🚨 **The single biggest risk to the ladder is it flattening, not the economics.** Binary Public Access removes the reason to give Anthers more than the Public Access price, so the paying population slides toward exactly that unless something above it earns more. A near-total collapse to $${collapse.avgSeeds} a payer puts inflection 1 at ${accounts(collapse.accounts)} against ${accounts(current?.accounts ?? null)} today — **still worse than the ~57,500 of the pre-R2 world**, so the R2 windfall does not quite cover it, but by about ${(((collapse.accounts as number) / 57_500) * 100 - 100).toFixed(0)}% rather than the ninety it was once thought to be.`,
	].join("\n");
}

function renderEdBandMarkdown(): string {
	const rows = edBandSensitivity();
	return [
		table(
			["ED salary", "Inflection 1"],
			[":--", "--:"],
			rows.map((r) => [r.label, accounts(r.accounts)]),
		),
		"",
		`Still the single number with the most leverage on where the ladder's anchor falls — but no longer a painful choice: paying at the **top** of the ED band in Organizational Structure now reaches inflection 1 at ${accounts(rows[2].accounts)}, comfortably below where the **bottom** of the band landed under the pre-R2 economics (~57,500).`,
	].join("\n");
}

function renderCreatorSegmentsMarkdown(): string {
	const s = creatorSegments();
	return [
		`The modeled creator population at rung 10's ceiling — ${s.accounts.toLocaleString("en-US")} accounts, ${s.creators.toLocaleString("en-US")} creators. **Attention share** is what divides the Time Pool: not hours, because with unlimited Public Access a viewer's hours are a free variable while their contribution is fixed by what they give, so a per-hour rate is an emergent ratio nobody is paid at.`,
		"",
		table(
			["Segment", "Creators", "Attention", "Catalog", "Time Pool /mo", "Storage /mo", "Net /mo"],
			[":--", "--:", "--:", "--:", "--:", "--:", "--:"],
			s.rows.map((r) => [
				r.free ? `${r.name} *(subsidized)*` : r.name,
				r.count.toLocaleString("en-US"),
				r.attentionPct,
				`${r.storageGiB} GiB`,
				usd(r.earns),
				r.free ? "—" : usd(r.storage),
				usd(r.net),
			]),
		),
		"",
		`**Free creators' first ${FREE_STORAGE_GIB} GiB is a free-access obligation**, funded from what users give — the only cost line that scales with creators and is paid for by users. Everything above the free tier is the creator's own opt-in cost: the object-store rate plus half again, and nothing else, because delivery costs nobody anything.`,
	].join("\n");
}

/**
 * What each candidate free-account Time Pool pot costs, as the floor paying share.
 *
 * 11.03 carried these three by hand and they had been wrong twice — a table whose entire
 * purpose is to price a decision that has not been taken is exactly the table that must
 * not be typed. ⚠️ Note the reversal this generation produced: the revamp's own ~15.7%
 * for a $0.50 pot, which 11.03 recorded as "does not reproduce, do not carry forward",
 * **reproduces exactly** under the unified model. What did not reproduce was the four-rung
 * Badge mix `selfSufficiency()` used to assume, not the figure.
 */
function renderFreePotMarkdown(): string {
	const rows = freePotSensitivity();
	const shipped = rows.find((r) => r.shipped);
	return [
		table(
			["Free pot / account", "Creator earns, with support", "Floor paying share"],
			["--:", "--:", "--:"],
			rows.map((r) => [
				r.shipped ? `**$${r.pot}** *(shipped)*` : `$${r.pot}`,
				`${formatMultiple(r.multiple)} more`,
				r.shipped ? `**${r.floorPct}**` : r.floorPct,
			]),
		),
		"",
		`The pot is the single dial that sets **free-access cost per account**: cost is \`free accounts × this number\`, headcount times a policy figure, with no behavioral guess underneath it. Raising it sends more money to the creators a free viewer spends time with, and raises the share of payers needed to fund that — which is the whole of the trade. The shipped $${shipped?.pot} was chosen on an **asymmetry rather than a forecast**: it is a standing obligation to every free account, so raising it later is easy and climbing down from it in public is not.`,
	].join("\n");
}

interface Block {
	file: string;
	key: string;
	render: () => string;
	/**
	 * Why this block is exempt from the `RETIRED_COPY` self-check, when it is.
	 *
	 * A generated region **cannot carry an `econ:allow`** — the annotation would either be
	 * overwritten on the next run or become part of the published output — so the exemption
	 * has to live here, beside the renderer. Same contract as `econ:allow` otherwise: a
	 * reason is required, and every exemption is printed on every run.
	 *
	 * ⚠️ The legitimate use is a **historical** sentence: "a digital sale *used to* carry the
	 * first download's bandwidth" is true, and the word "first" is load-bearing — it names
	 * which download was charged. `NOT_NEGATED` cannot express past tense, and rewording
	 * around the guard would trade an accurate sentence for a passing one.
	 */
	allowRetired?: string;
}

const LADDER =
	"60-69 Governance & Strategy/61 Roadmap & Growth/61.01 Growth Phases and Join Quotas.md";

/**
 * Generated regions in markdown that lives in **this repository**.
 *
 * Kept apart from `BLOCKS` because of when each one runs: the wiki blocks are skipped
 * entirely when the vault is absent, which is correct for a document only Parker has and
 * exactly wrong for one every clone carries. CI has no vault, so a README block on the
 * wiki path would never once be checked — and "never checked" is the state the README was
 * already in.
 */
const REPO_BLOCKS: Block[] = [
	{ file: "README.md", key: "readme-model", render: renderReadmeModelMarkdown },
];

/**
 * Generated regions in the **public** wiki. See {@link PUBLIC_WIKI}.
 *
 * 🚨 **These are the highest-stakes blocks in the file, because their audience is not us.**
 * A stale figure in the private vault misleads the person who wrote it; a stale figure here
 * misleads someone deciding whether to trust the platform with their money, on a page whose
 * whole argument is that Anthers is straight about where the money goes.
 *
 * ⚠️ **Every money figure in the public wiki that is *not* inside one of these regions is
 * hand-typed and unguarded.** Several are, as of this writing — correct, because each was
 * checked against `fees.ts` when written, and unprotected against the next time a constant
 * moves. Pointing `scanDocs` at this vault is what closes that, and it is deliberately not in
 * this change: it will report real hits, and a guard turned on in the same commit as the work
 * it fails is a guard nobody can tell apart from a broken one.
 */
const PUBLIC_WIKI_BLOCKS: Block[] = [
	{
		file: "20-29 Using Anthers/21 Supporting Creators/21.01 Badges.md",
		key: "badge-table",
		render: renderBadgePublicMarkdown,
	},
	{
		file: "20-29 Using Anthers/21 Supporting Creators/21.01 Badges.md",
		key: "perk-ladder",
		render: renderPerkLadderMarkdown,
	},
	{
		file: "40-49 Where the Money Goes/40 The Support Model/40.00 The Support Model.md",
		key: "badge-table",
		render: renderBadgePublicMarkdown,
	},
	{
		file: "40-49 Where the Money Goes/40 The Support Model/40.00 The Support Model.md",
		key: "sample-receipt",
		render: renderReceiptMarkdown,
	},
	{
		file: "40-49 Where the Money Goes/40 The Support Model/40.01 What a Creator Takes Home.md",
		key: "sale-table",
		render: renderSalePublicMarkdown,
	},
	{
		file: "40-49 Where the Money Goes/40 The Support Model/40.01 What a Creator Takes Home.md",
		key: "creator-receipt",
		render: renderCreatorReceiptMarkdown,
	},
	{
		file: "30-39 Creating on Anthers/31 Getting Paid/31.01 Selling a Work.md",
		key: "purchase-examples",
		render: renderPurchaseExamplesPublicMarkdown,
	},
];

const BLOCKS: Block[] = [
	{
		file: "50-59 Business and Finance/50 Economics & Model/50.01 Support Model Economics and Milestones.md",
		key: "badge-table",
		render: renderBadgeMarkdown,
	},
	{
		file: "50-59 Business and Finance/50 Economics & Model/50.01 Support Model Economics and Milestones.md",
		key: "sample-receipt",
		render: renderReceiptMarkdown,
	},
	{
		file: "50-59 Business and Finance/50 Economics & Model/50.01 Support Model Economics and Milestones.md",
		key: "sale-table",
		render: renderSaleMarkdown,
		allowRetired:
			"names the retired first-download charge in the past tense, to explain why size left the table",
	},
	{
		file: "30-39 Creator Experience/31 Monetization/31.02 Direct Creator Purchases.md",
		key: "purchase-examples",
		render: renderPurchaseExamplesMarkdown,
		allowRetired:
			"names the retired first-download charge in the past tense, to explain why size is shown for scale only",
	},
	{
		file: "60-69 Governance & Strategy/63 Brand/63.01 Copy Style Guide.md",
		key: "sale-table",
		render: renderSaleMarkdown,
		allowRetired: "same renderer as 50.01's sale-table, and the same past-tense sentence",
	},
	{
		file: "50-59 Business and Finance/50 Economics & Model/50.01 Support Model Economics and Milestones.md",
		key: "creator-receipt",
		render: renderCreatorReceiptMarkdown,
	},
	{
		file: "10-19 Overview/11 Model & Mission/11.02 Free Access and Charitable Programs.md",
		key: "self-sufficiency",
		render: renderSelfSufficiencyMarkdown,
	},
	{
		file: "60-69 Governance & Strategy/62 Positioning & Audience/62.04 Creator Take-Home Comparisons.md",
		key: "take-home",
		render: renderTakeHomeMarkdown,
	},
	// The growth ladder. 61.01 is canonical for the RUNGS, which are policy and stay
	// hand-written; everything derived from them is generated here.
	{ file: LADDER, key: "growth-landmarks", render: renderLandmarksMarkdown },
	{ file: LADDER, key: "growth-ladder", render: renderLadderVerdictMarkdown },
	{ file: LADDER, key: "growth-paying-share", render: renderPayingShareMarkdown },
	{ file: LADDER, key: "growth-seed-mix", render: renderSeedMixMarkdown },
	{ file: LADDER, key: "growth-ed-band", render: renderEdBandMarkdown },
	{ file: LADDER, key: "growth-creator-segments", render: renderCreatorSegmentsMarkdown },
	{
		file: "10-19 Overview/11 Model & Mission/11.03 Open Questions re the Support Model.md",
		key: "free-pot",
		render: renderFreePotMarkdown,
	},
];

// ── 3. The app: a published figure may be DERIVED, never TYPED ───────────────
//
// The app reads its figures from `figures.generated.ts`, and an import cannot
// drift — so the residual risk is not a stale region, it is someone typing a
// number that is right today. This scan is what closes that, and it is worth being
// exact about the guarantee, because a guard whose reach is misread is how we got
// here in the first place:
//
//   It catches a published figure at the moment it is TYPED, while it still matches
//   the model. It does NOT recognize one that has already gone stale — $9.40 matches
//   nothing we publish now, so nothing here would have flagged it today. It would
//   have flagged it on the day it was written, when it was still correct.
//
// That is the right place to catch it. Typing is the defect; drifting is only what
// the defect eventually does.

/**
 * ⚠️ **`packages/db/src` is here for the seed data, and joined the list 2026-08-16.**
 * Not a page, but the seeds and the gauntlet are prose a developer reads to learn what
 * the model supports — and they had drifted exactly as the README did, for exactly the
 * same reason: outside the scan, so nothing looked. `seed.ts` carried a `pwyw` pricing
 * type and a work blurb promising pay-what-you-want, for a mechanism that has never
 * existed; the gauntlet printed a viewer's support as a Seed count. One sweep, then this
 * line, so it is the last time.
 *
 * Cheap to include because the scan blanks comments first: the schema identifiers that
 * legitimately say "seed" (`seed_allocations`, `BADGE_RUNGS`, `seedGatedAccess`) are code,
 * and every `RETIRED_COPY` pattern matches the word as prose rather than as an
 * identifier. Adding the root found one line and no false positives.
 */
const APP_ROOTS = ["apps/web/src", "packages/web-shared/src", "packages/db/src"];

/**
 * Markdown in this repo that is read by outsiders, and so is held to the same standard
 * as a page.
 *
 * The README needed **both** halves of the guard and had neither. It carried typed money
 * figures (a $0.01/GiB rate, a per-Badge Time Pool column) *and* retired-mechanism prose
 * with no number attached — "pays creators by watch-time", a bandwidth allowance, a Badge
 * that gated content — for anywhere from two days to five months after each mechanism was
 * deleted. It drifted precisely because `APP_ROOTS` is a list of `.ts`/`.tsx` directories
 * and nobody noticed the repo's shop window was outside it.
 *
 * 🚨 **It was `["README.md"]` — one file — until 2026-08-18, and the same reasoning that
 * added the README argued for all of it.** Fixing one file and leaving its neighbors
 * outside is how the gap reproduces: `packages/db/TEST_ACCOUNTS.md` was a **complete
 * description of the pre-retirement model** (a "Rank (Anthers-Seeds)" column, Anthers
 * Gates, Seed Gates, "whole $3 Seeds"), and `apps/web/tests/README.md` said "badge/Seed
 * billing" — both invisible for the same reason the README was, two days after a sweep
 * that reported the code half finished.
 *
 * The list is now every `.md` in the repo, discovered rather than enumerated, because an
 * enumerated list is a thing to forget to add to — which is the defect above, written as
 * a constant. There are ten of them, so the scan costs nothing.
 *
 * Widening found exactly one file's worth of drift and **no false positives**, including
 * across `LICENSE.md` and the two `THIRD-PARTY.md` files, which are verbatim third-party
 * text: none needed an `econ:allow-file`. That is the same result adding `packages/db/src`
 * to `APP_ROOTS` got, and for the same reason — these patterns match retired *copy*, and
 * copy is not what a license is made of.
 */
async function docFiles(): Promise<string[]> {
	const out: string[] = [];
	for await (const path of markdownFiles(REPO)) out.push(relative(REPO, path));
	return out.sort();
}

/**
 * Copy for a charge that no longer exists.
 *
 * This is NOT a copy linter — 63.01 is the guide, and adding every rule there to a
 * build script would rot. It is the second half of one specific defect, and it earns
 * its place because the figure scan above could not have found it: *"the only
 * deductions are card processing and your buyer's first download"* carries no number,
 * so a page can quote a perfectly current $9.41 while still describing a fee retired
 * four months earlier. That exact sentence survived this task's own sweep and turned
 * up in a bundle grep afterwards.
 *
 * The rule for adding one: a phrase belongs here when it describes a **mechanism the
 * code no longer has**, so that the only correct number of occurrences is zero.
 *
 * 🚨 **Every pattern must exclude the negation**, or the guard fires on the one use
 * that is always correct. *"No wallet, no per-GiB charge, however many devices you
 * use"* is exactly the sentence a retired charge should leave behind, and four pages
 * say some version of it. A first cut without the lookbehind flagged all four — which
 * would have taught us to annotate good copy rather than fix bad copy, and that is how
 * a guard becomes noise people route around.
 */
const NOT_NEGATED = /(?<!\b(?:no|never|not|without|nor|zero) )/.source;
const RETIRED_COPY: { pattern: RegExp; why: string }[] = [
	{
		// 🚨 The Seed retired as a FINANCIAL UNIT on 2026-08-16 — thresholds, Badge levels
		// and every support amount are dollars, at any amount. This rule exists because
		// `econ:figures` is otherwise **blind to a retired premise carrying no number**:
		// "in $3 increments" quotes a figure that is still perfectly current ($3 is still
		// the Public Access price) while describing a mechanism that is gone, so the typed
		// figure scan cannot see it and neither can the marker blocks.
		//
		// That blindness is exactly what the Public Access revamp paid for once already,
		// when five marketing pages described a bandwidth allowance for two days after it
		// was deleted and nothing said a word.
		pattern: new RegExp(
			`${NOT_NEGATED}(?:\\$3 (?:increments|steps|units)|in \\$3s|whole[- ]Seed|whole number of Seeds|multiple of a Seed|per[- ]Seed)`,
			"gi",
		),
		why: "the Seed retired as a financial unit 2026-08-16 — amounts are dollars, at any level, with no granularity floor",
	},
	{
		// 🚨 **The Seed as a noun at all, not merely as a counted one.**
		//
		// This matched only the COUNTED forms (`3 Seeds`, `a Seed`, `Seed count`) until
		// 2026-08-16, on the reasoning that counting was what retired. That reasoning was
		// wrong, and the retirement PR read green because of it: **186 lines across 32
		// files** still said Seed in user-facing copy, and none of them counted anything.
		// "Give Seeds to Anthers", "Your Seeds are set up", "Seed Income", "Seed gated" —
		// every one invisible to the narrow rule, and every one on a live surface.
		//
		// Worse, the narrow rule made the sweep look finished. The task tracking it recorded
		// the code half as done and ~738 wiki mentions as all that remained; the code half
		// was not close to done, and six of those lines were rendering **wrong numbers**
		// rather than dated words.
		//
		// ⚠️ **`\b` on a capital-S `Seeds?` is what makes this safe against identifiers**,
		// and the safety is structural rather than a list of exceptions. Identifiers glue
		// the word to other word characters, so a word boundary cannot fall on both sides:
		// `GiveSeedsCard`, `canGiveSeeds`, `SeedListResponse`, `seedAllocations`,
		// `setSeedAllocs` are all out of reach, and the lowercase and SCREAMING forms
		// (`seedAccess`, `BADGE_RUNGS`) miss on case. What is left is the word standing on
		// its own, which in code means a string or JSX text — copy, which is exactly what
		// 63.01 governs. Comments are blanked before matching, so engineering prose keeps
		// its history notes.
		pattern: new RegExp(`${NOT_NEGATED}\\bSeeds?\\b`, "g"),
		why: "the Seed retired as a noun 2026-08-16 — name the amount ($3, $7.50), say 'Badge' for a level, or 'support' for the act",
	},

	{
		pattern: new RegExp(`${NOT_NEGATED}(?:buyer'?s? )?first download`, "gi"),
		why: "delivery has been free at any volume since 2026-08-12 — there is no first-download charge to deduct",
	},
	{
		pattern: new RegExp(
			`${NOT_NEGATED}(?:bandwidth (?:allowance|wallet)|per-GiB (?:charge|rate))`,
			"gi",
		),
		why: "the allowance, the wallet and the per-GiB rate were all deleted 2026-08-12",
	},
	{
		// A mechanism the code never had, rather than one it lost — but the test the list
		// applies is the same ("the only correct number of occurrences is zero"), and so is
		// the fix. ATProto adoption is deferred (41.01): what ships is Bluesky identity
		// LINKING, and the `atproto_uri` columns sit unpopulated as future-proofing. This
		// framing has drifted back onto marketing pages twice — PR #166 removed it from
		// /for-creators, #183 from the Ghost comparison — which is what earns it a guard
		// rather than another sweep.
		//
		// ⚠️ Deliberately narrow: it matches the CLAIM, not the subject. A page may say
		// federation is coming, may name Bluesky, may explain what ATProto is. What it may
		// not say is that Anthers is built on it today.
		pattern: new RegExp(
			`${NOT_NEGATED}(?:built on the AT ?Protocol|portable DID|stored as ATProto records)`,
			"gi",
		),
		why: "ATProto adoption is deferred — Bluesky identity linking ships, federation does not (41.01)",
	},
	{
		// The same claim in a wording the rule above could not see, which is the third time
		// 63.01's *"a guard covers a phrasing, never a claim"* has been paid for. /about's
		// hero read **"Anthers is a federated, open content network"** for months, one band
		// above a page whose entire subject is being honest about what does and doesn't
		// exist yet — while the ATProto rule matched `built on the AT Protocol` and the
		// canonical-introduction rule matched `open, distributed network`, and neither
		// matched this.
		//
		// ⚠️ The adjective is the claim and the noun is not. **"federated" always describes
		// Anthers as already federated**; "federation" is the subject a page may legitimately
		// discuss — /compare/itch writes *"federation is a direction we're committed to, not
		// something we've shipped"*, /roadmap lists *"federation functioning"* as a milestone,
		// and the wiki index calls a section *"AT Protocol, federation, and community
		// guidelines"*. All three must stay silent, and all three do, because none of them
		// uses the adjective. Verified by sabotage against each.
		pattern: new RegExp(`${NOT_NEGATED}\\bfederated\\b`, "gi"),
		why: "Anthers is centralized-first — write federation as coming, never as a property it already has (63.01; 41.01)",
	},
	{
		// The second mechanism the code never had, and the one that had spread furthest: a
		// /for-creators pricing card, a ✓ in the itch comparison, the demo storefront, and
		// the sentence the creator reads directly above the price field all promised
		// pay-what-you-want. **Checkout has never accepted an amount.** `resolvePurchase`
		// reads the stored `access.price` and `ProjectPricing` posts `{ slug }` with no
		// body, so the buyer has no way to send one.
		//
		// 🚨 **It is now a DECISION rather than a gap** (Parker, 2026-08-18): Anthers is not
		// building pay-what-you-want. That matters for how this rule reads. An unbuilt
		// feature invites "write it as coming" — the tense rule the cart and self-hosting
		// both get — and this one does not get it: PWYW is written as **absent**. So the
		// guard is permanent rather than a placeholder to delete once the feature lands,
		// which is what a reader would otherwise reasonably assume from `why` alone.
		// Recorded in the vault at `31.02 Direct Creator Purchases` and `63.01 § Prices`;
		// the itch.io import consequence is in `62.01 § 5.1` (a PWYW game imports as a
		// draft with no price set, rather than a number the creator never chose).
		//
		// 🚨 This one earns a guard rather than a sweep for a reason the ATProto rule does
		// not have: a creator who prices low believing tips will follow **loses money on
		// every sale**, and the take-home display built alongside this is the thing that
		// tells them so. A page still promising the tips would put the two surfaces in
		// direct contradiction at the exact moment the number is chosen.
		//
		// ⚠️ Broad on purpose, unlike ATProto's. There is no lexical difference between
		// claiming it and crediting a rival for it — the itch comparison row differs from
		// the old one by a JSX prop — so the honest use is the annotated one. Exactly one
		// `econ:allow` exists for it today, on that row, and a second should be argued for
		// rather than added.
		// `pwyw` is in the list because the acronym is how it survived in code rather than
		// copy — a `pricingType` the seed data set on two works, which the spelled-out
		// pattern sails straight past. Comments are blanked, so the entry above explaining
		// why the value went is out of its reach.
		pattern: new RegExp(
			`${NOT_NEGATED}(?:pay[- ]what[- ]you[- ]want|\\bpwyw\\b|name your own price|suggested price|(?:buyers?|they) (?:may|can) pay more|price is a minimum)`,
			"gi",
		),
		why: "pay-what-you-want has never existed and is not planned (decided 2026-08-18) — checkout charges the stored price and accepts no amount from the buyer",
	},
	{
		// The organization's own name for itself, and the one place a copy error becomes a
		// factual error: **there is one legal person and it is `Anthers, Inc.`** (63.01,
		// retired 2026-08-05). Writing "supported by a non-profit foundation" invents a
		// second organization for the reader to track, and does it two sentences before the
		// page names the actual corporation — so the reader is left with two entities and no
		// way to tell which is which.
		//
		// 🚨 The narrowing is the whole rule: a foundation belonging to SOMEONE ELSE is fine
		// and real. `CompareGhostPage` correctly says Ghost's "non-profit foundation" has
		// been building in the open since 2013 — flagging that would teach people to
		// annotate accurate copy about a rival, which is how a guard becomes noise. Hence
		// `our|a new|the` rather than a bare match; note `\bthe\b` cannot match inside
		// "their", which is what spares the Ghost line.
		pattern: new RegExp(
			`${NOT_NEGATED}(?:Anthers Foundation|\\b(?:our|a new|the)\\s+non-profit\\s+foundation)`,
			"gi",
		),
		why: "there is one legal person and it is `Anthers, Inc.` — name the function, not an entity (63.01 § Words)",
	},
	{
		// The federation claim wearing different clothes. The ATProto rule above matches
		// "built on the AT Protocol"; this one matches the same assertion made without
		// naming the protocol, which is how it got back onto the org profile, the platform
		// README and /for-users in August 2026 while that rule sat green.
		//
		// ⚠️ Narrow on purpose, exactly like its sibling: a page may say federation is
		// coming and may describe what a distributed network would mean. What it may not do
		// is describe Anthers as being one TODAY. Anthers is centralized-first; what is
		// true now is open-source and no lock-in, which is what the canonical intro says
		// instead.
		pattern: new RegExp(`${NOT_NEGATED}open,?\\s+(?:and\\s+)?distributed network`, "gi"),
		why: "Anthers is centralized-first — federation is coming, not here (63.01; 41.01)",
	},
	{
		// Not a retired *mechanism* like the two above — a retired *word* for a live one,
		// which is the other way this list earns its keep. The Time Pool is real; calling
		// what it measures "watch-time" makes video the default unit of a platform that
		// hosts four media and measures them on one clock. 63.01 blessed the word until
		// 2026-08-12 **while citing the equal-time principle as its authority**, which
		// refutes itself in a line.
		//
		// ⚠️ Scoped to user-facing copy, exactly as 63.01 is. This scanner only walks
		// `APP_ROOTS` and blanks comments first, so the engineering uses it deliberately
		// keeps — `distribute-pool.ts`'s job comments, the ~600 Class B reads per
		// watch-hour figure — are out of reach by construction rather than by exception.
		pattern: new RegExp(`${NOT_NEGATED}watch[- ](?:time|hours?)`, "gi"),
		why: 'a minute is a minute across four media — say "time" (63.01 § Vocabulary)',
	},
	{
		// Retired 2026-08-12 with the second access table (migration `0029`). There is one
		// gate primitive and it points only at a creator: a Work is gated by its creator or
		// it is Public Access, with no Badge threshold in between. `ANTHERS_BADGES` no
		// longer participates in resolution at all, so this describes a mechanism the code
		// genuinely no longer has — the test this list applies.
		//
		// ⚠️ Earned by measurement, not suspicion: on 2026-08-14 this phrase was still live
		// in five places across /for-users, /for-creators and /faq, two days after the
		// mechanism was deleted, and every one of them carried a correct money figure. That
		// is precisely the defect the figure scan cannot see.
		//
		// The lookahead spares the sentence the retirement *leaves behind* — "Seeds you give
		// Anthers gate nothing at all" is the correct copy now, and a guard that flagged it
		// would teach people to annotate good copy rather than delete bad copy.
		pattern: new RegExp(
			`${NOT_NEGATED}Anthers[- ](?:[Gg]ates?\\b(?!\\s+(?:nothing|no\\b))|gated)`,
			"g",
		),
		why: "Anthers Gates were retired 2026-08-12 — one gate primitive, pointed only at a creator (63.01 § Seed Gate)",
	},
	{
		// The other half of the same 2026-08-12 change, and the subtler one. Deleting the
		// bandwidth allowance made "no allowance, no cap" true of *delivery* — and the copy
		// correctly said so. What the copy never learned is that a NEW meter arrived the
		// same day: Public Access is capped monthly on a free account. So four pages ended
		// up claiming unbounded streaming while the app itself rendered the limit.
		//
		// 🚨 Downloads really are unlimited, so this must not fire on them. It matches only
		// the retired formulations that put STREAMING inside the unbounded claim — 63.01
		// makes "free forever" and the limit co-present, on the same rule as "no cut" and
		// the take-home.
		pattern: new RegExp(
			`${NOT_NEGATED}(?:stream(?:s|ing)?[^.]{0,30}without a meter|stream(?:ing|s)? and download(?:s|ing)? are unlimited|streams and downloads freely)`,
			"gi",
		),
		why: "a free account's Public Access is capped monthly — say the limit beside the freedom (63.01 § Claims: co-presence)",
	},
	{
		// 🚨 **A support rung written as a bare number reads as a count of the retired unit,
		// however correct the number is.** This is the exact defect that reached published
		// output: `renderSelfSufficiencyMarkdown` destructured `PAYING_BADGE_MIX` — keyed in
		// dollars since 2026-08-16 — as `seeds` and printed the key without a `$`, so 11.02
		// published *"45% at 3, 25% at 6, 14% at 9"* one line below the words "$6.59 a
		// month". Every figure was right and every one of them said "three Seeds".
		//
		// ⭐ It is the one shape of this failure a regex can actually catch, which is why it
		// is here and why the rest of the sweep was a reading pass. A scanner cannot tell a
		// comment *recording* that the Seed was retired from one describing it as current —
		// the corpus holds about 150 of the first — but "a percentage at a bare number" has
		// no correct occurrence in published copy, because every rung is money.
		pattern: /\d+% at (?!\$)\d/g,
		why: "a support rung is money — write it as `at $3`, or a bare number reads as a count of the Seed retired 2026-08-16",
	},
];

/** `// econ:allow — <why>`: this number is not one of ours. The reason is required. */
const ALLOW = /econ:allow(?!-file)\b[\s:—-]*(.*)$/;

/**
 * `// econ:allow-file — <why>`: this whole file is a known exception.
 *
 * A file-level escape hatch is how guards go quiet, so it pays for itself two ways:
 * the reason is required, and **every exempt file is printed on every run**, in both
 * write and check mode. An exception you have to read out loud each time is one
 * somebody eventually fixes; a silenced line is one nobody sees again.
 */
// The `m` flag matters: without it `$` only anchors at end-of-STRING, so a marker
// in a file header would never match the file it heads.
const ALLOW_FILE = /econ:allow-file\b[\s:—-]*(.*)$/m;

/**
 * A line that carries no code once its comments are gone.
 *
 * 🚨 **The braces are why this is a function and not `=== ""`.** `withoutComments`
 * blanks the comment body but cannot blank the `{` and `}` a JSX comment wraps it in, so
 * such a comment leaves `{` on its first line and `}` on its last. That single surviving
 * brace stopped the walk below dead — which meant **an `econ:allow` written as a JSX
 * comment had never once worked**, in the only syntax available inside a JSX tree. Two
 * were sitting in the app reading as though they did (`CompareItchPage:196`,
 * `SubscriptionPage:663`); both happen to guard lines nothing currently matches, so
 * nobody found out. Discovered 2026-08-16 by writing a third one that was load-bearing.
 *
 * An escape hatch that silently does nothing is worse than one that does not exist: the
 * next person concludes the annotation is unsupported and reaches for `econ:allow-file`,
 * which silences the whole file.
 */
const blankish = (line: string) => line.replace(/[{}]/g, "").trim() === "";

/**
 * Find the annotation covering line `i`: on the line itself, or anywhere in the
 * comment block immediately above it — the reason for a coincidence is often two
 * lines, and a guard that silently ignores the second one teaches people to write
 * shorter reasons rather than better ones.
 *
 * `code` is the comment-blanked source, so "this line is nothing but a comment" is
 * exactly "blank once the comments are gone, but not blank before".
 */
function allowance(lines: string[], code: string[], i: number): RegExpExecArray | null {
	let found = ALLOW.exec(lines[i]);
	for (let k = i - 1; !found && k >= 0 && blankish(code[k]) && lines[k].trim() !== ""; k--) {
		found = ALLOW.exec(lines[k]);
	}
	return found;
}

/**
 * Every money figure `scenarios.ts` publishes, indexed by its rendered value and
 * mapped to the name a page should read it by.
 *
 * Built from the scenarios rather than from `figures.generated.ts`, so a stale
 * generated file can never satisfy the guard that guards it.
 */
function publishedFigures(): Map<string, string[]> {
	const index = new Map<string, string[]>();
	const add = (value: unknown, name: string) => {
		if (typeof value !== "string" || !/^\d+\.\d{2}$/.test(value)) return;
		const at = index.get(value) ?? [];
		if (!at.includes(name)) at.push(name);
		index.set(value, at);
	};
	const record = <T extends object>(owner: string, row: T, keyField?: keyof T & string) => {
		const at = keyField ? `${owner}[${row[keyField]}]` : owner;
		for (const [k, v] of Object.entries(row)) add(v, `${at}.${k}`);
	};
	// The two dials prose quotes directly, named first so the message points at the
	// import a page actually wants rather than at the table row that happens to equal it.
	add(PUBLIC_ACCESS_PRICE.toFixed(2), "PUBLIC_ACCESS_PRICE (@anthers/shared/constants)");
	add(timePoolFor(PUBLIC_ACCESS_PRICE).toFixed(2), "timePoolFor(PUBLIC_ACCESS_PRICE)");
	for (const r of badgeTable()) record("BADGE_TABLE", r, "badge");
	for (const r of saleTable()) record("SALE_TABLE", r, "label");
	for (const r of purchaseExamples()) record("purchaseExamples()", r, "label");
	record("SAMPLE_RECEIPT", sampleReceipt());
	record("DIRECTED_SUPPORT_WORST_CASE", directedSupportWorstCase());
	record("cartSaving()", cartSaving());
	record("creatorReceipt()", creatorReceipt());
	const s = selfSufficiency();
	add(s.freeUserCost, "selfSufficiency().freeUserCost");
	add(s.revenuePerPayingUser, "selfSufficiency().revenuePerPayingUser");
	for (const r of s.rows) add(r.net, `selfSufficiency().rows[${r.sharePct}].net`);
	return index;
}

/**
 * Blank every comment, preserving newlines so line numbers stay true.
 *
 * These pages carry long doc comments that explain the model in figures — developer
 * prose no reader ever sees, and flagging it would only push us toward worse
 * comments. There is deliberately no TypeScript parse here: a real lexer would have
 * to know that the apostrophe in JSX text like `Anthers' cut` is not a string
 * delimiter, and mis-reading that fails in the wrong direction. Blanking only ever
 * REMOVES text, so the worst a mis-read can cost is a missed hit — never a false
 * accusation against a line that is fine.
 */
function withoutComments(src: string): string {
	let out = "";
	for (let i = 0; i < src.length; ) {
		if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
			i = stop;
		} else if (src.startsWith("//", i) && src[i - 1] !== ":") {
			// The `:` guard keeps `https://…` inside a string from reading as a comment.
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out += " ".repeat(stop - i);
			i = stop;
		} else {
			out += src[i++];
		}
	}
	return out;
}

/**
 * Collapse the source to one line, keeping a char→line map.
 *
 * JSX text wraps wherever the formatter decides, so a phrase and the word that negates
 * it routinely end up on different lines: `no allowance, no wallet, no per-GiB\ncharge`
 * splits "per-GiB charge" itself in half AND strands its "no" two lines up. Matching
 * line-by-line therefore reports a sentence that says the exact opposite of what it was
 * accused of — which is worse than missing it, because the fix looks like deleting
 * correct copy. Phrase rules run against the unwrapped text; only the report needs
 * lines, and `lineOf` carries them.
 */
function flatten(code: string): { text: string; lineOf: number[] } {
	let text = "";
	const lineOf: number[] = [];
	let line = 1;
	let gap = false;
	for (const ch of code) {
		if (ch === "\n") {
			line++;
			gap = true;
			continue;
		}
		if (/\s/.test(ch)) {
			gap = true;
			continue;
		}
		if (gap && text) {
			text += " ";
			lineOf.push(line);
		}
		gap = false;
		text += ch;
		lineOf.push(line);
	}
	return { text, lineOf };
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(path);
		else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|e2e)\.tsx?$/.test(entry.name)) yield path;
	}
}

/**
 * Every `.md` in the repo, skipping what is not ours to hold to a copy rule.
 *
 * ⚠️ **`node_modules` is the one that matters** — without it this walks a dependency tree
 * of thousands of READMEs, every one of them someone else's prose, and the run turns into
 * a wall of findings about libraries. The rest are build output and VCS internals, which
 * contain nothing hand-written.
 *
 * 🚨 **`test-results` and `playwright-report` were added 2026-08-22, and the reason is that
 * the finding they produce cannot be acted on.** Playwright writes an `error-context.md`
 * beside a failed spec containing the *source of the test that failed* — so
 * `user-gauntlet.e2e.ts`'s own comments, which say in as many words that the Seed and
 * Anthers Gates were retired, arrived here as prose and were reported as live copy. Test
 * files are deliberately outside `sourceFiles` for exactly that reason; dumping one into a
 * `.md` smuggled it back in. Three things make it worth a fix rather than a `rm`: the
 * directory is gitignored, so **CI never sees it and only local runs go red**; the artifact
 * is regenerated by the next failure, so deleting it fixes nothing; and the message tells
 * you to strike phrasing from a file that is a transcript, which is advice nobody can
 * follow. A guard that can only be silenced by deleting evidence teaches people to delete
 * evidence.
 */
async function* markdownFiles(dir: string): AsyncGenerator<string> {
	const SKIP = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		"target",
		".next",
		"coverage",
		"test-results",
		"playwright-report",
	]);
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* markdownFiles(path);
		else if (entry.name.endsWith(".md")) yield path;
	}
}

/**
 * Blank a markdown file down to the prose a human actually wrote.
 *
 * Two exclusions, and they are excluded for the same reason rather than two: a generated
 * region is **full** of published figures — that is its entire job — and the sentences its
 * renderers emit name retired mechanisms on purpose ("a *Bandwidth* column sat here until
 * 2026-08-12"). Scanning either would report the generator against itself, and teach the
 * reader to annotate correct output rather than fix incorrect prose. HTML comments go for
 * the same reason `withoutComments` blanks `//` ones: an `econ:allow` reason is written
 * there, and `allowance()` finds an annotation above a line by asking whether that line is
 * blank *once comments are gone but not before*.
 *
 * Newlines survive so reported line numbers stay true.
 */
function withoutGeneratedRegions(src: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	return src
		.replace(/<!--\s*econ:begin\b[\s\S]*?econ:end\b[\s\S]*?-->/g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Both halves of the guard against one file: a published figure typed by hand, and copy
 * for a mechanism the code no longer has.
 *
 * `source` is what a human wrote and `prose` is that with the unscannable parts blanked —
 * comments for code, generated regions for markdown. Keeping both is what lets the figure
 * check run over the real text while the `econ:allow` reason is still found in the comment
 * that carries it.
 */
function scanText(label: string, source: string, prose: string, index: Map<string, string[]>) {
	const lines = source.split("\n");
	const code = prose.split("\n");
	code.forEach((line, i) => {
		for (const m of line.matchAll(/\$(\d+\.\d{2})/g)) {
			const owners = index.get(m[1]);
			if (!owners) continue;
			// The annotation lives in a comment, so it is looked for in the ORIGINAL.
			const allow = allowance(lines, code, i);
			if (allow?.[1].trim()) continue;
			typed.push(
				`${label}:${i + 1}\n      typed $${m[1]} — that is ${owners
					.slice(0, 3)
					.join(" / ")}${allow ? "\n      (econ:allow needs a reason after it)" : ""}`,
			);
		}
	});

	const { text, lineOf } = flatten(prose);
	for (const { pattern, why } of RETIRED_COPY) {
		for (const hit of text.matchAll(pattern)) {
			const at = lineOf[hit.index] ?? 1;
			const allow = allowance(lines, code, at - 1);
			if (allow?.[1].trim()) continue;
			retired.push(`${label}:${at}\n      "${hit[0]}" — ${why}`);
		}
	}
}

async function scanApp() {
	const index = publishedFigures();
	for (const root of APP_ROOTS) {
		const dir = join(REPO, root);
		if (!existsSync(dir)) continue;
		for await (const path of sourceFiles(dir)) {
			const source = await readFile(path, "utf8");
			const fileWide = ALLOW_FILE.exec(source);
			if (fileWide?.[1].trim()) {
				exempt.push(`${relative(REPO, path)} — ${fileWide[1].trim()}`);
				continue;
			}
			scanText(relative(REPO, path), source, withoutComments(source), index);
		}
	}
}

async function scanDocs() {
	const index = publishedFigures();
	for (const file of await docFiles()) {
		const path = join(REPO, file);
		if (!existsSync(path)) continue;
		const source = await readFile(path, "utf8");
		const fileWide = ALLOW_FILE.exec(source);
		if (fileWide?.[1].trim()) {
			exempt.push(`${file} — ${fileWide[1].trim()}`);
			continue;
		}
		scanText(file, source, withoutGeneratedRegions(source), index);
	}
}

/**
 * 🚨 **A generated block may never contain the string `undefined` (or `NaN`).**
 *
 * Added 2026-08-16 after two shipped. Renaming `BadgeRow.seeds` → `monthly` and
 * `selfSufficiency().averageSeeds` → `averageSupport` left two renderers reading fields
 * that no longer existed, so 20.01 published a column of `undefined` and 11.02 published
 * *"the average payer at **undefined Seeds**"*.
 *
 * **`--check` was green the whole time**, and that is the part worth internalising: a
 * generator that is consistently wrong produces output that consistently matches itself.
 * Drift-checking compares today's render against the page; it cannot see a value that was
 * never right in the first place.
 *
 * The root cause was that `scripts/` sat outside `bun run typecheck`, which is
 * `--filter '*'` over **workspaces** and `scripts/` is not one — so `r.seeds` on a type
 * with no such field raised nothing at all. That is fixed too (`scripts/tsconfig.json`,
 * wired into the `typecheck` script), and this is the belt to its braces: a renderer can
 * still interpolate an optional that happens to be absent, and TypeScript is right to
 * allow that.
 */
function assertRendered(key: string, body: string, allowRetired?: string): void {
	if (/\b(undefined|NaN)\b/.test(body)) {
		throw new Error(
			`econ-figures: block "${key}" rendered a literal undefined/NaN — a renderer is ` +
				`reading a field that no longer exists. Fix the renderer; do not commit the block.`,
		);
	}

	// 🚨 **The generator is held to its own RETIRED_COPY rules**, added 2026-08-16.
	//
	// It was not, and the blind spot is structural rather than an oversight: `scanDocs`
	// blanks generated regions before matching (`withoutGeneratedRegions`), precisely so a
	// figure it just wrote is not then flagged as hand-typed. The consequence nobody drew
	// is that **the one region no human may edit was also the one region nothing checked**
	// — so the tool that guards this vocabulary spent the Seed retirement publishing
	// "A lone directed Seed is the same shape" into four wiki docs, and `--check` passed.
	//
	// It surfaced the worst way available: a hand-sweep of those docs "fixed" the wording,
	// which made the blocks stale, which failed a pre-push `make verify` on a production
	// release. The words would otherwise have come back on the next generation.
	if (allowRetired) {
		exempt.push(`block "${key}" — ${allowRetired}`);
		return;
	}
	for (const { pattern, why } of RETIRED_COPY) {
		const hit = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(body);
		if (hit) {
			throw new Error(
				`econ-figures: block "${key}" renders "${hit[0]}" — ${why}.\n` +
					`      Fix the RENDERER, not the document: a hand edit inside a generated ` +
					`region is reverted by the next run.`,
			);
		}
	}
}

function splice(source: string, key: string, body: string, allowRetired?: string): string | null {
	assertRendered(key, body, allowRetired);
	const begin = `<!-- econ:begin ${key} -->`;
	const end = `<!-- econ:end ${key} -->`;
	const i = source.indexOf(begin);
	const k = source.indexOf(end);
	if (i === -1 || k === -1) return null;
	const note = "<!-- GENERATED by `bun run econ:figures` — do not edit by hand. -->";
	return `${source.slice(0, i + begin.length)}\n${note}\n\n${body}\n\n${source.slice(k)}`;
}

async function reconcile(path: string, next: string, label: string) {
	const current = existsSync(path) ? await readFile(path, "utf8") : "";
	if (current === next) return;
	if (check) {
		failures.push(label);
		return;
	}
	await writeFile(path, next);
	console.log(`  wrote ${label}`);
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(
	`econ-figures: PUBLIC_ACCESS_PRICE=$${PUBLIC_ACCESS_PRICE} TIME_POOL_RATE=${TIME_POOL_RATE} CARD=${(CARD_RATE * 100).toFixed(1)}%+$${CARD_FLAT.toFixed(2)}`,
);

await reconcile(
	join(REPO, "packages/shared/src/figures.generated.ts"),
	await formatted(renderModule()),
	"packages/shared/src/figures.generated.ts",
);

/**
 * Splice every block for `root` and write the files that changed.
 *
 * One file may carry several blocks (50.01 carries four), so the spliced text is
 * accumulated per path before anything is written — otherwise the second block would
 * splice into the on-disk copy and drop the first.
 */
async function writeBlocks(root: string, blocks: Block[]) {
	const byFile = new Map<string, string>();
	for (const b of blocks) {
		const path = join(root, b.file);
		if (!existsSync(path)) {
			// 🚨 A FAILURE, not a warning (2026-08-16). It warned and carried on, which meant
			// **renaming a document silently dropped its generated block from coverage** — the
			// run stayed green while a published table quietly stopped being checked. Found by
			// renaming `20.01 Badges and Seed Levels` during the Seed retirement: `--check`
			// failed for an unrelated reason and the warning was two lines above it, unread.
			// A guard that can lose a target without saying so is the failure this whole
			// script exists to prevent, one level up.
			failures.push(`${b.file} — no such file (renamed? then update BLOCKS)`);
			continue;
		}
		const current = byFile.get(path) ?? (await readFile(path, "utf8"));
		const next = splice(current, b.key, b.render(), b.allowRetired);
		if (next === null) {
			// 🚨 A FAILURE, not a warning (2026-08-30), for exactly the reason the missing-FILE
			// case above became one. A block whose markers are gone is a target this guard has
			// silently lost: deleting the `readme-model` block outright — markers and all two
			// thousand characters of published money figures — left `--check` reporting "up to
			// date". Renaming the file was caught and deleting the block was not, which is the
			// same hole through a different door.
			failures.push(`${b.file} — no <!-- econ:begin ${b.key} --> markers (block deleted?)`);
			continue;
		}
		byFile.set(path, next);
	}
	for (const [path, next] of byFile) {
		await reconcile(path, next, relative(root, path));
	}
}

// The repo's own markdown first, and unconditionally: every clone has it, CI has it, and
// a contributor with no vault still gets the check. The wiki is the optional half.
await writeBlocks(REPO, REPO_BLOCKS);

// 🚨 **The wiki half runs only when it is asked for — `--wiki`, via `make wiki-figures`.**
//
// It was part of every `make verify` until 2026-08-30, and the reason it is not any more
// is that **CI has never once run it.** A GitHub runner has no `~/Obsidian`, so the branch
// below took the `skip` path on every CI run this check has ever had, printing a line and
// passing. The drift protection on the wiki's blocks was therefore never "CI enforces
// this" — it was "whoever last ran `make verify` on the one laptop with the vault
// attached", which is the weakest enforcement available.
//
// ⭐ **What it did reliably produce was failure on the developer machine**, because a
// personal notes folder is not a build input: reorganizing it renamed the project root
// (fixed 2026-08-30) and left an empty husk that looked like a second root (fixed the same
// day). Both fixes are real and both are patches on a coupling that should not exist —
// a test in this repository has no business failing because of the shape of somebody's
// notes directory. The generation is worth keeping; making it a gate was the mistake.
//
// ⚠️ The repo's own blocks above are unaffected and stay in `make verify`, as does the
// whole typed-figure scan over `apps/` and `packages/` — those are the parts that protect
// what users see, and neither needs a vault. **The real fix is for the wiki to live in the
// repository**, at which point this entire discovery apparatus — `ANTHERS_VAULT`, the
// project-root regex, the husk check — deletes itself and CI checks the blocks for real.
if (wikiRequested) {
	// Only *absent* is optional. A vault we cannot find our way around inside is a broken
	// tool reporting success — and having explicitly asked for the wiki, silence about not
	// finding it would be worse here than anywhere.
	const wiki = findWiki();
	if ("error" in wiki) {
		failures.push(`the wiki blocks were not checked at all — ${wiki.error}`);
	} else if ("skip" in wiki) {
		console.log("  (no vault on this machine — skipping wiki blocks)");
	} else {
		console.log(`  wiki: ${wiki.path}`);
		await writeBlocks(wiki.path, BLOCKS);
	}

	// The public wiki, on the same absent-versus-broken rule and with none of the searching.
	const publicWiki = findPublicWiki();
	if ("error" in publicWiki) {
		failures.push(`the public wiki blocks were not checked at all — ${publicWiki.error}`);
	} else if ("skip" in publicWiki) {
		console.log("  (no public wiki on this machine — skipping its blocks)");
	} else {
		console.log(`  public wiki: ${publicWiki.path}`);
		await writeBlocks(publicWiki.path, PUBLIC_WIKI_BLOCKS);
	}
} else {
	const total = BLOCKS.length + PUBLIC_WIKI_BLOCKS.length;
	console.log(`  (wiki blocks not requested — ${total} blocks skipped; make wiki-figures)`);
}

await scanApp();
await scanDocs();

if (failures.length > 0) {
	console.error("\nThese generated regions are stale:\n");
	for (const f of failures) console.error(`  ${f}`);
	console.error("\nRun `bun run econ:figures` and commit the result.");
}

if (typed.length > 0) {
	console.error("\nA published figure may be DERIVED, never typed:\n");
	for (const t of typed) console.error(`  ${t}`);
	console.error(
		"\nIn the app, read it from `@anthers/shared/figures` instead — the way FAQPage\n" +
			"does. In markdown, move it inside an `econ:begin`/`econ:end` region and render\n" +
			"it from a scenario, the way the README's money section is.\n" +
			"If the number is not one of ours (a rival platform's cut, an illustrative\n" +
			"infrastructure cost), say so on the line:\n" +
			"    // econ:allow — Steam's 30% cut, not one of our figures\n" +
			"    <!-- econ:allow — Steam's 30% cut, not one of our figures -->\n",
	);
}

if (retired.length > 0) {
	// The list holds two kinds now — a mechanism the code no longer has, and a word we
	// no longer use for one it does — so the header names neither and the per-hit `why`
	// carries the difference. Saying "a charge that no longer exists" over a vocabulary
	// hit sends the reader looking for a number to update, which is the wrong move.
	console.error("\nThis copy uses something we have retired:\n");
	for (const r of retired) console.error(`  ${r}`);
	console.error(
		"\nStrike the retired phrasing rather than updating a number beside it — the\n" +
			"sentence changes shape, it does not change value. If the phrase is genuinely\n" +
			"someone else's (a rival's mechanism, their metric) or historical, annotate it:\n" +
			"    // econ:allow — YouTube's own metric for YouTube's own mechanism\n",
	);
}

if (exempt.length > 0) {
	// "file(s) … from the app scan" until 2026-08-17, when `allowRetired` started pushing
	// generated BLOCKS onto the same list — so every line it printed was mislabelled as a
	// file and attributed to a scan it never went through. A guard that misreports its own
	// exemptions is teaching the reader to skim them.
	console.log(`\necon-figures: ${exempt.length} exemption(s), each with a stated reason:`);
	for (const e of exempt) console.log(`  ${e}`);
	console.log("");
}

if (check && failures.length + typed.length + retired.length > 0) {
	console.error("econ-figures --check FAILED.");
	process.exit(1);
}
console.log(check ? "econ-figures: up to date" : "econ-figures: done");
