// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type BadgeKey,
	badgeLabel,
	SEED_PRICE,
	seedCost,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { useMemo, useState } from "react";
import { CalcPageHeader, SegControl } from "../components/calculators/ui";

// ---------------------------------------------------------------------------
// Support-model economics. A viewer holds Anthers-Seeds — $3 each; the count is
// their rank (Root 1 … Blossom 4). Each Anthers-Seed's $3 splits into a Time Pool
// ($1.50, to creators by watch-time) and "Supports Anthers" (their bandwidth at
// cost + the Foundation remainder). Money to creators = the Time Pool + Seeds a
// viewer gives directly to a creator ($3 each, 100% to them). The Time Pool is
// distributed across the creators a viewer watches, in proportion to watch-time
// (equal-time principle — a minute is a minute across every medium). Bandwidth is
// folded into the Anthers-Seeds, at cost — never the creator-funding lever, so it
// never appears in these earnings figures.
//
// Rates/dials come from @anthers/shared/constants (SEED_PRICE, timePoolFor, …) —
// the same source of truth the API charges against.
// ---------------------------------------------------------------------------

/** Ordered rungs low → high; the paid Badges drive the personas/matrix. */
const PLANS: BadgeKey[] = ["free", "root", "sprout", "petal", "blossom"];
const PAID_PLANS: BadgeKey[] = ["root", "sprout", "petal", "blossom"];

