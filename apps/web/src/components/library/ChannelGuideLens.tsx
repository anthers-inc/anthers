// SPDX-License-Identifier: Apache-2.0
/**
 * The **Channel Guide lens** — the Library (or, later, the Feed), organized the way a
 * TV schedule is browsed.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea** — the same invariant
 * the music, video and Bookshelf lenses carry: a different *organizing metaphor* over a
 * corpus the context hands it. The metaphor is an old-school channel guide **pivoted 90°
 * clockwise** (Parker, 2026-10-11): channels left to right alphabetically, each column a
 * vertical timeline of that creator's videos, latest at the top, oldest at the bottom.
 * Selecting a video opens it in the left ¾ with that video's channel sliding to the
 * right ¼, selection highlighted — the playlist-player arrangement.
 *
 * ⭐ **Next is up** — see `lib/channel-guide.ts`, which carries the whole model in pure
 * form: the never-temporal-never-alignment rule (columns are per-creator recency ranks,
 * "latest plus one" aligns across channels without agreeing on a time), the upward
 * next-up arithmetic, and the autoplay preference, which is deliberately **off by
 * default** and a user's choice to flip.
 *
 * ⭐ **The guide is drawn as a guide, not as a list of cards.** Every channel is a column
 * under a fixed-height bug (avatar, name, handle, program count), every program is the
 * same fixed-height block, and a rank ruler down the left edge names the row positions
 * — *Latest*, *1 back*, *2 back* — so the level rows read as ranks rather than as a
 * shared clock. That is the metaphor made visible: a real schedule prints times in that
 * gutter, and this one prints the only ordinals the model actually has.
 *
 * 🚨 **A lens is a view, never a container**, and nothing here mutates the shelf: no
 * fetch of its own, selection is view state, and closing the player leaves the guide
 * exactly as it stood. The corpus rides the context (Parker, 2026-10-11): **from the
 * Library, a channel's programs are the creator's videos you have saved; from the Feed,
 * every video they have released, followed or not.** The component renders whatever
 * channels its host translates — that translation for the Library shelf is
 * {@link channelGuideChannelsFromShelf}.
 */
import { workUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import type { Work } from "@anthers/web-shared/types";
import { isAccessResult } from "@anthers/web-shared/types";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	LockClosedIcon,
	PlayIcon,
	TvIcon,
	XMarkIcon,
} from "@heroicons/react/24/solid";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	compareChannelNames,
	compareRecencyLatestFirst,
	type GuideChannel,
	nextProgramIndex,
	previousProgramIndex,
	readAutoplay,
	writeAutoplay,
} from "../../lib/channel-guide";
import PlayingBars from "../media/transport/PlayingBars";
import VideoPlayer from "../media/VideoPlayer";
import type { LensItem } from "./MusicLens";

/** A video duration rendered the way a video platform shows it: 25:02, or 1:04:33. */
export function formatDuration(seconds: number | null | undefined): string | null {
	if (seconds == null || seconds <= 0) return null;
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rem = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
	return `${m}:${String(rem).padStart(2, "0")}`;
}

/** A block's date, the compact feed shape (`FeedTile`'s convention). */
function compactDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The Library context's translation: the same fetched shelf list the other lenses draw
 * on, grouped into channels **by their creators** — a channel exists because at least one
 * saved video names its creator, and the channel's programs are exactly the creator's
 * saved videos, recency-ranked by the model. Channels alphabetically by name.
 */
export function channelGuideChannelsFromShelf(items: LensItem[]): GuideChannel[] {
	const byCreator = new Map<string, GuideChannel>();
	for (const item of items) {
		if (item.kind !== "work" || item.work?.type !== "video") continue;
		const work = item.work;
		const key = `creator:${work.creatorId ?? "unknown"}`;
		let channel = byCreator.get(key);
		if (!channel) {
			channel = {
				id: key,
				creatorId: work.creatorId ?? null,
				handle: work.creatorHandle ?? null,
				name: work.creatorDisplayName ?? work.creatorHandle ?? null,
				avatar: work.creatorAvatar ?? null,
				programs: [],
			};
			byCreator.set(key, channel);
		}
		channel.programs.push(work);
	}
	for (const channel of byCreator.values()) {
		channel.programs.sort(compareRecencyLatestFirst);
	}
	return [...byCreator.values()].sort(compareChannelNames);
}

