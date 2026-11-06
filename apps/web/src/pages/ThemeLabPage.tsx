// SPDX-License-Identifier: Apache-2.0
//
// The theme study at /themes: six candidate palettes beside the one the site uses
// today, each shown in a light and a dark variant so a choice can be made by looking
// rather than by reading oklch numbers.
//
// Why a page and not a picker entry: the catalog is a set of shipped commitments, and
// twelve palettes do not belong in every reader's theme menu while one is being chosen.
// The candidates live in `packages/web-shared/src/styles/theme-candidates.css`, scoped
// by `data-theme` onto the preview surfaces here; the real palette and the two pickers
// are untouched. When a family is picked it moves into theme.css, the `Theme` union and
// `THEMES`, and the rest of the candidate file is deleted.
//
// The page renders bare — outside every shell — because the shell is itself one of the
// surfaces being judged. Each preview draws its own nav, hero, buttons, card, field and
// swatches, and the full-page view draws a long editorial page in the chosen palette.
// A control bar outside the scope carries the switching, so a dark preview never drags
// a dark control bar over the page it is meant to be judged against.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Card, Eyebrow, H2, Lede, Section, SignpostCard } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { useEffect, useState } from "react";
import {
	CURRENT_FAMILY,
	FOCUS_FAMILIES,
	LAB_FAMILIES,
	type LabFamily,
	type LabVariant,
	themeValue,
} from "./theme-lab-data";

const serif = { fontFamily: FONTS.fraunces };
const bodyFont = { fontFamily: FONTS.nunito };

type VariantFilter = "both" | LabVariant;

const VARIANT_FILTERS: { value: VariantFilter; label: string }[] = [
	{ value: "both", label: "Both" },
	{ value: "light", label: "Light only" },
	{ value: "dark", label: "Dark only" },
];

/** One family's preview card in the grid. */
function FamilyCard({
	family,
	filter,
	onOpen,
}: {
	family: LabFamily;
	filter: VariantFilter;
	onOpen: (family: LabFamily, variant: LabVariant) => void;
}) {
	const variants: LabVariant[] = filter === "both" ? ["light", "dark"] : [filter];

	return (
		<article className="rounded-3xl border border-base-content/10 bg-base-200/40 p-4 sm:p-5">
			<header className="mb-4 flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h2 style={serif} className="text-2xl font-medium">
							{family.name}
						</h2>
						{family.current && <span className="badge badge-sm badge-ghost">Current</span>}
					</div>
					<p className="mt-1 max-w-xl text-sm leading-relaxed text-base-content/60">
						{family.concept}
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						className="btn btn-xs btn-outline"
						onClick={() => onOpen(family, "light")}
					>
						Light page
					</button>
					<button
						type="button"
						className="btn btn-xs btn-outline"
						onClick={() => onOpen(family, "dark")}
					>
						Dark page
					</button>
				</div>
			</header>

			<div className={filter === "both" ? "grid gap-4 lg:grid-cols-2" : ""}>
				{variants.map((variant) => (
					<div key={variant}>
						<p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-base-content/45">
							{variant === "light" ? "Light" : "Dark"}
						</p>
						<PreviewPanel family={family} variant={variant} />
					</div>
				))}
			</div>
		</article>
	);
}

