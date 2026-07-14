// SPDX-License-Identifier: AGPL-3.0-or-later
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type ItemStatus = "launched" | "active" | "planned" | "exploring";

interface RoadmapItem {
	id: string;
	title: string;
	description: string;
	status: ItemStatus;
	/** Quarter index the item starts at (0-based). */
	startQ: number;
	/** Quarter index the item ends at (0-based, inclusive). */
	endQ: number;
	/** Visual row (0-based) — assigned by layout. */
	row?: number;
}

interface RoadmapLane {
	id: string;
	label: string;
	color: string;
	items: RoadmapItem[];
}

interface RoadmapSection {
	id: string;
	label: string;
	lanes: RoadmapLane[];
}

interface RoadmapDef {
	id: string;
	label: string;
	description: string;
	quarters: string[];
	sections: RoadmapSection[];
}

/* ------------------------------------------------------------------ */
/*  Status colors & labels                                            */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<
	ItemStatus,
	{ label: string; bg: string; bgDim: string; text: string; dot: string }
> = {
	launched: {
		label: "Launched",
		bg: "bg-success/20",
		bgDim: "bg-success/8",
		text: "text-success",
		dot: "#22c55e",
	},
	active: {
		label: "In Progress",
		bg: "bg-info/20",
		bgDim: "bg-info/8",
		text: "text-info",
		dot: "#3b82f6",
	},
	planned: {
		label: "Planned",
		bg: "bg-warning/20",
		bgDim: "bg-warning/8",
		text: "text-warning",
		dot: "#eab308",
	},
	exploring: {
		label: "Exploring",
		bg: "bg-base-content/10",
		bgDim: "bg-base-content/5",
		text: "text-base-content/50",
		dot: "#a3a3a3",
	},
};

/* ------------------------------------------------------------------ */
/*  Roadmap data                                                      */
/* ------------------------------------------------------------------ */

const QUARTERS = [
	"Q1 2026",
	"Q2 2026",
	"Q3 2026",
	"Q4 2026",
	"Q1 2027",
	"Q2 2027",
	"Q3 2027",
	"Q4 2027",
];

