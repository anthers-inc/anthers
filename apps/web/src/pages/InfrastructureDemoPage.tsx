// SPDX-License-Identifier: AGPL-3.0-or-later
import { PUBLIC_ACCESS_PRICE, timePoolFor } from "@anthers/shared/constants";
import { BADGE_TABLE } from "@anthers/shared/figures";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { FONTS } from "@anthers/web-shared/fonts";
import { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	LabelList,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

const serif = { fontFamily: FONTS.fraunces };

// ---------------------------------------------------------------------------
// Constants — from Anthers Infrastructure Cheat Sheet
// ---------------------------------------------------------------------------

// At-cost infrastructure rates (DigitalOcean retail). These are real pass-through
// costs, not a funding lever — Anthers adds no markup on any of them.
const BASE_COSTS = {
	storageCostPerGb: 0.02,
	deliveryCostPerGb: 0.01,
	computeCostPerGb: 0.005,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MediaType = "video" | "audio" | "text" | "game";
type Tab = "calculator" | "comparison" | "profiles" | "optimizations";

interface VideoQuality {
	label: string;
	bitrateMbps: number;
	mbPerMin: number;
	deliveryCostPerMin: number;
}

interface AudioFormat {
	label: string;
	bitrateKbps: number;
	mbPerMin: number;
	deliveryCostPerMin: number;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const VIDEO_QUALITIES: VideoQuality[] = [
	{ label: "360p", bitrateMbps: 1, mbPerMin: 7.5, deliveryCostPerMin: 0.000075 },
	{ label: "720p", bitrateMbps: 5, mbPerMin: 37.5, deliveryCostPerMin: 0.000375 },
	{ label: "1080p", bitrateMbps: 8, mbPerMin: 60, deliveryCostPerMin: 0.0006 },
	{ label: "1080p/60", bitrateMbps: 12, mbPerMin: 90, deliveryCostPerMin: 0.0009 },
	{ label: "4K/30", bitrateMbps: 35, mbPerMin: 260, deliveryCostPerMin: 0.0026 },
	{ label: "4K/60", bitrateMbps: 50, mbPerMin: 375, deliveryCostPerMin: 0.00375 },
];

const AUDIO_FORMATS: AudioFormat[] = [
	{ label: "AAC 128", bitrateKbps: 128, mbPerMin: 0.96, deliveryCostPerMin: 0.0000096 },
	{ label: "AAC 256", bitrateKbps: 256, mbPerMin: 1.9, deliveryCostPerMin: 0.000019 },
	{ label: "FLAC (CD)", bitrateKbps: 1000, mbPerMin: 7.5, deliveryCostPerMin: 0.000075 },
	{ label: "FLAC (Hi-Res)", bitrateKbps: 2500, mbPerMin: 18.8, deliveryCostPerMin: 0.000188 },
];

const CROSS_MEDIA_DATA = [
	{ media: "Video 1080p", costPerMin: 0.0006, ratio: "1x", color: "#ef4444" },
	{ media: "Video 4K", costPerMin: 0.003, ratio: "5x", color: "#dc2626" },
	{ media: "Audio (HQ)", costPerMin: 0.00002, ratio: "0.03x", color: "#f59e0b" },
	{ media: "Text", costPerMin: 0.000001, ratio: "0.002x", color: "#6b7280" },
	{ media: "Game (web)", costPerMin: 0.00001, ratio: "0.02x", color: "#6366f1" },
	{ media: "Game (DL)", costPerMin: 0, ratio: "0x", color: "#8b5cf6" },
];

interface ReferenceCreator {
	name: string;
	subs: string;
	videos: string;
	storageLabel: string;
	storageCost: number;
	deliveryCost: number;
	totalInfra: number;
	viewMinutes: string;
	infraPerViewMin: number;
	infraPctGross: string;
	ytGross: number;
	ytNet: number;
	anthersNet: number;
}

const REFERENCE_CREATORS: ReferenceCreator[] = [
	{
		name: "Amaiguri",
		subs: "3.85K",
		videos: "270",
		storageLabel: "2.6 TB",
		storageCost: 52.65,
		deliveryCost: 12.8,
		totalInfra: 65,
		viewMinutes: "155K",
		infraPerViewMin: 0.000419,
		infraPctGross: "Subsidized",
		ytGross: 11,
		ytNet: 6,
		anthersNet: 11,
	},
	{
		name: "LittleDuck",
		subs: "17.2K",
		videos: "1.1K",
		storageLabel: "9.4 TB",
		storageCost: 188.76,
		deliveryCost: 10.92,
		totalInfra: 200,
		viewMinutes: "440K",
		infraPerViewMin: 0.000455,
		infraPctGross: "Subsidized",
		ytGross: 30,
		ytNet: 16,
		anthersNet: 30,
	},
	{
		name: "Race Day Cafe",
		subs: "35.1K",
		videos: "58",
		storageLabel: "396 GB",
		storageCost: 7.92,
		deliveryCost: 66.56,
		totalInfra: 75,
		viewMinutes: "4.7M",
		infraPerViewMin: 0.000016,
		infraPctGross: "11.1%",
		ytGross: 678,
		ytNet: 373,
		anthersNet: 603,
	},
	{
		name: "Life Of Riza",
		subs: "991K",
		videos: "77",
		storageLabel: "225 GB",
		storageCost: 4.5,
		deliveryCost: 67.62,
		totalInfra: 72,
		viewMinutes: "5.3M",
		infraPerViewMin: 0.000014,
		infraPctGross: "4.6%",
		ytGross: 1575,
		ytNet: 866,
		anthersNet: 1503,
	},
	{
		name: "bugfishhhh",
		subs: "147K",
		videos: "22",
		storageLabel: "558 GB",
		storageCost: 11.16,
		deliveryCost: 1396.56,
		totalInfra: 1408,
		viewMinutes: "62M",
		infraPerViewMin: 0.000023,
		infraPctGross: "49.2%",
		ytGross: 2859,
		ytNet: 1572,
		anthersNet: 1451,
	},
	{
		name: "MAPHRA",
		subs: "166K",
		videos: "6",
		storageLabel: "8.2 GB",
		storageCost: 0.16,
		deliveryCost: 399.95,
		totalInfra: 400,
		viewMinutes: "16.5M",
		infraPerViewMin: 0.000024,
		infraPctGross: "6.8%",
		ytGross: 5875,
		ytNet: 3231,
		anthersNet: 5475,
	},
	{
		name: "Memoria",
		subs: "281K",
		videos: "288",
		storageLabel: "5.1 TB",
		storageCost: 101.09,
		deliveryCost: 1168.9,
		totalInfra: 1270,
		viewMinutes: "49M",
		infraPerViewMin: 0.000026,
		infraPctGross: "36.3%",
		ytGross: 3500,
		ytNet: 1925,
		anthersNet: 2230,
	},
	{
		name: "gabi belle",
		subs: "1.42M",
		videos: "179",
		storageLabel: "2.1 TB",
		storageCost: 41.88,
		deliveryCost: 1187.12,
		totalInfra: 1229,
		viewMinutes: "51M",
		infraPerViewMin: 0.000024,
		infraPctGross: "28.9%",
		ytGross: 4250,
		ytNet: 2338,
		anthersNet: 3021,
	},
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtCost(n: number, minDecimals = 2): string {
	if (n === 0) return "$0";
	if (n < 0.0001) return `$${n.toExponential(1)}`;
	if (n < 0.01) return `$${n.toFixed(6)}`;
	if (n < 1) return `$${n.toFixed(4)}`;
	if (n < 100) return `$${n.toFixed(minDecimals)}`;
	return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtSize(gb: number): string {
	if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${(gb * 1024).toFixed(0)} MB`;
}

function fmtNum(n: number): string {
	return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Section: Unit Cost Calculator
// ---------------------------------------------------------------------------

function UnitCostCalculator() {
	const [mediaType, setMediaType] = useState<MediaType>("video");
	const [videoQualityIdx, setVideoQualityIdx] = useState(2); // 1080p default
	const [audioFormatIdx, setAudioFormatIdx] = useState(1); // AAC 256 default
	const [contentMinutes, setContentMinutes] = useState(30);
	const [monthlyPlays, setMonthlyPlays] = useState(10000);
	const [gameSizeMb, setGameSizeMb] = useState(500);
	const [textSizeKb, setTextSizeKb] = useState(500);

	const costs = useMemo(() => {
		if (mediaType === "video") {
			const q = VIDEO_QUALITIES[videoQualityIdx];
			const storageGb = (contentMinutes * q.mbPerMin * 1.8) / 1024;
			const storageCostMo = storageGb * BASE_COSTS.storageCostPerGb;
			const deliveryPerPlay = ((contentMinutes * q.mbPerMin) / 1024) * BASE_COSTS.deliveryCostPerGb;
			const deliveryTotal = deliveryPerPlay * monthlyPlays;
			return {
				storageGb,
				storageCostMo,
				deliveryPerPlay,
				deliveryTotal,
				mediaLabel: `${q.label} video`,
			};
		}
		if (mediaType === "audio") {
			const f = AUDIO_FORMATS[audioFormatIdx];
			const storageGb = (contentMinutes * f.mbPerMin * 2) / 1024;
			const storageCostMo = storageGb * BASE_COSTS.storageCostPerGb;
			const deliveryPerPlay = ((contentMinutes * f.mbPerMin) / 1024) * BASE_COSTS.deliveryCostPerGb;
			const deliveryTotal = deliveryPerPlay * monthlyPlays;
			return {
				storageGb,
				storageCostMo,
				deliveryPerPlay,
				deliveryTotal,
				mediaLabel: `${f.label} audio`,
			};
		}
		if (mediaType === "text") {
			const storageGb = textSizeKb / (1024 * 1024);
			const storageCostMo = storageGb * BASE_COSTS.storageCostPerGb;
			const deliveryPerPlay = (textSizeKb / (1024 * 1024)) * BASE_COSTS.deliveryCostPerGb;
			const deliveryTotal = deliveryPerPlay * monthlyPlays;
			return { storageGb, storageCostMo, deliveryPerPlay, deliveryTotal, mediaLabel: "text post" };
		}
		// game
		const storageGb = (gameSizeMb * 3) / 1024; // 3 platform variants
		const storageCostMo = storageGb * BASE_COSTS.storageCostPerGb;
		const deliveryPerPlay = (gameSizeMb / 1024) * BASE_COSTS.deliveryCostPerGb;
		const deliveryTotal = deliveryPerPlay * monthlyPlays;
		return {
			storageGb,
			storageCostMo,
			deliveryPerPlay,
			deliveryTotal,
			mediaLabel: "game download",
		};
	}, [
		mediaType,
		videoQualityIdx,
		audioFormatIdx,
		contentMinutes,
		monthlyPlays,
		gameSizeMb,
		textSizeKb,
	]);

	const totalMonthlyCost = costs.storageCostMo + costs.deliveryTotal;

	return (
		<div className="space-y-6">
			{/* Media type selector */}
			<div className="flex flex-wrap gap-2">
				{(["video", "audio", "text", "game"] as MediaType[]).map((t) => (
					<button
						type="button"
						key={t}
						onClick={() => setMediaType(t)}
						className={`btn btn-sm ${mediaType === t ? "btn-primary" : "btn-ghost"}`}
					>
						{t === "video" ? "Video" : t === "audio" ? "Audio" : t === "text" ? "Text" : "Games"}
					</button>
				))}
			</div>

			{/* Inputs */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
				{mediaType === "video" && (
					<>
						<div>
							<label className="label text-sm">Resolution / Quality</label>
							<select
								className="select select-bordered select-sm w-full"
								value={videoQualityIdx}
								onChange={(e) => setVideoQualityIdx(Number(e.target.value))}
							>
								{VIDEO_QUALITIES.map((q, i) => (
									<option key={q.label} value={i}>
										{q.label} (~{q.bitrateMbps} Mbps)
									</option>
								))}
							</select>
						</div>
						<div>
							<label className="label text-sm">Content duration (minutes)</label>
							<input
								type="range"
								min={1}
								max={240}
								value={contentMinutes}
								onChange={(e) => setContentMinutes(Number(e.target.value))}
								className="range range-sm range-primary"
							/>
							<div className="text-sm text-base-content/60 mt-1 tabular-nums">
								{contentMinutes} min
							</div>
						</div>
					</>
				)}
				{mediaType === "audio" && (
					<>
						<div>
							<label className="label text-sm">Audio format</label>
							<select
								className="select select-bordered select-sm w-full"
								value={audioFormatIdx}
								onChange={(e) => setAudioFormatIdx(Number(e.target.value))}
							>
								{AUDIO_FORMATS.map((f, i) => (
									<option key={f.label} value={i}>
										{f.label} ({f.bitrateKbps} kbps)
									</option>
								))}
							</select>
						</div>
						<div>
							<label className="label text-sm">Content duration (minutes)</label>
							<input
								type="range"
								min={1}
								max={120}
								value={contentMinutes}
								onChange={(e) => setContentMinutes(Number(e.target.value))}
								className="range range-sm range-primary"
							/>
							<div className="text-sm text-base-content/60 mt-1 tabular-nums">
								{contentMinutes} min
							</div>
						</div>
					</>
				)}
				{mediaType === "text" && (
					<div>
						<label className="label text-sm">Post size (KB, including images)</label>
						<input
							type="range"
							min={5}
							max={10000}
							step={5}
							value={textSizeKb}
							onChange={(e) => setTextSizeKb(Number(e.target.value))}
							className="range range-sm range-primary"
						/>
						<div className="text-sm text-base-content/60 mt-1 tabular-nums">
							{textSizeKb >= 1024 ? `${(textSizeKb / 1024).toFixed(1)} MB` : `${textSizeKb} KB`}
						</div>
					</div>
				)}
				{mediaType === "game" && (
					<div>
						<label className="label text-sm">Build size per platform (MB)</label>
						<input
							type="range"
							min={10}
							max={20000}
							step={10}
							value={gameSizeMb}
							onChange={(e) => setGameSizeMb(Number(e.target.value))}
							className="range range-sm range-primary"
						/>
						<div className="text-sm text-base-content/60 mt-1 tabular-nums">
							{gameSizeMb >= 1024 ? `${(gameSizeMb / 1024).toFixed(1)} GB` : `${gameSizeMb} MB`} (
							{fmtSize((gameSizeMb * 3) / 1024)} across 3 platforms)
						</div>
					</div>
				)}
				<div>
					<label className="label text-sm">
						Monthly{" "}
						{mediaType === "video"
							? "views"
							: mediaType === "audio"
								? "listens"
								: mediaType === "text"
									? "reads"
									: "downloads"}
					</label>
					<input
						type="range"
						min={100}
						max={1000000}
						step={100}
						value={monthlyPlays}
						onChange={(e) => setMonthlyPlays(Number(e.target.value))}
						className="range range-sm range-primary"
					/>
					<div className="text-sm text-base-content/60 mt-1 tabular-nums">
						{fmtNum(monthlyPlays)}
					</div>
				</div>
			</div>

			{/* Results */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<ResultCard
					label="Storage"
					value={fmtSize(costs.storageGb)}
					sub={`${fmtCost(costs.storageCostMo)}/mo`}
				/>
				<ResultCard
					label={`Per ${mediaType === "video" ? "view" : mediaType === "audio" ? "listen" : mediaType === "text" ? "read" : "download"}`}
					value={fmtCost(costs.deliveryPerPlay)}
					sub="delivery cost"
				/>
				<ResultCard
					label="Monthly delivery"
					value={fmtCost(costs.deliveryTotal)}
					sub={`${fmtNum(monthlyPlays)} plays`}
				/>
				<ResultCard
					label="Total monthly"
					value={fmtCost(totalMonthlyCost)}
					sub="storage + delivery"
					accent="text-warning"
				/>
			</div>

			{/* Context: infra vs pool rate */}
			{mediaType === "video" && (
				<div className="card bg-base-200/50 border border-base-300">
					<div className="card-body p-4">
						<p className="text-sm text-base-content/60">
							At {VIDEO_QUALITIES[videoQualityIdx].label}, delivery costs{" "}
							<span className="font-semibold text-base-content">
								{fmtCost(VIDEO_QUALITIES[videoQualityIdx].deliveryCostPerMin)}/min
							</span>{" "}
							— and{" "}
							<span className="font-semibold text-base-content">nobody is charged for it</span>.
							Egress is $0 at any volume on Cloudflare R2, so there is no allowance, no wallet and
							no per-GiB line on anyone's bill. Creator earnings were always{" "}
							<span className="font-semibold text-success">decoupled</span> from delivery: they come
							from the Time Pool their support for Anthers funds ($
							{timePoolFor(PUBLIC_ACCESS_PRICE).toFixed(2)} of every ${PUBLIC_ACCESS_PRICE}),
							distributed by time (equal-time), plus what fans direct to them — both of which reach
							creators in full.
						</p>
					</div>
				</div>
			)}
		</div>
	);
}

function ResultCard({
	label,
	value,
	sub,
	accent,
}: {
	label: string;
	value: string;
	sub?: string;
	accent?: string;
}) {
	return (
		<div className="card bg-base-200">
			<div className="card-body p-4">
				<p className="text-xs text-base-content/50 uppercase tracking-wide">{label}</p>
				<p className={`text-xl font-bold tabular-nums ${accent ?? ""}`}>{value}</p>
				{sub && <p className="text-xs text-base-content/40">{sub}</p>}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section: Cross-Media Comparison
// ---------------------------------------------------------------------------

function CrossMediaComparison() {
	const [logScale, setLogScale] = useState(true);

	// Filter to items with cost > 0, sort largest to smallest
	const sortedData = CROSS_MEDIA_DATA.filter((d) => d.costPerMin > 0).sort(
		(a, b) => b.costPerMin - a.costPerMin,
	);

	// For log scale: normalize so the smallest value = 1 and everything else is
	// a positive multiple. This way taller bars = more expensive (intuitive).
	const minCost = Math.min(...sortedData.map((d) => d.costPerMin));

	const chartData = sortedData.map((d) => ({
		name: d.media,
		cost: d.costPerMin,
		// Log-relative: how many orders of magnitude more expensive than the cheapest
		logRelative: Math.log10(d.costPerMin / minCost),
		actualCost: d.costPerMin,
		color: d.color,
		label: fmtCost(d.costPerMin),
	}));

	// Cost per time-minute table (all media)
	const creatorProfiles = [
		{ type: "Game dev (5 games, 5K DL/mo)", volume: "5 GB stored, 2.5 TB delivered", cost: "$25" },
		{ type: "Game dev (1 jam, 500 DL/mo)", volume: "200 MB stored, 100 GB delivered", cost: "$1" },
		{
			type: "Musician (10 albums, 10K streams)",
			volume: "7 GB stored, 18 GB delivered",
			// econ:allow — an illustrative infrastructure cost, not a published figure.
			// It equals SAMPLE_RECEIPT.paymentsAnthers by coincidence.
			cost: "$0.32",
		},
		{
			type: "Writer (weekly essays, 10K reads)",
			volume: "400 MB stored, 5 GB delivered",
			cost: "$0.06",
		},
		{ type: "Video (4 vids/mo, 100K views)", volume: "40 GB stored, 6 TB delivered", cost: "$61" },
		{ type: "Video (4 vids/mo, 1M views)", volume: "40 GB stored, 60 TB delivered", cost: "$601" },
	];

	return (
		<div className="space-y-6">
			<p className="text-sm text-base-content/60 leading-relaxed">
				The metric that matters most for the Time Pool model is{" "}
				<span className="font-semibold text-base-content">cost per minute of audience time</span>,
				since Time Pool revenue is distributed proportionally to time (the equal-time principle).
				Video is by far the most expensive medium to deliver — audio, text, and games are 30-500x
				cheaper per time-minute.
			</p>

			{/* Chart */}
			<div className="card bg-base-200/50 border border-base-300">
				<div className="card-body p-4">
					<div className="flex justify-between items-center mb-2">
						<h4 className="text-sm font-semibold">Delivery Cost per Time-Minute</h4>
						<label className="label cursor-pointer gap-2">
							<span className="text-xs text-base-content/50">Log scale</span>
							<input
								type="checkbox"
								checked={logScale}
								onChange={() => setLogScale(!logScale)}
								className="toggle toggle-xs toggle-primary"
							/>
						</label>
					</div>
					<ResponsiveContainer width="100%" height={280}>
						<BarChart data={chartData} margin={{ top: 24, right: 8, bottom: 8, left: 8 }}>
							<XAxis dataKey="name" tick={{ fontSize: 11 }} />
							{logScale ? (
								<YAxis
									tick={{ fontSize: 10 }}
									tickFormatter={(v: number) => (v === 0 ? "1x" : `${Math.round(10 ** v)}x`)}
									domain={[0, "auto"]}
								/>
							) : (
								<YAxis
									tick={{ fontSize: 10 }}
									tickFormatter={(v: number) => fmtCost(v)}
									domain={[0, "auto"]}
								/>
							)}
							<Tooltip
								formatter={(_value, _name, item) => {
									const actual = (item.payload as (typeof chartData)[number]).actualCost;
									return [fmtCost(actual), "Cost/min"];
								}}
								contentStyle={{ fontSize: 12, borderRadius: 8 }}
							/>
							<Bar dataKey={logScale ? "logRelative" : "cost"} radius={[4, 4, 0, 0]}>
								{chartData.map((d, i) => (
									<Cell key={i} fill={d.color} />
								))}
								<LabelList dataKey="label" position="top" style={{ fontSize: 10, fill: "#888" }} />
							</Bar>
						</BarChart>
					</ResponsiveContainer>
					{logScale && (
						<p className="text-xs text-base-content/40 mt-1">
							Log scale — taller bars = more expensive. Y-axis shows relative cost vs. the cheapest
							media type. Actual dollar values shown above each bar.
						</p>
					)}
				</div>
			</div>

			{/* Table: cost per time-minute */}
			<div className="overflow-x-auto">
				<table className="table table-sm w-full">
					<thead>
						<tr>
							<th>Media Type</th>
							<th className="text-right">Cost per Time-Min</th>
							<th className="text-right">Ratio to Video</th>
						</tr>
					</thead>
					<tbody>
						{CROSS_MEDIA_DATA.map((d) => (
							<tr key={d.media}>
								<td className="text-sm">{d.media}</td>
								<td className="text-sm text-right tabular-nums">{fmtCost(d.costPerMin)}</td>
								<td className="text-sm text-right tabular-nums text-base-content/60">{d.ratio}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Creator profile cost table */}
			<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider">
				Monthly Infrastructure by Creator Type
			</h4>
			<div className="overflow-x-auto">
				<table className="table table-sm w-full">
					<thead>
						<tr>
							<th>Creator Type</th>
							<th className="text-right">Content Volume</th>
							<th className="text-right">Monthly Cost</th>
						</tr>
					</thead>
					<tbody>
						{creatorProfiles.map((p) => (
							<tr key={p.type}>
								<td className="text-sm">{p.type}</td>
								<td className="text-sm text-right text-base-content/60">{p.volume}</td>
								<td className="text-sm text-right font-medium tabular-nums">{p.cost}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section: Reference Creator Profiles (YouTube comparison)
// ---------------------------------------------------------------------------

function ReferenceCreatorProfiles() {
	const [sortKey, setSortKey] = useState<"name" | "totalInfra" | "anthersNet">("totalInfra");

	const sorted = useMemo(() => {
		return [...REFERENCE_CREATORS].sort((a, b) => {
			if (sortKey === "name") return a.name.localeCompare(b.name);
			return a[sortKey] - b[sortKey];
		});
	}, [sortKey]);

	const chartData = REFERENCE_CREATORS.map((c) => ({
		name: c.name,
		ytNet: c.ytNet,
		anthersNet: c.anthersNet,
		infra: c.totalInfra,
	})).sort((a, b) => a.ytNet - b.ytNet);

	return (
		<div className="space-y-6">
			<p className="text-sm text-base-content/60 leading-relaxed">
				These are real YouTube creators mapped onto Anthers' model. YouTube takes 45% as a platform
				fee. Anthers takes no such fee — only real infrastructure costs (shown below) are deducted,
				at cost with no markup. <span className="font-semibold text-base-content">Free access</span>
				, funded by the remainder of what is given to Anthers, is covered across the platform.
			</p>

			{/* Net income comparison chart */}
			<div className="card bg-base-200/50 border border-base-300">
				<div className="card-body p-4">
					<h4 className="text-sm font-semibold mb-2">Net Creator Income: YouTube vs Anthers</h4>
					<ResponsiveContainer width="100%" height={320}>
						<BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 32, left: 8 }}>
							<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
							<XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" />
							<YAxis
								tick={{ fontSize: 10 }}
								tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}K`}
							/>
							<Tooltip
								formatter={(value) => [`$${Number(value).toLocaleString()}`, ""]}
								contentStyle={{ fontSize: 12, borderRadius: 8 }}
							/>
							<Legend wrapperStyle={{ fontSize: 12 }} />
							<Bar dataKey="ytNet" name="YouTube net" fill="#6b7280" radius={[2, 2, 0, 0]} />
							<Bar dataKey="anthersNet" name="Anthers net" fill="#22c55e" radius={[2, 2, 0, 0]} />
						</BarChart>
					</ResponsiveContainer>
				</div>
			</div>

			{/* Sort controls */}
			<div className="flex gap-2 items-center">
				<span className="text-xs text-base-content/50">Sort by:</span>
				{(
					[
						["name", "Name"],
						["totalInfra", "Infra cost"],
						["anthersNet", "Anthers net"],
					] as const
				).map(([key, label]) => (
					<button
						type="button"
						key={key}
						onClick={() => setSortKey(key)}
						className={`btn btn-xs ${sortKey === key ? "btn-primary" : "btn-ghost"}`}
					>
						{label}
					</button>
				))}
			</div>

			{/* Full reference table */}
			<div className="overflow-x-auto">
				<table className="table table-xs w-full">
					<thead>
						<tr>
							<th>Creator</th>
							<th className="text-right">Subs</th>
							<th className="text-right">Storage</th>
							<th className="text-right">Infra/mo</th>
							<th className="text-right">Infra % Gross</th>
							<th className="text-right">YT Net</th>
							<th className="text-right">Anthers Net</th>
							<th className="text-right">Advantage</th>
						</tr>
					</thead>
					<tbody>
						{sorted.map((c) => {
							const advantage = c.anthersNet - c.ytNet;
							return (
								<tr key={c.name}>
									<td className="text-sm font-medium">{c.name}</td>
									<td className="text-sm text-right tabular-nums text-base-content/60">{c.subs}</td>
									<td className="text-sm text-right tabular-nums text-base-content/60">
										{c.storageLabel}
									</td>
									<td className="text-sm text-right tabular-nums">
										${c.totalInfra.toLocaleString()}
									</td>
									<td
										className={`text-sm text-right tabular-nums ${c.infraPctGross === "Subsidized" ? "text-info" : ""}`}
									>
										{c.infraPctGross}
									</td>
									<td className="text-sm text-right tabular-nums">${c.ytNet.toLocaleString()}</td>
									<td className="text-sm text-right tabular-nums font-semibold">
										${c.anthersNet.toLocaleString()}
									</td>
									<td
										className={`text-sm text-right tabular-nums font-semibold ${advantage >= 0 ? "text-success" : "text-error"}`}
									>
										{advantage >= 0 ? "+" : ""}
										{advantage.toLocaleString()}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{/* Assumptions */}
			<details className="collapse collapse-arrow bg-base-200/50">
				<summary className="collapse-title text-sm font-medium">Assumptions</summary>
				<div className="collapse-content text-xs text-base-content/60 space-y-1">
					<p>
						YouTube CPM estimated by content type (range: $2.50-$7). Applied to ~50% monetized
						playback rate.
					</p>
					<p>YouTube takes 45% of ad revenue.</p>
					<p>
						Anthers Sprout Badge: ${SPROUT.monthly}/month to Anthers → ${SPROUT.timePool} Time Pool
						to creators and ${SPROUT.payments} of at-cost card processing, leaving $
						{SPROUT.remainder} to fund free access and the charitable programs. Support given
						straight to a creator carries no platform cut. Time Pool is distributed by time.
						Delivery is free and appears nowhere in the split.
					</p>
					<p>Storage: ~120 MB/min multi-quality adaptive bitrate. Delivery: ~4 MB/min blended.</p>
					<p>
						Infrastructure at Cloudflare R2 retail rates. Egress is $0 at any volume; the residual
						delivery cost is per-request operations, which HLS incurs and whole-file downloads
						barely do.
					</p>
					<p>
						Free access — unlimited streaming and downloads for every account, and 50 GiB free
						storage per creator — is funded by the remainder of what is given to Anthers, from a
						shared subsidy pool.
					</p>
					<p>Anthers gross assumed equal to YouTube gross for apples-to-apples comparison.</p>
				</div>
			</details>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section: Optimization Impact Visualizer
// ---------------------------------------------------------------------------

interface OptimizationToggle {
	id: string;
	label: string;
	description: string;
	deliveryReductionPct: number;
	storageReductionPct: number;
	enabled: boolean;
}

function OptimizationVisualizer() {
	const [baseDelivery, setBaseDelivery] = useState(1060);
	const [baseStorage, setBaseStorage] = useState(2.66);
	const [baseCompute, setBaseCompute] = useState(42);

	const [optimizations, setOptimizations] = useState<OptimizationToggle[]>([
		{
			id: "webrtc",
			label: "WebRTC Peer-Assisted Delivery",
			description: "30-60% delivery reduction for content with concurrent viewers",
			deliveryReductionPct: 40,
			storageReductionPct: 0,
			enabled: false,
		},
		{
			id: "abr",
			label: "Adaptive Bitrate Intelligence",
			description: "15-25% delivery reduction by serving lowest viable quality",
			deliveryReductionPct: 20,
			storageReductionPct: 0,
			enabled: false,
		},
		{
			id: "av1",
			label: "AV1 Codec",
			description: "25-35% compression improvement over H.264",
			deliveryReductionPct: 30,
			storageReductionPct: 30,
			enabled: false,
		},
		{
			id: "cdn",
			label: "CDN Pre-warming & Cache Optimization",
			description: "10-20% delivery reduction via aggressive caching",
			deliveryReductionPct: 15,
			storageReductionPct: 0,
			enabled: false,
		},
		{
			id: "audio",
			label: "Audio-Only Mode",
			description: "5-15% delivery reduction for talk-heavy content",
			deliveryReductionPct: 10,
			storageReductionPct: 0,
			enabled: false,
		},
	]);

	const toggle = (id: string) => {
		setOptimizations((prev) => prev.map((o) => (o.id === id ? { ...o, enabled: !o.enabled } : o)));
	};

	// Calculate cascading reductions (each applies to the remainder)
	const result = useMemo(() => {
		let delivery = baseDelivery;
		let storage = baseStorage;

		const steps: { label: string; delivery: number; savings: number }[] = [
			{ label: "Baseline", delivery: baseDelivery, savings: 0 },
		];

		for (const opt of optimizations) {
			if (!opt.enabled) continue;
			const deliveryReduction = delivery * (opt.deliveryReductionPct / 100);
			delivery -= deliveryReduction;
			storage *= 1 - opt.storageReductionPct / 100;
			steps.push({
				label: opt.label.split(" ")[0], // short label
				delivery: Math.round(delivery),
				savings: Math.round(deliveryReduction),
			});
		}

		return {
			delivery,
			storage,
			compute: baseCompute,
			total: delivery + storage + baseCompute,
			steps,
		};
	}, [optimizations, baseDelivery, baseStorage, baseCompute]);

	const totalSavings = baseDelivery + baseStorage + baseCompute - result.total;
	const savingsPct = (totalSavings / (baseDelivery + baseStorage + baseCompute)) * 100;

	// Chart data for the waterfall
	const chartData = result.steps.map((s) => ({
		name: s.label,
		delivery: s.delivery,
	}));

	return (
		<div className="space-y-6">
			<p className="text-sm text-base-content/60 leading-relaxed">
				Toggle optimization techniques to see their cascading impact on infrastructure costs. Each
				optimization applies to the remaining delivery cost after previous optimizations. Default
				baseline uses <span className="font-semibold text-base-content">bugfishhhh</span> — the
				hardest case in our model (high-bandwidth long-form video essays).
			</p>

			{/* Baseline inputs */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div>
					<label className="label text-sm">Baseline delivery ($/mo)</label>
					<input
						type="number"
						className="input input-bordered input-sm w-full tabular-nums"
						value={baseDelivery}
						onChange={(e) => setBaseDelivery(Number(e.target.value) || 0)}
					/>
				</div>
				<div>
					<label className="label text-sm">Storage ($/mo)</label>
					<input
						type="number"
						className="input input-bordered input-sm w-full tabular-nums"
						step={0.01}
						value={baseStorage}
						onChange={(e) => setBaseStorage(Number(e.target.value) || 0)}
					/>
				</div>
				<div>
					<label className="label text-sm">Compute ($/mo)</label>
					<input
						type="number"
						className="input input-bordered input-sm w-full tabular-nums"
						value={baseCompute}
						onChange={(e) => setBaseCompute(Number(e.target.value) || 0)}
					/>
				</div>
			</div>

			{/* Optimization toggles */}
			<div className="space-y-2">
				{optimizations.map((opt) => (
					<div
						key={opt.id}
						onClick={() => toggle(opt.id)}
						className={`card cursor-pointer transition-all ${opt.enabled ? "bg-primary/10 border-primary/30 border" : "bg-base-200/50 border border-base-300"}`}
					>
						<div className="card-body p-3 flex-row items-center gap-3">
							<input
								type="checkbox"
								checked={opt.enabled}
								onChange={() => toggle(opt.id)}
								className="checkbox checkbox-sm checkbox-primary"
							/>
							<div className="flex-1 min-w-0">
								<p className={`text-sm font-medium ${opt.enabled ? "text-primary" : ""}`}>
									{opt.label}
								</p>
								<p className="text-xs text-base-content/50">{opt.description}</p>
							</div>
							<div className="text-right flex-shrink-0">
								<span className="badge badge-sm badge-ghost tabular-nums">
									{opt.deliveryReductionPct > 0 ? `-${opt.deliveryReductionPct}% delivery` : ""}
									{opt.storageReductionPct > 0 ? ` -${opt.storageReductionPct}% storage` : ""}
								</span>
							</div>
						</div>
					</div>
				))}
			</div>

			{/* Waterfall chart */}
			{result.steps.length > 1 && (
				<div className="card bg-base-200/50 border border-base-300">
					<div className="card-body p-4">
						<h4 className="text-sm font-semibold mb-2">Delivery Cost Waterfall</h4>
						<ResponsiveContainer width="100%" height={220}>
							<AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
								<CartesianGrid strokeDasharray="3 3" opacity={0.15} />
								<XAxis dataKey="name" tick={{ fontSize: 10 }} />
								<YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
								<Tooltip
									formatter={(v) => [`$${v}`, "Delivery"]}
									contentStyle={{ fontSize: 12, borderRadius: 8 }}
								/>
								<Area
									type="stepAfter"
									dataKey="delivery"
									stroke="#6366f1"
									fill="#6366f1"
									fillOpacity={0.2}
								/>
							</AreaChart>
						</ResponsiveContainer>
					</div>
				</div>
			)}

			{/* Result summary */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<ResultCard
					label="Optimized delivery"
					value={`$${Math.round(result.delivery)}`}
					sub={`was $${baseDelivery}`}
				/>
				<ResultCard
					label="Storage"
					value={`$${result.storage.toFixed(2)}`}
					sub={`was $${baseStorage}`}
				/>
				<ResultCard
					label="Total infra"
					value={`$${Math.round(result.total)}`}
					accent="text-warning"
					sub="storage + delivery + compute"
				/>
				<ResultCard
					label="Total savings"
					value={`$${Math.round(totalSavings)}`}
					sub={`${savingsPct.toFixed(0)}% reduction`}
					accent="text-success"
				/>
			</div>

			{/* Pool rate comparison */}
			<div className="card bg-base-200/50 border border-base-300">
				<div className="card-body p-4 text-sm text-base-content/60">
					<p>
						At $2,859 gross with ${Math.round(result.total)} infrastructure, the creator keeps{" "}
						<span className="font-bold text-success">
							${Math.round(2859 - result.total).toLocaleString()}
						</span>{" "}
						({(((2859 - result.total) / 2859) * 100).toFixed(1)}% of gross). Compare to YouTube:{" "}
						<span className="font-bold text-base-content">$1,572</span> (55% of gross).
					</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Section: Quick Reference Card
// ---------------------------------------------------------------------------

interface UnitCostCard {
	media: string;
	badge: string;
	badgeClass: string;
	store: { description: string; cost: string };
	deliver: { description: string; cost: string };
	note: string;
}

const UNIT_COST_CARDS: UnitCostCard[] = [
	{
		media: "Video",
		badge: "Video",
		badgeClass: "badge-error",
		store: { description: "1 hour of 1080p/60 (all quality tiers)", cost: "$0.19/mo" },
		deliver: { description: "1 view of a 30-min 1080p video", cost: "$0.018" },
		note: "Scales with catalog size and viewership",
	},
	{
		media: "Audio",
		badge: "Audio",
		badgeClass: "badge-warning",
		store: { description: "10-album music catalog", cost: "$0.14/mo" },
		deliver: { description: "1 full-album stream (high quality)", cost: "$0.00086" },
		note: "Scales with both, but delivery is very cheap",
	},
	{
		media: "Text",
		badge: "Text",
		badgeClass: "badge-ghost",
		store: { description: "A year of weekly essays", cost: "$0.008/mo" },
		deliver: { description: "1 article read", cost: "$0.000005" },
		note: "Essentially flat regardless of scale",
	},
	{
		media: "Games",
		badge: "Games",
		badgeClass: "badge-primary",
		store: { description: "500 MB game (3 platform variants)", cost: "$0.03/mo" },
		deliver: { description: "1 game download (500 MB)", cost: "$0.005" },
		note: "Storage scales with catalog; delivery is one-time per download",
	},
];

function QuickReference() {
	return (
		<div className="space-y-6">
			<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider">
				How much does it cost to serve one unit of content?
			</h4>

			{/* Media-type cards */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
				{UNIT_COST_CARDS.map((card) => (
					<div key={card.badge} className="card bg-base-200 border border-base-300">
						<div className="card-body p-4 gap-3">
							<span className={`badge ${card.badgeClass}`}>{card.badge}</span>
							<div>
								<p className="text-xs text-base-content/50 uppercase tracking-wide">Store</p>
								<p className="text-sm text-base-content/70">{card.store.description}</p>
								<p className="text-lg font-bold tabular-nums">{card.store.cost}</p>
							</div>
							<div className="divider my-0" />
							<div>
								<p className="text-xs text-base-content/50 uppercase tracking-wide">Deliver</p>
								<p className="text-sm text-base-content/70">{card.deliver.description}</p>
								<p className="text-lg font-bold tabular-nums">{card.deliver.cost}</p>
							</div>
							<p className="text-xs text-base-content/40">{card.note}</p>
						</div>
					</div>
				))}
			</div>

			{/* Base cost assumptions */}
			<div className="card bg-base-200/50 border border-base-300">
				<div className="card-body p-4">
					<h4 className="text-sm font-semibold mb-2">Base Cost Assumptions</h4>
					<div className="grid grid-cols-3 gap-4">
						<div>
							<p className="text-xs text-base-content/50 uppercase">Object storage</p>
							<p className="text-lg font-bold tabular-nums">
								$0.02<span className="text-sm font-normal text-base-content/50">/GB/mo</span>
							</p>
						</div>
						<div>
							<p className="text-xs text-base-content/50 uppercase">CDN delivery</p>
							<p className="text-lg font-bold tabular-nums">
								$0.01<span className="text-sm font-normal text-base-content/50">/GB</span>
							</p>
						</div>
						<div>
							<p className="text-xs text-base-content/50 uppercase">Compute</p>
							<p className="text-lg font-bold tabular-nums">
								$0.005<span className="text-sm font-normal text-base-content/50">/GB proc</span>
							</p>
						</div>
					</div>
					<p className="text-xs text-base-content/40 mt-2">
						Approximate volume rates at moderate scale (tens of TB/month) using DigitalOcean retail
						pricing. Actual costs vary by provider, region, and contract.
					</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const TABS: { id: Tab; label: string; description: string }[] = [
	{
		id: "calculator",
		label: "Cost Calculator",
		description: "Calculate storage and delivery costs for any content type and volume",
	},
	{
		id: "comparison",
		label: "Cross-Media",
		description: "Compare delivery costs across video, audio, text, and games",
	},
	{
		id: "profiles",
		label: "Creator Profiles",
		description: "Real YouTube creators mapped onto Anthers' infrastructure model",
	},
	{
		id: "optimizations",
		label: "Optimizations",
		description: "Toggle optimization techniques and see cascading cost reductions",
	},
];

/** The Sprout row, derived — never re-typed. See scripts/econ-figures.ts. */
const SPROUT = BADGE_TABLE.find((r) => r.badge === "Sprout")!;

export default function InfrastructureDemoPage() {
	const [activeTab, setActiveTab] = useState<Tab>("calculator");

	return (
		<div className="pb-16">
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Infrastructure Economics
						</p>
						<h1
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							What it actually costs to host content.
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-base-content/75">
							Anthers passes infrastructure costs through at cost with zero markup. Storage at
							$0.02/GB/month. Delivery at $0.01/GB. No percentage cut, no hidden fees. Explore the
							real numbers below.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* Quick reference card — always visible */}
			<div className="max-w-7xl mx-auto px-4 mb-8">
				<div className="card bg-base-200/50 border border-base-300">
					<div className="card-body p-4">
						<QuickReference />
					</div>
				</div>
			</div>

			<div className="max-w-7xl mx-auto px-4">
				{/* Tab selector */}
				<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-8">
					{TABS.map((tab) => (
						<button
							type="button"
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							className={`flex-1 text-left px-4 py-3 rounded-lg border transition-all ${
								activeTab === tab.id
									? "border-primary bg-primary/10 shadow-sm"
									: "border-base-300 bg-base-200/50 hover:border-base-content/20"
							}`}
						>
							<p className={`text-sm font-semibold ${activeTab === tab.id ? "text-primary" : ""}`}>
								{tab.label}
							</p>
							<p className="text-xs text-base-content/50">{tab.description}</p>
						</button>
					))}
				</div>

				{/* Active section */}
				<div className="card bg-base-100 shadow-sm border border-base-300">
					<div className="card-body p-6">
						{activeTab === "calculator" && <UnitCostCalculator />}
						{activeTab === "comparison" && <CrossMediaComparison />}
						{activeTab === "profiles" && <ReferenceCreatorProfiles />}
						{activeTab === "optimizations" && <OptimizationVisualizer />}
					</div>
				</div>

				{/* Footer note */}
				<div className="mt-8 text-center">
					<p className="text-xs text-base-content/40 max-w-xl mx-auto leading-relaxed">
						Cost estimates are approximate and based on volume CDN/storage pricing as of early 2026.
						Actual costs will vary with provider, scale, and optimization techniques. These figures
						are intended for planning and modeling, not invoicing.
					</p>
				</div>
			</div>
		</div>
	);
}
