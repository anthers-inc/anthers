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
//   0. **Join.** The five free inclusions as an icon row, then the signup control — an
//      address or a Bluesky handle, on a tab switcher — before the page asks for anything
//      at all. Two doors into the optional half close the section.
//   1. What support for a CREATOR does, with its breakdown, ending in a creator search.
//   2. What support for ANTHERS does, with the same breakdown, ending in a yes/no.
//   …then the one place it all adds up, with the same signup control again.
//
// ⭐ **The first section was rebuilt on 2026-08-23, and three of its changes are about
// how the section is READ rather than what it claims.** The inclusions were four bordered
// cards sitting directly above the bordered signup card, so the eye could not tell the
// list of what you get from the thing you do about it — they are an icon row now, the
// shape /about used for its governance facts. The Bluesky door was a divider and a second
// button under the email field, which made it read as an afterthought rather than as the
// other half of one choice. And the two paragraphs describing where a monthly amount can
// point are now buttons that scroll to the section that asks for it, so a reader does not
// have to hold a description in their head for two screens before meeting its control.
//
// 🚨 **Signing up moved to the TOP on 2026-08-22, and it moved for a reason about how the
// page is read rather than about what it says.** The signup control used to live only in
// the closing panel, below two sections of money — so a visitor arriving from a button
// marked "Sign Up" met an argument about supporting creators and an argument about
// supporting Anthers before finding any way in. Everything on the way down was optional
// and nothing said so early enough. Putting the door first makes the optionality
// structural instead of a claim: you can join from the first screen and never scroll.
//
// 🚨 **Support for ANTHERS must never read as the price of admission.** Parker's framing,
// and it is a product position rather than a copy preference: somebody served entirely by
// purchases, by backing creators directly, and by the free hours is using Anthers exactly
// as intended, and the page must not nudge them out of it. Hence "Only if you want to" as
// the first words of that section, and hence the free inclusions being a list at the top
// rather than a sentence somewhere in the middle.
//
// ⚠️ The free hours are stated **up front and as an inclusion**, which is the other half
// of the same instruction: a limit discovered after signing up is a surprise, and a limit
// read as a warning turns the whole list into a trial. 63.01 already required "free
// forever" and the cap to be co-present in the same breath; this page now does it in the
// first thing anybody sees.
//
// 🚨 Steps 1 and 2 were the other way round until 2026-08-17, and creator support was not
// mentioned until the third section. That order was a relic of the model where support for
// Anthers bought streaming bandwidth generally, so it was the thing every visitor needed.
// It buys Public Access now and nothing else; early visitors arrive at the invitation of a
// creator already here, and with few creators there is little Public Access to want yet.
// So the creator ask leads and the Anthers ask follows it.
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
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	PUBLIC_ACCESS_PRICE,
	timePoolFor,
} from "@anthers/shared/constants";
import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { useAuth } from "@anthers/web-shared/auth";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import {
	ArrowDownTrayIcon,
	BanknotesIcon,
	EnvelopeIcon,
	HeartIcon,
	PlayCircleIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	SparklesIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BlueskyMark from "../components/auth/BlueskyMark";
import { storedGibPerSourceHour } from "../components/calculators/video-model";
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

/**
 * What the free creator allowance holds, in hours of video — **derived, never typed.**
 *
 * A creator's storage carries the master they uploaded plus the whole AV1 ladder Anthers
 * transcodes from it, so "50 GiB" means nothing to somebody deciding whether to publish
 * here and "6+ hours of video" means everything. The number is computed from the same
 * bitrate model `/calculators/video-storage` runs on, so the page and the calculator
 * cannot disagree, and doubling the allowance would move this sentence on its own.
 *
 * 🚨 **The framerate is the assumption to know about, and the copy does not state it.**
 * An hour at 1080p60 stores nearly twice what an hour at 1080p30 does, so this reads the
 * 30fps case: 50 GiB is about 6.7 hours at 30fps and about 4.7 at 60. The published
 * sentence says "6+ hours", which is true of a 30fps master and generous for a 60fps one.
 * If that ever needs to be the worst case rather than the common one, change the argument
 * here rather than the sentence.
 */
const FREE_VIDEO_HOURS = Math.floor(FREE_STORAGE_GIB / storedGibPerSourceHour("1080p", 30, "h264"));

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

/** One segment of the support breakdown. */
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
 * Where a month's support goes — one component, used twice.
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

/**
 * What signing up actually costs, said as a list rather than as a paragraph.
 *
 * 🚨 **The limit is in here, not in a footnote, and 63.01 requires it to be.** *"Free
 * forever"* met without a bound beside it is heard as *unlimited*, so the offer has to be
 * stated whole: permanent **and** bounded. Hiding the cap would also hollow out the only
 * honest reason to give Anthers anything, since the cap is the thing that lifts.
 *
 * ⚠️ Every line is a thing you get, including the bounded one. *"10 hours a month"* is
 * written as an inclusion rather than as a restriction, because it is one — and because a
 * reader who meets it as a warning reads the whole list as a trial.
 */
function FreeInclusions() {
	const items: { icon: typeof PlayCircleIcon; label: string; sub: string }[] = [
		{
			icon: PlayCircleIcon,
			label: `${FREE_PUBLIC_ACCESS_HOURS} hours/month of Public Access`,
			sub: "Any works creators make available without a Badge, streamed for free, with creators still paid by Anthers for you.",
		},
		{
			icon: ShieldCheckIcon,
			label: "No Ads or Data Harvesting",
			sub: "Even if you use Anthers for free, we never serve ads, we never sell your data, and we can never be sold. Free means free.",
		},
		{
			icon: BanknotesIcon,
			label: "Zero Platform Fee",
			sub: "When you choose to support a creator with a monthly Badge subscription or a direct purchase, Anthers takes no cut.",
		},
		{
			icon: ArrowDownTrayIcon,
			label: "Purchases are yours, forever",
			sub: "Any works you purchase are yours to own and download from your Anthers library, even if they're unlisted later.",
		},
		{
			icon: ServerStackIcon,
			label: `${FREE_STORAGE_GIB} GiB of Anthers storage`,
			// ⚠️ **This is a CREATOR allowance, and the sentence has to keep saying so.**
			// `FREE_STORAGE_GIB`'s only consumer is `estimateStorageCost` in
			// `packages/shared/src/fees.ts`, which bills a creator's catalogue against it —
			// there is no user-side storage quota to describe. A draft of this line offered
			// the same allowance to users for preserving delisted purchases and storing
			// cloud saves; neither exists, and a delisted purchase already survives without
			// drawing on anybody's quota, since that is a free-access obligation under 63.01.
			//
			// ⚠️ The `6+` is DERIVED, never typed — see `FREE_VIDEO_HOURS`. Only the numeral
			// is computed; the sentence is Parker's, word for word.
			sub: `If you're interested in creating on Anthers, you can store the equivalent of ${FREE_VIDEO_HOURS}+ hours of Full HD video for free in your catalog.`,
		},
	];
	return (
		// The icon row, as /about used to draw its governance facts: a mark, a short name,
		// a sentence. ⭐ It replaced five bordered cards, which sat directly above the
		// signup card and read as a second stack of the same object — the eye could not
		// tell the list of what you get from the thing you do about it.
		<ul className="mx-auto mt-12 grid max-w-7xl grid-cols-1 gap-8 text-center sm:grid-cols-2 lg:grid-cols-5 lg:gap-8">
			{items.map((item, i) => (
				<Reveal as="li" key={item.label} delay={i * 90}>
					<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
						<item.icon className="h-7 w-7" />
					</div>
					{/* ⚠️ `lg:min-h-12` reserves two lines for every title, because these wrap to
					    one or two depending on the name and the breakpoint — and a row whose
					    paragraphs start at five different heights reads as five loose blocks
					    rather than as one row. It applies only where the items sit side by
					    side; stacked, the reserved space is just a gap. */}
					<h3 style={serif} className="mb-1 text-base font-medium text-balance lg:min-h-8">
						{item.label}
					</h3>
					<p className="text-xs leading-relaxed text-base-content/55">{item.sub}</p>
				</Reveal>
			))}
		</ul>
	);
}

/**
 * One of the two optional things, drawn as a door rather than described as a fact.
 *
 * ⚠️ **It scrolls rather than navigates**, because the section it names is on this page —
 * a `<Link to="#…">` would be a router navigation to the same route and would leave the
 * reader where they were. `scroll-mt` on the target is what keeps the heading clear of
 * the sticky header.
 */
function GoFurtherCard({
	icon: Icon,
	title,
	target,
	children,
}: {
	icon: typeof PlayCircleIcon;
	title: string;
	target: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="group flex w-full items-start gap-4 rounded-2xl border border-base-content/10 bg-base-200/60 p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
			onClick={() =>
				document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })
			}
		>
			<span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
				<Icon className="h-6 w-6" />
			</span>
			<span className="min-w-0">
				<span className="flex items-center gap-1.5 text-sm font-bold">
					{title}
					<span
						aria-hidden="true"
						className="translate-y-px text-base-content/35 transition-transform group-hover:translate-x-0.5"
					>
						↓
					</span>
				</span>
				<span className="mt-1.5 block text-sm leading-snug text-base-content/60">{children}</span>
			</span>
		</button>
	);
}

