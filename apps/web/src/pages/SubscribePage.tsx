// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Support page (route: /subscribe) — the middle of the funnel.
//
// Its job is to explain how support works and then open a door: a free account, or a
// monthly amount pointed at Anthers and at creators. It is NOT a report on what a user
// already holds — that is /subscription, and conflating the two is what the previous
// revision did.
//
// The page is a guided sequence, and the order is the argument:
//
//   1. Anthers is free — an email address and nothing else, with no card asked for at any
//      point unless the visitor chooses to back someone — shown with a reel of work anyone
//      can open, and closing with what support is: one thing, the destination differing.
//   2. What support for a CREATOR does, with its breakdown, ending in a creator search.
//   3. What support for ANTHERS does, with the same breakdown, ending in a yes/no.
//
// 🚨 Steps 2 and 3 were the other way round until 2026-08-17, and creator support was not
// mentioned until the third section. That order was a relic of the model where support for
// Anthers bought streaming bandwidth generally, so it was the thing every visitor needed.
// It buys Public Access now and nothing else; early visitors arrive at the invitation of a
// creator already here, and with few creators there is little Public Access to want yet.
// So the creator ask leads and the Anthers ask follows it — and step 1 says outright that
// an account costs an email address, because for a share of visitors the load-bearing fact
// is that Anthers is free forever with no strings, not what a payment would buy.
//
// Each step that asks something answers it in place — a `SectionEcho` under the controls,
// defaulting to *nothing chosen* — and the closing section adds the page up once. That
// replaced a sticky tray in a right-hand rail: the rail fought the one thing every other
// marketing page does, which is centre a single column, and it put a choice and its
// consequence in different eyelines.
//
// The question the page asks is *whether*, never *how much*: a creator pick is
// follow-or-back rather than a stepper, because the amount is a conversation for after
// the account exists and asking it here costs conversion for no information.
//
// ⚠️ PROPOSAL vs. SHIPPED. Public Access is a proposal — the working plan is the vault's
// `90-99 Agents/Transient/Public Access Model Revamp 20260811`, and where this disagrees
// with the wiki the wiki is still right. Everything drawn from `@anthers/shared/constants`
// is real and charged against. The two figures that used to be quarantined here as a
// SPIKE — the free hours and the free-account Time Pool — are both real constants
// as of 2026-08-12 and are now read rather than typed.
//
// What is wired to real data, and what is not:
//   • The reel is REAL — `GET /api/content/open-works` returns released, streamable Works
//     that are free to everyone. That predicate holds under both the current model and the
//     proposal, so the endpoint needed no opinion about which gate kinds exist.
//   • The creator finder is REAL — `GET /api/accounts/creators`, whose `mediums` come from
//     what each creator has actually released rather than anything they declare.
//   • Support for ANTHERS commits for real, through the same preview + modal ceremony the
//     inline post unlock uses.
//   • Following commits for real.
//   • Support for a CREATOR rides on the SAME subscription as the Anthers one — ONE ITEM
//     PER DESTINATION, itemised, so the invoice names them. ⚠️ This described a shared
//     *quantity* until 2026-08-16 ("one to Anthers and one each to two creators is quantity
//     3 at $9/month"); the Seed retirement replaced that with N items carrying their own
//     amounts, because a quantity can only express multiples of one unit. The split rides
//     in subscription metadata; see `anthersSupportFromSub` in services/billing.ts.
//     (`POST /subscriptions/seeds/buy` also exists as a one-off top-up of the creator
//     balance. It is not this path — a separate charge pays the fixed $0.30 twice — and
//     nothing in the UI calls it.)

import {
	amountLabel,
	cardFeeDisplay,
	FREE_TIME_POOL,
	PUBLIC_ACCESS_PRICE,
	timePoolFor,
} from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { useAuth } from "@anthers/web-shared/auth";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { FONTS } from "@anthers/web-shared/fonts";
import { sanitizeNextPath, withNextPath } from "@anthers/web-shared/nextPath";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SignupCeremonyModal from "../components/subscribe/SignupCeremonyModal";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";

/* ── Free-tier figures ────────────────────────────────────────────────────────
 * Both of these were quarantined in a named `SPIKE` block until 2026-08-12, because
 * Public Access was a proposal and neither number had code behind it. Both are real
 * now and are read from the modules that own them, so this page cannot drift from the
 * meter that enforces the hours or the ledger that funds the pool.
 *
 * 🚨 `FREE_TIME_POOL` in particular is **explicitly provisional** and expected to move —
 * which is exactly why it must not be transcribed here. See its note in `constants.ts`.
 */

/** Where support for Anthers goes, at the worst case of it alone on the charge. */
const ANTHERS_PAYMENTS = cardFeeDisplay(PUBLIC_ACCESS_PRICE);
const ANTHERS_REMAINDER = PUBLIC_ACCESS_PRICE - timePoolFor(PUBLIC_ACCESS_PRICE) - ANTHERS_PAYMENTS;
/** What a lone directed amount reaches its creator as — gross, less its share of the fee. */
const CREATOR_NET = PUBLIC_ACCESS_PRICE - ANTHERS_PAYMENTS;

/** How many creators a shuffle draws. Two rows at most, at every breakpoint. */
const HANDFUL = 6;

/** Work types, in the shape a reader recognises. Keys are `works.type` values. */
const MEDIUMS = [
	{ key: "game", label: "Games" },
	{ key: "video", label: "Video" },
	{ key: "audio", label: "Audio" },
	{ key: "text", label: "Writing" },
] as const;

/** Picks survive a trip through signup, so nobody loses their choices to a redirect. */
const PICKS_KEY = "anthers_subscribe_picks";

/** The marketing display face, as the other marketing pages set it. */
const serif = { fontFamily: FONTS.fraunces };

interface OpenWork {
	publicId: number;
	slug: string;
	title: string | null;
	type: string;
	thumbnail: string | null;
	durationSeconds: number | null;
	estimatedReadMinutes: number | null;
	creator: { username: string; displayName: string | null };
}

interface Picks {
	/** null = unanswered, which is not the same as "no" and must not render as a choice. */
	anthers: boolean | null;
	follow: string[];
	seed: string[];
}

