// SPDX-License-Identifier: Apache-2.0
//
// Resource: "Your media month" — the spend calculator, the user-facing flagship of
// the resources revamp, and the interactive form of the wiki's *What It Costs,
// Against What You Pay Now* (11.05): that page's five fixed cases become the
// reader's own month, built line by line, and it answers the two things a fixed
// table cannot — modeling a whole media life, and personalizing it. Then it
// re-points the same money on Anthers, computed exactly, and shows the parts it
// cannot compute as published gaps rather than estimates. When Anthers loses a
// line, the tool says so.
//
// The comparison is **exact against lower bound**: "your money today" carries
// "not published" wherever a platform does not disclose its per-user split (an
// unknown stated as an unknown — the gap is a finding, and it lives in the
// reader's own totals), against "the same money on Anthers", computed to the
// cent.
//
// The mapping, settled 2026-10-15: the Anthers side by default takes the Public
// Access price, everything past it is directed at the creators, and both sides
// are editable — the directed side follows the month until the reader edits it
// by hand. Purchases stay purchases: the same goods at the same price, with
// everything past the at-cost card line reaching the creator.
//
// The losing case is shown, not arranged away: a month of the free, ad-supported
// line alone pays nothing, and the tool states the loss plainly — the direction
// (ad-supported watching pays creators something) is known, the size is not, and
// both are said.
//
// All computation lives in `lib/media-month.ts` (tested against the decimal
// originals and the wiki's generated case rows); this file is the rendering.
// Rival prices, rates and published nulls come from the generated `RIVAL_SPEND`,
// never from a typed figure. The SPA never imports `fees.ts`; the float copies
// it reads were pinned by the economics tests to the money version.
//
// ⚠️ **Badges are subscription purchases** — the shared package's vocabulary
// rule (82.01) applies to every string on this page; a Badge is bought, like
// any other subscription, and the verb for paying it is "give".

import { ANTHERS_BADGES, badgeLabel, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { RIVAL_SPEND } from "@anthers/shared/figures";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { useMemo, useState } from "react";
import {
	CalcNotes,
	CalcPageHeader,
	NumberField,
	SegControl,
	StatCard,
} from "../components/calculators/ui";
import {
	cardFloor,
	computeMonth,
	crossover,
	type LineKey,
	type MediaMonth,
	money2,
	pct,
	type SpendLine,
	startLines,
} from "../lib/media-month";

// ─── Static labels and rival rows ──────────────────────────────────────────────

const LINE_TITLES: Record<LineKey, string> = {
	video: "A video subscription",
	music: "A music subscription",
	purchases: "Storefront purchases",
	direct: "Direct support",
	free: "The free, ad-supported month",
};

const LINE_ORDER: LineKey[] = ["video", "music", "purchases", "direct", "free"];

/** The marker a `null` split renders as — a finding, stated as one. */
const NOT_PUBLISHED = "not published";

function rival(key: "video" | "music" | "direct") {
	const r = RIVAL_SPEND.find((r) => r.key === key);
	if (!r) throw new Error(`RIVAL_SPEND lost its ${key} row`);
	return r;
}

/** The rival rows the subscription-type lines' price fields are labeled with — the platforms' own names. */
const LINE_RIVALS = {
	video: rival("video"),
	music: rival("music"),
	direct: rival("direct"),
};

/** The Anthers-side quick-pick: the Free rung (nothing given) plus the Badge ladder, read rather than typed. */
const RUNG_OPTIONS: { value: number; label: string }[] = [
	{ value: 0, label: "Free" },
	...ANTHERS_BADGES.map((b) => ({ value: b.threshold, label: badgeLabel(b.name) })),
].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);

/** The last time any rival row was checked against its source. */
const LAST_CHECKED = RIVAL_SPEND.map((r) => r.checkedOn).reduce((a, b) => (a > b ? a : b));

const sharePct = (s: number): string => `${Math.round(s * 1000) / 10}%`;

/**
 * What each `RIVAL_SPEND` row publishes, for the notes' figures table: the list
 * price where one exists, the published shares or cut where they exist, and
 * "not published" where they do not. Every number comes off the row itself.
 */
