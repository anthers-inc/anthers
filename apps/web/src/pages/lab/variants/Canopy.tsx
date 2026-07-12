// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant — "Canopy": a refined, modern botanical brand. Sage + terracotta +
// amber, big confident Fraunces display over Nunito Sans. Editorial, asymmetric
// composition: left-aligned section heads, a refined 12-col grid, generous
// margins, soft-shadow cards (no glass, no frames), calm negative space.

import { Frond, Sprig } from "../botanical";
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
	"base-100": "oklch(98.2% 0.006 80)",
	"base-200": "oklch(95.5% 0.012 90)",
	"base-300": "oklch(91% 0.02 110)",
	"base-content": "oklch(27% 0.02 150)",
	primary: "oklch(58% 0.07 150)",
	"primary-content": "oklch(98% 0.01 150)",
	secondary: "oklch(64% 0.13 45)",
	"secondary-content": "oklch(98% 0.02 45)",
	accent: "oklch(75% 0.13 78)",
	"accent-content": "oklch(26% 0.05 78)",
	neutral: "oklch(32% 0.02 150)",
	"neutral-content": "oklch(96% 0.01 90)",
	info: "oklch(60% 0.09 220)",
	success: "oklch(58% 0.1 155)",
	warning: "oklch(79% 0.13 85)",
	error: "oklch(58% 0.16 28)",
};
const DARK: Palette = {
	"base-100": "oklch(23.5% 0.022 165)",
	"base-200": "oklch(27% 0.024 165)",
	"base-300": "oklch(31.5% 0.026 168)",
	"base-content": "oklch(92% 0.02 82)",
	primary: "oklch(76% 0.1 155)",
	"primary-content": "oklch(20% 0.04 155)",
	secondary: "oklch(67% 0.14 44)",
	"secondary-content": "oklch(98% 0.02 44)",
	accent: "oklch(80% 0.12 80)",
	"accent-content": "oklch(22% 0.05 80)",
	neutral: "oklch(30% 0.022 166)",
	"neutral-content": "oklch(92% 0.02 82)",
	info: "oklch(68% 0.1 220)",
	success: "oklch(74% 0.12 155)",
	warning: "oklch(82% 0.12 86)",
	error: "oklch(66% 0.15 28)",
};

const display = { fontFamily: FONTS.fraunces };
const softCard =
	"rounded-3xl bg-base-100 shadow-[0_1px_2px_rgba(20,30,24,0.04),0_18px_44px_-26px_rgba(20,30,24,0.24)] ring-1 ring-base-content/5";
const btnPrimary = "btn btn-primary rounded-xl border-0 px-6 shadow-sm";
const btnSoft =
	"btn rounded-xl border-0 bg-base-200 px-6 text-base-content shadow-none hover:bg-base-300";

const GLANCE = [
	{ k: "Platform cut", v: "$0" },
	{ k: "Free delivery each month", v: "3 GiB" },
	{ k: "Usage after that", v: "$0.03/GiB" },
	{ k: "Every boost to creators", v: "100%" },
] as const;

