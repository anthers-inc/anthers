// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The public roadmap. Content lives in `content/roadmap.ts`; this file only renders it.
//
// 🚨 **What this replaced, and why none of it came across.** The page was a fixed-quarter
// SVG Gantt running Q1 2026 to Q4 2027, with every goal drawn as a bar spanning quarters
// somebody had guessed at. It was written before the support model and before the Catalog,
// and its drift was structural rather than cosmetic: Direct Purchases and Gated Content
// were marked *planned* and both had shipped, the Catalog and the Studio and moderation
// did not appear at all, the vocabulary was pre-support-model throughout, and a
// "Non-Profit" tab ran on a retired four-pillar framing and on subscriber-count
// milestones. Anyone reading it learned what Anthers was planning a year ago.
//
// ⚠️ **The Gantt is the part most worth not rebuilding.** Its entire axis was time, so
// every goal on it made a scheduling claim whether or not anybody had made a schedule —
// *"federation functioning"* sat inside a dated bar, which was both a promise nobody held
// and a present-tense claim about something that is signposted rather than scheduled.
// Three buckets and no dates outside Launched is the shape that cannot do that.
//
// **Everything renders at once — no tabs, no accordions, no lazy sections.** Two reasons,
// and the second is the load-bearing one. A roadmap is skimmed, so hiding two thirds of it
// behind a control makes the reader work to find out there is more. And
// `marketing-copy.e2e.ts` reads this page's `body.textContent` and asserts that retired
// claims are *absent* — a negative assertion that unrendered copy satisfies perfectly. Put
// content behind a tab and the guard stops covering it, silently.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { BookOpenIcon } from "@heroicons/react/24/outline";
import {
	BUCKETS,
	type Bucket,
	countIn,
	docHref,
	itemsIn,
	ROADMAP,
	type RoadmapGroup,
	type RoadmapItem,
} from "../content/roadmap";

const serif = { fontFamily: FONTS.fraunces };

/**
 * Bucket accents. Deliberately not a red/amber/green traffic light: Planned is not a
 * warning and Active is not a problem, and coloring them that way turns an honest list of
 * unfinished work into a page that looks like a status board in trouble.
 */
const ACCENT: Record<Bucket, { pill: string; rule: string }> = {
	active: { pill: "bg-primary/10 text-primary", rule: "border-primary/25" },
	planned: { pill: "bg-accent/15 text-accent", rule: "border-accent/25" },
	launched: { pill: "bg-success/15 text-success", rule: "border-success/25" },
};

export default function RoadmapPage() {
	return (
		<div>
			<Hero />
			{BUCKETS.map((bucket, i) => (
				<BucketSection key={bucket.id} bucket={bucket} tint={i % 2 === 1} />
			))}
			<Growth />
			<Closing />
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
						Roadmap
					</p>
					<h1 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						What we are building
					</h1>
				</Reveal>
				<Reveal delay={150}>
					<Lede>
						Everything Anthers is working toward, and everything it has finished, with nothing
						dressed up as further along than it is. Every goal carries its own status, and where
						something half-exists the card says so — a page like this is worth reading only if the
						disappointing half is on it too.
					</Lede>
				</Reveal>
				<Reveal delay={250}>
					<p className="mx-auto mt-8 max-w-2xl text-sm leading-relaxed text-base-content/55">
						Only finished work carries a date, and it carries the quarter it shipped in. Nothing
						else carries one at all — a quarter on something already built is a fact about the past,
						and a quarter on something planned is a promise, and Anthers would rather give you the
						order of things than a schedule it has no way to keep. Where a goal has documentation
						behind it the card names the page, shown dimmed until the documentation itself is
						published.
					</p>
				</Reveal>
			</div>
		</header>
	);
}

/** One bucket, with every group that has something in it. */
function BucketSection({ bucket, tint }: { bucket: (typeof BUCKETS)[number]; tint: boolean }) {
	const groups = ROADMAP.map((g) => ({ group: g, subgroups: itemsIn(g, bucket.id) })).filter(
		(g) => g.subgroups.length > 0,
	);
	const accent = ACCENT[bucket.id];

	return (
		<Section tint={tint}>
			<Reveal>
				<Eyebrow>
					{countIn(bucket.id)} {countIn(bucket.id) === 1 ? "goal" : "goals"}
				</Eyebrow>
				<H2>{bucket.label}</H2>
				<Lede>{bucket.blurb}</Lede>
			</Reveal>

			<div className="mt-14 space-y-16 text-left">
				{groups.map(({ group, subgroups }) => (
					<GroupBlock key={group.id} group={group} subgroups={subgroups} accent={accent} />
				))}
			</div>
		</Section>
	);
}