const PLATFORM_ROADMAP: RoadmapDef = {
	id: "platform",
	label: "Platform Roadmap",
	description:
		"Everything we're building for creators and users on Anthers — from publishing and monetization tools to content playback, subscriptions, and community features.",
	quarters: QUARTERS,
	sections: [
		{
			id: "for-creators",
			label: "For Creators",
			lanes: [
				{
					id: "publishing",
					label: "Publishing",
					color: "#7c3aed",
					items: [
						{
							id: "c-game-hosting",
							title: "Game Hosting & Marketplace",
							description:
								"Host games with build management, differential updates, web game embedding, and flexible pricing (free / PWYW / fixed / gated).",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-rich-text",
							title: "Rich Text Posts",
							description:
								"TipTap-powered editor for devlogs, articles, and written content with inline images and embeds.",
							status: "active",
							startQ: 0,
							endQ: 0,
						},
						{
							id: "c-video",
							title: "Video Hosting",
							description:
								"Upload and transcode video to HLS for adaptive streaming. Automatic thumbnail generation.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-audio",
							title: "Audio Hosting",
							description:
								"Upload audio with normalization, waveform generation, and persistent playback across navigation.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-multimedia-expand",
							title: "Multi-Media Expansion",
							description:
								"Visual art galleries, podcast series support, and mixed-media project pages.",
							status: "planned",
							startQ: 3,
							endQ: 5,
						},
					],
				},
				{
					id: "monetization",
					label: "Monetization",
					color: "#c026d3",
					items: [
						{
							id: "c-stripe-connect",
							title: "Stripe Connect Payouts",
							description:
								"Creator onboarding to Stripe Connect for direct payouts from marketplace sales and subscription distributions.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-pool-income",
							title: "Subscription Pool Income",
							description:
								"Earn from the Time Pool proportional to engagement time across all subscribers.",
							status: "planned",
							startQ: 1,
							endQ: 2,
						},
						{
							id: "c-boost-income",
							title: "Seed Income",
							description:
								"Additional subscriber-directed Seeds—100% to you—with manual or automatic allocation.",
							status: "planned",
							startQ: 1,
							endQ: 3,
						},
						{
							id: "c-gated-content",
							title: "Gated Content",
							description:
								"Set Seed thresholds to unlock exclusive content. Subscribers who sow enough Seeds get access.",
							status: "planned",
							startQ: 2,
							endQ: 3,
						},
						{
							id: "c-direct-purchases",
							title: "Direct Purchases",
							description:
								"Marketplace for one-time purchases: digital downloads, experiences, physical goods. 0% creator cut — transparent pass-through fees.",
							status: "planned",
							startQ: 2,
							endQ: 4,
						},
						{
							id: "c-bundles",
							title: "Creator Bundles",
							description:
								"Collaborative bundles with discounted combined gate access and engagement-time proportional revenue sharing.",
							status: "exploring",
							startQ: 5,
							endQ: 7,
						},
					],
				},
				{
					id: "tools",
					label: "Creator Tools",
					color: "#0ea5e9",
					items: [
						{
							id: "c-analytics",
							title: "Analytics Dashboard",
							description:
								"Views, purchases, engagement timeseries, content performance breakdown. Unified analytics across all content types.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-cross-publish",
							title: "Cross-Publishing",
							description:
								"Publish once, distribute everywhere. YouTube, itch.io, Steam, Substack, and more.",
							status: "planned",
							startQ: 2,
							endQ: 4,
						},
						{
							id: "c-itch-import",
							title: "itch.io Import",
							description: "One-click import of games, metadata, and assets from itch.io.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "c-creator-hubs",
							title: "Custom Creator Pages",
							description:
								"Branded creator profile pages with customizable layout, featured content, and social links.",
							status: "planned",
							startQ: 2,
							endQ: 3,
						},
						{
							id: "c-native-first",
							title: "Native-First Publishing",
							description:
								"Tools optimized for Anthers as the primary publishing destination, with cross-posting to legacy platforms as secondary.",
							status: "exploring",
							startQ: 5,
							endQ: 7,
						},
					],
				},
			],
		},
		{
			id: "for-users",
			label: "For Users",
			lanes: [
				{
					id: "consumption",
					label: "Content & Playback",
					color: "#2563eb",
					items: [
						{
							id: "u-browse",
							title: "Browse & Discover",
							description:
								"Browse projects by category, tag, and media type. Search with full-text matching.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "u-hls-playback",
							title: "Adaptive Video Playback",
							description: "HLS-based adaptive streaming for video content with quality selection.",
							status: "active",
							startQ: 0,
							endQ: 0,
						},
						{
							id: "u-audio-player",
							title: "Persistent Audio Player",
							description:
								"Mini-player that persists across page navigation. Full waveform visualization.",
							status: "active",
							startQ: 0,
							endQ: 0,
						},
						{
							id: "u-web-games",
							title: "Web Game Embedding",
							description: "Play HTML5/WebGL games directly in the browser from project pages.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "u-playlists",
							title: "Playlists & Watch History",
							description:
								"Create and manage playlists. Track watch/listen/play history across all content types.",
							status: "planned",
							startQ: 3,
							endQ: 4,
						},
						{
							id: "u-notifications",
							title: "Notifications",
							description: "Get notified when creators you follow publish new content or go live.",
							status: "planned",
							startQ: 3,
							endQ: 4,
						},
					],
				},
				{
					id: "subscription",
					label: "Subscriptions",
					color: "#c026d3",
					items: [
						{
							id: "u-sub-tiers",
							title: "Badge Plans & Seeds",
							description:
								"Choose a Badge plan (Free, Root, Sprout, Petal, Blossom); its whole-dollar price funds creators through the Time Pool (shared by watch-time) and included Seeds (100% to creators you pick), and comes with a bandwidth-wallet allowance. Every dollar is money to creators, bandwidth at cost, or the Community Share to the Anthers Foundation.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "u-boost-alloc",
							title: "Seed Allocation",
							description:
								"Sow Seeds to your favorite creators with sliders. Unlocks gated content.",
							status: "planned",
							startQ: 1,
							endQ: 2,
						},
						{
							id: "u-sub-dashboard",
							title: "Subscription Dashboard",
							description:
								"See exactly where your money goes each month: which creators, how much, why.",
							status: "planned",
							startQ: 2,
							endQ: 3,
						},
					],
				},
				{
					id: "community",
					label: "Community",
					color: "#0f766e",
					items: [
						{
							id: "u-follows",
							title: "Follow Creators",
							description:
								"Follow creators to build your chronological feed. No algorithmic ranking.",
							status: "active",
							startQ: 0,
							endQ: 0,
						},
						{
							id: "u-comments",
							title: "Comments & Ratings",
							description: "Rate and review projects. Comment on posts and game pages.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "u-jams",
							title: "Game Jams",
							description:
								"Participate in game jams: browse entries, vote, and discover new creators.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "u-contests",
							title: "Contests & Calls for Content",
							description:
								"Multi-media contests, sponsor-backed events, panel judging, prize escrow.",
							status: "planned",
							startQ: 3,
							endQ: 5,
						},
						{
							id: "u-mobile",
							title: "Mobile Apps",
							description:
								"Native iOS and Android apps for content consumption, notifications, and community interaction.",
							status: "exploring",
							startQ: 5,
							endQ: 7,
						},
					],
				},
			],
		},
	],
};

