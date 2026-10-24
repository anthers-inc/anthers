// SPDX-License-Identifier: Apache-2.0
/**
 * The poster a Work shows when it has no thumbnail of its own.
 *
 * ⭐ **Every kind gets its own drawing, and the music band is the bar** (Parker, 2026-10-24).
 * A Work may be released with no thumbnail, so the band where its picture would be cannot be a
 * bare gradient or a lone gray icon — that reads as a broken image rather than as a Work whose
 * creator left the picture to us. The anatomy is the one the feed's music band proved: the
 * type's icon large and soft, the type's name in a tracked-out uppercase eyebrow, and a
 * decorative foot adapted to the medium — a waveform, a filmstrip, a page grid, a barcode.
 *
 * ⚠️ **The foot is decoration and carries no data.** A real waveform is drawn from the
 * creator's peaks and a real filmstrip from their frames; these are the shape of the idea, so
 * they are static, `aria-hidden`, and never animated except where a hover preview is already
 * playing beneath them.
 *
 * A new kind joins by adding its row to {@link POSTERS}, which is typed as a total map over
 * `WORK_TYPES` — a missing row is a compile error rather than a silent fallback.
 */

import type { WorkType } from "@anthers/shared/content";
import type { ReactNode } from "react";
import { TypeIcon, typeLabel } from "./works";

type MotifProps = {
	/** A hover preview is playing above the poster — the listened feet step with it. */
	playing?: boolean;
	/** Drawn at thumbnail size: the Studio's row, the channel guide's strip. */
	compact?: boolean;
};

/** The decorative foot, at the two sizes the poster is drawn. */
function foot(compact?: boolean): string {
	return compact
		? "absolute inset-x-1.5 bottom-1 h-2 text-base-content/40"
		: "absolute inset-x-4 bottom-3 h-8 text-base-content/40";
}

function MotifFrame({ compact, children }: { compact?: boolean; children: ReactNode }) {
	return (
		<div aria-hidden="true" className={`${foot(compact)} pointer-events-none`}>
			{children}
		</div>
	);
}

/**
 * Music, and the shape spoken audio borrows: bars of hand-picked heights, so the foot reads
 * as a waveform rather than as a spreadsheet. Decorative — see the header.
 */
const MUSIC_BARS = [
	38, 62, 45, 80, 55, 30, 70, 50, 88, 40, 60, 75, 35, 55, 68, 48, 30, 80, 58, 42, 66, 36, 74, 52,
];

/** Spoken audio: denser and more even than music's, the way a voice's level reads. */
const AUDIO_BARS = [
	22, 34, 28, 46, 38, 60, 44, 32, 52, 70, 58, 42, 30, 48, 66, 54, 36, 28, 44, 62, 50, 34, 26, 40,
	56, 68, 46, 32, 24, 38,
];

function WaveformMotif({ heights, playing }: MotifProps & { heights: readonly number[] }) {
	return (
		<MotifFrame>
			<div className="flex h-full items-end gap-[3px]">
				{heights.map((height, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a static decorative list, never reordered
						key={i}
						className={`flex-1 origin-bottom rounded-full bg-current ${
							playing ? "opacity-80 motion-safe:animate-eq-bar" : "opacity-35"
						}`}
						style={{
							height: `${height}%`,
							...(playing ? { animationDelay: `${i * 40}ms` } : null),
						}}
					/>
				))}
			</div>
		</MotifFrame>
	);
}

/** The filmstrip: two rows of sprockets around a run of frames. */
function FilmstripMotif({ compact }: MotifProps) {
	const sprockets = Array.from({ length: 16 }, (_, i) => i);
	return (
		<MotifFrame compact={compact}>
			<svg
				viewBox="0 0 160 32"
				preserveAspectRatio="none"
				className="h-full w-full opacity-70"
				fill="currentColor"
				aria-hidden="true"
			>
				{sprockets.map((i) => (
					<rect key={`top-${i}`} x={i * 10 + 2} y={0} width={6} height={4} rx={1} />
				))}
				{sprockets.map((i) => (
					<rect key={`bottom-${i}`} x={i * 10 + 2} y={28} width={6} height={4} rx={1} />
				))}
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<rect key={`frame-${i}`} x={i * 26.67} y={7} width={1.5} height={18} />
				))}
			</svg>
		</MotifFrame>
	);
}

