// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant — "Herbarium": a naturalist's pressed-specimen album / botanical
// field guide. Each section is a numbered Plate; cards are specimens mounted on
// dashed frames with printed labels; Fraunces headings over a Spectral body,
// with Caveat scrawled in the margins. Warm parchment in light, teak in dark.

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
	"base-100": "oklch(96.5% 0.018 88)",
	"base-200": "oklch(93.5% 0.025 82)",
	"base-300": "oklch(89% 0.03 78)",
	"base-content": "oklch(30% 0.035 110)",
	primary: "oklch(45% 0.08 145)",
	"primary-content": "oklch(97% 0.02 90)",
	secondary: "oklch(66% 0.1 74)",
	"secondary-content": "oklch(26% 0.05 74)",
	accent: "oklch(58% 0.1 20)",
	"accent-content": "oklch(97% 0.02 20)",
	neutral: "oklch(34% 0.03 90)",
	"neutral-content": "oklch(95% 0.02 88)",
	info: "oklch(55% 0.08 230)",
	success: "oklch(52% 0.1 150)",
	warning: "oklch(72% 0.12 78)",
	error: "oklch(52% 0.15 28)",
};

const DARK: Palette = {
	"base-100": "oklch(23% 0.02 70)",
	"base-200": "oklch(26.5% 0.022 70)",
	"base-300": "oklch(31% 0.024 72)",
	"base-content": "oklch(90% 0.03 84)",
	primary: "oklch(70% 0.1 145)",
	"primary-content": "oklch(20% 0.04 145)",
	secondary: "oklch(78% 0.11 80)",
	"secondary-content": "oklch(24% 0.05 80)",
	accent: "oklch(66% 0.11 22)",
	"accent-content": "oklch(20% 0.04 22)",
	neutral: "oklch(30% 0.02 72)",
	"neutral-content": "oklch(90% 0.03 84)",
	info: "oklch(66% 0.09 230)",
	success: "oklch(68% 0.11 150)",
	warning: "oklch(80% 0.12 82)",
	error: "oklch(64% 0.15 28)",
};

const heading = { fontFamily: FONTS.fraunces };
const hand = { fontFamily: FONTS.caveat };

/** Mock-binomial species names for the four pressed badge specimens. */
const BADGE_LATIN = ["Radix", "Germen", "Petalum", "Flos"] as const;
/** Small botanical glyphs for the three-layer growing habit. */
const LAYER_GLYPH = ["🍃", "🌰", "🌱"] as const;

