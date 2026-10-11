// SPDX-License-Identifier: Apache-2.0
//
// Resource: "Where the money goes" — the one-pool drawing of Anthers' revenue,
// at the plan's own scale. One question: where does Anthers' revenue go? The
// answer starts before the plan ledger does: the Badge rungs' support comes
// in and merges into one pool, from which obligations leave obligations-first
// — card processing at cost, the paying rungs' creators paid by time — and
// what Anthers holds (the charitable remainder) splits into Admin at the 30%
// ceiling and Programs, which open into Free Access, Free Storage and Other
// Programs, each standing over its own spending.
//
// 🚨 **Targets and estimates, never actuals (Parker, 2026-08-30)** — this page
// must never read as a report of money that has moved. Actual-to-budget
// reporting belongs to real operating history, of which there is none yet, and
// the copy below says so in plain terms rather than implying a report exists.
//
// 🚨 **Claims discipline is load-bearing here.** No federal exemption, no
// pending, no applied-for status: the Form 1023 has not been filed, and the
// wiki's *How Anthers Talks About Itself* § Claims is the authority. The
// phrases are guarded in `about-claims.test.ts`, which reads this file too
// (added with this page), because a page whose whole subject is charitable
// spending is where a claims mistake is most likely.
//
// 🚨 **Every figure on this page is generated, never typed** — that is the
// point of this resource and the reason the deleted /demo-* pages came down:
// each modeled the economics in its own hardcoded numbers and could drift from
// every other surface. The data is `PLAN_PATH` from `@anthers/shared/figures`,
// computed at build time in `scripts/econ-figures.ts` from the authored plan in
// `packages/shared/src/financial-plan.ts` — the same rows the admin console's
// plan tool seeds — through `planLedgerFor`, with conservation asserted in the
// generator itself: inflows sum to processing plus pools plus remainder, the
// remainder closes into Admin and Programs, and the programs close inside
// Programs. Why generation rather than an import: `financial-plan.ts`
// transitively imports `fees.ts`, which pulls decimal.js into the bundle, and
// the SPA must never carry it.
//
// Percentage figures in the prose are read from the data too (`adminCeiling`),
// never typed as literals, so a dial change republishes this page's copy with
// its figures.
//
// Diagram mechanics: `align="left"` is load-bearing, and it is the one place
// this drawing differs from the admin console's plan screen. The admin diagram
// draws remainder-onward and wants justifies' merged last column; this one
// must not have it — card processing and the paying rungs' creator pools are
// terminal obligations with nothing beneath them, and justify would drag their
// ribbons the full width to the right edge, making the smallest at-cost line
// read as the biggest flow. Node order within each column still follows the
// array (`sort={false}`), and the array carries the subtree ordering (Parker,
// 2026-10-10, from the admin Sankey): each column sorts largest to smallest
// within each stream, and whole groups travel with their parent, so a stream's
// ribbons are never parted by a neighbor's.
//
// Styled like the other resources (DaisyUI-native, plain, no Meadow decor) so
// it reads as one set with them.

import { PLAN_PATH } from "@anthers/shared/figures";
import { useState } from "react";
import { ResponsiveContainer, Sankey, type SankeyLinkProps, type SankeyNodeProps } from "recharts";
import { CalcNotes, CalcPageHeader, SegControl, StatCard } from "../components/calculators/ui";

// ─── Composition helpers ─────────────────────────────────────────────────────

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const inflowLabel = (i: { rung: number; badge: string | null; given: number }) =>
	`${i.badge ?? `$${i.rung}`} · ${usd(i.given)}/mo`;

// ─── The drawing ─────────────────────────────────────────────────────────────

interface DiagramNode {
	name: string;
	fill: string;
	group: string;
	label: string;
	value: number;
	/** Drawn as an error-bordered capsule when the phase breaches its budget. */
	warn?: boolean;
}

interface DiagramLink {
	source: number;
	target: number;
	value: number;
	group: string;
	stroke: string;
}

const C = {
	rung: "#6366f1",
	pool: "#4f46e5",
	remainder: "#312e81",
	card: "#64748b",
	pools: "#d97706",
	admin: "#6d28d9",
	programs: "#065f46",
	access: "#2563eb",
	storage: "#0891b2",
	other: "#059669",
};