/** A compact but real surface: nav, hero, buttons, card, field, and the palette bars. */
function PreviewPanel({ family, variant }: { family: LabFamily; variant: LabVariant }) {
	return (
		<section
			data-theme={themeValue(family, variant)}
			aria-label={`${family.name}, ${variant} variant`}
			className="overflow-hidden rounded-xl border border-base-content/15 bg-base-100 text-base-content"
		>
			<div className="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-2.5">
				<span className="flex items-center gap-1.5">
					<Sprig className="h-4 w-4 text-primary" />
					<span className="text-sm font-semibold tracking-tight">Anthers</span>
				</span>
				<span className="hidden items-center gap-3 text-[10px] text-base-content/55 sm:flex">
					<span>For Users</span>
					<span>For Creators</span>
					<span>Resources</span>
				</span>
				<span className="rounded-md bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-content">
					Sign Up
				</span>
			</div>

			<div className="bg-base-200/70 px-4 pb-5 pt-4">
				<p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-primary">
					A creative garden
				</p>
				<p style={serif} className="mt-1.5 text-xl font-light leading-tight">
					Make what you love.{" "}
					<em className="font-medium not-italic text-primary">Keep what you earn.</em>
				</p>
				<p className="mt-2 text-[11px] leading-relaxed text-base-content/65">
					A nonprofit home for videos, games, music and writing, where readers support creators
					directly. <span className="text-primary underline underline-offset-2">How it works</span>
				</p>
				<div className="mt-3 flex flex-wrap gap-2">
					<span className="rounded-md bg-primary px-3 py-1.5 text-[10px] font-semibold text-primary-content">
						Start Exploring
					</span>
					<span className="rounded-md border border-base-content/20 px-3 py-1.5 text-[10px] font-medium">
						For Creators
					</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2 px-4 py-4">
				<div className="rounded-lg border border-base-content/10 bg-base-200 p-2.5">
					<p className="text-[9px] uppercase tracking-wide text-base-content/50">Support</p>
					<p className="mt-0.5 text-[11px] font-medium">A creator you love</p>
					<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-base-300">
						<div className="h-full w-2/3 rounded-full bg-primary" />
					</div>
					<div className="mt-2 flex flex-wrap gap-1">
						<span className="rounded bg-primary px-1.5 py-0.5 text-[8px] font-semibold text-primary-content">
							Root
						</span>
						<span className="rounded bg-secondary px-1.5 py-0.5 text-[8px] font-semibold text-secondary-content">
							Petal
						</span>
						<span className="rounded bg-accent px-1.5 py-0.5 text-[8px] font-semibold text-accent-content">
							Blossom
						</span>
					</div>
				</div>
				<div className="space-y-1.5">
					<div className="rounded-md border border-base-content/15 px-2 py-1.5 text-[10px] text-base-content/40">
						Search the garden
					</div>
					<div className="flex items-center gap-1.5 text-[9px] text-base-content/70">
						<span className="flex h-3 w-3 items-center justify-center rounded-full bg-primary text-[7px] text-primary-content">
							✓
						</span>
						Follow this creator
					</div>
					<div className="flex items-center gap-1 text-[9px] text-base-content/55">
						<span className="h-2 w-2 rounded-full bg-success" />
						<span>Available today</span>
					</div>
				</div>
			</div>

			<Swatches />
		</section>
	);
}

const SWATCHES: { token: string; label: string; border?: boolean }[] = [
	{ token: "bg-base-100", label: "Base", border: true },
	{ token: "bg-base-200", label: "Surface" },
	{ token: "bg-base-300", label: "Edge" },
	{ token: "bg-primary", label: "Primary" },
	{ token: "bg-secondary", label: "Secondary" },
	{ token: "bg-accent", label: "Accent" },
	{ token: "bg-neutral", label: "Neutral" },
];

function Swatches() {
	return (
		<div className="grid grid-cols-7 gap-1 border-t border-base-content/10 px-4 py-3">
			{SWATCHES.map((swatch) => (
				<div key={swatch.label} title={swatch.label}>
					<div
						aria-hidden="true"
						className={`h-2.5 rounded-sm ${swatch.token} ${swatch.border ? "border border-base-content/15" : ""}`}
					/>
					<p className="mt-1 truncate text-center text-[8px] text-base-content/45">
						{swatch.label}
					</p>
				</div>
			))}
		</div>
	);
}