/** Writing: a paragraph's last lines, ragged where prose is. */
function ProseLinesMotif({ compact }: MotifProps) {
	const widths = [100, 92, 97, 68];
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full flex-col justify-end gap-[5px]">
				{widths.map((width) => (
					<div
						key={width}
						className="h-[3px] rounded-full bg-current opacity-70"
						style={{ width: `${width}%` }}
					/>
				))}
			</div>
		</MotifFrame>
	);
}

/** Comic: a strip of panels with gutters, one of them carrying its own balloon. */
function ComicPanelsMotif({ compact }: MotifProps) {
	const panels = [30, 22, 26, 18];
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full gap-1">
				{panels.map((width, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a static decorative list, never reordered
						key={i}
						className="h-full rounded-sm border border-current opacity-70"
						style={{ width: `${width}%` }}
					>
						{i === 1 && <div className="mx-1 mt-1 h-1 rounded-full bg-current opacity-80" />}
					</div>
				))}
			</div>
		</MotifFrame>
	);
}

/** The book kinds: two pages splayed either side of the gutter. */
function OpenBookMotif({ compact }: MotifProps) {
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full items-stretch justify-center gap-[3px]">
				<div className="h-full w-1/3 rounded-l-sm border border-current opacity-70" />
				<div className="h-full w-1/3 rounded-r-sm border border-current opacity-70" />
			</div>
		</MotifFrame>
	);
}

/** A gallery: a horizon and a rising sun, the picture icon made into scenery. */
function LandscapeMotif({ compact }: MotifProps) {
	return (
		<MotifFrame compact={compact}>
			<svg
				viewBox="0 0 100 32"
				preserveAspectRatio="none"
				className="h-full w-full opacity-70"
				fill="currentColor"
				aria-hidden="true"
			>
				<circle cx={20} cy={9} r={4} />
				<path d="M0 32 L22 13 L38 27 L54 15 L76 32 Z" />
				<path d="M62 32 L78 21 L92 32 Z" opacity={0.6} />
			</svg>
		</MotifFrame>
	);
}

/** A game: a level's ground, stepped the way a platformer's tiles step. */
function LevelBlocksMotif({ compact }: MotifProps) {
	const columns = [46, 46, 78, 32, 58, 100, 58, 32];
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full items-end gap-[2px]">
				{columns.map((height, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a static decorative list, never reordered
						key={i}
						className="flex-1 rounded-[1px] bg-current opacity-70"
						style={{ height: `${height}%` }}
					/>
				))}
			</div>
		</MotifFrame>
	);
}

/** Software: a prompt and the lines it answered with. */
function CodeLinesMotif({ compact }: MotifProps) {
	const scale = compact ? "text-[6px]" : "text-[9px]";
	return (
		<MotifFrame compact={compact}>
			<div className={`flex h-full flex-col justify-end gap-[5px] ${scale}`}>
				<div className="flex items-center gap-1">
					<span className="font-mono leading-none">&gt;</span>
					<span className="h-[3px] w-1/3 rounded-full bg-current opacity-70" />
				</div>
				<div className="ml-3 h-[3px] w-1/2 rounded-full bg-current opacity-45" />
				<div className="ml-3 h-[3px] w-2/5 rounded-full bg-current opacity-45" />
			</div>
		</MotifFrame>
	);
}

/** A physical good: the barcode on the parcel. */
function BarcodeMotif({ compact }: MotifProps) {
	const bars = [1, 2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 2, 1, 3, 1, 2, 1, 1, 2, 3, 1, 2];
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full items-stretch gap-[2px]">
				{bars.map((weight, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a static decorative list, never reordered
						key={i}
						className="bg-current opacity-70"
						style={{ flexGrow: weight, flexBasis: 0 }}
					/>
				))}
			</div>
		</MotifFrame>
	);
}

