// SPDX-License-Identifier: Apache-2.0
//
// The public changelog. Content lives in `content/changelog.ts`; this file only
// renders it.
//
// There are two layers, and the page is honest about both. The **raw changelist** —
// every change between two tags, one line each — is published unedited as the GitHub
// release on each version's tag, and this page links to it beside every entry. This
// page is the **reader-facing pass** over that list: the changes grouped into arcs
// rather than commits, filtered of what a reader cannot see (test machinery,
// contributor tooling, internal rewrites), and translated into what a reader or a
// creator can now do that they could not before. No entry here adds anything the
// release does not contain, and nothing a reader can see is silently dropped — the
// raw list stays one click away on the tag.
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

/** The bands alternate from the tinted hero (band 0) down, whatever the release count; see `Section`. */
const tintedBand = (band: number) => band % 2 === 0;

export default function ChangelogPage() {
	// `/changelog#<version>` scrolls to that release, which is how the roadmap's card
	// for a launched item links to the version that shipped it. Scrolled by hand
	// because the router does not follow a fragment on navigation, and a browser's
	// own jump happens before this renders.
	const target = useLocation().hash.slice(1);
	useEffect(() => {
		if (target) document.getElementById(target)?.scrollIntoView({ block: "start" });
	}, [target]);

	return (
		<div>
			<Hero />
			{CHANGELOG.map((release, i) => (
				<ReleaseSection key={release.version} release={release} tint={tintedBand(i + 1)} />
			))}
			<Closing tint={tintedBand(CHANGELOG.length + 1)} />
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
						Every numbered release, and what a reader or a creator can do now that they could not
						before. The raw, unedited list of every change stays on the GitHub release for each
						version — this page is the pass that groups and translates it. No entry here adds
						anything the release does not contain, and nothing a reader can see is silently dropped.
					</Lede>
				</Reveal>
			</div>
		</header>
	);
}

/** One release: version, date, lede, the entries, and both links out of the page. */
function ReleaseSection({ release, tint }: { release: ChangelogRelease; tint: boolean }) {
	const items = allItems();

	return (
		<Section tint={tint}>
			<div id={release.version} className="scroll-mt-24">
				<Reveal>
					<Eyebrow>{release.date}</Eyebrow>
					<H2>{release.version}</H2>
					<Lede>{release.lede}</Lede>
				</Reveal>

				<div className="mx-auto mt-10 max-w-3xl text-left">
					<Reveal delay={100}>
						<ul className="space-y-3 text-base leading-relaxed text-base-content/75">
							{release.entries.map((entry) => (
								<li key={entry} className="list-disc pl-5 marker:text-primary/50">
									{entry}
								</li>
							))}
						</ul>
					</Reveal>

					{/* The roadmap items this release moved to launched, linked both ways:
					    each chip goes to the roadmap card, whose own chip returns here. */}
					{release.roadmapIds && release.roadmapIds.length > 0 && (
						<div className="mt-8 flex flex-wrap gap-2">
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

					<Reveal delay={150}>
						<div className="mt-8">
							<a
								href={`https://github.com/anthers-inc/anthers/releases/tag/v${release.version}`}
								className="link link-hover text-sm font-medium text-primary"
								rel="noreferrer"
							>
								Every change, unedited
							</a>
							<p className="mt-1 text-sm leading-relaxed text-base-content/45">
								The release notes on the tag are the complete mechanical list, commit by commit.
							</p>
						</div>
					</Reveal>
				</div>
			</div>
		</Section>
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
