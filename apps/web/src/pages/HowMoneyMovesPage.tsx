// SPDX-License-Identifier: Apache-2.0
//
// Resource: "How the Money Moves" — the mechanism, drawn. One question: a person
// pays Anthers (or a creator) a monthly amount; where does it go, and what does it
// buy? The page draws every way money arrives on Anthers and every way it leaves,
// at three representative charges — a Root subscription to Anthers, a subscription
// pointed at a creator, and a purchase — with every strand labeled by its computed
// percentage, and receipts beneath that carry the whole Badge ladder and the flat
// fee's edges.
//
// 🚨 **This page is the mechanism, never the plan.** The retired `/resources/revenue`
// drew the financial plan's projections at modeled scale, and was taken down for
// exactly that (2026-10-15): projections this early and this in flux make a public
// page muddier rather than more transparent. Everything here is a single charge's
// arithmetic — no account mix, no phase, no forecast — so a strand's percentages
// hold whatever the platform's size turns out to be. `MONEY_FLOWS` from
// `@anthers/shared/figures` carries the routes (computed by `scripts/econ-figures.ts`
// from the checkout's own primitives, conservation asserted in the generator); the
// charges named there are inputs, and nothing on this page is a projection of scale.
// Actual-to-budget reporting belongs to real operating history, and the copy below
// says so in plain terms rather than implying a report exists.
//
// 🚨 **Claims discipline is load-bearing here** — the page's subject is the
// organization's own money, so it rides the `about-claims` scan (this file is read
// by that suite). No federal exemption claim in any form, no dates on it: the wiki's
// *How Anthers Talks About Itself* § Claims is the authority.
//
// 🚨 **A Badge is a subscription purchase, never a gift** (2026-10-15, recorded in
// *How Anthers Talks About Itself*'s vocabulary): the reader pays a monthly amount
// and buys the lifted limit and a standing. This page's copy says subscription, and
// the verb *give* only where it earns its place.
//
// Diagram mechanics carried from the retired revenue drawing (which adapted the
// admin console's plan screen): `align="left"` keeps terminal obligations in their
// own column instead of justify's pull to the last one, and `sort={false}` makes the
// nodes array the drawing order — each column largest to smallest within its stream.
// Hover lighting follows the streams the same way: a strand lights its own subtree
// and every ancestor's own node back to its source.

import { MONEY_FLOWS } from "@anthers/shared/figures";
import { useState } from "react";
import { ResponsiveContainer, Sankey, type SankeyLinkProps, type SankeyNodeProps } from "recharts";
import { CalcNotes, CalcPageHeader, StatCard } from "../components/calculators/ui";

// ─── Composition helpers ─────────────────────────────────────────────────────

