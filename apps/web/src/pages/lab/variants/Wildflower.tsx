// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant — "Wildflower": a vivid meadow in bloom. Cheerful, saturated pops of
// poppy red (accent), cornflower blue (secondary), and buttercup yellow
// (warning) scattered over garden green (primary). Fraunces display over
// Nunito Sans, wavy organic section dividers, colorful rounded pills, and a
// four-bloom badge ladder. Energetic — but the big areas stay calm so the
// color reads as joyful, not loud.

import type { ReactNode } from "react";
import {
	ANTHERS_GATES,
	BADGE_RANKS,
	BOOST_GATES,
	DELIVERY_CONTROLS,
	FONTS,
	FREE_INCLUDES,
	type Mode,
	type Palette,
	POOLS,
	PRICING_MODELS,
	paletteVars,
	SEG_BG,
	SPROUT_BREAKDOWN,
	THREE_WAYS,
} from "../kit";

const LIGHT: Palette = {
	"base-100": "oklch(98.5% 0.014 118)",
	"base-200": "oklch(96% 0.022 125)",
	"base-300": "oklch(91.5% 0.032 130)",
	"base-content": "oklch(29% 0.06 150)",
	primary: "oklch(57% 0.14 150)",
	"primary-content": "oklch(98% 0.02 120)",
	secondary: "oklch(60% 0.14 262)",
	"secondary-content": "oklch(98% 0.02 262)",
	accent: "oklch(62% 0.19 30)",
	"accent-content": "oklch(98% 0.02 30)",
	neutral: "oklch(33% 0.05 150)",
	"neutral-content": "oklch(96% 0.02 120)",
	info: "oklch(60% 0.13 255)",
	success: "oklch(58% 0.14 150)",
	warning: "oklch(84% 0.15 92)",
	error: "oklch(60% 0.19 28)",
};
const DARK: Palette = {
	"base-100": "oklch(21% 0.035 205)",
	"base-200": "oklch(24.5% 0.04 205)",
	"base-300": "oklch(29% 0.045 208)",
	"base-content": "oklch(93% 0.03 110)",
	primary: "oklch(76% 0.16 150)",
	"primary-content": "oklch(20% 0.05 150)",
	secondary: "oklch(72% 0.13 260)",
	"secondary-content": "oklch(18% 0.05 260)",
	accent: "oklch(68% 0.18 30)",
	"accent-content": "oklch(20% 0.04 30)",
	neutral: "oklch(30% 0.035 205)",
	"neutral-content": "oklch(93% 0.03 110)",
	info: "oklch(70% 0.13 255)",
	success: "oklch(74% 0.15 150)",
	warning: "oklch(85% 0.14 92)",
	error: "oklch(68% 0.18 30)",
};

const display = { fontFamily: FONTS.fraunces };

// Rotating "bloom" tints — literal class strings only (Tailwind can't build
// `bg-${x}`), so every colorway is spelled out in full.
const EYEBROW_TONE = {
	primary: "bg-primary/12 text-primary",
	accent: "bg-accent/12 text-accent",
	secondary: "bg-secondary/12 text-secondary",
} as const;
const DOT_TONE = {
	primary: "bg-primary",
	accent: "bg-accent",
	secondary: "bg-secondary",
} as const;
type Tone = keyof typeof EYEBROW_TONE;

const WAY_TONE = [
	{ blob: "bg-primary/15 text-primary", ring: "ring-primary/25" },
	{ blob: "bg-accent/15 text-accent", ring: "ring-accent/25" },
	{ blob: "bg-secondary/15 text-secondary", ring: "ring-secondary/25" },
] as const;

// Root → Sprout → Petal → Blossom, as a buttercup→green→poppy→cornflower run.
const BADGE_TONE = [
	{ blob: "bg-warning/25", ring: "ring-warning/50", tag: "bg-warning/20 text-base-content/80" },
	{ blob: "bg-primary/15", ring: "ring-primary/40", tag: "bg-primary/12 text-primary" },
	{ blob: "bg-accent/15", ring: "ring-accent/40", tag: "bg-accent/12 text-accent" },
	{ blob: "bg-secondary/15", ring: "ring-secondary/40", tag: "bg-secondary/12 text-secondary" },
] as const;