const FOUNDATION_ROADMAP: RoadmapDef = {
	id: "foundation",
	label: "Foundation Roadmap",
	description:
		"Milestones and initiatives for the Anthers Foundation — a 501(c)(3) non-profit. From incorporation to charitable programs at scale.",
	quarters: QUARTERS,
	sections: [
		{
			id: "on-platform",
			label: "On-Platform",
			lanes: [
				{
					id: "legal",
					label: "Organization",
					color: "#c2410c",
					items: [
						{
							id: "f-pre-inc",
							title: "Pre-Incorporation",
							description:
								"Attorney engaged, board recruited, governance documents drafted, fiscal planning completed.",
							status: "active",
							startQ: 0,
							endQ: 0,
						},
						{
							id: "f-incorporation",
							title: "Incorporation & Filing",
							description:
								"Colorado incorporation, EIN obtained, Form 1023 submitted, first board meeting held.",
							status: "active",
							startQ: 0,
							endQ: 1,
						},
						{
							id: "f-building",
							title: "Building in the Open",
							description:
								"Platform development, community forming, early donations, vendor conversations, transparent progress reports.",
							status: "active",
							startQ: 1,
							endQ: 2,
						},
						{
							id: "f-alpha",
							title: "Alpha Launch",
							description:
								"Invite-only launch with 20-50 creators, a few hundred consumers. CRF operational. IRS determination letter (ideally).",
							status: "planned",
							startQ: 2,
							endQ: 3,
						},
						{
							id: "f-beta",
							title: "Beta Launch",
							description:
								"Open registration, multiple media formats, CRF expanding, active fundraising, first 990 filed.",
							status: "planned",
							startQ: 4,
							endQ: 5,
						},
						{
							id: "f-ga",
							title: "General Availability",
							description:
								"Stable public platform, all CRF pillars active, federation functioning, organizational maturity.",
							status: "exploring",
							startQ: 6,
							endQ: 7,
						},
					],
				},
				{
					id: "crf",
					label: "Resilience Fund",
					color: "#0f766e",
					items: [
						{
							id: "f-infra-equity",
							title: "Pillar 1: Infrastructure Equity",
							description:
								"Small creator subsidies, viral surge protection, free-tier infrastructure access for new creators.",
							status: "planned",
							startQ: 2,
							endQ: 4,
						},
						{
							id: "f-education",
							title: "Pillar 2: Education & Development",
							description:
								"Creators as Educators initiative, structured mentorship programs, skill-building content and workshops.",
							status: "planned",
							startQ: 3,
							endQ: 5,
						},
						{
							id: "f-relief",
							title: "Pillar 3: Economic Resilience & Relief",
							description:
								"Creation grants ($1-5K range), emergency assistance for creators, supplementary professional resources.",
							status: "exploring",
							startQ: 4,
							endQ: 6,
						},
						{
							id: "f-community",
							title: "Pillar 4: Community & Public Benefit",
							description:
								"Open-source tool development, research and advocacy, community partnerships and outreach programs.",
							status: "exploring",
							startQ: 5,
							endQ: 7,
						},
					],
				},
				{
					id: "growth",
					label: "Growth Milestones",
					color: "#7c3aed",
					items: [
						{
							id: "f-founding-creators",
							title: "Founding Creators (20-50)",
							description:
								"Recruit initial cohort of founding creators, primarily from the indie game development community.",
							status: "active",
							startQ: 0,
							endQ: 2,
						},
						{
							id: "f-2500-subs",
							title: "2,500 Subscribers",
							description:
								"Covers basic overhead ($13-16K/yr). Infrastructure subsidies begin. Reserve accumulation starts.",
							status: "planned",
							startQ: 3,
							endQ: 4,
						},
						{
							id: "f-10000-subs",
							title: "10,000 Subscribers",
							description:
								"Minimum viable one-person operation ($50-65K/yr). Pillar 1 funded. First small grants possible.",
							status: "exploring",
							startQ: 5,
							endQ: 6,
						},
						{
							id: "f-25000-subs",
							title: "25,000 Subscribers",
							description:
								"Inflection point: ED salary + admin overhead ($125-164K/yr). All four CRF pillars active. Meaningful creation grants.",
							status: "exploring",
							startQ: 6,
							endQ: 7,
						},
					],
				},
			],
		},
		{
			id: "off-platform",
			label: "Off-Platform",
			lanes: [],
		},
	],
};

