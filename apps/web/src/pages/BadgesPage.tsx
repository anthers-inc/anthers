// SPDX-License-Identifier: Apache-2.0

/*
 * The Badges page — what the person holds, and what it does.
 *
 * A Badge is the monthly amount somebody gives a creator, and also the emblem they hold
 * while giving it. Two ladders live here, and they are one kind of object:
 *   1. The Badge held from Anthers — the monthly amount to Anthers, which lifts the
 *      Public Access limit at $3 and funds the Time Pool and the programs. Changed on
 *      /signup; this page displays and manages the subscription around it.
 *   2. The Badges held from creators — written by the subscription itself at the rung
 *      each creator names, clearing their ladder with no platform cut. Held and changed
 *      on the creator's own page; this page displays them.
 *
 * The cycle card beneath is the accounting record — where the month's money went — and
 * the cycle navigation lives there, because reviewing a closed cycle is accounting work
 * rather than the page's subject.
 *
 * A creator's Badge emblem renders through the same BadgeMark Anthers' own Badges render
 * through (CreatorBadgeMark), so both ladders read as one collection.
 */

// The narrower `Badge` (Anthers' own four, no "free") is what `AnthersBadgeMark` keys on —
// both types carry the name, and the disambiguation keeps the cast honest.
import type { Badge as IssuerBadge } from "@anthers/shared/constants";
import { timePoolFor } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { AnthersBadgeMark } from "@anthers/web-shared/economics";
import { CreatorBadgeMark } from "@anthers/web-shared/economics/CreatorBadgeMark";
import { EarningsBasis } from "@anthers/web-shared/economics/EarningsBasis";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type {
	Account,
	AccountResponse,
	AttentionSummary,
	Badge,
	BadgeHoldingsResponse,
	BadgeView,
	CreatorBadge,
	CreatorBadgeListResponse,
	CreatorEarnings,
	PoolDistribution,
} from "@anthers/web-shared/types";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnthersLadder } from "../lib/anthers-ladder";

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function fmt(n: number | string): string {
	return `$${Number(n).toFixed(2)}`;
}
function formatHours(seconds: number): string {
	const hrs = seconds / 3600;
	if (hrs >= 1) return `${hrs.toFixed(1)} hrs`;
	const mins = Math.round(seconds / 60);
	return mins > 0 ? `${mins}m` : "0m";
}

/* ------------------------------------------------------------------ */
/*  Cycle helpers                                                      */
/* ------------------------------------------------------------------ */

function getCurrentCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}
function offsetCycle(cycle: string, offset: number): string {
	const d = new Date(`${cycle}T00:00:00`);
	d.setMonth(d.getMonth() + offset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function cycleLabel(cycle: string): string {
	return new Date(`${cycle}T00:00:00`).toLocaleString("default", {
		month: "long",
		year: "numeric",
	});
}
type ViewMode = "past" | "current" | "next";
function viewModeFor(cycle: string): ViewMode {
	const current = getCurrentCycle();
	if (cycle === current) return "current";
	if (cycle > current) return "next";
	return "past";
}

/** Fetch a subscriptions GET endpoint that carries query params (raw, credentialed). */
async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(`${apiBaseUrl()}/api/subscriptions/${path}`, { credentials: "include" });
	if (!res.ok) throw new Error(`Request failed: ${path}`);
	return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/*  Cycle selector — the accounting card's control, small by design.   */
/* ------------------------------------------------------------------ */

function CycleSelector({ cycle, onChange }: { cycle: string; onChange: (c: string) => void }) {
	const current = getCurrentCycle();
	const nextCycle = offsetCycle(current, 1);
	const mode = viewModeFor(cycle);
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				className="btn btn-ghost btn-xs"
				aria-label="Earlier cycle"
				onClick={() => onChange(offsetCycle(cycle, -1))}
			>
				&larr;
			</button>
			<span className="text-sm font-medium min-w-[140px] text-center">
				{cycleLabel(cycle)}
				{mode === "current" && <span className="text-xs text-base-content/40 ml-1">(current)</span>}
				{mode === "next" && <span className="text-xs text-primary ml-1">(preview)</span>}
			</span>
			{cycle < nextCycle ? (
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					aria-label="Later cycle"
					onClick={() => onChange(offsetCycle(cycle, 1))}
				>
					&rarr;
				</button>
			) : (
				<div className="btn btn-ghost btn-xs invisible">&rarr;</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Row model                                                          */
/* ------------------------------------------------------------------ */

interface CreatorRow {
	/** The row's own merge key (creator id, or a negative synthetic key for a gone creator) — the React key. */
	mapKey: number;
	creatorId: number;
	handle: string;
	displayName: string | null;
	avatar: string | null;
	timeSeconds: number;
	poolAmount: number;
	/** Settled Badge share for this creator this cycle (from the distribution row). */
	settledBadge: number;
	/** The threshold of the Badge held from this creator this cycle, or 0. */
	committedBadge: number;
	/** The rung held or picked, including local pending edits. */
	pendingBadge: CreatorBadge | null;
	/** The creator's ladder, for the rung chips and the held emblem's fallback. */
	rungs: CreatorBadge[];
}

function initials(row: CreatorRow): string {
	return (row.displayName || row.handle)
		.split(/\s+/)
		.map((w) => w[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function BadgesPage() {
	const [searchParams] = useSearchParams();

	// The seeded ladder, for what this page quotes: the rungs strip (the rows are the
	// source of truth for each rung's label and price) and the InfoTip's claim about what
	// a Badge to Anthers funds. The constants stand in until the fetch lands.
	const { rungs: anthersRungs, publicAccessPrice } = useAnthersLadder();

	// Account + Badge + earnings
	const [account, setAccount] = useState<Account | null>(null);
	const [badge, setBadge] = useState<Badge>("free");
	const [badgeView, setBadgeView] = useState<BadgeView | null>(null);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);

	// Per-cycle data
	const [attention, setAttention] = useState<AttentionSummary | null>(null);
	const [distributions, setDistributions] = useState<PoolDistribution[]>([]);
	const [holdings, setHoldings] = useState<BadgeHoldingsResponse | null>(null);
	const [laddersMap, setLaddersMap] = useState<Map<string, CreatorBadge[]>>(new Map());

	// UI state
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [selectedCycle, setSelectedCycle] = useState(getCurrentCycle());

	const sessionId = searchParams.get("session_id");
	const viewMode = viewModeFor(selectedCycle);

	// ── Data fetching ──

	const fetchAccount = useCallback(async () => {
		try {
			const meRes = await client.api.subscriptions.me.$get();
			const me = (await meRes.json()) as AccountResponse;
			setAccount(me.account);
			setBadge(me.badge);
			setBadgeView(me.badgeView);
		} catch {
			setError("Failed to load your account.");
		} finally {
			setLoading(false);
		}

		// Earnings (non-blocking — only meaningful for creators)
		client.api.subscriptions.earnings
			.$get()
			.then((res) => res.json())
			.then((data) => setEarnings(data as CreatorEarnings))
			.catch(() => {});
	}, []);

	const fetchCycleData = useCallback(async (cycle: string) => {
		const [att, dist, held] = await Promise.allSettled([
			getJson<AttentionSummary>(`attention/summary?cycle=${cycle}`),
			getJson<{ distributions: PoolDistribution[] }>(`distributions?cycle=${cycle}`),
			getJson<BadgeHoldingsResponse>(`my-badges?cycle=${cycle}`),
		]);

		if (att.status === "fulfilled") setAttention(att.value);
		if (held.status === "fulfilled") setHoldings(held.value);

		if (dist.status === "fulfilled") {
			const rows = dist.value.distributions;
			setDistributions(rows);

			// Fetch each creator's ladder for the held-rung chips.
			const handles = rows.map((d) => d.creator?.handle).filter(Boolean) as string[];
			const ladders = new Map<string, CreatorBadge[]>();
			const ladderResults = await Promise.allSettled(
				handles.map(async (u) => ({
					handle: u,
					badges: (await getJson<CreatorBadgeListResponse>(`badges?creator=${u}`)).badges,
				})),
			);
			for (const r of ladderResults) {
				if (r.status === "fulfilled") ladders.set(r.value.handle, r.value.badges);
			}
			setLaddersMap(ladders);
		}
	}, []);

	useEffect(() => {
		fetchAccount();
	}, [fetchAccount]);
	useEffect(() => {
		fetchCycleData(selectedCycle);
	}, [selectedCycle, fetchCycleData]);

	useEffect(() => {
		if (sessionId) {
			setSuccess("Payment received! Your account is updated.");
			const timer = setTimeout(fetchAccount, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchAccount]);

	// ── Derived rows ──

	const rows: CreatorRow[] = useMemo(() => {
		const map = new Map<number, CreatorRow>();
		for (const d of distributions) {
			// `creatorId` is null once that creator deletes their account — the payment
			// record survives them (Privacy Policy), so this list has to render the money without a
			// creator to attach it to. Keyed on a negative synthetic id so several deleted
			// creators stay separate rows rather than collapsing into one, and labeled
			// rather than blanked: the person is gone, what you paid is not.
			const key = d.creatorId ?? -d.id;
			map.set(key, {
				mapKey: key,
				creatorId: d.creatorId ?? 0,
				handle: d.creator?.handle ?? "",
				displayName: d.creator?.displayName ?? (d.creatorId === null ? "Deleted creator" : null),
				avatar: d.creator?.avatar ?? null,
				timeSeconds: d.attentionSeconds ?? 0,
				poolAmount: Number(d.poolAmount),
				settledBadge: Number(d.badgeAmount),
				committedBadge: 0,
				pendingBadge: null,
				rungs: [],
			});
		}
		// A holding's dollars are its Badge's threshold by construction, so the holding
		// row carries no amount — the rung it names is the amount. The API keys a
		// holding by its Badge id only, so rows merge on HANDLE: a distribution or a
		// holding may arrive without the other, and both name the same creator.
		for (const h of holdings?.badges ?? []) {
			const existing = [...map.values()].find((row) => row.handle === h.creator.handle);
			const committed = Math.round(Number(h.threshold));
			const heldRung: CreatorBadge = {
				id: h.id,
				creatorId: existing?.creatorId ?? 0,
				threshold: h.threshold,
				label: h.label,
				description: h.description,
				hasArt: h.hasArt,
				artShape: h.artShape,
				artColor: h.artColor,
				sortOrder: 0,
				createdAt: h.createdAt,
				updatedAt: h.createdAt,
			};
			if (existing) {
				existing.committedBadge = committed;
				existing.pendingBadge = heldRung;
			} else {
				map.set(-h.id, {
					mapKey: -h.id,
					creatorId: -h.id,
					handle: h.creator.handle,
					displayName: h.creator.displayName ?? null,
					avatar: null,
					timeSeconds: 0,
					poolAmount: 0,
					settledBadge: 0,
					committedBadge: committed,
					pendingBadge: heldRung,
					rungs: [],
				});
			}
		}
		for (const row of map.values()) {
			const rungs = laddersMap.get(row.handle) ?? [];
			row.rungs = rungs;
		}
		return Array.from(map.values()).sort(
			(a, b) => b.poolAmount + b.committedBadge - (a.poolAmount + a.committedBadge),
		);
	}, [distributions, holdings, laddersMap]);

	const totalPool = rows.reduce((s, r) => s + r.poolAmount, 0);
	const totalTime = rows.reduce((s, r) => s + r.timeSeconds, 0);

	const isPaid = badge !== "free";
	const isCanceling = account ? !!account.canceledAt : false;

	// ── Account actions ──

	const handleCancel = async () => {
		setActionLoading("cancel");
		setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			setAccount(((await res.json()) as unknown as { account: Account }).account);
			setSuccess(
				"Your support for Anthers will revert to Free at the end of the current billing period.",
			);
		} catch {
			setError("Failed to cancel.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleResume = async () => {
		setActionLoading("resume");
		setError(null);
		try {
			const res = await client.api.subscriptions.resume.$post();
			setAccount(((await res.json()) as unknown as { account: Account }).account);
			setSuccess("Subscription renewal resumed.");
		} catch {
			setError("Failed to resume.");
		} finally {
			setActionLoading(null);
		}
	};

	const handleBillingPortal = async () => {
		setActionLoading("portal");
		try {
			const res = await client.api.subscriptions["billing-portal"].$post();
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				setError(data.error ?? "Failed to open billing portal.");
				setActionLoading(null);
				return;
			}
			window.location.href = ((await res.json()) as { portalUrl: string }).portalUrl;
		} catch {
			setError("Failed to open billing portal.");
			setActionLoading(null);
		}
	};

	/* ---- Render ---- */

	if (loading)
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);

	if (!account || !badgeView)
		return (
			<div className="max-w-2xl mx-auto px-4 py-8 text-center">
				<h1 className="text-2xl font-bold mb-4">Account unavailable</h1>
				<p className="mb-4">{error ?? "We couldn't load your account. Please try again."}</p>
				<Link to="/signup" className="btn btn-primary">
					Support Anthers
				</Link>
			</div>
		);

	return (
		// `min-w-0 w-full max-w-full` breaks the flex-column min-content cascade
		// so this wrapper can shrink below its inner content's min-content
		// width on mobile (the same fix the other top-level pages carry).
		// Without `w-full`, `mx-auto` on a flex item disables the default
		// `align-self: stretch`, so the wrapper falls back to its content's
		// intrinsic width (up to the cap), which can push past the mobile
		// viewport. The page takes a reading measure rather than a dashboard
		// width — what it holds is lists and a card, not a wide grid.
		<div className="mx-auto min-w-0 w-full max-w-full max-w-4xl px-4 py-8">
			<div className="mb-2">
				<h1 className="text-2xl font-bold">Badges</h1>
				{/* The one page title; the cards below carry their own section titles. */}
				<p className="text-sm text-base-content/50">
					Badges mark how you back Anthers and the creators you choose — held while you're giving,
					at the amount you pick.
				</p>
			</div>
			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}
			{success && (
				<div className="alert alert-success mb-4">
					<span>{success}</span>
				</div>
			)}

			{/* ── The Badge from Anthers ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="divider text-sm text-base-content/50 mt-0 mb-4">
					Your Badge from Anthers
					<InfoTip
						text={`What you give Anthers funds the Time Pool ($${timePoolFor(publicAccessPrice).toFixed(2)}, to creators by time) and Supports Anthers (the remainder, which funds the charitable programs — free access included). The card fee is inside the price. Downloads are unlimited and cost nothing, and $${publicAccessPrice} a month lifts the ${FREE_PUBLIC_ACCESS_HOURS}-hour monthly limit on Public Access.`}
					/>
				</div>

				<div className="flex items-start gap-4">
					{badge !== "free" && <AnthersBadgeMark badge={badge} size="h-16 w-16" />}
					<div className="flex-1 min-w-0">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className="text-lg font-bold">{badgeView.name}</span>
							<span className="text-base-content/60 tabular-nums">{fmt(badgeView.price)}/mo</span>
							{isCanceling && (
								<span className="text-error text-sm">(reverts to Free at period end)</span>
							)}
						</div>
					</div>
					{viewMode === "current" && (
						<div className="flex flex-col items-end gap-2 shrink-0">
							<button
								type="button"
								className={`btn btn-sm ${actionLoading === "portal" ? "btn-disabled" : "btn-neutral"}`}
								onClick={handleBillingPortal}
								disabled={!!actionLoading}
							>
								{actionLoading === "portal" ? "Opening…" : "Manage Billing"}
							</button>
							{isPaid &&
								(isCanceling ? (
									<button
										type="button"
										className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
										onClick={handleResume}
										disabled={!!actionLoading}
									>
										{actionLoading === "resume" ? "Resuming…" : "Resume supporting"}
									</button>
								) : (
									<button
										type="button"
										className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
										onClick={handleCancel}
										disabled={!!actionLoading}
									>
										{actionLoading === "cancel" ? "Stopping…" : "Stop supporting"}
									</button>
								))}
							<Link to="/signup" className="btn btn-primary btn-sm">
								Adjust support
							</Link>
						</div>
					)}
				</div>

				{/* Where the month's support goes */}
				<div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-5">
					<div>
						<div className="text-xs text-base-content/50 uppercase">Time Pool</div>
						<div className="text-lg font-bold text-success">{fmt(badgeView.timePool)}</div>
						<div className="text-[11px] text-base-content/40">to creators, by time</div>
					</div>
					<div>
						<div className="text-xs text-base-content/50 uppercase">Supports Anthers</div>
						<div className="text-lg font-bold">{fmt(badgeView.supportsAnthers)}</div>
						<div className="text-[11px] text-base-content/40">free access &amp; programs</div>
					</div>
					{/*
					 * 🚨 Reads the amount, because this card is rendered for the $0 rung
					 * too and used to tell that user their streaming was "Unlimited" — the one
					 * person on the page for whom it is false. Public Access is capped monthly
					 * until the Public Access price to Anthers lifts it; downloads are unlimited either
					 * way, which is why the sub-label sits under both branches.
					 *
					 * 🚨 The comparison reads the SEEDED ladder — the price lifting the limit is a
					 * ladder claim, the same one every other surface quotes. The card is rendered
					 * for the $0 rung too and must not read as "unlimited" until the fetched
					 * value agrees.
					 */}
					<div>
						<div className="text-xs text-base-content/50 uppercase">Public Access</div>
						<div className="text-lg font-bold">
							{badgeView.price >= publicAccessPrice
								? "Unlimited"
								: `${FREE_PUBLIC_ACCESS_HOURS} hrs/mo`}
						</div>
						{/* econ:allow — this states the ABSENCE of the retired mechanism, which is the
						    one place naming it is correct. */}
						<div className="text-[11px] text-base-content/40">
							downloads always free — no allowance, no per-GiB charge
						</div>
					</div>
				</div>

				{/* The ladder, as the seeded rows state it — the held rung lit, the rest shown
				    as what raising the amount would hold. Free renders no mark (a mark IS a
				    Badge and Free is the absence of one); the strip is still what $3+ buys. */}
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3 mt-5 pt-4 border-t border-base-content/10">
					{anthersRungs.map((rung) => {
						const held = rung.name === badge;
						return (
							<div
								key={rung.name}
								className="flex items-center gap-2"
								title={rung.description ?? undefined}
							>
								<AnthersBadgeMark badge={rung.name as IssuerBadge} lit={held} size="h-9 w-9" />
								<div className="text-xs leading-tight">
									<div className={held ? "font-bold" : "text-base-content/60"}>{rung.label}</div>
									<div className="text-base-content/40 tabular-nums">{fmt(rung.threshold)}/mo</div>
								</div>
							</div>
						);
					})}
					<Link to="/signup" className="link link-primary text-sm ml-auto">
						{isPaid ? "Raise your support" : "Support Anthers"}
					</Link>
				</div>

				{account.currentPeriodEnd && viewMode === "current" && (
					<p className="text-xs text-base-content/40 text-center mt-4">
						{isCanceling ? "Support ends" : "Next renewal"}:{" "}
						{new Date(account.currentPeriodEnd).toLocaleDateString("en-US", {
							month: "long",
							day: "numeric",
							year: "numeric",
						})}
					</p>
				)}
			</div>

			{/* ── The Badges held from creators ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="divider text-sm text-base-content/50 mt-0 mb-1">
					Badges You Hold
					<InfoTip text="A Badge from a creator is the monthly amount you give them — held while you're giving, clearing the rung on their ladder, with no platform cut; only the at-cost card processing comes out. Pick one on the creator's own page, and it renews monthly alongside your support for Anthers." />
				</div>

				{holdings && holdings.badges.length > 0 ? (
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						{rows.map((row) => (
							<CreatorBadgeCard key={row.mapKey} row={row} />
						))}
					</div>
				) : (
					<div className="py-4 text-center text-sm text-base-content/50">
						<p>
							{isPaid
								? "You hold no Badges from creators this cycle."
								: "You don't hold any Badges yet."}
						</p>
						<p className="mt-1 text-base-content/40">
							A Badge from a creator is the monthly amount you give them, picked on their own page.
						</p>
						<Link to="/discover" className="btn btn-primary btn-sm mt-3">
							Find creators to back
						</Link>
					</div>
				)}
			</div>

			{/* ── Where the month went — the accounting record ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-1">
					<div className="divider text-sm text-base-content/50 mt-0 mb-0 flex-1 sm:mb-0 justify-start">
						Where Your Month Went
					</div>
					<div className="self-end sm:self-auto">
						<CycleSelector cycle={selectedCycle} onChange={setSelectedCycle} />
					</div>
				</div>
				{/* Fixed-height so switching months changes the text without shifting the layout. */}
				<p className="text-xs text-base-content/50 min-h-[1rem]">
					{viewMode === "past"
						? "Read-only view of a closed cycle."
						: viewMode === "next"
							? "Preview — you can direct next month's support now."
							: ""}
				</p>
				{attention && (
					<p className="text-xs text-base-content/40 mb-3">
						{attention.hoursUsed} hrs of time with creators this cycle
					</p>
				)}

				{rows.length > 0 ? (
					<div>
						<div className="flex items-center gap-3 text-[10px] text-base-content/40 uppercase tracking-wider px-1 pb-1 border-b border-base-content/10">
							<div className="w-7" />
							<span className="flex-1">Creator</span>
							<span className="text-right hidden sm:block">Time</span>
							<span className="w-16 text-right">Time Pool</span>
							<span className="w-16 text-right">Badge</span>
						</div>
						{rows.map((row) => {
							const pct = totalTime > 0 ? Math.round((row.timeSeconds / totalTime) * 100) : 0;
							return (
								<div key={row.mapKey} className="flex items-center gap-3 text-sm px-1 py-1.5">
									<div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 bg-base-300 overflow-hidden">
										{row.avatar ? (
											<img src={row.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
										) : (
											initials(row)
										)}
									</div>
									<Link
										to={profileUrl(row.handle)}
										className="text-base-content/70 truncate flex-1 link-hover min-w-0"
									>
										{row.displayName || row.handle}
									</Link>
									{/* Two ways money reaches a creator: the Time Pool, by your time —
									    video, audio, reading, and gameplay all count equally — and the
									    Badge you hold from them. */}
									<span className="text-base-content/40 text-xs tabular-nums text-right hidden sm:block">
										{row.timeSeconds > 0 ? (
											<>
												{formatHours(row.timeSeconds)}
												{pct > 0 ? ` (${pct}%)` : ""}
											</>
										) : (
											"—"
										)}
									</span>
									<span className="text-success tabular-nums w-16 text-right">
										{fmt(row.poolAmount)}
									</span>
									<span
										className={`tabular-nums w-16 text-right ${row.settledBadge || row.committedBadge ? "" : "text-base-content/25"}`}
									>
										{row.settledBadge || row.committedBadge
											? fmt(row.settledBadge || row.committedBadge)
											: "—"}
									</span>
								</div>
							);
						})}
						<div className="flex items-center justify-between text-sm border-t border-base-content/10 mt-2 pt-2">
							<span className="text-base-content/60">Time Pool total</span>
							<strong className="text-success tabular-nums">{fmt(totalPool)}</strong>
						</div>
					</div>
				) : (
					<div className="py-4 text-center text-sm text-base-content/40">
						<p>No time with creators yet this cycle.</p>
						<p className="mt-1">
							Your Time Pool is distributed by time — video, audio, text, and gameplay all count
							equally.
						</p>
					</div>
				)}
			</div>

			{/* ── Creator earnings ── */}
			{earnings && parseFloat(earnings.total) > 0 && (
				<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
					<div className="divider text-sm text-base-content/50 mt-0 mb-3">
						Your Creator Earnings
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div>
							<div className="text-xs text-base-content/50 uppercase">Pool income</div>
							<div className="text-xl font-bold text-success">{fmt(earnings.poolTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Badge income</div>
							<div className="text-xl font-bold text-success">{fmt(earnings.badgeTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Total</div>
							<div className="text-xl font-bold">{fmt(earnings.total)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Supporters</div>
							<div className="text-xl font-bold">{earnings.subscriberCount}</div>
						</div>
					</div>
					{/* The transfer split — settled money still waiting out its hold, beside
							what has already moved into the connected account. */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
						<div>
							<div className="text-xs text-base-content/50 uppercase">Held</div>
							<div className="text-xl font-bold">{fmt(earnings.heldTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Transferred</div>
							<div className="text-xl font-bold">{fmt(earnings.transferredTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Recovered</div>
							<div className="text-xl font-bold">{fmt(earnings.nettedTotal)}</div>
						</div>
						<div>
							<div className="text-xs text-base-content/50 uppercase">Still Recovering</div>
							<div className="text-xl font-bold">{fmt(earnings.nettingOpenTotal)}</div>
						</div>
					</div>
					{earnings.cycle && (
						<p className="text-xs text-base-content/50 mt-2">
							<EarningsBasis earnings={earnings} />
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  One held creator card                                              */
/* ------------------------------------------------------------------ */

/**
 * A creator the person backs, as a Badge they hold: their patch — the emblem IS the
 * Badge they hold — beside the rung's label and price, the rest of the ladder beneath as
 * the rungs a raised amount would hold. Buying and changing a Badge happens on the
 * creator's own page; this card links there and picks nothing.
 */
function CreatorBadgeCard({ row }: { row: CreatorRow }) {
	const held = row.pendingBadge;
	const heldIndex =
		held && row.rungs.length > 0 ? row.rungs.findIndex((r) => r.id === held.id) : -1;
	const name = row.displayName || row.handle || "Deleted creator";

	return (
		<div className="rounded-lg p-3 bg-base-100/40 flex flex-col gap-2">
			<div className="flex items-center gap-3">
				{held && heldIndex >= 0 ? (
					<CreatorBadgeMark
						badgeId={held.id}
						index={heldIndex}
						label={`${held.label} badge`}
						art={{
							artShape: held.artShape,
							artColor: held.artColor,
							hasArt: held.hasArt,
						}}
						size="h-12 w-12"
					/>
				) : (
					<div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 bg-base-300 overflow-hidden">
						{row.avatar ? (
							<img src={row.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
						) : (
							initials(row)
						)}
					</div>
				)}
				<div className="flex-1 min-w-0">
					{row.handle ? (
						<Link
							to={`${profileUrl(row.handle)}?tab=badges`}
							className="text-sm font-medium link-hover block truncate"
						>
							{name}
						</Link>
					) : (
						<span className="text-sm font-medium block truncate">{name}</span>
					)}
					{held && (
						<span className="text-xs text-base-content/50 tabular-nums">
							{held.label} · {fmt(held.threshold)}/mo
						</span>
					)}
				</div>
			</div>
			{row.rungs.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{row.rungs.map((rung) => {
						const isHeld = held?.id === rung.id;
						return (
							<span
								key={rung.id}
								className={`badge badge-xs ${isHeld ? "badge-success" : "badge-ghost"}`}
								title={rung.description ?? undefined}
							>
								{isHeld ? "✓" : "○"} {rung.label} (${rung.threshold})
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
}
