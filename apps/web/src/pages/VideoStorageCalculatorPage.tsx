// SPDX-License-Identifier: AGPL-3.0-or-later

import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { useMemo, useState } from "react";
import { CalcNotes, CalcPageHeader, NumberField, SegControl } from "../components/calculators/ui";
import {
	AV1_REF30,
	FPS_MULT,
	fixed,
	GIB_PER_MBPS_HR,
	money,
	moneyBig,
	RES_COLOR,
	RES_HEIGHT,
	RES_LADDER_HIGH_TO_LOW,
	type Resolution,
	RUNG_AUDIO_MBPS,
	rungFps,
} from "../components/calculators/video-model";

// ---------------------------------------------------------------------------
// Model — the original master is stored as-is, then a full AV1 delivery ladder
// down to 240p30 is transcoded and stored alongside it.
// ---------------------------------------------------------------------------

type MasterFormat = "h264" | "h265" | "prores" | "custom";

/** Master export reference: 30fps video bitrate (Mbps) per format + fps scaling. */
const MASTER_EXPORT: Record<
	Exclude<MasterFormat, "custom">,
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
const MASTER_AUDIO_MBPS = 0.256;

const MASTER_COLOR = "#94a3b8";

const MASTER_RESOLUTIONS: Resolution[] = ["720p", "1080p", "1440p", "2160p"];

interface Variant {
	key: string;
	label: string;
	tag: string;
	isMaster: boolean;
	color: string;
	video: number;
	total: number;
	gib: number;
	cost: number;
}

