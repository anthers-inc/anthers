// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { CalcPageHeader } from "../components/calculators/ui";

// ---------------------------------------------------------------------------
// V3 economics (spec §2–4). A viewer prepays two independent purchases:
//   • Usage — per GiB, all-in $0.03/GiB = $0.01 bandwidth (at cost)
//     + $0.005 Anthers Foundation fee (charity) + $0.015 Time Pool (to creators)
//   • Boost — $1 units, 100% to creators (no fee, no processing cut)
// Money to creators = Time Pool + Boost. The Time Pool is distributed across the
// creators a viewer watches, in proportion to watch-time (equal-time principle).
// The rolling Anthers Badge is earned from combined spend (usage$ + boost$).
// ---------------------------------------------------------------------------

const TIME_POOL_PER_GIB = 0.015;
const BANDWIDTH_PER_GIB = 0.01;
const AFF_PER_GIB = 0.005;
const USAGE_PRICE_PER_GIB = BANDWIDTH_PER_GIB + AFF_PER_GIB + TIME_POOL_PER_GIB; // 0.03

const timePool = (usageGib: number) => usageGib * TIME_POOL_PER_GIB;
const usageCost = (usageGib: number) => usageGib * USAGE_PRICE_PER_GIB;

function badgeOf(combinedSpend: number): string {
	if (combinedSpend >= 30) return "Blossom";
	if (combinedSpend >= 15) return "Petal";
	if (combinedSpend >= 7) return "Sprout";
	if (combinedSpend >= 3) return "Root";
	return "—";
}