const timePoolOf = (badge: BadgeKey) => timePoolFor(thresholdForBadge(badge));
/** A loose illustrative cap on directable creator-Seeds by rank (Seeds are independent). */
const seedsOf = (badge: BadgeKey) => thresholdForBadge(badge);
/** "Supports Anthers" — the non-Time-Pool half of each Anthers-Seed (bandwidth + Foundation). */
const supportsAnthersOf = (badge: BadgeKey) =>
	Math.max(0, seedCost(thresholdForBadge(badge)) - timePoolFor(thresholdForBadge(badge)));

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usd0 = (n: number) =>
	(n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const usd2 = (n: number) =>
	(n < 0 ? "−$" : "$") +
	Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function rate(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (n >= 1)
		return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	if (n >= 0.1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(4)}`;
}
const cnt = (n: number) => Math.round(n).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Section 1 — the conversion engine (one viewer)
// ---------------------------------------------------------------------------

function ConversionEngine() {
	const [badge, setBadge] = useState<BadgeKey>("sprout");
	const [total, setTotal] = useState(20);
	const [you, setYou] = useState(8);
	const [seedsToYou, setSeedsToYou] = useState(1);

	const m = useMemo(() => {
		const safeTotal = total > 0 ? total : 0.0001;
		const youCapped = Math.min(you, safeTotal);
		const planSeeds = seedsOf(badge);
		const directedSeeds = Math.min(seedsToYou, planSeeds);

		const tp = timePoolOf(badge);
		const seeds = planSeeds * SEED_PRICE;
		const supportsAnthers = supportsAnthersOf(badge);
		const price = seedCost(thresholdForBadge(badge));

		const share = youCapped / safeTotal;
		const tpEarn = share * tp;
		const seedEarn = directedSeeds * SEED_PRICE;
		const earn = tpEarn + seedEarn;

		const perHour = tp / safeTotal; // Time Pool value of a view-hour

		return {
			youCapped,
			directedSeeds,
			planSeeds,
			tp,
			seeds,
			supportsAnthers,
			price,
			share,
			tpEarn,
			seedEarn,
			earn,
			perHour,
			toCreators: tp + seeds,
		};
	}, [badge, total, you, seedsToYou]);

	// Split bar over what the viewer's Anthers-Seeds cost them (their own at-cost
	// bandwidth is folded into the "Supports Anthers" slice, not broken out here).
	const seg = [
		{ label: "Time Pool", note: "to creators", v: m.tp, color: "#34d399" },
		{
			label: "Supports Anthers",
			note: "at cost + programs",
			v: m.supportsAnthers,
			color: "#a78bfa",
		},
	];

	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 sm:p-6">
				<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					1 · The conversion engine — one viewer
				</h2>
				<p className="text-sm text-base-content/60 max-w-2xl mb-2">
					Pick the Badge a viewer chose, then how they spend their month. Their Time Pool is split
					across everyone they watch, by time; your slice of their watch-time — plus any Seeds they
					direct to you — is what you take home from them. Anthers is a non-profit—no profit-taking.
				</p>

				<div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
					{/* Inputs */}
					<div className="space-y-5">
						<div>
							<div className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
								<span>Viewer's Badge</span>
								<span className="font-mono text-sm">
									{usd0(m.price)}
									<span className="text-base-content/40">/mo</span>
								</span>
							</div>
							<SegControl
								ariaLabel="Viewer's Badge"
								value={badge}
								onChange={setBadge}
								options={PLANS.map((b) => ({ value: b, label: badgeLabel(b) }))}
							/>
							<div className="flex justify-between font-mono text-[10px] text-base-content/40 mt-1.5">
								<span>{usd2(m.tp)} Time Pool</span>
								<span>{m.planSeeds} Seeds</span>
							</div>
						</div>
						<label className="block">
							<span className="block text-sm text-base-content/70 mb-2">
								Their total watch-time / month
							</span>
							<div className="flex items-center gap-2">
								<input
									type="number"
									min={0.1}
									step={1}
									value={total}
									onChange={(e) => setTotal(Math.max(0, Number(e.target.value) || 0))}
									className="input input-bordered input-sm w-full font-mono tabular-nums text-right"
								/>
								<span className="text-base-content/40 text-xs w-8">hrs</span>
							</div>
						</label>
						<label className="block">
							<span className="block text-sm text-base-content/70 mb-2">
								Of that, time with <b className="text-base-content">you</b>
							</span>
							<div className="flex items-center gap-2">
								<input
									type="number"
									min={0}
									step={0.5}
									value={you}
									onChange={(e) => setYou(Math.max(0, Number(e.target.value) || 0))}
									className="input input-bordered input-sm w-full font-mono tabular-nums text-right"
								/>
								<span className="text-base-content/40 text-xs w-8">hrs</span>
							</div>
							{you > total && (
								<p className="text-error text-xs mt-1">
									Time with you can't exceed their total — capped at {total} hrs.
								</p>
							)}
						</label>
						<label className="block">
							<span className="block text-sm text-base-content/70 mb-2">Seeds directed to you</span>
							<div className="flex items-center gap-2">
								<input
									type="number"
									min={0}
									step={1}
									value={seedsToYou}
									onChange={(e) => setSeedsToYou(Math.max(0, Number(e.target.value) || 0))}
									className="input input-bordered input-sm w-full font-mono tabular-nums text-right"
								/>
								<span className="text-base-content/40 text-xs w-8">× $1</span>
							</div>
							<p className="text-base-content/40 text-xs mt-1">
								{m.planSeeds === 0
									? "The Free plan includes no Seeds."
									: `Their plan includes ${m.planSeeds} Seed${m.planSeeds === 1 ? "" : "s"} — capped there (${m.directedSeeds} to you).`}
							</p>
						</label>
					</div>

					{/* Readout */}
					<div className="space-y-4">
						<div className="grid grid-cols-2 gap-3">
							<div className="rounded-xl bg-success/10 p-4">
								<p className="text-xs uppercase tracking-wide text-base-content/50">
									Their Time Pool
								</p>
								<p className="mt-1 font-mono text-2xl font-bold tabular-nums text-success leading-none">
									{usd2(m.tp)}
								</p>
								<p className="mt-1.5 text-xs text-base-content/50">
									plan <span className="font-semibold text-success">{badgeLabel(badge)}</span> ·{" "}
									{m.planSeeds} Seeds
								</p>
							</div>
							<div className="rounded-xl bg-base-200 p-4">
								<p className="text-xs uppercase tracking-wide text-base-content/50">
									Value / view-hour
								</p>
								<p className="mt-1 font-mono text-2xl font-bold tabular-nums leading-none">
									{rate(m.perHour)}
									<span className="ml-1 text-sm font-medium text-base-content/50">/hr</span>
								</p>
								<p className="mt-1.5 text-xs text-base-content/50">
									Time Pool basis — Seeds stack on top
								</p>
							</div>
							<div className="rounded-xl bg-base-200 p-4">
								<p className="text-xs uppercase tracking-wide text-base-content/50">
									Your share of their time
								</p>
								<p className="mt-1 font-mono text-2xl font-bold tabular-nums leading-none">
									{(m.share * 100).toFixed(m.share < 0.1 ? 1 : 0)}
									<span className="ml-1 text-sm font-medium text-base-content/50">%</span>
								</p>
								<p className="mt-1.5 text-xs text-base-content/50">
									{+m.youCapped.toFixed(2)} of {+total.toFixed(2)} hrs
								</p>
							</div>
							<div className="rounded-xl bg-warning/10 p-4">
								<p className="text-xs uppercase tracking-wide text-base-content/50">
									You earn from them
								</p>
								<p className="mt-1 font-mono text-2xl font-bold tabular-nums text-warning leading-none">
									{usd2(m.earn)}
								</p>
								<p className="mt-1.5 text-xs text-base-content/50">
									{usd2(m.tpEarn)} time + {usd2(m.seedEarn)} seeds / mo
								</p>
							</div>
						</div>

						{/* Split bar */}
						<div>
							<div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-base-content/40 mb-1.5">
								<span>where their Seeds go</span>
								<span>
									{usd2(m.price)}/mo · {usd2(m.toCreators)} to creators
								</span>
							</div>
							<div className="flex h-8 rounded-lg overflow-hidden border border-base-300">
								{seg.map((s) => {
									const w = m.price > 0 ? (s.v / m.price) * 100 : 0;
									return (
										<div
											key={s.label}
											className="flex items-center justify-center text-[11px] font-mono text-white/95 transition-[width] duration-300 overflow-hidden whitespace-nowrap"
											style={{ width: `${w}%`, background: s.color }}
											title={`${s.label} (${s.note}) — ${usd2(s.v)}`}
										>
											{w > 14 ? usd2(s.v) : ""}
										</div>
									);
								})}
							</div>
							<div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-base-content/60">
								{seg.map((s) => (
									<span key={s.label} className="inline-flex items-center gap-1.5">
										<i
											className="inline-block w-2.5 h-2.5 rounded-sm"
											style={{ background: s.color }}
										/>
										{s.label} <span className="text-base-content/40">({s.note})</span>
									</span>
								))}
							</div>
							<p className="mt-2 text-[11px] text-base-content/40">
								Bandwidth is folded into each Seed given to Anthers at cost (a free floor + per-Seed
								allowance, $0.01/GiB) — no wallet, and never a creator-funding lever.
							</p>
						</div>

						<div className="text-sm text-base-content/80 bg-success/10 rounded-lg p-3.5 leading-relaxed">
							This viewer chose the <b className="text-success">{badgeLabel(badge)}</b> plan (
							{usd2(m.price)}/mo). Of that, <b>{usd2(m.toCreators)}</b> reaches creators (
							{usd2(m.tp)} Time Pool + {usd2(m.seeds)} Seeds); Anthers keeps <b>$0</b>. You hold{" "}
							<b>{(m.share * 100).toFixed(m.share < 0.1 ? 1 : 0)}%</b> of their {+total.toFixed(2)}{" "}
							hrs, so you earn <b>{usd2(m.earn)}/mo</b> from them.
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section 2 — what a view-hour is worth (dispersion matrix)
// ---------------------------------------------------------------------------

function ValueMatrix() {
	const [cols, setCols] = useState([
		{ lab: "Light", h: 5 },
		{ lab: "Casual", h: 15 },
		{ lab: "Heavy", h: 40 },
		{ lab: "Extreme", h: 80 },
	]);

	const { rows, lo, hi, loCell, hiCell } = useMemo(() => {
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		let loCell = "";
		let hiCell = "";
		const rows = PAID_PLANS.map((badge) => {
			const tp = timePoolOf(badge);
			const cells = cols.map((c) => {
				const h = c.h > 0 ? c.h : 0.0001;
				const v = tp / h;
				if (v < lo) {
					lo = v;
					loCell = `${badgeLabel(badge)} fan watching ${c.h} hrs`;
				}
				if (v > hi) {
					hi = v;
					hiCell = `${badgeLabel(badge)} fan watching ${c.h} hrs`;
				}
				return v;
			});
			return { name: badgeLabel(badge), tp, cells };
		});
		return { rows, lo, hi, loCell, hiCell };
	}, [cols]);

	const lnLo = Math.log(lo);
	const lnHi = Math.log(hi);
	const span = lnHi - lnLo || 1;
	const heat = (v: number) => {
		const a = 0.05 + 0.78 * ((Math.log(v) - lnLo) / span);
		return `rgba(52, 211, 153, ${a.toFixed(3)})`;
	};
	const ratio = hi / lo;

	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 sm:p-6">
				<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					2 · What a view-hour is worth
				</h2>
				<p className="text-sm text-base-content/60 max-w-2xl mb-3">
					The same hour of content pays wildly different amounts depending on who's watching. Each
					cell is <b className="text-base-content">$ per view-hour</b> = that viewer's Time Pool ÷
					their total monthly watch-time. Rows are the paid Badges; edit the consumption columns to
					explore.
				</p>
				<div className="overflow-x-auto">
					<table className="w-full text-sm border-collapse">
						<thead>
							<tr>
								<th className="text-left font-semibold p-2.5 border-b border-base-content/20">
									Plan · Time Pool
								</th>
								{cols.map((c, i) => (
									<th
										key={c.lab}
										className="text-right p-2.5 border-b border-base-content/20 font-mono"
									>
										<span className="block text-[10px] uppercase tracking-wide text-base-content/40 font-sans mb-1">
											{c.lab}
										</span>
										<input
											type="number"
											min={0.1}
											step={1}
											value={c.h}
											onChange={(e) => {
												const h = Number(e.target.value) || 0;
												setCols((prev) => prev.map((x, xi) => (xi === i ? { ...x, h } : x)));
											}}
											className="input input-xs w-16 text-right font-mono tabular-nums"
										/>{" "}
										<span className="text-xs text-base-content/40">hrs</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.name}>
									<th className="text-left font-semibold p-2.5 border-r border-base-300">
										{r.name}
										<span className="block text-[11px] font-normal font-mono text-base-content/40">
											{usd2(r.tp)} pool
										</span>
									</th>
									{r.cells.map((v, ci) => (
										<td
											key={cols[ci].lab}
											className="text-right p-2.5 font-mono tabular-nums rounded"
											style={{ background: heat(v) }}
										>
											{rate(v)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="mt-4 text-sm text-base-content/60 bg-base-200 rounded-lg border border-dashed border-base-300 px-3.5 py-3">
					Spread: the most valuable hour here (<b className="text-base-content">{hiCell}</b>,{" "}
					<span className="font-mono text-success">{rate(hi)}/hr</span>) is worth{" "}
					<b className="text-base-content">
						{ratio.toLocaleString("en-US", { maximumFractionDigits: 0 })}×
					</b>{" "}
					the least (<b className="text-base-content">{loCell}</b>,{" "}
					<span className="font-mono text-success">{rate(lo)}/hr</span>). Same content, same minute
					— the difference is entirely who's watching and how much else they watch. Seeds stack on
					top.
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section 3 — a creator's monthly revenue (audience segments)
// ---------------------------------------------------------------------------

interface Segment {
	id: number;
	name: string;
	subs: number;
	badge: BadgeKey;
	total: number;
	you: number;
	seedsToYou: number;
}

const SEG_DEFAULTS: Omit<Segment, "id">[] = [
	{ name: "Superfans", subs: 50, badge: "blossom", total: 15, you: 9, seedsToYou: 3 },
	{ name: "Core fans", subs: 200, badge: "petal", total: 20, you: 8, seedsToYou: 1 },
	{ name: "Regulars", subs: 800, badge: "sprout", total: 25, you: 4, seedsToYou: 0 },
	{ name: "Casual", subs: 2000, badge: "root", total: 30, you: 1.5, seedsToYou: 0 },
];

let segCounter = 0;
const makeSegments = (): Segment[] => SEG_DEFAULTS.map((s) => ({ id: ++segCounter, ...s }));

function AudienceBuilder() {
	const [segments, setSegments] = useState<Segment[]>(makeSegments);

	const totals = useMemo(() => {
		let rev = 0;
		let tpRev = 0;
		let seedRev = 0;
		let subs = 0;
		let capHrs = 0;
		const rows = segments.map((s) => {
			const total = s.total > 0 ? s.total : 0.0001;
			const you = Math.min(s.you, total);
			const tp = timePoolOf(s.badge);
			const directedSeeds = Math.min(s.seedsToYou, seedsOf(s.badge));
			const share = you / total;
			const tpPerSub = share * tp;
			const seedPerSub = directedSeeds * SEED_PRICE;
			const perSub = tpPerSub + seedPerSub;
			const segRev = perSub * s.subs;
			rev += segRev;
			tpRev += tpPerSub * s.subs;
			seedRev += seedPerSub * s.subs;
			subs += s.subs;
			capHrs += you * s.subs;
			return { ...s, tp, directedSeeds, share, perSub, segRev };
		});
		return { rows, rev, tpRev, seedRev, subs, capHrs };
	}, [segments]);

	const effRate = totals.capHrs > 0 ? totals.rev / totals.capHrs : 0;
	const capMin = totals.capHrs * 60;
	const rpm = capMin > 0 ? (totals.rev / capMin) * 1000 : 0;

	const update = (id: number, field: keyof Segment, value: string) => {
		setSegments((prev) =>
			prev.map((s) =>
				s.id === id
					? {
							...s,
							[field]:
								field === "name"
									? value
									: field === "badge"
										? (value as BadgeKey)
										: Number.parseFloat(value) || 0,
						}
					: s,
			),
		);
	};

	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 sm:p-6">
				<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					3 · A creator's monthly revenue
				</h2>
				<p className="text-sm text-base-content/60 max-w-2xl mb-3">
					Build an audience from segments. For each, set the subscriber count, the Badge they chose,
					total monthly watch-time, hours spent with you, and any Seeds they direct to you. Revenue
					per subscriber = (your share of their time × their Time Pool) + directed Seeds.
				</p>

				<div className="overflow-x-auto">
					<table className="w-full text-sm border-collapse font-mono tabular-nums">
						<thead>
							<tr className="text-[10px] uppercase tracking-wide text-base-content/50 border-b border-base-content/20">
								<th className="text-left p-2 font-sans">Segment</th>
								<th className="text-right p-2">Subs</th>
								<th className="text-right p-2">Plan</th>
								<th className="text-right p-2">Total hrs</th>
								<th className="text-right p-2">Hrs of you</th>
								<th className="text-right p-2">Seeds→you</th>
								<th className="text-right p-2 border-l border-base-300 text-success">Time Pool</th>
								<th className="text-right p-2">Your share</th>
								<th className="text-right p-2">$ / sub</th>
								<th className="text-right p-2 text-warning">Revenue / mo</th>
								<th className="p-2" />
							</tr>
						</thead>
						<tbody>
							{totals.rows.map((r) => (
								<tr key={r.id} className="border-b border-base-300/60">
									<td className="p-1.5">
										<input
											value={r.name}
											onChange={(e) => update(r.id, "name", e.target.value)}
											className="input input-xs w-24 font-sans font-semibold"
										/>
									</td>
									<td className="p-1.5 text-right">
										<input
											type="number"
											min={0}
											step={10}
											value={r.subs}
											onChange={(e) => update(r.id, "subs", e.target.value)}
											className="input input-xs w-16 text-right font-mono"
										/>
									</td>
									<td className="p-1.5 text-right">
										<select
											value={r.badge}
											onChange={(e) => update(r.id, "badge", e.target.value)}
											className="select select-xs w-24 font-sans"
										>
											{PAID_PLANS.map((b) => (
												<option key={b} value={b}>
													{badgeLabel(b)}
												</option>
											))}
										</select>
									</td>
									<td className="p-1.5 text-right">
										<input
											type="number"
											min={0.1}
											step={1}
											value={r.total}
											onChange={(e) => update(r.id, "total", e.target.value)}
											className="input input-xs w-14 text-right font-mono"
										/>
									</td>
									<td className="p-1.5 text-right">
										<input
											type="number"
											min={0}
											step={0.5}
											value={r.you}
											onChange={(e) => update(r.id, "you", e.target.value)}
											className="input input-xs w-14 text-right font-mono"
										/>
									</td>
									<td className="p-1.5 text-right">
										<input
											type="number"
											min={0}
											step={1}
											value={r.seedsToYou}
											onChange={(e) => update(r.id, "seedsToYou", e.target.value)}
											className="input input-xs w-14 text-right font-mono"
										/>
									</td>
									<td className="p-2 text-right text-base-content/60 border-l border-base-300">
										{usd2(r.tp)}
									</td>
									<td className="p-2 text-right text-base-content/60">
										{(r.share * 100).toFixed(r.share < 0.1 ? 1 : 0)}%
									</td>
									<td className="p-2 text-right text-base-content/60">{usd2(r.perSub)}</td>
									<td className="p-2 text-right text-warning font-bold">{usd2(r.segRev)}</td>
									<td className="p-1.5 text-center">
										<button
											type="button"
											onClick={() => setSegments((prev) => prev.filter((s) => s.id !== r.id))}
											className="btn btn-ghost btn-xs text-base-content/40 hover:text-error"
											aria-label={`Remove ${r.name}`}
										>
											✕
										</button>
									</td>
								</tr>
							))}
						</tbody>
						<tfoot>
							<tr className="border-t border-base-content/20 font-bold">
								<td className="p-2 font-sans">Total</td>
								<td className="p-2 text-right">{cnt(totals.subs)}</td>
								<td colSpan={2} />
								<td className="p-2 text-right">{cnt(totals.capHrs)} hrs</td>
								<td className="p-2 text-right border-l border-base-300" colSpan={4} />
								<td className="p-2 text-right text-warning">{usd2(totals.rev)}</td>
								<td />
							</tr>
						</tfoot>
					</table>
				</div>

				<div className="mt-3">
					<button
						type="button"
						className="btn btn-sm btn-outline"
						onClick={() =>
							setSegments((prev) => [
								...prev,
								{
									id: ++segCounter,
									name: "New segment",
									subs: 100,
									badge: "sprout",
									total: 20,
									you: 3,
									seedsToYou: 0,
								},
							])
						}
					>
						+ Add segment
					</button>
				</div>

				{/* Headline numbers */}
				<div className="flex flex-wrap gap-3 mt-5">
					<div className="flex-1 min-w-[180px] rounded-xl bg-warning/10 p-4">
						<p className="text-xs uppercase tracking-wide text-base-content/50">Monthly revenue</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums text-warning">
							{usd2(totals.rev)}
						</p>
						<p className="mt-1 text-xs text-base-content/50">
							{usd0(totals.rev * 12)}/yr · {usd2(totals.tpRev)} time + {usd2(totals.seedRev)} seeds
						</p>
					</div>
					<div className="flex-1 min-w-[180px] rounded-xl bg-success/10 p-4">
						<p className="text-xs uppercase tracking-wide text-base-content/50">Effective rate</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums text-success">
							{rate(effRate)}
							<span className="ml-1 text-sm font-medium text-base-content/50">/hr</span>
						</p>
						<p className="mt-1 text-xs text-base-content/50">per view-hour, blended</p>
					</div>
					<div className="flex-1 min-w-[180px] rounded-xl bg-base-200 p-4">
						<p className="text-xs uppercase tracking-wide text-base-content/50">
							Captured watch-time
						</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums">
							{cnt(totals.capHrs)} hrs
						</p>
						<p className="mt-1 text-xs text-base-content/50">{cnt(capMin)} view-minutes / mo</p>
					</div>
					<div className="flex-1 min-w-[180px] rounded-xl bg-base-200 p-4">
						<p className="text-xs uppercase tracking-wide text-base-content/50">
							Per 1,000 view-minutes
						</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums">{usd2(rpm)}</p>
						<p className="mt-1 text-xs text-base-content/50">the model's answer to "RPM"</p>
					</div>
				</div>

				<div className="mt-4 flex justify-end">
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={() => {
							segCounter = 0;
							setSegments(makeSegments());
						}}
					>
						Reset to defaults
					</button>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CreatorMonetizationCalculatorPage() {
	return (
		<div className="max-w-5xl mx-auto px-4 pb-16">
			<Reveal>
				<CalcPageHeader
					eyebrow="Time Pool · watch-time → revenue"
					title="How watch-time becomes creator revenue"
					lede={
						<>
							On Anthers, a viewer's <b className="text-base-content">Time Pool</b> — set by the
							Badge they chose — is split across every creator they engage with,{" "}
							<b className="text-base-content">proportionally by time</b> — a minute is a minute,
							whether it's video, audio, reading, or play. So a view-minute isn't worth a fixed
							platform rate: it's worth a{" "}
							<b className="text-base-content">slice of that viewer's Time Pool</b>, plus any Seeds
							they direct your way. This tool traces that conversion, from one viewer up to a
							creator's monthly earnings.
						</>
					}
				/>
			</Reveal>

			<Reveal>
				<div className="collapse collapse-arrow bg-base-100 border border-base-300 mb-4">
					<input type="checkbox" />
					<div className="collapse-title text-sm font-medium text-base-content/70">
						What this models — and what it leaves out
					</div>
					<div className="collapse-content text-sm text-base-content/60 space-y-3">
						<div>
							<h4 className="font-semibold text-base-content/80 mb-1">
								The support-model mechanic
							</h4>
							<ul className="list-disc pl-5 space-y-1">
								<li>
									A viewer gives Anthers <b>Seeds</b> — a flat <b>$3 each</b> (their Badge, Root →
									Blossom). Each one's $3 splits into a <b>Time Pool</b> ($1.50, to creators by
									watch-time) and <b>Supports Anthers</b> (their bandwidth at cost + the Foundation
									remainder). Directed <b>Seeds</b> ($3 each, 100% to a creator) are given on top.
								</li>
								<li>
									Their <b>Time Pool</b> is divided among the creators they watch{" "}
									<b>in proportion to time spent</b>. A creator who holds <code>s</code> = (their
									minutes ÷ the viewer's total minutes) earns <code>s × Time Pool</code> from that
									viewer, plus any Seeds the viewer directs to them.
								</li>
								<li>
									<b>Equal-time principle:</b> a minute counts the same across all media types.
									Delivery cost differs by medium, but that's billed on the viewer's side (a folded
									into their Seeds to Anthers, at cost) and never touches the creator share.
								</li>
								<li>
									The <b>Badge</b> is a chosen point-in-time plan, not a rolling spend total.
								</li>
							</ul>
						</div>
						<div>
							<h4 className="font-semibold text-base-content/80 mb-1">What it leaves out</h4>
							<ul className="list-disc pl-5 space-y-1">
								<li>
									The audience builder counts just the Seeds each segment directs to you. One-time /
									direct purchases and creator <b>storage</b> costs are out of scope — see the
									companion storage &amp; bandwidth calculators.
								</li>
								<li>
									Rates from the support model (<code>@anthers/shared</code>). Planning model —
									approximate, not for invoicing.
								</li>
							</ul>
						</div>
					</div>
				</div>
			</Reveal>

			<div className="space-y-4">
				<Reveal>
					<ConversionEngine />
				</Reveal>
				<Reveal>
					<ValueMatrix />
				</Reveal>
				<Reveal>
					<AudienceBuilder />
				</Reveal>
			</div>
		</div>
	);
}
