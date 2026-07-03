// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared sidebar filter sections used by both Discover and Feed pages.
 * Includes: Content Type, Price, Filters (type-specific), and Tags.
 */

import {
	CommandLineIcon,
	CubeIcon,
	CubeTransparentIcon,
	CurrencyDollarIcon,
	FunnelIcon,
	MusicalNoteIcon,
	PencilSquareIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	TagIcon,
	VideoCameraIcon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const CONTENT_TYPES = [
	{ id: "", label: "All", icon: CubeTransparentIcon },
	{ id: "game", label: "Games", icon: PuzzlePieceIcon },
	{ id: "audio", label: "Music", icon: MusicalNoteIcon },
	{ id: "video", label: "Video", icon: VideoCameraIcon },
	{ id: "text", label: "Writing", icon: PencilSquareIcon },
	{ id: "image", label: "Images", icon: PhotoIcon },
	{ id: "software", label: "Software", icon: CommandLineIcon },
	{ id: "physical", label: "Physical", icon: CubeIcon },
	{ id: "service", label: "Services", icon: WrenchScrewdriverIcon },
] as const;

const PRICING_MODES = [
	{ id: "", label: "All" },
	{ id: "free", label: "Free" },
	{ id: "gated", label: "Gated" },
	{ id: "paid", label: "Paid" },
] as const;

export const TAGS_BY_TYPE: Record<string, string[]> = {
	"": [
		"indie",
		"open-source",
		"pixel-art",
		"narrative",
		"relaxing",
		"horror",
		"puzzle",
		"chiptune",
		"lo-fi",
		"podcast",
		"essay",
		"tutorial",
		"devlog",
		"creative-tools",
	],
	game: [
		"rpg",
		"platformer",
		"puzzle",
		"horror",
		"narrative",
		"roguelike",
		"farming-sim",
		"visual-novel",
		"point-and-click",
		"casual",
		"speedrun",
		"pixel-art",
		"jam-game",
		"atmospheric",
		"replayable",
		"relaxing",
		"level-editor",
		"indie",
	],
	audio: [
		"chiptune",
		"lo-fi",
		"ost",
		"game-music",
		"podcast",
		"interviews",
		"synthwave",
		"electronic",
		"ambient",
		"soundtrack",
		"remix",
	],
	video: [
		"devlog",
		"behind-the-scenes",
		"game-design",
		"tutorial",
		"live-performance",
		"essay",
		"documentary",
		"review",
	],
	text: [
		"essay",
		"tutorial",
		"devlog",
		"zine",
		"illustration",
		"art",
		"sketchbook",
		"technology",
		"culture",
		"guide",
		"postmortem",
	],
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ContentFilterParams {
	contentType: string;
	pricing: string;
	showLocked: string;
	minPrice: string;
	maxPrice: string;
	onSale: string;
	tag: string;
}

interface ContentFilterSectionsProps extends ContentFilterParams {
	onUpdateParams: (updates: Record<string, string>) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const filterBtnClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-secondary/10 text-secondary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

export default function ContentFilterSections({
	contentType,
	pricing,
	showLocked,
	minPrice,
	maxPrice,
	onSale,
	tag,
	onUpdateParams,
}: ContentFilterSectionsProps) {
	return (
		<>
			{/* Content type */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
					Content Type
				</h3>
				<div className="flex flex-col gap-0.5">
					{CONTENT_TYPES.map((type) => (
						<button
							key={type.id}
							type="button"
							className={filterBtnClass(contentType === type.id)}
							onClick={() => onUpdateParams({ media_type: type.id })}
						>
							<type.icon className="w-5 h-5 shrink-0" />
							{type.label}
						</button>
					))}
				</div>
			</section>

			{/* Price */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<CurrencyDollarIcon className="w-3.5 h-3.5" />
					Price
				</h3>

				{/* Three-way toggle */}
				<div className="flex rounded-lg bg-base-300/50 p-0.5">
					{PRICING_MODES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={`flex-1 text-xs py-1.5 rounded-md transition-colors font-medium ${
								pricing === mode.id
									? "bg-base-100 text-base-content shadow-sm"
									: "text-base-content/50 hover:text-base-content/70"
							}`}
							onClick={() =>
								onUpdateParams({
									pricing: mode.id,
									show_locked: "",
									min_price: "",
									max_price: "",
									on_sale: "",
								})
							}
						>
							{mode.label}
						</button>
					))}
				</div>

				{/* Gated sub-options */}
				{pricing === "gated" && (
					<label className="flex items-center gap-2 mt-3 cursor-pointer">
						<input
							type="checkbox"
							className="checkbox checkbox-xs checkbox-secondary"
							checked={showLocked === "true"}
							onChange={(e) => onUpdateParams({ show_locked: e.target.checked ? "true" : "" })}
						/>
						<span className="text-xs text-base-content/70">Show locked content</span>
					</label>
				)}

				{/* Paid sub-options */}
				{pricing === "paid" && (
					<div className="mt-3 space-y-2.5">
						<div className="flex items-center gap-2">
							<div className="flex-1">
								<input
									type="number"
									className="input input-bordered input-xs w-full"
									placeholder="Min"
									min="0"
									step="0.01"
									value={minPrice}
									onChange={(e) => onUpdateParams({ min_price: e.target.value })}
								/>
							</div>
							<span className="text-xs text-base-content/30">&ndash;</span>
							<div className="flex-1">
								<input
									type="number"
									className="input input-bordered input-xs w-full"
									placeholder="Max"
									min="0"
									step="0.01"
									value={maxPrice}
									onChange={(e) => onUpdateParams({ max_price: e.target.value })}
								/>
							</div>
						</div>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								className="checkbox checkbox-xs checkbox-secondary"
								checked={onSale === "true"}
								onChange={(e) => onUpdateParams({ on_sale: e.target.checked ? "true" : "" })}
							/>
							<span className="text-xs text-base-content/70">On sale</span>
						</label>
					</div>
				)}
			</section>

			{/* Type-specific filters */}
			{(contentType === "game" || contentType === "audio" || contentType === "video") && (
				<section>
					<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
						<FunnelIcon className="w-3.5 h-3.5" />
						Filters
					</h3>

					{contentType === "game" && (
						<div className="mb-3">
							<label className="text-xs text-base-content/50 mb-1 block">Platform</label>
							<select className="select select-bordered select-xs w-full">
								<option value="">Any platform</option>
								<option value="web">Browser</option>
								<option value="windows">Windows</option>
								<option value="mac">macOS</option>
								<option value="linux">Linux</option>
							</select>
						</div>
					)}

					{contentType === "audio" && (
						<div className="mb-3">
							<label className="text-xs text-base-content/50 mb-1 block">Duration</label>
							<select className="select select-bordered select-xs w-full">
								<option value="">Any length</option>
								<option value="short">Under 5 min</option>
								<option value="medium">5-30 min</option>
								<option value="long">Over 30 min</option>
							</select>
						</div>
					)}

					{contentType === "video" && (
						<div className="mb-3">
							<label className="text-xs text-base-content/50 mb-1 block">Duration</label>
							<select className="select select-bordered select-xs w-full">
								<option value="">Any length</option>
								<option value="short">Under 10 min</option>
								<option value="medium">10-60 min</option>
								<option value="long">Over 1 hour</option>
							</select>
						</div>
					)}
				</section>
			)}

			{/* Tags */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<TagIcon className="w-3.5 h-3.5" />
					Tags
				</h3>
				<div className="flex flex-wrap gap-1.5">
					{(TAGS_BY_TYPE[contentType] ?? TAGS_BY_TYPE[""]).map((t) => (
						<button
							key={t}
							type="button"
							className={`badge badge-sm cursor-pointer transition-colors ${
								tag === t ? "badge-secondary" : "badge-ghost hover:badge-outline"
							}`}
							onClick={() => onUpdateParams({ tag: tag === t ? "" : t })}
						>
							{t}
						</button>
					))}
				</div>
			</section>
		</>
	);
}