const ROADMAPS: RoadmapDef[] = [PLATFORM_ROADMAP, FOUNDATION_ROADMAP];

/* ------------------------------------------------------------------ */
/*  Layout helper: assign rows within each lane to avoid overlaps     */
/* ------------------------------------------------------------------ */

function assignRows(items: RoadmapItem[]): RoadmapItem[] {
	const sorted = [...items].sort((a, b) => a.startQ - b.startQ || a.endQ - b.endQ);
	const rows: number[][] = []; // rows[r] = list of endQ values in that row

	return sorted.map((item) => {
		let placed = -1;
		for (let r = 0; r < rows.length; r++) {
			// Check if this row has space (no overlap)
			const lastEnd = Math.max(...rows[r]);
			if (item.startQ > lastEnd) {
				placed = r;
				break;
			}
		}
		if (placed === -1) {
			placed = rows.length;
			rows.push([]);
		}
		rows[placed].push(item.endQ);
		return { ...item, row: placed };
	});
}

/* ------------------------------------------------------------------ */
/*  Timeline chart (SVG-based interactive Gantt)                       */
/* ------------------------------------------------------------------ */

const MIN_Q_WIDTH = 160; // minimum px per quarter column
const ROW_HEIGHT = 40; // px per item row
const LANE_HEADER = 32; // px for lane label
const LANE_GAP = 16; // px between lanes
const SECTION_HEADER = 36; // px for section group header
const SECTION_GAP = 24; // px between sections
const BAR_PAD_Y = 6; // vertical padding inside row
const BAR_RADIUS = 6;
const LEFT_GUTTER = 0; // no left gutter — labels are inside bars
const TOP_PAD = 40; // space for quarter headers

interface TimelineProps {
	roadmap: RoadmapDef;
	selectedItem: string | null;
	onSelect: (id: string | null) => void;
}

