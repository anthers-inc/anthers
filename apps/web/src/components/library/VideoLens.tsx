// SPDX-License-Identifier: Apache-2.0
/**
 * The **video lens** — the Library, organized the way a watchable collection is.
 *
 * 🚨 **This is not a filter, and the difference is the whole idea.** A filter narrows what
 * is in the grid and leaves you with the grid. A lens is a different *organizing metaphor*
 * over the same items: here, saved video Works as a watchlist — cover-forward, duration on
 * the spine, a "Watch" affordance on every card rather than a link out. The proof that
 * scope is not the substance is that the media-type tab of the same name narrows on the
 * same corpus and is nothing alike: the tab answers *"what video have I saved?"* and this
 * answers *"what can I put on?"*.
 *
 * Instance two of the concept (after the music lens), and built against it as precedent:
 * everything on screen is read from the same `LensItem[]` the shelf carries, never a fresh
 * fetch — which is what keeps "a lens is a view, never a container" true rather than
 * stated, and why a paid-for entry can never drop out from under a viewer who flips views.
 *
 * Customization follows the preset-dials model (Parker, 2026-09-20): this lens ships the
 * built experience and may grow fixed controls we design over its filter, never an
 * arbitrary filter builder.
 */
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { PlayIcon, VideoCameraIcon } from "@heroicons/react/24/solid";
import type { LensItem } from "./MusicLens";

/** One saved video, rendered as something you put on rather than a tile you click. */
function formatDuration(seconds: number | null | undefined): string | null {
	if (seconds == null || seconds <= 0) return null;
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rem = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
	return `${m}:${String(rem).padStart(2, "0")}`;
}

export default function VideoLens({ items }: { items: LensItem[] }) {
	// Saved video Works, in shelf order. A saved Project of videos would be a series —
	// not built yet; when it lands it gets the same treatment albums got in the music
	// lens — but today a series of videos is saved as its members, so the lens reads
	// works only rather than guessing at a container it cannot yet see.
	const videos = items.filter((i) => i.kind === "work" && i.work?.type === "video");

	if (videos.length === 0) {
		return (
			<div className="rounded-box border border-base-300 bg-base-100 px-6 py-14 text-center">
				<VideoCameraIcon className="mx-auto size-10 text-base-content/20" />
				<h2 className="mt-3 text-lg font-bold">Nothing to watch kept yet</h2>
				<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
					Save a video and it lands here — free work included. You don't have to buy something to
					keep it.
				</p>
				<Link to="/discover" className="btn btn-primary btn-sm mt-4">
					Find something to watch
				</Link>
			</div>
		);
	}

	return (
		<section>
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Watchlist
			</h2>
			<ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{videos.map((item) => {
					const work = item.work;
					if (!work) return null;
					const to =
						work.publicId != null ? workUrl({ slug: work.slug, publicId: work.publicId }) : null;
					const duration = formatDuration(work.durationSeconds);
					const locked = work.access?.canAccess === false;
					return (
						<li key={item.id}>
							<div className="group card bg-base-100 shadow-sm transition-shadow hover:shadow-md">
								{to ? (
									<Link to={to} className="relative block">
										<figure className="relative aspect-video w-full overflow-hidden rounded-t-box bg-base-300">
											{work.thumbnail ? (
												<img src={work.thumbnail} alt="" className="h-full w-full object-cover" />
											) : (
												<div className="flex h-full w-full items-center justify-center">
													<VideoCameraIcon className="size-10 text-base-content/20" />
												</div>
											)}
											{duration && (
												<span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
													{duration}
												</span>
											)}
											{/* The affordance this lens exists for: a tile you click is the shelf's
											    move; here the card offers to be *put on*. */}
											<span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
												<span className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-content shadow-lg">
													<PlayIcon className="size-7 translate-x-0.5" />
												</span>
											</span>
										</figure>
									</Link>
								) : (
									<figure className="relative aspect-video w-full overflow-hidden rounded-t-box bg-base-300">
										<div className="flex h-full w-full items-center justify-center">
											<VideoCameraIcon className="size-10 text-base-content/20" />
										</div>
									</figure>
								)}
								<div className="card-body gap-1 p-4">
									<h3 className="card-title text-base leading-snug">
										{to ? (
											<Link to={to}>{work.title || "Untitled"}</Link>
										) : (
											work.title || "Untitled"
										)}
									</h3>
									<div className="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
										{item.purchased && <span className="badge badge-xs badge-soft">Purchased</span>}
										{locked && <span className="badge badge-xs badge-ghost">Gated</span>}
									</div>
								</div>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
