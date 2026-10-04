// SPDX-License-Identifier: Apache-2.0
//
// The public changelog. Content lives in `content/changelog.ts`; this file only
// renders it.
//
// There are two layers, and the page is honest about both. The **raw changelist** —
// every change between two tags, one line each — is published unedited as the GitHub
// release on each version's tag, and this page links to it beside every release. This
// page is the **user-facing pass** over that list: the changes grouped into arcs
// rather than commits, filtered of what a user cannot see (test machinery,
// contributor tooling, internal rewrites), and translated into what a user or a
// creator can now do that they could not before. No entry here adds anything the
// release does not contain, and nothing a user can see is silently dropped — the
// raw list stays one click away on the tag.
//
// **The page is grouped by month, not release by release.** One section per month,
// with a small divider inside it naming each release whose changes sit below it, so a
// `####.##.0` release and the `####.##.1` hotfixes after it read as one month's full
// set of changes — which is what a user wants from the page. The grouping is derived
// here from what each entry already carries, because the content module is a way
// station that must not gain fields the exporter would have to reproduce.
//
// **Everything renders at once — no tabs, no accordions, no lazy sections**, for the
// same reasons as the roadmap page beside it: a changelog is skimmed, and
// `marketing-copy.e2e.ts` reads this page's `body.textContent` and asserts that
// retired claims are *absent* — a negative assertion that unrendered copy satisfies
// perfectly.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link, useLocation } from "@anthers/web-shared/router";
import { useEffect } from "react";
import { CHANGELOG, type ChangelogRelease } from "../content/changelog";
import { allItems } from "../content/roadmap";

const serif = { fontFamily: FONTS.fraunces };

/** The bands alternate from the tinted hero (band 0) down, whatever the month count; see `Section`. */
const tintedBand = (band: number) => band % 2 === 0;

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

/** One month of releases. Derived from the entries' `date`s; nothing is stored. */
export interface ChangelogMonth {
	/** The `YYYY-MM` the releases shipped in, cut from each entry's ISO `date`. */
	key: string;
	/** The month as the heading names it, e.g. "October 2026". */
	label: string;
	/** Every release that shipped in the month, newest first, in `CHANGELOG`'s own order. */
	releases: ChangelogRelease[];
}

/**
 * The changelog grouped by month, newest first. Folds over the entries in order of
 * first appearance — `CHANGELOG` is newest first, so both the months and the releases
 * inside each come out newest first without sorting. The month is the month of the
 * entry's `date`, not of its calver version: a `####.##.5` numbered for one month can
 * ship early in the next, and a user's question is when it shipped — the divider
 * carries the version beside the date either way.
 *
 * Exported for `changelog-grouping.test.ts`, which pins the grouping's shape, rather
 * than because anything else renders it.
 */
export function groupedByMonth(entries: readonly ChangelogRelease[] = CHANGELOG): ChangelogMonth[] {
	const months: ChangelogMonth[] = [];
	for (const release of entries) {
		// An entry's `date` is ISO `YYYY-MM-DD` (pinned by `changelog.test.ts`), so the
		// month is the first seven characters — no `Date` parsing, and no timezone to
		// drag a month edge across.
		const key = release.date.slice(0, 7);
		let month = months.find((m) => m.key === key);
		if (!month) {
			const [year, monthIndex] = key.split("-").map(Number);
			month = { key, label: `${MONTH_NAMES[monthIndex - 1]} ${year}`, releases: [] };
			months.push(month);
		}
		month.releases.push(release);
	}
	return months;
}

export default function ChangelogPage() {
	// `/changelog#<version>` scrolls to that release, which is how the roadmap's card
	// for a launched item links to the version that shipped it. Scrolled by hand
	// because the router does not follow a fragment on navigation, and a browser's
	// own jump happens before this renders.
	const target = useLocation().hash.slice(1);
	useEffect(() => {
		if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
	}, [target]);

	const months = groupedByMonth();

	return (
		<div>
			<Hero />
			{months.map((month, i) => (
				<MonthSection key={month.key} month={month} tint={tintedBand(i + 1)} />
			))}
			<Closing tint={tintedBand(months.length + 1)} />
		</div>
	);
}

