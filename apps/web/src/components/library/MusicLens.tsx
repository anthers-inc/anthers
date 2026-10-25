// SPDX-License-Identifier: Apache-2.0
/**
 * The **music lens** — the Library, organized the way a record collection is.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea.** A filter narrows what
 * is in the grid and leaves you with the grid. A lens is a different *organizing metaphor*
 * over the same items: releases with cover art you open, tracks inside a release that
 * become a queue. The proof that scope is not the substance is that a Jellyfin-style video
 * library and an old-school channel guide would draw on the same corpus as each other and
 * be nothing alike.
 *
 * **The lens has two layers, and they are the two a person expects from a music library.**
 * The first is a grid of **releases**: a Project that holds music, or a saved music Work
 * that belongs to no Project and therefore stands as a one-track release. The second is
 * the release itself, with its cover, artist, Play and Shuffle, and its track list — the
 * same `AlbumView`, `TrackRow` and player bar the Project page already uses. Opening a
 * release does not leave the lens.
 *
 * ⚠️ **A release is what was kept, read honestly.** In the Library, a release reached
 * through saved tracks lists only the tracks that are in the Library; a release saved as a
 * Project opens whole, because the Project itself is what was kept. The `scope` prop is
 * how a future Feed lens asks the same component for every track of a Project instead.
 *
 * Customization is deliberately **presets with preset dials** (Parker, 2026-09-20): the
 * lens is a built experience over a filter the lens itself defines, and any knob it
 * exposes is a fixed control we designed rather than an arbitrary filter builder. The
 * first such dial is {@link MusicLensProps.includeSpoken} — off by default, so the lens
 * is music by default, and on it widens the same view to spoken-word audio for the
 * listener who wants one collection of everything they listen to.
 *
 * 🚨 **A dial is a lens control, and the lens invariants still hold.** Toggling it is a
 * view change, not a container change: turning include-spoken on and back off must leave
 * the Library holding exactly what it held — the toggle re-scopes what the lens *draws on*,
 * it never adds or removes anything *from* the Library.
 */
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Work, WorkRelease } from "@anthers/web-shared/types";
import { MusicalNoteIcon } from "@heroicons/react/24/outline";
import { PlayIcon } from "@heroicons/react/24/solid";
import { useEffect, useMemo, useState } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import { isPlayable, type QueueTrack } from "../../lib/music-queue";
import { trackFromWork, tracksFrom } from "../../lib/tracks";
import AlbumView from "../media/AlbumView";

/** The release metadata the Library carries for a saved Work. */
export type LensRelease = WorkRelease;

export interface LensProject extends LensRelease {
	/** Every released member, music or not. `musicCount` is the part this lens draws. */
	trackCount: number;
}

export interface LensItem {
	id: number;
	kind: "work" | "project";
	hidden: boolean;
	purchased: boolean;
	work?: Work | null;
	project?: LensProject | null;
}

export interface MusicLensProps {
	items: LensItem[];
	/**
	 * The lens's preset dial over its own filter (Parker, 2026-09-20): when on,
	 * spoken-word `audio` Works join the record collection for the listener who wants
	 * one collection of everything they listen to. Off by default — the music lens is music
	 * by default, and spoken word's home is its own lens.
	 */
	includeSpoken: boolean;
	/**
	 * Where the lens is drawing from. The Library opens a release as it was kept; the
	 * feed-shaped scopes — Discovery's network-shaped recipe and its whole-site stream —
	 * open the whole Project, because what arrived is not a kept list. Only the empty
	 * state's words and that opening rule differ.
	 */
	scope?: "library" | "feed" | "discovery";
}

/** The Work types this lens draws on, before grouping them into releases. */
export function listenedTypes(includeSpoken: boolean): ReadonlySet<string> {
	return includeSpoken ? new Set(["music", "audio"]) : new Set(["music"]);
}

