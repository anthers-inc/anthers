// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Support page (route: /subscribe) — the middle of the funnel.
//
// Its job is to explain how support works and then open a door: a free account, or Seeds
// pointed at Anthers and at creators. It is NOT a report on what a user already holds —
// that is /subscription, and conflating the two is what the previous revision did.
//
// The page is a guided sequence, and the order is the argument:
//
//   1. Anthers is free, stated on its own and shown with a reel of work anyone can open.
//   2. A Seed is one thing — $3 — and the destination is the whole difference.
//   3. What a Seed to Anthers does, with its breakdown, ending in a yes/no.
//   4. What a Seed to a creator does, with the same breakdown, ending in a creator search.
//
// A tray alongside collects the answers, and the panel at the foot of the page is its
// twin. The question the page asks is *whether*, never *how much*: a creator pick is
// follow-or-Seed rather than a stepper, because the amount is a conversation for after
// the account exists and asking it here costs conversion for no information.
//
// ⚠️ PROPOSAL vs. SHIPPED. Public Access is a proposal — the working plan is the vault's
// `90-99 Agents/Transient/Public Access Model Revamp 20260811`, and where this disagrees
// with the wiki the wiki is still right. Everything drawn from `@anthers/shared/constants`
// is real and charged against; the two proposed figures are quarantined in the named SPIKE
// block below so nothing invented can hide inside the copy.
//
// What is wired to real data, and what is not:
//   • The reel is REAL — `GET /api/content/open-works` returns released, streamable Works
//     that are free to everyone. That predicate holds under both the current model and the
//     proposal, so the endpoint needed no opinion about which gate kinds exist.
//   • The creator finder is REAL — `GET /api/accounts/creators`, whose `mediums` come from
//     what each creator has actually released rather than anything they declare.
//   • Seeds to ANTHERS commit for real, through the same preview + modal ceremony the
//     inline post unlock uses.
//   • Following commits for real.
//   • Seeds to a CREATOR can be chosen, and are allocated where the user already holds a
//     creator-Seed balance — but nothing in the API SELLS creator Seeds
//     (`applyCreditForPurchase` credits a `type: "seeds"` purchase that no route creates),
//     so a user without a balance cannot finish that half yet. The page says so plainly
//     rather than failing at the last step.

import { cardFeeDisplay, SEED_PRICE, TIME_POOL_PER_SEED } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";

/* ── SPIKE dials — PROPOSED, not in @anthers/shared/constants yet ─────────────
 * Kept in one named block so a reader can see at a glance which figures on this page have
 * no code behind them. Both are settled in the working plan and neither has propagated:
 * moving them here is a copy change, moving them into `constants.ts` is a model change
 * that has to travel with `econ:figures`.
 *
 * FREE_PA_HOURS — how much Public Access a free account reaches each month.
 * FREE_TP_PER_ACCOUNT — what Anthers puts into the Time Pool for a free account, split
 *   among creators by attention-proportion exactly as a paying account's is.
 */
const SPIKE = {
	FREE_PA_HOURS: 10,
	FREE_TP_PER_ACCOUNT: 0.5,
} as const;

/** Where a Seed given to Anthers goes, at the single-Seed worst case. */
const ANTHERS_PAYMENTS = cardFeeDisplay(SEED_PRICE);
const ANTHERS_REMAINDER = SEED_PRICE - TIME_POOL_PER_SEED - ANTHERS_PAYMENTS;
/** What a lone directed Seed reaches its creator as — gross, less its share of the fee. */
const CREATOR_NET = SEED_PRICE - ANTHERS_PAYMENTS;

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