type PhaseFigure = (typeof PLAN_PATH)[number];

/**
 * Hover follows streams, and the hierarchy, the way the admin console's
 * diagram does: a stream's hover lights its own subtree plus the chain of
 * ancestors back to the pool, so a program line reads as one story from the
 * pool that funded it. DOWN fans a hover through children only; UP lights an
 * ancestor's own node and its own chain up, but never fans DOWN again, so
 * hovering Admin lights the remainder and the pool without ever lighting
 * Programs beside it.
 */
const DOWN: Record<string, readonly string[]> = {
	pool: ["card", "poolToCreators", "remainder"],
	remainder: ["programs", "admin"],
	programs: ["access", "storage", "other"],
	access: ["freePools"],
	storage: ["freeCatalog", "payingAllowances"],
	other: ["unallocated"],
	admin: ["infra", "staff", "tooling", "services", "reserves", "headroom"],
};

const UP: Record<string, readonly string[]> = {
	card: ["pool"],
	poolToCreators: ["pool"],
	remainder: ["pool"],
	programs: ["remainder"],
	admin: ["remainder"],
	access: ["programs", "remainder"],
	storage: ["programs", "remainder"],
	other: ["programs", "remainder"],
	infra: ["admin", "remainder"],
	staff: ["admin", "remainder"],
	tooling: ["admin", "remainder"],
	services: ["admin", "remainder"],
	reserves: ["admin", "remainder"],
	headroom: ["admin", "remainder"],
	freePools: ["access", "programs", "remainder"],
	freeCatalog: ["storage", "programs", "remainder"],
	payingAllowances: ["storage", "programs", "remainder"],
	unallocated: ["other", "programs", "remainder"],
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
	return lit;
}