export default function Canopy({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;
	const bg =
		mode === "light"
			? "radial-gradient(120% 70% at 80% -5%, oklch(95% 0.03 78) 0%, rgba(0,0,0,0) 50%), var(--color-base-100)"
			: "radial-gradient(120% 70% at 80% -5%, oklch(29% 0.04 160) 0%, rgba(0,0,0,0) 50%), var(--color-base-100)";

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.nunito })}
			className="min-h-screen text-base-content"
		>
			{/* Hero — asymmetric: big headline left, quiet spec card right */}
			<header className="relative overflow-hidden">
				<Frond className="pointer-events-none absolute -top-24 -right-16 hidden h-[32rem] w-auto rotate-[20deg] text-primary/10 lg:block" />
				<div className="relative z-10 mx-auto max-w-6xl px-6 pt-24 pb-20 lg:px-10 lg:pt-28 lg:pb-28">
					<div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
						<div className="lg:col-span-7">
							<p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
								For readers, players &amp; listeners
							</p>
							<h1
								style={display}
								className="mt-5 text-balance text-5xl font-medium leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl"
							>
								Your money goes <span className="text-primary">exactly where you send it</span>.
							</h1>
							<p className="mt-6 max-w-xl text-lg leading-relaxed text-base-content/70">
								Anthers is a creator-first media platform with a zero-percent cut. Browse free, buy
								work outright, or support creators directly—and see every cost, down to the cent.
							</p>
							<div className="mt-8 flex flex-wrap gap-3">
								<button type="button" className={btnPrimary}>
									Start exploring
								</button>
								<button type="button" className={btnSoft}>
									Create a free account
								</button>
							</div>
							<p className="mt-5 text-sm text-base-content/50">
								No account needed to browse, download free work, or play web games.
							</p>
						</div>
						<div className="lg:col-span-5">
							<div className={`${softCard} p-7 sm:p-8`}>
								<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/50">
									The economics, plainly
								</p>
								<dl className="mt-4 flex flex-col">
									{GLANCE.map((g, i) => (
										<div
											key={g.k}
											className={`flex items-baseline justify-between gap-4 py-3.5 ${
												i > 0 ? "border-t border-base-content/10" : ""
											}`}
										>
											<dt className="text-sm text-base-content/70">{g.k}</dt>
											<dd style={display} className="text-2xl font-medium text-primary">
												{g.v}
											</dd>
										</div>
									))}
								</dl>
							</div>
						</div>
					</div>
				</div>
			</header>

			{/* Three ways — section head left rail, numbered list right */}
			<Section>
				<div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
					<Head
						className="lg:col-span-5"
						eyebrow="How it works"
						title="Three ways to use Anthers"
						lede="Free access, one-time purchases, and ongoing support. Not competing plans to choose between—combinable layers you use in whatever mix suits you."
					/>
					<ol className="lg:col-span-7">
						{THREE_WAYS.map((w, i) => (
							<li
								key={w.step}
								className={`grid grid-cols-[auto_1fr] gap-x-6 py-6 ${
									i > 0 ? "border-t border-base-content/10" : ""
								}`}
							>
								<span style={display} className="text-4xl font-medium leading-none text-primary/35">
									0{w.step}
								</span>
								<div>
									<h3 style={display} className="text-xl font-medium">
										{w.title}
									</h3>
									<p className="mt-1.5 leading-relaxed text-base-content/70">{w.body}</p>
								</div>
							</li>
						))}
					</ol>
				</div>
			</Section>

			{/* ① Free — mission prose left, includes list right */}
			<Section tint>
				<div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
					<div className="lg:col-span-6">
						<Head
							eyebrow="① Always free"
							title="Free, and it stays that way"
							lede="The free tier isn't a trial. It's a standing promise from the Anthers Foundation—a non-profit—that reaching creative work shouldn't depend on your ability to pay."
						/>
						<div className="mt-6 max-w-xl space-y-4 leading-relaxed text-base-content/70">
							<p>
								Every free tier is paid for by someone. On ad-funded platforms that's
								advertisers—which makes you the product. Here, a free viewer's bandwidth is covered
								by the Foundation's Subsidy pool, funded by the charity fee on paid Usage and shared
								across the whole community.
							</p>
							<p>
								So free access never rides on ads or your data. Just the small real costs, quietly
								diffused across everyone who benefits.
							</p>
						</div>
					</div>
					<div className="lg:col-span-6">
						<div className={`${softCard} p-7 sm:p-8`}>
							<h3 style={display} className="text-xl font-medium">
								What a free account includes
							</h3>
							<ul className="mt-5 flex flex-col gap-3.5">
								{FREE_INCLUDES.map((f) => (
									<li key={f.text} className="flex gap-3">
										<span
											className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
												f.yes
													? "bg-primary/15 text-primary"
													: "bg-base-content/5 text-base-content/40"
											}`}
										>
											{f.yes ? "✓" : "–"}
										</span>
										<span className="text-base-content/75">{f.text}</span>
									</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			</Section>

			{/* ② One-time — head + pricing models left, receipt card right */}
			<Section>
				<div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
					<div className="lg:col-span-5">
						<Head
							eyebrow="② One-time purchases"
							title="Buy it once. The price is what the creator gets."
							lede="Games, albums, films, and books, bought outright and yours to keep. The listed price is exactly what the creator receives—real costs are itemized on top, so you see every cent before you pay."
						/>
						<div className="mt-8 space-y-4">
							{PRICING_MODELS.map((m) => (
								<div key={m.title}>
									<h4 style={display} className="font-medium text-primary">
										{m.title}
									</h4>
									<p className="mt-0.5 text-sm leading-relaxed text-base-content/65">{m.body}</p>
								</div>
							))}
						</div>
					</div>
					<div className="lg:col-span-7">
						<div className={`${softCard} mx-auto max-w-lg p-7 sm:p-8`}>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<span style={display} className="text-lg font-medium">
									A $17 indie game
								</span>
								<span className="rounded-full bg-primary/12 px-3 py-1 text-xs font-semibold text-primary">
									Creator gets $17.00
								</span>
							</div>
							<dl className="mt-6 space-y-3 text-sm">
								<Line label="Game price → the creator" value="$17.00" strong />
								<Line label="Delivery — actual bandwidth" value="$0.06" />
								<Line label="Anthers Foundation — charity" value="$0.03" />
								<Line label="Card processing" value="$0.79" />
							</dl>
							<div className="mt-5 flex items-baseline justify-between border-t border-base-content/10 pt-4">
								<span style={display} className="text-xl font-medium">
									You pay
								</span>
								<span style={display} className="text-xl font-medium">
									$17.88
								</span>
							</div>
							<p className="mt-4 text-xs leading-relaxed text-base-content/55">
								Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps $0. Pay
								from your bank and processing shrinks to about 0.8%.
							</p>
						</div>
					</div>
				</div>
			</Section>

			{/* ③ Support — head, then breakdown (wide) beside the two pools */}
			<Section tint>
				<Head
					className="max-w-2xl"
					eyebrow="③ Support"
					title="Support, split so you can see it"
					lede="Two independent, prepaid choices: buy Usage for open access—which funds the Time Pool—and send Boosts a dollar at a time, straight to creators. The split is the same at every amount, and nothing is hidden."
				/>
				<div className="mt-14 grid items-start gap-8 lg:grid-cols-12 lg:gap-10">
					<div className="lg:col-span-7">
						<div className={`${softCard} p-7 sm:p-8`}>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<h3 style={display} className="text-xl font-medium">
									{SPROUT_BREAKDOWN.heading}
								</h3>
								<span className="text-sm text-base-content/55">{SPROUT_BREAKDOWN.sub}</span>
							</div>
							<div className="mt-5 flex h-3 overflow-hidden rounded-full">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
								))}
							</div>
							<dl className="mt-5 space-y-2.5 text-sm">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className="flex items-center justify-between gap-3">
										<dt className="flex items-center gap-2.5 text-base-content/75">
											<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEG_BG[r.token]}`} />
											{r.label}
										</dt>
										<dd className="font-mono font-medium tabular-nums">{r.amount}</dd>
									</div>
								))}
							</dl>
							<div className="mt-5 flex items-baseline justify-between border-t border-base-content/10 pt-4">
								<span className="font-semibold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
								<span style={display} className="text-xl font-medium text-primary">
									{SPROUT_BREAKDOWN.toCreators}
								</span>
							</div>
							<p className="mt-4 text-xs leading-relaxed text-base-content/55">
								{SPROUT_BREAKDOWN.footnote}
							</p>
						</div>
					</div>
					<div className="space-y-6 lg:col-span-5">
						{POOLS.map((p) => (
							<div key={p.title} className={`${softCard} p-7`}>
								<p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">
									{p.eyebrow}
								</p>
								<h3 style={display} className="mt-2 text-xl font-medium">
									{p.title}
								</h3>
								<p className="mt-2 text-sm leading-relaxed text-base-content/70">{p.body}</p>
							</div>
						))}
					</div>
				</div>
			</Section>

			{/* Badge ladder — horizontal progression on a connecting line */}
			<Section>
				<Head
					className="max-w-2xl"
					eyebrow="Your standing"
					title="The Anthers Badge—a rank that grows with you"
					lede="Not a plan you pick or a tier you subscribe to. A rolling rank earned from your combined Usage and Boost spend over the last few months. Everyone starts unranked; your first $3 earns Root—and some creators use it as a key, an Anthers Gate."
				/>
				<div className="relative mt-16">
					<div
						aria-hidden="true"
						className="absolute top-10 right-[12.5%] left-[12.5%] hidden h-px bg-gradient-to-r from-primary/40 via-secondary/40 to-accent/50 md:block"
					/>
					<ol className="grid grid-cols-2 gap-x-6 gap-y-12 md:grid-cols-4">
						{BADGE_RANKS.map((b) => (
							<li key={b.name} className="relative flex flex-col items-center text-center">
								<div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-base-200 text-4xl ring-1 ring-base-content/10">
									<span aria-hidden="true">{b.emoji}</span>
								</div>
								<h3 style={display} className="text-lg font-medium">
									{b.name}
								</h3>
								<p className="mt-0.5 font-mono text-xs text-secondary">{b.threshold}</p>
								<p className="mt-1.5 max-w-[16rem] text-sm leading-relaxed text-base-content/60">
									{b.flavor}
								</p>
							</li>
						))}
					</ol>
				</div>
			</Section>

			{/* Gates — two clear kinds, side by side */}
			<Section tint>
				<Head
					className="max-w-2xl"
					eyebrow="Unlocking more"
					title="Two clear ways to open a gate"
					lede="Some creators keep premium work behind a gate. There are exactly two kinds—one earned from your support of a single creator, one from your standing across the whole platform."
				/>
				<div className="mt-14 grid gap-8 md:grid-cols-2">
					<GateCard
						label="For one creator"
						title="Boost Gates"
						note="Based on your support for one creator."
						accent="text-secondary"
						gates={BOOST_GATES}
					/>
					<GateCard
						label="Across the platform"
						title="Anthers Gates"
						note="Based on your standing across the whole platform."
						accent="text-primary"
						gates={ANTHERS_GATES}
					/>
				</div>
			</Section>

			{/* Delivery — head left, highlight + control cards right */}
			<Section>
				<div className="grid items-start gap-12 lg:grid-cols-12 lg:gap-16">
					<Head
						className="lg:col-span-5"
						eyebrow="Delivery"
						title="Pay for what you use—and keep it low"
						lede="Streaming and downloads cost bandwidth. Most platforms bury it in ads or their cut. Anthers shows it, at cost, as a line in your Usage—with real tools to keep it small."
					/>
					<div className="lg:col-span-7">
						<div className="rounded-3xl bg-accent/12 p-7">
							<p className="text-base leading-relaxed">
								<span style={display} className="text-xl font-medium text-primary">
									Your first 3 GiB each month is free
								</span>
								<span className="text-base-content/75">
									{" "}
									—covered by the Foundation. Beyond that, Usage is just $0.03/GiB, a third of it
									real bandwidth at cost.
								</span>
							</p>
						</div>
						<div className="mt-6 grid gap-4 sm:grid-cols-2">
							{DELIVERY_CONTROLS.map((c) => (
								<div key={c.title} className={`${softCard} p-6`}>
									<h3 style={display} className="font-medium">
										{c.title}
									</h3>
									<p className="mt-1.5 text-sm leading-relaxed text-base-content/65">{c.body}</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</Section>

			{/* Closing — warm, asymmetric sign-off */}
			<section>
				<div className="mx-auto max-w-6xl px-6 py-24 lg:px-10 lg:py-28">
					<div className="relative overflow-hidden rounded-[2rem] bg-primary/8 p-8 sm:p-12 lg:p-14">
						<Frond className="pointer-events-none absolute -right-12 -bottom-24 hidden h-80 w-auto -rotate-[18deg] text-primary/12 lg:block" />
						<div className="relative z-10 grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-10">
							<div className="lg:col-span-8">
								<p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
									Start here
								</p>
								<h2
									style={display}
									className="mt-4 text-balance text-4xl font-medium leading-[1.05] tracking-tight sm:text-5xl"
								>
									Start where you like. It's free to look.
								</h2>
								<p className="mt-5 max-w-xl text-lg leading-relaxed text-base-content/70">
									Support the creators you love on terms you can actually see. Browse the whole
									catalog free—no account needed to begin.
								</p>
							</div>
							<div className="flex flex-wrap gap-3 lg:col-span-4 lg:justify-end">
								<button type="button" className={btnPrimary}>
									Browse projects
								</button>
								<button type="button" className={btnSoft}>
									Create a free account
								</button>
							</div>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}

// ─── Local building blocks ───

function Section({ children, tint }: { children: React.ReactNode; tint?: boolean }) {
	return (
		<section className={tint ? "bg-base-200/50" : ""}>
			<div className="mx-auto max-w-6xl px-6 py-24 lg:px-10 lg:py-28">{children}</div>
		</section>
	);
}

function Head({
	eyebrow,
	title,
	lede,
	className,
}: {
	eyebrow: string;
	title: string;
	lede?: string;
	className?: string;
}) {
	return (
		<div className={className}>
			<Sprig className="mb-3 h-8 w-8 text-primary/45" />
			<p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">{eyebrow}</p>
			<h2
				style={display}
				className="mt-4 text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl"
			>
				{title}
			</h2>
			{lede && <p className="mt-5 max-w-xl text-lg leading-relaxed text-base-content/70">{lede}</p>}
		</div>
	);
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className={strong ? "font-medium" : "text-base-content/70"}>{label}</dt>
			<dd className={`font-mono tabular-nums ${strong ? "font-medium" : "text-base-content/70"}`}>
				{value}
			</dd>
		</div>
	);
}

function GateCard({
	label,
	title,
	note,
	accent,
	gates,
}: {
	label: string;
	title: string;
	note: string;
	accent: string;
	gates: readonly { amount: string; name: string; perk: string }[];
}) {
	return (
		<div className={`${softCard} p-7 sm:p-8`}>
			<p className={`text-xs font-semibold uppercase tracking-[0.18em] ${accent}`}>{label}</p>
			<h3 style={display} className="mt-2 text-xl font-medium">
				{title}
			</h3>
			<p className="mt-1 text-sm text-base-content/55">{note}</p>
			<div className="mt-5">
				{gates.map((g) => (
					<div
						key={g.name}
						className="grid grid-cols-[3rem_6rem_1fr] items-baseline gap-3 border-t border-base-content/10 py-3 first:border-t-0"
					>
						<span className={`font-mono text-sm ${accent}`}>{g.amount}</span>
						<span style={display} className="font-medium">
							{g.name}
						</span>
						<span className="text-sm text-base-content/65">{g.perk}</span>
					</div>
				))}
			</div>
		</div>
	);
}