function money(n: number): string {
	return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

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
		<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-content">
			{n}
		</span>
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
		<div className="max-w-xl">
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
				<span className="text-xl font-bold tabular-nums">{money(SEED_PRICE)}/mo</span>
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
			className={`mt-7 rounded-2xl border p-5 transition-colors ${
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
			<label className="input input-bordered flex max-w-md items-center gap-2 rounded-full">
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

			<div className="mt-3 flex flex-wrap items-center gap-2">
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
										{seeded ? "✓ Seed added" : "Give a Seed"}
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
			<p className="mt-3 text-xs text-base-content/45">
				How much each creator gets is a question for once your account exists — right now it&rsquo;s
				just who.
			</p>
		</div>
	);
}

/* ── The tray, and the twin at the foot of the page ─────────────────────────── */

interface TrayLine {
	key: string | null;
	label: string;
	sub: string;
	amount: number;
}

function Tray({
	title,
	lines,
	total,
	cta,
	busy,
	note,
	error,
	success,
	onSubmit,
	onDrop,
}: {
	title: string;
	lines: TrayLine[];
	total: number;
	cta: string;
	busy: boolean;
	note: string;
	error: string | null;
	success: string | null;
	onSubmit: () => void;
	onDrop: (key: string) => void;
}) {
	return (
		<div className="rounded-2xl border border-base-300 bg-base-200/60 p-5">
			<h3 className="mb-3 text-lg font-bold">{title}</h3>
			<ul className="space-y-2">
				{lines.map((line) => (
					<li
						key={line.key ?? "free"}
						className="flex items-baseline justify-between gap-3 border-b border-base-content/5 pb-2 text-sm"
					>
						<span className="min-w-0">
							<span className="font-semibold">{line.label}</span>
							<span className="block text-xs text-base-content/45">{line.sub}</span>
							{line.key && (
								<button
									type="button"
									className="text-[11px] text-base-content/40 underline"
									onClick={() => onDrop(line.key as string)}
								>
									Remove
								</button>
							)}
						</span>
						<strong className="shrink-0 tabular-nums">
							{line.amount ? money(line.amount) : "Free"}
						</strong>
					</li>
				))}
			</ul>
			<div className="mt-3 flex items-baseline justify-between">
				<span className="font-bold">Monthly</span>
				<span className="text-2xl font-bold tabular-nums">{money(total)}</span>
			</div>
			{total > 0 && (
				<p className="text-right text-xs text-base-content/45">plus any applicable tax</p>
			)}
			<button
				type="button"
				className={`btn btn-primary mt-4 w-full ${busy ? "btn-disabled" : ""}`}
				onClick={onSubmit}
				disabled={busy}
			>
				{busy ? "Working…" : cta}
			</button>
			{error && <p className="mt-2 text-sm text-error">{error}</p>}
			{success && <p className="mt-2 text-sm text-success">{success}</p>}
			<p className="mt-2 text-xs leading-relaxed text-base-content/45">{note}</p>
		</div>
	);
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function SubscribePage() {
	const { user } = useAuth();
	const signedIn = !!user;

	const [picks, setPicks] = useState<Picks>(EMPTY_PICKS);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [loadingCreators, setLoadingCreators] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [pending, setPending] = useState<{
		anthersSeeds: number;
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

	const anthersSeeds = picks.anthers === true ? 1 : 0;
	const total = (anthersSeeds + picks.seed.length) * SEED_PRICE;

	const lines: TrayLine[] = useMemo(() => {
		const out: TrayLine[] = [
			{
				key: null,
				label: "Free account",
				sub: `${SPIKE.FREE_PA_HOURS} hours of Public Access a month`,
				amount: 0,
			},
		];
		if (picks.anthers === true)
			out.push({
				key: "anthers",
				label: "A Seed for Anthers",
				sub: "watch as much as you like",
				amount: SEED_PRICE,
			});
		for (const username of picks.follow) {
			const creator = byUsername.get(username);
			out.push({
				key: username,
				label: creator ? nameOf(creator) : username,
				sub: picks.seed.includes(username) ? "following · one Seed" : "following",
				amount: picks.seed.includes(username) ? SEED_PRICE : 0,
			});
		}
		return out;
	}, [picks, byUsername]);

	/**
	 * Commit what can be committed.
	 *
	 * Signed out, the picks are already in session storage, so the account comes first and
	 * the page is waiting when they come back. Signed in, follows and creator-Seed
	 * allocations are applied, and Seeds for Anthers open the same confirmation modal the
	 * inline post unlock uses — one ceremony, so the charge is described identically
	 * wherever a user commits.
	 */
	const submit = async () => {
		if (!signedIn) {
			window.location.href = "/signup";
			return;
		}
		setBusy(true);
		setError(null);
		setSuccess(null);
		try {
			for (const username of picks.follow) {
				const creator = byUsername.get(username);
				if (!creator || creator.isFollowing) continue;
				await client.api.accounts.users[":username"].follow.$post({ param: { username } });
			}

			// Creator Seeds are ALLOCATED from a balance the user already holds; nothing in
			// the API sells them, so a user without one is told rather than failed at.
			const unallocated: string[] = [];
			for (const username of picks.seed) {
				const creator = byUsername.get(username);
				if (!creator) continue;
				const res = await client.api.subscriptions.seeds.$post({
					json: { creatorId: creator.id, amount: SEED_PRICE.toFixed(2) },
				});
				if (!res.ok) unallocated.push(nameOf(creator));
			}

			if (picks.anthers === true) {
				const res = await client.api.subscriptions.preview[":seeds"].$get({
					param: { seeds: "1" },
				});
				if (!res.ok) {
					setError("Couldn't load the charge details. Please try again.");
					return;
				}
				const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
				setPending({ anthersSeeds: 1, badgeName: "1 Seed", preview });
			}

			if (unallocated.length > 0) {
				setError(
					`Your follows are saved. Seeds for ${unallocated.join(", ")} need a creator-Seed balance, which can't be bought here yet — they're kept for when it can.`,
				);
			} else if (picks.anthers !== true) {
				setSuccess(
					picks.follow.length > 0 ? "Saved — you're following them now." : "Nothing to save yet.",
				);
			}
		} catch {
			setError("Something went wrong. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const trayProps = {
		lines,
		total,
		cta: signedIn
			? total > 0
				? "Confirm and continue"
				: "Save my picks"
			: "Create your free account",
		busy,
		error,
		success,
		note: signedIn
			? "You'll see the exact charge before anything is confirmed. Change or stop any month."
			: "Free to make, and your picks are kept here while you sign up.",
		onSubmit: submit,
		onDrop: dropPick,
	};

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade so this wrapper can
		// shrink below its content's min-content width on mobile; without `w-full`,
		// `mx-auto` on a flex item disables the default `align-self: stretch`. The
		// wide-screen cap is a utility class, never an inline style — an inline width wins
		// over `max-w-full` and defeats the cap below the cap.
		<div className="mx-auto min-w-0 w-full max-w-full max-w-[80rem] px-4 py-8">
			<div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="min-w-0">
					{/* ── 1 · Free ───────────────────────────────────────────── */}
					<Reveal>
						<div className="mb-3 flex items-center gap-3">
							<StepNumber n={1} />
							<p className="text-xs font-semibold uppercase tracking-wider text-base-content/40">
								A non-profit · no ads, no shareholders, no strings
							</p>
						</div>
						<h1 className="text-4xl font-bold sm:text-5xl">Anthers is free. Forever.</h1>
						<p className="mt-4 max-w-2xl leading-relaxed text-base-content/70">
							Every month you get <strong>{SPIKE.FREE_PA_HOURS} hours of Public Access</strong> —
							the streaming work creators leave open to everyone. Follow whoever you like, keep a
							library, and buy anything a creator sells.
						</p>
						<OpenWorksReel />
					</Reveal>

					{/* ── 2 · The Seed ───────────────────────────────────────── */}
					<Reveal delay={80} className="mt-12 border-t border-base-content/10 pt-8">
						<div className="mb-3 flex items-center gap-3">
							<StepNumber n={2} />
							<h2 className="text-2xl font-bold sm:text-3xl">
								Going further is one thing: a Seed.
							</h2>
						</div>
						<p className="max-w-2xl leading-relaxed text-base-content/70">
							A Seed is <strong>{money(SEED_PRICE)} a month</strong> — the only unit of support on
							Anthers. You hold as many as you like, and you choose where each one points.
						</p>
						<div className="mt-6 grid gap-4 sm:grid-cols-[auto_1fr_1fr] sm:items-stretch">
							<div className="grid place-items-center rounded-xl border border-primary/30 bg-primary/10 px-6 py-4 text-center">
								<span>
									<span className="block text-2xl font-bold">{money(SEED_PRICE)}</span>
									<span className="text-xs text-base-content/60">
										one Seed
										<br />
										per month
									</span>
								</span>
							</div>
							<div className="rounded-xl border border-base-content/10 bg-base-200/60 p-4">
								<h3 className="text-sm font-bold">Point it at Anthers</h3>
								<p className="mt-1.5 text-sm leading-snug text-base-content/60">
									It keeps Public Access open to everyone, and pays the creators whose work you
									spend time with.
								</p>
							</div>
							<div className="rounded-xl border border-base-content/10 bg-base-200/60 p-4">
								<h3 className="text-sm font-bold">Point it at a creator</h3>
								<p className="mt-1.5 text-sm leading-snug text-base-content/60">
									It reaches them directly, as recurring support, and clears whichever of their own
									levels it meets.
								</p>
							</div>
						</div>
					</Reveal>

					{/* ── 3 · A Seed for Anthers ─────────────────────────────── */}
					<Reveal delay={80} className="mt-12 border-t border-base-content/10 pt-8">
						<div className="mb-3 flex items-center gap-3">
							<StepNumber n={3} />
							<h2 className="text-2xl font-bold sm:text-3xl">A Seed for Anthers</h2>
						</div>
						<p className="mb-6 max-w-2xl leading-relaxed text-base-content/70">
							Watch as much Public Access as you like, for as long as you hold it — and{" "}
							<strong>
								{money(TIME_POOL_PER_SEED)} of every {money(SEED_PRICE)}
							</strong>{" "}
							goes into the Time Pool, split among the creators whose work you spent time with.
						</p>
						<SeedBreakdown
							segments={[
								{
									tone: "pool",
									amount: TIME_POOL_PER_SEED,
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
							note={`The first Seed lifts your monthly limit. Each one after it adds another ${money(TIME_POOL_PER_SEED)} to the creators you spend time with, and helps keep other people's accounts free. Shown at the worst case — a single Seed on the charge; hold more and the fixed card fee spreads across them.`}
						/>
						<Ask
							title="Add a Seed for Anthers?"
							value={picks.anthers}
							yesLabel={`Yes — ${money(SEED_PRICE)} a month`}
							noLabel={`The free ${SPIKE.FREE_PA_HOURS} hours suit me`}
							onChange={(v) => setPicks((prev) => ({ ...prev, anthers: v }))}
						>
							You can change it any month, and your free account stays yours either way.
						</Ask>
					</Reveal>

					{/* ── 4 · A Seed for a creator ───────────────────────────── */}
					<Reveal delay={80} className="mt-12 border-t border-base-content/10 pt-8">
						<div className="mb-3 flex items-center gap-3">
							<StepNumber n={4} />
							<h2 className="text-2xl font-bold sm:text-3xl">A Seed for a creator</h2>
						</div>
						<p className="mb-6 max-w-2xl leading-relaxed text-base-content/70">
							It goes to them.{" "}
							<strong>
								{money(CREATOR_NET)} of every {money(SEED_PRICE)}
							</strong>{" "}
							reaches the creator, with card processing the only deduction — Anthers takes no cut of
							a single cent of it.
						</p>
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
							note="Shown at the worst case — a single Seed on the charge. Hold more and the fixed card fee spreads across them, so every creator on it receives a little more."
						/>
						<p className="mt-8 max-w-2xl leading-relaxed text-base-content/70">
							<strong>Anyone you&rsquo;d like to start with?</strong> Search for someone by name, or
							tap a medium to meet a few. Following is free — add a Seed when you&rsquo;d like to
							back them.
						</p>
						<CreatorFinder
							creators={creators}
							loading={loadingCreators}
							picks={picks}
							onToggle={toggleCreator}
						/>
					</Reveal>

					{/* ── The tray's twin, for anyone who scrolled past it ───── */}
					<Reveal delay={80} className="mt-12 border-t border-base-content/10 pt-8">
						<h2 className="text-2xl font-bold">Ready when you are</h2>
						<p className="mt-2 max-w-prose text-base-content/60">
							The same panel as the one beside you — whatever you&rsquo;ve picked comes with it.
						</p>
						<div className="mt-5 max-w-md">
							<Tray {...trayProps} title="Create your account" />
						</div>
					</Reveal>

					{/* Why non-profit */}
					<div className="mx-auto mt-16 max-w-3xl pb-4 text-center">
						<h2 className="mb-3 text-xl font-bold">Why non-profit</h2>
						<p className="mx-auto max-w-2xl text-sm leading-relaxed text-base-content/60">
							Anthers is a non-profit because the only way to guarantee that our platform always
							serves creators is to make it legally impossible for it to act otherwise. Anthers
							cannot distribute profits to insiders, cannot be acquired, and cannot have its mission
							diluted by investors. If it ever ceases to operate, its assets go to another exempt
							organization, not to founders or shareholders.
						</p>
					</div>
				</div>

				{/* ── The tray ───────────────────────────────────────────────── */}
				<div className="hidden lg:block">
					{/* Clears the sticky marketing navbar, which is ~4.5rem and sits at top-0 —
					    a smaller offset parks the tray's first row underneath it. */}
					<div className="sticky top-24">
						<Tray {...trayProps} title="Your start" />
						<p className="mt-3 text-xs leading-relaxed text-base-content/40">
							Anthers puts {money(SPIKE.FREE_TP_PER_ACCOUNT)} a month into the Time Pool for every
							free account, so your watching pays creators even at $0.
						</p>
					</div>
				</div>
			</div>

			{pending && (
				<SubscriptionPaymentModal
					anthersSeeds={pending.anthersSeeds}
					badgeName={pending.badgeName}
					preview={pending.preview}
					onComplete={() => {
						setPending(null);
						// The webhook applies the Seed count, so send the user where it shows.
						window.location.href = "/subscription";
					}}
					onClose={() => setPending(null)}
				/>
			)}
		</div>
	);
}