/** Which way in the signup card is currently offering. */
type Door = "email" | "bluesky";

/**
 * The signup control: two doors on a tab switcher, an address or a Bluesky handle.
 *
 * 🚨 **One component, rendered twice, and that is deliberate rather than lazy.** It opens
 * the page — because the first thing a visitor needs to know is that joining costs nothing
 * — and it closes it, for somebody who scrolled, chose something, and is ready. Two copies
 * of this markup would be two things to keep honest about what the button promises, and
 * the promise is the part that matters.
 *
 * Both instances read the same `email` state, so typing in one fills the other; only the
 * input's `id` differs, which is why `idPrefix` exists. `door` is shared for the same
 * reason: a reader who picks Bluesky at the top and scrolls to the bottom should find the
 * card they chose, not the one they didn't.
 *
 * ⚠️ **The tabs replaced a divider and a second button underneath the email field**, which
 * made Bluesky read as the afterthought rather than as the other half of one choice. They
 * appear only where there genuinely are two doors: a signed-in visitor has no address to
 * give, somebody returning from Bluesky without a usable address has already used that
 * door, and the door is closed entirely when the API says signup is off.
 */
function SignupForm({
	idPrefix,
	cta,
	busy,
	note,
	error,
	success,
	email,
	onEmailChange,
	onSubmit,
	atprotoHandle,
	onBluesky,
	handle,
	onHandleChange,
	door,
	onDoorChange,
	className,
}: {
	idPrefix: string;
	cta: string;
	busy: boolean;
	note?: string;
	error: string | null;
	success: string | null;
	/** Null when signed in — there is no address to ask a returning user for. */
	email: string | null;
	onEmailChange: (value: string) => void;
	onSubmit: () => void;
	/**
	 * The Bluesky handle of a signup already in progress, or null.
	 *
	 * Set when someone came back from Bluesky and their PDS could not give us a usable
	 * address. The identity is proved and parked; this page is finishing the job, and
	 * saying whose signup it is finishing is the difference between an explanation and an
	 * unexplained email field after a detour through another website.
	 */
	atprotoHandle: string | null;
	/**
	 * Hand the typed handle off to Bluesky. Null when the door should not be offered at all.
	 *
	 * On success this never returns in any useful sense — the browser is already leaving —
	 * so nothing may be queued after it, and `busy` is deliberately left set.
	 */
	onBluesky: ((handle: string) => void) | null;
	/** The Bluesky handle being typed, shared by both copies of this card like `email`. */
	handle: string;
	onHandleChange: (value: string) => void;
	door: Door;
	onDoorChange: (door: Door) => void;
	/** Outer spacing only — the card's own box is this component's, not a caller's. */
	className?: string;
}) {
	const fieldId = `${idPrefix}-email`;
	const handleFieldId = `${idPrefix}-handle`;
	/** Two doors to choose between, rather than one door and a fallback. */
	const tabbed = email !== null && !!onBluesky && !atprotoHandle;
	/** With no tabs there is nothing to switch, so the email field is simply the card. */
	const showEmail = email !== null && (!tabbed || door === "email");

	const emailPanel = showEmail && (
		<form
			className="text-left"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			<label className="label px-0 pb-1" htmlFor={fieldId}>
				<span className="text-sm font-semibold">Where should we reach you?</span>
			</label>
			<input
				id={fieldId}
				type="email"
				required
				autoComplete="email"
				placeholder="you@example.com"
				className="input input-bordered w-full"
				value={email ?? ""}
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
	);

	/**
	 * The Bluesky door, asked for in place rather than in a modal.
	 *
	 * ⭐ **The handle used to be collected in a step of its own** — press the button, meet
	 * `BlueskyHandleModal`, type the handle, press again, leave. That is two presses and a
	 * layer for one short field, and this card has room the `/login` card genuinely does
	 * not (its botanical flourishes reach about seven rems in from each corner, which is
	 * why the modal exists at all and why `/login` keeps it).
	 *
	 * ⚠️ **The panel is a field and a button, and nothing else** (Parker, 2026-08-24). It
	 * carried a paragraph explaining the round trip, which made the Bluesky tab twice the
	 * height of the email one — so switching tabs resized the card under the reader. What
	 * survives of that explanation is the one-line `note` below the button.
	 *
	 * 🚨 **One of the three promises survives, and it is in the `note` under the button.**
	 * `transition:email` is a real consent screen on somebody else's website, so the warning
	 * that Bluesky will be asked for an email address had to land somewhere — folding it
	 * into a line that already existed keeps it without giving the panel back its height.
	 * The other two are covered a moment later: `/welcome` takes the name and the terms, and
	 * the emailed code speaks for itself when it arrives.
	 */
	const blueskyPanel = tabbed && door === "bluesky" && onBluesky && (
		<form
			className="text-left"
			onSubmit={(e) => {
				e.preventDefault();
				onBluesky(handle);
			}}
		>
			<label className="label px-0 pb-1" htmlFor={handleFieldId}>
				<span className="text-sm font-semibold">What&rsquo;s your handle?</span>
			</label>
			{/* A handle is a domain name, so this is `text` with a URL keyboard rather than an
			    `email`-shaped field. The leading `@` is how people write it and not part of
			    it — stripped on submit, never fought with while typing. */}
			<input
				id={handleFieldId}
				type="text"
				inputMode="url"
				autoComplete="username"
				spellCheck={false}
				autoCapitalize="none"
				placeholder="alice.bsky.social"
				aria-label="Bluesky handle"
				className="input input-bordered w-full"
				value={handle}
				onChange={(e) => onHandleChange(e.target.value)}
			/>
			{/* 🚨 No butterfly on this button, and that is a compliance decision rather than a
			    visual one. Bluesky's guidance allows their mark in three colours only, and the
			    one that reads on `btn-primary` differs by theme — our primary is a deep green
			    in light and a light amber in dark, so white works on one and is nearly
			    invisible on the other, while their blue is listed for light backgrounds only.
			    The tab an inch above already carries the mark in an approved colour on a
			    surface we control, which is where it belongs. */}
			<button
				type="submit"
				className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
				disabled={busy || !handle.trim()}
			>
				{busy ? "Taking you to Bluesky…" : "Sign up with Bluesky"}
			</button>
		</form>
	);

	/**
	 * One tab on the vertical rail.
	 *
	 * ⚠️ **Icon-only, so the accessible name comes from `aria-label` and there is no visible
	 * text to fall back on.** `title` gives a pointer user the same word on hover; the panel
	 * beside it names the door in full, which is what carries the meaning for everyone else.
	 */
	/**
	 * One tab in the strip across the card's top edge.
	 *
	 * The selected tab wears the card body's own background so the two read as one
	 * surface, and the unselected one is recessed a shade behind it. That is the whole
	 * of the selected state: it is the tab, not the mark on it, that changes.
	 */
	const tab = (value: Door, label: string, icon: React.ReactNode) => (
		<button
			type="button"
			role="tab"
			aria-selected={door === value}
			// ⚠️ The divider between the cells is this left border rather than a spacer
			// element, because a `tablist` should contain tabs and nothing else — an
			// `aria-hidden` span in there is a thing assistive tech has to step over.
			className={`flex flex-1 items-center justify-center gap-2 border-base-300 px-4 py-3 text-sm font-semibold transition-colors not-first:border-l ${
				door === value
					? "bg-base-200/60 text-base-content"
					: "bg-base-300/60 text-base-content/50 hover:text-base-content/75"
			}`}
			onClick={() => onDoorChange(value)}
		>
			{icon}
			{label}
		</button>
	);

	return (
		// 🚨 `data-signup` exists because the page deliberately carries TWO of these, with the
		// same button label — which is right for a reader (it is the same act) and ambiguous
		// for anything selecting by role and name. This is the seam that disambiguates them
		// without inventing two different labels for one action.
		//
		// ⚠️ **The card box belongs to this component rather than to its call sites**, and
		// that is what lets the tabs sit ON the top edge instead of floating inside the
		// padding. Both callers used to draw the border and background themselves; a tab
		// strip cannot attach to an edge it is nested three levels inside of. `overflow-hidden`
		// is what stops a selected tab's background squaring off the rounded top corners.
		<div
			data-signup={idPrefix}
			className={`overflow-hidden rounded-2xl border border-base-300 bg-base-200/60 ${className ?? ""}`}
		>
			{/* Tabs across the TOP rather than down the left (Parker, 2026-08-24) — the card
			    is a centred column and a left rail pushed its contents off that centre line,
			    where a top strip keeps the field, the button and the note all aligned to the
			    same axis.

			    ⚠️ The strip renders only when there really are two doors. One tab above a
			    panel reads as a control that has lost its other half, which is worse than
			    the plain card a closed Bluesky door falls back to.

			    🚨 The label is "Bluesky", never "Bsky" — their brand guidance rules out that
			    abbreviation in public-facing material by name. */}
			{tabbed && (
				<div role="tablist" aria-label="How to sign up" className="flex border-b border-base-300">
					{tab(
						"email",
						"Email",
						<EnvelopeIcon
							className={`h-5 w-5 ${door === "email" ? "text-primary" : "text-base-content/40"}`}
						/>,
					)}
					{/* 🚨 The butterfly keeps its own colour in BOTH states — see `BlueskyMark`.
					    Dimming it to signal "not selected" would be tinting somebody else's
					    trademark, so the tab behind it carries the whole selected state. */}
					{tab("bluesky", "Bluesky", <BlueskyMark className="h-5 w-5" />)}
				</div>
			)}

			<div className="p-6">
				{/* The ONE field this page collects. Username and password are deliberately not
				    asked for here — they cost nothing at the moment of decision and everything
				    at the moment of doubt, so they move to onboarding, after the address is
				    confirmed and after any charge. */}
				{atprotoHandle && (
					// 🚨 Why an email field is being shown to somebody who just authenticated
					// somewhere else. Without this the page reads as a flow that forgot what it
					// was doing — which is how a signup gets abandoned three steps in.
					<div className="mb-5 flex items-start gap-3 rounded-xl bg-base-300/50 p-4 text-left">
						<BlueskyMark className="mt-0.5 h-5 w-5 shrink-0" />
						<p className="text-sm text-base-content/70">
							Signing up as <strong className="break-all">@{atprotoHandle}</strong>. One more thing:
							Anthers needs an email address it can reach you at, for receipts and account notices —
							so we'll send a code to confirm it.
						</p>
					</div>
				)}

				{emailPanel}
				{blueskyPanel}

				{email === null && (
					<button
						type="button"
						className={`btn btn-primary btn-lg w-full ${busy ? "btn-disabled" : ""}`}
						onClick={onSubmit}
						disabled={busy}
					>
						{busy ? "Working…" : cta}
					</button>
				)}
				{error && <p className="mt-3 text-sm text-error">{error}</p>}
				{success && <p className="mt-3 text-sm text-success">{success}</p>}
				{note && (
					<p className="mt-3 text-center text-xs leading-relaxed text-base-content/45">{note}</p>
				)}
			</div>
		</div>
	);
}

