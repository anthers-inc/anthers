// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Variant — "SeedPacket": a cheerful seed catalog. Dashed "cut-here" packets,
// postmark/rosette stamp emblems, big font-black Fraunces display, hand-lettered
// Caveat scribbles, and kraft-paper warmth with sunny yellow + tomato accents.
// Creators are "growers"; the whole page reads like a seed company catalog.

import { type ReactNode, useId } from "react";
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
	"base-100": "oklch(95.5% 0.028 86)",
	"base-200": "oklch(92% 0.038 82)",
	"base-300": "oklch(87% 0.05 80)",
	"base-content": "oklch(28% 0.03 65)",
	primary: "oklch(52% 0.13 148)",
	"primary-content": "oklch(98% 0.02 100)",
	secondary: "oklch(83% 0.15 90)",
	"secondary-content": "oklch(30% 0.06 80)",
	accent: "oklch(60% 0.18 30)",
	"accent-content": "oklch(98% 0.02 30)",
	neutral: "oklch(33% 0.04 60)",
	"neutral-content": "oklch(95% 0.03 86)",
	info: "oklch(58% 0.1 230)",
	success: "oklch(56% 0.13 148)",
	warning: "oklch(80% 0.15 88)",
	error: "oklch(58% 0.19 30)",
};
const DARK: Palette = {
	"base-100": "oklch(22% 0.025 95)",
	"base-200": "oklch(25.5% 0.028 95)",
	"base-300": "oklch(30% 0.03 98)",
	"base-content": "oklch(92% 0.04 88)",
	primary: "oklch(74% 0.15 148)",
	"primary-content": "oklch(20% 0.05 148)",
	secondary: "oklch(85% 0.14 92)",
	"secondary-content": "oklch(24% 0.06 88)",
	accent: "oklch(67% 0.17 32)",
	"accent-content": "oklch(20% 0.04 32)",
	neutral: "oklch(30% 0.028 96)",
	"neutral-content": "oklch(92% 0.04 88)",
	info: "oklch(68% 0.11 230)",
	success: "oklch(72% 0.14 148)",
	warning: "oklch(84% 0.14 90)",
	error: "oklch(66% 0.18 32)",
};

const display = { fontFamily: FONTS.fraunces };
const hand = { fontFamily: FONTS.caveat };