/** Reference personas: usage level (GiB) that lands each badge at $0 boost. */
const BADGES: { name: string; usageGib: number }[] = [
	{ name: "Root", usageGib: 100 },
	{ name: "Sprout", usageGib: 200 },
	{ name: "Petal", usageGib: 300 },
	{ name: "Blossom", usageGib: 400 },
];

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
	const [usageGib, setUsageGib] = useState(300);
	const [boost, setBoost] = useState(6);
	const [total, setTotal] = useState(20);
	const [you, setYou] = useState(8);
	const [boostToYou, setBoostToYou] = useState(2);

	const m = useMemo(() => {
		const safeTotal = total > 0 ? total : 0.0001;
		const youCapped = Math.min(you, safeTotal);
		const directed = Math.min(boostToYou, boost);
		const undirected = boost - directed;

		const tp = timePool(usageGib);
		const usage$ = usageCost(usageGib);
		const combined = usage$ + boost;
		const badge = badgeOf(combined);

		const share = youCapped / safeTotal;
		const tpEarn = share * tp;
		const boostEarn = directed + share * undirected;
		const earn = tpEarn + boostEarn;

		const perHour = tp / safeTotal; // Time Pool value of a view-hour

		return {
			youCapped,
			directed,
			tp,
			usage$,
			combined,
			badge,
			share,
			tpEarn,
			boostEarn,
			earn,
			perHour,
			toCreators: tp + boost,
			bandwidth: usageGib * BANDWIDTH_PER_GIB,
			aff: usageGib * AFF_PER_GIB,
		};
	}, [usageGib, boost, total, you, boostToYou]);

	// Split bar over the viewer's whole monthly spend.
	const spend = m.usage$ + boost;
	const seg = [
		{ label: "Bandwidth", note: "at cost", v: m.bandwidth, color: "#64748b" },
		{ label: "AF Fee", note: "charity", v: m.aff, color: "#a78bfa" },
		{ label: "Time Pool", note: "to creators", v: m.tp, color: "#34d399" },
		{ label: "Boost", note: "to creators", v: boost, color: "#22d3ee" },
	];

	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 sm:p-6">
				<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					1 · The conversion engine — one viewer
				</h2>
				<p className="text-sm text-base-content/60 max-w-2xl mb-2">
					Set a viewer's Usage and Boost and how they spend their month. Their Time Pool (funded by
					Usage) is split across everyone they watch, by time; your slice of their watch-time — plus
					any Boost they direct to you — is what you take home from them.
				</p>

				<div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
					{/* Inputs */}
					<div className="space-y-5">
						<div>
							<div className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
								<span>Viewer monthly Usage</span>
								<span className="font-mono text-sm">
									{usageGib} GiB <span className="text-base-content/40">· {usd2(m.usage$)}</span>
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={600}
								step={10}
								value={usageGib}
								onChange={(e) => setUsageGib(Number(e.target.value))}
								className="range range-sm range-success w-full"
							/>
							<div className="flex justify-between font-mono text-[10px] text-base-content/40 mt-1">
								<span>100 Root</span>
								<span>200 Sprout</span>
								<span>300 Petal</span>
								<span>400 Blossom</span>
							</div>
						</div>
						<label className="block">
							<span className="block text-sm text-base-content/70 mb-2">Viewer monthly Boost</span>
							<div className="flex items-center gap-2">
								<span className="text-base-content/40 font-mono">$</span>
								<input
									type="number"
									min={0}
									step={1}
									value={boost}
									onChange={(e) => setBoost(Math.max(0, Number(e.target.value) || 0))}
									className="input input-bordered input-sm w-full font-mono tabular-nums text-right"
								/>
							</div>
						</label>
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
							<span className="block text-sm text-base-content/70 mb-2">Boost directed to you</span>
							<div className="flex items-center gap-2">
								<span className="text-base-content/40 font-mono">$</span>
								<input
									type="number"
									min={0}
									step={1}
									value={boostToYou}
									onChange={(e) => setBoostToYou(Math.max(0, Number(e.target.value) || 0))}
									className="input input-bordered input-sm w-full font-mono tabular-nums text-right"
								/>
							</div>
							<p className="text-base-content/40 text-xs mt-1">
								Rest of their boost ({usd2(boost - m.directed)}) is undirected — it flows by
								watch-time.
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
									{usageGib} GiB × $0.015 · badge{" "}
									<span className="font-semibold text-success">{m.badge}</span>
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
									Time Pool basis — Boost stacks on top
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
									{usd2(m.tpEarn)} time + {usd2(m.boostEarn)} boost / mo
								</p>
							</div>
						</div>

						{/* Split bar */}
						<div>
							<div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-base-content/40 mb-1.5">
								<span>where their monthly spend goes</span>
								<span>
									{usd2(spend)}/mo · {usd2(m.toCreators)} to creators
								</span>
							</div>
							<div className="flex h-8 rounded-lg overflow-hidden border border-base-300">
								{seg.map((s) => {
									const w = spend > 0 ? (s.v / spend) * 100 : 0;
									return (
										<div
											key={s.label}
											className="flex items-center justify-center text-[11px] font-mono text-white/95 transition-[width] duration-300 overflow-hidden whitespace-nowrap"
											style={{ width: `${w}%`, background: s.color }}
											title={`${s.label} (${s.note}) — ${usd2(s.v)}`}
										>
											{w > 12 ? usd2(s.v) : ""}
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
						</div>

						<div className="text-sm text-base-content/80 bg-success/10 rounded-lg p-3.5 leading-relaxed">
							This viewer spends <b>{usd2(spend)}/mo</b> ({usageGib} GiB Usage + {usd2(boost)}{" "}
							Boost) → <b className="text-success">{m.badge}</b> badge. Of that,{" "}
							<b>{usd2(m.toCreators)}</b> reaches creators ({usd2(m.tp)} Time Pool + {usd2(boost)}{" "}
							Boost); Anthers keeps <b>$0</b>. You hold{" "}
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
		const rows = BADGES.map((b) => {
			const tp = timePool(b.usageGib);
			const cells = cols.map((c) => {
				const h = c.h > 0 ? c.h : 0.0001;
				const v = tp / h;
				if (v < lo) {
					lo = v;
					loCell = `${b.name} funder watching ${c.h} hrs`;
				}
				if (v > hi) {
					hi = v;
					hiCell = `${b.name} funder watching ${c.h} hrs`;
				}
				return v;
			});
			return { name: b.name, usageGib: b.usageGib, tp, cells };
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
					their total monthly watch-time. Rows are badge personas; edit the consumption columns to
					explore.
				</p>
				<div className="overflow-x-auto">
					<table className="w-full text-sm border-collapse">
						<thead>
							<tr>
								<th className="text-left font-semibold p-2.5 border-b border-base-content/20">
									Badge · Time Pool
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
											{r.usageGib} GiB → {usd2(r.tp)}
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
					— the difference is entirely who's watching and how much else they watch.
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
	usageGib: number;
	total: number;
	you: number;
	boostToYou: number;
}

const SEG_DEFAULTS: Omit<Segment, "id">[] = [
	{ name: "Superfans", subs: 50, usageGib: 400, total: 15, you: 9, boostToYou: 3 },
	{ name: "Core fans", subs: 200, usageGib: 300, total: 20, you: 8, boostToYou: 1 },
	{ name: "Regulars", subs: 800, usageGib: 200, total: 25, you: 4, boostToYou: 0.25 },
	{ name: "Casual", subs: 2000, usageGib: 100, total: 30, you: 1.5, boostToYou: 0 },
];

let segCounter = 0;
const makeSegments = (): Segment[] => SEG_DEFAULTS.map((s) => ({ id: ++segCounter, ...s }));

function AudienceBuilder() {
	const [segments, setSegments] = useState<Segment[]>(makeSegments);

	const totals = useMemo(() => {
		let rev = 0;
		let tpRev = 0;
		let boostRev = 0;
		let subs = 0;
		let capHrs = 0;
		const rows = segments.map((s) => {
			const total = s.total > 0 ? s.total : 0.0001;
			const you = Math.min(s.you, total);
			const tp = timePool(s.usageGib);
			const share = you / total;
			const tpPerSub = share * tp;
			const perSub = tpPerSub + s.boostToYou;
			const segRev = perSub * s.subs;
			rev += segRev;
			tpRev += tpPerSub * s.subs;
			boostRev += s.boostToYou * s.subs;
			subs += s.subs;
			capHrs += you * s.subs;
			return { ...s, tp, share, perSub, segRev };
		});
		return { rows, rev, tpRev, boostRev, subs, capHrs };
	}, [segments]);

	const effRate = totals.capHrs > 0 ? totals.rev / totals.capHrs : 0;
	const capMin = totals.capHrs * 60;
	const rpm = capMin > 0 ? (totals.rev / capMin) * 1000 : 0;

	const update = (id: number, field: keyof Segment, value: string) => {
		setSegments((prev) =>
			prev.map((s) =>
				s.id === id
					? { ...s, [field]: field === "name" ? value : Number.parseFloat(value) || 0 }
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
					Build an audience from segments. For each, set the subscriber count, their Usage, total
					monthly watch-time, hours spent with you, and any Boost they direct to you. Revenue per
					subscriber = (your share of their time × their Time Pool) + directed Boost.
				</p>

				<div className="overflow-x-auto">
					<table className="w-full text-sm border-collapse font-mono tabular-nums">
						<thead>
							<tr className="text-[10px] uppercase tracking-wide text-base-content/50 border-b border-base-content/20">
								<th className="text-left p-2 font-sans">Segment</th>
								<th className="text-right p-2">Subs</th>
								<th className="text-right p-2">Usage GiB</th>
								<th className="text-right p-2">Total hrs</th>
								<th className="text-right p-2">Hrs of you</th>
								<th className="text-right p-2">Boost→you</th>
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
										<input
											type="number"
											min={0}
											step={10}
											value={r.usageGib}
											onChange={(e) => update(r.id, "usageGib", e.target.value)}
											className="input input-xs w-16 text-right font-mono"
										/>
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
											step={0.25}
											value={r.boostToYou}
											onChange={(e) => update(r.id, "boostToYou", e.target.value)}
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
									usageGib: 200,
									total: 20,
									you: 3,
									boostToYou: 0,
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
							{usd0(totals.rev * 12)}/yr · {usd2(totals.tpRev)} time + {usd2(totals.boostRev)} boost
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
			<CalcPageHeader
				eyebrow="Time Pool · watch-time → revenue"
				title="How watch-time becomes creator revenue"
				lede={
					<>
						On Anthers, a viewer's <b className="text-base-content">Time Pool</b> is split across
						every creator they engage with,{" "}
						<b className="text-base-content">proportionally by time</b> — a minute is a minute,
						whether it's video, audio, reading, or play. So a view-minute isn't worth a fixed
						platform rate: it's worth a{" "}
						<b className="text-base-content">slice of that viewer's Time Pool</b>, plus any Boost
						they direct your way. This tool traces that conversion, from one viewer up to a
						creator's monthly earnings.
					</>
				}
			/>

			<div className="collapse collapse-arrow bg-base-100 border border-base-300 mb-4">
				<input type="checkbox" />
				<div className="collapse-title text-sm font-medium text-base-content/70">
					What this models — and what it leaves out
				</div>
				<div className="collapse-content text-sm text-base-content/60 space-y-3">
					<div>
						<h4 className="font-semibold text-base-content/80 mb-1">The V3 mechanic</h4>
						<ul className="list-disc pl-5 space-y-1">
							<li>
								A viewer prepays two independent purchases: <b>Usage</b> (per GiB, all-in $0.03/GiB
								= $0.01 bandwidth at cost + $0.005 Anthers Foundation fee + $0.015 Time Pool) and{" "}
								<b>Boost</b> ($1 units, 100% to creators). Anthers keeps $0.
							</li>
							<li>
								Their <b>Time Pool</b> = Usage GiB × $0.015. It's divided among the creators they
								watch <b>in proportion to time spent</b>. A creator who holds <code>s</code> =
								(their minutes ÷ the viewer's total minutes) earns <code>s × Time Pool</code> from
								that viewer, plus any Boost the viewer directs to them.
							</li>
							<li>
								<b>Equal-time principle:</b> a minute counts the same across all media types.
								Delivery cost differs by medium, but that's billed on the viewer's side and never
								touches the creator share.
							</li>
							<li>
								The rolling <b>Anthers Badge</b> (Root $3 / Sprout $7 / Petal $15 / Blossom $30) is
								earned from combined spend (Usage $ + Boost $), not a chosen plan.
							</li>
						</ul>
					</div>
					<div>
						<h4 className="font-semibold text-base-content/80 mb-1">What it leaves out</h4>
						<ul className="list-disc pl-5 space-y-1">
							<li>
								Undirected Boost is modeled explicitly only in Section 1; the audience builder
								counts just the Boost each segment directs to you. One-time / direct purchases and
								creator <b>storage</b> costs are out of scope — see the companion storage &amp;
								bandwidth calculators.
							</li>
							<li>
								Formulas from the V3 Subscription Economics spec. Planning model — approximate, not
								for invoicing.
							</li>
						</ul>
					</div>
				</div>
			</div>

			<div className="space-y-4">
				<ConversionEngine />
				<ValueMatrix />
				<AudienceBuilder />
			</div>
		</div>
	);
}