/** A full editorial page in one palette, for judging the thing at size. */
function FullMockPage({ family, variant }: { family: LabFamily; variant: LabVariant }) {
	return (
		<div
			data-theme={themeValue(family, variant)}
			className="min-h-screen bg-base-100 pb-24 text-base-content"
		>
			<header className="sticky top-0 z-30 border-b border-base-content/10 bg-base-100/85 backdrop-blur">
				<div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
					<span className="flex items-center gap-2">
						<Sprig className="h-6 w-6 text-primary" />
						<span className="text-lg font-semibold tracking-tight">Anthers</span>
					</span>
					<nav
						aria-label="Preview navigation"
						className="hidden items-center gap-6 text-sm text-base-content/65 md:flex"
					>
						<span>For Users</span>
						<span>For Creators</span>
						<span>Resources</span>
						<span>About Us</span>
					</nav>
					<div className="flex items-center gap-2">
						<span className="hidden px-3 py-2 text-sm font-medium sm:inline">Log In</span>
						<span className="btn btn-primary btn-sm rounded-lg">Sign Up Free</span>
					</div>
				</div>
			</header>

			<section className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pb-20 pt-20 text-center">
					<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
					<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
						For the Players, Listeners, Viewers, Readers &amp; Fans
					</p>
					<h1
						style={serif}
						className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
					>
						Our creative garden,
						<br />
						<em className="font-medium not-italic text-primary">where we can all grow together</em>
					</h1>
					<p className="mx-auto mt-8 max-w-3xl text-lg leading-relaxed text-base-content/70">
						Anthers is a nonprofit creative garden for everyone: a place for videos, games, music,
						writing, crafts, services, and more, all on an open-source, ad-free platform.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<span className="btn btn-primary rounded-lg px-8">Start Exploring</span>
						<span className="btn btn-outline rounded-lg px-8">Browse Creators</span>
					</div>
					<p className="mx-auto mt-6 max-w-xl text-sm text-base-content/50">
						No ads, ever. No shareholders, ever. Just freedom to see and be seen.
					</p>
				</div>
			</section>

			<Section>
				<Eyebrow>How it works</Eyebrow>
				<H2>Support the creators you love, and grow the garden for all</H2>
				<Lede>
					Anthers is where you back the people whose work you love. Give a creator a monthly amount,
					or buy something they made outright; Anthers takes no cut of either one.
				</Lede>
				<div className="my-8 grid gap-6 text-left sm:grid-cols-2">
					<SignpostCard step="1" title="Support Creators" tone="creator">
						Directing a monthly amount to a creator does the following:
						<ul>
							<li>Send that creator your support with no platform cut</li>
							<li>Open that creator's gated work at a level they set</li>
							<li>Hold that creator's Badges for as long as you keep giving</li>
						</ul>
					</SignpostCard>
					<SignpostCard step="2" title="Support Anthers" tone="anthers">
						Giving Anthers a monthly amount, entirely optional, does the following:
						<ul>
							<li>Increase the pool of money distributed to creators you spend time with</li>
							<li>Fund free public access and Anthers' charitable programs for all</li>
						</ul>
					</SignpostCard>
				</div>
			</Section>

			<Section tint>
				<Eyebrow>The garden</Eyebrow>
				<H2>A home for every kind of work</H2>
				<div className="mt-8 grid gap-5 text-left sm:grid-cols-3">
					<Card>
						<h3 style={serif} className="text-xl font-medium">
							Video &amp; Film
						</h3>
						<p className="mt-2 text-sm leading-relaxed text-base-content/65">
							Adaptive playback, chapters, captions, and a player that remembers where you stopped.
						</p>
					</Card>
					<Card>
						<h3 style={serif} className="text-xl font-medium">
							Games
						</h3>
						<p className="mt-2 text-sm leading-relaxed text-base-content/65">
							Downloadable builds and web-native games, with updates that reach players who already
							bought.
						</p>
					</Card>
					<Card>
						<h3 style={serif} className="text-xl font-medium">
							Music &amp; Audio
						</h3>
						<p className="mt-2 text-sm leading-relaxed text-base-content/65">
							Full-quality downloads, waveform playback, and spoken audio made for listening to
							talk.
						</p>
					</Card>
				</div>
			</Section>

			<Section>
				<Eyebrow>A last word</Eyebrow>
				<H2>The price you see is the price you pay</H2>
				<Lede>
					Sales tax is the only thing ever added. Anthers takes no cut of what you give a creator,
					and nothing here is gated behind a Badge.
				</Lede>
				<div className="mt-8 flex flex-wrap items-center justify-center gap-2">
					<span className="badge badge-primary">Root</span>
					<span className="badge badge-secondary">Petal</span>
					<span className="badge badge-accent">Blossom</span>
					<span className="badge badge-neutral">Free</span>
				</div>
				<div className="mt-8 flex flex-wrap justify-center gap-3">
					<span className="btn btn-primary rounded-lg px-8">Start Exploring</span>
					<span className="btn btn-ghost rounded-lg px-8">Read the Model</span>
				</div>
			</Section>

			<footer className="border-t border-base-content/10 px-6 py-10 text-sm text-base-content/50">
				<div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
					<span>Anthers is a nonprofit creative garden.</span>
					<span>Terms · Privacy · Status · Release Notes</span>
				</div>
			</footer>
		</div>
	);
}