function PoolDiagram({ phase }: { phase: PhaseFigure }) {
	const [hover, setHover] = useState<string | null>(null);

	const inflowTotal = phase.inflows.reduce((a, i) => a + i.given, 0);

	/**
	 * The nodes array IS the drawing order in each column (`sort={false}`), and
	 * it carries Parker's subtree ordering: inflow rungs sorted among
	 * themselves; the pool; the pool's children largest-first; the remainder's
	 * children (Programs above Admin for being larger); then Programs' lines
	 * and Programs' spending above Admin's lines, each family size-sorted among
	 * itself. Columns fall out of the longest-path depths, and the `left`
	 * alignment on the Sankey leaves every terminal obligation in its own
	 * column instead of justify's pull to the last one.
	 */
	const bySize = (a: DiagramNode, b: DiagramNode): number => b.value - a.value;

	const rungNodes: DiagramNode[] = phase.inflows
		.filter((i) => i.given > 0)
		.map((i) => ({
			name: `r${i.rung}`,
			fill: C.rung,
			group: `r${i.rung}`,
			label: inflowLabel(i),
			value: i.given,
		}));

	const poolNode: DiagramNode = {
		name: "pool",
		fill: C.pool,
		group: "pool",
		label: `The pool · ${usd(inflowTotal)}/mo`,
		value: Math.max(1, inflowTotal),
	};

	const poolKids: DiagramNode[] = [
		{
			name: "poolToCreators",
			fill: C.pools,
			group: "poolToCreators",
			label: `Creator pools, paid by time · ${usd(phase.payingPools)}/mo`,
			value: Math.max(1, phase.payingPools),
		},
		{
			name: "remainder",
			fill: C.remainder,
			group: "remainder",
			label: `What Anthers holds · ${usd(phase.remainder)}/mo`,
			value: Math.max(1, phase.remainder),
		},
		{
			name: "card",
			fill: C.card,
			group: "card",
			label: `Card processing, at cost · ${usd(phase.card)}/mo`,
			value: Math.max(1, phase.card),
		},
	];

	const remainderKids: DiagramNode[] = [
		{
			name: "programs",
			fill: C.programs,
			group: "programs",
			label: `Programs · ${usd(phase.programs)}/mo`,
			value: Math.max(1, phase.programs),
		},
		{
			name: "admin",
			fill: C.admin,
			group: "admin",
			label: `Admin budget · ${usd(phase.adminBudget)}/mo`,
			value: Math.max(1, phase.adminBudget),
			...(phase.adminWithinCeiling ? {} : { warn: true }),
		},
	].sort(bySize);

	// Programs' lines and Admin's spending lines. Zero-valued lines draw
	// nothing — a phase with no staff shows no staff capsule — and their
	// absence changes no conservation, because they carried zero.
	const programLines: DiagramNode[] = [
		{
			name: "other",
			fill: C.other,
			group: "other",
			label: `Other Programs · ${usd(phase.otherPrograms)}/mo`,
			value: Math.max(1, phase.otherPrograms),
		},
		{
			name: "access",
			fill: C.access,
			group: "access",
			label: `Free Access · ${usd(phase.freeAccess)}/mo`,
			value: Math.max(1, phase.freeAccess),
		},
		{
			name: "pstorage",
			fill: C.storage,
			group: "storage",
			label: `Free Storage · ${usd(phase.freeCatalog + phase.payingAllowances)}/mo`,
			value: Math.max(1, phase.freeCatalog + phase.payingAllowances),
		},
	].filter((c) => c.value > 1);

	const adminLines: DiagramNode[] = [
		{
			name: "staff",
			fill: C.admin,
			group: "staff",
			label: `Staff · ${usd(phase.adminSpending.staff)}/mo`,
			value: phase.adminSpending.staff,
		},
		{
			name: "headroom",
			fill: C.admin,
			group: "headroom",
			label: `Headroom · ${usd(phase.adminSpending.headroom)}/mo`,
			value: phase.adminSpending.headroom,
		},
		{
			name: "infra",
			fill: C.admin,
			group: "infra",
			label: `Infrastructure · ${usd(phase.adminSpending.infrastructure)}/mo`,
			value: phase.adminSpending.infrastructure,
		},
		{
			name: "reserves",
			fill: C.admin,
			group: "reserves",
			label: `Reserves · ${usd(phase.adminSpending.reserves)}/mo`,
			value: phase.adminSpending.reserves,
		},
		{
			name: "tooling",
			fill: C.admin,
			group: "tooling",
			label: `Tooling · ${usd(phase.adminSpending.tooling)}/mo`,
			value: phase.adminSpending.tooling,
		},
		{
			name: "services",
			fill: C.admin,
			group: "services",
			label: `Services · ${usd(phase.adminSpending.services)}/mo`,
			value: phase.adminSpending.services,
		},
	].filter((c) => c.value > 1);

	const programKids: DiagramNode[] = [
		{
			name: "unallocated",
			fill: C.other,
			group: "unallocated",
			label: `Unallocated · ${usd(phase.otherPrograms)}/mo`,
			value: Math.max(1, phase.otherPrograms),
		},
		{
			name: "freePools",
			fill: C.access,
			group: "freePools",
			label: `Free Time Pools · ${usd(phase.freePools)}/mo`,
			value: Math.max(1, phase.freePools),
		},
		{
			name: "freeCatalog",
			fill: C.storage,
			group: "freeCatalog",
			label: `Free creators' catalogs · ${usd(phase.freeCatalog)}/mo`,
			value: phase.freeCatalog,
		},
		{
			name: "payingAllowances",
			fill: C.storage,
			group: "payingAllowances",
			label: `Bundled allowances · ${usd(phase.payingAllowances)}/mo`,
			value: phase.payingAllowances,
		},
	].filter((c) => c.value > 1);

	const nodes: DiagramNode[] = [
		...[...rungNodes].sort(bySize),
		poolNode,
		...[...poolKids].sort(bySize),
		...[...remainderKids].sort(bySize),
		...[...programLines].sort(bySize),
		...[...adminLines].sort(bySize),
		...[...programKids].sort(bySize),
	];

	const byName = new Map(nodes.map((n, i) => [n.name, i] as const));
	const link = (
		from: string,
		to: string,
		value: number,
		group: string,
		stroke: string,
	): DiagramLink => ({
		source: byName.get(from) ?? 0,
		target: byName.get(to) ?? 0,
		value: Math.max(1, value),
		group,
		stroke,
	});
	const links: DiagramLink[] = [
		...rungNodes.map((r) => link(r.name, "pool", r.value, r.group, r.fill)),
		link("pool", "poolToCreators", phase.payingPools, "poolToCreators", C.pools),
		link("pool", "remainder", phase.remainder, "remainder", C.remainder),
		link("pool", "card", phase.card, "card", C.card),
		link("remainder", "programs", phase.programs, "programs", C.programs),
		link("remainder", "admin", phase.adminBudget, "admin", C.admin),
		...programLines.map((o) => link("programs", o.name, o.value, o.group, o.fill)),
		...adminLines.map((o) => link("admin", o.name, o.value, o.group, o.fill)),
		link("access", "freePools", phase.freePools, "freePools", C.access),
		link("pstorage", "freeCatalog", phase.freeCatalog, "freeCatalog", C.storage),
		link("pstorage", "payingAllowances", phase.payingAllowances, "payingAllowances", C.storage),
		link("other", "unallocated", phase.otherPrograms, "unallocated", C.other),
	];

	/**
	 * The lit set for a hovered stream: the stream, everything under it, and
	 * every ancestor's OWN node up to the pool. Hovering the pool lights
	 * everything on the diagram, because everything is under it.
	 */
	const dim = (group: string): number => (!hover ? 1 : litGroupsFor(hover).has(group) ? 1 : 0.18);

	return (
		<figure className="my-6 w-full">
			<ResponsiveContainer width="100%" height={640}>
				<Sankey
					data={{ nodes, links }}
					nodeWidth={18}
					nodePadding={18}
					align="left"
					linkCurvature={0.55}
					sort={false}
					margin={{ top: 8, right: 160, bottom: 8, left: 8 }}
					role="img"
					aria-label="Where Anthers' revenue goes: the Badge rungs' support merging into one pool, out to card processing at cost and to creators paid by time, the remainder splitting into Admin and Programs, and the programs opening into Free Access, Free Storage and Other Programs with their own spending beneath them"
					node={(props) => <PoolNode {...props} dim={dim} />}
					link={(props) => <PoolLink {...props} dim={dim} />}
					onMouseEnter={(item, type) => {
						const d = (type === "node"
							? (item as SankeyNodeProps).payload
							: (item as SankeyLinkProps).payload) as unknown as DiagramNode;
						setHover(d.group);
					}}
					onMouseLeave={() => setHover(null)}
				/>
			</ResponsiveContainer>
			<p className="mt-1 text-xs text-base-content/60">
				Each column reads largest to smallest within its stream, and whole groups travel with their
				parent: Programs and everything under it sit above Admin's spending lines, because Programs
				is larger. Hover any capsule or ribbon to follow its stream. No strand skips from an input
				to a purpose: every inflow merges into the pool before anything is spent, and every
				commitment is made on the outflow side.
			</p>
			<p className="mt-1 text-xs text-base-content/70">
				{((1 - phase.adminCeiling) * 100).toFixed(0)}% of the remainder goes to the programs by
				construction, with the admin ceiling's {(phase.adminCeiling * 100).toFixed(0)}% taking{" "}
				{usd(phase.adminBudget)}/mo. Within the programs,{" "}
				{((phase.freeAccess / Math.max(1, phase.programs)) * 100).toFixed(0)}% funds Free Access
				through the Time Pool Fund ({usd(phase.freeSlice)} per free account across{" "}
				{Math.round(phase.freeAccounts).toLocaleString("en-US")} free accounts),{" "}
				{usd(phase.freeCatalog + phase.payingAllowances)}/mo covers free storage, and{" "}
				{usd(phase.otherPrograms)}/mo stays budgeted but not yet allocated.
				{!phase.solvent && (
					<span className="text-error">
						{" "}
						Free Access and Free Storage overrun Programs at this phase; the plan row cannot be
						afforded as modeled.
					</span>
				)}
			</p>
		</figure>
	);
}