function publishedFacts(r: (typeof RIVAL_SPEND)[number]): string {
	const price = r.price > 0 ? `${money2(r.price)}/mo` : null;
	let share: string;
	if (r.creatorShare === null && r.platformCut === null) {
		share = NOT_PUBLISHED;
	} else if ("absorbsProcessing" in r && r.absorbsProcessing) {
		share = `${sharePct(r.creatorShare ?? 0)} to creators and ${sharePct(r.platformCut ?? 0)} to the platform, processing absorbed`;
	} else if ("perCreatorCharge" in r && r.perCreatorCharge) {
		share = `${sharePct(r.platformCut ?? 0)} platform fee, plus the card processing every pledge costs the creator`;
	} else {
		share = `${sharePct(r.platformCut ?? 0)} platform fee`;
	}
	return price ? `${price} · ${share}` : share;
}

// ─── The page ──────────────────────────────────────────────────────────────────

export default function MediaMonthCalculatorPage() {
	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade — see the
		// monetization calculator's page component for the full note.
		<div className="max-w-5xl min-w-0 w-full mx-auto px-4 pb-16">
			<CalcPageHeader
				eyebrow="For users · the spend calculator"
				title="Your media month"
				lede={
					<>
						You already pay for media — a video subscription, a music subscription, items bought
						outright, maybe pledges to people by name, maybe nothing at all. Build your month below;
						the tool asks two questions of it: what does the month cost, and how much of it reaches
						the people who made the things? Then it re-points the same money on Anthers, computed
						exactly, and shows the parts it cannot compute as published gaps rather than estimates.
						When Anthers loses a line, the tool says so.
					</>
				}
			/>

			<div className="card bg-base-100 border border-base-300">
				<div className="card-body p-5 sm:p-6">
					<Calculator />
				</div>
			</div>
		</div>
	);
}

// ─── State ─────────────────────────────────────────────────────────────────────