export default function VideoStorageCalculatorPage() {
	const [res, setRes] = useState<Resolution>("1080p");
	const [fps, setFps] = useState(60);
	const [master, setMaster] = useState<MasterFormat>("h264");
	const [masterMbps, setMasterMbps] = useState(20);
	const [price, setPrice] = useState(0.02);
	const [hours, setHours] = useState(100);

	const { variants, masterVar, ladderGib, sumGib, sumVideo, sumTotal, sumCost, maxCost } =
		useMemo(() => {
			// Master, stored untouched.
			let mVideo: number;
			let mLabel: string;
			if (master === "custom") {
				mVideo = masterMbps;
				mLabel = "Custom master";
			} else {
				const m = MASTER_EXPORT[master];
				mVideo = (m.ref[res] ?? 0) * m.fps[fps];
				mLabel = m.label;
			}
			const mTotal = mVideo + MASTER_AUDIO_MBPS;
			const mGib = mTotal * GIB_PER_MBPS_HR;
			const masterVar: Variant = {
				key: "master",
				label: mLabel,
				tag: `${res} · ${fps}fps · as-is`,
				isMaster: true,
				color: MASTER_COLOR,
				video: mVideo,
				total: mTotal,
				gib: mGib,
				cost: mGib * price,
			};

			// AV1 delivery ladder, from the master resolution down to 240p.
			const srcH = RES_HEIGHT[res];
			const rungs: Variant[] = RES_LADDER_HIGH_TO_LOW.filter((r) => RES_HEIGHT[r] <= srcH).map(
				(r) => {
					const f = rungFps(r, fps);
					const video = AV1_REF30[r] * FPS_MULT[f];
					const total = video + RUNG_AUDIO_MBPS;
					const gib = total * GIB_PER_MBPS_HR;
					return {
						key: r,
						label: r,
						tag: `${f}fps · AV1`,
						isMaster: false,
						color: RES_COLOR[r],
						video,
						total,
						gib,
						cost: gib * price,
					};
				},
			);

			const variants = [masterVar, ...rungs];
			const ladderGib = rungs.reduce((a, b) => a + b.gib, 0);
			const sumGib = masterVar.gib + ladderGib;
			const sumVideo = variants.reduce((a, b) => a + b.video, 0);
			const sumTotal = variants.reduce((a, b) => a + b.total, 0);
			const sumCost = variants.reduce((a, b) => a + b.cost, 0);
			const maxCost = Math.max(...variants.map((v) => v.cost));
			return { variants, masterVar, ladderGib, sumGib, sumVideo, sumTotal, sumCost, maxCost };
		}, [res, fps, master, masterMbps, price]);

	const rungCount = variants.length - 1;
	const masterShare = sumGib > 0 ? Math.round((masterVar.gib / sumGib) * 100) : 0;

	return (
		// `min-w-0 w-full` breaks the flex-column min-content cascade — without
		// `w-full`, `mx-auto` on a flex item disables the default
		// `align-self: stretch`, so the wrapper falls back to its content's
		// intrinsic width (up to `max-w-5xl`), which the wide `md:grid-cols-2`
		// cards inside push past the mobile viewport.
		<div className="max-w-5xl min-w-0 w-full mx-auto px-4 pb-16">
			<Reveal>
				<CalcPageHeader
					eyebrow="Original master + AV1 ladder · storage cost"
					title="Video storage cost per source-hour"
					lede={
						<>
							Pick the master resolution and framerate, and how the original was exported. The tool
							stores that <b className="text-base-content">original file as-is</b>, then builds a
							full <b className="text-base-content">AV1</b> transcode ladder down to{" "}
							<b className="text-base-content">240p30</b> and stores that too — reporting monthly
							storage cost per hour of source content.
						</>
					}
				/>
			</Reveal>

			{/* Inputs + readout */}
			<Reveal delay={120}>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
					<div className="card bg-base-100 border border-base-300">
						<div className="card-body p-5 gap-5">
							<p className="text-[10px] font-mono uppercase tracking-[0.2em] text-base-content/40">
								Source · Inputs
							</p>
							<div>
								<span className="block text-sm text-base-content/70 mb-2">Master resolution</span>
								<SegControl
									ariaLabel="Master resolution"
									value={res}
									onChange={setRes}
									options={MASTER_RESOLUTIONS.map((r) => ({ value: r, label: r }))}
								/>
							</div>
							<div>
								<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
									<span>Master framerate</span>
									<span className="text-xs font-mono text-base-content/40">
										sub-720p held to 30
									</span>
								</span>
								<SegControl
									ariaLabel="Master framerate"
									value={fps}
									onChange={setFps}
									options={[
										{ value: 24, label: "24 fps" },
										{ value: 30, label: "30 fps" },
										{ value: 60, label: "60 fps" },
									]}
								/>
							</div>
							<div>
								<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
									<span>Original export</span>
									<span className="text-xs font-mono text-base-content/40">stored as-is</span>
								</span>
								<SegControl
									ariaLabel="Original export format"
									value={master}
									onChange={setMaster}
									options={[
										{ value: "h264", label: "H.264" },
										{ value: "h265", label: "H.265" },
										{ value: "prores", label: "ProRes" },
										{ value: "custom", label: "Custom" },
									]}
								/>
							</div>
							{master === "custom" && (
								<NumberField
									label="Master video bitrate"
									hint="audio added on top"
									value={masterMbps}
									onChange={setMasterMbps}
									step={1}
									suffix="Mbps"
								/>
							)}
							<NumberField
								label="Storage price"
								value={price}
								onChange={setPrice}
								step={0.001}
								prefix="$"
								suffix="/ GiB / month"
							/>
						</div>
					</div>

					<div className="card bg-gradient-to-b from-base-200 to-base-300/40 border border-base-300">
						<div className="card-body p-5 justify-between">
							<div>
								<p className="text-[10px] font-mono uppercase tracking-[0.2em] text-base-content/40 mb-2">
									Master + ladder · per source-hour
								</p>
								<p className="font-mono text-5xl font-bold tabular-nums text-warning leading-none">
									{moneyBig(sumCost)}
									<span className="text-base font-medium text-base-content/50 ml-1.5">/hr/mo</span>
								</p>
								<p className="mt-3 font-mono text-sm text-base-content/60">
									<span className="text-success">{fixed(sumGib, 2)} GiB</span> per source-hour ·
									master {fixed(masterVar.gib, 2)} + ladder {fixed(ladderGib, 2)}
								</p>
							</div>
							<div className="mt-6">
								<div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-base-content/40 mb-2">
									<span>storage share</span>
									<span>
										master + {rungCount} rung{rungCount === 1 ? "" : "s"}
									</span>
								</div>
								<div className="flex w-full h-7 rounded-md overflow-hidden border border-base-content/10 bg-base-200">
									{variants.map((v) => (
										<div
											key={v.key}
											className="h-full transition-[width] duration-500"
											style={{
												width: `${sumGib > 0 ? (v.gib / sumGib) * 100 : 0}%`,
												background: v.color,
											}}
											title={`${v.isMaster ? v.label : v.label} — ${fixed(v.gib, 2)} GiB/hr (${sumGib > 0 ? Math.round((v.gib / sumGib) * 100) : 0}%)`}
										/>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			</Reveal>

			{/* Ladder table */}
			<Reveal>
				<div className="card bg-base-100 border border-base-300 overflow-hidden mb-4">
					<div className="overflow-x-auto">
						<table className="table table-sm w-full font-mono tabular-nums">
							<thead>
								<tr className="text-[10px] uppercase tracking-[0.14em] text-base-content/40">
									<th>Variant</th>
									<th className="text-right">Video</th>
									<th className="text-right hidden sm:table-cell">Total bitrate</th>
									<th className="text-right">Size / hr</th>
									<th className="text-right">Cost / hr / mo</th>
								</tr>
							</thead>
							<tbody>
								{variants.map((v) => (
									<tr
										key={v.key}
										className={v.cost === maxCost ? "bg-warning/5" : undefined}
										style={
											v.cost === maxCost
												? { boxShadow: "inset 2px 0 0 var(--color-warning)" }
												: undefined
										}
									>
										<td>
											<span className="flex items-center gap-2.5">
												<span
													className="w-2.5 h-2.5 rounded-sm shrink-0"
													style={{ background: v.color }}
												/>
												<span className={v.isMaster ? "font-semibold not-italic" : ""}>
													{v.label}
												</span>
												<span className="text-[11px] text-base-content/40">{v.tag}</span>
											</span>
										</td>
										<td className="text-right text-base-content/60">{fixed(v.video, 2)} Mbps</td>
										<td className="text-right text-base-content/60 hidden sm:table-cell">
											{fixed(v.total, 2)} Mbps
										</td>
										<td className="text-right">{fixed(v.gib, 3)} GiB</td>
										<td className="text-right">{money(v.cost)}</td>
									</tr>
								))}
							</tbody>
							<tfoot>
								<tr className="border-t border-base-300 font-semibold">
									<td>Master + AV1 ladder</td>
									<td className="text-right text-base-content/60">{fixed(sumVideo, 2)} Mbps</td>
									<td className="text-right hidden sm:table-cell">{fixed(sumTotal, 2)} Mbps</td>
									<td className="text-right">{fixed(sumGib, 2)} GiB</td>
									<td className="text-right text-warning">{money(sumCost)}</td>
								</tr>
							</tfoot>
						</table>
					</div>
				</div>
			</Reveal>

			{/* Scale out */}
			<Reveal>
				<div className="card bg-base-100 border border-base-300 mb-2">
					<div className="card-body p-5">
						<p className="text-[10px] font-mono uppercase tracking-[0.2em] text-base-content/40 mb-3">
							Scale out · library total
						</p>
						<div className="flex flex-wrap items-center gap-4">
							<div className="w-56">
								<NumberField
									label="Total library"
									value={hours}
									onChange={setHours}
									step={1}
									suffix="source hours"
								/>
							</div>
							<span className="text-base-content/40 font-mono mt-6">→</span>
							<div className="mt-6">
								<span className="font-mono text-2xl font-bold text-warning tabular-nums">
									{money(sumCost * hours)}
								</span>
								<span className="text-xs text-base-content/50 ml-1.5">
									/ month, master + ladder
								</span>
							</div>
						</div>
					</div>
				</div>
			</Reveal>

			<Reveal>
				<CalcNotes>
					<p>
						<strong className="text-base-content/70">Master.</strong> The original upload is stored
						untouched at {fixed(masterVar.total, 2)} Mbps ({fixed(masterVar.gib, 2)} GiB per
						source-hour) — {masterShare}% of the total store here. Defaults assume a quality-leaning
						NLE export; ProRes 422 HQ masters run 10–40× an H.264 export and will swamp everything.
						Switch to <em className="text-base-content/60 not-italic font-semibold">Custom</em> to
						model your own observed upload bitrate.
					</p>
					<p>
						<strong className="text-base-content/70">Ladder.</strong> AV1 video at delivery bitrates
						(240p 0.15 · 480p 0.55 · 720p 1.40 · 1080p 2.80 · 1440p 5.50 · 2160p 9.0 Mbps at 30fps),
						scaled ×0.92 / ×1.0 / ×1.40 for 24 / 30 / 60 fps, plus 128 kbps Opus per rung. Rungs at
						720p and above inherit the master framerate; lower rungs are held to 30fps. The full
						ladder is {fixed(ladderGib, 2)} GiB per source-hour.
					</p>
					<p>
						<strong className="text-base-content/70">Units.</strong> Size = bitrate × 3600s ÷ 8, in
						GiB (2³⁰ bytes) to match a per-GiB price. One Mbps for an hour = 0.419 GiB. Storage only
						— egress (see the companion bandwidth tool), requests, and any replication factor land
						on top. DigitalOcean Spaces prices per GB (10⁹); multiply by 1.074 for $/GiB. Planning
						model, not for invoicing.
					</p>
				</CalcNotes>
			</Reveal>
		</div>
	);
}
