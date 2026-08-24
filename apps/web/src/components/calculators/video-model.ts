// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared video-bitrate model for the Video Storage calculator. It sizes content
// from the AV1 delivery ladder and a bytes-per-bitrate constant, and the reference
// numbers live here rather than in the page. Ported from the standalone planning
// tools in the Anthers business-and-finance wiki.
//
// It was shared with a Video Bandwidth calculator until 2026-08-12, when that page
// was retired: it priced a user-facing bandwidth allowance that no longer exists,
// and quoted $0.01/GiB — DigitalOcean Spaces' egress rate — a day after we moved to
// R2, where egress is $0 at any volume. The SIZING half of it was never wrong, and
// is what survives here.

export type Resolution = "240p" | "480p" | "720p" | "1080p" | "1440p" | "2160p";

export type MasterFormat = "h264" | "h265" | "prores";

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

/**
 * AV1 delivery-ladder video bitrate reference at 30fps (Mbps), good-quality VBR.
 * The storage calculator builds its whole ladder from these. (A bandwidth
 * calculator used them as its AV1 codec row until 2026-08-12, when it was retired
 * along with the user-facing bandwidth allowance it existed to spend.)
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

/** Master export reference: 30fps video bitrate (Mbps) per format + fps scaling. */
export const MASTER_EXPORT: Record<
	MasterFormat,
	{ label: string; ref: Partial<Record<Resolution, number>>; fps: Record<number, number> }
> = {
	h264: {
		label: "H.264 master",
		ref: { "720p": 6, "1080p": 12, "1440p": 20, "2160p": 45 },
		fps: { 24: 0.9, 30: 1.0, 60: 1.5 },
	},
	h265: {
		label: "H.265 master",
		ref: { "720p": 4, "1080p": 8, "1440p": 13, "2160p": 28 },
		fps: { 24: 0.9, 30: 1.0, 60: 1.5 },
	},
	prores: {
		label: "ProRes 422HQ master",
		ref: { "720p": 98, "1080p": 220, "1440p": 390, "2160p": 880 },
		fps: { 24: 0.8, 30: 1.0, 60: 2.0 },
	},
};

/** The master carries a higher-rate audio track than the delivery rungs. */
export const MASTER_AUDIO_MBPS = 0.256;

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