/** One card in the releases layer — a Project, or a one-track Work standing alone. */
export interface MusicRelease {
	key: string;
	kind: "project" | "work";
	projectId: number | null;
	slug: string;
	title: string;
	coverImage: string | null;
	creatorId: number | null;
	creatorHandle: string | null;
	creatorDisplayName: string | null;
	/** What the card advertises: the whole Project's music, or the saved tracks it holds. */
	trackCount: number;
	/** What the whole record holds, including members this corpus never saw — the count a
	 *  feed-scoped lens advertises, because opening the release there fetches it whole. */
	wholeCount: number;
	/** True when the release itself is in the Library — a saved Project or a standalone Work. */
	wholeRelease: boolean;
	/** The saved tracks already placed under it, in Library order; a whole saved Project fetches its own. */
	tracks: QueueTrack[];
}

/**
 * Group the Library into releases, in Library order.
 *
 * A saved Project is a release while it holds music. A saved music Work joins every
 * published Project it belongs to and never appears as a loose row; a saved music Work
 * with no Project is a one-track release. Spoken-word Works stay one-track releases even
 * when a Project holds them, because a series of episodes is not a record.
 */
export function musicReleases(items: LensItem[], includeSpoken: boolean): MusicRelease[] {
	const drawOn = listenedTypes(includeSpoken);
	const byKey = new Map<string, MusicRelease>();
	const ordered: MusicRelease[] = [];

	const take = (seed: MusicRelease): MusicRelease => {
		const existing = byKey.get(seed.key);
		if (existing) return existing;
		byKey.set(seed.key, seed);
		ordered.push(seed);
		return seed;
	};

	for (const item of items) {
		if (item.kind === "project" && item.project) {
			const project = item.project;
			// A Project with no music is not a release here. A saved spoken-word Project
			// stays a series; its episodes are one-track releases under the dial instead.
			if (project.musicCount <= 0) continue;
			const trackCount = project.musicCount + (includeSpoken ? project.audioCount : 0);
			const release = take({
				key: `project:${project.id}`,
				kind: "project",
				projectId: project.id,
				slug: project.slug,
				title: project.title,
				coverImage: project.coverImage,
				creatorId: project.creatorId,
				creatorHandle: project.creatorHandle,
				creatorDisplayName: project.creatorDisplayName,
				trackCount,
				wholeCount: trackCount,
				wholeRelease: true,
				tracks: [],
			});
			// A saved Project is the whole release wherever its card first appeared, and
			// its own cover wins over a track thumbnail used as a fallback.
			release.wholeRelease = true;
			release.trackCount = trackCount;
			release.wholeCount = trackCount;
			if (project.coverImage) release.coverImage = project.coverImage;
			continue;
		}

		if (item.kind !== "work" || !item.work) continue;
		const work = item.work;
		if (!drawOn.has(work.type)) continue;

		const track = trackFromWork(work, {
			id: work.creatorId ?? null,
			handle: work.creatorHandle ?? null,
			displayName: work.creatorDisplayName ?? null,
		});

		// Only a music Work groups under a Project. The dial widens the collection to
		// episodes as one-track releases; it does not turn a series into a record.
		const memberships = work.type === "music" ? (work.releases ?? []) : [];
		if (memberships.length === 0) {
			take({
				key: `work:${work.id}`,
				kind: "work",
				projectId: null,
				slug: work.slug ?? "",
				title: work.title || "Untitled",
				coverImage: work.thumbnail || null,
				creatorId: work.creatorId ?? null,
				creatorHandle: work.creatorHandle ?? null,
				creatorDisplayName: work.creatorDisplayName ?? null,
				trackCount: 1,
				wholeCount: 1,
				wholeRelease: true,
				tracks: [track],
			});
			continue;
		}

		for (const membership of memberships) {
			if (membership.musicCount <= 0) continue;
			const release = take({
				key: `project:${membership.id}`,
				kind: "project",
				projectId: membership.id,
				slug: membership.slug,
				title: membership.title,
				coverImage: membership.coverImage,
				creatorId: membership.creatorId,
				creatorHandle: membership.creatorHandle,
				creatorDisplayName: membership.creatorDisplayName,
				trackCount: 0,
				wholeCount: membership.musicCount + (includeSpoken ? membership.audioCount : 0),
				wholeRelease: false,
				tracks: [],
			});
			if (!release.tracks.some((t) => t.workId === track.workId)) release.tracks.push(track);
			if (!release.coverImage) release.coverImage = track.thumbnail;
		}
	}

	// A release reached through saved tracks advertises exactly what it holds. A whole
	// saved Project already carries its music count and is left alone.
	for (const release of ordered) {
		if (!release.wholeRelease) release.trackCount = release.tracks.length;
	}
	return ordered;
}