const usd = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${v}%`;

// ─── The drawing ─────────────────────────────────────────────────────────────

interface FlowNode {
	name: string;
	fill: string;
	group: string;
	label: string;
	value: number;
	/** Sources label to the right; everything deeper labels left, out of the ribbons. */
	labelRight?: boolean;
}

interface FlowLink {
	source: number;
	target: number;
	value: number;
	group: string;
	stroke: string;
	/** The label this ribbon carries: the share of its own charge, computed. */
	pct?: number;
}

const C = {
	anthers: "#6366f1",
	creator: "#0d9488",
	purchase: "#0284c7",
	card: "#64748b",
	timePool: "#d97706",
	remainder: "#312e81",
	creatorPay: "#b45309",
	processor: "#475569",
	programs: "#065f46",
};

const F = MONEY_FLOWS;

const cardTotal = F.anthersSub.card + F.creatorSub.at.card + F.purchase.at.card;
const creatorsTotal = F.anthersSub.timePool + F.creatorSub.at.creator + F.purchase.at.creator;

/** Declared in drawing order within each column; recharts renders the array as-is. */
const NODE_DEFS: FlowNode[] = [
	{
		name: "sA",
		fill: C.anthers,
		group: "anthers",
		label: `An Anthers Subscription · Root ${usd(F.anthersSub.monthly)}/mo`,
		value: F.anthersSub.monthly,
		labelRight: true,
	},
	{
		name: "sD",
		fill: C.creator,
		group: "creatorSub",
		label: `A Subscription to a Creator · ${usd(F.creatorSub.at.monthly)}/mo`,
		value: F.creatorSub.at.monthly,
		labelRight: true,
	},
	{
		name: "sP",
		fill: C.purchase,
		group: "purchase",
		label: `A Purchase · ${usd(F.purchase.at.price)}`,
		value: F.purchase.at.price,
		labelRight: true,
	},
	{
		name: "card",
		fill: C.card,
		group: "card",
		label: `Card Processing, at Cost · ${usd(cardTotal)}/mo`,
		value: cardTotal,
	},
	{
		name: "timePool",
		fill: C.timePool,
		group: "timePool",
		label: `The Time Pool · ${usd(F.anthersSub.timePool)}/mo`,
		value: F.anthersSub.timePool,
	},
	{
		name: "remainder",
		fill: C.remainder,
		group: "remainder",
		label: `The Remainder · ${usd(F.anthersSub.remainder)}/mo`,
		value: F.anthersSub.remainder,
	},
	{
		name: "creators",
		fill: C.creatorPay,
		group: "creators",
		label: `To Creators · ${usd(creatorsTotal)}/mo`,
		value: creatorsTotal,
	},
	{
		name: "processor",
		fill: C.processor,
		group: "processor",
		label: `The Payment Processor · ${usd(cardTotal)}/mo`,
		value: cardTotal,
	},
	{
		name: "programs",
		fill: C.programs,
		group: "programs",
		label: `The Charitable Programs · ${usd(F.anthersSub.remainder)}/mo`,
		value: F.anthersSub.remainder,
	},
];

interface LinkDef {
	from: string;
	to: string;
	value: number;
	group: string;
	stroke: string;
	/** The charge's own share, computed — labeled on the first hop out of a source. */
	pct?: number;
}

const LINK_DEFS: LinkDef[] = [
	{
		from: "sA",
		to: "card",
		value: F.anthersSub.card,
		group: "anthers",
		stroke: C.anthers,
		pct: F.anthersSub.cardPct,
	},
	{
		from: "sA",
		to: "timePool",
		value: F.anthersSub.timePool,
		group: "timePool",
		stroke: C.timePool,
		pct: F.anthersSub.timePoolPct,
	},
	{
		from: "sA",
		to: "remainder",
		value: F.anthersSub.remainder,
		group: "remainder",
		stroke: C.remainder,
		pct: F.anthersSub.remainderPct,
	},
	{
		from: "sD",
		to: "card",
		value: F.creatorSub.at.card,
		group: "creatorSub",
		stroke: C.creator,
		pct: F.creatorSub.at.cardPct,
	},
	{
		from: "sD",
		to: "creators",
		value: F.creatorSub.at.creator,
		group: "creators",
		stroke: C.creator,
		pct: F.creatorSub.at.creatorPct,
	},
	{
		from: "sP",
		to: "card",
		value: F.purchase.at.card,
		group: "purchase",
		stroke: C.purchase,
		pct: F.purchase.at.cardPct,
	},
	{
		from: "sP",
		to: "creators",
		value: F.purchase.at.creator,
		group: "creators",
		stroke: C.purchase,
		pct: F.purchase.at.creatorPct,
	},
	{
		from: "timePool",
		to: "creators",
		value: F.anthersSub.timePool,
		group: "timePool",
		stroke: C.timePool,
	},
	{
		from: "remainder",
		to: "programs",
		value: F.anthersSub.remainder,
		group: "programs",
		stroke: C.programs,
	},
	{ from: "card", to: "processor", value: cardTotal, group: "card", stroke: C.card },
];

// Columns draw in narrative order, streams kept whole: the Anthers subscription
// first (the hero strand — the only one feeding a pool), then the two pass-through
// charges; the subscription's ways out and the terminals sort widest-first.
// `sort={false}` makes the array the order.
const inColumn = (names: string[], bySize: boolean) =>
	bySize
		? NODE_DEFS.filter((n) => names.includes(n.name)).sort((a, b) => b.value - a.value)
		: NODE_DEFS.filter((n) => names.includes(n.name));

const NODE_ORDER = [
	...inColumn(["sA", "sD", "sP"], false),
	...inColumn(["card", "timePool", "remainder"], true),
	...inColumn(["creators", "processor", "programs"], true),
];

const idx = new Map(NODE_ORDER.map((n, i) => [n.name, i] as const));
const data = {
	nodes: NODE_ORDER.map((n) => ({ ...n })),
	links: LINK_DEFS.map((l) => ({
		source: idx.get(l.from) ?? 0,
		target: idx.get(l.to) ?? 0,
		value: l.value,
		group: l.group,
		stroke: l.stroke,
		pct: l.pct,
	})),
};

/**
 * Hover follows streams the way the admin diagram's does: the strand and
 * everything under it, plus each ancestor's own node back to the source.
 */
const DOWN: Record<string, readonly string[]> = {
	anthers: ["anthersCard", "timePool", "remainder"],
	timePool: ["creators"],
	remainder: ["programs"],
	creatorSub: ["creatorCard", "creators"],
	purchase: ["purchaseCard", "creators"],
	card: ["processor"],
};

const UP: Record<string, readonly string[]> = {
	anthersCard: ["anthers"],
	timePool: ["anthers"],
	remainder: ["anthers"],
	programs: ["remainder", "anthers"],
	creatorCard: ["creatorSub"],
	purchaseCard: ["purchase"],
	creators: ["creatorSub", "purchase", "timePool"],
	processor: ["card"],
};

function litGroupsFor(hover: string): Set<string> {
	const lit = new Set<string>();
	const down = (g: string) => {
		lit.add(g);
		for (const child of DOWN[g] ?? []) down(child);
	};
	const up = (g: string) => {
		lit.add(g);
		for (const parent of UP[g] ?? []) up(parent);
	};
	down(hover);
	up(hover);
	// `creators` carries three streams; hovering it lights every source.
	if (hover === "creators") for (const s of ["anthers", "creatorSub", "purchase"]) down(s);
	return lit;
}

function FlowDiagram() {
	const [hover, setHover] = useState<string | null>(null);
	const dim = (group: string): number => (!hover ? 1 : litGroupsFor(hover).has(group) ? 1 : 0.18);

	return (
		<figure className="my-6 w-full">
			<ResponsiveContainer width="100%" height={640}>
				<Sankey
					data={data}
					nodeWidth={18}
					nodePadding={26}
					align="left"
					linkCurvature={0.55}
					sort={false}
					margin={{ top: 8, right: 220, bottom: 8, left: 8 }}
					role="img"
					aria-label="How the Money Moves: three ways money arrives — a Root subscription to Anthers, a subscription pointed at a creator, and a purchase. Card processing leaves every one at cost, paid to the processor. Half of an Anthers subscription goes to the Time Pool, paid to creators by time spent; its remainder merges into one pool funding the charitable programs. A creator subscription and a purchase pass through to their creator in full, minus the card line."
					node={(props) => <FlowNodeCapsule {...props} dim={dim} />}
					link={(props) => <FlowRibbon {...props} dim={dim} />}
					onMouseEnter={(item, type) => {
						const d = (type === "node"
							? (item as SankeyNodeProps).payload
							: (item as SankeyLinkProps).payload) as unknown as FlowNode;
						setHover(d.group);
					}}
					onMouseLeave={() => setHover(null)}
				/>
			</ResponsiveContainer>
			<p className="mt-1 text-xs text-base-content/60">
				Three example charges, drawn all the way out. The figures beside the deeper capsules are the
				three charges together; the percentages on the ribbons are each charge's own split, computed
				from the same math the checkout runs. Hover any capsule or ribbon to light its stream.
			</p>
		</figure>
	);
}

interface NodeDrawProps extends SankeyNodeProps {
	dim: (group: string) => number;
}

function FlowNodeCapsule(props: NodeDrawProps) {
	const d = props.payload as unknown as FlowNode;
	const cy = props.y + props.height / 2;
	return (
		<g opacity={props.dim(d.group)} data-node={d.name}>
			<rect
				x={props.x}
				y={props.y}
				width={props.width}
				height={Math.max(3, props.height)}
				rx={props.width / 2}
				fill={d.fill}
			/>
			<text
				x={d.labelRight ? props.x + props.width + 8 : props.x - 8}
				y={cy + 4}
				fontSize={11.5}
				textAnchor={d.labelRight ? "start" : "end"}
				className="fill-current"
			>
				{d.label}
			</text>
		</g>
	);
}

interface LinkDrawProps extends SankeyLinkProps {
	dim: (group: string) => number;
}

/**
 * A ribbon: width proportional to its dollars, colored by its stream, and — on
 * the first hop out of a charge — labeled with that charge's computed share.
 */
function FlowRibbon(props: LinkDrawProps) {
	const d = props.payload as unknown as FlowLink;
	const path = `M${props.sourceX},${props.sourceY} C${props.sourceControlX},${props.sourceY} ${props.targetControlX},${props.targetY} ${props.targetX},${props.targetY}`;
	const midX =
		(props.sourceX + 3 * props.sourceControlX + 3 * props.targetControlX + props.targetX) / 8;
	const midY = (props.sourceY + props.targetY) / 2;
	return (
		<g opacity={props.dim(d.group)}>
			<path
				d={path}
				fill="none"
				stroke={d.stroke}
				strokeWidth={Math.max(1.5, props.linkWidth)}
				opacity={0.42}
			/>
			{d.pct !== undefined && (
				<text
					x={midX}
					y={midY + 3.5}
					fontSize={10}
					textAnchor="middle"
					className="fill-current text-base-content/75"
				>
					{pct(d.pct)}
				</text>
			)}
		</g>
	);
}

// ─── The page ────────────────────────────────────────────────────────────────

export default function HowMoneyMovesPage() {
	return (
		<div>
			<CalcPageHeader
				eyebrow="The mechanism"
				title="How the Money Moves"
				lede={
					<>
						A person&rsquo;s money reaches Anthers one of three ways — a monthly subscription to
						Anthers, a monthly subscription pointed at a creator, or a purchase — and this page
						draws where each one goes, all the way out, exactly as the platform works today. The
						percentages are the mechanism: the same every month, at any scale, and every one of them
						is generated from the same math the checkout runs. Hold it to the arithmetic.
					</>
				}
			/>

			<div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
				<StatCard
					label="Of an Anthers subscription, to the Time Pool"
					value={pct(F.anthersSub.timePoolPct)}
					sub="Paid to creators by the time spent with their work, on every rung"
					tone="time"
				/>
				<StatCard
					label="What Anthers keeps from creator money"
					value="0%"
					sub="Nothing. Only the at-cost card line is deducted, and it is paid to the processor"
				/>
				<StatCard
					label={`Of ${F.purchase.at.item.toLowerCase()} priced ${usd(F.purchase.at.price)}, to its creator`}
					value={pct(F.purchase.at.creatorPct)}
					sub={`${usd(F.purchase.at.creator)} — computed, not estimated`}
				/>
			</div>

			<FlowDiagram />

			<div className="mt-12 prose prose-sm max-w-none prose-headings:mb-3">
				<h2>Reading the Drawing</h2>
				<p>
					Read it obligations-first. Card processing leaves every charge at cost, paid to the
					processor at their published rate, with nothing added. An Anthers subscription splits into
					three: the card line, half its monthly amount into the Time Pool — paid to creators by the
					time spent with their work, a minute for a minute across every medium — and the remainder,
					which merges into one pool that funds the charitable programs. A subscription pointed at a
					creator, and a purchase, pass straight through to their creator in full: those two ribbons
					never touch a pool, because Anthers takes no cut of creator money.
				</p>
				<h2>One Pool, Not Buckets</h2>
				<p>
					The remainder strands all merge before anything is spent, and no revenue line is reserved
					against a purpose. What Anthers commits to is the outflow side: the programs are budgeted
					in advance, published, and changed openly. The drawing shows the pool funding the programs
					as one strand, because the split between them is a budget decision made on what has
					arrived — not a property of the money coming in. Free access sits inside the programs:
					every account&rsquo;s ten free hours a month, and the pools that pay the creators whose
					work is watched and played for free, are what that strand pays for.
				</p>
				<h2>What the Drawing Leaves Out</h2>
				<p>
					Storage top-ups pass through at cost: every byte past a held rung&rsquo;s allowance is
					charged at the provider&rsquo;s own rate with no mark-up, so those dollars fund nothing
					and there is no strand for them to honestly occupy. The donation channel is not built yet;
					when it exists, a donation draws as what it is — one line bypassing the pool entirely,
					going only where the giver directed it, because a real charitable contribution&rsquo;s
					restriction binds in a way nothing budgeted here does.
				</p>
				<h2>Right Now — and Nothing Else</h2>
				<p>
					Nothing here is a projection. There is no account mix, no growth phase, and no forecast:
					each strand is one charge&rsquo;s arithmetic, and the percentages a subscription splits
					into hold whatever size the platform reaches. Reporting actual spending belongs to real
					operating history; Anthers has launch months rather than years, so this page draws how the
					money moves rather than a report of where it went.
				</p>

				<h2>The Receipts</h2>
				<p>
					The same routes as numbers, per charge. Everything below is generated from the
					platform&rsquo;s own code, and the build fails if a figure and its source ever disagree.
				</p>

				<table>
					<thead>
						<tr>
							<th>An Anthers subscription</th>
							<th>To the Time Pool</th>
							<th>Card, at cost</th>
							<th>The remainder &rarr; the programs</th>
						</tr>
					</thead>
					<tbody>
						{F.ladder.map((r) => (
							<tr key={r.badge}>
								<td>
									{r.badge} — {usd(r.monthly)}/mo
								</td>
								<td>
									{usd(r.timePool)} ({pct(r.timePoolPct)})
								</td>
								<td>
									{usd(r.card)} ({pct(r.cardPct)})
								</td>
								<td>
									{usd(r.remainder)} ({pct(r.remainderPct)})
								</td>
							</tr>
						))}
						<tr>
							<td>+ any amount beyond the top</td>
							<td colSpan={3}>
								— half to the Time Pool, the card line at cost, and the rest funds the programs
							</td>
						</tr>
					</tbody>
				</table>
				<p>
					The card line&rsquo;s share shrinks as the charge grows, and that is the fixed fee&rsquo;s
					arithmetic, visible left to right: a Root charge carries a {pct(F.anthersSub.cardPct)}{" "}
					card line, a Blossom charge {pct(F.ladder[3].cardPct)}. The half to the Time Pool does not
					move — it is half by construction, on every rung.
				</p>

				<table>
					<thead>
						<tr>
							<th>A subscription pointed at a creator</th>
							<th>Card, at cost</th>
							<th>Reaches the creator</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>{usd(F.creatorSub.at.monthly)}/mo</td>
							<td>
								{usd(F.creatorSub.at.card)} ({pct(F.creatorSub.at.cardPct)})
							</td>
							<td>
								{usd(F.creatorSub.at.creator)} ({pct(F.creatorSub.at.creatorPct)})
							</td>
						</tr>
						<tr>
							<td>{usd(F.creatorSub.worst.monthly)}/mo — deliberately the worst case</td>
							<td>
								{usd(F.creatorSub.worst.card)} ({pct(F.creatorSub.worst.cardPct)})
							</td>
							<td>
								{usd(F.creatorSub.worst.creator)} ({pct(F.creatorSub.worst.creatorPct)})
							</td>
						</tr>
					</tbody>
				</table>
				<p>
					The worst case is drawn on purpose: a lone charge to a single creator pays the fixed part
					of the card fee alone. Batch an Anthers subscription and your creator subscriptions onto
					one monthly charge and the fixed part is paid once, split pro-rata — creators receive
					more, not less, the more is on the charge.
				</p>

				<table>
					<thead>
						<tr>
							<th>A purchase</th>
							<th>Card, at cost</th>
							<th>Reaches the creator</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>
								{F.purchase.at.item} — {usd(F.purchase.at.price)}
							</td>
							<td>
								{usd(F.purchase.at.card)} ({pct(F.purchase.at.cardPct)})
							</td>
							<td>
								{usd(F.purchase.at.creator)} ({pct(F.purchase.at.creatorPct)})
							</td>
						</tr>
						<tr>
							<td>
								{F.purchase.worst.item} — {usd(F.purchase.worst.price)}
							</td>
							<td>
								{usd(F.purchase.worst.card)} ({pct(F.purchase.worst.cardPct)})
							</td>
							<td>
								{usd(F.purchase.worst.creator)} ({pct(F.purchase.worst.creatorPct)})
							</td>
						</tr>
					</tbody>
				</table>
				<p>
					Several small purchases in one cart pay the fixed card fee once, and the whole saving
					reaches the creators. Sales tax is added on top at checkout and remitted — it never
					appears here because it is never Anthers&rsquo; money. Downloads are unlimited and free,
					and delivery costs nothing at any volume.
				</p>
			</div>

			<CalcNotes>
				<p>
					Every figure on this page is generated from the platform&rsquo;s own code — the same
					primitives the checkout and the payouts run on — and the generated figures file carries
					the whole route, with the arithmetic asserted at build time. A Badge is a subscription
					purchase: it buys the lifted Public Access limit and the standing of the rung held, and
					this page draws what each charge pays for. What it does not draw is a forecast of any
					kind; nothing here should be read as a report of money that has moved.
				</p>
			</CalcNotes>
		</div>
	);
}