const EMPTY_PICKS: Picks = { anthers: null, follow: [], seed: [] };

/**
 * What the whole charge comes to, in **dollars a month**.
 *
 * 🚨 **This was a COUNT until 2026-08-16, and both of its consumers take an amount.**
 * `anthers` was `1` for "ticked" and the total was `1 + directed.length`, which the page
 * then handed to `preview/:amount` and to the subscribe body's `anthersSupport`. That was
 * correct while a Seed was an indivisible $3 and the server multiplied by it; the
 * retirement made the server take dollars and multiply by nothing, so the ceremony
 * **quoted $3 for a $9 charge** and then subscribed the user at **$1 a month** — under the
 * $3 that lifts the Public Access limit they had just agreed to pay for.
 *
 * Extracted rather than inlined so the conversion has a test. Nothing else on this page
 * can be unit-tested — the ceremony's own e2e cannot complete a payment, because the
 * emailed code is argon2-hashed at rest by design.
 */
export function supportTotal(
	anthers: boolean | null,
	directed: { amount: number }[],
	anthersPrice = PUBLIC_ACCESS_PRICE,
): number {
	const toAnthers = anthers === true ? anthersPrice : 0;
	return directed.reduce((sum, d) => sum + d.amount, toAnthers);
}

const money = amountLabel;

function initialsOf(name: string): string {
	return (
		name
			.split(/\s+/)
			.map((w) => w[0])
			.join("")
			.replace(/[^a-z]/gi, "")
			.slice(0, 2)
			.toLowerCase() || "an"
	);
}

/** A creator's display name, falling back to the handle that always exists. */
function nameOf(creator: PublicUser): string {
	return creator.displayName || creator.username;
}

/** How long a Work takes, in the unit its own medium is measured in. */
function runtimeOf(work: OpenWork): string {
	if (work.estimatedReadMinutes) return `${work.estimatedReadMinutes} min read`;
	if (work.durationSeconds) {
		const mins = Math.round(work.durationSeconds / 60);
		if (mins < 60) return `${mins} min`;
		return `${Math.floor(mins / 60)} hr ${String(mins % 60).padStart(2, "0")}`;
	}
	if (work.type === "game" || work.type === "software") return "Play in your browser";
	return "Free to everyone";
}

/* ── Small pieces ───────────────────────────────────────────────────────────── */

/** A drawn medium mark — the reel's fallback when a Work carries no thumbnail. */
function MediumGlyph({ type, className }: { type: string; className?: string }) {
	const paths: Record<string, React.ReactNode> = {
		game: (
			<>
				<rect x="6" y="16" width="36" height="20" rx="8" />
				<path d="M15 26h6M18 23v6M30 25h.01M34 29h.01" />
			</>
		),
		video: (
			<>
				<rect x="7" y="13" width="24" height="22" rx="4" />
				<path d="M31 22l10-6v16l-10-6z" />
			</>
		),
		audio: <path d="M11 24v4M18 18v16M25 12v24M32 19v14M39 23v6" />,
		text: (
			<>
				<path d="M13 12h22v24H13z" />
				<path d="M18 20h12M18 26h12M18 32h7" />
			</>
		),
	};
	return (
		<svg
			viewBox="0 0 48 48"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			{paths[type] ?? paths.text}
		</svg>
	);
}

/** The step marker — numbered because the page really is a sequence. */
function StepNumber({ n }: { n: number }) {
	return (
		<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-content">
			{n}
		</span>
	);
}

/**
 * A step's heading block.
 *
 * Centred, and in the Fraunces display face at the marketing scale, because this page
 * sits in the same lineup as /for-users and /about and was reading as a different site:
 * bold sans headings hard against the left edge, while every neighbouring page centres a
 * light serif inside a capped column.
 */
function StepHeading({
	n,
	title,
	children,
}: {
	n: number;
	title: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="text-center">
			<div className="mb-4 flex justify-center">
				<StepNumber n={n} />
			</div>
			<h2 style={serif} className="text-balance text-3xl font-light leading-tight sm:text-4xl">
				{title}
			</h2>
			{children && (
				<p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-base-content/65">
					{children}
				</p>
			)}
		</div>
	);
}

/** One segment of the Seed breakdown. */
interface Segment {
	amount: number;
	label: string;
	desc: string;
	tone: "pool" | "mission" | "pay";
}

const SEGMENT_BG: Record<Segment["tone"], string> = {
	pool: "bg-success/70",
	mission: "bg-info/40",
	pay: "bg-base-300",
};

/**
 * Where a Seed goes — one component, used twice.
 *
 * The two destinations are the same picture with different segments, which is what makes
 * the contrast legible without inventing a second visual language for it.
 */
