// SPDX-License-Identifier: AGPL-3.0-or-later
//
// econ:allow-file — KNOWN DEFECT, allowed only so the guard that FOUND it can ship.
//
// This whole calculator is built on a user-facing bandwidth allowance priced in
// dollars, and both were deleted 2026-08-12. Its notes still say the Seeds a viewer
// gives Anthers "cover this egress at cost ($0.01/GiB)" — that rate was DigitalOcean
// Spaces' egress price, and we moved to Cloudflare R2 ($0 egress) on 2026-08-11 — and
// the page's premise is how much watch time an allowance buys "before it runs out".
// 63.01 § Storage forbids describing a user-side bandwidth line at all: delivery is
// free to everyone, at any volume.
//
// The SIZING is still sound and still useful (a Mbps-hour really is 0.419 GiB, and
// DELIVERY_GIB_PER_HOUR deliberately survived the retirement as a capacity figure).
// What has no owner any more is the allowance the sizing is spent against. Whether
// this becomes a viewer's own mobile-data budget, a creator self-hosting estimate, or
// nothing at all is a product call, not a copy fix — which is why it is exempted here
// rather than quietly reworded.

import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { useMemo, useState } from "react";
import { CalcNotes, CalcPageHeader, NumberField, SegControl } from "../components/calculators/ui";
import {
	AV1_REF30,
	FPS_MULT,
	fixed,
	fmtTime,
	GIB_PER_MBPS_HR,
	money,
	RES_COLOR,
	RES_HEIGHT,
	RES_TIERS_LOW_TO_HIGH,
	type Resolution,
	RUNG_AUDIO_MBPS,
	rungFps,
	trimNum,
} from "../components/calculators/video-model";

// ---------------------------------------------------------------------------
// Model — a player pulls ONE tier at a time (adaptive bitrate just switches
// between them), so there's no ladder to sum. We size that single stream and
// report how much watch time a bandwidth allowance buys.
// ---------------------------------------------------------------------------

type Codec = "av1" | "vp9" | "h264" | "h265";

/** Delivery video bitrate reference at 30fps (Mbps), video only, good-quality VBR. */
const CODECS: Record<Codec, { label: string; hint: string; ref: Record<Resolution, number> }> = {
	av1: { label: "AV1", hint: "royalty-free · recommended", ref: AV1_REF30 },
	vp9: {
		label: "VP9",
		hint: "royalty-free · fallback",
		ref: { "240p": 0.2, "480p": 0.75, "720p": 1.9, "1080p": 3.6, "1440p": 7.0, "2160p": 12.0 },
	},
	h264: {
		label: "H.264",
		hint: "universal · compatibility floor",
		ref: { "240p": 0.3, "480p": 1.1, "720p": 2.8, "1080p": 4.8, "1440p": 9.5, "2160p": 16.0 },
	},
	h265: {
		label: "H.265",
		hint: "avoid on web · royalties + browser gaps",
		ref: { "240p": 0.2, "480p": 0.75, "720p": 1.9, "1080p": 3.6, "1440p": 7.0, "2160p": 11.5 },
	},
};

const CODEC_NOTE: Record<Codec, string> = {
	av1: "AV1 is the recommended primary: royalty-free and the cheapest per view, so lowest egress. Pair it with a VP9 fallback for devices without AV1 hardware decode and an H.264 floor for the oldest clients.",
	vp9: "VP9 is the royalty-free fallback for clients without AV1 decode — near-universal browser and hardware support today, ~30% more bandwidth than AV1 for the same quality.",
	h264: "H.264 is the universal compatibility floor: it plays everywhere but costs the most bandwidth per view, so serve it only to clients that can't decode AV1 or VP9.",
	h265: "H.265 is shown for comparison only — not recommended for web delivery. Multiple content-royalty pools and patchy in-browser support make AV1/VP9 the better call. Efficiency sits near VP9.",
};

interface TierRow {
	tier: Resolution;
	fps: number;
	total: number;
	gib: number;
}