function Hero() {
	return (
		<header className="bg-base-200/70">
			<div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
				<Reveal>
					<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
					<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
						Changelog
					</p>
					<h1 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						What actually shipped
					</h1>
				</Reveal>
				<Reveal delay={150}>
					<Lede>
						Every numbered release, month by month, and what a user or a creator can do now that
						they could not before. The raw, unedited list of every change stays on the GitHub
						release for each version — this page is the pass that groups and translates it. No entry
						here adds anything the release does not contain, and nothing a user can see is
						silently dropped.
					</Lede>
				</Reveal>
			</div>
		</header>
	);
}

/** One month: the month heading, then every release that shipped in it under a divider of its own. */
function MonthSection({ month, tint }: { month: ChangelogMonth; tint: boolean }) {
	const count = month.releases.length;

	return (
		<Section tint={tint}>
			<Reveal>
				<Eyebrow>
					{count} {count === 1 ? "release" : "releases"}
				</Eyebrow>
				<H2>{month.label}</H2>
			</Reveal>

			<div className="mx-auto mt-12 max-w-3xl text-left">
				{month.releases.map((release, i) => (
					<ReleaseBlock key={release.version} release={release} first={i === 0} />
				))}
			</div>
		</Section>
	);
}

/**
 * One release inside its month, opening with the divider that names it — the version
 * and date over a rule, with the raw list at the rule's end — followed by the arcs that
 * release shipped. `first` only sets the spacing: the month heading already separates
 * the first release from what is above it.
 *
 * `id` carries the `/changelog#<version>` anchor the roadmap's launched cards link
 * back to; `scroll-mt-24` keeps the divider clear of the sticky header when it lands.
 */
function ReleaseBlock({ release, first }: { release: ChangelogRelease; first: boolean }) {
	const items = allItems();

	return (
		<div id={release.version} className={`scroll-mt-24 ${first ? "" : "mt-16"}`}>
			<Reveal>
				<div className="flex items-center gap-4">
					<h3 className="font-mono text-sm font-medium tracking-wider text-base-content/70">
						{release.version}
					</h3>
					<span className="text-xs text-base-content/40">{release.date}</span>
					<div className="h-px flex-1 bg-base-content/10" />
					<a
						href={`https://github.com/anthers-inc/anthers/releases/tag/v${release.version}`}
						className="shrink-0 text-xs font-medium text-primary link link-hover"
						rel="noreferrer"
					>
						Every change, unedited
					</a>
				</div>

				<p className="mt-5 text-sm leading-relaxed text-base-content/55">{release.lede}</p>

				<ul className="mt-5 space-y-3 text-base leading-relaxed text-base-content/75">
					{release.entries.map((entry) => (
						<li key={entry} className="list-disc pl-5 marker:text-primary/50">
							{entry}
						</li>
					))}
				</ul>

				{/* The roadmap items this release moved to launched, linked both ways:
				    each chip goes to the roadmap card, whose own chip returns here. */}
				{release.roadmapIds && release.roadmapIds.length > 0 && (
					<div className="mt-6 flex flex-wrap gap-2">
						{release.roadmapIds.map((id) => {
							const item = items.find((i) => i.id === id);
							if (!item) return null;
							return (
								<Link
									key={id}
									to={`/roadmap#goal-${id}`}
									className="inline-flex items-center rounded-full border border-base-content/15 px-3 py-1 text-xs text-base-content/60 transition-colors hover:border-primary/40 hover:text-primary"
								>
									{item.title}
								</Link>
							);
						})}
					</div>
				)}
			</Reveal>
		</div>
	);
}

/**
 * The closing echo of the roadmap's own "Hold us to this" — this page is the checkable
 * half of that promise: every release's full list is public on the tag, and the roadmap
 * links both ways.
 */
function Closing({ tint }: { tint: boolean }) {
	return (
		<Section tint={tint}>
			<Reveal>
				<Eyebrow>Built in the open</Eyebrow>
				<H2>Hold us to this</H2>
				<Lede>
					The changelog is checkable rather than asserted. Every release's full list is public on
					the tag it shipped under, the source is public, and where a change finished a goal on the
					roadmap the two pages link to each other — so a claim here can be read against the thing
					it claims.
				</Lede>
				<div className="mt-9 flex flex-wrap justify-center gap-3">
					<a
						href="https://github.com/anthers-inc/anthers/releases"
						className="btn btn-primary rounded-lg px-7"
						rel="noreferrer"
					>
						Every release
					</a>
					<Link to="/roadmap" className="btn btn-ghost rounded-lg px-7">
						The Roadmap
					</Link>
				</div>
			</Reveal>
		</Section>
	);
}