function SeedBreakdown({ segments, note }: { segments: Segment[]; note: string }) {
	return (
		<div className="mx-auto max-w-xl">
			<div className="flex h-11 overflow-hidden rounded-xl border border-base-content/10">
				{segments.map((s) => (
					<div
						key={s.label}
						className={`grid min-w-0 place-items-center text-sm font-bold tabular-nums ${SEGMENT_BG[s.tone]}`}
						style={{ flexGrow: Math.round(s.amount * 100) }}
					>
						{money(s.amount)}
					</div>
				))}
			</div>
			<ul className="mt-4 space-y-2.5">
				{segments.map((s) => (
					<li key={s.label} className="flex items-baseline gap-2.5 text-sm">
						<span
							aria-hidden="true"
							className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm ${SEGMENT_BG[s.tone]}`}
						/>
						<span className="leading-snug">
							<span className="text-base-content/80">{s.label}</span>
							<span className="block text-xs text-base-content/45">{s.desc}</span>
						</span>
						<strong className="ml-auto shrink-0 tabular-nums">{money(s.amount)}</strong>
					</li>
				))}
			</ul>
			<div className="mt-3 flex items-baseline justify-between border-t border-base-content/10 pt-3">
				<span className="font-bold">Total</span>
				<span className="text-xl font-bold tabular-nums">{money(PUBLIC_ACCESS_PRICE)}/mo</span>
			</div>
			<p className="text-right text-xs text-base-content/45">plus any applicable tax</p>
			<p className="mt-3 text-xs leading-relaxed text-base-content/50">{note}</p>
		</div>
	);
}

/** The yes/no ask. `null` renders as unanswered — neither button pressed. */
function Ask({
	title,
	children,
	value,
	yesLabel,
	noLabel,
	onChange,
}: {
	title: string;
	children: React.ReactNode;
	value: boolean | null;
	yesLabel: string;
	noLabel: string;
	onChange: (v: boolean | null) => void;
}) {
	return (
		<div
			className={`mx-auto mt-8 max-w-xl rounded-2xl border p-5 transition-colors ${
				value === true ? "border-primary/45 bg-primary/5" : "border-base-content/10 bg-base-200/60"
			}`}
		>
			<h3 className="text-lg font-bold">{title}</h3>
			<p className="mt-1 max-w-prose text-sm leading-relaxed text-base-content/60">{children}</p>
			<div className="mt-4 flex flex-wrap gap-2.5">
				<button
					type="button"
					className={`btn btn-sm rounded-full ${value === true ? "btn-primary" : "btn-outline"}`}
					aria-pressed={value === true}
					onClick={() => onChange(value === true ? null : true)}
				>
					{value === true ? "✓ " : ""}
					{yesLabel}
				</button>
				<button
					type="button"
					className={`btn btn-sm rounded-full ${value === false ? "btn-neutral" : "btn-ghost"}`}
					aria-pressed={value === false}
					onClick={() => onChange(value === false ? null : false)}
				>
					{noLabel}
				</button>
			</div>
		</div>
	);
}

/* ── Step 1 · the reel ──────────────────────────────────────────────────────── */

/**
 * A thin row of work anyone can open.
 *
 * One row rather than a grid, deliberately: it is proof that the commons exists, not a
 * browsing surface, and a handful of cards on a scrollable row reads as a selection at
 * any catalog size — which matters most at launch, when there won't be many.
 */
function OpenWorksReel() {
	const [works, setWorks] = useState<OpenWork[] | null>(null);
	const scroller = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		client.api.content["open-works"]
			.$get({ query: { limit: "12" } })
			.then((res) => (res.ok ? res.json() : { works: [] }))
			.then((data) => {
				if (live) setWorks((data as { works: OpenWork[] }).works);
			})
			.catch(() => {
				if (live) setWorks([]);
			});
		return () => {
			live = false;
		};
	}, []);

	// Nothing to prove the commons with yet — say nothing rather than show an empty shelf.
	if (works !== null && works.length === 0) return null;

	const nudge = (dir: number) =>
		scroller.current?.scrollBy({ left: dir * 210, behavior: "smooth" });

	return (
		<div className="mt-8">
			<div className="mb-3 flex items-center justify-between gap-4">
				<p className="text-xs font-semibold uppercase tracking-wider text-base-content/40">
					Open to everyone right now
				</p>
				{works && works.length > 2 && (
					<div className="flex gap-2">
						<button
							type="button"
							className="btn btn-circle btn-outline btn-xs"
							onClick={() => nudge(-1)}
							aria-label="Scroll back"
						>
							←
						</button>
						<button
							type="button"
							className="btn btn-circle btn-outline btn-xs"
							onClick={() => nudge(1)}
							aria-label="Scroll forward"
						>
							→
						</button>
					</div>
				)}
			</div>
			<div ref={scroller} className="flex snap-x gap-3 overflow-x-auto pb-2">
				{works === null
					? // Placeholders hold the row's height while it loads, so nothing jumps.
						Array.from({ length: 4 }, (_, i) => (
							<div
								key={`skeleton-${i}`}
								className="h-[10.5rem] w-[11.5rem] shrink-0 animate-pulse rounded-xl bg-base-200"
							/>
						))
					: works.map((work) => (
							<Link
								key={work.publicId}
								to={`/works/${work.slug}-${work.publicId}`}
								className="w-[11.5rem] shrink-0 snap-start overflow-hidden rounded-xl border border-base-content/10 bg-base-100 transition-shadow hover:shadow-md"
							>
								<div className="grid aspect-video place-items-center bg-base-200 text-primary">
									{work.thumbnail ? (
										<img
											src={work.thumbnail}
											alt=""
											className="h-full w-full object-cover"
											loading="lazy"
										/>
									) : (
										<MediumGlyph type={work.type} className="h-9 w-9 opacity-80" />
									)}
								</div>
								<div className="p-2.5">
									<p className="line-clamp-2 text-sm font-semibold leading-snug">
										{work.title || "Untitled"}
									</p>
									<p className="mt-0.5 truncate text-xs text-base-content/45">
										{work.creator.displayName || work.creator.username}
									</p>
									<p className="mt-1.5 text-[11px] text-base-content/55">{runtimeOf(work)}</p>
								</div>
							</Link>
						))}
			</div>
		</div>
	);
}

/* ── Step 4 · the creator finder ────────────────────────────────────────────── */

/**
 * Search by name, or tap a medium for a handful.
 *
 * The medium chips SHUFFLE rather than filter: tapping one draws a few creators who work
 * in it, and tapping it again draws different ones. A directory has to be complete before
 * it's worth browsing, and at launch it won't be — a handful that changes always reads as
 * discovery instead.
 */
function CreatorFinder({
	creators,
	loading,
	picks,
	onToggle,
}: {
	creators: PublicUser[];
	loading: boolean;
	picks: Picks;
	onToggle: (username: string, kind: "follow" | "seed") => void;
}) {
	const [query, setQuery] = useState("");
	const [medium, setMedium] = useState<string | null>(null);
	const [shuffle, setShuffle] = useState(0);

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q) {
			return creators
				.filter(
					(c) =>
						c.username.toLowerCase().includes(q) || (c.displayName ?? "").toLowerCase().includes(q),
				)
				.slice(0, HANDFUL);
		}
		const pool = medium
			? creators.filter((c) => (c.mediums ?? []).includes(medium))
			: creators.slice();
		// Fisher–Yates, so tapping the same medium again genuinely redraws rather than
		// reordering the same six. `shuffle` is a dependency purely to force the redraw.
		void shuffle;
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool.slice(0, HANDFUL);
	}, [creators, query, medium, shuffle]);

	return (
		<div className="mt-6">
			<label className="input input-bordered mx-auto flex max-w-md items-center gap-2 rounded-full">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
					className="h-4 w-4 shrink-0 opacity-40"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="6" />
					<path d="M20 20l-4.5-4.5" />
				</svg>
				<input
					type="search"
					className="grow"
					placeholder="Search creators by name"
					aria-label="Search creators by name"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>

			<div className="mt-3 flex flex-wrap items-center justify-center gap-2">
				{MEDIUMS.map((m) => (
					<button
						key={m.key}
						type="button"
						className={`btn btn-xs rounded-full ${medium === m.key ? "btn-neutral" : "btn-outline"}`}
						aria-pressed={medium === m.key}
						onClick={() => {
							setQuery("");
							setMedium(m.key);
							setShuffle((n) => n + 1);
						}}
					>
						{m.label}
					</button>
				))}
				<span className="text-xs text-base-content/40">
					{medium ? "Tap again for a different handful." : "Tap one for a handful."}
				</span>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{loading ? (
					Array.from({ length: 3 }, (_, i) => (
						<div key={`c-skeleton-${i}`} className="h-28 animate-pulse rounded-xl bg-base-200" />
					))
				) : shown.length === 0 ? (
					<p className="col-span-full rounded-xl border border-dashed border-base-content/15 p-5 text-center text-sm text-base-content/50">
						{query
							? "No one by that name yet — try a medium, or browse everyone on Discover."
							: "No creators here yet. They're on their way."}
					</p>
				) : (
					shown.map((creator) => {
						const followed = picks.follow.includes(creator.username);
						const seeded = picks.seed.includes(creator.username);
						return (
							<div
								key={creator.id}
								className={`rounded-xl border p-3.5 transition-colors ${
									followed || seeded
										? "border-primary/40 bg-primary/5"
										: "border-base-content/10 bg-base-100"
								}`}
							>
								<div className="flex items-center gap-2.5">
									{creator.avatar ? (
										<img
											src={creator.avatar}
											alt=""
											className="h-9 w-9 shrink-0 rounded-full object-cover"
										/>
									) : (
										<span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-primary-content">
											{initialsOf(nameOf(creator))}
										</span>
									)}
									<span className="min-w-0">
										<Link
											to={`/${creator.username}`}
											className="block truncate text-sm font-bold hover:underline"
										>
											{nameOf(creator)}
										</Link>
										<span className="block truncate text-xs text-base-content/45">
											{(creator.mediums ?? [])
												.map((m) => MEDIUMS.find((x) => x.key === m)?.label ?? m)
												.slice(0, 2)
												.join(" · ") || `@${creator.username}`}
										</span>
									</span>
								</div>
								<div className="mt-3 flex flex-wrap gap-2">
									<button
										type="button"
										className={`btn btn-xs rounded-full ${followed ? "btn-outline btn-primary" : "btn-outline"}`}
										aria-pressed={followed}
										onClick={() => onToggle(creator.username, "follow")}
									>
										{followed ? "✓ Following" : "Follow"}
									</button>
									<button
										type="button"
										className={`btn btn-xs rounded-full ${seeded ? "btn-primary" : "btn-outline"}`}
										aria-pressed={seeded}
										onClick={() => onToggle(creator.username, "seed")}
									>
										{seeded ? "✓ Supporting" : "Support"}
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
			{/* ⚠️ This said "how much each creator gets is a question for once your account
			    exists — right now it's just who", which the echo below it contradicts: a
			    pick adds a real priced line. The page still asks *whether* rather than *how
			    much*, so name the starting amount and say where it is changed. */}
			<p className="mt-4 text-center text-xs text-base-content/45">
				Backing someone starts at {money(PUBLIC_ACCESS_PRICE)} a month each. You can change the
				amount, or add and drop creators, whenever you like once your account exists.
			</p>
		</div>
	);
}

/* ── Per-section feedback, and the summary that adds it up ──────────────────── */

interface PickLine {
	key: string | null;
	label: string;
	sub: string;
	amount: number;
}

/**
 * What this section currently amounts to, stated under the section itself.
 *
 * Every step that asks something answers it in place rather than reporting into a rail
 * off to one side: a choice and its consequence belong in the same eyeline, and the page
 * can then be a single centred column like the rest of the marketing lineup. The default
 * is always *nothing chosen*, said plainly — an unanswered step reads as unanswered
 * rather than as a quiet no.
 */
function SectionEcho({
	empty,
	lines,
	onDrop,
}: {
	empty: string;
	lines: PickLine[];
	onDrop: (key: string) => void;
}) {
	const total = lines.reduce((sum, l) => sum + l.amount, 0);
	return (
		<div
			className={`mx-auto mt-8 max-w-xl rounded-2xl border px-5 py-4 transition-colors ${
				lines.length > 0
					? "border-primary/35 bg-primary/5"
					: "border-dashed border-base-content/15 bg-base-200/40"
			}`}
		>
			{lines.length === 0 ? (
				<p className="text-center text-sm text-base-content/50">{empty}</p>
			) : (
				<>
					<ul className="space-y-2">
						{lines.map((line) => (
							<li key={line.key ?? line.label} className="flex items-baseline gap-3 text-sm">
								<span className="min-w-0">
									<span className="font-semibold">{line.label}</span>
									<span className="block text-xs text-base-content/50">{line.sub}</span>
								</span>
								<span className="ml-auto flex shrink-0 items-baseline gap-3">
									<strong className="tabular-nums">
										{line.amount ? `${money(line.amount)}/mo` : "Free"}
									</strong>
									{line.key && (
										<button
											type="button"
											className="text-xs text-base-content/45 underline"
											onClick={() => onDrop(line.key as string)}
										>
											Remove
										</button>
									)}
								</span>
							</li>
						))}
					</ul>
					{lines.length > 1 && (
						<p className="mt-3 border-t border-base-content/10 pt-2 text-right text-sm font-semibold tabular-nums">
							{money(total)}/mo from this step
						</p>
					)}
				</>
			)}
		</div>
	);
}

/** The closing panel — the only place the whole page is added up, and the only CTA. */
function Summary({
	lines,
	total,
	cta,
	busy,
	note,
	error,
	success,
	email,
	onEmailChange,
	onSubmit,
	onDrop,
}: {
	lines: PickLine[];
	total: number;
	cta: string;
	busy: boolean;
	note: string;
	error: string | null;
	success: string | null;
	/** Null when signed in — there is no address to ask a returning user for. */
	email: string | null;
	onEmailChange: (value: string) => void;
	onSubmit: () => void;
	onDrop: (key: string) => void;
}) {
	return (
		<div className="mx-auto mt-8 max-w-lg rounded-2xl border border-base-300 bg-base-200/60 p-6">
			<ul className="space-y-2.5">
				{lines.map((line) => (
					<li
						key={line.key ?? "free"}
						className="flex items-baseline gap-3 border-b border-base-content/5 pb-2.5 text-sm"
					>
						<span className="min-w-0">
							<span className="font-semibold">{line.label}</span>
							<span className="block text-xs text-base-content/45">{line.sub}</span>
						</span>
						<span className="ml-auto flex shrink-0 items-baseline gap-3">
							<strong className="tabular-nums">{line.amount ? money(line.amount) : "Free"}</strong>
							{line.key && (
								<button
									type="button"
									className="text-xs text-base-content/40 underline"
									onClick={() => onDrop(line.key as string)}
								>
									Remove
								</button>
							)}
						</span>
					</li>
				))}
			</ul>
			<div className="mt-4 flex items-baseline justify-between">
				<span className="font-bold">Monthly</span>
				<span className="text-3xl font-bold tabular-nums">{money(total)}</span>
			</div>
			{total > 0 && (
				<p className="text-right text-xs text-base-content/45">plus any applicable tax</p>
			)}

			{/* The ONE field this page collects. Username and password are deliberately not
			    asked for here — they cost nothing at the moment of decision and everything
			    at the moment of doubt, so they move to onboarding, after the address is
			    confirmed and after any charge. */}
			{email !== null && (
				<form
					className="mt-5"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmit();
					}}
				>
					<label className="label px-0 pb-1" htmlFor="subscribe-email">
						<span className="text-sm font-semibold">Where should we reach you?</span>
					</label>
					<input
						id="subscribe-email"
						type="email"
						required
						autoComplete="email"
						placeholder="you@example.com"
						className="input input-bordered w-full"
						value={email}
						onChange={(e) => onEmailChange(e.target.value)}
					/>
					<button
						type="submit"
						className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
						disabled={busy}
					>
						{busy ? "Working…" : cta}
					</button>
				</form>
			)}

			{email === null && (
				<button
					type="button"
					className={`btn btn-primary btn-lg mt-5 w-full ${busy ? "btn-disabled" : ""}`}
					onClick={onSubmit}
					disabled={busy}
				>
					{busy ? "Working…" : cta}
				</button>
			)}
			{error && <p className="mt-3 text-sm text-error">{error}</p>}
			{success && <p className="mt-3 text-sm text-success">{success}</p>}
			<p className="mt-3 text-center text-xs leading-relaxed text-base-content/45">{note}</p>
		</div>
	);
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function SubscribePage() {
	const { user, refreshUser } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const signedIn = !!user;

	/**
	 * Where to hand the visitor back to once this is over, if they came from somewhere.
	 *
	 * Set by the gated-post unlock modal, which is the case that matters: someone who
	 * clicked "Create an account" to read one particular thing. It rides through the whole
	 * detour — ceremony, possible payment modal, `/welcome` — and onboarding does the final
	 * hop, because a new account still owes a handle and the terms before it goes anywhere.
	 *
	 * 🚨 Read through `sanitizeNextPath` every time, never off `URLSearchParams` directly:
	 * this value is attacker-controlled, and it decides where a person lands seconds after
	 * typing a code from their inbox.
	 */
	const next = sanitizeNextPath(new URLSearchParams(location.search).get("next"));

	const [email, setEmail] = useState("");
	/** The address a ceremony is open for, or null when it isn't. */
	const [ceremony, setCeremony] = useState<string | null>(null);
	/**
	 * Whether this session was minted by the ceremony just now, and still owes a handle.
	 *
	 * A ref rather than state because it is read inside `commit` immediately after being
	 * set, in the same turn — a state update would not have landed yet, and the account
	 * would be left on the marketing page instead of being sent to onboarding.
	 */
	const justSignedUp = useRef(false);

	const [picks, setPicks] = useState<Picks>(EMPTY_PICKS);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [loadingCreators, setLoadingCreators] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [pending, setPending] = useState<{
		anthersSupport: number;
		directed: { creatorId: number; amount: number }[];
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);

	// Restore anything chosen before a trip through signup. Guarded because a browser with
	// storage disabled must not take the page down with it.
	useEffect(() => {
		try {
			const raw = sessionStorage.getItem(PICKS_KEY);
			if (raw) setPicks({ ...EMPTY_PICKS, ...(JSON.parse(raw) as Partial<Picks>) });
		} catch {
			/* no storage, no restore — the page still works */
		}
	}, []);

	useEffect(() => {
		try {
			sessionStorage.setItem(PICKS_KEY, JSON.stringify(picks));
		} catch {
			/* see above */
		}
	}, [picks]);

	useEffect(() => {
		let live = true;
		client.api.accounts.creators
			.$get()
			.then((res) => res.json())
			.then((data) => {
				if (live) setCreators(data.creators as PublicUser[]);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoadingCreators(false);
			});
		return () => {
			live = false;
		};
	}, []);

	const toggleCreator = useCallback((username: string, kind: "follow" | "seed") => {
		setPicks((prev) => {
			const follow = new Set(prev.follow);
			const seed = new Set(prev.seed);
			if (kind === "seed") {
				if (seed.has(username)) {
					seed.delete(username);
				} else {
					seed.add(username);
					// Giving someone a Seed follows them too; the reverse isn't implied.
					follow.add(username);
				}
			} else if (follow.has(username)) {
				follow.delete(username);
				seed.delete(username);
			} else {
				follow.add(username);
			}
			return { ...prev, follow: [...follow], seed: [...seed] };
		});
	}, []);

	const dropPick = useCallback((key: string) => {
		setPicks((prev) =>
			key === "anthers"
				? { ...prev, anthers: null }
				: {
						...prev,
						follow: prev.follow.filter((u) => u !== key),
						seed: prev.seed.filter((u) => u !== key),
					},
		);
	}, []);

	const byUsername = useMemo(() => new Map(creators.map((c) => [c.username, c])), [creators]);

	/**
	 * 🚨 **The displayed total and the charged total are the SAME function**, and were two
	 * independent expressions until 2026-08-16.
	 *
	 * They agreed, so nothing was visibly wrong — but the page's summary said
	 * `(anthers + creators) × price` while the charge said `1 + creators`, and only the
	 * second one was broken by the Seed retirement. A page that computes what it shows and
	 * what it bills by different routes is one edit away from showing a number it does not
	 * charge, which is the exact failure the confirmation ceremony exists to prevent.
	 */
	const total = supportTotal(
		picks.anthers,
		picks.seed.map(() => ({ amount: PUBLIC_ACCESS_PRICE })),
	);

	/** Step 3's answer, in the shape the echo and the summary both render. Step 3 is the
	 *  Anthers ask — it was step 2 until 2026-08-17; see the resequencing note up top. */
	const anthersLines: PickLine[] = useMemo(
		() =>
			picks.anthers === true
				? [
						{
							key: "anthers",
							label: "Support for Anthers",
							sub: "watch as much Public Access as you like",
							amount: PUBLIC_ACCESS_PRICE,
						},
					]
				: [],
		[picks.anthers],
	);

	/** Step 2's answers — one line per creator, whether followed or backed. */
	const creatorLines: PickLine[] = useMemo(
		() =>
			picks.follow.map((username) => {
				const creator = byUsername.get(username);
				return {
					key: username,
					label: creator ? nameOf(creator) : username,
					sub: picks.seed.includes(username) ? "following · supporting" : "following",
					amount: picks.seed.includes(username) ? PUBLIC_ACCESS_PRICE : 0,
				};
			}),
		[picks.follow, picks.seed, byUsername],
	);

	/**
	 * The whole page, added up once — the only place a total appears.
	 *
	 * Listed in the order the page asks: the free account first, then the creators, then
	 * Anthers. The two support lines were the other way round until 2026-08-17, and a
	 * summary that reads in a different order from the steps above it makes a reader
	 * re-derive which line came from which choice.
	 */
	const summaryLines: PickLine[] = useMemo(
		() => [
			{
				key: null,
				label: "Free account",
				sub: `${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month`,
				amount: 0,
			},
			...creatorLines,
			...anthersLines,
		],
		[anthersLines, creatorLines],
	);

	/**
	 * Commit what can be committed.
	 *
	 * Signed out, the picks are already in session storage, so the account comes first and
	 * the page is waiting when they come back. Signed in, follows and creator-Seed
	 * allocations are applied, and Seeds for Anthers open the same confirmation modal the
	 * inline post unlock uses — one ceremony, so the charge is described identically
	 * wherever a user commits.
	 */
	/**
	 * Tell the auth context about the new session, then go.
	 *
	 * 🚨 **Refreshing the context is what unmounts this page, so it must be the LAST
	 * thing the ceremony does.** `/subscribe` renders inside `PublicShell`, which returns
	 * `LoggedOutLayout` or `LoggedInLayout` depending on `isAuthenticated`. Those are
	 * different component types, so the moment `refreshUser()` resolves React tears the
	 * subtree down and rebuilds it — and this page goes with it.
	 *
	 * That cost a real bug: verifying used to refresh immediately, so by the time the
	 * preview came back `setPending` was landing on an unmounted component and the
	 * payment modal never opened. Nothing errored. The free path appeared to work only
	 * because `navigate` still fires from a dead closure, which is exactly the kind of
	 * partial success that hides the problem.
	 *
	 * The session cookie is set at verification, so every call in between is already
	 * authenticated — the context is the only thing that doesn't know yet, and it does
	 * not need to until we are leaving.
	 */
	const leave = useCallback(
		async (path: string) => {
			await refreshUser();
			navigate(path);
		},
		[navigate, refreshUser],
	);

	const commit = useCallback(async () => {
		setBusy(true);
		setError(null);
		setSuccess(null);
		try {
			// Following costs nothing, so it is applied straight away rather than waiting on
			// a charge that may not even happen.
			for (const username of picks.follow) {
				const creator = byUsername.get(username);
				if (!creator || creator.isFollowing) continue;
				await client.api.accounts.users[":username"].follow.$post({ param: { username } });
			}

			// The Public Access price each, to the creators picked — on the SAME charge as
			// the Anthers one.
			const directed = picks.seed
				.map((username) => byUsername.get(username))
				.filter((creator): creator is PublicUser => !!creator)
				.map((creator) => ({ creatorId: creator.id, amount: PUBLIC_ACCESS_PRICE }));

			const anthers = picks.anthers === true ? PUBLIC_ACCESS_PRICE : 0;
			const total = supportTotal(picks.anthers, directed);

			if (total === 0) {
				// Nothing to charge. A brand-new account still has somewhere to be — the
				// handle it hasn't claimed — and sending it there is the difference between
				// finishing the ceremony and abandoning someone on a marketing page.
				if (justSignedUp.current) {
					await leave(withNextPath("/welcome", next));
					return;
				}
				// A RETURNING account, signed in by the ceremony rather than created by it.
				// It owes no handle, so there is no onboarding to pass through — but if it
				// came from somewhere, that somewhere is still the point of the visit, and
				// a success message on a marketing page is not it.
				if (next) {
					await leave(next);
					return;
				}
				setSuccess(
					picks.follow.length > 0 ? "Saved — you're following them now." : "Nothing to save yet.",
				);
				return;
			}

			// Preview prices the whole charge, so the modal quotes the total the user is
			// actually agreeing to rather than the Anthers half of it.
			const res = await client.api.subscriptions.preview[":amount"].$get({
				param: { amount: String(total) },
			});
			if (!res.ok) {
				setError("Couldn't load the charge details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSupport: anthers,
				directed,
				// The honest label is the amount: a commit needn't land on a Badge, and
				// naming one would describe only the Anthers half of this charge.
				badgeName: `${amountLabel(total)} a month`,
				preview,
			});
		} catch {
			setError("Something went wrong. Please try again.");
		} finally {
			setBusy(false);
		}
	}, [byUsername, leave, next, picks]);

	/**
	 * Commit what can be committed.
	 *
	 * Signed in, this goes straight to `commit`. Signed out, it opens the ceremony —
	 * which is a code box rather than a payment box, and which stays on this page. The
	 * old flow redirected to `/signup`, and the picks only survived because they were
	 * being written to session storage on every change; keeping the user here means the
	 * choices they just made are simply still in front of them.
	 */
	const submit = async () => {
		if (!signedIn) {
			const address = email.trim();
			if (!address) {
				setError("Add an email address so we can confirm it's you.");
				return;
			}
			setBusy(true);
			setError(null);
			try {
				// Answers 200 whatever happened, deliberately — see the route. So there is
				// nothing to branch on here, and the modal opens either way.
				await client.api.auth.signup.start.$post({ json: { email: address } });
				setCeremony(address);
			} catch {
				setError("Couldn't send the code. Please try again.");
			} finally {
				setBusy(false);
			}
			return;
		}
		await commit();
	};

	/**
	 * The address is confirmed and the browser now holds a session.
	 *
	 * Everything from here is an ordinary authenticated call, which is the entire reason
	 * the session is issued at verification rather than after payment — and note there is
	 * deliberately no `refreshUser()` here. See `leave`: telling the auth context is what
	 * unmounts this page, so it waits until the page is finished with.
	 */
	const onVerified = async (result: { created: boolean; needsOnboarding: boolean }) => {
		setCeremony(null);
		justSignedUp.current = result.needsOnboarding;

		// A returning user who already has a handle just gets signed in, and their picks
		// commit exactly as if they had been signed in all along.
		await commit();
	};

	const summaryProps = {
		lines: summaryLines,
		total,
		cta: signedIn
			? total > 0
				? "Confirm and continue"
				: "Save my picks"
			: total > 0
				? "Create my account & continue"
				: "Create my free account",
		busy,
		error,
		success,
		email: signedIn ? null : email,
		onEmailChange: setEmail,
		note: signedIn
			? "You'll see the exact charge before anything is confirmed. Change or stop any month."
			: total > 0
				? "We'll confirm your email first. You'll see the exact charge before anything is taken."
				: "We'll email you a code to confirm the address. A card is only needed if you choose to support someone.",
		onSubmit: submit,
		onDrop: dropPick,
	};

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade so this wrapper can
		// shrink below its content's min-content width on mobile; without `w-full`,
		// `mx-auto` on a flex item disables the default `align-self: stretch`.
		//
		// 🚨 ONE max-width, never two. This carried `max-w-full max-w-[80rem]` (inherited
		// from the page it replaced), and Tailwind resolves that pair by source order in
		// the generated stylesheet, not by order in the attribute — `.max-w-full` is
		// emitted last, so it won and the page ran the full width of the viewport at every
		// size. Nothing errors; the cap is simply never applied, which reads as a scattered
		// layout rather than as a bug. `max-w-6xl` matches the shared marketing `Section`.
		<div className="mx-auto min-w-0 w-full max-w-5xl px-6 py-12 sm:py-16">
			<div className="min-w-0">
				<div>
					{/* ── 1 · Free ───────────────────────────────────────────── */}
					<Reveal>
						<div className="text-center">
							<div className="mb-4 flex items-center justify-center gap-3">
								<StepNumber n={1} />
								<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
									A non-profit · no ads, no shareholders, no strings
								</p>
							</div>
							<h1
								style={serif}
								className="text-balance text-4xl font-light leading-tight sm:text-5xl"
							>
								Anthers is free. Forever.
							</h1>
							<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
								<strong>An email address is the whole of it.</strong> No card, no trial, nothing to
								cancel — and nothing to pay until you decide to back a creator. Every month you get{" "}
								<strong>{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access</strong> — the streaming
								work creators leave open to everyone. Follow whoever you like, keep a library, and
								buy anything a creator sells.
							</p>
						</div>
						<OpenWorksReel />

						{/* What support is, as the tail of "it's free" rather than as its own step: the
						    primitive is one sentence, and giving it a numbered step of its own made the
						    page look like it asked three things when it asks two.
						    ⚠️ The old copy said "a monthly amount, from $3". There is no floor of $3 —
						    that is what unlimited Public Access costs, and a creator sets their own
						    levels to any amount at all. Naming a floor describes a mechanism the Seed
						    retirement removed. */}
						<div className="mt-14">
							<p className="mx-auto max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
								Going further is one thing: a monthly amount. You choose how much, and you choose
								where it points.
							</p>
							<div className="mt-6 grid gap-4 sm:grid-cols-2">
								<div className="rounded-xl border border-base-content/10 bg-base-200/60 p-4">
									<h3 className="text-sm font-bold">Point it at a creator</h3>
									<p className="mt-1.5 text-sm leading-snug text-base-content/60">
										It reaches them directly, as recurring support with no platform cut, and clears
										whichever of their own levels it meets.
									</p>
								</div>
								<div className="rounded-xl border border-base-content/10 bg-base-200/60 p-4">
									<h3 className="text-sm font-bold">Point it at Anthers</h3>
									<p className="mt-1.5 text-sm leading-snug text-base-content/60">
										It keeps Public Access open to everyone, and pays the creators whose work you
										spend time with.
									</p>
								</div>
							</div>
						</div>
					</Reveal>

					{/* ── 2 · Support for a creator — the primary ask ─────────── */}
					<Reveal delay={80} className="mt-16 border-t border-base-content/10 pt-14">
						<StepHeading n={2} title="Support a creator">
							It goes to them.{" "}
							<strong>
								{money(CREATOR_NET)} of every {money(PUBLIC_ACCESS_PRICE)}
							</strong>{" "}
							reaches the creator, with card processing the only deduction — Anthers takes no cut of
							a single cent of it.
						</StepHeading>
						<SeedBreakdown
							segments={[
								{
									tone: "pool",
									amount: CREATOR_NET,
									label: "Straight to the creator",
									desc: "recurring support, and it clears whichever of their levels it reaches",
								},
								{
									tone: "pay",
									amount: ANTHERS_PAYMENTS,
									label: "Payments",
									desc: "card & processing, at cost, paid to the processor",
								},
							]}
							note="Shown at the worst case — this alone on the charge. Give more, or back more than one creator, and the fixed card fee spreads across it, so every creator on it receives a little more."
						/>
						<p className="mx-auto mt-12 max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
							<strong>Anyone you&rsquo;d like to start with?</strong> Search for someone by name, or
							tap a medium to meet a few. Following is free — support someone when you&rsquo;d like
							to back them.
						</p>
						<CreatorFinder
							creators={creators}
							loading={loadingCreators}
							picks={picks}
							onToggle={toggleCreator}
						/>
						<SectionEcho
							lines={creatorLines}
							onDrop={dropPick}
							empty="No creators picked yet — following is free whenever you're ready."
						/>
					</Reveal>

					{/* ── 3 · Support for Anthers — the optional second thing ─── */}
					<Reveal delay={80} className="mt-16 border-t border-base-content/10 pt-14">
						<StepHeading n={3} title="Support Anthers">
							Optional, and separate from anything above. Watch as much Public Access as you like,
							for as long as you hold it — and{" "}
							<strong>
								{money(timePoolFor(PUBLIC_ACCESS_PRICE))} of every {money(PUBLIC_ACCESS_PRICE)}
							</strong>{" "}
							goes into the Time Pool, split among the creators whose work you spent time with.
						</StepHeading>
						<SeedBreakdown
							segments={[
								{
									tone: "pool",
									amount: timePoolFor(PUBLIC_ACCESS_PRICE),
									label: "To creators, through the Time Pool",
									desc: "split by the share of your time each one earned",
								},
								{
									tone: "mission",
									amount: ANTHERS_REMAINDER,
									label: "Free access & programs",
									desc: "keeps other people's accounts free and funds Anthers' charitable programs",
								},
								{
									tone: "pay",
									amount: ANTHERS_PAYMENTS,
									label: "Payments",
									desc: "card & processing, at cost, paid to the processor",
								},
							]}
							note={`${money(PUBLIC_ACCESS_PRICE)} a month lifts your monthly limit. Every dollar past it adds more to the creators you spend time with, and helps keep other people's accounts free. Shown at the worst case — this alone on the charge; give more and the fixed card fee spreads across it.`}
						/>
						<Ask
							title="Support Anthers too?"
							value={picks.anthers}
							yesLabel={`Yes — ${money(PUBLIC_ACCESS_PRICE)} a month`}
							noLabel={`The free ${FREE_PUBLIC_ACCESS_HOURS} hours suit me`}
							onChange={(v) => setPicks((prev) => ({ ...prev, anthers: v }))}
						>
							You can change it any month, and your free account stays yours either way.
						</Ask>
						<SectionEcho
							lines={anthersLines}
							onDrop={dropPick}
							empty={
								picks.anthers === false
									? `Staying free — ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month.`
									: "Nothing added here yet."
							}
						/>
					</Reveal>

					{/* ── The one place it all adds up ───────────────────────── */}
					<Reveal delay={80} className="mt-16 border-t border-base-content/10 pt-14">
						<h2 style={serif} className="text-center text-3xl font-light leading-tight sm:text-4xl">
							Ready when you are
						</h2>
						<p className="mx-auto mt-4 max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
							Everything you chose along the way, in one place.
						</p>
						<Summary {...summaryProps} />
						<p className="mx-auto mt-5 max-w-xl text-center text-xs leading-relaxed text-base-content/45">
							Anthers puts {money(FREE_TIME_POOL)} a month into the Time Pool for every free
							account, so your time pays creators even at $0.
						</p>
					</Reveal>

					{/* Why non-profit */}
					<div className="mx-auto mt-16 max-w-3xl pb-4 text-center">
						<h2 style={serif} className="mb-4 text-2xl font-light sm:text-3xl">
							Why non-profit
						</h2>
						<p className="mx-auto max-w-2xl text-sm leading-relaxed text-base-content/60">
							Anthers is a non-profit because the only way to guarantee that our platform always
							serves creators is to make it legally impossible for it to act otherwise. Anthers
							cannot distribute profits to insiders, cannot be acquired, and cannot have its mission
							diluted by investors. If it ever ceases to operate, its assets go to another exempt
							organization, not to founders or shareholders.
						</p>
					</div>
				</div>
			</div>

			{ceremony && (
				<SignupCeremonyModal
					email={ceremony}
					paying={total > 0}
					onVerified={onVerified}
					onClose={() => setCeremony(null)}
				/>
			)}

			{pending && (
				<SubscriptionPaymentModal
					anthersSupport={pending.anthersSupport}
					directed={pending.directed}
					badgeName={pending.badgeName}
					preview={pending.preview}
					onComplete={() => {
						setPending(null);
						// A brand-new account owes a handle before anything else — including
						// before the page that would show off the support it just bought, which
						// is a poor place to discover you have no profile. `next` rides along so
						// onboarding can hand them back to whatever they came here to read. An
						// existing user goes straight there, or to where the webhook's work
						// becomes visible.
						void leave(
							justSignedUp.current ? withNextPath("/welcome", next) : (next ?? "/subscription"),
						);
					}}
					onClose={() => {
						setPending(null);
						// The card was declined or dismissed — but the account exists and is
						// signed in, because verification made it. That is the correct
						// outcome and takes no unwinding: they have a free account, and the
						// only thing still owed is the handle.
						if (justSignedUp.current) void leave(withNextPath("/welcome", next));
					}}
				/>
			)}
		</div>
	);
}
