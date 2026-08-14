// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The **music lens** — the Library, organized the way a record collection is.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea.** A filter narrows what
 * is in the grid and leaves you with the grid. A lens is a different *organizing metaphor*
 * over the same items: albums with cover art you play from, tracks in a list that becomes
 * a queue, artists as the thing you browse by. The proof that scope is not the substance
 * is that a Jellyfin-style video library and an old-school channel guide would draw on the
 * same corpus as each other and be nothing alike.
 *
 * Instance one of the concept, so the seams matter more than the surface: everything on
 * screen here is a component the Project page already uses (`AlbumView`, `TrackRow`, the
 * player bar), which is precisely why the library work had to happen *with* the music work
 * rather than after it. A second lens is a new component, not a refactor of this one.
 *
 * Customization is deliberately **presets only** for now (Parker, 2026-08-13): one built
 * experience per lens, no user-facing arrangement. The dial between "pick a preset",
 * "rearrange one" and "compose one from parts" gets decided when there are two real lenses
 * to generalize from rather than one to argue about.
 */
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Work } from "@anthers/web-shared/types";
import { MusicalNoteIcon } from "@heroicons/react/24/outline";
import { ArrowsRightLeftIcon, PlayIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import { isPlayable, type QueueTrack } from "../../lib/music-queue";
import { trackFromWork } from "../../lib/tracks";
import TrackRow, { TRACK_GRID } from "../media/TrackRow";

export interface LensProject {
	id: number;
	slug: string;
	title: string;
	coverImage: string | null;
	creatorId: number | null;
	creatorUsername: string | null;
	creatorDisplayName: string | null;
	trackCount: number;
	isAlbum: boolean;
}

export interface LensItem {
	id: number;
	kind: "work" | "project";
	hidden: boolean;
	purchased: boolean;
	work?: Work | null;
	project?: LensProject | null;
}

export default function MusicLens({ items }: { items: LensItem[] }) {
	const player = useMediaPlayer();
	/** Which saved album is being fetched, so its play button can show it is working. */
	const [loadingAlbum, setLoadingAlbum] = useState<number | null>(null);

	const albums = items
		.map((i) => i.project)
		.filter((p): p is LensProject => p != null && p.isAlbum);

	// Saved audio Works, in shelf order. These are the "singles" — tracks kept on their
	// own, as opposed to records kept whole.
	const singles: QueueTrack[] = items
		.filter((i) => i.kind === "work" && i.work?.type === "audio")
		.map((i) =>
			trackFromWork(i.work as Work, {
				id: i.work?.creatorId ?? null,
			}),
		);

	/**
	 * Fetch an album's members and put the record on.
	 *
	 * The shelf request deliberately carries a track *count* rather than the tracks, so
	 * this is where they are actually fetched — one request, when somebody presses play,
	 * instead of one per saved album on every page load.
	 */
	const playAlbum = async (project: LensProject, shuffle: boolean) => {
		setLoadingAlbum(project.id);
		try {
			const res = await client.api.content.projects[":slug"].$get({
				param: { slug: project.slug },
			});
			if (!res.ok) return;
			const { project: full } = (await res.json()) as unknown as {
				project: { works?: Work[]; creator?: { username?: string; displayName?: string } };
			};
			const tracks = (full.works ?? [])
				.filter((w) => w.type === "audio")
				.map((w) =>
					trackFromWork(w, {
						id: project.creatorId,
						username: project.creatorUsername,
						displayName: project.creatorDisplayName,
					}),
				);
			// Start from the first PLAYABLE track — pressing play on a record whose opener
			// is gated and hearing nothing is the stall the whole area exists to avoid.
			const start = tracks.findIndex(isPlayable);
			if (start < 0) return;
			player.playTracks(tracks, start, { shuffle });
		} finally {
			setLoadingAlbum(null);
		}
	};

	const playableSingles = singles.filter(isPlayable);

	if (albums.length === 0 && singles.length === 0) {
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<MusicalNoteIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">No music kept yet</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					Save an album or a track and it lands here — free work included. You don't have to buy
					something to keep it.
				</p>
				<Link to="/discover" className="btn btn-primary btn-sm mt-4">
					Find something to listen to
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-10">
			{albums.length > 0 && (
				<section>
					<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
						Albums
					</h2>
					<div
						className="grid gap-4"
						style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
					>
						{albums.map((album) => (
							<AlbumCard
								key={album.id}
								album={album}
								busy={loadingAlbum === album.id}
								onPlay={() => playAlbum(album, false)}
							/>
						))}
					</div>
				</section>
			)}

			{singles.length > 0 && (
				<section>
					<div className="mb-3 flex items-center justify-between gap-3">
						<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
							Tracks
						</h2>
						<div className="flex items-center gap-1">
							<button
								type="button"
								className="btn btn-primary btn-xs gap-1 rounded-full px-4"
								disabled={playableSingles.length === 0}
								onClick={() => player.playTracks(singles, singles.findIndex(isPlayable))}
							>
								<PlayIcon className="size-3.5" />
								Play all
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs gap-1 rounded-full"
								disabled={playableSingles.length < 2}
								onClick={() =>
									player.playTracks(singles, singles.findIndex(isPlayable), { shuffle: true })
								}
							>
								<ArrowsRightLeftIcon className="size-3.5" />
								Shuffle
							</button>
						</div>
					</div>

					<div className="rounded-box border border-base-300 bg-base-100 p-2">
						<div
							className={`${TRACK_GRID} px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/40`}
						>
							<span className="text-center">#</span>
							<span>Title</span>
							<span />
							<span className="text-right">Time</span>
						</div>
						<div className="h-px bg-base-300" />
						<ul className="mt-1">
							{singles.map((track, i) => {
								const isCurrent = player.currentTrack?.workId === track.workId;
								return (
									<li key={track.workId}>
										<TrackRow
											track={track}
											index={i}
											isCurrent={isCurrent}
											isPlaying={isCurrent && player.isPlaying}
											// The whole shelf becomes the queue, positioned on what was
											// clicked — so playing the fourth track still plays the rest.
											onPlay={() => player.playTracks(singles, i)}
										/>
									</li>
								);
							})}
						</ul>
					</div>
				</section>
			)}
		</div>
	);
}

/** One saved record: cover, title, artist, and a play button that fades in over the art. */
function AlbumCard({
	album,
	busy,
	onPlay,
}: {
	album: LensProject;
	busy: boolean;
	onPlay: () => void;
}) {
	return (
		<div className="group flex flex-col gap-2">
			<div className="relative">
				<Link to={`/projects/${album.slug}`} className="block w-full" title={album.title}>
					{album.coverImage ? (
						<img
							src={album.coverImage}
							alt=""
							className="aspect-square w-full rounded-lg object-cover shadow-sm transition-shadow group-hover:shadow-lg"
						/>
					) : (
						<div className="flex aspect-square w-full items-center justify-center rounded-lg bg-base-300 shadow-sm transition-shadow group-hover:shadow-lg">
							<MusicalNoteIcon className="size-8 text-base-content/20" />
						</div>
					)}
				</Link>
				{/* Rises into place on hover, the way Garnet's grid does — the one piece of
				    motion that makes a grid of covers feel like a shelf you can reach into. */}
				<button
					type="button"
					onClick={onPlay}
					disabled={busy}
					aria-label={`Play ${album.title}`}
					className="absolute bottom-2 right-2 flex size-10 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-content opacity-0 shadow-lg transition-[opacity,transform] duration-200 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100"
				>
					{busy ? (
						<span className="loading loading-spinner loading-sm" />
					) : (
						<PlayIcon className="size-5" />
					)}
				</button>
			</div>
			<div className="min-w-0">
				<Link
					to={`/projects/${album.slug}`}
					className="block truncate text-sm font-medium leading-tight link-hover"
				>
					{album.title}
				</Link>
				<div className="flex items-center gap-1.5 text-xs text-base-content/55">
					{album.creatorUsername ? (
						<Link
							to={`/${album.creatorUsername}`}
							className="min-w-0 truncate hover:text-primary hover:underline"
						>
							{album.creatorDisplayName || album.creatorUsername}
						</Link>
					) : (
						<span className="min-w-0 truncate">Unknown artist</span>
					)}
					<span className="shrink-0 text-base-content/35">
						· {album.trackCount} {album.trackCount === 1 ? "track" : "tracks"}
					</span>
				</div>
			</div>
		</div>
	);
}

/** Link out of the lens to a single track's page — used by the empty state's copy. */
export function trackHref(track: QueueTrack): string {
	return workUrl({ slug: track.slug, publicId: track.publicId });
}