/** A service: a work order's answered lines. */
function ChecklistMotif({ compact }: MotifProps) {
	const widths = [68, 84, 56];
	return (
		<MotifFrame compact={compact}>
			<div className="flex h-full flex-col justify-end gap-[4px]">
				{widths.map((width) => (
					<div key={width} className="flex items-center gap-1">
						<span className="size-[5px] shrink-0 rounded-[1px] border border-current opacity-70" />
						<span
							className="h-[3px] rounded-full bg-current opacity-50"
							style={{ width: `${width}%` }}
						/>
					</div>
				))}
			</div>
		</MotifFrame>
	);
}

/**
 * The palette and the foot for each kind. `WORK_TYPES` is the authority on the list, and a
 * kind missing here is a type error rather than a poster that silently falls back.
 */
const POSTERS: Record<WorkType, { palette: string; Motif: (props: MotifProps) => ReactNode }> = {
	music: {
		palette: "from-secondary/25 to-primary/15",
		Motif: (props) => <WaveformMotif {...props} heights={MUSIC_BARS} />,
	},
	audio: {
		palette: "from-accent/20 to-primary/10",
		Motif: (props) => <WaveformMotif {...props} heights={AUDIO_BARS} />,
	},
	video: {
		palette: "from-warning/25 to-accent/10",
		Motif: (props) => <FilmstripMotif {...props} />,
	},
	text: {
		palette: "from-base-300/80 to-base-100",
		Motif: (props) => <ProseLinesMotif {...props} />,
	},
	comic: {
		palette: "from-accent/30 to-warning/15",
		Motif: (props) => <ComicPanelsMotif {...props} />,
	},
	ebook: {
		palette: "from-accent/30 to-secondary/15",
		Motif: (props) => <OpenBookMotif {...props} />,
	},
	image: {
		palette: "from-info/25 to-accent/10",
		Motif: (props) => <LandscapeMotif {...props} />,
	},
	game: {
		palette: "from-primary/25 to-accent/10",
		Motif: (props) => <LevelBlocksMotif {...props} />,
	},
	software: {
		palette: "from-neutral/25 to-base-200",
		Motif: (props) => <CodeLinesMotif {...props} />,
	},
	physical: {
		palette: "from-success/25 to-warning/10",
		Motif: (props) => <BarcodeMotif {...props} />,
	},
	service: {
		palette: "from-info/25 to-primary/10",
		Motif: (props) => <ChecklistMotif {...props} />,
	},
};

export default function WorkPoster({
	type,
	className = "aspect-video",
	playing = false,
	variant = "full",
}: {
	/** The Work's kind. A kind this build does not know falls back to the writing poster. */
	type: string;
	/** Sizes the poster. Defaults to the 16:9 band a listing gives a thumbnail. */
	className?: string;
	/** A hover preview is playing above it; the listened feet step with it. */
	playing?: boolean;
	/**
	 * `full` is the listing band — icon, name and foot. `thumb` is the small preview a
	 * table row or a guide strip gives a thumbnail: the icon and the foot, no name.
	 */
	variant?: "full" | "thumb";
}) {
	const shape = POSTERS[type as WorkType] ?? POSTERS.text;
	const compact = variant === "thumb";
	const Motif = shape.Motif;
	return (
		<div
			data-testid="work-poster"
			data-work-type={type}
			className={`relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br ${shape.palette} ${className}`}
		>
			<TypeIcon
				type={type}
				className={
					compact
						? "w-6 h-6 text-base-content/20"
						: "w-[26%] max-w-14 aspect-square text-base-content/15"
				}
			/>
			{!compact && (
				<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">
					{typeLabel(type)}
				</span>
			)}
			<Motif playing={playing} compact={compact} />
		</div>
	);
}
