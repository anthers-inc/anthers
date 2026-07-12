// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant 1 — "Meadow": airy editorial, foresty green + soft yellow.
// Fraunces display serif over Nunito Sans, generous whitespace, hairline rules.

import { BrandGlyph, grassFloorDataUri, pollenDataUri, Sprig, vineTileDataUri } from "../botanical";
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
	"base-100": "oklch(98.6% 0.012 96)",
	"base-200": "oklch(96.2% 0.022 98)",
	"base-300": "oklch(91.5% 0.035 102)",
	"base-content": "oklch(31% 0.05 155)",
	primary: "oklch(49% 0.11 152)",
	"primary-content": "oklch(98% 0.02 110)",
	secondary: "oklch(84% 0.13 92)",
	"secondary-content": "oklch(32% 0.06 88)",
	accent: "oklch(69% 0.14 74)",
	"accent-content": "oklch(24% 0.05 74)",
	neutral: "oklch(36% 0.04 150)",
	"neutral-content": "oklch(96% 0.02 100)",
	info: "oklch(62% 0.09 220)",
	success: "oklch(57% 0.13 150)",
	warning: "oklch(80% 0.14 85)",
	error: "oklch(57% 0.17 28)",
};

const DARK: Palette = {
	"base-100": "oklch(22% 0.028 158)",
	"base-200": "oklch(25.5% 0.03 158)",
	"base-300": "oklch(30% 0.033 158)",
	"base-content": "oklch(93% 0.03 96)",
	primary: "oklch(75% 0.15 150)",
	"primary-content": "oklch(20% 0.05 150)",
	secondary: "oklch(86% 0.13 94)",
	"secondary-content": "oklch(24% 0.05 88)",
	accent: "oklch(79% 0.13 76)",
	"accent-content": "oklch(22% 0.05 76)",
	neutral: "oklch(31% 0.03 158)",
	"neutral-content": "oklch(93% 0.03 96)",
	info: "oklch(70% 0.1 220)",
	success: "oklch(73% 0.14 150)",
	warning: "oklch(83% 0.13 88)",
	error: "oklch(66% 0.16 28)",
};

const serif = { fontFamily: FONTS.fraunces };