/** The full-page view's switcher, outside the preview scope so it keeps the site palette. */
function FocusBar({
	family,
	variant,
	onFamily,
	onVariant,
	onBack,
}: {
	family: LabFamily;
	variant: LabVariant;
	onFamily: (family: LabFamily) => void;
	onVariant: (variant: LabVariant) => void;
	onBack: () => void;
}) {
	return (
		<div className="fixed inset-x-0 bottom-0 z-50 border-t border-base-content/15 bg-base-100/95 backdrop-blur">
			<div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
				<button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>
					← All palettes
				</button>
				<span className="hidden h-6 w-px bg-base-content/15 sm:block" />
				<div className="flex flex-wrap items-center gap-1.5">
					{FOCUS_FAMILIES.map((option) => (
						<button
							key={option.slug}
							type="button"
							aria-label={option.current ? `${option.name}, current palette` : option.name}
							onClick={() => onFamily(option)}
							className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
								option.slug === family.slug
									? "border-primary bg-primary/10 font-semibold text-primary"
									: "border-base-content/15 text-base-content/70 hover:border-base-content/30"
							}`}
						>
							<span data-theme={themeValue(option, variant)} className="inline-flex">
								<span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-primary" />
							</span>
							{option.name}
							{option.current && (
								<span className="text-[9px] uppercase tracking-wide text-base-content/40">now</span>
							)}
						</button>
					))}
				</div>
				<span className="ml-auto hidden h-6 w-px bg-base-content/15 sm:block" />
				<div className="join">
					<button
						type="button"
						className={`btn btn-sm join-item ${variant === "light" ? "btn-primary" : "btn-ghost"}`}
						onClick={() => onVariant("light")}
					>
						Light
					</button>
					<button
						type="button"
						className={`btn btn-sm join-item ${variant === "dark" ? "btn-primary" : "btn-ghost"}`}
						onClick={() => onVariant("dark")}
					>
						Dark
					</button>
				</div>
				<span className="hidden text-xs text-base-content/45 lg:inline">
					Esc returns to the grid
				</span>
			</div>
		</div>
	);
}

export default function ThemeLabPage() {
	usePageTitle("Theme Study");

	const [filter, setFilter] = useState<VariantFilter>("both");
	const [focus, setFocus] = useState<{ family: LabFamily; variant: LabVariant } | null>(null);

	// Esc leaves the full-page view. The listener exists only while it has something
	// to do, and the grid is where the page loaded, so there is no history to restore.
	useEffect(() => {
		if (!focus) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFocus(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [focus]);

	useEffect(() => {
		if (focus) window.scrollTo(0, 0);
	}, [focus]);

	if (focus) {
		return (
			<div style={bodyFont}>
				<FullMockPage family={focus.family} variant={focus.variant} />
				<FocusBar
					family={focus.family}
					variant={focus.variant}
					onFamily={(family) => setFocus({ family, variant: focus.variant })}
					onVariant={(variant) => setFocus({ family: focus.family, variant })}
					onBack={() => setFocus(null)}
				/>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-base-100 text-base-content" style={bodyFont}>
			<header className="bg-base-200/50">
				<div className="mx-auto max-w-7xl px-6 pb-10 pt-14">
					<p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
						Theme Study
					</p>
					<h1
						style={serif}
						className="mt-3 max-w-3xl text-balance text-4xl font-light leading-tight sm:text-5xl"
					>
						Six palettes, each with a light and a dark side
					</h1>
					<p className="mt-4 max-w-3xl text-base leading-relaxed text-base-content/70">
						Every candidate keeps Meadow's roles — primary carries headings, links and buttons,
						secondary is the quieter fill, and accent is the warm edge — but moves the palette away
						from green and yellow. Open any family at full size to read a whole page in one variant;
						Meadow, the palette the site uses today, is in that switcher for comparison.
					</p>
					<p className="mt-2 max-w-3xl text-sm leading-relaxed text-base-content/50">
						Every palette's text-on-color roles were checked at WCAG AA before they landed. These
						palettes are candidates only: the site's pickers still offer Meadow until one is chosen.
					</p>
				</div>
			</header>

			<div className="sticky top-0 z-30 border-b border-base-content/10 bg-base-100/90 backdrop-blur">
				<div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3">
					<p className="text-sm text-base-content/60">
						{LAB_FAMILIES.length} families × 2 variants
					</p>
					<div className="join">
						{VARIANT_FILTERS.map((option) => (
							<button
								key={option.value}
								type="button"
								className={`btn btn-sm join-item ${
									filter === option.value ? "btn-primary" : "btn-ghost"
								}`}
								onClick={() => setFilter(option.value)}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
			</div>

			<main className="mx-auto max-w-7xl px-6 py-10">
				<div className={`grid gap-6 ${filter === "both" ? "" : "xl:grid-cols-2"}`}>
					{LAB_FAMILIES.map((family) => (
						<FamilyCard
							key={family.slug}
							family={family}
							filter={filter}
							onOpen={(nextFamily, variant) => setFocus({ family: nextFamily, variant })}
						/>
					))}
				</div>

				<p className="mx-auto mt-10 max-w-3xl text-center text-sm text-base-content/50">
					Meadow, the current palette, is deliberately not one of the six. It is the baseline the
					others are read against, and it stays available in the full-page switcher above.
				</p>
			</main>

			<footer className="border-t border-base-content/10 px-6 py-8 text-center text-xs text-base-content/40">
				Theme study · {CURRENT_FAMILY.name} remains the live palette
			</footer>
		</div>
	);
}