interface NodeDrawProps extends SankeyNodeProps {
	dim: (group: string) => number;
}

/**
 * A node: a rounded capsule with its label riding beside it. The first two
 * columns (the inflow rungs and the pool itself) label to the RIGHT, because
 * everything to their left is the page margin; every deeper column labels to
 * the left, keeping labels out of the ribbons crossing in from the pool.
 */
function PoolNode(props: NodeDrawProps) {
	const d = props.payload as unknown as DiagramNode;
	const cy = props.y + props.height / 2;
	const rightLabel = d.name === "pool" || /^r\d+$/.test(d.group);
	return (
		<g opacity={props.dim(d.group)} data-node={d.name}>
			<rect
				x={props.x}
				y={props.y}
				width={props.width}
				height={Math.max(3, props.height)}
				rx={props.width / 2}
				fill={d.fill}
				stroke={d.warn ? "#dc2626" : undefined}
				strokeWidth={d.warn ? 1.5 : undefined}
			/>
			<text
				x={rightLabel ? props.x + props.width + 8 : props.x - 8}
				y={cy + 4}
				fontSize={11.5}
				textAnchor={rightLabel ? "start" : "end"}
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

/** A ribbon: stroke-width proportional to its dollars, in its stream's color. */
function PoolLink(props: LinkDrawProps) {
	const d = props.payload as unknown as DiagramLink;
	const path = `M${props.sourceX},${props.sourceY} C${props.sourceControlX},${props.sourceY} ${props.targetControlX},${props.targetY} ${props.targetX},${props.targetY}`;
	return (
		<path
			d={path}
			fill="none"
			stroke={d.stroke}
			strokeWidth={Math.max(1.5, props.linkWidth)}
			opacity={0.42 * props.dim(d.group)}
		/>
	);
}

// ─── The page ────────────────────────────────────────────────────────────────

const DEFAULT_PHASE = 8; // Inflection 1 — full-time: the landmark the plan is built around.

const phaseOptions = PLAN_PATH.map((p) => ({
	value: p.phase,
	label: p.accounts >= 1000 ? `${p.accounts / 1000}k` : `${p.accounts}`,
}));

export default function RevenueResourcePage() {
	const [phasePhase, setPhasePhase] = useState<number>(DEFAULT_PHASE);
	const phase = PLAN_PATH.find((p) => p.phase === phasePhase) ?? PLAN_PATH[PLAN_PATH.length - 1];

	// The shares the prose quotes, read from the data rather than typed.
	const adminPct = (phase.adminCeiling * 100).toFixed(0);
	const programsPct = ((1 - phase.adminCeiling) * 100).toFixed(0);
	const accessShareOfPrograms = ((phase.freeAccess / Math.max(1, phase.programs)) * 100).toFixed(0);
	const payingSharePct = (phase.payingShare * 100).toFixed(0);

	return (
		<div>
			<CalcPageHeader
				eyebrow="Charitable planning"
				title="Where the money goes"
				lede={
					<>
						Everything given to Anthers merges into one pool before anything is spent, and this page
						draws that pool at nine scales of the plan's growth, from launch to a full-time
						organization: what comes in, what leaves first, and what the charitable programs (free
						access and free storage included) receive from what remains. Every figure is the plan
						working itself out; pick a scale, trace a stream, and hold us to the arithmetic.
					</>
				}
			/>

			<section className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-base-content/70">
				<span className="font-medium">
					{phase.label}, {phase.accounts.toLocaleString("en-US")} accounts
				</span>
				<span aria-hidden="true" className="text-base-content/25">
					·
				</span>
				<span>
					{payingSharePct}% paying · {phase.payingAccounts.toLocaleString("en-US")} paying /{" "}
					{phase.freeAccounts.toLocaleString("en-US")} free ·{" "}
					{phase.creators.toLocaleString("en-US")} creators
				</span>
			</section>
			<SegControl
				options={phaseOptions}
				value={phasePhase}
				onChange={setPhasePhase}
				ariaLabel="Plan phase to draw"
			/>

			<PoolDiagram phase={phase} />

			<div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
				<StatCard
					label="Into the pool"
					value={usd(inflowTotal(phase))}
					unit="/mo"
					sub="Everything given to Anthers, all rungs together"
				/>
				<StatCard
					label="What Anthers holds"
					value={usd(phase.remainder)}
					unit="/mo"
					sub={<>After processing at cost and creator pools: the charitable remainder</>}
				/>
				<StatCard
					label="The programs' floor"
					value={`${programsPct}%`}
					sub={<>Everything left after the {adminPct}% admin ceiling, held no lower</>}
					tone="time"
				/>
				<StatCard
					label="Budgeted, not yet allocated"
					value={usd(phase.otherPrograms)}
					unit="/mo"
					sub="Other Programs: the dial to watch as the plan scales"
				/>
			</div>

			<div className="mt-12 prose prose-sm max-w-none prose-headings:mb-3">
				<h2>One pool, not buckets</h2>
				<p>
					No revenue line is reserved against a purpose. Storage and free access are reasons a line
					of income is fair, never a description of where its dollars go; if the lines were tied to
					purposes, the budget would be too small to do the job. What Anthers commits to is the
					outflow side: budgets per program, set in advance, published, changed openly.
					Administrative spending is held to no more than {adminPct}% of charitable revenue, which
					holds the programs to at least {programsPct}%, and within the programs a stated share (
					{accessShareOfPrograms}% of the programs, in this plan) funds Free Access: creative work
					free to experience, with an ad-free platform behind it, paid to the creators through the
					Time Pool Fund. Free Storage sits beside it as the second program, and {programsPct}% is
					the floor the budget cannot cross by construction.
				</p>
				<h2>Reading the drawing</h2>
				<p>
					Read it obligations-first. Card processing leaves at cost, paid to the processor at their
					published rate with nothing added. The creator pools leave next, because that was always
					the arrangement: half of what a supporter gives Anthers is that Badge's pool, paid to
					creators by the time spent with their work. What remains is what Anthers holds, and every
					ceiling in this page governs that remainder: administration may take up to {adminPct}% of
					it, and the rest is the programs'. The program breakdown below the pool is the publishable
					form of that policy: free access at its stated share, free storage for smaller creators at
					what it actually costs, and the rest budgeted but not yet allocated.
				</p>
				<h2>What the drawing leaves out</h2>
				<p>
					Two flows never appear above, and both absences are choices rather than gaps. Storage
					top-ups pass through at cost: every byte past a Badge's allowance is charged at the
					provider's own rate with no mark-up, so those dollars fund nothing, and there is no strand
					for them to honestly occupy. And when a donor restricts a gift to a purpose, that
					restriction is binding in a way nothing Anthers writes about its own budget is; the
					donation channel is not built yet, so the strand has nothing to draw today. It will draw
					as what it is when it exists: one anomalous line bypassing the pool entirely, going only
					where the donor directed it, the single exception to everything above.
				</p>
				<h2>Targets, not actuals</h2>
				<p>
					Nothing above reports money that has moved. These are the targets and estimates of the
					current plan, drawn across its growth phases from a launch of one thousand accounts to
					nine times that, at a modeled {payingSharePct}% paying share. Reporting actual spending
					against them belongs to operating history; Anthers has launch months rather than years,
					and so the drawing is a promise made in public rather than an account rendered. The
					promise is the shape above and the ceilings that bound it: {adminPct}% to run the
					organization or less,
					{programsPct}% to its programs or more, and the mix between the programs set out where
					everyone can read it.
				</p>
			</div>

			<CalcNotes>
				<p>
					Every figure on this page is generated from the plan math in the repository&rsquo;s shared
					library, the same ledger the admin console edits; the generated figures file carries the
					whole path, and the build fails if a figure and its source ever disagree. Free accounts
					give nothing by design, so their strand is zero; the Badge rungs reflect the modeled mix
					of support sizes, and the &ldquo;+&rdquo; beyond the top rung is upside the model leaves
					out. The plan itself is targets: figures regenerate if the plan changes, and nothing here
					should be read as a report of money that has already moved.
				</p>
			</CalcNotes>
		</div>
	);
}

function inflowTotal(phase: PhaseFigure): number {
	return phase.inflows.reduce((a, i) => a + i.given, 0);
}