export default function Meadow({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;

	// "Pollen in the air" texture over the base surface (no top radial gradient).
	const pollen = pollenDataUri(mode === "light" ? "oklch(72% 0.12 92)" : "oklch(86% 0.13 95)");
	const bg = `url("${pollen}") repeat, var(--color-base-100)`;

	// A repeating vine — foliage green, blooms in the soft yellow, amber bees — that
	// scrolls with the page and springs from the grass floor at the bottom.
	const vineStyle = {
		backgroundImage: `url("${vineTileDataUri({
			stem: pal.primary,
			flower: pal.secondary,
			core: pal.accent,
			bee: pal.accent,
		})}")`,
		backgroundRepeat: "repeat-y",
		backgroundSize: "100% auto",
		backgroundPosition: "center top",
		opacity: mode === "dark" ? 0.75 : 0.62,
	};

	// Grassy/flowery floor the vines spring out of, tiled across the very bottom.
	const floorStyle = {
		backgroundImage: `url("${grassFloorDataUri({
			grass: pal.primary,
			flower: pal.secondary,
			core: pal.accent,
		})}")`,
		backgroundRepeat: "repeat-x",
		backgroundSize: "auto 100%",
		backgroundPosition: "left bottom",
		opacity: mode === "dark" ? 0.7 : 0.55,
	};

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.nunito })}
			className="relative min-h-screen text-base-content"
		>
			{/* Botanical side vines — a repeating stem that scrolls with the page,
				framing the centered content on wide screens */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 left-0 z-0 hidden w-28 xl:block"
				style={vineStyle}
			/>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 right-0 z-0 hidden w-28 -scale-x-100 xl:block"
				style={vineStyle}
			/>
			{/* Grassy floor across the very bottom */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-44"
				style={floorStyle}
			/>

			<div className="relative z-10">
				{/* Hero */}
				<header className="mx-auto max-w-5xl px-6 pt-28 pb-20 text-center">
					<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
					<p className="mb-5 text-sm font-semibold uppercase tracking-[0.25em] text-primary">
						For&nbsp;Readers, Players &amp; Listeners
					</p>
					<h1
						style={serif}
						className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
					>
						Somewhere your money can{" "}
						<em className="font-medium text-primary not-italic">actually grow something</em>.
					</h1>
					<p className="mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-base-content/70">
						Anthers is planted by the people who use it—not advertisers. You pay creators directly,
						pay only for what you use, and keep the relationships you grow. No ads, no algorithm, no
						hidden cut. Here's how it works.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
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
					<p className="mt-6 text-sm text-base-content/45">
						No account needed to browse, download free work, or play web games.
					</p>
					<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
				</header>

				{/* Three ways */}
				<Section>
					<Eyebrow>How you'll use it</Eyebrow>
					<H2>Three ways in, and you combine them</H2>
					<Lede>
						Free use, one-time purchases, and ongoing support. These aren't rival plans to pick
						between—they're layers you grow into, in any order that suits you.
					</Lede>
					<div className="mt-14 grid gap-8 sm:grid-cols-3">
						{THREE_WAYS.map((w) => (
							<div key={w.step} className="text-center">
								<div
									style={serif}
									className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-2xl font-semibold text-primary"
								>
									{w.step}
								</div>
								<h3 style={serif} className="mb-2 text-xl font-medium">
									{w.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/65">{w.body}</p>
							</div>
						))}
					</div>
				</Section>

				{/* Free */}
				<Section tint>
					<Eyebrow>① Free use</Eyebrow>
					<H2>Free, and always will be</H2>
					<Lede>
						The free tier isn't a trial you're meant to grow out of. It's a standing promise from
						the Anthers Foundation—a non-profit—that reaching creative work shouldn't depend on your
						ability to pay.
					</Lede>
					<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
						<Card>
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🌿&nbsp; How free stays free
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Every free tier is paid for by someone. On ad-funded platforms it's
								advertisers—which makes you the product. Here, a free viewer's small bandwidth cost
								is covered by the Foundation's Subsidy pool—funded by the charity fee on paid Usage
								and shared across the whole community—so free access never rides on ads or your
								data.
							</p>
							<p className="mt-3 text-sm leading-relaxed text-base-content/70">
								Not one company hoarding a war chest, but the small real costs diffused across
								everyone who benefits. Free-as-in-shared-responsibility—the way a healthier internet
								ought to work.
							</p>
						</Card>
						<Card>
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎁&nbsp; What a free account includes
							</h3>
							<ul className="flex flex-col gap-2.5 text-sm">
								{FREE_INCLUDES.map((f) => (
									<li key={f.text} className="flex gap-2.5">
										<span
											className={`mt-0.5 shrink-0 font-semibold ${f.yes ? "text-primary" : "text-base-content/30"}`}
										>
											{f.yes ? "✓" : "–"}
										</span>
										<span className="text-base-content/70">{f.text}</span>
									</li>
								))}
							</ul>
						</Card>
					</div>
				</Section>

				{/* One-time purchases */}
				<Section>
					<Eyebrow>② One-time purchases</Eyebrow>
					<H2>Buy it once—the price is what the creator gets</H2>
					<Lede>
						No ongoing plan needed. Games, albums, films, books, and apps can be bought
						outright—yours to keep. The listed price is exactly what the creator receives; real
						costs are added on top and itemized, so you see every penny first.
					</Lede>
					<div className="mx-auto mt-12 max-w-lg">
						<Card>
							<div className="mb-4 flex items-baseline justify-between">
								<span className="text-sm text-base-content/55">Example — a $17 indie game</span>
								<span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
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
								<span style={serif} className="text-lg font-medium">
									You pay
								</span>
								<span style={serif} className="text-lg font-medium">
									$17.88
								</span>
							</div>
							<p className="mt-3 text-xs leading-relaxed text-base-content/50">
								Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps $0. Pay
								from your bank and processing shrinks to about 0.8%.
							</p>
						</Card>
					</div>
					<div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-3">
						{PRICING_MODELS.map((m) => (
							<div key={m.title} className="rounded-2xl bg-base-200/60 p-5 text-center">
								<p style={serif} className="mb-1 font-medium text-primary">
									{m.title}
								</p>
								<p className="text-xs leading-relaxed text-base-content/60">{m.body}</p>
							</div>
						))}
					</div>
				</Section>

				{/* Support */}
				<Section tint>
					<Eyebrow>③ Support, split transparently</Eyebrow>
					<H2>Support, split so you can see every seed</H2>
					<Lede>
						The third way—and where most creators earn the most. Two independent choices: buy Usage
						for open, watch-anything access, and send Boosts a dollar at a time. The split is the
						same at every amount, and nothing's hidden.
					</Lede>

					<div className="mx-auto mt-12 max-w-2xl">
						<Card>
							<div className="mb-4 flex items-baseline justify-between">
								<h3 style={serif} className="text-lg font-medium">
									{SPROUT_BREAKDOWN.heading}
								</h3>
								<span className="text-sm text-base-content/50">{SPROUT_BREAKDOWN.sub}</span>
							</div>
							<div className="mb-4 flex h-3 overflow-hidden rounded-full">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
								))}
							</div>
							<dl className="flex flex-col gap-2 text-sm">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className="flex items-center justify-between gap-3">
										<span className="flex items-center gap-2 text-base-content/70">
											<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEG_BG[r.token]}`} />
											{r.label}
										</span>
										<span className="font-medium">{r.amount}</span>
									</div>
								))}
							</dl>
							<div className="mt-4 flex items-baseline justify-between border-t border-base-content/10 pt-3">
								<span className="font-semibold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
								<span style={serif} className="text-lg font-medium text-primary">
									{SPROUT_BREAKDOWN.toCreators}
								</span>
							</div>
							<p className="mt-3 text-xs leading-relaxed text-base-content/45">
								{SPROUT_BREAKDOWN.footnote}
							</p>
						</Card>
					</div>

					<div className="mx-auto mt-8 grid max-w-3xl gap-6 md:grid-cols-2">
						{POOLS.map((p) => (
							<Card key={p.title}>
								<p className="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/45">
									{p.eyebrow}
								</p>
								<h3 style={serif} className="mb-2 text-xl font-medium">
									{p.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/70">{p.body}</p>
							</Card>
						))}
					</div>
				</Section>

				{/* Badge ladder */}
				<Section>
					<Eyebrow>Your standing</Eyebrow>
					<H2>An Anthers Badge—a rank that grows with you</H2>
					<Lede>
						Everything you spend—Usage and Boosts alike—earns a badge. Not a plan you pick or a tier
						you subscribe to: a rank you grow into, like a plant reaching for light. Support more
						and you climb; ease off and it gently recedes.
					</Lede>
					<div className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-6 md:grid-cols-4">
						{BADGE_RANKS.map((b, i) => (
							<div key={b.name} className="relative text-center">
								<div className="relative mx-auto mb-3 flex h-24 w-24 items-center justify-center">
									<BrandGlyph
										name="wreath"
										className="absolute inset-0 h-full w-full text-primary/50"
									/>
									<span aria-hidden="true" className="text-4xl">
										{b.emoji}
									</span>
								</div>
								<h3 style={serif} className="text-lg font-medium">
									{b.name}
								</h3>
								<p className="mt-0.5 font-mono text-xs text-primary">{b.threshold}</p>
								<p className="mt-1.5 text-xs leading-relaxed text-base-content/55">{b.flavor}</p>
								{i < BADGE_RANKS.length - 1 && (
									<span className="pointer-events-none absolute -right-3 top-8 hidden text-base-content/25 md:block">
										→
									</span>
								)}
							</div>
						))}
					</div>
					<p className="mx-auto mt-8 max-w-2xl text-center text-sm text-base-content/50">
						Everyone starts unranked; your first $3 of combined Usage&nbsp;+&nbsp;Boost earns Root.
						Your badge reflects the last few months, so it moves with you—and some creators use it
						as a key, opening whole ranks of content at once.
					</p>
				</Section>

				{/* Gates */}
				<Section tint>
					<Eyebrow>Unlocking more</Eyebrow>
					<H2>Two clear ways to open a gate</H2>
					<Lede>
						Some creators put premium work behind a gate. There are exactly two kinds—one for your
						support of a single creator, one for your standing across the whole platform.
					</Lede>
					<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
						<Card>
							<p className="text-xs font-semibold uppercase tracking-wider text-primary/80">
								For one creator
							</p>
							<h3 style={serif} className="mb-4 text-xl font-medium">
								Boost Gates
							</h3>
							{BOOST_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Card>
						<Card>
							<p className="text-xs font-semibold uppercase tracking-wider text-accent">
								Across the platform
							</p>
							<h3 style={serif} className="mb-4 text-xl font-medium">
								Anthers Gates
							</h3>
							{ANTHERS_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Card>
					</div>
				</Section>

				{/* Delivery */}
				<Section>
					<Eyebrow>Bandwidth, in the open</Eyebrow>
					<H2>Pay for what you use—and keep it low</H2>
					<Lede>
						Streaming and downloads cost bandwidth. Every other platform buries that cost in ads or
						a platform cut. Anthers shows it, at cost, as a line in your Usage—so you get real tools
						to keep it small.
					</Lede>
					<div className="mx-auto mt-10 max-w-2xl rounded-3xl bg-primary/10 p-7 text-center">
						<p className="leading-relaxed">
							<span style={serif} className="text-xl font-medium text-primary">
								Your first 3 GiB each month is free
							</span>
							<span className="text-base-content/70">
								{" "}
								—covered by the Foundation. Beyond that, Usage is just $0.03/GiB, a third of it real
								bandwidth at cost.
							</span>
						</p>
					</div>
					<div className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-2 lg:grid-cols-4">
						{DELIVERY_CONTROLS.map((c) => (
							<div key={c.title} className="rounded-2xl border border-base-content/10 p-5">
								<h3 style={serif} className="mb-1.5 font-medium">
									{c.title}
								</h3>
								<p className="text-xs leading-relaxed text-base-content/60">{c.body}</p>
							</div>
						))}
					</div>
				</Section>

				{/* Closing */}
				<section className="mx-auto max-w-2xl px-6 py-28 text-center">
					<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
					<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						Plant something worth growing
					</h2>
					<p className="mx-auto mt-5 max-w-xl leading-relaxed text-base-content/70">
						Support the creators you love, on terms you can see and trust. Browse the whole catalog
						free—no account required to start.
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
				</section>
			</div>
		</div>
	);
}

// ─── Local building blocks ───

function Section({ children, tint }: { children: React.ReactNode; tint?: boolean }) {
	return (
		<section className={tint ? "bg-base-200/40" : ""}>
			<div className="mx-auto max-w-6xl px-6 py-24 text-center">{children}</div>
		</section>
	);
}

function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-primary/80">
			{children}
		</p>
	);
}

function H2({ children }: { children: React.ReactNode }) {
	return (
		<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
			{children}
		</h2>
	);
}

function Lede({ children }: { children: React.ReactNode }) {
	return (
		<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
			{children}
		</p>
	);
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-3xl border border-base-content/10 bg-base-100 p-7 text-left shadow-sm">
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

function GateRow({ amount, name, perk }: { amount: string; name: string; perk: string }) {
	return (
		<div className="flex items-center gap-3 border-t border-base-content/10 py-2.5 first:border-t-0">
			<span className="w-10 shrink-0 font-mono text-xs text-primary">{amount}</span>
			<span style={serif} className="w-24 shrink-0 font-medium">
				{name}
			</span>
			<span className="text-xs text-base-content/55">{perk}</span>
		</div>
	);
}