function Timeline({ roadmap, selectedItem, onSelect }: TimelineProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [hoveredItem, setHoveredItem] = useState<string | null>(null);
	const [containerWidth, setContainerWidth] = useState(0);

	// Measure container width and update on resize
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setContainerWidth(entry.contentRect.width);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Compute Q_WIDTH: fill container, but never go below MIN_Q_WIDTH
	const numQuarters = roadmap.quarters.length;
	const Q_WIDTH =
		containerWidth > 0
			? Math.max(MIN_Q_WIDTH, (containerWidth - LEFT_GUTTER) / numQuarters)
			: MIN_Q_WIDTH;

	// Layout all sections → lanes
	const layoutSections = useMemo(() => {
		return roadmap.sections
			.filter((s) => s.lanes.length > 0)
			.map((section) => {
				const lanes = section.lanes.map((lane) => {
					const laidOut = assignRows(lane.items);
					const maxRow = laidOut.reduce((max, item) => Math.max(max, (item.row ?? 0) + 1), 0);
					return { ...lane, items: laidOut, rowCount: maxRow };
				});
				return { ...section, lanes };
			});
	}, [roadmap]);

	// Total SVG height
	const totalHeight = useMemo(() => {
		return (
			TOP_PAD +
			layoutSections.reduce(
				(h, section) =>
					h +
					SECTION_HEADER +
					section.lanes.reduce(
						(lh, lane) => lh + LANE_HEADER + lane.rowCount * ROW_HEIGHT + LANE_GAP,
						0,
					) +
					SECTION_GAP,
				0,
			)
		);
	}, [layoutSections]);

	const totalWidth = LEFT_GUTTER + numQuarters * Q_WIDTH;

	const handleBarClick = useCallback(
		(id: string) => {
			onSelect(selectedItem === id ? null : id);
		},
		[selectedItem, onSelect],
	);

	// Accumulate Y offset for each lane
	let laneY = TOP_PAD;

	return (
		<div ref={containerRef} className="overflow-x-auto rounded-xl border border-base-300/50">
			<svg
				role="img"
				ref={svgRef}
				width={totalWidth}
				height={totalHeight}
				className="select-none"
				style={{ minWidth: numQuarters * MIN_Q_WIDTH }}
			>
				<title>Roadmap timeline</title>
				{/* Quarter columns */}
				{roadmap.quarters.map((q, i) => {
					const x = LEFT_GUTTER + i * Q_WIDTH;
					return (
						<g key={q}>
							{/* Alternating column background */}
							<rect
								x={x}
								y={0}
								width={Q_WIDTH}
								height={totalHeight}
								className={i % 2 === 0 ? "fill-base-200/30" : "fill-base-200/60"}
							/>
							{/* Vertical divider */}
							{i > 0 && (
								<line
									x1={x}
									y1={0}
									x2={x}
									y2={totalHeight}
									className="stroke-base-300/40"
									strokeWidth={1}
								/>
							)}
							{/* Quarter label */}
							<text
								x={x + Q_WIDTH / 2}
								y={24}
								textAnchor="middle"
								className="fill-base-content/50"
								fontSize={12}
								fontWeight={600}
							>
								{q}
							</text>
						</g>
					);
				})}

				{/* "Now" indicator line for current quarter */}
				{(() => {
					const now = new Date();
					const year = now.getFullYear();
					const month = now.getMonth(); // 0-11
					const currentQLabel = `Q${Math.floor(month / 3) + 1} ${year}`;
					const qIndex = roadmap.quarters.indexOf(currentQLabel);
					if (qIndex === -1) return null;
					// Position within the quarter (0-1)
					const monthInQ = month % 3;
					const dayFrac = (now.getDate() - 1) / 30;
					const frac = (monthInQ + dayFrac) / 3;
					const x = LEFT_GUTTER + qIndex * Q_WIDTH + frac * Q_WIDTH;
					return (
						<g>
							<line
								x1={x}
								y1={TOP_PAD - 6}
								x2={x}
								y2={totalHeight}
								stroke="#f43f5e"
								strokeWidth={2}
								strokeDasharray="6 4"
								opacity={0.6}
							/>
							<text
								x={x}
								y={TOP_PAD - 10}
								textAnchor="middle"
								fontSize={10}
								fontWeight={700}
								fill="#f43f5e"
								opacity={0.8}
							>
								Today
							</text>
						</g>
					);
				})()}

				{/* Sections → Lanes */}
				{layoutSections.map((section) => {
					// Section header
					const sectionStartY = laneY;
					laneY += SECTION_HEADER;

					return (
						<g key={section.id}>
							{/* Section group label */}
							<text
								x={8}
								y={sectionStartY + SECTION_HEADER - 12}
								fontSize={13}
								fontWeight={800}
								className="fill-base-content/60"
								style={{ letterSpacing: 0.5 }}
							>
								{section.label}
							</text>

							{/* Section divider line */}
							<line
								x1={0}
								y1={sectionStartY + SECTION_HEADER - 4}
								x2={totalWidth}
								y2={sectionStartY + SECTION_HEADER - 4}
								className="stroke-base-300/50"
								strokeWidth={1}
							/>

							{/* Lanes within section */}
							{section.lanes.map((lane) => {
								const currentLaneY = laneY;
								const laneHeight = LANE_HEADER + lane.rowCount * ROW_HEIGHT;
								laneY += laneHeight + LANE_GAP;

								return (
									<g key={lane.id}>
										{/* Lane label */}
										<text
											x={8}
											y={currentLaneY + LANE_HEADER - 10}
											fontSize={11}
											fontWeight={700}
											className="fill-base-content/40"
											style={{ letterSpacing: 1 }}
										>
											{lane.label.toUpperCase()}
										</text>

										{/* Lane separator line */}
										<line
											x1={0}
											y1={currentLaneY + LANE_HEADER - 2}
											x2={totalWidth}
											y2={currentLaneY + LANE_HEADER - 2}
											className="stroke-base-300/30"
											strokeWidth={1}
										/>

										{/* Items */}
										{lane.items.map((item) => {
											const row = item.row ?? 0;
											const x = LEFT_GUTTER + item.startQ * Q_WIDTH + 4;
											const w = (item.endQ - item.startQ + 1) * Q_WIDTH - 8;
											const y = currentLaneY + LANE_HEADER + row * ROW_HEIGHT + BAR_PAD_Y;
											const h = ROW_HEIGHT - BAR_PAD_Y * 2;
											const isHovered = hoveredItem === item.id;
											const isSelected = selectedItem === item.id;
											const status = STATUS_META[item.status];

											return (
												<g
													key={item.id}
													style={{ cursor: "pointer" }}
													onMouseEnter={() => setHoveredItem(item.id)}
													onMouseLeave={() => setHoveredItem(null)}
													onClick={() => handleBarClick(item.id)}
												>
													{/* Bar background */}
													<rect
														x={x}
														y={y}
														width={w}
														height={h}
														rx={BAR_RADIUS}
														fill={lane.color}
														fillOpacity={isSelected ? 0.35 : isHovered ? 0.25 : 0.15}
														stroke={lane.color}
														strokeWidth={isSelected ? 2 : isHovered ? 1.5 : 0}
														strokeOpacity={0.6}
														style={{ transition: "fill-opacity 150ms, stroke-width 150ms" }}
													/>
													{/* Status dot */}
													<circle cx={x + 14} cy={y + h / 2} r={4} fill={status.dot} />
													{/* Title */}
													<text
														x={x + 26}
														y={y + h / 2}
														dominantBaseline="central"
														fontSize={12}
														fontWeight={600}
														className="fill-base-content"
														style={{ pointerEvents: "none" }}
													>
														{item.title}
													</text>
												</g>
											);
										})}
									</g>
								);
							})}

							{/* Section gap spacer (advance laneY) */}
							{(() => {
								laneY += SECTION_GAP;
								return null;
							})()}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Detail panel (shown when an item is selected)                     */
/* ------------------------------------------------------------------ */

function DetailPanel({
	item,
	lane,
	quarters,
	onClose,
}: {
	item: RoadmapItem;
	lane: RoadmapLane;
	quarters: string[];
	onClose: () => void;
}) {
	const status = STATUS_META[item.status];
	const span =
		item.startQ === item.endQ
			? quarters[item.startQ]
			: `${quarters[item.startQ]} — ${quarters[item.endQ]}`;

	return (
		<div className={`card ${status.bg} border border-base-300/50 shadow-lg`}>
			<div className="card-body p-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="flex items-center gap-2 mb-1">
							<span
								className="inline-block w-3 h-3 rounded-full"
								style={{ backgroundColor: status.dot }}
							/>
							<span className={`text-xs font-semibold uppercase tracking-wide ${status.text}`}>
								{status.label}
							</span>
							<span className="text-xs text-base-content/30 mx-1">|</span>
							<span className="text-xs font-medium" style={{ color: lane.color }}>
								{lane.label}
							</span>
						</div>
						<h3 className="text-lg font-bold">{item.title}</h3>
						<p className="text-xs text-base-content/50 mt-0.5">{span}</p>
					</div>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						onClick={onClose}
						aria-label="Close detail"
					>
						<svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
							<path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
						</svg>
					</button>
				</div>
				<p className="text-sm text-base-content/70 mt-2 leading-relaxed">{item.description}</p>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Status legend                                                     */
/* ------------------------------------------------------------------ */

function StatusLegend() {
	return (
		<div className="flex flex-wrap gap-4 text-xs">
			{(Object.entries(STATUS_META) as [ItemStatus, (typeof STATUS_META)[ItemStatus]][]).map(
				([key, meta]) => (
					<div key={key} className="flex items-center gap-1.5">
						<span
							className="inline-block w-2.5 h-2.5 rounded-full"
							style={{ backgroundColor: meta.dot }}
						/>
						<span className="text-base-content/60">{meta.label}</span>
					</div>
				),
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Main page component                                               */
/* ------------------------------------------------------------------ */

export default function RoadmapPage() {
	const [activeTab, setActiveTab] = useState(0);
	const [selectedItem, setSelectedItem] = useState<string | null>(null);

	const roadmap = ROADMAPS[activeTab];

	// Find the selected item and its lane for the detail panel
	const selectedData = useMemo(() => {
		if (!selectedItem) return null;
		for (const section of roadmap.sections) {
			for (const lane of section.lanes) {
				const item = lane.items.find((i) => i.id === selectedItem);
				if (item) return { item, lane };
			}
		}
		return null;
	}, [selectedItem, roadmap]);

	// Reset selection when switching tabs
	const handleTabChange = useCallback((index: number) => {
		setActiveTab(index);
		setSelectedItem(null);
	}, []);

	return (
		<div className="mx-auto px-4 py-8" style={{ maxWidth: "110rem" }}>
			{/* Header */}
			<div className="text-center mb-8">
				<Reveal>
					<p className="text-xs uppercase tracking-wider text-base-content/40 mb-1">
						501(c)(3) non-profit
					</p>
					<h1 className="text-3xl font-bold mb-2">Roadmap</h1>
				</Reveal>
				<Reveal delay={120}>
					<p className="text-base-content/70 max-w-xl mx-auto">
						See what we're building, what's next, and where we're headed. Anthers is built in the
						open — everything here reflects our actual plans and priorities.
					</p>
				</Reveal>
			</div>

			{/* Tab selector */}
			<div className="flex justify-center mb-6">
				<div className="tabs tabs-boxed bg-base-200/60">
					{ROADMAPS.map((rm, i) => (
						<button
							type="button"
							key={rm.id}
							className={`tab ${activeTab === i ? "tab-active" : ""}`}
							onClick={() => handleTabChange(i)}
						>
							{rm.label.replace(" Roadmap", "")}
						</button>
					))}
				</div>
			</div>

			{/* Roadmap description */}
			<div className="max-w-3xl mx-auto mb-6">
				<p className="text-sm text-base-content/60 text-center">{roadmap.description}</p>
			</div>

			{/* Legend + hint */}
			<div className="flex items-center justify-between mb-4 flex-wrap gap-2">
				<StatusLegend />
				<p className="text-xs text-base-content/30">Click any item for details.</p>
			</div>

			{/* Timeline chart */}
			<Timeline roadmap={roadmap} selectedItem={selectedItem} onSelect={setSelectedItem} />

			{/* Detail panel */}
			{selectedData && (
				<div className="mt-6 max-w-2xl">
					<DetailPanel
						item={selectedData.item}
						lane={selectedData.lane}
						quarters={roadmap.quarters}
						onClose={() => setSelectedItem(null)}
					/>
				</div>
			)}

			{/* Bottom section — Contributing */}
			<Reveal className="mt-16 max-w-3xl mx-auto text-center pb-4">
				<h2 className="text-xl font-bold mb-3">Built in the Open</h2>
				<p className="text-sm text-base-content/60 leading-relaxed max-w-2xl mx-auto">
					Anthers is a non-profit, and our roadmap reflects our commitment to transparency.
					Priorities are shaped by creator and user feedback, not investor demands. Have a feature
					request or want to get involved? Join our community or reach out directly.
				</p>
			</Reveal>
		</div>
	);
}
