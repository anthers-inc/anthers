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
import VideoPlayer from "../media/VideoPlayer";
import type { LensItem } from "./MusicLens";
import { formatDuration } from "./VideoLens";

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

	if (channels.length === 0) {
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<TvIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">No channels yet</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					{source === "feed"
						? "Follow creators and their channels fill the guide as they release."
						: "Save a video and its creator takes a channel in the guide — free work included. You don't have to buy something to keep it."}
				</p>
				<Link to="/discover" className="btn btn-primary btn-sm mt-4">
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
					<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
						<div className="min-w-0">
							<h3 className="truncate text-lg font-bold">{work.title || "Untitled"}</h3>
							<div className="flex items-center gap-2 text-sm text-base-content/60">
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
						<label className="flex cursor-pointer items-center gap-2 text-sm">
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
					<div className="mt-3 flex items-center gap-2">
						<button
							type="button"
							className="btn btn-sm max-w-full"
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
					className="flex min-w-0 flex-col rounded-box border border-base-300 bg-base-100 lg:w-1/4 lg:flex-none"
					aria-label={`${channel.name ?? "Channel"} — programs`}
				>
					<header className="flex items-center gap-2 border-b border-base-300 p-3">
						{channel.avatar && (
							<img src={channel.avatar} alt="" className="size-8 rounded-full object-cover" />
						)}
						<span className="min-w-0 flex-1 truncate font-semibold">
							{channel.name ?? "Unknown channel"}
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
								className={idx === index ? "bg-secondary/20 ring-secondary ring-1 rounded-box" : ""}
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
		<section aria-label="Channel guide">
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Channel Guide
			</h2>
			<div className="overflow-x-auto pb-2">
				<ul aria-label="Channels" className="flex w-max gap-4" data-testid="guide-channels">
					{channels.map((channel) => (
						<li key={channel.id} className="w-60 shrink-0" data-testid="guide-channel">
							<section>
								<header className="flex items-center gap-2 px-1 pb-2">
									{channel.avatar ? (
										<img src={channel.avatar} alt="" className="size-8 rounded-full object-cover" />
									) : (
										<span className="flex size-8 items-center justify-center rounded-full bg-base-300 text-xs font-bold">
											{(channel.name ?? "Unknown").charAt(0).toUpperCase()}
										</span>
									)}
									<span
										className="min-w-0 flex-1 truncate text-sm font-semibold"
										title={channel.name ?? "Unknown channel"}
									>
										{channel.handle ? (
											<Link to={profileUrl(channel.handle)}>
												{channel.name ?? "Unknown channel"}
											</Link>
										) : (
											(channel.name ?? "Unknown channel")
										)}
									</span>
									<span className="text-xs text-base-content/50">{channel.programs.length}</span>
								</header>
								<ul className="flex flex-col gap-2">
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
		</section>
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
	const inner = (
		<span
			className={`flex gap-2 rounded-box p-1 text-left transition ${current ? "" : "hover:bg-base-200"}`}
		>
			<span className="relative aspect-video w-20 shrink-0 overflow-hidden rounded bg-base-300">
				{work.thumbnail ? (
					<img src={work.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
				) : (
					<span className="flex h-full w-full items-center justify-center">
						<TvIcon className="size-5 text-base-content/25" />
					</span>
				)}
				{work.durationSeconds != null && work.durationSeconds > 0 && (
					<span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] font-medium text-white">
						{formatDuration(work.durationSeconds)}
					</span>
				)}
			</span>
			<span className="min-w-0 flex-1">
				<span className={`line-clamp-2 text-xs leading-snug ${current ? "font-bold" : ""}`}>
					{work.title || "Untitled"}
				</span>
				<span className="mt-0.5 block text-[10px] text-base-content/50">
					{compactDate(work.releasedAt ?? work.createdAt)}
				</span>
				{locked && (
					<span className="badge badge-ghost badge-xs mt-1 gap-0.5">
						<LockClosedIcon className="size-2.5" /> Gated
					</span>
				)}
			</span>
		</span>
	);

	if (locked) {
		// A gated block rides the schedule (it is the guide's fact that the creator
		// released it) but cannot be put on here — so it routes to the Work's page,
		// where the unlock path lives.
		return to ? (
			<Link to={to} className="block rounded-box border border-base-300 bg-base-100">
				{inner}
			</Link>
		) : (
			<span className="block cursor-default rounded-box border border-base-300 bg-base-100">
				{inner}
			</span>
		);
	}
	return (
		<button
			type="button"
			onClick={() => onSelect(work.id)}
			data-testid={variant === "rail" ? "guide-rail-block" : "guide-block"}
			className="block w-full cursor-pointer rounded-box border border-base-300 bg-base-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
		>
			{inner}
		</button>
	);
}