export default function Herbarium({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;
	const bg =
		mode === "light"
			? "radial-gradient(120% 80% at 50% 0%, oklch(97% 0.02 88) 0%, rgba(0,0,0,0) 60%), var(--color-base-100)"
			: "radial-gradient(120% 80% at 50% 0%, oklch(27% 0.03 72) 0%, rgba(0,0,0,0) 60%), var(--color-base-100)";

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.spectral })}
			className="min-h-screen text-base-content"
		>
			{/* ── Frontispiece / hero ── */}
			<header className="mx-auto max-w-6xl px-6 pt-24 pb-16">
				<p className="mb-6 text-xs font-semibold uppercase tracking-[0.32em] text-primary">
					The Anthers Herbarium
				</p>
				<div className="grid items-center gap-12 lg:grid-cols-[1.35fr_1fr]">
					<div>
						<h1
							style={heading}
							className="text-balance text-4xl font-normal leading-[1.08] sm:text-6xl"
						>
							A living collection, kept in the open—where the{" "}
							<em className="not-italic text-primary">grower keeps everything</em>.
						</h1>
						<p className="mt-6 max-w-xl text-lg leading-relaxed text-base-content/70">
							Anthers is a creator-first platform, catalogued like a field guide. You pay makers
							directly, pay only for what you use, and every figure is pressed flat and labelled for
							you to inspect. No ads, no algorithm, no cut for us. What follows are the plates.
						</p>
						<div className="mt-8 flex flex-wrap gap-3">
							<button type="button" className="btn btn-primary rounded-sm px-6">
								Enter the collection
							</button>
							<button
								type="button"
								className="btn btn-outline rounded-sm border-base-content/30 px-6"
							>
								Begin a free account
							</button>
						</div>
						<p className="mt-6 text-sm text-base-content/45">
							No account needed to browse, download free work, or play web games.
						</p>
					</div>

					{/* A mounted frontispiece specimen */}
					<figure className="relative mx-auto w-full max-w-xs rounded-sm border border-dashed border-base-content/35 bg-base-100/60 px-6 pt-8 pb-4 text-center shadow-sm">
						<span
							style={hand}
							className="-top-4 -rotate-3 absolute right-4 text-2xl text-accent/80"
						>
							pressed 2026
						</span>
						<div className="mx-auto flex h-28 w-28 items-center justify-center rounded-full border border-base-content/15 bg-base-200/50 text-6xl">
							<span aria-hidden="true">🌸</span>
						</div>
						<p style={heading} className="mt-5 text-xl">
							Anthers × Grower
						</p>
						<p className="mt-0.5 text-sm italic text-base-content/55">Communis hortus</p>
						<figcaption className="mt-5 flex items-center justify-between border-base-content/15 border-t pt-3 text-[10px] uppercase tracking-[0.22em] text-base-content/45">
							<span>Frontispiece</span>
							<span>Pl. 00</span>
						</figcaption>
					</figure>
				</div>
			</header>

			{/* ── Plate I — Three ways in ── */}
			<Plate
				no="I"
				title="Three specimens, one growing habit"
				latin="Usus tripartitus"
				lede="Free use, one-time purchase, and ongoing support are not rival plans to choose between. Like leaf, seed, and root, they are layers of a single plant—press them together in whatever order suits you."
				margin={
					<Marginalia side="right" top="6rem">
						combine, don't choose ✿
					</Marginalia>
				}
			>
				<div className="mt-12 grid gap-6 sm:grid-cols-3">
					{THREE_WAYS.map((w, i) => (
						<Specimen key={w.step} fig={`Pl. I · fig. ${w.step}`}>
							<div className="mb-3 flex items-center justify-between">
								<span className="text-3xl" aria-hidden="true">
									{LAYER_GLYPH[i]}
								</span>
								<span className="text-[10px] uppercase tracking-[0.22em] text-base-content/45">
									Layer {w.step}
								</span>
							</div>
							<h3 style={heading} className="mb-1.5 text-xl">
								{w.title}
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">{w.body}</p>
						</Specimen>
					))}
				</div>
			</Plate>

			{/* ── Plate II — Free ── */}
			<Plate
				no="II"
				tint
				title="Free, and always will be"
				latin="Gratis perpetuus"
				lede="The free tier is not a trial you're meant to outgrow. It is a standing promise from the Anthers Foundation—a non-profit—that reaching creative work should never depend on your ability to pay."
				margin={
					<Marginalia side="left" top="7rem">
						you are not the product
					</Marginalia>
				}
			>
				<div className="mt-12 grid gap-6 md:grid-cols-2">
					<Specimen fig="Pl. II · fig. 1">
						<h3 style={heading} className="mb-3 text-xl">
							🌿&nbsp; How free stays free
						</h3>
						<p className="text-sm leading-relaxed text-base-content/70">
							Every free tier is paid for by someone. On ad-funded platforms it is advertisers—which
							makes you the product. Here, a free viewer's small bandwidth cost is covered by the
							Foundation's Subsidy pool, funded by the charity fee on paid Usage and shared across
							the whole community—so free access never rides on ads or your data.
						</p>
						<p className="mt-3 text-sm leading-relaxed text-base-content/70">
							Not one company hoarding a war chest, but the small real costs diffused across
							everyone who benefits. Free as in shared responsibility—the way a healthier internet
							ought to be.
						</p>
					</Specimen>
					<Specimen fig="Pl. II · fig. 2">
						<h3 style={heading} className="mb-4 text-xl">
							🗂️&nbsp; In every free account
						</h3>
						<ul className="flex flex-col gap-2.5 text-sm">
							{FREE_INCLUDES.map((f) => (
								<li key={f.text} className="flex gap-2.5">
									<span
										className={`mt-0.5 shrink-0 font-semibold ${
											f.yes ? "text-primary" : "text-accent/60"
										}`}
										aria-hidden="true"
									>
										{f.yes ? "✓" : "–"}
									</span>
									<span className="text-base-content/70">{f.text}</span>
								</li>
							))}
						</ul>
					</Specimen>
				</div>
			</Plate>

			{/* ── Plate III — One-time purchases ── */}
			<Plate
				no="III"
				title="Buy it once—the price is what the grower gets"
				latin="Emptio singularis"
				lede="No ongoing plan required. Games, albums, films, books, and apps can be bought outright—yours to keep. The listed price is exactly what the creator receives; the small real costs are added on top and labelled, so you see every penny before you press buy."
				margin={
					<Marginalia side="right" top="7rem">
						Anthers keeps $0 →
					</Marginalia>
				}
			>
				<div className="mt-12 grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
					{/* The ledger specimen */}
					<figure className="relative rounded-sm border border-dashed border-base-content/30 bg-base-100/60 p-7 shadow-sm">
						<div className="mb-5 flex items-baseline justify-between gap-3">
							<span className="text-xs uppercase tracking-[0.22em] text-base-content/50">
								Specimen — a $17 indie game
							</span>
							<span className="shrink-0 border border-base-content/20 px-2 py-0.5 text-xs font-medium text-primary">
								Grower gets $17.00
							</span>
						</div>
						<dl className="flex flex-col gap-2.5 text-sm">
							<Line label="Game price → the creator" value="$17.00" strong />
							<Line label="Delivery — actual bandwidth" value="$0.06" />
							<Line label="Anthers Foundation — charity" value="$0.03" />
							<Line label="Card processing" value="$0.79" />
						</dl>
						<div className="mt-5 flex items-baseline justify-between border-base-content/20 border-t border-dashed pt-4">
							<span style={heading} className="text-lg">
								You pay
							</span>
							<span style={heading} className="text-lg">
								$17.88
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/55">
							Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps $0. Pay from
							your bank and processing shrinks to about 0.8%.
						</p>
						<figcaption className="mt-5 flex items-center justify-between border-base-content/15 border-t pt-3 text-[10px] uppercase tracking-[0.22em] text-base-content/45">
							<span>Anthers Herbarium</span>
							<span>Pl. III · fig. 1</span>
						</figcaption>
					</figure>

					{/* Pricing habits, as small mounted keys */}
					<div>
						<p className="mb-4 text-xs uppercase tracking-[0.22em] text-base-content/50">
							Three pricing habits observed
						</p>
						<div className="flex flex-col gap-4">
							{PRICING_MODELS.map((m, i) => (
								<div
									key={m.title}
									className="rounded-sm border border-base-content/20 border-dashed bg-base-100/40 p-4"
								>
									<div className="mb-1 flex items-baseline gap-2">
										<span className="text-[10px] uppercase tracking-[0.2em] text-base-content/40">
											{`${i + 1}`.padStart(2, "0")}
										</span>
										<p style={heading} className="text-base text-primary">
											{m.title}
										</p>
									</div>
									<p className="text-xs leading-relaxed text-base-content/65">{m.body}</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</Plate>

			{/* ── Plate IV — Support ── */}
			<Plate
				no="IV"
				tint
				title="Support, pressed flat so every part shows"
				latin="Sustentatio diaphana"
				lede="The third way—and where most creators earn the most. Two independent, prepaid choices: buy Usage for open, watch-anything access (which funds the Time Pool), and send Boosts a dollar at a time (100% to creators). The split is the same at every amount, and nothing is hidden."
				margin={
					<Marginalia side="right" top="6rem">
						a minute is a minute
					</Marginalia>
				}
			>
				<div className="mx-auto mt-12 max-w-2xl">
					<figure className="rounded-sm border border-dashed border-base-content/30 bg-base-100/60 p-7 shadow-sm">
						<div className="mb-5 flex items-baseline justify-between gap-3">
							<h3 style={heading} className="text-lg">
								{SPROUT_BREAKDOWN.heading}
							</h3>
							<span className="text-xs uppercase tracking-[0.18em] text-base-content/50">
								{SPROUT_BREAKDOWN.sub}
							</span>
						</div>
						<div className="mb-5 flex h-4 overflow-hidden rounded-sm border border-base-content/20">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
							))}
						</div>
						<dl className="flex flex-col gap-2 text-sm">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className="flex items-center justify-between gap-3">
									<span className="flex items-center gap-2 text-base-content/75">
										<span className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${SEG_BG[r.token]}`} />
										{r.label}
									</span>
									<span className="font-medium tabular-nums">{r.amount}</span>
								</div>
							))}
						</dl>
						<div className="mt-5 flex items-baseline justify-between border-base-content/20 border-t border-dashed pt-4">
							<span className="font-semibold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
							<span style={heading} className="text-lg text-primary">
								{SPROUT_BREAKDOWN.toCreators}
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/55">
							{SPROUT_BREAKDOWN.footnote}
						</p>
						<figcaption className="mt-5 flex items-center justify-between border-base-content/15 border-t pt-3 text-[10px] uppercase tracking-[0.22em] text-base-content/45">
							<span>Anthers Herbarium</span>
							<span>Pl. IV · fig. 1</span>
						</figcaption>
					</figure>
				</div>

				<div className="mx-auto mt-8 grid max-w-3xl gap-6 md:grid-cols-2">
					{POOLS.map((p, i) => (
						<Specimen key={p.title} fig={`Pl. IV · fig. ${i + 2}`}>
							<p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-secondary">
								{p.eyebrow}
							</p>
							<h3 style={heading} className="mb-2 text-xl">
								{p.title}
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">{p.body}</p>
						</Specimen>
					))}
				</div>
			</Plate>

			{/* ── Plate V — Badge ladder (four pressed specimens) ── */}
			<Plate
				no="V"
				title="A badge, pressed as it grows"
				latin="Insigne crescens"
				lede="Not a plan you pick or a tier you subscribe to—a rolling rank earned from your combined Usage and Boost spend over the last few months. Everyone starts unranked; your first $3 earns Root; ease off and it gently recedes. Some creators use it as a key—that's an Anthers Gate."
				margin={
					<Marginalia side="left" top="8rem">
						everyone starts unranked
					</Marginalia>
				}
			>
				<div className="mt-12 grid grid-cols-2 gap-5 md:grid-cols-4">
					{BADGE_RANKS.map((b, i) => (
						<figure
							key={b.name}
							className="relative flex flex-col items-center rounded-sm border border-dashed border-base-content/35 bg-base-100/60 px-4 pt-8 pb-4 text-center shadow-sm"
						>
							<span className="absolute top-2.5 left-3 text-[10px] uppercase tracking-[0.2em] text-base-content/40">
								No. {i + 1}
							</span>
							<div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full border border-base-content/15 bg-base-200/50 text-4xl">
								<span aria-hidden="true">{b.emoji}</span>
							</div>
							<h3 style={heading} className="text-lg">
								{b.name}
							</h3>
							<p className="text-xs italic text-base-content/50">{BADGE_LATIN[i]}</p>
							<span className="mt-2 inline-block border border-base-content/20 px-2 py-0.5 text-xs font-medium text-primary">
								{b.threshold}
							</span>
							<p className="mt-2.5 text-xs leading-relaxed text-base-content/60">{b.flavor}</p>
							<figcaption className="mt-4 w-full border-base-content/15 border-t pt-2.5 text-[10px] uppercase tracking-[0.18em] text-base-content/40">
								Anthers Herb.
							</figcaption>
						</figure>
					))}
				</div>
			</Plate>

			{/* ── Plate VI — Gates ── */}
			<Plate
				no="VI"
				tint
				title="Two keys to a locked drawer"
				latin="Duae claves"
				lede="Some growers keep premium work behind a gate. There are exactly two kinds of key—one cut from your support of a single creator, one from your standing across the whole platform."
			>
				<div className="mt-12 grid gap-6 md:grid-cols-2">
					<Specimen fig="Pl. VI · fig. 1">
						<p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary/80">
							Based on your support for one creator
						</p>
						<h3 style={heading} className="mb-4 text-xl">
							Boost Gates
						</h3>
						{BOOST_GATES.map((g) => (
							<GateRow key={g.name} {...g} />
						))}
					</Specimen>
					<Specimen fig="Pl. VI · fig. 2">
						<p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
							Based on your standing across the platform
						</p>
						<h3 style={heading} className="mb-4 text-xl">
							Anthers Gates
						</h3>
						{ANTHERS_GATES.map((g) => (
							<GateRow key={g.name} {...g} />
						))}
					</Specimen>
				</div>
			</Plate>

			{/* ── Plate VII — Delivery ── */}
			<Plate
				no="VII"
				title="Bandwidth, measured in the open"
				latin="Traditio mensurata"
				lede="Streaming and downloads cost bandwidth. Every other platform buries that cost in ads or a platform cut. Anthers shows it, at cost, as a labelled line in your Usage—and hands you real tools to keep it small."
				margin={
					<Marginalia side="right" top="6rem">
						at cost, always
					</Marginalia>
				}
			>
				<div className="mx-auto mt-10 max-w-2xl rounded-sm border border-dashed border-primary/40 bg-primary/5 p-6 text-center">
					<p className="leading-relaxed">
						<span style={heading} className="text-xl text-primary">
							Your first 3 GiB each month is free
						</span>
						<span className="text-base-content/70">
							{" "}
							—covered by the Foundation. Beyond that, Usage is just $0.03/GiB, a third of it real
							bandwidth at cost.
						</span>
					</p>
				</div>
				<div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
					{DELIVERY_CONTROLS.map((c, i) => (
						<div
							key={c.title}
							className="rounded-sm border border-base-content/20 border-dashed bg-base-100/40 p-5"
						>
							<span className="text-[10px] uppercase tracking-[0.2em] text-base-content/40">
								Fig. {i + 1}
							</span>
							<h3 style={heading} className="mt-1 mb-1.5 text-base">
								{c.title}
							</h3>
							<p className="text-xs leading-relaxed text-base-content/65">{c.body}</p>
						</div>
					))}
				</div>
			</Plate>

			{/* ── Colophon / closing ── */}
			<section className="mx-auto max-w-2xl px-6 py-28 text-center">
				<p className="mb-5 text-xs font-semibold uppercase tracking-[0.32em] text-primary">
					Colophon
				</p>
				<div className="mb-6 text-4xl" aria-hidden="true">
					🌱
				</div>
				<h2 style={heading} className="text-balance text-3xl leading-tight sm:text-5xl">
					Come and press something worth keeping
				</h2>
				<p className="mx-auto mt-5 max-w-xl leading-relaxed text-base-content/70">
					Support the growers you love, on terms you can see and check. Browse the whole collection
					free—no account required to begin.
				</p>
				<div className="mt-8 flex flex-wrap justify-center gap-3">
					<button type="button" className="btn btn-primary rounded-sm px-6">
						Browse the collection
					</button>
					<button type="button" className="btn btn-outline rounded-sm border-base-content/30 px-6">
						Begin a free account
					</button>
				</div>
				<p style={hand} className="mt-8 text-xl text-accent/70">
					pressed with care, 2026
				</p>
			</section>
		</div>
	);
}

// ─── Local building blocks ───

function Plate({
	no,
	title,
	latin,
	lede,
	children,
	tint,
	margin,
}: {
	no: string;
	title: string;
	latin: string;
	lede: string;
	children: React.ReactNode;
	tint?: boolean;
	margin?: React.ReactNode;
}) {
	return (
		<section className={tint ? "bg-base-200/40" : ""}>
			<div className="relative mx-auto max-w-6xl px-6 py-24">
				{margin}
				<div className="mx-auto max-w-4xl">
					<div className="mb-6 flex items-baseline gap-4">
						<span className="shrink-0 text-xs font-semibold uppercase tracking-[0.3em] text-primary">
							Plate {no}
						</span>
						<span className="h-px flex-1 bg-base-content/20" />
						<span className="shrink-0 text-[11px] uppercase tracking-[0.22em] text-base-content/40">
							Anthers Herbarium
						</span>
					</div>
					<h2 style={heading} className="text-balance text-3xl leading-tight sm:text-4xl">
						{title}
					</h2>
					<p className="mt-1.5 text-lg italic text-base-content/50">{latin}</p>
					<p className="mt-5 max-w-2xl text-lg leading-relaxed text-base-content/70">{lede}</p>
					{children}
				</div>
			</div>
		</section>
	);
}

function Specimen({ children, fig }: { children: React.ReactNode; fig: string }) {
	return (
		<figure className="flex flex-col rounded-sm border border-dashed border-base-content/30 bg-base-100/60 p-6 text-left shadow-sm">
			<div className="flex-1">{children}</div>
			<figcaption className="mt-5 flex items-center justify-between border-base-content/15 border-t pt-3 text-[10px] uppercase tracking-[0.22em] text-base-content/45">
				<span>Anthers Herbarium</span>
				<span>{fig}</span>
			</figcaption>
		</figure>
	);
}

function Marginalia({
	side,
	top,
	children,
}: {
	side: "left" | "right";
	top: string;
	children: React.ReactNode;
}) {
	return (
		<span
			style={{ fontFamily: FONTS.caveat, top }}
			className={`pointer-events-none absolute hidden w-32 text-xl leading-tight text-accent/75 xl:block ${
				side === "right" ? "right-1 rotate-2 text-right" : "-rotate-2 left-1 text-left"
			}`}
		>
			{children}
		</span>
	);
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className={strong ? "font-medium" : "text-base-content/70"}>{label}</span>
			<span className={`tabular-nums ${strong ? "font-medium" : "text-base-content/70"}`}>
				{value}
			</span>
		</div>
	);
}

function GateRow({ amount, name, perk }: { amount: string; name: string; perk: string }) {
	return (
		<div className="flex items-center gap-3 border-base-content/15 border-t border-dashed py-2.5 first:border-t-0">
			<span className="w-10 shrink-0 font-medium text-primary tabular-nums">{amount}</span>
			<span style={heading} className="w-24 shrink-0">
				{name}
			</span>
			<span className="text-xs text-base-content/60">{perk}</span>
		</div>
	);
}