/** The closing panel — the only place the whole page is added up. */
function Summary({
	lines,
	total,
	onDrop,
	...signup
}: {
	lines: PickLine[];
	total: number;
	onDrop: (key: string) => void;
} & Omit<React.ComponentProps<typeof SignupForm>, "idPrefix">) {
	return (
		// ⚠️ Two stacked cards rather than one panel, since `SignupForm` now draws its own
		// box so its tabs have a top edge to sit on. It reads better than the single panel
		// did anyway: what you chose is one object, and the way in is another.
		<div className="mx-auto mt-8 max-w-lg">
			<div className="rounded-2xl border border-base-300 bg-base-200/60 p-6">
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
								<strong className="tabular-nums">
									{line.amount ? money(line.amount) : "Free"}
								</strong>
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
			</div>

			<SignupForm idPrefix="summary" className="mt-4" {...signup} />
		</div>
	);
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function SubscribePage() {
	const { user, refreshUser, signUpWithBluesky } = useAuth();
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
	/**
	 * Which door the signup card is showing — shared by both copies of it, like `email`.
	 *
	 * Email is the default because it is the one every visitor can use; the Bluesky tab
	 * asks for an account on another service.
	 */
	const [door, setDoor] = useState<Door>("email");
	/** The Bluesky handle being typed, shared by both copies of the signup card. */
	const [handle, setHandle] = useState("");
	/** The address a ceremony is open for, or null when it isn't. */
	const [ceremony, setCeremony] = useState<string | null>(null);
	/**
	 * Whether the Bluesky door is open at all.
	 *
	 * ⚠️ Starts false and is only ever turned on, so the page never flashes a button it is
	 * about to take away — and a browser that cannot reach the API simply sees the page as
	 * it was before this feature existed, which is the correct degraded state.
	 */
	const [blueskySignupOpen, setBlueskySignupOpen] = useState(false);
	/**
	 * A Bluesky signup already proved and parked, waiting on an address.
	 *
	 * ⚠️ Read from the API rather than from the URL. `?atproto=1` says only *"go and ask"* —
	 * the answer comes from an httpOnly cookie the browser cannot read and cannot forge, so
	 * a hand-typed `?atproto=1` gets `null` and this page behaves exactly as it always has.
	 */
	const [pendingAtproto, setPendingAtproto] = useState<{
		handle: string;
		email: string | null;
	} | null>(null);
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

	// Is the Bluesky door open? Signed-out visitors only, because that is the only state
	// this page offers it in.
	useEffect(() => {
		if (signedIn) return;
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then(({ signupEnabled }) => {
				if (live) setBlueskySignupOpen(signupEnabled);
			})
			.catch(() => {
				/* Unreachable API: leave the door closed. */
			});
		return () => {
			live = false;
		};
	}, [signedIn]);

	// Pick up a Bluesky signup that came back without a usable address. Asked for only when
	// the callback said to — an unconditional fetch would put a request on every visit to
	// answer a question almost nobody is asking.
	useEffect(() => {
		if (signedIn) return;
		if (new URLSearchParams(location.search).get("atproto") !== "1") return;
		let live = true;
		client.api.atproto.pending
			.$get()
			.then((res) => res.json())
			.then(({ pending: row }) => {
				if (!live || !row) return;
				setPendingAtproto(row);
				// The PDS's address, if it gave us one. A prefill and not a claim — they may
				// type a different one, and the code is what settles it either way.
				if (row.email) setEmail(row.email);
			})
			.catch(() => {
				/* No parked signup, or the API is unreachable. The page is a signup page
				   regardless, and it still works without knowing this. */
			});
		return () => {
			live = false;
		};
	}, [signedIn, location.search]);

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
					// Directing support to someone follows them too; the reverse isn't implied.
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
	 * the page is waiting when they come back. Signed in, follows and creator
	 * allocations are applied, and support for Anthers opens the same confirmation modal the
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
	 * Hand off to Bluesky with the handle typed into the card.
	 *
	 * ⚠️ **`setBusy(false)` is deliberately missing from the success path**, because there
	 * is no success path to return to — `signUpWithBluesky` sets `window.location` and the
	 * browser leaves. Putting the button back would only invite a second handoff from a
	 * page that is already going.
	 *
	 * The picks are in session storage before this runs, so a round trip through another
	 * website loses nothing; see `PICKS_KEY`.
	 */
	const startBluesky = useCallback(
		async (raw: string) => {
			// A handle is a domain name; the leading `@` is how people write it, not part of
			// it. Stripped here rather than while typing, so the field never fights anyone.
			const value = raw.trim().replace(/^@/, "");
			if (!value) {
				setError("Add your Bluesky handle so we know which account to confirm.");
				return;
			}
			setBusy(true);
			setError(null);
			try {
				await signUpWithBluesky(value, next);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.");
				setBusy(false);
			}
		},
		[signUpWithBluesky, next],
	);

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

	/**
	 * Everything the signup control needs, shared by the copy at the top of the page and
	 * the one at the bottom.
	 *
	 * ⚠️ **Both read the same state, so both stay honest about the same total.** Somebody
	 * who scrolls down, adds support, and scrolls back up finds the top button saying
	 * *"Create my account & continue"* rather than still promising free — which is correct:
	 * they chose to pay. What must never happen is the two disagreeing.
	 */
	const signupProps = {
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
				: // 🚨 **The Bluesky note is the ONLY warning that the round trip asks for an email
					// address**, since the panel above it became a field and a button and nothing
					// else. `transition:email` is a real consent screen on somebody else's website,
					// and meeting it unannounced is how a signup gets abandoned at the last step —
					// so the note carries that rather than narrating the redirect, which the button
					// it sits under already names. `subscribe-bluesky.e2e.ts` pins the sentence.
					door === "bluesky"
					? "Bluesky will ask to share your email address."
					: "We'll email you a code to confirm your address.",
		onSubmit: submit,
		atprotoHandle: pendingAtproto?.handle ?? null,
		// Offered only to somebody signed out, and only while the door is actually open —
		// see `blueskySignupOpen` for why a button that refuses is worse than no button.
		onBluesky: signedIn || !blueskySignupOpen ? null : startBluesky,
		handle,
		onHandleChange: setHandle,
		door,
		onDoorChange: setDoor,
	};

	const summaryProps = {
		...signupProps,
		lines: summaryLines,
		total,
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
		// layout rather than as a bug.
		//
		// ⚠️ **88rem is wider than the shared marketing `Section` (`max-w-6xl`, 72rem), and
		// that is deliberate but temporary** (Parker, 2026-08-23): the whole site is due a
		// size and layout pass to widen its columns and size its text up, and this page went
		// first because it was being rebuilt anyway. When that pass lands, this number should
		// become whatever `Section` settles on rather than staying a local exception.
		<div className="mx-auto min-w-0 w-full max-w-[88rem] px-6 py-12 sm:py-16">
			<div className="min-w-0">
				<div>
					{/* ── Join, before anything is asked for ─────────────────── */}
					<Reveal>
						<div className="text-center">
							<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
								A non-profit · no ads, no shareholders, no strings
							</p>
							<h1
								style={serif}
								className="mt-4 text-balance text-4xl font-light leading-tight sm:text-5xl"
							>
								Anthers is free. Forever.
							</h1>
							<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
								No card required, no trial period, no ads or sneaky charges. We believe amazing
								creative and educational content should be free for all, no strings attached.
							</p>

							<FreeInclusions />

							{/* The turn from the list into the act. Without it the card arrives as a
							    form somebody has to work out the purpose of; with it, the five
							    inclusions above are the offer and this is the answer to them. */}
							<p
								style={serif}
								className="mx-auto mt-14 max-w-2xl text-balance text-2xl font-light leading-snug"
							>
								If that sounds good, sign up for free below and let&rsquo;s get started.
							</p>

							<div className="mx-auto mt-6 max-w-md">
								<SignupForm idPrefix="top" {...signupProps} />
							</div>
						</div>

						{/* What support is, as the tail of "it's free" rather than as its own step: the
						    primitive is one sentence, and giving it a numbered step of its own made the
						    page look like it asked three things when it asks two.
						    ⚠️ The old copy said "a monthly amount, from $3". There is no floor of $3 —
						    that is what unlimited Public Access costs, and a creator sets their own
						    levels to any amount at all. Naming a floor describes a mechanism the Seed
						    retirement removed.
						    ⭐ Each card is now a door into the section that asks for it, rather than a
						    description a reader has to hold in their head while scrolling past two more
						    screens to find the control it described. */}
						<div className="mt-14">
							<p className="mx-auto max-w-2xl text-center text-lg leading-relaxed text-base-content/65">
								<strong>Everything above is free forever</strong>, but there is more to love on
								Anthers if you want it. You can add either of these now, or at any point in the
								future.
							</p>
							<div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-2">
								<GoFurtherCard icon={HeartIcon} title="Support creators" target="support-a-creator">
									Every creator has work that is free to everyone and work they put behind a monthly
									amount they set — their own Badges. Anthers takes no cut of either. Pick anyone
									you&rsquo;d like to back as part of signing up.
								</GoFurtherCard>
								<GoFurtherCard icon={SparklesIcon} title="Support Anthers" target="support-anthers">
									{money(PUBLIC_ACCESS_PRICE)} a month takes the monthly limit off Public Access, so
									you can watch as much as you like, and it lifts what your time pays creators from{" "}
									{money(FREE_TIME_POOL)} a month to {money(timePoolFor(PUBLIC_ACCESS_PRICE))}.
									There is more on the way for supporters.
								</GoFurtherCard>
							</div>
						</div>
					</Reveal>

					{/* ── 1 · Support for a creator — the primary ask ───────────
					    The `id` is the target of the "Support creators" door up top, and the
					    `scroll-mt` keeps the heading clear of the sticky header when it lands. */}
					<Reveal
						delay={80}
						id="support-a-creator"
						className="mt-16 scroll-mt-24 border-t border-base-content/10 pt-14"
					>
						<StepHeading n={1} title="Support a creator">
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

					{/* ── 2 · Support for Anthers — the optional second thing ───
					    🚨 The one section this page must not let read as a requirement. Plenty of
					    people will be served entirely by purchases, creator support and the free
					    hours, and that is a fine way to use Anthers rather than a lapse to nudge
					    somebody out of. The heading's first words say so before the numbers do. */}
					<Reveal
						delay={80}
						id="support-anthers"
						className="mt-16 scroll-mt-24 border-t border-base-content/10 pt-14"
					>
						<StepHeading n={2} title="Support Anthers">
							<strong>Only if you want to.</strong> Buying from creators, backing them directly and
							the free {FREE_PUBLIC_ACCESS_HOURS} hours may be everything you ever need — this
							changes nothing about any of it. What it does is lift the monthly limit, and put{" "}
							<strong>
								{money(timePoolFor(PUBLIC_ACCESS_PRICE))} of every {money(PUBLIC_ACCESS_PRICE)}
							</strong>{" "}
							into the Time Pool, split among the creators whose work you spent time with.
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
						{/* ⚠️ This carried the same {money(FREE_TIME_POOL)} sentence the free
						    inclusions now open the page with. Repeating a fact at both ends of a
						    long page reads as a copy bug; what belongs *here* is not the mechanism
						    but the reassurance, at the one moment somebody is deciding whether
						    they have chosen enough. They have. */}
						<p className="mx-auto mt-5 max-w-xl text-center text-xs leading-relaxed text-base-content/45">
							Choosing nothing here is a complete answer — a free account still pays creators for
							the time you give them.
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
