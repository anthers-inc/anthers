// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared kit for the For Users design lab (/for-users-lab). This is a TEST BED:
// six botanical redesign variants of the For Users page, each with its own
// light + dark palette, flipped by a corner toggle. Everything here is
// self-contained and deletable — the whole lab is `pages/lab/` + one route.
//
// Palettes are scoped per-variant by writing DaisyUI's `--color-*` custom
// properties onto the variant's root wrapper (they inherit into the subtree),
// so we never touch the shared brand theme. The invariant V3 economics data
// lives here once, so every variant's rewritten copy stays factually correct.

import type { CSSProperties } from "react";

export type Mode = "light" | "dark";

/** The DaisyUI color tokens each variant overrides. Any valid CSS color string. */
export type Palette = {
	"base-100": string;
	"base-200": string;
	"base-300": string;
	"base-content": string;
	primary: string;
	"primary-content": string;
	secondary: string;
	"secondary-content": string;
	accent: string;
	"accent-content": string;
	neutral: string;
	"neutral-content": string;
	info: string;
	success: string;
	warning: string;
	error: string;
};

/**
 * Turn a Palette into an inline style object of DaisyUI CSS variables, scoped to
 * the subtree it's applied on. `scheme` sets `color-scheme` so form controls,
 * scrollbars, etc. render for the right mode. `extra` merges in per-variant
 * styles (background, fontFamily, …).
 */
export function paletteVars(
	p: Palette,
	scheme: Mode,
	extra: Record<string, string> = {},
): CSSProperties {
	const vars: Record<string, string> = {
		colorScheme: scheme,
		"--color-base-100": p["base-100"],
		"--color-base-200": p["base-200"],
		"--color-base-300": p["base-300"],
		"--color-base-content": p["base-content"],
		"--color-primary": p.primary,
		"--color-primary-content": p["primary-content"],
		"--color-secondary": p.secondary,
		"--color-secondary-content": p["secondary-content"],
		"--color-accent": p.accent,
		"--color-accent-content": p["accent-content"],
		"--color-neutral": p.neutral,
		"--color-neutral-content": p["neutral-content"],
		"--color-info": p.info,
		"--color-info-content": p["base-100"],
		"--color-success": p.success,
		"--color-success-content": p["base-100"],
		"--color-warning": p.warning,
		"--color-warning-content": p["base-100"],
		"--color-error": p.error,
		"--color-error-content": p["base-100"],
		...extra,
	};
	return vars as CSSProperties;
}

/**
 * Literal background classes for the breakdown tokens. Tailwind only generates
 * classes it finds as complete strings in source, so template-built names like
 * `bg-${token}` never get emitted — always index into this map instead.
 */
export const SEG_BG: Record<string, string> = {
	neutral: "bg-neutral",
	info: "bg-info",
	primary: "bg-primary",
	secondary: "bg-secondary",
	accent: "bg-accent",
	success: "bg-success",
};

/** Web families loaded in index.html. Use via inline `fontFamily`. */
export const FONTS = {
	fraunces: '"Fraunces", Georgia, "Times New Roman", serif',
	nunito: '"Nunito Sans", system-ui, -apple-system, sans-serif',
	spectral: '"Spectral", Georgia, serif',
	caveat: '"Caveat", "Segoe Script", cursive',
};

// ─── Invariant V3 data (shared by every variant; copy voice varies, numbers don't) ───

export const THREE_WAYS = [
	{
		step: "1",
		title: "Free use",
		body: "Browse, download free content, and play web games within a generous free allowance on a free account.",
	},
	{
		step: "2",
		title: "One-time purchases",
		body: "Buy a game, album, film, or book outright. The creator's price is exactly what they receive.",
	},
	{
		step: "3",
		title: "Support",
		body: "Buy Usage for open access and send Boosts to creators—unlocking more across the platform, a dollar at a time.",
	},
] as const;

export const FREE_INCLUDES = [
	{
		yes: true,
		text: "Your first 3 GiB of delivery each month—watching, listening, reading, and playing—covered by the Foundation.",
	},
	{
		yes: true,
		text: "Everything a creator has chosen to make free, with no login wall and no “subscribe to download” trick.",
	},
	{ yes: true, text: "Web games you can play instantly with a free account." },
	{
		yes: false,
		text: "Gated Boost and Badge content stays locked until you support the creator or platform.",
	},
	{
		yes: false,
		text: "Free time doesn't fund the creator pools—that's what buying Usage and boosting add.",
	},
] as const;

