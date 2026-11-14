// SPDX-License-Identifier: Apache-2.0

/*
 * The Badges settings tab — one collection, from Anthers and from every creator backed.
 *
 * The page is three surfaces in order: the grid of every Badge the account carries, with
 * Anthers always first; the details of whichever one is selected; and a rolling five-month
 * row of what that Badge costs. "All Badges" selects the whole collection, which gives the
 * details a "Multiple Badges Selected" state and makes the month row the combined total.
 *
 * ⭐ **The two ladders are one collection** (Parker, 2026-11-12). The Anthers Badge and the
 * creator Badges were two cards with two mental models; the grid puts them in one order and
 * the details section renders Anthers' ladder through the same card shape a creator's
 * ladder uses. Anthers' own slot is special because it carries the subscription, not because
 * it is a different kind of Badge.
 *
 * ⭐ **The five-month row is where the prorate discount becomes legible.** A Badge bought
 * mid-month is charged in full that day and carries a day-exact reduction against the next
 * renewal, so the next month is cheaper and the one after returns to the rung's price. The
 * row shows paid months in green and estimated months outlined, and names a reduction under
 * the month it discounts.
 *
 * The Time Pool accounting that used to share this page's cycle card moved to the Time tab
 * (2026-11-12). Badges are the standing relationship and its charges; the pool is time.
 */

import { currentCycleKey, cycleStart } from "@anthers/shared/billing-cycle";
// The narrower `Badge` (Anthers' own four, no "free") is what `AnthersBadgeMark` keys on —
// both types carry the name, and the disambiguation keeps the cast honest.
import type { Badge as IssuerBadge } from "@anthers/shared/constants";
import {
	stickerBudgetFor,
	storageReserveFor,
	supportLineFor,
	timePoolByTimeFor,
} from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { AnthersBadgeMark, BadgeMark } from "@anthers/web-shared/economics";
import { CreatorBadgeMark } from "@anthers/web-shared/economics/CreatorBadgeMark";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type {
	Account,
	AccountResponse,
	Badge,
	BadgeHolding,
	BadgeHoldingsResponse,
	BadgeMonthCharge,
	BadgeMonthsResponse,
	BadgeView,
	CreatorBadge,
	CreatorBadgeListResponse,
} from "@anthers/web-shared/types";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAnthersLadder } from "../../lib/anthers-ladder";

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function fmt(n: number | string): string {
	return `$${Number(n).toFixed(2)}`;
}