function Calculator() {
	const [lines, setLines] = useState(startLines);
	// The re-point, settled 2026-10-15: the Anthers side starts at the Public
	// Access price, and everything past it is directed at the creators. The
	// directed side follows the month until the reader types a number of their
	// own.
	const [anthersAmt, setAnthersAmt] = useState(PUBLIC_ACCESS_PRICE);
	const [directedAmt, setDirectedAmt] = useState(0);
	const [directedTouched, setDirectedTouched] = useState(false);

	const set = (key: LineKey, patch: Partial<SpendLine>) =>
		setLines((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

	// Editing a subscription-type line reshapes the month's money, so the
	// directed side goes back to following it — the re-point re-derives.
	const setSpend = (key: LineKey, v: number) => {
		set(key, { spend: Math.max(0, v) });
		setDirectedTouched(false);
	};

	const m = useMemo(
		() => computeMonth(lines, { anthersAmt, directedAmt, directedTouched }),
		[lines, anthersAmt, directedAmt, directedTouched],
	);

	return (
		<>
			<Inputs
				lines={lines}
				set={set}
				setSpend={setSpend}
				anthersAmt={anthersAmt}
				setAnthersAmt={setAnthersAmt}
				directed={m.anthers.directed}
				directedAuto={m.anthers.directedAuto}
				onDirectedChange={(v) => {
					setDirectedAmt(v);
					setDirectedTouched(true);
				}}
				followMonth={() => setDirectedTouched(false)}
				floorless={m.anthers.floorless}
			/>

			<div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
				<FlowToday m={m} />
				<FlowAnthers lines={lines} m={m} anthersAmt={anthersAmt} />
			</div>

			<Verdict m={m} />

			<Notes />
		</>
	);
}

// ─── Inputs ────────────────────────────────────────────────────────────────────

interface InputsProps {
	lines: Record<LineKey, SpendLine>;
	set: (key: LineKey, patch: Partial<SpendLine>) => void;
	setSpend: (key: LineKey, v: number) => void;
	anthersAmt: number;
	setAnthersAmt: (v: number) => void;
	directed: number;
	directedAuto: boolean;
	onDirectedChange: (v: number) => void;
	followMonth: () => void;
	floorless: boolean;
}

function Inputs({
	lines,
	set,
	setSpend,
	anthersAmt,
	setAnthersAmt,
	directed,
	directedAuto,
	onDirectedChange,
	followMonth,
	floorless,
}: InputsProps) {
	// A line's fields stay mounted while it is on even at zero — a line that hid
	// its price field at zero could never be brought back.

	const lineHeader = (key: LineKey) => (
		<div className="flex justify-between items-center gap-3 mb-2">
			<span className="text-sm font-semibold text-base-content/80">{LINE_TITLES[key]}</span>
			<SegControl
				ariaLabel={`${LINE_TITLES[key]} on or off`}
				value={lines[key].on ? 1 : 0}
				onChange={(v) => set(key, { on: v === 1 })}
				options={[
					{ value: 0, label: "Off" },
					{ value: 1, label: "On" },
				]}
			/>
		</div>
	);

	// `LINE_ORDER` drives the grid; each cell spells out its own fields, which
	// differ per line.
	const block = new Map<LineKey, React.ReactNode>([
		[
			"video",
			<>
				{lineHeader("video")}
				{lines.video.on && (
					<div className="grid grid-cols-2 gap-3">
						<NumberField
							label={LINE_RIVALS.video.name}
							value={lines.video.spend}
							onChange={(v) => setSpend("video", v)}
							min={0}
							step={0.01}
							prefix="$"
							suffix="/mo"
						/>
						<NumberField
							label="Watching"
							value={lines.video.hours}
							onChange={(v) => set("video", { hours: Math.max(0, Math.round(v)) })}
							min={0}
							step={1}
							suffix="hrs"
						/>
					</div>
				)}
			</>,
		],
		[
			"music",
			<>
				{lineHeader("music")}
				{lines.music.on && (
					<NumberField
						label={LINE_RIVALS.music.name}
						value={lines.music.spend}
						onChange={(v) => setSpend("music", v)}
						min={0}
						step={0.01}
						prefix="$"
						suffix="/mo"
					/>
				)}
			</>,
		],
		[
			"purchases",
			<>
				{lineHeader("purchases")}
				{lines.purchases.on && (
					<div className="grid grid-cols-2 gap-3">
						<NumberField
							label="Typical item"
							value={lines.purchases.itemPrice}
							onChange={(v) => set("purchases", { itemPrice: Math.max(0, v) })}
							min={0}
							step={1}
							prefix="$"
						/>
						<NumberField
							label="Items a month"
							value={lines.purchases.items}
							onChange={(v) => set("purchases", { items: Math.max(0, Math.round(v)) })}
							min={0}
							step={1}
						/>
					</div>
				)}
			</>,
		],
		[
			"direct",
			<>
				{lineHeader("direct")}
				{lines.direct.on && (
					<div className="grid grid-cols-2 gap-3">
						<NumberField
							label={LINE_RIVALS.direct.name}
							hint="total / month"
							value={lines.direct.spend}
							onChange={(v) => setSpend("direct", v)}
							min={0}
							step={0.5}
							prefix="$"
							suffix="/mo"
						/>
						<NumberField
							label="To how many"
							hint={
								lines.direct.recipients > 1
									? `${lines.direct.recipients} separate bills`
									: undefined
							}
							value={lines.direct.recipients}
							onChange={(v) => set("direct", { recipients: Math.max(1, Math.round(v)) })}
							min={1}
							step={1}
						/>
					</div>
				)}
			</>,
		],
		[
			"free",
			<>
				{lineHeader("free")}
				{lines.free.on && (
					<NumberField
						label="Watching, free"
						hint="ad-supported"
						value={lines.free.hours}
						onChange={(v) => set("free", { hours: Math.max(0, Math.round(v)) })}
						min={0}
						step={1}
						suffix="hrs"
					/>
				)}
			</>,
		],
	]);

	return (
		<div>
			<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
				Your month, line by line
			</h2>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 mt-3">
				{LINE_ORDER.map((key) => (
					<div key={key}>{block.get(key)}</div>
				))}
			</div>

			{/* The Anthers side of the month */}
			<div className="mt-6 pt-5 border-t border-base-content/10">
				<h3 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40 mb-3">
					The same money, re-pointed on Anthers
				</h3>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 items-start">
					<div>
						<NumberField
							label="What you give Anthers"
							value={anthersAmt}
							onChange={(v) => setAnthersAmt(Math.max(0, v))}
							min={0}
							step={0.5}
							prefix="$"
							suffix="/mo"
						/>
						<div className="mt-2">
							<SegControl
								ariaLabel="The Badge rungs, as quick amounts"
								value={anthersAmt}
								onChange={(v) => setAnthersAmt(v)}
								// A hand-typed value matches no rung, so it joins the
								// options as "Custom" — pressed, until a rung is picked again.
								options={
									RUNG_OPTIONS.some((o) => o.value === anthersAmt)
										? RUNG_OPTIONS
										: [...RUNG_OPTIONS, { value: anthersAmt, label: "Custom" }]
								}
							/>
						</div>
					</div>
					<div>
						<NumberField
							label="What you direct at creators"
							value={directed}
							onChange={onDirectedChange}
							min={0}
							step={0.5}
							prefix="$"
							suffix="/mo"
						/>
						<p className="text-base-content/40 text-xs mt-1.5 leading-relaxed">
							{directedAuto ? (
								<>
									Following your month: everything past the Anthers side, re-pointed at the
									creators. Editing the number takes over by hand.
								</>
							) : (
								<>
									You are steering by hand.{" "}
									<button type="button" className="link" onClick={followMonth}>
										Follow my month again
									</button>
									.
								</>
							)}
						</p>
					</div>
				</div>
				{floorless && (
					<p className="text-warning text-xs mt-3 leading-relaxed">
						A monthly charge under about {money2(cardFloor())} is consumed entirely: the flat part
						of the card fee alone is bigger than what would be left. Nothing funds anything at this
						size, and the calculator shows it as a gap rather than a remainder. The floor is
						computed from the card rate and moves with it.
					</p>
				)}
			</div>
		</div>
	);
}

// ─── Flow 1 — your money today ─────────────────────────────────────────────────

function FlowToday({ m }: { m: MediaMonth }) {
	return (
		<section className="card bg-base-200/40 border border-base-300">
			<div className="card-body p-4 sm:p-5">
				<h3 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					Your money today
				</h3>

				{m.today.paysNothing ? (
					<p className="text-sm text-base-content/80 leading-relaxed pt-1">
						You pay nothing anywhere. This is the month Anthers loses on money — see the same-money
						side for what it offers instead, and neither tool hides that.
					</p>
				) : (
					<>
						<table className="table table-sm">
							<thead>
								<tr className="text-[10px] uppercase tracking-wide text-base-content/50">
									<th className="font-sans">Line</th>
									<th className="text-right font-sans">You pay</th>
									<th className="text-right font-sans">The platform keeps</th>
									<th className="text-right font-sans">Reaches creators</th>
								</tr>
							</thead>
							<tbody>
								{m.today.rows.map((row) => (
									<tr key={row.key} className="border-b border-base-300/60">
										<td>
											<span className="font-semibold text-base-content/80">{row.name}</span>
											<span className="block text-xs text-base-content/40">{row.gets}</span>
										</td>
										<td className="text-right font-mono tabular-nums">
											{row.pay === null ? "—" : money2(row.pay)}
										</td>
										<td className="text-right font-mono tabular-nums">
											{row.platform === null ? (
												<span className="badge badge-warning badge-sm">{NOT_PUBLISHED}</span>
											) : (
												money2(row.platform)
											)}
										</td>
										<td className="text-right font-mono tabular-nums">
											{row.creator === null ? (
												<span className="badge badge-warning badge-sm">{NOT_PUBLISHED}</span>
											) : (
												money2(row.creator)
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>

						{/* What the platform does publish, row by row — so the gaps above read as gaps. */}
						<div className="mt-3 space-y-3">
							{m.today.rows.map((row) => (
								<div key={row.key}>
									<p className="text-[11px] font-mono uppercase tracking-[0.12em] text-base-content/40">
										{row.name}
									</p>
									<ul className="mt-1 list-disc pl-4 space-y-1 text-xs leading-relaxed text-base-content/40">
										{row.knowns.map((k) => (
											<li key={k}>{k}</li>
										))}
									</ul>
								</div>
							))}
						</div>

						<div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
							<StatCard
								label="You pay"
								value={money2(m.today.paid)}
								sub="Sales tax is the illustration, on both sides alike."
							/>
							<StatCard
								label="Known to reach the people you chose"
								value={money2(m.today.knownByName)}
								sub="Exact per the published fees — the purchases and the pledges are the named money."
							/>
							<StatCard
								label="Rides lines nobody publishes"
								value={money2(m.today.notPublished)}
								sub="The gap is a finding, not an omission."
							/>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

// ─── Flow 2 — the same money on Anthers ────────────────────────────────────────

function FlowAnthers({
	lines,
	m,
	anthersAmt,
}: {
	lines: Record<LineKey, SpendLine>;
	m: MediaMonth;
	anthersAmt: number;
}) {
	const breakdown = m.anthers.breakdown;
	// Null is the losing case's shape (no charge, no purchases — a month that pays
	// nothing), and the losing case renders the prose panel below instead; when
	// these tiles and the verdict are rendered, the month has money in it.
	const paid = m.anthers.paid ?? 0;
	const reachCreators = m.anthers.reachCreators ?? 0;
	const byName = m.anthers.byName ?? 0;

	const chargeItems: { label: string; value: number; sub?: string }[] = [
		{ label: "Given to Anthers", value: breakdown.anthers },
		{ label: "Directed at creators", value: breakdown.directed },
		{
			label: "The one card fee, at cost",
			value: breakdown.card,
			sub: "Paid to the processor — the whole charge's fee, once, split pro-rata.",
		},
		{ label: "Directed money reaches", value: breakdown.directedNet },
		{ label: "The Time Pool — by time spent", value: breakdown.timePool },
		{ label: "The remainder — funds the charitable programs", value: breakdown.remainder },
		{ label: "You pay, with tax", value: breakdown.chargedWithTax },
	];

	return (
		<section className="card bg-base-200/40 border border-base-300">
			<div className="card-body p-4 sm:p-5">
				<h3 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
					The same money on Anthers
				</h3>

				{m.today.paysNothing ? (
					// The losing case, stated rather than arranged away. The pools are
					// real but the layer computes no dollar figure for them against this
					// month, so none is rendered — prose only.
					<div className="text-sm text-base-content/80 leading-relaxed space-y-3 pt-1">
						<p>
							Your comparable month here is the free account: {FREE_PUBLIC_ACCESS_HOURS} hours of
							Public Access, funded by Anthers, not by you — the pools that pay the creators whose
							work free accounts watch are funded by the remainder.
						</p>
						<p>
							With {lines.free.hours} hours a month, a free account covers{" "}
							{Math.min(FREE_PUBLIC_ACCESS_HOURS, lines.free.hours)} of them. Giving the Public
							Access price lifts the cap to all of it — and nothing is unlocked: the work was
							already free to everyone; what lifts is the limit.
						</p>
						<p>
							On money this month is a loss — per-hour, ad-supported watching almost certainly pays
							creators more than a free account's funded pool. What Anthers offers instead is not
							financial: no ads, no behavioral profile, no feed built to maximize watching. That
							choice is a product choice rather than a savings one, and it is yours.
						</p>
					</div>
				) : (
					<>
						{breakdown.charge > 0 && (
							<div className="space-y-2">
								{chargeItems.map((item) => (
									<ChargeRow key={item.label} {...item} />
								))}
							</div>
						)}

						{m.anthers.purchases.length > 0 && (
							<div className="space-y-2">
								{m.anthers.purchases.map((row) => {
									const delta = row.reachAnthers - row.reachRival;
									return (
										<p key={row.price} className="text-sm text-base-content/70 leading-relaxed">
											{row.items} × {money2(row.price)} — the card line is {money2(row.card)}; the
											creator receives {money2(row.reachAnthers)} exactly.{" "}
											{row.price >= crossover() ? (
												<>
													On the storefront the same purchase delivers {money2(row.reachRival)} —
													the Anthers difference is {money2(delta)} per item (
													{pct(delta, row.reachRival)} more).
												</>
											) : (
												<>
													The storefront wins at this item price — below the computed crossover of{" "}
													{money2(crossover())}, a percentage cut that absorbs processing beats the
													flat card fee. Conceded, not hidden.
												</>
											)}
										</p>
									);
								})}
							</div>
						)}

						<div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
							<StatCard label="You pay, with tax" value={money2(paid)} />
							<StatCard
								label="Reaches creators — exactly"
								value={money2(reachCreators)}
								tone="time"
								sub="Computed from the checkout's own math, to the cent."
							/>
							<StatCard
								label="The split of what arrives"
								value={money2(byName + m.anthers.byPool)}
								sub={`${money2(byName)} by name · ${money2(m.anthers.byPool)} by the time spent`}
							/>
						</div>

						{/* The hours, against the Public Access allowance. The covered case and
						    the free-account choice are the only two sentences that can be true. */}
						{lines.video.on && anthersAmt >= PUBLIC_ACCESS_PRICE && (
							<p className="text-sm text-base-content/70 leading-relaxed">
								Your {lines.video.hours} watching hours: covered entirely — the Public Access price
								buys the lifted limit; the ten hours were the free account's, and this is not it.
							</p>
						)}
						{lines.video.on && anthersAmt === 0 && lines.video.hours > FREE_PUBLIC_ACCESS_HOURS && (
							<p className="text-sm text-base-content/70 leading-relaxed">
								You chose the free account: {FREE_PUBLIC_ACCESS_HOURS} hours a month — your{" "}
								{lines.video.hours} exceed it; the tool will not pretend otherwise.
							</p>
						)}

						{breakdown.directed > 0 && (
							<p className="text-sm text-base-content/70 leading-relaxed">
								Every directed dollar arrives {pct(breakdown.directedNet, breakdown.directed)} whole
								— one charge pays the flat fee once, whatever it carries.
							</p>
						)}
					</>
				)}
			</div>
		</section>
	);
}

/** One label/value row of the support-charge itemization, mono value right-aligned. */
function ChargeRow({ label, value, sub }: { label: string; value: number; sub?: string }) {
	return (
		<div>
			<div className="flex items-baseline justify-between gap-3 text-sm">
				<span className="text-base-content/70">{label}</span>
				<span className="font-mono text-sm tabular-nums">{money2(value)}</span>
			</div>
			{sub && <p className="text-xs text-base-content/40 mt-0.5">{sub}</p>}
		</div>
	);
}

// ─── The verdict ───────────────────────────────────────────────────────────────

function Verdict({ m }: { m: MediaMonth }) {
	if (m.today.paysNothing) return null;
	// Same guarantee as the flow panel: with a paying month, these are computed.
	const paid = m.anthers.paid ?? 0;
	const reachCreators = m.anthers.reachCreators ?? 0;

	return (
		<div className="mt-6 border-l-4 border-primary/40 bg-base-200/60 px-4 py-3 text-sm text-base-content/80 leading-relaxed space-y-2">
			<p>
				Of your {money2(m.today.paid)} today, {money2(m.today.knownByName)} is known to reach the
				people you chose by name; {money2(m.today.notPublished)} rides lines whose per-user split
				those platforms do not publish — the tool leaves the gap standing rather than estimating it.
			</p>
			<p>
				The same spend re-pointed on Anthers pays {money2(paid)} with tax and{" "}
				{money2(reachCreators)} reaches creators — computed, exactly. Pattern in your own numbers:
				money with a name on it travels better than money pooled; that is the model working, not a
				defect.
			</p>
		</div>
	);
}

// ─── The notes ─────────────────────────────────────────────────────────────────

function Notes() {
	return (
		<CalcNotes>
			<p>
				Every Anthers figure on this page is computed from the checkout's own math — the float
				copies of the decimal originals, pinned by test to the money version. The directed-money
				batching arithmetic is the same one the wiki's tables run; nothing on this page is
				estimated, and a figure that cannot be computed is shown as a published gap rather than an
				invented number.
			</p>
			<p>
				The prices and rates on the rival side are hand-maintained competitor research, carried by
				the generated <code>RIVAL_SPEND</code> table — what each platform publishes, and does not:
			</p>
			<div className="overflow-x-auto">
				<table className="table table-sm text-xs align-top">
					<thead>
						<tr className="text-[10px] uppercase tracking-wide text-base-content/50">
							<th className="font-sans">Line</th>
							<th className="font-sans">Published</th>
							<th className="font-sans">Source</th>
							<th className="font-sans">Checked</th>
						</tr>
					</thead>
					<tbody>
						{RIVAL_SPEND.map((r) => (
							<tr key={r.key} className="border-b border-base-300/40 align-top">
								<td className="whitespace-nowrap font-medium">{r.name}</td>
								<td>{publishedFacts(r)}</td>
								<td className="text-base-content/40">{r.source}</td>
								<td className="font-mono whitespace-nowrap">{r.checkedOn}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p>
				These figures move — re-checked {LAST_CHECKED} — and Steam's tier improvements above ten
				million in lifetime revenue per title are left out, as irrelevant to effectively every
				creator compared here.
			</p>
			<p>
				Sales tax is added on both sides at the illustration rate, the same way the wiki's
				comparison tables add it; it is the only thing added on top anywhere.
			</p>
			<p>
				The wiki's fixed cases, in prose, live at its{" "}
				<em>What It Costs, Against What You Pay Now</em> page; the head-to-head pay table for
				creators is the pay comparison among the resources.
			</p>
		</CalcNotes>
	);
}
