// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Link } from "react-router-dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformComparison {
	gross: number;
	platformFee: number;
	infraCost: number;
	net: number;
}

interface SubscriberMilestone {
	label: string;
	subscribers: number;
	pctOfAudience: number;
}

interface RevenueByTier {
	tier: string;
	price: number;
	pool: number;
	boost: number;
	total: number;
}

interface ContentItem {
	/** e.g. "Long essays (40-90 min)", "Podcast episodes" */
	label: string;
	mediaType: "video" | "audio" | "text" | "game";
	count: number;
	/** Average duration in minutes (for video/audio) or null */
	avgDurationMin: number | null;
	/** Total monthly views/listens/reads/downloads across all items in this category */
	monthlyPlays: number;
	/** Average watch/listen duration per play in minutes (accounts for drop-off) */
	avgPlayMin: number | null;
}

interface DemoCreatorBreakdown {
	id: string;
	label: string;
	displayName: string;
	avatar: string;
	contentType: string;
	description: string;
	/** Platform they're coming from */
	currentPlatform: string;
	/** Stats on their current platform */
	audienceStats: { label: string; value: string }[];
	/** Detailed content library with per-category breakdowns */
	contentLibrary: ContentItem[];
	/** Monthly revenue on current platform vs Anthers */
	current: PlatformComparison;
	anthers: PlatformComparison;
	/** Subscriber milestones to hit key revenue targets */
	milestones: SubscriberMilestone[];
	/** Per-subscriber revenue by Anthers tier */
	revenueByTier: RevenueByTier[];
	/** Key insight text */
	insight: string;
	/** Monthly infra breakdown */
	infraBreakdown: { label: string; cost: number }[];
	/** Content stats */
	contentStats: { label: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Infrastructure cost constants (from Anthers Infrastructure Cheat Sheet)
// ---------------------------------------------------------------------------

const INFRA = {
	/** Source bitrate assumption for all video content (Mbps). */
	videoBitrateMbps: 30,
	/** Object storage: $/GB/month */
	storageCostPerGb: 0.02,
	/** CDN delivery: $/GB */
	deliveryCostPerGb: 0.01,
	/** Multi-quality ladder storage multiplier (360p through source) */
	qualityLadderMultiplier: 1.8,
	/** Blended average viewer delivery rate (MB/min) across quality tiers */
	videoDeliveryMbPerMin: 4,
	/** Audio delivery rate (AAC 256 kbps, MB/min) */
	audioDeliveryMbPerMin: 1.9,
	/** Audio storage rate (MB/min, multi-format ~2x FLAC) */
	audioStorageMbPerMin: 15,
	/** Text: average page weight in MB */
	textDeliveryMb: 0.5,
	/** Text: average storage per post in MB */
	textStorageMb: 0.5,
	/** Game download: delivery $/GB (same as CDN) */
	gameDeliveryCostPerGb: 0.01,
};

/**
 * Derive per-minute source storage from bitrate.
 * 30 Mbps = 30 / 8 = 3.75 MB/s = 225 MB/min
 */
const VIDEO_SOURCE_MB_PER_MIN = (INFRA.videoBitrateMbps / 8) * 60;

// ---------------------------------------------------------------------------
// Demo data — three creators at different scales and content types
// ---------------------------------------------------------------------------

const DEMO_CREATORS: DemoCreatorBreakdown[] = [
	{
		id: "video",
		label: "Video Essayist",
		displayName: "Deep Currents",
		avatar: "DC",
		contentType: "Long-form video essays",
		description:
			"High-bandwidth video essayist with a back-catalog of long-form content. This is the hardest case in our model — heavy streaming, large file sizes, high concurrent viewership. If the economics work here, they work everywhere.",
		currentPlatform: "YouTube",
		audienceStats: [
			{ label: "Subscribers", value: "147,000" },
			{ label: "Monthly views", value: "953,000" },
			{ label: "Watch time/mo", value: "26.5M min" },
			{ label: "Avg. video length", value: "~50 min" },
		],
		contentLibrary: [
			// 22 videos total, ~1,112 min runtime, 953K monthly views
			{
				label: "Long essays (40-90 min)",
				mediaType: "video",
				count: 8,
				avgDurationMin: 65,
				monthlyPlays: 420_000,
				avgPlayMin: 38,
			},
			{
				label: "Mid-length essays (15-40 min)",
				mediaType: "video",
				count: 7,
				avgDurationMin: 25,
				monthlyPlays: 350_000,
				avgPlayMin: 18,
			},
			{
				label: "Short commentaries (<15 min)",
				mediaType: "video",
				count: 5,
				avgDurationMin: 10,
				monthlyPlays: 160_000,
				avgPlayMin: 8,
			},
			{
				label: "Livestream archives (2-4 hrs)",
				mediaType: "video",
				count: 2,
				avgDurationMin: 180,
				monthlyPlays: 23_000,
				avgPlayMin: 45,
			},
		],
		current: {
			gross: 2859,
			platformFee: 1287,
			infraCost: 0,
			net: 1572,
		},
		anthers: {
			gross: 2859,
			platformFee: 0,
			infraCost: 1105,
			net: 1754,
		},
		milestones: [
			{ label: "Cover infrastructure", subscribers: 1339, pctOfAudience: 0.9 },
			{ label: "Match YouTube net", subscribers: 1905, pctOfAudience: 1.3 },
			{ label: "Match YouTube gross", subscribers: 3466, pctOfAudience: 2.4 },
			{ label: "Double YouTube net", subscribers: 3810, pctOfAudience: 2.6 },
		],
		revenueByTier: [
			{ tier: "Root", price: 3, pool: 0.83, boost: 0.0, total: 0.83 },
			{ tier: "Sprout", price: 7, pool: 0.77, boost: 0.66, total: 1.43 },
			{ tier: "Sprout+", price: 10, pool: 0.77, boost: 1.12, total: 1.89 },
			{ tier: "Petal", price: 15, pool: 0.77, boost: 1.64, total: 2.41 },
			{ tier: "Bloom", price: 30, pool: 0.75, boost: 3.94, total: 4.69 },
		],
		insight:
			"Even as the highest-bandwidth creator in our model, Deep Currents comes out ahead of YouTube at just 1.3% subscriber conversion. Boost income is load-bearing — it accounts for over half of revenue at Sprout and above. With WebRTC peer-assisted delivery (30-60% bandwidth savings), infrastructure drops to ~$575/mo, widening the margin significantly.",
		infraBreakdown: [
			{ label: "CDN delivery (~106 TB)", cost: 1060 },
			{ label: "Object storage (~133 GB)", cost: 2.66 },
			{ label: "Compute (transcoding)", cost: 42 },
		],
		contentStats: [
			{ label: "Library size", value: "22 pieces" },
			{ label: "Total runtime", value: "~1,112 min" },
			{ label: "Storage", value: "~133 GB" },
			{ label: "Monthly bandwidth", value: "~106 TB" },
		],
	},
	{
		id: "podcast",
		label: "Podcaster & Writer",
		displayName: "Sage Moreno",
		avatar: "SM",
		contentType: "Podcast + long-form essays",
		description:
			"A mid-size podcaster and essayist. Audio is dramatically cheaper to serve than video — roughly 1/60th the bandwidth per minute. Combined with text posts, infrastructure costs are negligible, making almost every subscription dollar pure creator income.",
		currentPlatform: "Substack + Patreon",
		audienceStats: [
			{ label: "Newsletter subs", value: "24,000" },
			{ label: "Podcast listeners/mo", value: "85,000" },
			{ label: "Patreon supporters", value: "1,400" },
			{ label: "Avg. episode length", value: "~45 min" },
		],
		contentLibrary: [
			{
				label: "Full-length episodes (30-60 min)",
				mediaType: "audio",
				count: 68,
				avgDurationMin: 45,
				monthlyPlays: 72_000,
				avgPlayMin: 32,
			},
			{
				label: "Bonus/short episodes (10-20 min)",
				mediaType: "audio",
				count: 21,
				avgDurationMin: 15,
				monthlyPlays: 13_000,
				avgPlayMin: 12,
			},
			{
				label: "Long-form essays (2-5K words)",
				mediaType: "text",
				count: 140,
				avgDurationMin: null,
				monthlyPlays: 65_000,
				avgPlayMin: null,
			},
			{
				label: "Short posts & updates",
				mediaType: "text",
				count: 60,
				avgDurationMin: null,
				monthlyPlays: 22_000,
				avgPlayMin: null,
			},
		],
		current: {
			gross: 9800,
			platformFee: 1274,
			infraCost: 0,
			net: 8526,
		},
		anthers: {
			gross: 9800,
			platformFee: 0,
			infraCost: 48,
			net: 9752,
		},
		milestones: [
			{ label: "Cover infrastructure", subscribers: 32, pctOfAudience: 0.1 },
			{ label: "Match Patreon net", subscribers: 1120, pctOfAudience: 4.7 },
			{ label: "Match combined gross", subscribers: 1288, pctOfAudience: 5.4 },
			{ label: "Double Patreon net", subscribers: 2240, pctOfAudience: 9.3 },
		],
		revenueByTier: [
			{ tier: "Root", price: 3, pool: 0.66, boost: 0.0, total: 0.66 },
			{ tier: "Sprout", price: 7, pool: 0.62, boost: 0.52, total: 1.14 },
			{ tier: "Sprout+", price: 10, pool: 0.62, boost: 0.89, total: 1.51 },
			{ tier: "Petal", price: 15, pool: 0.62, boost: 1.3, total: 1.92 },
			{ tier: "Bloom", price: 30, pool: 0.6, boost: 3.12, total: 3.72 },
		],
		insight:
			"Audio and text are incredibly cheap to serve. Sage's entire monthly infrastructure cost is under $50 — less than 0.5% of revenue. This means nearly every dollar from subscribers flows directly to income. Compared to Patreon's 8-12% fee + payment processing, Anthers saves over $1,200/mo at the same subscriber count.",
		infraBreakdown: [
			{ label: "CDN delivery (~2.4 TB audio)", cost: 24 },
			{ label: "Object storage (~18 GB)", cost: 0.36 },
			{ label: "Compute (audio processing)", cost: 8 },
			{ label: "Text/image hosting", cost: 15.64 },
		],
		contentStats: [
			{ label: "Podcast episodes", value: "89 episodes" },
			{ label: "Total audio runtime", value: "~4,000 min" },
			{ label: "Written essays", value: "~200 posts" },
			{ label: "Monthly bandwidth", value: "~2.4 TB" },
		],
	},
	{
		id: "gamedev",
		label: "Indie Game Dev",
		displayName: "Nova Pixel",
		avatar: "NP",
		contentType: "Games + devlogs + OSTs",
		description:
			"A small indie game developer who publishes games (one-time purchases), devlog videos, and original soundtracks. Revenue is a mix of direct game sales and subscription support from fans following the development journey. Infrastructure costs are tiny since game downloads are infrequent bursts, not continuous streaming.",
		currentPlatform: "itch.io",
		audienceStats: [
			{ label: "itch.io followers", value: "3,200" },
			{ label: "Monthly page views", value: "18,000" },
			{ label: "Total game sales", value: "4,800" },
			{ label: "Avg. game price", value: "$8.50" },
		],
		contentLibrary: [
			{
				label: "Game builds (50-500 MB each)",
				mediaType: "game",
				count: 4,
				avgDurationMin: null,
				monthlyPlays: 420,
				avgPlayMin: null,
			},
			{
				label: "Devlog videos (5-15 min)",
				mediaType: "video",
				count: 47,
				avgDurationMin: 10,
				monthlyPlays: 14_000,
				avgPlayMin: 7,
			},
			{
				label: "OST albums (audio)",
				mediaType: "audio",
				count: 72,
				avgDurationMin: 4,
				monthlyPlays: 8_500,
				avgPlayMin: 3.5,
			},
			{
				label: "Text devlogs & patch notes",
				mediaType: "text",
				count: 30,
				avgDurationMin: null,
				monthlyPlays: 4_200,
				avgPlayMin: null,
			},
		],
		current: {
			gross: 1420,
			platformFee: 142,
			infraCost: 0,
			net: 1278,
		},
		anthers: {
			gross: 1420,
			platformFee: 0,
			infraCost: 12,
			net: 1408,
		},
		milestones: [
			{ label: "Cover infrastructure", subscribers: 8, pctOfAudience: 0.3 },
			{ label: "Match itch.io net", subscribers: 168, pctOfAudience: 5.3 },
			{ label: "Match itch.io + subs", subscribers: 320, pctOfAudience: 10.0 },
			{ label: "Double itch.io net", subscribers: 560, pctOfAudience: 17.5 },
		],
		revenueByTier: [
			{ tier: "Root", price: 3, pool: 0.51, boost: 0.0, total: 0.51 },
			{ tier: "Sprout", price: 7, pool: 0.48, boost: 0.4, total: 0.88 },
			{ tier: "Sprout+", price: 10, pool: 0.48, boost: 0.69, total: 1.17 },
			{ tier: "Petal", price: 15, pool: 0.48, boost: 1.0, total: 1.48 },
			{ tier: "Bloom", price: 30, pool: 0.46, boost: 2.4, total: 2.86 },
		],
		insight:
			"Game developers benefit from both subscription income (devlog followers, OST listeners) and direct sales on the marketplace. Nova's infrastructure costs are minimal — downloads are one-time transfers, not continuous streaming. Combined with direct game sales, even a small subscriber base creates a sustainable income floor that smooths out the feast-or-famine cycle of launch-driven sales.",
		infraBreakdown: [
			{ label: "CDN delivery (~120 GB)", cost: 1.2 },
			{ label: "Object storage (~8 GB)", cost: 0.16 },
			{ label: "Compute (video transcoding)", cost: 6 },
			{ label: "Game file hosting", cost: 4.64 },
		],
		contentStats: [
			{ label: "Published games", value: "4 titles" },
			{ label: "Devlog videos", value: "47 episodes" },
			{ label: "OST albums", value: "3 albums" },
			{ label: "Monthly bandwidth", value: "~120 GB" },
		],
	},
];

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function StatCard({
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
				<p className={`text-xl font-bold ${accent ?? ""}`}>{value}</p>
				{sub && <p className="text-xs text-base-content/40">{sub}</p>}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Content library table with derived infrastructure costs
// ---------------------------------------------------------------------------

interface DerivedCosts {
	storageGb: number;
	storageCost: number;
	deliveryGb: number;
	deliveryCost: number;
}

function deriveItemCosts(item: ContentItem): DerivedCosts {
	const { mediaType, count, avgDurationMin, monthlyPlays, avgPlayMin } = item;

	if (mediaType === "video") {
		// Storage: source MB/min * duration * quality ladder * count
		const totalSourceMin = count * (avgDurationMin ?? 0);
		const storageGb =
			(totalSourceMin * VIDEO_SOURCE_MB_PER_MIN * INFRA.qualityLadderMultiplier) / 1024;
		const storageCost = storageGb * INFRA.storageCostPerGb;

		// Delivery: plays * avg watch min * blended MB/min
		const totalDeliveryMin = monthlyPlays * (avgPlayMin ?? 0);
		const deliveryGb = (totalDeliveryMin * INFRA.videoDeliveryMbPerMin) / 1024;
		const deliveryCost = deliveryGb * INFRA.deliveryCostPerGb;

		return { storageGb, storageCost, deliveryGb, deliveryCost };
	}

	if (mediaType === "audio") {
		const totalMin = count * (avgDurationMin ?? 0);
		const storageGb = (totalMin * INFRA.audioStorageMbPerMin) / 1024;
		const storageCost = storageGb * INFRA.storageCostPerGb;

		const totalDeliveryMin = monthlyPlays * (avgPlayMin ?? 0);
		const deliveryGb = (totalDeliveryMin * INFRA.audioDeliveryMbPerMin) / 1024;
		const deliveryCost = deliveryGb * INFRA.deliveryCostPerGb;

		return { storageGb, storageCost, deliveryGb, deliveryCost };
	}

	if (mediaType === "text") {
		const storageGb = (count * INFRA.textStorageMb) / 1024;
		const storageCost = storageGb * INFRA.storageCostPerGb;

		const deliveryGb = (monthlyPlays * INFRA.textDeliveryMb) / 1024;
		const deliveryCost = deliveryGb * INFRA.deliveryCostPerGb;

		return { storageGb, storageCost, deliveryGb, deliveryCost };
	}

	if (mediaType === "game") {
		// Assume average 200 MB per build, 3 platform variants
		const avgBuildMb = 200;
		const platforms = 3;
		const storageGb = (count * avgBuildMb * platforms) / 1024;
		const storageCost = storageGb * INFRA.storageCostPerGb;

		// Downloads: plays * avg build size
		const deliveryGb = (monthlyPlays * avgBuildMb) / 1024;
		const deliveryCost = deliveryGb * INFRA.gameDeliveryCostPerGb;

		return { storageGb, storageCost, deliveryGb, deliveryCost };
	}

	return { storageGb: 0, storageCost: 0, deliveryGb: 0, deliveryCost: 0 };
}

function fmtSize(gb: number): string {
	if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${(gb * 1024).toFixed(0)} MB`;
}

function fmtCost(cost: number): string {
	if (cost < 0.01) return "<$0.01";
	if (cost < 1) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(2)}`;
}

function ContentLibraryTable({ creator }: { creator: DemoCreatorBreakdown }) {
	const rows = creator.contentLibrary.map((item) => ({
		item,
		costs: deriveItemCosts(item),
	}));

	const totalStorage = rows.reduce((s, r) => s + r.costs.storageGb, 0);
	const totalStorageCost = rows.reduce((s, r) => s + r.costs.storageCost, 0);
	const totalDelivery = rows.reduce((s, r) => s + r.costs.deliveryGb, 0);
	const totalDeliveryCost = rows.reduce((s, r) => s + r.costs.deliveryCost, 0);
	const totalInfra = totalStorageCost + totalDeliveryCost;

	return (
		<div className="space-y-4">
			<div className="overflow-x-auto">
				<table className="table table-sm w-full">
					<thead>
						<tr>
							<th>Content</th>
							<th className="text-right">Items</th>
							<th className="text-right">Monthly plays</th>
							<th className="text-right">Storage</th>
							<th className="text-right">Delivery/mo</th>
							<th className="text-right">Cost/mo</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(({ item, costs }) => (
							<tr key={item.label}>
								<td className="text-sm">
									<div className="flex items-center gap-2">
										<span
											className={`badge badge-xs ${
												item.mediaType === "video"
													? "badge-error"
													: item.mediaType === "audio"
														? "badge-warning"
														: item.mediaType === "game"
															? "badge-primary"
															: "badge-ghost"
											}`}
										>
											{item.mediaType}
										</span>
										<span>{item.label}</span>
									</div>
								</td>
								<td className="text-sm text-right tabular-nums">{item.count}</td>
								<td className="text-sm text-right tabular-nums">
									{item.monthlyPlays.toLocaleString()}
								</td>
								<td className="text-sm text-right tabular-nums text-base-content/60">
									{fmtSize(costs.storageGb)}
								</td>
								<td className="text-sm text-right tabular-nums text-base-content/60">
									{fmtSize(costs.deliveryGb)}
								</td>
								<td className="text-sm text-right tabular-nums">
									{fmtCost(costs.storageCost + costs.deliveryCost)}
								</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr className="font-semibold">
							<td className="text-sm">Total</td>
							<td className="text-sm text-right">
								{creator.contentLibrary.reduce((s, i) => s + i.count, 0)}
							</td>
							<td className="text-sm text-right">
								{creator.contentLibrary.reduce((s, i) => s + i.monthlyPlays, 0).toLocaleString()}
							</td>
							<td className="text-sm text-right text-base-content/60">{fmtSize(totalStorage)}</td>
							<td className="text-sm text-right text-base-content/60">{fmtSize(totalDelivery)}</td>
							<td className="text-sm text-right">{fmtCost(totalInfra)}</td>
						</tr>
					</tfoot>
				</table>
			</div>

			{/* Summary cards */}
			<div className="grid grid-cols-3 gap-3">
				<StatCard
					label="Total storage"
					value={fmtSize(totalStorage)}
					sub={`${fmtCost(totalStorageCost)}/mo`}
				/>
				<StatCard
					label="Monthly delivery"
					value={fmtSize(totalDelivery)}
					sub={`${fmtCost(totalDeliveryCost)}/mo`}
				/>
				<StatCard
					label="Total infra cost"
					value={fmtCost(totalInfra)}
					sub="passed through at cost"
					accent="text-warning"
				/>
			</div>

			<p className="text-xs text-base-content/40">
				Video assumes {INFRA.videoBitrateMbps} Mbps source bitrate with adaptive multi-quality
				ladder ({INFRA.qualityLadderMultiplier}x storage). Delivery uses blended average of{" "}
				{INFRA.videoDeliveryMbPerMin} MB/min across viewer quality tiers. Storage at $
				{INFRA.storageCostPerGb}/GB/mo, delivery at ${INFRA.deliveryCostPerGb}/GB.
			</p>
		</div>
	);
}

function ComparisonTable({ creator }: { creator: DemoCreatorBreakdown }) {
	const { current, anthers, currentPlatform } = creator;

	const rows: {
		label: string;
		currentVal: string;
		anthersVal: string;
		currentClass?: string;
		anthersClass?: string;
	}[] = [
		{
			label: "Gross revenue",
			currentVal: `$${current.gross.toLocaleString()}`,
			anthersVal: `$${anthers.gross.toLocaleString()}`,
		},
		{
			label: "Platform fees",
			currentVal:
				current.platformFee > 0
					? `-$${current.platformFee.toLocaleString()} (${Math.round((current.platformFee / current.gross) * 100)}%)`
					: "$0",
			anthersVal: "$0",
			currentClass: current.platformFee > 0 ? "text-error" : "",
			anthersClass: "text-success",
		},
		{
			label: "Infrastructure",
			currentVal: current.infraCost > 0 ? `-$${current.infraCost.toLocaleString()}` : "Included",
			anthersVal:
				anthers.infraCost > 0
					? `-$${anthers.infraCost.toLocaleString()} (${Math.round((anthers.infraCost / anthers.gross) * 100)}%)`
					: "$0",
			currentClass: "text-base-content/50",
			anthersClass: anthers.infraCost > 50 ? "text-warning" : "text-base-content/50",
		},
		{
			label: "Net to creator",
			currentVal: `$${current.net.toLocaleString()}`,
			anthersVal: `$${anthers.net.toLocaleString()}`,
			currentClass: "font-bold",
			anthersClass: `font-bold ${anthers.net >= current.net ? "text-success" : ""}`,
		},
		{
			label: "Creator keeps",
			currentVal: `${Math.round((current.net / current.gross) * 100)}%`,
			anthersVal: `${Math.round((anthers.net / anthers.gross) * 100)}%`,
			anthersClass: anthers.net >= current.net ? "text-success font-semibold" : "",
		},
	];

	return (
		<div className="overflow-x-auto">
			<table className="table table-sm w-full">
				<thead>
					<tr>
						<th />
						<th className="text-right">{currentPlatform}</th>
						<th className="text-right">Anthers</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.label}>
							<td className="text-sm text-base-content/70">{row.label}</td>
							<td className={`text-sm text-right ${row.currentClass ?? ""}`}>{row.currentVal}</td>
							<td className={`text-sm text-right ${row.anthersClass ?? ""}`}>{row.anthersVal}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function MilestoneBar({ creator }: { creator: DemoCreatorBreakdown }) {
	const maxSubs = creator.milestones[creator.milestones.length - 1].subscribers;

	return (
		<div className="space-y-3">
			{creator.milestones.map((m) => {
				const pct = Math.min((m.subscribers / (maxSubs * 1.15)) * 100, 100);
				return (
					<div key={m.label}>
						<div className="flex justify-between text-sm mb-1">
							<span className="text-base-content/70">{m.label}</span>
							<span className="font-medium tabular-nums">
								{m.subscribers.toLocaleString()} subs
								<span className="text-base-content/40 ml-1">({m.pctOfAudience}%)</span>
							</span>
						</div>
						<div className="w-full h-2.5 bg-base-300 rounded-full overflow-hidden">
							<div
								className="h-full bg-primary/60 rounded-full transition-all"
								style={{ width: `${pct}%` }}
							/>
						</div>
					</div>
				);
			})}
			<p className="text-xs text-base-content/40">
				% of {creator.currentPlatform} audience needed to convert
			</p>
		</div>
	);
}

function TierRevenueTable({ creator }: { creator: DemoCreatorBreakdown }) {
	return (
		<div className="overflow-x-auto">
			<table className="table table-sm w-full">
				<thead>
					<tr>
						<th>Tier</th>
						<th className="text-right">Price</th>
						<th className="text-right">Pool</th>
						<th className="text-right">Boost</th>
						<th className="text-right">Total to creator</th>
					</tr>
				</thead>
				<tbody>
					{creator.revenueByTier.map((row) => {
						const isExample = row.tier.includes("+");
						return (
							<tr
								key={row.tier}
								className={
									isExample ? "text-base-content/50 border-dashed border-t border-base-300/50" : ""
								}
							>
								<td className={`text-sm ${isExample ? "italic" : "font-medium"}`}>
									{isExample ? `e.g. ${row.tier}` : row.tier}
								</td>
								<td
									className={`text-sm text-right ${isExample ? "italic" : "text-base-content/60"}`}
								>
									${row.price}/mo
								</td>
								<td className="text-sm text-right text-success">${row.pool.toFixed(2)}</td>
								<td className="text-sm text-right text-primary">
									{row.boost > 0 ? `$${row.boost.toFixed(2)}` : "—"}
								</td>
								<td className={`text-sm text-right ${isExample ? "" : "font-semibold"}`}>
									${row.total.toFixed(2)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className="text-xs text-base-content/40 mt-2">
				Named tiers show revenue at the threshold price; "Sprout+" shows $10/mo as an example of
				continuous $1-increment funding between tiers. Boost scales continuously — actual funding
				levels vary. Per-subscriber revenue assumes this creator receives{" "}
				{creator.id === "video" ? "~8.6%" : creator.id === "podcast" ? "~6.8%" : "~5.2%"} of a
				typical subscriber's engagement time.
			</p>
		</div>
	);
}

function InfraBreakdown({ creator }: { creator: DemoCreatorBreakdown }) {
	const total = creator.infraBreakdown.reduce((s, i) => s + i.cost, 0);

	return (
		<div className="space-y-2">
			{creator.infraBreakdown.map((item) => (
				<div key={item.label} className="flex justify-between text-sm">
					<span className="text-base-content/70">{item.label}</span>
					<span className="tabular-nums">
						${item.cost < 1 ? item.cost.toFixed(2) : item.cost.toFixed(0)}
					</span>
				</div>
			))}
			<div className="divider my-1" />
			<div className="flex justify-between text-sm font-bold">
				<span>Total monthly infrastructure</span>
				<span>${total < 1 ? total.toFixed(2) : total.toFixed(0)}</span>
			</div>
			<p className="text-xs text-base-content/40">
				Passed through at cost — no markup. Itemized on the creator dashboard.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Creator breakdown panel
// ---------------------------------------------------------------------------

function CreatorBreakdownPanel({ creator }: { creator: DemoCreatorBreakdown }) {
	return (
		<div className="space-y-8">
			{/* Creator header */}
			<div className="flex items-start gap-4">
				<div className="w-14 h-14 rounded-full bg-base-300 flex items-center justify-center text-lg font-bold text-base-content/60 flex-shrink-0">
					{creator.avatar}
				</div>
				<div>
					<h3 className="text-xl font-bold">{creator.displayName}</h3>
					<p className="text-sm text-base-content/60">{creator.contentType}</p>
					<p className="text-sm text-base-content/50 mt-1 max-w-2xl leading-relaxed">
						{creator.description}
					</p>
				</div>
			</div>

			{/* Content library & infrastructure derivation */}
			<div>
				<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
					Content Library & Infrastructure
				</h4>
				<div className="card bg-base-200/60 shadow-sm">
					<div className="card-body p-4">
						<ContentLibraryTable creator={creator} />
					</div>
				</div>
			</div>

			{/* Audience stats */}
			<div>
				<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
					Current Audience ({creator.currentPlatform})
				</h4>
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					{creator.audienceStats.map((stat) => (
						<StatCard key={stat.label} label={stat.label} value={stat.value} />
					))}
				</div>
			</div>

			{/* Revenue comparison */}
			<div>
				<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
					Revenue Comparison
				</h4>
				<div className="card bg-base-200/60 shadow-sm">
					<div className="card-body p-4">
						<ComparisonTable creator={creator} />
					</div>
				</div>
			</div>

			{/* Two-column: Milestones + Tier Revenue */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
						Subscriber Milestones
					</h4>
					<div className="card bg-base-200/60 shadow-sm">
						<div className="card-body p-4">
							<MilestoneBar creator={creator} />
						</div>
					</div>
				</div>
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
						Per-Subscriber Revenue by Tier
					</h4>
					<div className="card bg-base-200/60 shadow-sm">
						<div className="card-body p-4">
							<TierRevenueTable creator={creator} />
						</div>
					</div>
				</div>
			</div>

			{/* Two-column: Infrastructure + Content stats */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
						Infrastructure Costs
					</h4>
					<div className="card bg-base-200/60 shadow-sm">
						<div className="card-body p-4">
							<InfraBreakdown creator={creator} />
						</div>
					</div>
				</div>
				<div>
					<h4 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
						Content Profile
					</h4>
					<div className="card bg-base-200/60 shadow-sm">
						<div className="card-body p-4 space-y-2">
							{creator.contentStats.map((stat) => (
								<div key={stat.label} className="flex justify-between text-sm">
									<span className="text-base-content/70">{stat.label}</span>
									<span className="font-medium">{stat.value}</span>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>

			{/* Insight callout */}
			<div className="card bg-primary/5 border border-primary/20">
				<div className="card-body p-4">
					<h4 className="text-sm font-semibold text-primary mb-1">Key Takeaway</h4>
					<p className="text-sm text-base-content/70 leading-relaxed">{creator.insight}</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CreatorBreakdownDemoPage() {
	const [activeId, setActiveId] = useState(DEMO_CREATORS[0].id);
	const active = DEMO_CREATORS.find((c) => c.id === activeId)!;

	return (
		<div className="pb-16">
			{/* Hero intro */}
			<section className="py-12 px-4 text-center">
				<p className="text-sm font-medium text-primary mb-2 tracking-wide uppercase">
					Creator Economics
				</p>
				<h1 className="text-4xl font-bold tracking-tight mb-3">
					How your audience translates to income.
				</h1>
				<p className="text-base-content/60 max-w-2xl mx-auto leading-relaxed">
					Anthers takes zero percentage cut. Infrastructure is passed through at cost. Below are
					three real-world creator profiles showing exactly how audience size, content type, and
					subscriber tiers determine income on Anthers — and how it compares to the platforms you're
					on today.
				</p>
			</section>

			{/* Content */}
			<div className="max-w-7xl mx-auto px-4">
				{/* Creator selector tabs */}
				<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-8">
					{DEMO_CREATORS.map((c) => (
						<button
							type="button"
							key={c.id}
							onClick={() => setActiveId(c.id)}
							className={`
								flex-1 text-left px-4 py-3 rounded-lg border transition-all
								${
									activeId === c.id
										? "border-primary bg-primary/10 shadow-sm"
										: "border-base-300 bg-base-200/50 hover:border-base-content/20"
								}
							`}
						>
							<p className={`text-sm font-semibold ${activeId === c.id ? "text-primary" : ""}`}>
								{c.displayName}
							</p>
							<p className="text-xs text-base-content/50">
								{c.label} — {c.currentPlatform}
							</p>
						</button>
					))}
				</div>

				{/* Breakdown content */}
				<CreatorBreakdownPanel creator={active} />

				{/* CTA */}
				<div className="mt-12 text-center">
					<p className="text-base-content/50 text-sm mb-4">
						No hidden fees. No percentage cut. Real infrastructure costs, transparently deducted.
					</p>
					<div className="flex flex-wrap justify-center gap-3">
						<Link to="/for-creators" className="btn btn-primary">
							Learn more for creators
						</Link>
						<Link to="/demo-creator-page" className="btn btn-ghost">
							See creator page demos
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