function monthLabel(cycle: string): string {
	return cycleStart(cycle).toLocaleString("default", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

function shortMonth(cycle: string): string {
	return cycleStart(cycle).toLocaleString("default", { month: "short", timeZone: "UTC" });
}

function shortYear(cycle: string): string {
	return cycleStart(cycle).toLocaleString("default", { year: "numeric", timeZone: "UTC" });
}

function nameOf(holding: BadgeHolding): string {
	return holding.creator.displayName || holding.creator.handle || "A creator";
}

/** The tile's name: both creators for a shared Badge, the publisher alone otherwise. */
function ownersOf(holding: BadgeHolding): string {
	const owners = holding.owners ?? [];
	if (owners.length < 2) return nameOf(holding);
	return owners.map((owner) => owner.displayName || owner.handle).join(" & ");
}

/** Fetch a subscriptions GET endpoint that carries query params (raw, credentialed). */
async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(`${apiBaseUrl()}/api/subscriptions/${path}`, { credentials: "include" });
	if (!res.ok) throw new Error(`Request failed: ${path}`);
	return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/*  The Anthers slot's mark                                            */
/* ------------------------------------------------------------------ */

/**
 * Anthers' tile needs a mark for the free account too, and Free has no Badge art by design.
 * The bee patch is a placeholder that belongs to Anthers rather than a fifth rung: it never
 * appears on the ladder, and it is drawn dim so it cannot be mistaken for a held Badge.
 */
function AnthersSlotMark({ badge }: { badge: Badge }) {
	if (badge !== "free") {
		return <AnthersBadgeMark badge={badge as IssuerBadge} size="h-12 w-12" />;
	}
	return (
		<BadgeMark
			shape="circle"
			color="cream"
			emblem="bee"
			label="Anthers"
			clipId="badge-mark-anthers-free"
			dim
			size="h-12 w-12"
		/>
	);
}

/* ------------------------------------------------------------------ */
/*  One tile in the collection grid                                    */
/* ------------------------------------------------------------------ */

function BadgeTile({
	selected,
	onSelect,
	name,
	subline,
	handle,
	mark,
	special = false,
}: {
	selected: boolean;
	onSelect: () => void;
	name: string;
	subline: string;
	handle?: string;
	mark: ReactNode;
	special?: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onSelect}
			className={`relative flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-colors ${
				special
					? "border-primary/40 bg-gradient-to-br from-primary/15 via-base-100 to-base-200 hover:border-primary/70"
					: "border-base-content/10 bg-base-100/40 hover:border-primary/40"
			} ${selected ? "ring-2 ring-primary ring-offset-2 ring-offset-base-200" : ""}`}
		>
			{selected && (
				<span
					aria-hidden="true"
					className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-content"
				>
					✓
				</span>
			)}
			<div className="flex h-12 items-center justify-center">{mark}</div>
			<div className="min-w-0 w-full">
				<p className="truncate text-sm font-semibold">{name}</p>
				{handle && handle !== name && (
					<p className="truncate text-[11px] text-base-content/45">@{handle}</p>
				)}
				<p className="mt-0.5 truncate text-[11px] text-base-content/55 tabular-nums">{subline}</p>
			</div>
		</button>
	);
}

/* ------------------------------------------------------------------ */
/*  One tall card in Badge Details, borrowed from the creator page     */
/* ------------------------------------------------------------------ */

function BadgeDetailCard({
	mark,
	label,
	threshold,
	description,
	current,
}: {
	mark: ReactNode;
	label: string;
	threshold: number | string;
	description: string | null;
	current: boolean;
}) {
	return (
		<article
			className={`relative flex h-full flex-col rounded-2xl border bg-base-200 p-4 ${
				current ? "border-success/60" : "border-base-content/10"
			}`}
		>
			{current && (
				<>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute -inset-1.5 rounded-[1.15rem] ring-2 ring-success/40"
					/>
					<span className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-success px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success-content shadow">
						Current Badge
					</span>
				</>
			)}
			<div className="flex items-center gap-4">
				{mark}
				<div className="min-w-0 flex-1">
					<h4 className="text-xl font-bold leading-tight">{label}</h4>
					<p className="mt-1 text-2xl font-semibold leading-none">
						{fmt(threshold)}
						<span className="ml-0.5 text-sm font-normal text-base-content/50">/mo</span>
					</p>
				</div>
			</div>
			{description && (
				<p className="my-4 whitespace-pre-line border-y border-base-300/60 py-3 text-sm text-base-content/60">
					{description}
				</p>
			)}
		</article>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function BadgesSection() {
	const [searchParams] = useSearchParams();

	// The seeded ladder, for what the Anthers details quote: the rungs strip and the
	// InfoTip's claim about what a Badge to Anthers funds. The constants stand in until
	// the fetch lands.
	const { rungs: anthersRungs, publicAccessPrice } = useAnthersLadder();

	// Account + Badge
	const [account, setAccount] = useState<Account | null>(null);
	const [badge, setBadge] = useState<Badge>("free");
	const [badgeView, setBadgeView] = useState<BadgeView | null>(null);

	// The collection, the ladders behind its marks, and the rolling charge row.
	const [holdings, setHoldings] = useState<BadgeHolding[] | null>(null);
	const [ladders, setLadders] = useState<Map<string, CreatorBadge[]>>(new Map());
	const [months, setMonths] = useState<BadgeMonthCharge[] | null>(null);
	const [monthsError, setMonthsError] = useState(false);

	// `all`, `anthers`, or a creator's handle. Anthers is the opening selection because it
	// is the slot that carries the subscription controls.
	const [selected, setSelected] = useState<"all" | "anthers" | string>("anthers");

	// UI state
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	const sessionId = searchParams.get("session_id");

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
	}, []);

	const fetchHoldings = useCallback(async () => {
		try {
			const data = await getJson<BadgeHoldingsResponse>("my-badges");
			setHoldings(data.badges);

			// Each held creator's ladder, so the tile can draw the rung's position and the
			// details section can show the whole ladder rather than the held rung alone.
			const handles = data.badges
				.filter((holding) => !holding.isAnthers && holding.creator.handle)
				.map((holding) => holding.creator.handle);
			const ladderResults = await Promise.allSettled(
				handles.map(async (handle) => ({
					handle,
					badges: (
						await getJson<CreatorBadgeListResponse>(`badges?creator=${encodeURIComponent(handle)}`)
					).badges,
				})),
			);
			const next = new Map<string, CreatorBadge[]>();
			for (const result of ladderResults) {
				if (result.status === "fulfilled") next.set(result.value.handle, result.value.badges);
			}
			setLadders(next);
		} catch {
			setError("Failed to load the Badges you carry.");
		}
	}, []);

	const fetchMonths = useCallback(async () => {
		setMonthsError(false);
		try {
			setMonths((await getJson<BadgeMonthsResponse>("badge-months")).months);
		} catch {
			setMonthsError(true);
		}
	}, []);

	useEffect(() => {
		fetchAccount();
		fetchHoldings();
		fetchMonths();
	}, [fetchAccount, fetchHoldings, fetchMonths]);

	useEffect(() => {
		if (sessionId) {
			setSuccess("Payment received! Your account is updated.");
			const timer = setTimeout(() => {
				void fetchAccount();
				void fetchHoldings();
				void fetchMonths();
			}, 2000);
			return () => clearTimeout(timer);
		}
	}, [sessionId, fetchAccount, fetchHoldings, fetchMonths]);

	// ── Derived rows ──

	/** Every held creator Badge, strongest first; the Anthers slot is rendered separately. */
	const creatorBadges = useMemo(() => {
		const rows = (holdings ?? []).filter((holding) => !holding.isAnthers && holding.creator.handle);
		return [...rows].sort((a, b) => {
			const byAmount = Number(b.threshold) - Number(a.threshold);
			if (byAmount !== 0) return byAmount;
			return nameOf(a).localeCompare(nameOf(b));
		});
	}, [holdings]);

	const selectedHolding =
		selected !== "all" && selected !== "anthers"
			? creatorBadges.find((holding) => holding.creator.handle === selected)
			: undefined;
	const selectedLadder = selectedHolding ? (ladders.get(selectedHolding.creator.handle) ?? []) : [];

	/**
	 * The five months, narrowed to whatever is selected. `All Badges` uses the server's
	 * combined total; a single Badge sums the rows that name it, which is one row in every
	 * ordinary month and more only if two rails recorded the same destination.
	 */
	const monthRows = useMemo(
		() =>
			(months ?? []).map((month) => {
				if (selected === "all") {
					return {
						cycle: month.cycle,
						state: month.state,
						amount: month.total,
						reduction: month.reduction,
						hasCharge: month.badges.length > 0,
					};
				}
				const rows = month.badges.filter((row) =>
					selected === "anthers" ? row.isAnthers : row.handle === selected,
				);
				const amount = rows.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2);
				const reduction = rows.reduce((sum, row) => sum + Number(row.reduction), 0).toFixed(2);
				return {
					cycle: month.cycle,
					state: month.state,
					amount,
					reduction,
					hasCharge: rows.length > 0,
				};
			}),
		[months, selected],
	);

	const isPaid = badge !== "free";
	const isCanceling = account ? !!account.canceledAt : false;

	// ── Account actions ──

	const refreshAfterAction = useCallback(() => {
		void fetchAccount();
		void fetchHoldings();
		void fetchMonths();
	}, [fetchAccount, fetchHoldings, fetchMonths]);

	const handleCancel = async () => {
		setActionLoading("cancel");
		setError(null);
		try {
			const res = await client.api.subscriptions.cancel.$post();
			setAccount(((await res.json()) as unknown as { account: Account }).account);
			setSuccess(
				"Your support for Anthers will revert to Free at the end of the current billing period.",
			);
			refreshAfterAction();
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
			refreshAfterAction();
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
			<div className="max-w-2xl mx-auto py-8 text-center">
				<h2 className="text-xl font-bold mb-4">Account unavailable</h2>
				<p className="mb-4">{error ?? "We couldn't load your account. Please try again."}</p>
				<Link to="/signup" className="btn btn-primary">
					Support Anthers
				</Link>
			</div>
		);

	return (
		<section aria-labelledby="badges-section-heading" className="mb-10">
			<div className="mb-4">
				<h2 id="badges-section-heading" className="text-xl font-bold">
					Badges
				</h2>
				<p className="text-sm text-base-content/50">
					Every Badge you carry, from Anthers and from the creators you back.
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

			{/* ── The whole collection ── */}
			<button
				type="button"
				aria-pressed={selected === "all"}
				onClick={() => setSelected("all")}
				className={`btn w-full mb-3 ${selected === "all" ? "btn-primary" : "btn-outline"}`}
			>
				All Badges
				<span
					className={`badge badge-sm ${selected === "all" ? "badge-primary-content" : "badge-ghost"}`}
				>
					{creatorBadges.length + 1}
				</span>
			</button>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3 mb-6">
				<BadgeTile
					special
					selected={selected === "anthers"}
					onSelect={() => setSelected("anthers")}
					name="Anthers"
					subline={`${badgeView.name} · ${fmt(badgeView.price)}/mo`}
					mark={<AnthersSlotMark badge={badge} />}
				/>
				{creatorBadges.map((holding) => {
					const ladder = ladders.get(holding.creator.handle) ?? [];
					const index = Math.max(
						0,
						ladder.findIndex((rung) => rung.id === holding.id),
					);
					return (
						<BadgeTile
							key={holding.id}
							selected={selected === holding.creator.handle}
							onSelect={() => setSelected(holding.creator.handle)}
							name={ownersOf(holding)}
							handle={holding.creator.handle}
							subline={`${holding.label} · ${fmt(holding.threshold)}/mo`}
							mark={
								<CreatorBadgeMark
									badgeId={holding.id}
									index={index}
									label={`${holding.label} badge`}
									art={holding}
									owners={holding.owners}
									size="h-12 w-12"
								/>
							}
						/>
					);
				})}
			</div>

			{/* ── Whatever is selected ── */}
			<div className="card bg-base-200/60 shadow-xl p-5 mb-6">
				<div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
					<h3 className="text-lg font-bold">Badge Details</h3>
					{selectedHolding && (
						<Link
							to={`${profileUrl(selectedHolding.creator.handle)}?tab=badges`}
							className="link link-primary text-sm"
						>
							Open {nameOf(selectedHolding)}'s page
						</Link>
					)}
				</div>

				{selected === "all" ? (
					<div className="py-12 text-center">
						<p className="text-base font-medium text-base-content/60">Multiple Badges Selected</p>
						<p className="mt-1 text-sm text-base-content/40">
							Choose one Badge above to see its details.
						</p>
					</div>
				) : selected === "anthers" ? (
					<AnthersBadgeDetails
						account={account}
						badge={badge}
						badgeView={badgeView}
						anthersRungs={anthersRungs}
						publicAccessPrice={publicAccessPrice}
						isPaid={isPaid}
						isCanceling={isCanceling}
						actionLoading={actionLoading}
						onBillingPortal={handleBillingPortal}
						onCancel={handleCancel}
						onResume={handleResume}
					/>
				) : selectedHolding ? (
					<CreatorBadgeDetails holding={selectedHolding} ladder={selectedLadder} />
				) : (
					<div className="py-12 text-center">
						<p className="text-base font-medium text-base-content/60">Multiple Badges Selected</p>
					</div>
				)}
			</div>

			{/* ── The rolling five-month charge row ── */}
			<div className="card bg-base-200/60 shadow-xl p-5">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<h3 className="text-lg font-bold">Monthly Charges</h3>
					{selectedHolding && (
						<span className="text-xs text-base-content/45">
							{shortMonth(monthRows[0]?.cycle ?? currentCycleKey())} –{" "}
							{shortMonth(monthRows[monthRows.length - 1]?.cycle ?? currentCycleKey())}{" "}
							{shortYear(monthRows[monthRows.length - 1]?.cycle ?? currentCycleKey())}
						</span>
					)}
				</div>
				<p className="mt-1 text-sm text-base-content/55">
					{selected === "all"
						? "Every Badge combined, two months back and two ahead."
						: selected === "anthers"
							? "What support for Anthers costs each month."
							: selectedHolding
								? `What ${nameOf(selectedHolding)}'s Badge costs each month.`
								: "Choose a Badge above to see its charges."}
				</p>

				{monthsError ? (
					<p className="mt-4 text-sm text-base-content/50">
						The charge record could not load; your Badges above are unaffected.
					</p>
				) : months === null ? (
					<p className="mt-4 text-sm text-base-content/50">Loading the charge record…</p>
				) : (
					<>
						<div className="mt-4 grid grid-cols-5 gap-2">
							{monthRows.map((month) => {
								const current = month.cycle === currentCycleKey();
								const noCharge = !month.hasCharge || Number(month.amount) === 0;
								return (
									<div
										key={month.cycle}
										aria-current={current ? "true" : undefined}
										title={`${monthLabel(month.cycle)}: ${
											noCharge
												? "no charge"
												: `${fmt(month.amount)}, ${month.state === "paid" ? "paid" : "estimated"}${
														Number(month.reduction) > 0
															? `, including ${fmt(month.reduction)} prorate credit`
															: ""
													}`
										}`}
										className={`rounded-xl border p-2 text-center ${
											current
												? "border-primary/50 bg-primary/5"
												: "border-base-content/10 bg-base-100/40"
										}`}
									>
										<p className="text-xs font-medium text-base-content/60">
											{shortMonth(month.cycle)}
										</p>
										<p className="text-[10px] text-base-content/35">{shortYear(month.cycle)}</p>
										<p
											className={`mt-1 text-lg font-semibold tabular-nums ${
												noCharge
													? "text-base-content/35"
													: month.state === "paid"
														? "text-success"
														: "text-primary"
											}`}
										>
											{noCharge ? "—" : fmt(month.amount)}
										</p>
										<span
											className={`badge badge-sm mt-1 ${
												noCharge
													? "badge-ghost text-base-content/40"
													: month.state === "paid"
														? "badge-success"
														: "badge-outline"
											}`}
										>
											{noCharge ? "No charge" : month.state === "paid" ? "Paid" : "Estimated"}
										</span>
										{Number(month.reduction) > 0 && (
											<p className="mt-1 text-[10px] text-success">
												−{fmt(month.reduction)} prorate
											</p>
										)}
										{current && (
											<p className="mt-1 text-[10px] font-medium text-primary">This month</p>
										)}
									</div>
								);
							})}
						</div>
						<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-base-content/45">
							<span>
								<span className="mr-1 inline-block h-2 w-2 rounded-full bg-success align-middle" />
								Paid is money already charged.
							</span>
							<span>
								<span className="mr-1 inline-block h-2 w-2 rounded-full border border-base-content/40 align-middle" />
								Estimated comes from your standing Badges.
							</span>
							<span>A prorate credit is the days before a Badge started.</span>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/*  Anthers' own details                                               */
/* ------------------------------------------------------------------ */

function AnthersBadgeDetails({
	account,
	badge,
	badgeView,
	anthersRungs,
	publicAccessPrice,
	isPaid,
	isCanceling,
	actionLoading,
	onBillingPortal,
	onCancel,
	onResume,
}: {
	account: Account;
	badge: Badge;
	badgeView: BadgeView;
	anthersRungs: { name: string; label: string; threshold: number; description: string }[];
	publicAccessPrice: number;
	isPaid: boolean;
	isCanceling: boolean;
	actionLoading: string | null;
	onBillingPortal: () => void;
	onCancel: () => void;
	onResume: () => void;
}) {
	const currentRung = anthersRungs.find((rung) => rung.name === badge);
	// The hover breakdown has to describe the amount this account actually gives, not the
	// bottom rung's. Free has no amount of its own, so the bottom rung stands in as the
	// illustration of what a first Badge buys.
	const splitBase = badgeView.price > 0 ? badgeView.price : publicAccessPrice;

	return (
		<div>
			<div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
				<p className="text-sm text-base-content/60">
					{isPaid ? (
						<>
							You give Anthers <strong>{fmt(badgeView.price)}/mo</strong> as{" "}
							{currentRung?.label ?? badgeView.name}.
							{isCanceling && <span className="text-error"> Reverts to Free at period end.</span>}
						</>
					) : (
						<>
							You're on <strong>Free</strong> at {fmt(badgeView.price)}/mo. A Badge changes how much
							of what you give Anthers funds the Time Pool and the programs.
						</>
					)}
				</p>
				<div className="flex flex-wrap items-center gap-2">
					{isCanceling ? (
						<button
							type="button"
							className={`btn btn-success btn-sm ${actionLoading === "resume" ? "btn-disabled" : ""}`}
							onClick={onResume}
							disabled={!!actionLoading}
						>
							{actionLoading === "resume" ? "Resuming…" : "Resume supporting"}
						</button>
					) : isPaid ? (
						<button
							type="button"
							className={`btn btn-outline btn-error btn-sm ${actionLoading === "cancel" ? "btn-disabled" : ""}`}
							onClick={onCancel}
							disabled={!!actionLoading}
						>
							{actionLoading === "cancel" ? "Stopping…" : "Stop supporting"}
						</button>
					) : null}
					{isPaid && (
						<button
							type="button"
							className={`btn btn-neutral btn-sm ${actionLoading === "portal" ? "btn-disabled" : ""}`}
							onClick={onBillingPortal}
							disabled={!!actionLoading}
						>
							{actionLoading === "portal" ? "Opening…" : "Manage Billing"}
						</button>
					)}
					<Link to="/signup" className="btn btn-primary btn-sm">
						{isPaid ? "Adjust support" : "Support Anthers"}
					</Link>
				</div>
			</div>

			<div
				className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-8 px-1.5 py-2"
				data-testid="badge-grid"
			>
				{anthersRungs.map((rung) => (
					<BadgeDetailCard
						key={rung.name}
						current={rung.name === badge}
						label={rung.label}
						threshold={rung.threshold}
						description={rung.description || null}
						mark={
							<AnthersBadgeMark
								badge={rung.name as IssuerBadge}
								lit={rung.name === badge}
								size="h-16 w-16"
							/>
						}
					/>
				))}
			</div>

			<div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4 border-t border-base-content/10 pt-4">
				<div>
					<div className="text-xs text-base-content/50 uppercase">Time Pool</div>
					<div className="text-lg font-bold text-success">{fmt(badgeView.timePool)}</div>
					<div className="text-[11px] text-base-content/40">to creators, by time</div>
				</div>
				<div>
					<div className="text-xs text-base-content/50 uppercase">
						Supports Anthers
						<InfoTip
							text={`What you give Anthers is split into named lines that add up to it: the Time Pool ($${timePoolByTimeFor(splitBase).toFixed(2)}, to creators by time), your Sticker budget ($${stickerBudgetFor(splitBase).toFixed(2)}, to creators you choose yourself, and paid out by time if you leave it unspent), your storage allowance ($${storageReserveFor(splitBase).toFixed(2)}, reserved at cost and poured into Anthers Support if you don't use it), and Anthers Support ($${supportLineFor(splitBase).toFixed(2)}, which funds the charitable programs, free access included). The card fee is inside the price. Downloads are unlimited and cost nothing, and $${publicAccessPrice} a month lifts the ${FREE_PUBLIC_ACCESS_HOURS}-hour monthly limit on Public Access.`}
						/>
					</div>
					<div className="text-lg font-bold">{fmt(badgeView.supportsAnthers)}</div>
					<div className="text-[11px] text-base-content/40">free access &amp; programs</div>
				</div>
				<div>
					<div className="text-xs text-base-content/50 uppercase">Public Access</div>
					<div className="text-lg font-bold">
						{badgeView.price >= publicAccessPrice
							? "Unlimited"
							: `${FREE_PUBLIC_ACCESS_HOURS} hrs/mo`}
					</div>
					<div className="text-[11px] text-base-content/40">
						downloads always free, with no allowance and no per-GiB charge
					</div>
				</div>
			</div>

			{account.currentPeriodEnd && (
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
	);
}

/* ------------------------------------------------------------------ */
/*  One creator's details                                              */
/* ------------------------------------------------------------------ */

function CreatorBadgeDetails({
	holding,
	ladder,
}: {
	holding: BadgeHolding;
	ladder: CreatorBadge[];
}) {
	const name = nameOf(holding);
	const rungs: CreatorBadge[] =
		ladder.length > 0
			? ladder
			: [
					{
						id: holding.id,
						creatorId: 0,
						threshold: holding.threshold,
						label: holding.label,
						description: holding.description,
						hasArt: holding.hasArt,
						hasComposedArt: holding.hasComposedArt,
						artShape: holding.artShape,
						artColor: holding.artColor,
						artEdgeColor: holding.artEdgeColor ?? null,
						sortOrder: 0,
						createdAt: holding.createdAt,
						updatedAt: holding.updatedAt,
					},
				];

	return (
		<div>
			<p className="text-sm text-base-content/60">
				{name} sets these Badges. Yours is the rung marked Current Badge; the rest are what changing
				your support would hold.
			</p>
			<div
				className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-8 px-1.5 py-2"
				data-testid="badge-detail-grid"
			>
				{rungs.map((rung, index) => (
					<BadgeDetailCard
						key={rung.id}
						current={rung.id === holding.id}
						label={rung.label}
						threshold={rung.threshold}
						description={rung.description}
						mark={
							<CreatorBadgeMark
								badgeId={rung.id}
								index={index}
								label={`${rung.label} badge`}
								art={rung}
								owners={rung.owners}
								size="h-16 w-16"
							/>
						}
					/>
				))}
			</div>
		</div>
	);
}