const CTRL_DOT = ["bg-primary", "bg-accent", "bg-secondary", "bg-warning"] as const;

export default function Wildflower({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;
	const bg =
		mode === "light"
			? "radial-gradient(80% 50% at 15% 0%, oklch(95% 0.05 120) 0%, rgba(0,0,0,0) 50%), radial-gradient(70% 50% at 85% 10%, oklch(94% 0.06 262) 0%, rgba(0,0,0,0) 45%), var(--color-base-100)"
			: "radial-gradient(80% 50% at 15% 0%, oklch(28% 0.07 150) 0%, rgba(0,0,0,0) 50%), radial-gradient(70% 50% at 85% 10%, oklch(27% 0.08 262) 0%, rgba(0,0,0,0) 45%), var(--color-base-100)";

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.nunito })}
			className="min-h-screen text-base-content"
		>
			{/* Hero */}
			<header className="relative overflow-hidden">
				<div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-24 pb-16 md:grid-cols-[1.15fr_0.85fr] md:pt-28 md:pb-24">
					<div>
						<span className="inline-flex items-center gap-2 rounded-full bg-primary/12 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
							<span aria-hidden="true">🌼</span>
							For everyone who reads, watches, plays &amp; listens
						</span>
						<h1
							style={display}
							className="mt-6 text-balance text-5xl font-light leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl"
						>
							A whole <span className="font-medium text-accent not-italic">meadow of makers</span>
							—and a fair way to{" "}
							<span className="font-medium text-secondary not-italic">love every one</span>.
						</h1>
						<p className="mt-6 max-w-xl text-lg leading-relaxed text-base-content/75">
							Games, films, albums, and books from thousands of independent creators—paid for out in
							the open, with no ads, no algorithm deciding for you, and not a cent skimmed off the
							top. Pull up a patch of sun and let's walk through how it works.
						</p>
						<div className="mt-8 flex flex-wrap gap-3">
							<button type="button" className="btn btn-primary rounded-full px-7">
								Start exploring
							</button>
							<button
								type="button"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								Create a free account
							</button>
						</div>
						<p className="mt-5 text-sm text-base-content/50">
							No account needed to browse, download free work, or play web games.
						</p>
					</div>

					{/* A little bouquet — soft colored blooms, purely decorative */}
					<div aria-hidden="true" className="relative mx-auto hidden h-72 w-72 shrink-0 md:block">
						<span className="absolute left-2 top-6 flex h-24 w-24 rotate-[-8deg] items-center justify-center rounded-[42%] bg-accent/15 text-5xl ring-1 ring-accent/20">
							🌷
						</span>
						<span className="absolute right-3 top-0 flex h-20 w-20 rotate-[10deg] items-center justify-center rounded-[45%] bg-secondary/15 text-4xl ring-1 ring-secondary/20">
							🪻
						</span>
						<span className="absolute right-8 bottom-10 flex h-28 w-28 rotate-[6deg] items-center justify-center rounded-[44%] bg-warning/25 text-6xl ring-1 ring-warning/30">
							🌻
						</span>
						<span className="absolute left-6 bottom-2 flex h-20 w-20 rotate-[-6deg] items-center justify-center rounded-[45%] bg-primary/15 text-4xl ring-1 ring-primary/20">
							🌿
						</span>
						<span className="absolute left-24 top-28 flex h-16 w-16 items-center justify-center rounded-[46%] bg-base-200 text-3xl ring-1 ring-base-content/10">
							🌸
						</span>
					</div>
				</div>
			</header>

			{/* Three ways */}
			<Band>
				<Intro
					tone="primary"
					eyebrow="How you'll use it"
					title={
						<>
							Three ways to dig in—and they{" "}
							<span className="font-medium text-primary">bloom together</span>
						</>
					}
				>
					Free use, one-time purchases, and ongoing support aren't rival plans to choose between.
					They're layers that grow alongside each other—mix them however, and in whatever order,
					suits you.
				</Intro>
				<div className="mt-12 grid gap-6 md:grid-cols-3">
					{THREE_WAYS.map((w, i) => {
						const t = WAY_TONE[i % WAY_TONE.length];
						return (
							<div
								key={w.step}
								className="rounded-[1.75rem] border border-base-content/10 bg-base-100 p-7 shadow-sm"
							>
								<div
									style={display}
									className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full text-xl font-semibold ring-1 ${t.blob} ${t.ring}`}
								>
									{w.step}
								</div>
								<h3 style={display} className="mb-2 text-xl font-medium">
									{w.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/70">{w.body}</p>
							</div>
						);
					})}
				</div>
			</Band>

			{/* ① Free */}
			<Band tint wave>
				<Intro
					tone="primary"
					eyebrow="① Free use"
					title={
						<>
							Free, and <span className="font-medium text-primary">always will be</span>
						</>
					}
				>
					The free tier isn't a trial you're meant to outgrow. It's a standing promise from the
					Anthers Foundation—a non-profit—that reaching wonderful work should never hinge on what
					you can pay.
				</Intro>
				<div className="mt-11 grid gap-6 md:grid-cols-2">
					<Card>
						<h3 style={display} className="mb-3 text-xl font-medium">
							🌿&nbsp; How free stays free
						</h3>
						<p className="text-sm leading-relaxed text-base-content/75">
							Every free tier is paid for by someone. On ad-funded platforms it's advertisers—which
							quietly makes <em className="not-italic text-accent">you</em> the product. Here, a
							free viewer's small bandwidth cost is covered by the Foundation's Subsidy pool—funded
							by the charity fee on paid Usage and shared across the whole community—so free access
							never rides on ads or your data.
						</p>
						<p className="mt-3 text-sm leading-relaxed text-base-content/75">
							Not one company hoarding a war chest, but the small real costs spread lightly across
							everyone who benefits. Free as in shared responsibility—the way a kinder internet
							ought to work.
						</p>
					</Card>
					<Card>
						<h3 style={display} className="mb-3 text-xl font-medium">
							🎁&nbsp; What a free account includes
						</h3>
						<ul className="flex flex-col gap-3 text-sm">
							{FREE_INCLUDES.map((f) => (
								<li key={f.text} className="flex gap-3">
									<span
										className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
											f.yes ? "bg-primary/15 text-primary" : "bg-base-300 text-base-content/40"
										}`}
									>
										{f.yes ? "✓" : "–"}
									</span>
									<span className="text-base-content/75">{f.text}</span>
								</li>
							))}
						</ul>
					</Card>
				</div>
			</Band>

			{/* ② One-time purchases */}
			<Band>
				<Intro
					tone="accent"
					eyebrow="② One-time purchases"
					title={
						<>
							Buy it once—the price is{" "}
							<span className="font-medium text-accent">what the creator gets</span>
						</>
					}
				>
					No ongoing plan required. Games, albums, films, books, and apps can be bought outright and
					are yours to keep. The listed price is exactly what the creator receives; the real costs
					are added on top and itemized, so you see every penny before you pay.
				</Intro>
				<div className="mt-11 grid gap-8 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-start">
					<div className="rounded-[1.75rem] border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
						<div className="mb-4 flex items-center justify-between gap-3">
							<span className="text-sm text-base-content/60">Example — a $17 indie game</span>
							<span className="rounded-full bg-primary/12 px-3 py-1 text-xs font-bold text-primary">
								Creator gets $17.00
							</span>
						</div>
						<dl className="flex flex-col gap-2.5 text-sm">
							<Line label="Game price → the creator" value="$17.00" strong />
							<Line label="Delivery — actual bandwidth" value="$0.06" />
							<Line label="Anthers Foundation — charity" value="$0.03" />
							<Line label="Card processing" value="$0.79" />
						</dl>
						<div className="mt-4 flex items-baseline justify-between border-t border-base-content/10 pt-3">
							<span style={display} className="text-lg font-medium">
								You pay
							</span>
							<span style={display} className="text-lg font-medium text-accent">
								$17.88
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/55">
							Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps $0. Pay from
							your bank and processing shrinks to about 0.8%.
						</p>
					</div>
					<div>
						<p className="text-sm font-semibold uppercase tracking-wider text-base-content/45">
							However a creator wants to price it
						</p>
						<div className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
							{PRICING_MODELS.map((m, i) => (
								<div key={m.title} className="flex gap-4 rounded-2xl bg-base-200 p-5 text-left">
									<span
										className={`mt-1 h-8 w-1.5 shrink-0 rounded-full ${DOT_TONE[(["primary", "accent", "secondary"] as const)[i % 3]]}`}
									/>
									<div>
										<p style={display} className="mb-1 font-medium">
											{m.title}
										</p>
										<p className="text-xs leading-relaxed text-base-content/65">{m.body}</p>
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</Band>

			{/* ③ Support */}
			<Band tint wave>
				<Intro
					tone="secondary"
					eyebrow="③ Support, split transparently"
					title={
						<>
							Support, split{" "}
							<span className="font-medium text-secondary">right out in the open</span>
						</>
					}
				>
					The third way—and where most creators earn the most. Two independent, prepaid choices: buy
					Usage for open, watch-anything access (it funds the Time Pool), and send Boosts in $1
					units that go 100% to the creators you pick. The split is the same at every amount, and
					nothing's hidden.
				</Intro>

				<div className="mt-11 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
					<Card>
						<div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
							<h3 style={display} className="text-lg font-medium">
								{SPROUT_BREAKDOWN.heading}
							</h3>
							<span className="rounded-full bg-base-200 px-3 py-1 text-xs text-base-content/60">
								{SPROUT_BREAKDOWN.sub}
							</span>
						</div>
						<div className="mb-4 flex h-4 overflow-hidden rounded-full ring-1 ring-base-content/10">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
							))}
						</div>
						<dl className="flex flex-col gap-2 text-sm">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className="flex items-center justify-between gap-3">
									<span className="flex items-center gap-2 text-base-content/75">
										<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEG_BG[r.token]}`} />
										{r.label}
									</span>
									<span className="font-mono font-medium">{r.amount}</span>
								</div>
							))}
						</dl>
						<div className="mt-4 flex items-baseline justify-between rounded-2xl bg-primary/10 px-4 py-3">
							<span className="font-semibold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
							<span style={display} className="text-xl font-medium text-primary">
								{SPROUT_BREAKDOWN.toCreators}
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/50">
							{SPROUT_BREAKDOWN.footnote}
						</p>
					</Card>

					<div className="flex flex-col gap-5">
						{POOLS.map((p, i) => (
							<div
								key={p.title}
								className="rounded-[1.75rem] border border-base-content/10 bg-base-100 p-6 shadow-sm"
							>
								<span
									className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
										i === 0 ? EYEBROW_TONE.primary : EYEBROW_TONE.secondary
									}`}
								>
									<span
										className={`h-1.5 w-1.5 rounded-full ${i === 0 ? DOT_TONE.primary : DOT_TONE.secondary}`}
									/>
									{p.eyebrow}
								</span>
								<h3 style={display} className="mt-3 mb-2 text-xl font-medium">
									{p.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/75">{p.body}</p>
							</div>
						))}
					</div>
				</div>
			</Band>

			{/* Badge ladder */}
			<Band>
				<Intro
					tone="accent"
					eyebrow="Your standing"
					title={
						<>
							Your Anthers Badge—a{" "}
							<span className="font-medium text-accent">rank that grows with you</span>
						</>
					}
				>
					Not a plan you pick or a tier you subscribe to—a rolling rank earned from your combined
					Usage&nbsp;+&nbsp;Boost spend over the last few months. Everyone starts unranked; your
					first $3 earns Root; keep supporting and you climb, ease off and it gently recedes.
				</Intro>
				<div className="mt-12 grid grid-cols-2 gap-5 md:grid-cols-4">
					{BADGE_RANKS.map((b, i) => {
						const t = BADGE_TONE[i % BADGE_TONE.length];
						return (
							<div
								key={b.name}
								className="rounded-[1.75rem] border border-base-content/10 bg-base-100 p-6 text-center shadow-sm"
							>
								<div
									className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[42%] text-3xl ring-1 ${t.blob} ${t.ring}`}
								>
									<span aria-hidden="true">{b.emoji}</span>
								</div>
								<h3 style={display} className="text-lg font-medium">
									{b.name}
								</h3>
								<span
									className={`mt-2 inline-block rounded-full px-3 py-0.5 font-mono text-xs font-bold ${t.tag}`}
								>
									{b.threshold}
								</span>
								<p className="mt-3 text-xs leading-relaxed text-base-content/60">{b.flavor}</p>
							</div>
						);
					})}
				</div>
				<p className="mx-auto mt-8 max-w-2xl text-center text-sm text-base-content/55">
					Your badge reflects the last few months, so it moves with you—and some creators use it as
					a key, opening whole ranks of content at once. That's an Anthers Gate.
				</p>
			</Band>

			{/* Gates */}
			<Band tint wave>
				<Intro
					tone="secondary"
					eyebrow="Unlocking more"
					title={
						<>
							Two clear ways to <span className="font-medium text-secondary">unlock more</span>
						</>
					}
				>
					Some creators tuck premium work behind a gate. There are exactly two kinds—one based on
					your support for a single creator, one based on your standing across the whole platform.
				</Intro>
				<div className="mt-11 grid gap-6 md:grid-cols-2">
					<Card>
						<span className="inline-flex items-center gap-2 rounded-full bg-accent/12 px-3 py-1 text-xs font-bold uppercase tracking-wider text-accent">
							<span className="h-1.5 w-1.5 rounded-full bg-accent" />
							Boost Gates
						</span>
						<h3 style={display} className="mt-3 mb-3 text-xl font-medium">
							Based on your support for one creator
						</h3>
						{BOOST_GATES.map((g) => (
							<GateRow key={g.name} {...g} tone="accent" />
						))}
					</Card>
					<Card>
						<span className="inline-flex items-center gap-2 rounded-full bg-secondary/12 px-3 py-1 text-xs font-bold uppercase tracking-wider text-secondary">
							<span className="h-1.5 w-1.5 rounded-full bg-secondary" />
							Anthers Gates
						</span>
						<h3 style={display} className="mt-3 mb-3 text-xl font-medium">
							Based on your standing across the platform
						</h3>
						{ANTHERS_GATES.map((g) => (
							<GateRow key={g.name} {...g} tone="secondary" />
						))}
					</Card>
				</div>
			</Band>

			{/* Delivery */}
			<Band>
				<Intro
					tone="primary"
					eyebrow="Bandwidth, in the sunlight"
					title={
						<>
							Pay for what you use—and <span className="font-medium text-primary">keep it low</span>
						</>
					}
				>
					Streaming and downloads cost bandwidth. Every other platform buries that in ads or a
					platform cut. Anthers shows it, at cost, as a line in your Usage—and hands you real tools
					to keep it small.
				</Intro>
				<div className="mt-10 flex flex-col gap-3 rounded-[1.75rem] bg-primary/10 p-7 sm:flex-row sm:items-center sm:gap-6">
					<span className="text-5xl" aria-hidden="true">
						🌼
					</span>
					<p className="leading-relaxed">
						<span style={display} className="text-xl font-medium text-primary">
							Your first 3 GiB each month is free
						</span>
						<span className="text-base-content/75">
							{" "}
							—covered by the Foundation. Beyond that, Usage is just $0.03/GiB, a third of it real
							bandwidth at cost.
						</span>
					</p>
				</div>
				<div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
					{DELIVERY_CONTROLS.map((c, i) => (
						<div
							key={c.title}
							className="rounded-2xl border border-base-content/10 bg-base-100 p-5 shadow-sm"
						>
							<span
								className={`mb-3 block h-2.5 w-2.5 rounded-full ${CTRL_DOT[i % CTRL_DOT.length]}`}
							/>
							<h3 style={display} className="mb-1.5 font-medium">
								{c.title}
							</h3>
							<p className="text-xs leading-relaxed text-base-content/65">{c.body}</p>
						</div>
					))}
				</div>
			</Band>

			{/* Closing */}
			<div className="relative">
				<Wave />
				<section className="bg-base-200">
					<div className="mx-auto max-w-2xl px-6 py-24 text-center">
						<div className="mb-5 text-4xl" aria-hidden="true">
							🌷 🌻 🌸
						</div>
						<h2
							style={display}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Come help the whole meadow <span className="font-medium text-accent">bloom</span>
						</h2>
						<p className="mx-auto mt-5 max-w-xl leading-relaxed text-base-content/75">
							Back the creators you love on terms you can see and trust, and discover a hundred more
							along the way. Browse the whole catalog free—no account needed to start.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<button type="button" className="btn btn-primary rounded-full px-7">
								Browse projects
							</button>
							<button
								type="button"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								Create a free account
							</button>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}

// ─── Local building blocks ───

/** Soft, organic wave divider filled with the base-200 band color. */
function Wave({ flip = false }: { flip?: boolean }) {
	const d = flip
		? "M0,0 L1440,0 L1440,46 C1200,14 960,62 720,30 C480,-2 240,74 0,38 Z"
		: "M0,38 C240,74 480,-2 720,30 C960,62 1200,14 1440,46 L1440,80 L0,80 Z";
	return (
		<svg
			viewBox="0 0 1440 80"
			preserveAspectRatio="none"
			aria-hidden="true"
			className="block h-12 w-full sm:h-16"
		>
			<title>Wildflower divider</title>
			<path d={d} style={{ fill: "var(--color-base-200)" }} />
		</svg>
	);
}

/** A page band. `tint` gives it the soft base-200 wash; `wave` adds organic edges. */
function Band({ children, tint, wave }: { children: ReactNode; tint?: boolean; wave?: boolean }) {
	const inner = <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">{children}</div>;
	if (!tint) return <section>{inner}</section>;
	return (
		<div>
			{wave && <Wave />}
			<section className="bg-base-200">{inner}</section>
			{wave && <Wave flip />}
		</div>
	);
}

function Intro({
	tone,
	eyebrow,
	title,
	children,
}: {
	tone: Tone;
	eyebrow: string;
	title: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="max-w-3xl">
			<span
				className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider ${EYEBROW_TONE[tone]}`}
			>
				<span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} />
				{eyebrow}
			</span>
			<h2
				style={display}
				className="mt-4 text-balance text-4xl font-light leading-[1.08] tracking-tight sm:text-5xl"
			>
				{title}
			</h2>
			{children && (
				<p className="mt-5 max-w-2xl text-lg leading-relaxed text-base-content/70">{children}</p>
			)}
		</div>
	);
}

function Card({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-[1.75rem] border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
			{children}
		</div>
	);
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className={strong ? "font-medium" : "text-base-content/70"}>{label}</span>
			<span className={`font-mono ${strong ? "font-medium" : "text-base-content/70"}`}>
				{value}
			</span>
		</div>
	);
}

function GateRow({
	amount,
	name,
	perk,
	tone,
}: {
	amount: string;
	name: string;
	perk: string;
	tone: Tone;
}) {
	return (
		<div className="flex items-center gap-3 border-t border-base-content/10 py-2.5 first:border-t-0">
			<span
				className={`w-11 shrink-0 rounded-full text-center font-mono text-xs font-bold ${EYEBROW_TONE[tone]} py-0.5`}
			>
				{amount}
			</span>
			<span style={display} className="w-24 shrink-0 font-medium">
				{name}
			</span>
			<span className="text-xs text-base-content/60">{perk}</span>
		</div>
	);
}