/** Where a $7 Sprout month goes: 200 GiB usage + $1 boost. */
export const SPROUT_BREAKDOWN = {
	heading: "Where a $7 Sprout month goes",
	sub: "200 GiB usage + $1 boost",
	rows: [
		{ label: "Bandwidth — delivery, at cost", amount: "$2.00", pct: 29, token: "neutral" },
		{ label: "Anthers Foundation Fee — charity", amount: "$1.00", pct: 14, token: "info" },
		{ label: "Time Pool — creators, by time spent", amount: "$3.00", pct: 43, token: "primary" },
		{ label: "Boost — creators you direct it to", amount: "$1.00", pct: 14, token: "secondary" },
	],
	toCreatorsLabel: "To creators (Time Pool + Boost)",
	toCreators: "$4.00",
	footnote:
		"Card processing and sales tax are added on top and leave the system entirely—to the processor and the state, never to Anthers. Anthers's own cut is $0.",
} as const;

export const POOLS = [
	{
		eyebrow: "Automatic",
		title: "The Time Pool",
		body: "Funded by your Usage and shared out automatically by the time you spend—and a minute is a minute. A video, an essay, an album, a game all count exactly the same. Every creator you spend time with gets funded, with no effort from you.",
	},
	{
		eyebrow: "Your call",
		title: "Boost",
		body: "Point your support wherever you want, in $1 units—or leave it on auto and it follows your time. Every boost dollar goes 100% to creators. It's how you champion the people who matter most to you, and it's what unlocks their premium content.",
	},
] as const;

export const BADGE_RANKS = [
	{
		emoji: "🌰",
		name: "Root",
		threshold: "$3+",
		flavor: "Your first few dollars of support—you're on the board.",
	},
	{
		emoji: "🌱",
		name: "Sprout",
		threshold: "$7+",
		flavor: "Putting down roots, supporting creators month to month.",
	},
	{
		emoji: "🌷",
		name: "Petal",
		threshold: "$15+",
		flavor: "In full leaf—a real pillar for the creators you follow.",
	},
	{
		emoji: "🌸",
		name: "Blossom",
		threshold: "$30+",
		flavor: "Flourishing—among the platform's most devoted supporters.",
	},
] as const;

export const BOOST_GATES = [
	{ amount: "$1", name: "Follow+", perk: "Chat access, community polls" },
	{ amount: "$2", name: "Insider", perk: "Early access, community posts" },
	{ amount: "$3", name: "Supporter", perk: "Behind-the-scenes, extended cuts" },
	{ amount: "$5", name: "Champion", perk: "Monthly Q&A, name in credits" },
] as const;

export const ANTHERS_GATES = [
	{ amount: "$3+", name: "Root", perk: "Root-level content, platform-wide" },
	{ amount: "$7+", name: "Sprout", perk: "Sprout-level content, platform-wide" },
	{ amount: "$15+", name: "Petal", perk: "Petal-level content, platform-wide" },
	{ amount: "$30+", name: "Blossom", perk: "Blossom-level content, platform-wide" },
] as const;

export const DELIVERY_CONTROLS = [
	{
		title: "Smart quality scaling",
		body: "Video in a small window doesn't stream in 4K. Resolution matches the space it's shown in, so you don't pay for pixels you can't see.",
	},
	{
		title: "Audio-only mode",
		body: "Listening with the screen off? Drop to audio and cut bandwidth by 95%+—ideal for longform you don't need to watch.",
	},
	{
		title: "Download & cache",
		body: "Rewatching a favorite doesn't cost delivery twice. Cached and downloaded replays are free—and the creator still gets credited for your time.",
	},
	{
		title: "Live usage dashboard",
		body: "See your delivery cost as it happens, with a projection for the month. No surprises at billing time—ever.",
	},
] as const;

export const PRICING_MODELS = [
	{ title: "Free", body: "If a creator made it free, you get it free—no purchase, no paywall." },
	{
		title: "Pay what you want",
		body: "Some creators let you choose. Give what you can—even $1 helps—or nothing at all.",
	},
	{ title: "Fixed price", body: "The price you see is the price the creator set—and receives." },
] as const;