export default function SeedPacket({ mode }: { mode: Mode }) {
	const pal = mode === "light" ? LIGHT : DARK;
	const bg =
		mode === "light"
			? "radial-gradient(120% 80% at 50% -5%, oklch(93% 0.05 88) 0%, rgba(0,0,0,0) 55%), var(--color-base-100)"
			: "radial-gradient(120% 80% at 50% -5%, oklch(30% 0.05 100) 0%, rgba(0,0,0,0) 55%), var(--color-base-100)";

	return (
		<div
			style={paletteVars(pal, mode, { background: bg, fontFamily: FONTS.nunito })}
			className="min-h-screen overflow-x-hidden text-base-content"
		>
			{/* ── Hero: one big seed packet ── */}
			<header className="mx-auto max-w-5xl px-6 pt-20 pb-14">
				<Packet rotate="-0.6deg" className="relative">
					{/* masthead + postmark */}
					<div className="flex items-start justify-between gap-4">
						<div>
							<p
								style={display}
								className="text-xs font-black uppercase tracking-[0.28em] text-primary"
							>
								Anthers Seed&nbsp;Co.
							</p>
							<Scribble className="text-2xl text-accent">Fresh catalog — now in bloom!</Scribble>
						</div>
						<Postmark className="hidden h-24 w-24 shrink-0 rotate-[8deg] text-accent sm:block" />
					</div>

					<h1
						style={display}
						className="mt-6 text-balance text-5xl font-black leading-[0.98] tracking-tight sm:text-7xl"
					>
						Everything you love, <span className="text-primary">sold by the packet.</span>
					</h1>
					<p className="mt-6 max-w-2xl text-lg leading-relaxed text-base-content/75">
						Anthers is a seed catalog for games, films, albums, and books—grown by creators, not
						advertisers. You pay the grower directly, only for what you use, with nothing skimmed
						off the top. Here's how the whole garden works.
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						<button type="button" className="btn btn-primary rounded-full px-7 shadow-none">
							Open the catalog
						</button>
						<button
							type="button"
							className="btn btn-outline rounded-full border-2 border-dashed border-base-content/30 px-7"
						>
							Create a free account
						</button>
						<Scribble className="ml-1 text-xl text-primary">it's free to browse!</Scribble>
					</div>
					<p className="mt-5 text-sm text-base-content/50">
						No account needed to browse, download free work, or play web games.
					</p>

					<CutFooter note="open a packet 🌱" />
				</Packet>
			</header>

			{/* ── Three ways ── */}
			<Section>
				<Header eyebrow="mix & match — never rival plans!" title="Three ways to plant a garden">
					Free use, one-time purchases, and ongoing support aren't plans to choose between—they're
					layers you stack in any order you like. Sow one, sow all three.
				</Header>
				<div className="mt-12 grid gap-6 md:grid-cols-3">
					{THREE_WAYS.map((w, i) => (
						<Packet
							key={w.step}
							rotate={i % 2 === 0 ? "-1deg" : "1deg"}
							className="flex flex-col hover:rotate-0"
						>
							<div className="flex items-center justify-between">
								<StampNo n={w.step} />
								<Scribble className="text-lg text-accent">No.&nbsp;{w.step}</Scribble>
							</div>
							<h3 style={display} className="mt-4 text-2xl font-black leading-tight">
								{w.title}
							</h3>
							<p className="mt-2 text-sm leading-relaxed text-base-content/70">{w.body}</p>
						</Packet>
					))}
				</div>
			</Section>

			{/* ── ① Free, always ── */}
			<Section tint>
				<Header eyebrow="always free — no catch!" title="① The always-free packet">
					The free tier isn't a trial you're meant to outgrow. It's a standing promise from the{" "}
					<span className="font-bold text-primary">Anthers Foundation</span>, a non-profit: reaching
					creative work should never depend on your ability to pay.
				</Header>
				<div className="mt-10 grid gap-6 md:grid-cols-2">
					<Packet rotate="-0.6deg" className="hover:rotate-0">
						<h3 style={display} className="text-xl font-black">
							🌾&nbsp; How free stays free
						</h3>
						<p className="mt-3 text-sm leading-relaxed text-base-content/75">
							Every free tier is paid for by someone. On ad-funded sites it's advertisers—which
							makes <em>you</em> the crop being harvested. Here, a free viewer's small bandwidth
							cost is covered by the Foundation's <span className="font-bold">Subsidy pool</span>
							—funded by the charity fee on paid Usage and shared across the whole community.
						</p>
						<p className="mt-3 text-sm leading-relaxed text-base-content/75">
							So free access never rides on ads or your data. Just the small real costs, spread thin
							across everyone who benefits—free-as-in-shared-soil.
						</p>
					</Packet>
					<Packet rotate="0.7deg" className="hover:rotate-0">
						<div className="flex items-center justify-between">
							<h3 style={display} className="text-xl font-black">
								🎁&nbsp; What's inside
							</h3>
							<Scribble className="text-xl text-primary">no login wall!</Scribble>
						</div>
						<ul className="mt-4 flex flex-col gap-3 text-sm">
							{FREE_INCLUDES.map((f) => (
								<li key={f.text} className="flex gap-3">
									<span
										aria-hidden="true"
										className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-black ${
											f.yes ? "bg-primary text-primary-content" : "bg-base-300 text-base-content/50"
										}`}
									>
										{f.yes ? "✓" : "–"}
									</span>
									<span className="text-base-content/75">{f.text}</span>
								</li>
							))}
						</ul>
					</Packet>
				</div>
			</Section>

			{/* ── ② One-time purchases ── */}
			<Section>
				<Header eyebrow="the grower keeps every penny of it" title="② Buy the packet outright">
					No ongoing plan needed. A game, an album, a film, a book—buy it once, it's yours to keep.
					The listed price is exactly what the creator receives; the real costs are added on top and
					itemized, so you see every penny before you pay.
				</Header>
				<div className="mt-10 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
					<Packet rotate="-0.8deg" className="hover:rotate-0">
						<div className="flex items-center justify-between">
							<span className="text-sm text-base-content/60">Sample packet — a $17 indie game</span>
							<span
								style={display}
								className="rounded-full bg-primary px-3 py-1 text-xs font-black text-primary-content"
							>
								Grower gets $17.00
							</span>
						</div>
						<dl className="mt-5 flex flex-col gap-2.5 text-sm">
							<Line label="Game price → the creator" value="$17.00" strong />
							<Line label="Delivery (actual bandwidth)" value="$0.06" />
							<Line label="Anthers Foundation (charity)" value="$0.03" />
							<Line label="Card processing" value="$0.79" />
						</dl>
						<div className="mt-5 flex items-baseline justify-between border-t-2 border-dashed border-base-content/25 pt-4">
							<span style={display} className="text-2xl font-black">
								You pay
							</span>
							<span style={display} className="text-2xl font-black text-accent">
								$17.88
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/55">
							Just $0.88 in real costs on top—none of it a cut for Anthers, which keeps{" "}
							<span className="font-bold text-base-content/80">$0</span>. Pay from your bank and
							processing shrinks to about 0.8%.
						</p>
					</Packet>
					<div>
						<Scribble className="text-2xl text-primary">how growers price a packet</Scribble>
						<div className="mt-2 flex flex-col gap-3">
							{PRICING_MODELS.map((m, i) => (
								<div
									key={m.title}
									style={{ transform: `rotate(${i % 2 === 0 ? "-0.5" : "0.5"}deg)` }}
									className="rounded-xl border-2 border-dashed border-base-content/20 bg-base-200/60 p-4"
								>
									<p style={display} className="font-black text-primary">
										{m.title}
									</p>
									<p className="mt-0.5 text-xs leading-relaxed text-base-content/65">{m.body}</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</Section>

			{/* ── ③ Support, split transparently ── */}
			<Section tint>
				<Header eyebrow="100% to growers" title="③ Support, split in the open">
					The third way—and where most creators earn the most. Two independent, prepaid choices: buy{" "}
					<span className="font-bold text-primary">Usage</span> for open, watch-anything access, and
					send <span className="font-bold text-secondary-content">Boosts</span> a dollar at a time.
					Same split at every amount, nothing hidden in the seams.
				</Header>

				<div className="mt-10 grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
					<Packet rotate="-0.6deg" className="hover:rotate-0">
						<div className="flex items-baseline justify-between gap-3">
							<h3 style={display} className="text-xl font-black leading-tight">
								{SPROUT_BREAKDOWN.heading}
							</h3>
							<span className="shrink-0 text-sm text-base-content/55">{SPROUT_BREAKDOWN.sub}</span>
						</div>
						<div className="mt-5 flex h-4 overflow-hidden rounded-full ring-2 ring-base-content/15">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className={SEG_BG[r.token]} style={{ width: `${r.pct}%` }} />
							))}
						</div>
						<dl className="mt-4 flex flex-col gap-2.5 text-sm">
							{SPROUT_BREAKDOWN.rows.map((r) => (
								<div key={r.label} className="flex items-center justify-between gap-3">
									<span className="flex items-center gap-2.5 text-base-content/75">
										<span className={`h-3 w-3 shrink-0 rounded-full ${SEG_BG[r.token]}`} />
										{r.label}
									</span>
									<span style={display} className="font-black">
										{r.amount}
									</span>
								</div>
							))}
						</dl>
						<div className="mt-4 flex items-baseline justify-between border-t-2 border-dashed border-base-content/25 pt-4">
							<span className="font-bold">{SPROUT_BREAKDOWN.toCreatorsLabel}</span>
							<span style={display} className="text-2xl font-black text-primary">
								{SPROUT_BREAKDOWN.toCreators}
							</span>
						</div>
						<p className="mt-3 text-xs leading-relaxed text-base-content/50">
							{SPROUT_BREAKDOWN.footnote}
						</p>
					</Packet>

					<div className="grid gap-6">
						{POOLS.map((p, i) => (
							<Packet
								key={p.title}
								rotate={i % 2 === 0 ? "0.7deg" : "-0.7deg"}
								className="hover:rotate-0"
							>
								<div className="flex items-center justify-between">
									<span
										style={display}
										className="rounded-full bg-secondary px-3 py-0.5 text-xs font-black uppercase tracking-wide text-secondary-content"
									>
										{p.eyebrow}
									</span>
									<span aria-hidden="true" className="text-2xl">
										{i === 0 ? "🕰️" : "🚀"}
									</span>
								</div>
								<h3 style={display} className="mt-3 text-xl font-black">
									{p.title}
								</h3>
								<p className="mt-2 text-sm leading-relaxed text-base-content/75">{p.body}</p>
							</Packet>
						))}
					</div>
				</div>
			</Section>

			{/* ── Badge ladder: collectible stamps ── */}
			<Section>
				<Header eyebrow="collect all four!" title="Your Anthers Badge — a rank that grows">
					Not a plan you pick or a tier you subscribe to: a rolling rank earned from your combined
					Usage&nbsp;+&nbsp;Boost spend over the last few months. Everyone starts unranked; your
					first $3 earns Root. Support more and you climb; ease off and it gently recedes.
				</Header>
				<div className="mt-12 grid grid-cols-2 gap-5 sm:gap-6 lg:grid-cols-4">
					{BADGE_RANKS.map((b, i) => (
						<StampCard key={b.name} index={i} {...b} />
					))}
				</div>
				<p className="mx-auto mt-8 max-w-2xl text-center text-sm text-base-content/55">
					Because your badge reflects the last few months, it moves with you—and some creators use
					it as a key that opens whole ranks of content at once. That's an{" "}
					<span className="font-bold text-primary">Anthers Gate</span>.
				</p>
			</Section>

			{/* ── Gates ── */}
			<Section tint>
				<Header eyebrow="two golden keys" title="Two clear ways to open a gate">
					Some growers keep premium work behind a gate. There are exactly two kinds—one earned from
					your support of a single creator, one from your standing across the whole platform.
				</Header>
				<div className="mt-10 grid gap-6 md:grid-cols-2">
					<Packet rotate="-0.7deg" className="hover:rotate-0">
						<div className="flex items-center justify-between">
							<p
								style={display}
								className="text-xs font-black uppercase tracking-[0.18em] text-primary"
							>
								Boost Gate
							</p>
							<Scribble className="text-lg text-accent">for one grower</Scribble>
						</div>
						<h3 style={display} className="mt-1 text-xl font-black">
							Your support for one creator
						</h3>
						<div className="mt-4">
							{BOOST_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</div>
					</Packet>
					<Packet rotate="0.7deg" className="hover:rotate-0">
						<div className="flex items-center justify-between">
							<p
								style={display}
								className="text-xs font-black uppercase tracking-[0.18em] text-accent"
							>
								Anthers Gate
							</p>
							<Scribble className="text-lg text-primary">whole catalog</Scribble>
						</div>
						<h3 style={display} className="mt-1 text-xl font-black">
							Your standing across the platform
						</h3>
						<div className="mt-4">
							{ANTHERS_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</div>
					</Packet>
				</div>
			</Section>

			{/* ── Delivery / bandwidth ── */}
			<Section>
				<Header eyebrow="first 3 GiB on us!" title="Watering costs, shown at the tap">
					Streaming and downloads cost bandwidth. Every other platform buries that in ads or a
					hidden cut. Anthers prints it as a line in your Usage—at cost—and hands you real tools to
					keep it small.
				</Header>
				<Packet rotate="-0.5deg" className="mt-10 text-center hover:rotate-0">
					<p className="text-balance leading-relaxed">
						<span style={display} className="text-2xl font-black text-primary">
							Your first 3 GiB each month is free
						</span>
						<span className="text-base-content/75">
							{" "}
							—the Foundation covers it. Beyond that, Usage is just{" "}
							<span className="font-bold">$0.03/GiB</span>, a third of it real bandwidth at cost.
						</span>
					</p>
				</Packet>
				<div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
					{DELIVERY_CONTROLS.map((c, i) => (
						<div
							key={c.title}
							style={{ transform: `rotate(${i % 2 === 0 ? "-0.6" : "0.6"}deg)` }}
							className="rounded-xl border-2 border-dashed border-base-content/20 bg-base-100 p-5"
						>
							<h3 style={display} className="text-base font-black leading-tight">
								{c.title}
							</h3>
							<p className="mt-2 text-xs leading-relaxed text-base-content/65">{c.body}</p>
						</div>
					))}
				</div>
			</Section>

			{/* ── Closing ── */}
			<section className="mx-auto max-w-3xl px-6 py-24">
				<Packet rotate="0.6deg" className="text-center">
					<div className="flex items-center justify-center gap-3">
						<Postmark className="h-16 w-16 rotate-[-6deg] text-accent" />
						<Scribble className="text-3xl text-primary">happy growing!</Scribble>
					</div>
					<h2
						style={display}
						className="mt-5 text-balance text-4xl font-black leading-tight sm:text-5xl"
					>
						Plant something worth growing
					</h2>
					<p className="mx-auto mt-4 max-w-xl leading-relaxed text-base-content/75">
						Support the growers you love, on terms you can see and trust. Browse the whole catalog
						free—no account required to open the first packet.
					</p>
					<div className="mt-8 flex flex-wrap justify-center gap-3">
						<button type="button" className="btn btn-primary rounded-full px-7 shadow-none">
							Open the catalog
						</button>
						<button
							type="button"
							className="btn btn-outline rounded-full border-2 border-dashed border-base-content/30 px-7"
						>
							Create a free account
						</button>
					</div>
				</Packet>
			</section>
		</div>
	);
}

// ─── Local building blocks ───

function Section({ children, tint }: { children: ReactNode; tint?: boolean }) {
	return (
		<section className={tint ? "bg-base-200/50" : ""}>
			<div className="mx-auto max-w-6xl px-6 py-20">{children}</div>
		</section>
	);
}

/** A dashed-border "cut-here" seed packet with an offset paper shadow. */
function Packet({
	children,
	className,
	rotate,
}: {
	children: ReactNode;
	className?: string;
	rotate?: string;
}) {
	return (
		<div
			style={rotate ? { transform: `rotate(${rotate})` } : undefined}
			className={`relative rounded-2xl border-2 border-dashed border-base-content/30 bg-base-100 p-6 shadow-[5px_5px_0_0_rgba(0,0,0,0.07)] transition-transform duration-200 sm:p-8 ${className ?? ""}`}
		>
			{children}
		</div>
	);
}

/** Left-aligned catalog header: Caveat eyebrow, font-black Fraunces title, lede. */
function Header({
	eyebrow,
	title,
	children,
}: {
	eyebrow: string;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="max-w-3xl">
			<Scribble className="inline-block -rotate-2 text-2xl text-accent">{eyebrow}</Scribble>
			<h2
				style={display}
				className="mt-1 text-balance text-4xl font-black leading-[1.02] tracking-tight sm:text-5xl"
			>
				{title}
			</h2>
			{children && <p className="mt-4 text-lg leading-relaxed text-base-content/70">{children}</p>}
		</div>
	);
}

/** Caveat hand-lettered accent text; color/rotation via className. */
function Scribble({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<span style={hand} className={className}>
			{children}
		</span>
	);
}

/** A circular postmark stamp: dashed ring, circular text, sunflower rosette center. */
function Postmark({ className }: { className?: string }) {
	const raw = useId();
	const pathId = `pm-${raw.replace(/[:]/g, "")}`;
	return (
		<svg
			viewBox="0 0 120 120"
			className={className}
			role="img"
			aria-label="Anthers Seed Co. postmark"
		>
			<defs>
				<path id={pathId} d="M60,60 m-46,0 a46,46 0 1,1 92,0 a46,46 0 1,1 -92,0" fill="none" />
			</defs>
			<circle
				cx="60"
				cy="60"
				r="57"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeDasharray="2 4"
			/>
			<circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<text
				fontSize="9.5"
				fontWeight="800"
				letterSpacing="1.5"
				fill="currentColor"
				style={{ fontFamily: FONTS.nunito }}
			>
				<textPath href={`#${pathId}`} startOffset="2%">
					ANTHERS SEED CO · ZERO CUT ·
				</textPath>
			</text>
			{Array.from({ length: 12 }).map((_, i) => (
				<ellipse
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative petal ring
					key={i}
					cx="60"
					cy="34"
					rx="3.5"
					ry="10"
					fill="currentColor"
					transform={`rotate(${i * 30} 60 60)`}
				/>
			))}
			<circle cx="60" cy="60" r="8" fill="currentColor" />
			<circle cx="60" cy="60" r="3.5" fill="var(--color-base-100)" />
		</svg>
	);
}

/** Small round "No." stamp used on the Three Ways packets. */
function StampNo({ n }: { n: string }) {
	return (
		<span
			style={display}
			className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-dashed border-accent/60 bg-accent/10 text-xl font-black text-accent"
		>
			{n}
		</span>
	);
}

/** A collectible seed-packet stamp for the badge ladder. */
function StampCard({
	index,
	emoji,
	name,
	threshold,
	flavor,
}: {
	index: number;
	emoji: string;
	name: string;
	threshold: string;
	flavor: string;
}) {
	return (
		<div
			style={{ transform: `rotate(${index % 2 === 0 ? "-1.5" : "1.5"}deg)` }}
			className="rounded-lg border-4 border-dotted border-base-content/25 bg-base-200 p-2 transition-transform duration-200 hover:rotate-0"
		>
			<div className="relative rounded-md border border-base-content/10 bg-base-100 px-3 pt-4 pb-4 text-center">
				<span
					style={display}
					className="absolute right-1.5 top-1.5 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-black text-accent-content"
				>
					{threshold}
				</span>
				<div className="text-5xl" aria-hidden="true">
					{emoji}
				</div>
				<h3 style={display} className="mt-2 text-lg font-black">
					{name}
				</h3>
				<p className="mt-1.5 text-xs leading-relaxed text-base-content/60">{flavor}</p>
				<Scribble className="mt-2 block text-base text-primary">No. {index + 1}</Scribble>
			</div>
		</div>
	);
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className={strong ? "font-bold" : "text-base-content/70"}>{label}</span>
			<span style={display} className={strong ? "font-black" : "font-bold text-base-content/70"}>
				{value}
			</span>
		</div>
	);
}

function GateRow({ amount, name, perk }: { amount: string; name: string; perk: string }) {
	return (
		<div className="flex items-center gap-3 border-t border-dashed border-base-content/20 py-2.5 first:border-t-0">
			<span
				style={display}
				className="w-12 shrink-0 rounded-full bg-primary/10 py-0.5 text-center text-xs font-black text-primary"
			>
				{amount}
			</span>
			<span style={display} className="w-24 shrink-0 font-black">
				{name}
			</span>
			<span className="text-xs text-base-content/60">{perk}</span>
		</div>
	);
}

/** Dashed footer line with scissors + a hand-lettered aside — the "cut here" motif. */
function CutFooter({ note }: { note: string }) {
	return (
		<div className="mt-8 flex items-center gap-3 border-t-2 border-dashed border-base-content/25 pt-4">
			<span aria-hidden="true" className="text-lg">
				✂
			</span>
			<div className="h-px flex-1" />
			<Scribble className="text-xl text-accent">{note}</Scribble>
		</div>
	);
}