export interface ChannelGuideLensProps {
	/** The translated channels — the context decides what a block is; the lens only ranks them. */
	channels: GuideChannel[];
	/**
	 * Optional URL-synchronized selection (the Work's id), for a host that keeps the
	 * selected program in the address. Absent, the lens owns its selection state.
	 */
	selectedId?: number | null;
	onSelectedIdChange?: (id: number | null) => void;
	/** Which corpus fills the columns — changes the empty-state's sentence, nothing else. */
	source?: "library" | "feed";
}

export default function ChannelGuideLens({
	channels,
	selectedId,
	onSelectedIdChange,
	source = "library",
}: ChannelGuideLensProps) {
	// Controlled when the host passes an id (URL-shaped guides), internal otherwise.
	const [internalSelected, setInternalSelected] = useState<number | null>(null);
	const controlled = selectedId !== undefined;
	const selected = controlled ? (selectedId ?? null) : internalSelected;
	const select = (id: number | null) => {
		if (controlled) onSelectedIdChange?.(id);
		else setInternalSelected(id);
	};

	/** Whether the current selection arrived as a play intent (click, skip) — mounts the player autoplaying. */
	const [playIntent, setPlayIntent] = useState(false);
	const [autoplay, setAutoplay] = useState(false);
	useEffect(() => {
		setAutoplay(readAutoplay());
	}, []);
	const toggleAutoplay = (on: boolean) => {
		setAutoplay(on);
		writeAutoplay(on);
	};

	const selectedEntry = useMemo(() => {
		if (selected == null) return null;
		for (const channel of channels) {
			const index = channel.programs.findIndex((p) => p.id === selected);
			if (index >= 0) return { channel, index, work: channel.programs[index] };
		}
		return null;
	}, [channels, selected]);

	/** Keep the highlighted selection visible in the rail — "see what's next" is the point. */
	const railSelectedRef = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (selectedEntry && railSelectedRef.current) {
			railSelectedRef.current.scrollIntoView({ block: "nearest" });
		}
	}, [selectedEntry, selectedEntry?.index]);

	/*
	 * The guide's rows are fixed height and every channel column shares the same row
	 * rhythm, so the blocks line up across channels the way a TV schedule does. The
	 * gutter beside them is the guide's ruler: a real guide prints times there, and
	 * this one prints the only ordinal it has — positions back from the newest.
	 */
	const rowCount = Math.max(1, ...channels.map((c) => c.programs.length));

	if (channels.length === 0) {
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<span className="mx-auto flex size-14 items-center justify-center rounded-full bg-base-200">
					<TvIcon className="size-7 text-base-content/30" />
				</span>
				<h2 className="mt-3 text-lg font-bold">No channels yet</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					{source === "feed"
						? "Follow creators and their channels fill the guide as they release."
						: "Save a video and its creator takes a channel in the guide — free work included. You don't have to buy something to keep it."}
				</p>
				<Link to="/discovery" className="btn btn-primary btn-sm mt-4">
					{source === "feed" ? "Find channels to follow" : "Find something to watch"}
				</Link>
			</div>
		);
	}

	if (selectedEntry) {
		const { channel, index, work } = selectedEntry;
		const nextUp = nextProgramIndex(index);
		const prevDown = previousProgramIndex(index, channel.programs.length);
		const nextWork = nextUp != null ? channel.programs[nextUp] : null;
		const locked = isAccessResult(work.access) && work.access.canAccess === false;
		const playable =
			!locked && (work.transcoding?.hlsManifestUrl || work.originalUrl) ? work : null;
		return (
			<div className="flex flex-col gap-4 lg:flex-row" data-testid="guide-playing">
				<div className="flex min-w-0 flex-col lg:flex-[3]">
					{playable ? (
						<VideoPlayer
							key={work.id}
							src={(work.transcoding?.hlsManifestUrl ?? work.originalUrl) as string}
							poster={work.thumbnail ?? undefined}
							autoPlay={playIntent}
							attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
							publicAccess={work.publicAccess ?? false}
							onEnded={
								autoplay && nextWork
									? () => {
											setPlayIntent(true);
											select(nextWork.id);
										}
									: undefined
							}
						/>
					) : (
						// A gated Work keeps its place in the guide — the block is the
						// schedule's fact — and the player pane becomes the route to
						// unlock, the same treatment a locked entry gets on the shelf.
						<div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-box bg-base-200">
							{work.thumbnail && (
								<img
									src={work.thumbnail}
									alt=""
									className="absolute inset-0 h-full w-full object-cover opacity-40 blur-sm"
								/>
							)}
							<div className="relative z-10 flex flex-col items-center gap-2 text-center">
								<LockClosedIcon className="size-10 text-base-content/50" />
								<p className="max-w-xs text-sm text-base-content/70">
									This one is on its creator's terms. Open the Work's page to unlock it.
								</p>
								{workUrlFor(work) && (
									<Link to={workUrlFor(work)!} className="btn btn-primary btn-sm">
										Open the Work's page
									</Link>
								)}
							</div>
						</div>
					)}
					<div className="mt-3 flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0">
							<p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
								On now
							</p>
							<h3 className="truncate text-lg font-bold leading-tight">
								{work.title || "Untitled"}
							</h3>
							<div className="mt-1 flex items-center gap-2 text-sm text-base-content/60">
								{channel.handle && <Link to={profileUrl(channel.handle)}>{channel.name}</Link>}
								{workUrlFor(work) && (
									<>
										<span aria-hidden="true">·</span>
										<Link to={workUrlFor(work)!}>Open the Work's page</Link>
									</>
								)}
							</div>
						</div>
						{/* Autoplay is a choice, not a default (Parker, 2026-10-11). */}
						<label className="flex cursor-pointer items-center gap-2 rounded-full border border-base-300 bg-base-100 px-3 py-1.5 text-xs font-medium">
							<input
								type="checkbox"
								className="toggle toggle-sm"
								checked={autoplay}
								onChange={(e) => toggleAutoplay(e.target.checked)}
							/>
							Autoplay
						</label>
					</div>
					{/* The upward language, made hard to miss: next lives above, and the
					    buttons say so in arrows before anyone learns it the hard way. */}
					<div className="mt-3 flex items-center gap-2 border-t border-base-300 pt-3">
						<button
							type="button"
							className="btn btn-sm max-w-full justify-start border-base-300 bg-base-100"
							disabled={nextUp == null}
							onClick={() => {
								if (nextWork) {
									setPlayIntent(true);
									select(nextWork.id);
								}
							}}
							data-testid="guide-next"
							title={
								nextWork
									? `Up next: ${nextWork.title || "Untitled"}`
									: "Nothing further up this channel"
							}
						>
							<ArrowUpIcon className="size-4 shrink-0" />
							<span className="truncate">
								Up next{nextWork ? `: ${nextWork.title || "Untitled"}` : ""}
							</span>
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							disabled={prevDown == null}
							onClick={() => {
								if (prevDown != null) {
									setPlayIntent(true);
									select(channel.programs[prevDown].id);
								}
							}}
						>
							<ArrowDownIcon className="size-4" /> Earlier
						</button>
					</div>
				</div>
				<aside
					className="flex min-w-0 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100 lg:w-1/4 lg:flex-none"
					aria-label={`${channel.name ?? "Channel"} — programs`}
				>
					<header className="relative flex items-center gap-2.5 border-b border-base-300 p-3">
						{/* The channel's tab, the same accent its column carries in the guide. */}
						<span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
						{channel.avatar ? (
							<img
								src={channel.avatar}
								alt=""
								className="size-9 shrink-0 rounded-lg object-cover ring-1 ring-base-300"
							/>
						) : (
							<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-base-300 text-xs font-bold">
								{(channel.name ?? "Unknown").charAt(0).toUpperCase()}
							</span>
						)}
						<span className="min-w-0 flex-1">
							<span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/45">
								{channel.programs.length} {channel.programs.length === 1 ? "program" : "programs"}
							</span>
							<span className="block truncate font-semibold leading-tight">
								{channel.name ?? "Unknown channel"}
							</span>
							{channel.handle && (
								<span className="block truncate text-[10px] text-base-content/45">
									@{channel.handle}
								</span>
							)}
						</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							aria-label="Back to the guide"
							onClick={() => select(null)}
						>
							<XMarkIcon className="size-4" />
						</button>
					</header>
					<ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
						{channel.programs.map((p, idx) => (
							<li
								key={p.id}
								ref={idx === index ? railSelectedRef : undefined}
								className={
									idx === index ? "rounded-lg bg-primary/10 ring-1 ring-primary/40" : "rounded-lg"
								}
							>
								<ProgramBlock
									work={p}
									ordinal={idx}
									current={idx === index}
									variant="rail"
									onSelect={(id) => {
										setPlayIntent(true);
										select(id);
									}}
								/>
							</li>
						))}
					</ul>
				</aside>
			</div>
		);
	}

	return (
		<section aria-label="Channel guide" className="space-y-3">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-base-300 pb-2">
				<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
					Channel Guide
				</h2>
				<p className="text-[11px] text-base-content/45">
					{channels.length} {channels.length === 1 ? "channel" : "channels"} · newest first
				</p>
			</div>
			<div className="overflow-x-auto scroll-pl-16 pb-3">
				<div className="flex w-max snap-x snap-proximity items-start gap-2">
					{/* The guide's ruler. A schedule prints times down its left edge; here the
					    only honest ordinals are ranks back from the newest, so the ruler says
					    that instead of inventing a clock. It stays put while channels scroll. */}
					<div
						aria-hidden="true"
						className="sticky left-0 z-10 flex shrink-0 flex-col gap-1.5 border-r border-base-300 bg-base-100"
					>
						<div className="h-12" />
						{Array.from({ length: rowCount }, (_, rank) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the ruler's rows are positional and never reorder, so the rank IS the identity.
							<div key={rank} className="flex h-[76px] items-center justify-end">
								<span className="pr-2 text-[10px] font-medium uppercase tracking-wider tabular-nums text-base-content/45">
									{rank === 0 ? "Latest" : `${rank} back`}
								</span>
								<span className="h-px w-1.5 bg-base-300" />
							</div>
						))}
					</div>
					<ul aria-label="Channels" className="flex w-max gap-2 pl-2" data-testid="guide-channels">
						{channels.map((channel) => (
							<li key={channel.id} className="w-60 shrink-0 snap-start" data-testid="guide-channel">
								<section className="flex flex-col gap-1.5">
									<ChannelBug channel={channel} />
									<ul className="flex flex-col gap-1.5">
										{channel.programs.map((p, idx) => (
											<li key={p.id}>
												<ProgramBlock
													work={p}
													ordinal={idx}
													current={false}
													variant="column"
													onSelect={(id) => {
														setPlayIntent(true);
														select(id);
													}}
												/>
											</li>
										))}
									</ul>
								</section>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}

/**
 * A channel's bug: the fixed identity plate at the top of its column. It is the one
 * thing in the guide that must read the same whether the column is long or short, which
 * is why its height is fixed to the ruler's spacer.
 */
function ChannelBug({ channel }: { channel: GuideChannel }) {
	return (
		<header className="relative flex h-12 items-center gap-2.5 overflow-hidden rounded-lg border border-base-300 bg-base-100 pl-2.5 pr-2 shadow-sm">
			{/* The channel's tab, repeated on the rail when this channel is tuned. */}
			<span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
			{channel.avatar ? (
				<img
					src={channel.avatar}
					alt=""
					className="size-8 shrink-0 rounded-md object-cover ring-1 ring-base-300"
				/>
			) : (
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-base-300 text-xs font-bold">
					{(channel.name ?? "Unknown").charAt(0).toUpperCase()}
				</span>
			)}
			<div className="min-w-0 flex-1">
				<h3
					className="truncate text-[13px] font-semibold leading-tight"
					title={channel.name ?? "Unknown channel"}
				>
					{channel.handle ? (
						<Link to={profileUrl(channel.handle)}>{channel.name ?? "Unknown channel"}</Link>
					) : (
						(channel.name ?? "Unknown channel")
					)}
				</h3>
				{channel.handle && (
					<p className="truncate text-[10px] leading-tight text-base-content/45">
						@{channel.handle}
					</p>
				)}
			</div>
			<span
				className="shrink-0 rounded-full bg-base-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-base-content/55"
				title={`${channel.programs.length} ${channel.programs.length === 1 ? "program" : "programs"}`}
			>
				{channel.programs.length}
			</span>
		</header>
	);
}

function workUrlFor(work: Work): string | null {
	return work.publicId != null && work.slug
		? workUrl({ slug: work.slug, publicId: work.publicId })
		: null;
}

/**
 * One programming block — the guide's widget. A row: thumbnail with the duration on it,
 * title beside, the date it arrived here beneath, and the guide's own marks (gated,
 * playing) on top. Whole thing pressed, because a block is a program you put on, not a
 * page you visit; a gated block routes to the Work's page, where its unlock path lives.
 */
function ProgramBlock({
	work,
	ordinal: _ordinal,
	current,
	variant,
	onSelect,
}: {
	work: Work;
	/** The block's position in its column, latest-first — for a future "latest plus one" label. */
	ordinal: number;
	current: boolean;
	variant: "column" | "rail";
	onSelect: (id: number) => void;
}) {
	const locked = isAccessResult(work.access) && work.access.canAccess === false;
	const to = workUrlFor(work);
	// One row rhythm across the whole guide: a column block and a rail row are the same
	// shape at two sizes, and the fixed heights are what keep the columns aligned.
	const rowClass =
		variant === "column"
			? "h-[76px] gap-2 rounded-lg border border-base-300 bg-base-100 p-1.5 shadow-sm hover:border-primary/40 hover:shadow"
			: "h-[64px] gap-2 rounded-lg border border-transparent p-1.5 hover:bg-base-200";
	const thumbClass = variant === "column" ? "w-24" : "w-20";
	const inner = (
		<span className={`flex w-full items-center text-left transition ${rowClass}`}>
			<span
				className={`relative aspect-video shrink-0 self-center overflow-hidden rounded-md bg-base-300 ${thumbClass}`}
			>
				{work.thumbnail ? (
					<img src={work.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
				) : (
					<span className="flex h-full w-full items-center justify-center">
						<TvIcon className="size-5 text-base-content/25" />
					</span>
				)}
				{variant === "column" && (
					// The affordance the guide offers on a program: you tune to it.
					<span className="absolute inset-0 hidden items-center justify-center bg-black/25 group-hover:flex">
						<span className="flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
							<PlayIcon className="ml-0.5 size-3.5" />
						</span>
					</span>
				)}
				{work.durationSeconds != null && work.durationSeconds > 0 && (
					<span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 py-px text-[9px] font-semibold tabular-nums text-white">
						{formatDuration(work.durationSeconds)}
					</span>
				)}
				{locked && (
					<span className="absolute left-0.5 top-0.5 rounded bg-black/65 p-0.5 text-white">
						<LockClosedIcon className="size-2.5" />
					</span>
				)}
			</span>
			<span className="flex min-w-0 flex-1 flex-col justify-center">
				<span className="flex items-start gap-1.5">
					<span className={`line-clamp-2 text-xs leading-snug ${current ? "font-bold" : ""}`}>
						{work.title || "Untitled"}
					</span>
					{current && <PlayingBars className="mt-0.5 shrink-0 text-primary" />}
				</span>
				<span className="mt-1 flex items-center gap-1.5 text-[10px] text-base-content/50">
					<span className="truncate tabular-nums">
						{compactDate(work.releasedAt ?? work.createdAt)}
					</span>
					{locked && (
						<span className="shrink-0 rounded bg-base-200 px-1 text-[9px] font-semibold uppercase tracking-wide text-base-content/55">
							Gated
						</span>
					)}
				</span>
			</span>
		</span>
	);

	if (locked) {
		// A gated block rides the schedule (it is the guide's fact that the creator
		// released it) but cannot be put on here — so it routes to the Work's page,
		// where the unlock path lives.
		return to ? (
			<Link
				to={to}
				className="group block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
			>
				{inner}
			</Link>
		) : (
			<span className="group block cursor-default rounded-lg">{inner}</span>
		);
	}
	return (
		<button
			type="button"
			onClick={() => onSelect(work.id)}
			data-testid={variant === "rail" ? "guide-rail-block" : "guide-block"}
			className="group block w-full cursor-pointer rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
		>
			{inner}
		</button>
	);
}