/**
 * The release cards as the scope shows them. The Library opens a release as it was kept,
 * so the card counts the kept tracks; the feed-shaped scopes — Discovery's two — open it
 * whole, so the card advertises the record's own count rather than the handful of tracks
 * that arrived in the stream.
 */
export function releasesForScope(
	releases: MusicRelease[],
	scope: "library" | "feed" | "discovery",
): MusicRelease[] {
	if (scope === "library") return releases;
	return releases.map((release) =>
		release.kind === "project"
			? { ...release, trackCount: Math.max(release.trackCount, release.wholeCount) }
			: release,
	);
}

export default function MusicLens({ items, includeSpoken, scope = "library" }: MusicLensProps) {
	const player = useMediaPlayer();
	const releases = useMemo(
		() => releasesForScope(musicReleases(items, includeSpoken), scope),
		[items, includeSpoken, scope],
	);
	const drawOn = useMemo(() => listenedTypes(includeSpoken), [includeSpoken]);

	/** The release whose tracks layer is open, and the tracks it is showing. */
	const [selected, setSelected] = useState<MusicRelease | null>(null);
	const [detailTracks, setDetailTracks] = useState<QueueTrack[]>([]);
	/** The release whose Play button is waiting on a fetch. */
	const [busyKey, setBusyKey] = useState<string | null>(null);
	/** The release being opened, so its card can show the wait rather than doing nothing. */
	const [openingKey, setOpeningKey] = useState<string | null>(null);
	const [openError, setOpenError] = useState<string | null>(null);

	// A filter or dial can remove the open release from the Library. Return to the grid
	// rather than sitting on a detail for something no longer there.
	useEffect(() => {
		if (selected && !releases.some((release) => release.key === selected.key)) {
			setSelected(null);
			setDetailTracks([]);
		}
	}, [releases, selected]);

	/**
	 * Fetch a Project's tracks, as the release's whole self.
	 *
	 * The Library carries counts rather than members, so this is the one request a release
	 * needs — made when it is opened or played, never once per card on page load.
	 */
	const fetchProjectTracks = async (release: MusicRelease): Promise<QueueTrack[] | null> => {
		const res = await client.api.content.projects[":slug"].$get({
			param: { slug: release.slug },
		});
		if (!res.ok) return null;
		const { project } = (await res.json()) as unknown as {
			project: { works?: Work[] };
		};
		const works = (project.works ?? []).filter((work) => drawOn.has(work.type));
		return tracksFrom(works, {
			id: release.creatorId,
			handle: release.creatorHandle,
			displayName: release.creatorDisplayName,
		});
	};

	/** Whether opening this release means fetching its whole track list. */
	const isWholeProject = (release: MusicRelease) =>
		release.kind === "project" && (release.wholeRelease || scope !== "library");

	const openRelease = async (release: MusicRelease) => {
		setOpenError(null);
		if (!isWholeProject(release)) {
			setDetailTracks(release.tracks);
			setSelected(release);
			return;
		}

		setOpeningKey(release.key);
		try {
			const tracks = await fetchProjectTracks(release);
			if (!tracks) {
				setOpenError("This release could not be opened. Its creator may have unpublished it.");
				return;
			}
			setDetailTracks(tracks);
			setSelected(release);
		} catch {
			setOpenError("This release could not be opened. Check your connection and try again.");
		} finally {
			setOpeningKey(null);
		}
	};

	const playRelease = async (release: MusicRelease, shuffle: boolean) => {
		setOpenError(null);
		setBusyKey(release.key);
		try {
			const tracks = isWholeProject(release) ? await fetchProjectTracks(release) : release.tracks;
			if (!tracks) {
				setOpenError("This release could not be played. Its creator may have unpublished it.");
				return;
			}
			// Start from the first PLAYABLE track — pressing play on a release whose opener
			// is gated and hearing nothing is the stall the whole area exists to avoid.
			const start = tracks.findIndex(isPlayable);
			if (start < 0) {
				setOpenError("Nothing in this release can be played yet. Its tracks may be gated.");
				return;
			}
			player.playTracks(tracks, start, { shuffle });
		} catch {
			setOpenError("This release could not be played. Check your connection and try again.");
		} finally {
			setBusyKey(null);
		}
	};

	const backToReleases = () => {
		setSelected(null);
		setDetailTracks([]);
	};

	if (releases.length === 0) {
		if (scope === "discovery") {
			return (
				<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
					<MusicalNoteIcon className="mx-auto size-10 text-base-content/20" />
					<h2 className="mt-3 text-lg font-bold">
						{includeSpoken
							? "Nothing to listen to in the stream yet"
							: "No music in the stream yet"}
					</h2>
					<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
						{includeSpoken
							? "Music and spoken word arrive here as creators release it. Widen the window or clear a filter to see more."
							: "Music arrives here as creators release it. Widen the window or clear a filter to see more."}
					</p>
					<Link to="/discovery" className="btn btn-primary btn-sm mt-4">
						See everything new
					</Link>
				</div>
			);
		}
		const forNetwork = scope === "feed";
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<MusicalNoteIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">
					{forNetwork
						? includeSpoken
							? "Nothing to listen to in your feed yet"
							: "No music in your feed yet"
						: includeSpoken
							? "Nothing to listen to kept yet"
							: "No music kept yet"}
				</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					{forNetwork
						? includeSpoken
							? "Music and spoken word from the creators in your network arrive here as they release it. Follow, support, or save a creator and their work joins the feed."
							: "Music from the creators in your network arrives here as they release it. Follow, support, or save a creator and their records join the feed."
						: includeSpoken
							? "Save an album, a track or an episode and it lands here — free work included. You don't have to buy something to keep it."
							: "Save an album or a track and it lands here — free work included. You don't have to buy something to keep it."}
				</p>
				<Link to="/discovery" className="btn btn-primary btn-sm mt-4">
					{forNetwork ? "Find creators to follow" : "Find something to listen to"}
				</Link>
			</div>
		);
	}

	// The tracks layer: the release, opened where it is, with the same album view the
	// Project page uses. The back control returns to the collection rather than the page.
	if (selected) {
		// A one-track release's own artist is the Track's creator; a Project's is the
		// Project's. Either way the header says whose record this is.
		const creatorName = selected.creatorDisplayName || detailTracks[0]?.creator || "Unknown artist";
		const creatorHandle = selected.creatorHandle ?? detailTracks[0]?.creatorHandle ?? null;
		const creator = creatorHandle ? (
			<Link to={profileUrl(creatorHandle)} className="hover:text-primary hover:underline">
				{creatorName}
			</Link>
		) : (
			<span>{creatorName}</span>
		);

		return (
			<AlbumView
				title={selected.title}
				cover={
					selected.coverImage || detailTracks.find((track) => track.thumbnail)?.thumbnail || null
				}
				creator={creator}
				tracks={detailTracks}
				back={{ label: "Releases", onClick: backToReleases }}
			/>
		);
	}

	return (
		<div className="space-y-6">
			{openError && (
				<div className="alert alert-warning text-sm" role="alert">
					<span>{openError}</span>
				</div>
			)}

			<section>
				<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
					Releases
				</h2>
				<div
					className="grid gap-4"
					style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
					data-testid="release-grid"
				>
					{releases.map((release) => (
						<ReleaseCard
							key={release.key}
							release={release}
							busy={busyKey === release.key}
							opening={openingKey === release.key}
							// A release opened whole may still hold a playable track we have not
							// fetched yet; one drawn only from saved tracks can say now that none
							// of them will play.
							canPlay={isWholeProject(release) || release.tracks.some(isPlayable)}
							onOpen={() => openRelease(release)}
							onPlay={() => playRelease(release, false)}
						/>
					))}
				</div>
			</section>
		</div>
	);
}

