// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant — "Terrarium": a misty glass case. Frosted, translucent panels and
// dewy glass orbs float over a soft radial mist — built to prove dark mode can
// feel airy and open. Fraunces (light weights) over Nunito Sans; a serene,
// unhurried "under glass" voice with quiet confidence.

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
	"base-100": "oklch(97.5% 0.015 170)",
	"base-200": "oklch(95% 0.02 175)",
	"base-300": "oklch(91% 0.028 180)",
	"base-content": "oklch(30% 0.05 190)",
	primary: "oklch(57% 0.12 168)",
	"primary-content": "oklch(98% 0.02 170)",
	secondary: "oklch(80% 0.08 195)",
	"secondary-content": "oklch(28% 0.05 195)",
	accent: "oklch(64% 0.11 140)",
	"accent-content": "oklch(98% 0.02 140)",
	neutral: "oklch(34% 0.03 185)",
	"neutral-content": "oklch(96% 0.015 175)",
	info: "oklch(62% 0.1 210)",
	success: "oklch(60% 0.13 165)",
	warning: "oklch(80% 0.12 90)",
	error: "oklch(58% 0.16 25)",
};

const DARK: Palette = {
	"base-100": "oklch(20% 0.022 178)",
	"base-200": "oklch(23.5% 0.026 178)",
	"base-300": "oklch(28% 0.03 180)",
	"base-content": "oklch(92% 0.03 168)",
	primary: "oklch(78% 0.14 165)",
	"primary-content": "oklch(20% 0.04 165)",
	secondary: "oklch(83% 0.09 197)",
	"secondary-content": "oklch(22% 0.05 197)",
	accent: "oklch(73% 0.13 140)",
	"accent-content": "oklch(20% 0.04 140)",
	neutral: "oklch(29% 0.026 180)",
	"neutral-content": "oklch(92% 0.03 168)",
	info: "oklch(70% 0.11 210)",
	success: "oklch(74% 0.14 165)",
	warning: "oklch(83% 0.11 92)",
	error: "oklch(66% 0.15 25)",
};

const serif = { fontFamily: FONTS.fraunces };

// Per-index rise for the badge ladder (literal strings so Tailwind emits them).
const RISE = ["md:mt-16", "md:mt-10", "md:mt-4", "md:mt-0"] as const;

