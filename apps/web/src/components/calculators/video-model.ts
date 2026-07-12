// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared video-bitrate model for the Video Storage and Video Bandwidth
// calculators. Both tools size content from the same AV1 delivery ladder and the
// same bytes-per-bitrate constant, so the reference numbers live here once. Ported
// from the standalone planning tools in the Anthers business-and-finance wiki.

export type Resolution = "240p" | "480p" | "720p" | "1080p" | "1440p" | "2160p";

/** 1 Mbps sustained for one hour, expressed in GiB (2^30 bytes). */
export const GIB_PER_MBPS_HR = 0.4190952;

/** Opus audio carried alongside each delivered/ladder rung, in Mbps. */
export const RUNG_AUDIO_MBPS = 0.128;

/** Framerate scaling applied to the 30fps reference bitrates. */
export const FPS_MULT: Record<number, number> = { 24: 0.92, 30: 1.0, 60: 1.4 };

export const RES_HEIGHT: Record<Resolution, number> = {
	"240p": 240,
	"480p": 480,
	"720p": 720,
	"1080p": 1080,
	"1440p": 1440,
	"2160p": 2160,
};

/**
 * Category colours for the resolution rungs — a cool→warm ramp (low→high res)
 * chosen to stay legible on both the light and dark themes. These are data-viz
 * marks, not theme chrome, so they're fixed hex like the other chart colours in
 * the app (see InfrastructureDemoPage).
 */
export const RES_COLOR: Record<Resolution, string> = {
	"240p": "#60a5fa",
	"480p": "#22d3ee",
	"720p": "#4ade80",
	"1080p": "#facc15",
	"1440p": "#fb923c",
	"2160p": "#f87171",
};

/** High → low, the order a storage transcode ladder is built and stacked. */
export const RES_LADDER_HIGH_TO_LOW: Resolution[] = [
	"2160p",
	"1440p",
	"1080p",
	"720p",
	"480p",
	"240p",
];

/** Low → high, the order the bandwidth tier menu is listed. */
export const RES_TIERS_LOW_TO_HIGH: Resolution[] = [
	"240p",
	"480p",
	"720p",
	"1080p",
	"1440p",
	"2160p",
];

/**
 * AV1 delivery-ladder video bitrate reference at 30fps (Mbps), good-quality VBR.
 * The storage calculator builds its whole ladder from these; the bandwidth
 * calculator uses them as its AV1 codec row.
 */
export const AV1_REF30: Record<Resolution, number> = {
	"240p": 0.15,
	"480p": 0.55,
	"720p": 1.4,
	"1080p": 2.8,
	"1440p": 5.5,
	"2160p": 9.0,
};

/**
 * A ladder rung at 720p and above inherits the source framerate; rungs below
 * 720p are held to 30fps (higher framerates buy little at low resolution).
 */
export function rungFps(res: Resolution, srcFps: number): number {
	return RES_HEIGHT[res] >= 720 ? srcFps : Math.min(srcFps, 30);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Money with adaptive precision — dollars-and-cents above $1, finer below. */
export function money(v: number): string {
	if (v >= 1)
		return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	if (v >= 0.01) return `$${v.toFixed(3)}`;
	return `$${v.toFixed(4)}`;
}

/** Larger headline money figure — three decimals below $1 for readability. */
export function moneyBig(v: number): string {
	if (v >= 1)
		return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	return `$${v.toFixed(3)}`;
}

/** Fixed-decimal helper for bitrates / sizes. */
export function fixed(v: number, d: number): string {
	return v.toFixed(d);
}

/** Trim a number to at most two decimals without trailing zeros. */
export function trimNum(v: number): string {
	return (Math.round(v * 100) / 100).toString();
}

/** Render a duration in hours as a compact "1h 26m" / "45 min" / "30 sec". */
export function fmtTime(hours: number): string {
	if (!Number.isFinite(hours) || hours <= 0) return "—";
	const totalMin = hours * 60;
	if (totalMin < 1) return `${Math.round(hours * 3600)} sec`;
	let h = Math.floor(totalMin / 60);
	let m = Math.round(totalMin - h * 60);
	if (m === 60) {
		h += 1;
		m = 0;
	}
	if (h === 0) return `${m} min`;
	return `${h}h ${m}m`;
}