/** One release: cover, title, artist, a play button that fades in over the art, and a way in. */
function ReleaseCard({
	release,
	busy,
	opening,
	canPlay,
	onOpen,
	onPlay,
}: {
	release: MusicRelease;
	busy: boolean;
	opening: boolean;
	canPlay: boolean;
	onOpen: () => void;
	onPlay: () => void;
}) {
	// A one-track release's artist comes from the Track when the Work carries no display
	// surface of its own; a Project's comes from the Project row.
	const artist = release.creatorDisplayName || release.tracks[0]?.creator || "Unknown artist";
	return (
		<div className="group flex flex-col gap-2" data-testid="release-card">
			<div className="relative">
				<button
					type="button"
					onClick={onOpen}
					disabled={opening}
					className="block w-full"
					aria-label={`Open ${release.title}`}
				>
					{release.coverImage ? (
						<img
							src={release.coverImage}
							alt=""
							className="aspect-square w-full rounded-lg object-cover shadow-sm transition-shadow group-hover:shadow-lg"
						/>
					) : (
						<div className="flex aspect-square w-full items-center justify-center rounded-lg bg-base-300 shadow-sm transition-shadow group-hover:shadow-lg">
							<MusicalNoteIcon className="size-8 text-base-content/20" />
						</div>
					)}
				</button>
				{opening && (
					<div className="absolute inset-0 flex items-center justify-center rounded-lg bg-base-100/60">
						<span className="loading loading-spinner" />
					</div>
				)}
				{/* Rises into place on hover, the way Garnet's grid does — the one piece of
				    motion that makes a grid of covers feel like a record crate you can reach into.
				    Absent when the release holds nothing playable, so it never appears as a
				    control that cannot answer. */}
				{canPlay && (
					<button
						type="button"
						onClick={onPlay}
						disabled={busy || opening}
						aria-label={`Play ${release.title}`}
						className="absolute bottom-2 right-2 flex size-10 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-content opacity-0 shadow-lg transition-[opacity,transform] duration-200 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 disabled:pointer-events-none"
					>
						{busy ? (
							<span className="loading loading-spinner loading-sm" />
						) : (
							<PlayIcon className="size-5" />
						)}
					</button>
				)}
			</div>
			<div className="min-w-0">
				<button
					type="button"
					onClick={onOpen}
					disabled={opening}
					className="block w-full truncate text-left text-sm font-medium leading-tight hover:text-primary"
					title={release.title}
				>
					{release.title}
				</button>
				<div className="flex items-center gap-1.5 text-xs text-base-content/55">
					{release.creatorHandle ? (
						<Link
							to={profileUrl(release.creatorHandle)}
							className="min-w-0 truncate hover:text-primary hover:underline"
						>
							{artist}
						</Link>
					) : (
						<span className="min-w-0 truncate">{artist}</span>
					)}
					<span className="shrink-0 text-base-content/35">
						· {release.trackCount} {release.trackCount === 1 ? "track" : "tracks"}
					</span>
				</div>
			</div>
		</div>
	);
}