function GroupBlock({
	group,
	subgroups,
	accent,
}: {
	group: RoadmapGroup;
	subgroups: ReturnType<typeof itemsIn>;
	accent: (typeof ACCENT)[Bucket];
}) {
	return (
		<Reveal>
			<div className={`border-l-2 pl-6 sm:pl-8 ${accent.rule}`}>
				<h3 style={serif} className="text-2xl font-light">
					{group.label}
				</h3>
				<p className="mt-1 max-w-2xl text-sm leading-relaxed text-base-content/55">{group.blurb}</p>

				<div className="mt-8 space-y-10">
					{subgroups.map((sub) => (
						<div key={sub.label}>
							<h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-base-content/40">
								{sub.label}
							</h4>
							{/* `min-w-0` on the grid children is what keeps a long unbroken word from
							    pushing the card past the viewport; the mobile-overflow checker in
							    `make verify` is what would catch it if this were removed. */}
							<div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
								{sub.items.map((item) => (
									<ItemCard key={item.id} item={item} accent={accent} />
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</Reveal>
	);
}

/**
 * One goal: a title, one sentence, and the status on the card itself.
 *
 * 🚨 **The pill is what carries the tense, now that the descriptions are one line.** An
 * earlier draft ran a paragraph per goal plus a separate sentence saying where it actually
 * stood, which was honest and unreadable. The trade is that the section heading alone is
 * no longer allowed to be the only thing telling a reader that a goal is unbuilt — so
 * every card states its own status, adjacent to its own text, and `note` corrects the
 * cases where the pill is not enough on its own.
 */
function ItemCard({ item, accent }: { item: RoadmapItem; accent: (typeof ACCENT)[Bucket] }) {
	const status =
		item.bucket === "launched" ? item.quarter : item.bucket === "active" ? "Active" : "Planned";

	return (
		<article
			id={`goal-${item.id}`}
			className="flex min-w-0 flex-col rounded-2xl border border-base-content/10 bg-base-100 p-5 shadow-sm"
		>
			<div className="flex items-start justify-between gap-3">
				<h5 style={serif} className="min-w-0 text-base font-medium leading-snug">
					{item.title}
				</h5>
				<span
					className={`shrink-0 rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold ${accent.pill}`}
				>
					{status}
				</span>
			</div>
			<p className="mt-1.5 text-sm leading-relaxed text-base-content/65">{item.blurb}</p>
			{item.note && (
				<p className="mt-2 text-sm leading-relaxed text-base-content/45">{item.note}</p>
			)}
			{item.doc && <DocChip doc={item.doc} />}
		</article>
	);
}

/**
 * The documentation button.
 *
 * ⏳ **Inert today, by design.** `docHref` returns null for every page because the wiki is
 * not served from this site yet, so the chip names the page rather than linking to it. That
 * is more honest than hiding the button: it tells a reader the documentation exists and has
 * not been published, which is true, and which is itself a goal on this page. **A button
 * that navigated to a 404 would be the failure this avoids** — nothing typechecks a route
 * that does not exist.
 *
 * When the wiki ships, `docHref` learns the scheme and this renders an anchor. The chip's
 * appearance is deliberately near-identical either way, so the page does not visibly
 * change shape on the day it happens.
 */
function DocChip({ doc }: { doc: NonNullable<RoadmapItem["doc"]> }) {
	const href = docHref(doc);
	const inner = (
		<>
			<BookOpenIcon className="h-3.5 w-3.5 shrink-0" />
			<span className="truncate">{doc.title}</span>
		</>
	);
	const shape =
		"mt-4 inline-flex max-w-full items-center gap-1.5 self-start rounded-full border px-3 py-1 text-xs";

	if (!href) {
		return (
			<span
				className={`${shape} border-dashed border-base-content/15 text-base-content/35`}
				title="Not published yet — the wiki is not served from this site"
			>
				{inner}
			</span>
		);
	}
	return (
		<Link
			to={href}
			className={`${shape} border-base-content/15 text-base-content/60 transition-colors hover:border-primary/40 hover:text-primary`}
		>
			{inner}
		</Link>
	);
}

/**
 * How Anthers grows — the second half of the roadmap, and the one people ask about.
 *
 * ⚠️ **Numbers are deliberately absent and their absence is stated** (Parker, 2026-09-03).
 * The ladder's rungs are not settled, and publishing a figure that will move is a choice
 * with a cost: a reader remembers the number and not the caveat beside it. So this section
 * publishes the *mechanism*, which is the part that will still be true afterwards. The two
 * structural points on the ladder are described by what becomes possible at each rather
 * than by the account count that reaches it — the counts are anchored on a compensation
 * figure that is Parker's own income, and attaching that to a growth target pre-launch is a
 * different act from it appearing on an annual return later.
 *
 * 🚨 The joiner-facing half of this is governed by the wiki's *Why Joining May Have to
 * Wait*. **Where this section and that page disagree, that page is right.** It is not
 * linked here because the wiki is not served from this site yet — which is itself a goal on
 * this page.
 */
function Growth() {
	return (
		<Section>
			<Reveal>
				<Eyebrow>How Anthers grows</Eyebrow>
				<H2>Behind a ceiling, on purpose</H2>
				<Lede>
					Anthers intends to grow through a series of stages. Each one has a limit on how many
					accounts exist and a separate limit on how many creators, and when a limit is reached new
					signups stop and arrivals join a queue. None of it is enforced yet, and the specific
					numbers are not settled — what follows is a commitment about how Anthers will grow rather
					than a description of a gate you can meet today.
				</Lede>
			</Reveal>

			<div className="mx-auto mt-14 max-w-3xl space-y-10 text-left">
				<Reveal>
					<GrowthBlock title="Why a Ceiling Rather Than a Plan">
						<p>
							A growth plan says what an organization expects. A ceiling says what it permits. The
							difference matters because both of the things that actually bound Anthers are rates
							measured against a capacity, and neither announces itself before it is exceeded.
						</p>
						<p>
							<strong>Safety capacity is the first.</strong> The obligations that cannot be
							delegated — illegal content, platform-wide abuse, anything with a legal clock attached
							— scale with the number of incidents, and incidents scale roughly with accounts and
							uploads. The people handling them number one. A cap belongs on the thing incidents
							scale with, because the alternative is discovering the limit by missing something.
						</p>
						<p>
							<strong>Money is the second, and it is the less obvious one.</strong> Every account
							carries a subsidized share of the Time Pool whether it pays anything or not, which is
							what makes free access real rather than a trial. So self-sufficiency here is a ratio
							rather than a size: below a certain share of people paying, each new group of arrivals
							costs more in free access than it brings in, and growing makes the gap worse instead
							of better.
						</p>
						<p>
							<strong>A ceiling is also the measuring instrument, not only the brake.</strong> The
							only way to learn the real paying share is to admit a group of people and watch what
							they do, and a ceiling is what makes a group a group rather than an unbounded inflow.
							That is why the early limits sit close together: each one is a measurement, and
							measurements are worth taking often while the number is still unknown.
						</p>
					</GrowthBlock>
				</Reveal>

				<Reveal>
					<GrowthBlock title="Filling a Ceiling Does Not Open the Next One">
						<p>
							<strong>
								This is the rule most likely to disappoint, and it is the one Anthers most intends
								to keep.
							</strong>{" "}
							Reaching a limit is evidence of demand and nothing else. What opens the next stage is
							a checklist, and until it is met the correct behavior is to stay closed and let the
							queue grow.
						</p>
						<p>
							That checklist asks four things: that the safety floor is actually covered at the{" "}
							<em>next</em> stage's incident rate rather than merely provisioned for it; that the
							share of people paying clears the line the arithmetic needs, measured on people who
							actually joined rather than modeled; that whatever legal obligations the next stage
							newly trips have been discharged, since those land at thresholds rather than on dates;
							and that the organization has grown to match, because a stage's costs are committed
							before its people arrive.
						</p>
						<p>
							<strong>Nothing on that list is a date, and that is deliberate.</strong> A ceiling
							tied to a calendar is a plan with extra steps. A ceiling tied to a checklist is a
							commitment that survives the platform growing faster or slower than anyone guessed.
						</p>
					</GrowthBlock>
				</Reveal>

				<Reveal>
					<GrowthBlock title="How the Door Widens">
						<p>
							Admission is expected to open in three steps and then stay open.{" "}
							<strong>First, creators invite.</strong> Anthers seeds a first group of creators by
							hand and those creators bring their own audiences. This is not "people the founder
							knows" — that would test nothing except whether he has friends.
						</p>
						<p>
							There is a better reason for that order than pacing.{" "}
							<strong>A creator who invites is overwhelmingly inviting audience</strong>, so
							admission through creators moves the balance of accounts to creators in the direction
							it needs to go. That recruits the shape Anthers needs rather than refusing the shape
							it does not want, which a bare cap can only ever do.
						</p>
						<p>
							<strong>Then any account can invite</strong>, which tests whether Anthers spreads
							person to person without a creator in the middle.{" "}
							<strong>Then a public queue opens</strong>, and from that point the queue is the main
							door with invites continuing alongside it.
						</p>
						<p>
							<strong>The invite period is short and explicitly temporary.</strong> It buys organic
							pacing and real accountability — every early account traceable to somebody who vouched
							for them — and what it costs is exclusion-as-status, which sits badly beside
							everything else Anthers is for. An invite should read as{" "}
							<em>somebody wanted you here</em>, not as <em>you got past a rope</em>, and the queue
							opening is what stops the second reading taking hold.
						</p>
					</GrowthBlock>
				</Reveal>

				<Reveal>
					<GrowthBlock title="What Being Blocked Should Feel Like">
						<p>
							<strong>A closed door has to fail legibly.</strong> If you cannot join you should be
							told the real reason, given your position, and told what changes it. Anything less
							reads as a broken signup form, which is both worse and less honest. Three things
							Anthers commits to about the queue:
						</p>
						<p>
							<strong>There are two queues and they move independently.</strong> Accounts and
							creators are bounded by different things, so you may be admitted as a reader while
							still waiting as a creator, and the creator queue may be closed while the reader queue
							moves.
						</p>
						<p>
							<strong>Admissions are metered rather than released all at once.</strong> Opening a
							stage to its full ceiling on day one produces exactly the support and moderation spike
							the ceiling exists to prevent. On the early stages the rate matters more than the
							limit, because a small number of admissions is still a lot if they all arrive in an
							afternoon.
						</p>
						<p>
							<strong>Where you are matters, and Anthers cannot yet say how much.</strong>{" "}
							Publishing currently depends on the countries our payment processor operates in, and
							how many creators that excludes, and from where, is not something we can presently
							measure.
						</p>
					</GrowthBlock>
				</Reveal>

				<Reveal>
					<GrowthBlock title="Two Points on the Ladder That Are Not Pacing">
						<p>
							Most of the stages are pacing. Two are structural, and the ladder is built around
							them:{" "}
							<strong>the scale at which running Anthers can be somebody's full-time job</strong>,
							and the later scale at which <strong>it can pay somebody besides its founder</strong>.
							Everything below the first is Anthers as a side project with a bounded blast radius.
							Everything above it is Anthers as a job.
						</p>
						<p>
							The second lands a good deal further up than people expect, which is worth saying
							plainly: by the time a first hire is affordable, Anthers is already carrying a
							full-time director and is a materially different organization. Hiring is not the
							escape hatch from an overloaded solo stage; reaching the first point sooner is.
						</p>
						<p>
							<strong>The account numbers behind those two points are not published here.</strong>{" "}
							They are anchored on a compensation figure, and they will move as the model does. What
							is durable is the shape — that there is a scale at which this becomes a job, and a
							later one at which it becomes an organization — and the shape is the part worth
							committing to in public.
						</p>
					</GrowthBlock>
				</Reveal>
			</div>
		</Section>
	);
}

function GrowthBlock({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded-3xl border border-base-content/10 bg-base-100 p-7 shadow-sm sm:p-9">
			<h3 style={serif} className="text-2xl font-light">
				{title}
			</h3>
			<div className="mt-4 space-y-4 text-sm leading-relaxed text-base-content/70 sm:text-base">
				{children}
			</div>
		</div>
	);
}

function Closing() {
	return (
		<Section tint>
			<Reveal>
				<Eyebrow>Built in the open</Eyebrow>
				<H2>Hold us to this</H2>
				<Lede>
					This page is written by hand rather than generated from anything, which means it can go
					out of date without anything noticing. The source that runs Anthers is public, so the
					fastest way to check a claim on this page is to go and read the thing it describes.
					Priorities here are shaped by creators and readers rather than by investors, because there
					are no investors.
				</Lede>
				<div className="mt-9 flex flex-wrap justify-center gap-3">
					<a
						href="https://github.com/anthers-inc/anthers"
						className="btn btn-primary rounded-lg px-7"
						rel="noreferrer"
					>
						Read the source
					</a>
					<Link to="/faq" className="btn btn-ghost rounded-lg px-7">
						The FAQ
					</Link>
					<Link to="/about" className="btn btn-ghost rounded-lg px-7">
						About Anthers
					</Link>
				</div>
			</Reveal>
		</Section>
	);
}