export default function VideoBandwidthCalculatorPage() {
	const [codec, setCodec] = useState<Codec>("av1");
	const [res, setRes] = useState<Resolution>("1080p");
	const [fps, setFps] = useState(60);
	const [allowance, setAllowance] = useState(4);
	const [price, setPrice] = useState(0.01);

	const { rows, sel, maxGib, maxTier, stretch } = useMemo(() => {
		const ref = CODECS[codec].ref;
		const rows: TierRow[] = RES_TIERS_LOW_TO_HIGH.map((t) => {
			const f = rungFps(t, fps);
			const total = ref[t] * FPS_MULT[f] + RUNG_AUDIO_MBPS;
			const gib = total * GIB_PER_MBPS_HR;
			return { tier: t, fps: f, total, gib };
		});
		const sel = rows.find((r) => r.tier === res) ?? rows[0];
		const maxGib = Math.max(...rows.map((r) => r.gib));
		const maxTier = rows[rows.length - 1];
		const stretch = maxTier.gib / rows[0].gib;
		return { rows, sel, maxGib, maxTier, stretch };
	}, [codec, res, fps]);

	const ceilingPct = maxGib > 0 ? (sel.gib / maxGib) * 100 : 0;
	const capped = RES_HEIGHT[res] < 720 && fps > 30;

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade — see
		// SubscribePage / VideoStorageCalculatorPage for the same fix.
		<div className="max-w-5xl min-w-0 w-full mx-auto px-4 pb-16">
			<Reveal>
				<CalcPageHeader
					eyebrow={`${CODECS[codec].label} delivery · bandwidth allowance`}
					title="Stream time on your allowance"
					lede={
						<>
							Pick the resolution and framerate a viewer streams, and the bandwidth allowance to
							spend. A player only pulls <b className="text-base-content">one</b> tier at a time —
							adaptive bitrate just switches between them — so there's no ladder to sum. The tool
							sizes that single stream and reports{" "}
							<b className="text-base-content">how much watch time the allowance buys</b> before it
							runs out.
						</>
					}
				/>
			</Reveal>

			<Reveal delay={120}>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
					<div className="card bg-base-100 border border-base-300">
						<div className="card-body p-5 gap-5">
							<p className="text-[10px] font-mono uppercase tracking-[0.2em] text-base-content/40">
								Delivery · Inputs
							</p>
							<div>
								<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
									<span>Delivery codec</span>
									<span className="text-xs font-mono text-base-content/40">
										{CODECS[codec].hint}
									</span>
								</span>
								<SegControl
									ariaLabel="Delivery codec"
									value={codec}
									onChange={setCodec}
									options={(Object.keys(CODECS) as Codec[]).map((c) => ({
										value: c,
										label: CODECS[c].label,
									}))}
								/>
							</div>
							<div>
								<span className="block text-sm text-base-content/70 mb-2">
									Delivered resolution
								</span>
								<SegControl
									ariaLabel="Delivered resolution"
									value={res}
									onChange={setRes}
									options={RES_TIERS_LOW_TO_HIGH.map((r) => ({ value: r, label: r }))}
								/>
							</div>
							<div>
								<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
									<span>Delivered framerate</span>
									<span className="text-xs font-mono text-base-content/40">
										sub-720p capped at 30
									</span>
								</span>
								<SegControl
									ariaLabel="Delivered framerate"
									value={fps}
									onChange={setFps}
									options={[
										{ value: 24, label: "24 fps" },
										{ value: 30, label: "30 fps" },
										{ value: 60, label: "60 fps" },
									]}
								/>
							</div>
							<NumberField
								label="Bandwidth allowance"
								value={allowance}
								onChange={setAllowance}
								step={0.5}
								suffix="GiB"
							/>
							<NumberField
								label="Bandwidth price"
								value={price}
								onChange={setPrice}
								step={0.001}
								prefix="$"
								suffix="/ GiB egress"
							/>
						</div>
					</div>

					<div className="card bg-gradient-to-b from-base-200 to-base-300/40 border border-base-300">
						<div className="card-body p-5 justify-between">
							<div>
								<p className="text-[10px] font-mono uppercase tracking-[0.2em] text-base-content/40 mb-2">
									Stream time · {trimNum(allowance)} GiB allowance
								</p>
								<p className="font-mono text-5xl font-bold tabular-nums text-warning leading-none">
									{fmtTime(allowance / sel.gib)}
								</p>
								<p className="mt-3 font-mono text-sm text-base-content/60">
									burns <span className="text-success">{fixed(sel.gib, 2)} GiB/hr</span> at{" "}
									{fixed(sel.total, 2)} Mbps · allowance ≈ {money(allowance * price)}
								</p>
							</div>
							<div className="mt-6">
								<div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-base-content/40 mb-2">
									<span>allowance drain rate</span>
									<span>{Math.round(ceilingPct)}% of ceiling</span>
								</div>
								<div className="relative w-full h-7 rounded-md overflow-hidden border border-base-content/10 bg-base-200">
									<div
										className="absolute inset-y-0 left-0 transition-[width] duration-500"
										style={{
											width: `${ceilingPct}%`,
											background:
												"linear-gradient(90deg, color-mix(in oklch, var(--color-warning) 35%, transparent), var(--color-warning))",
										}}
									/>
								</div>
								<div className="flex justify-between font-mono text-[10px] text-base-content/40 mt-1.5">
									<span>0 GiB/hr</span>
									<span>
										{maxTier.tier}
										{maxTier.fps} · {fixed(maxTier.gib, 2)} GiB/hr
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</Reveal>

			{/* Tier menu */}
			<Reveal>
				<div className="card bg-base-100 border border-base-300 overflow-hidden mb-4">
					<div className="overflow-x-auto">
						<table className="table table-sm w-full font-mono tabular-nums">
							<thead>
								<tr className="text-[10px] uppercase tracking-[0.14em] text-base-content/40">
									<th>Delivered tier</th>
									<th className="text-right hidden sm:table-cell">Stream bitrate</th>
									<th className="text-right hidden sm:table-cell">GiB / hr</th>
									<th className="text-right">Stream time</th>
									<th className="text-right w-32">Drain rate</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => {
									const isSel = r.tier === res;
									const relW = maxGib > 0 ? (r.gib / maxGib) * 100 : 0;
									return (
										<tr
											key={r.tier}
											className={isSel ? "bg-warning/5" : undefined}
											style={
												isSel ? { boxShadow: "inset 2px 0 0 var(--color-warning)" } : undefined
											}
										>
											<td>
												<span className="flex items-center gap-2.5">
													<span
														className="w-2.5 h-2.5 rounded-sm shrink-0"
														style={{ background: RES_COLOR[r.tier] }}
													/>
													<span className={isSel ? "font-semibold" : ""}>{r.tier}</span>
													<span className="text-[11px] text-base-content/40">{r.fps}fps</span>
												</span>
											</td>
											<td className="text-right text-base-content/60 hidden sm:table-cell">
												{fixed(r.total, 2)} Mbps
											</td>
											<td className="text-right text-base-content/60 hidden sm:table-cell">
												{fixed(r.gib, 3)} GiB
											</td>
											<td className={`text-right ${isSel ? "text-warning" : ""}`}>
												{fmtTime(allowance / r.gib)}
											</td>
											<td>
												<div className="h-2 rounded bg-base-200 border border-base-content/10 overflow-hidden">
													<div
														className="h-full rounded-l transition-[width] duration-500"
														style={{ width: `${relW}%`, background: RES_COLOR[r.tier] }}
													/>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>
			</Reveal>

			<Reveal>
				<CalcNotes>
					<p>
						<strong className="text-base-content/70">Model.</strong> {CODECS[codec].label} video at
						delivery bitrates (
						{RES_TIERS_LOW_TO_HIGH.map((t) => `${t} ${trimNum(CODECS[codec].ref[t])}`).join(" · ")}{" "}
						Mbps at 30fps), scaled ×0.92 / ×1.0 / ×1.40 for 24 / 30 / 60 fps, plus 128 kbps audio
						(Opus, or AAC for H.264) in the stream. 720p and above stream at the chosen framerate;{" "}
						{capped ? "240p and 480p are held to 30fps here." : "240p and 480p are held to 30fps."}
					</p>
					<p>
						<strong className="text-base-content/70">Codec.</strong> {CODEC_NOTE[codec]}
					</p>
					<p>
						<strong className="text-base-content/70">Allowance.</strong> A tier burns bitrate ×
						3600s ÷ 8 per hour — one Mbps for an hour is 0.419 GiB — so stream time = allowance ÷
						that rate. At the current framerate the lowest tier stretches the same allowance about{" "}
						{stretch.toFixed(0)}× further than 2160p. On Anthers the Seeds a viewer gives Anthers
						fold in and cover this egress at cost ($0.01/GiB); the companion{" "}
						<em className="text-base-content/60 not-italic font-semibold">storage calculator</em>{" "}
						charges the whole transcode ladder every month instead. DigitalOcean Spaces bills per GB
						(10⁹); multiply by 1.074 for $/GiB. Planning model, not for invoicing.
					</p>
				</CalcNotes>
			</Reveal>
		</div>
	);
}