export default function Terrarium({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;
	const bg =
		mode === "light"
			? "radial-gradient(100% 60% at 20% 0%, oklch(94% 0.04 175) 0%, rgba(0,0,0,0) 55%), radial-gradient(90% 60% at 90% 20%, oklch(93% 0.05 140) 0%, rgba(0,0,0,0) 50%), var(--color-base-100)"
			: "radial-gradient(100% 60% at 20% 0%, oklch(30% 0.06 175) 0%, rgba(0,0,0,0) 55%), radial-gradient(90% 60% at 90% 20%, oklch(28% 0.07 150) 0%, rgba(0,0,0,0) 50%), var(--color-base-100)";

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.nunito })}
			className="relative min-h-screen overflow-hidden text-base-content"
		>
			{/* Drifting mist — soft glows the frosted panels sit within */}
			<div className="pointer-events-none absolute inset-0 overflow-hidden">
				<div className="absolute top-[5%] left-[6%] h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
				<div className="absolute top-[22%] right-[4%] h-80 w-80 rounded-full bg-secondary/20 blur-3xl" />
				<div className="absolute top-[50%] left-[10%] h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
				<div className="absolute top-[72%] right-[8%] h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
				<div className="absolute top-[90%] left-[34%] h-72 w-72 rounded-full bg-secondary/15 blur-3xl" />
			</div>

			<div className="relative">
				{/* Hero */}
				<header className="mx-auto max-w-4xl px-6 pt-28 pb-16 text-center">
					<div className="mx-auto mb-9 w-fit">
						<Orb emoji="🌿" size="h-24 w-24" text="text-4xl" />
					</div>
					<p className="mb-5 text-sm font-semibold uppercase tracking-[0.28em] text-primary">
						For readers · players · listeners
					</p>
					<h1
						style={serif}
						className="text-balance text-5xl font-light leading-[1.08] tracking-tight sm:text-7xl"
					>
						Everything in view,{" "}
						<em className="font-medium text-primary not-italic">clear as glass</em>.
					</h1>
					<p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-base-content/70">
						Anthers is a calm, creator-first place to read, watch, listen, and play. You pay
						creators directly. Every cost sits in the open. Nothing is skimmed off the top.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<button type="button" className="btn btn-primary rounded-full px-7">
							Step inside
						</button>
						<button
							type="button"
							className="btn rounded-full border border-base-content/15 bg-base-100/40 px-7 backdrop-blur-md hover:bg-base-100/60"
						>
							Create a free account
						</button>
					</div>
					<p className="mt-6 text-sm text-base-content/45">
						No account needed to browse, download free work, or play web games.
					</p>
				</header>

				{/* Three ways */}
				<Section>
					<Intro eyebrow="Three ways in" title="Three layers, gently combined">
						Not plans to choose between. Free use, one-time purchases, and support are quiet layers—
						added in any order, in any mix that suits you.
					</Intro>
					<div className="mx-auto mt-14 grid max-w-5xl gap-6 sm:grid-cols-3">
						{THREE_WAYS.map((w) => (
							<Glass key={w.step} className="p-8 text-left">
								<span
									style={serif}
									className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-primary/15 text-lg font-semibold text-primary"
								>
									{w.step}
								</span>
								<h3 style={serif} className="mb-2 text-xl font-medium">
									{w.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/70">{w.body}</p>
							</Glass>
						))}
					</div>
				</Section>

				{/* ① Free */}
				<Section>
					<Intro eyebrow="① Free, and always" title="Free, and always will be">
						This isn't a trial you outgrow. It's a standing promise from the Anthers Foundation, a
						non-profit: reaching creative work should never depend on your ability to pay.
					</Intro>
					<div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-5">
						<Glass className="p-8 text-left md:col-span-3">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🌫️&nbsp; How free stays free
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Every free tier is paid for by someone. On ad-funded platforms it's advertisers—so
								you become the product. Here, a free viewer's small bandwidth cost is covered by the
								Foundation's Subsidy pool: funded by the charity fee on paid Usage, and shared
								across the whole community.
							</p>
							<p className="mt-3 text-sm leading-relaxed text-base-content/70">
								So free access never rides on ads or your data. The small real costs simply diffuse
								across everyone who benefits—free as in shared responsibility, the way a healthier
								internet ought to feel.
							</p>
						</Glass>
						<Glass className="p-8 text-left md:col-span-2">
							<h3 style={serif} className="mb-4 text-xl font-medium">
								What a free account includes
							</h3>
							<ul className="flex flex-col gap-3 text-sm">
								{FREE_INCLUDES.map((f) => (
									<li key={f.text} className="flex gap-3">
										<span
											className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${
												f.yes
													? "bg-primary/15 text-primary"
													: "bg-base-content/5 text-base-content/40"
											}`}
										>
											{f.yes ? "✓" : "–"}
										</span>
										<span className="text-base-content/70">{f.text}</span>
									</li>
								))}
							</ul>
						</Glass>
					</div>
				</Section>

				{/* ② One-time purchases */}
				<Section>
					<Intro eyebrow="② One-time purchases" title="The price is what the creator gets">
						No plan required. Buy a game, album, film, or book outright—yours to keep. The listed
						price is exactly what the creator receives; the small real costs are added on top and
						named in full.
					</Intro>
					<div className="mx-auto mt-12 max-w-xl">
						<Glass className="p-8 text-left">
							<div className="mb-5 flex items-center justify-between gap-3">
								<span className="text-sm text-base-content/55">A $17 indie game</span>
								<span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">
									Creator gets $17.00
								</span>
							</div>
							<dl className="flex flex-col gap-3 text-sm">
								<Line label="Game price → the creator" value="$17.00" strong />
								<Line label="Delivery (actual bandwidth)" value="$0.06" />
								<Line label="Anthers Foundation (charity)" value="$0.03" />
								<Line label="Card processing" value="$0.79" />
							</dl>
							<div className="mt-5 flex items-baseline justify-between border-t border-base-content/10 pt-4">
								<span style={serif} className="text-lg font-medium">
									You pay
								</span>
								<span style={serif} className="text-lg font-medium">
									$17.88
								</span>
							</div>
							<p className="mt-4 text-xs leading-relaxed text-base-content/55">
								Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps $0. Pay
								from your bank and processing shrinks to about 0.8%.
							</p>
						</Glass>
					</div>
					<div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-3">
						{PRICING_MODELS.map((m) => (
							<div
								key={m.title}
								className="rounded-2xl bg-base-100/40 p-5 text-center ring-1 ring-base-content/10 backdrop-blur-sm"
							>
								<p style={serif} className="mb-1 font-medium text-primary">
									{m.title}
								</p>
								<p className="text-xs leading-relaxed text-base-content/60">{m.body}</p>
							</div>
						))}
					</div>
				</Section>

				{/* ③ Support */}
				<Section>
					<Intro eyebrow="③ Support, split transparently" title="Support, split in full view">
						Two independent, prepaid choices. Buy Usage for open, watch-anything access—it funds the
						Time Pool. Send Boosts in $1 units—100% to the creators you choose. The split is the
						same at every amount, and nothing is hidden.
					</Intro>

					<div className="mx-auto mt-12 max-w-2xl">
						<Glass className="p-8 text-left">
							<div className="mb-5 flex items-baseline justify-between gap-3">
								<h3 style={serif} className="text-lg font-medium">
									{SPROUT_BREAKDOWN.heading}
								</h3>
								<span className="text-sm text-base-content/55">{SPROUT_BREAKDOWN.sub}</span>
							</div>
							<div className="mb-5 flex h-3 overflow-hidden rounded-full ring-1 ring-base-content/10">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
								))}
							</div>
							<dl className="flex flex-col gap-2.5 text-sm">
								{SPROUT_BREAKDOWN.rows.map((r) => (
									<div key={r.label} className="flex items-center justify-between gap-3">
										<span className="flex items-center gap-2.5 text-base-content/70">
											<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEG_BG[r.token]}`} />
											{r.label}
										</span>
										<span className="font-medium tabular-nums">{r.amount}</span>
									</div>
								))}
							</dl>
							<div className="mt-5 flex items-baseline justify-between border-t border-base-content/10 pt-4">
								<span className="font-semibold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
								<span style={serif} className="text-lg font-medium text-primary">
									{SPROUT_BREAKDOWN.toCreators}
								</span>
							</div>
							<p className="mt-3 text-xs leading-relaxed text-base-content/50">
								{SPROUT_BREAKDOWN.footnote}
							</p>
						</Glass>
					</div>

					<div className="mx-auto mt-8 grid max-w-4xl gap-6 md:grid-cols-2">
						{POOLS.map((p) => (
							<Glass key={p.title} className="p-8 text-left">
								<p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
									{p.eyebrow}
								</p>
								<h3 style={serif} className="mb-2 text-xl font-medium">
									{p.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/70">{p.body}</p>
							</Glass>
						))}
					</div>
				</Section>

				{/* Badge ladder */}
				<Section>
					<Intro eyebrow="Your Anthers Badge" title="A rank that grows with you">
						Not a plan you pick or a tier you subscribe to. Your Badge is a rolling rank, earned
						from combined Usage and Boost spend over the last few months. Everyone starts unranked;
						your first $3 earns Root.
					</Intro>
					<div className="mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
						{BADGE_RANKS.map((b, i) => (
							<div key={b.name} className={`text-center ${RISE[i]}`}>
								<div className="mx-auto mb-4 w-fit">
									<Orb emoji={b.emoji} size="h-20 w-20" text="text-3xl" />
								</div>
								<h3 style={serif} className="text-lg font-medium">
									{b.name}
								</h3>
								<p className="mt-0.5 text-xs font-semibold tabular-nums text-primary">
									{b.threshold}
								</p>
								<p className="mt-1.5 text-xs leading-relaxed text-base-content/55">{b.flavor}</p>
							</div>
						))}
					</div>
					<p className="mx-auto mt-10 max-w-2xl text-center text-sm text-base-content/50">
						Your Badge reflects the last few months, so it drifts gently with you—support more and
						it rises, ease off and it recedes. Some creators use it as a key, opening a whole rank
						of content at once. That's an Anthers Gate.
					</p>
				</Section>

				{/* Gates */}
				<Section>
					<Intro eyebrow="Unlock more" title="Two clear ways to open a gate">
						Some creators keep premium work behind a gate. There are exactly two kinds—one for your
						support of a single creator, one for your standing across the whole platform.
					</Intro>
					<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
						<Glass className="p-8 text-left">
							<p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary/80">
								Based on your support for one creator
							</p>
							<h3 style={serif} className="mt-1 mb-4 text-xl font-medium">
								Boost Gates
							</h3>
							{BOOST_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Glass>
						<Glass className="p-8 text-left">
							<p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
								Based on your standing across the platform
							</p>
							<h3 style={serif} className="mt-1 mb-4 text-xl font-medium">
								Anthers Gates
							</h3>
							{ANTHERS_GATES.map((g) => (
								<GateRow key={g.name} accent {...g} />
							))}
						</Glass>
					</div>
				</Section>

				{/* Delivery */}
				<Section>
					<Intro eyebrow="Delivery, in the open" title="Pay only for the bandwidth you use">
						Streaming and downloads cost bandwidth. Most platforms bury that in ads or a cut.
						Anthers shows it plainly, at cost—so you keep it small with real tools, not guesswork.
					</Intro>
					<div className="mx-auto mt-12 max-w-2xl">
						<Glass className="p-8 text-center sm:p-10">
							<p className="text-balance leading-relaxed">
								<span style={serif} className="text-2xl font-light text-primary">
									Your first 3 GiB each month is free
								</span>
								<span className="text-base-content/70">
									, covered by the Foundation. Beyond that, Usage is just $0.03/GiB—a third of it
									real bandwidth, at cost.
								</span>
							</p>
						</Glass>
					</div>
					<div className="mx-auto mt-8 grid max-w-4xl gap-5 sm:grid-cols-2 lg:grid-cols-4">
						{DELIVERY_CONTROLS.map((c) => (
							<div
								key={c.title}
								className="rounded-2xl bg-base-100/40 p-6 text-left ring-1 ring-base-content/10 backdrop-blur-sm"
							>
								<h3 style={serif} className="mb-1.5 font-medium">
									{c.title}
								</h3>
								<p className="text-xs leading-relaxed text-base-content/60">{c.body}</p>
							</div>
						))}
					</div>
				</Section>

				{/* Closing */}
				<section className="mx-auto max-w-2xl px-6 pt-16 pb-32 text-center">
					<div className="mx-auto mb-7 w-fit">
						<Orb emoji="🌸" size="h-20 w-20" text="text-3xl" />
					</div>
					<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						Come in. It's calm in here.
					</h2>
					<p className="mx-auto mt-5 max-w-lg leading-relaxed text-base-content/70">
						Support the creators you love, on terms you can see straight through. Browse the whole
						catalog free—no account needed to start.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<button type="button" className="btn btn-primary rounded-full px-7">
							Browse everything
						</button>
						<button
							type="button"
							className="btn rounded-full border border-base-content/15 bg-base-100/40 px-7 backdrop-blur-md hover:bg-base-100/60"
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

function Section({ children }: { children: React.ReactNode }) {
	return <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24">{children}</section>;
}

function Intro({
	eyebrow,
	title,
	children,
}: {
	eyebrow: string;
	title: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="mx-auto max-w-2xl text-center">
			<p className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-primary/80">
				{eyebrow}
			</p>
			<h2
				style={serif}
				className="text-balance text-4xl font-light leading-tight tracking-tight sm:text-5xl"
			>
				{title}
			</h2>
			{children ? (
				<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
					{children}
				</p>
			) : null}
		</div>
	);
}

/** A frosted-glass panel: translucent, blurred, with a dewy top edge. */
function Glass({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={`relative overflow-hidden rounded-[1.75rem] bg-base-100/50 shadow-xl shadow-primary/5 ring-1 ring-base-content/10 backdrop-blur-md ${className}`}
		>
			<span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-base-content/20 to-transparent" />
			{children}
		</div>
	);
}

/** A glass dome with a dewy specular highlight. */
function Orb({ emoji, size, text }: { emoji: string; size: string; text: string }) {
	return (
		<div
			className={`relative grid place-items-center rounded-full bg-base-100/40 shadow-xl shadow-primary/10 ring-1 ring-base-content/10 backdrop-blur-md ${size}`}
		>
			<span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-b from-secondary/15 to-transparent" />
			<span className="pointer-events-none absolute top-[16%] left-[22%] h-1/4 w-1/3 rounded-full bg-secondary/40 blur-[6px]" />
			<span className={`relative ${text}`} aria-hidden="true">
				{emoji}
			</span>
		</div>
	);
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className={strong ? "font-medium" : "text-base-content/70"}>{label}</span>
			<span className={`tabular-nums ${strong ? "font-medium" : "text-base-content/70"}`}>
				{value}
			</span>
		</div>
	);
}

function GateRow({
	amount,
	name,
	perk,
	accent,
}: {
	amount: string;
	name: string;
	perk: string;
	accent?: boolean;
}) {
	return (
		<div className="flex items-center gap-3 border-t border-base-content/10 py-3 first:border-t-0">
			<span
				className={`w-11 shrink-0 text-sm font-semibold tabular-nums ${accent ? "text-accent" : "text-primary"}`}
			>
				{amount}
			</span>
			<span style={serif} className="w-24 shrink-0 font-medium">
				{name}
			</span>
			<span className="text-sm text-base-content/60">{perk}</span>
		</div>
	);
}
