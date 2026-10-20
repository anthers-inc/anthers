// SPDX-License-Identifier: Apache-2.0
/**
 * The locked Work's storefront carousel — the Steam and Vimeo On Demand shape (Parker,
 * 2026-10-19). Slide 0 is the existing locked composition, passed in as an element so the
 * no-preview page and this one render the same component; every later slide is a
 * screenshot or a trailer the creator added.
 *
 * The strip is the direct-pick row and the side chevrons are its pointer equivalent. Both
 * clamp at the ends rather than wrapping: the first tile is the price card, and a right
 * chevron from the last preview jumping back to the card would read as a new page rather
 * than a step back.
 *
 * 🚨 **This is composition chrome, not a page state.** Selecting a preview changes no URL,
 * and with no preview set the caller never mounts this at all.
 */

import type { PreviewMediaItem, WorkCaptionTrack } from "@anthers/web-shared/types";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useCallback, useState } from "react";
import Lightbox from "../media/Lightbox";
import WorkMediaFrame from "./WorkMediaFrame";

function PlayMark() {
	return (
		<span className="pointer-events-none absolute inset-0 flex items-center justify-center">
			<span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white">
				<svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4 fill-current" aria-hidden="true">
					<path d="M8 5v14l11-7z" />
				</svg>
			</span>
		</span>
	);
}

export default function PreviewCarousel({
	workTitle,
	thumbnail,
	previews,
	slideZero,
	slideZeroFill,
}: {
	workTitle: string | null;
	thumbnail: string | null;
	previews: PreviewMediaItem[];
	/** The locked composition, rendered exactly as the no-preview page renders it. */
	slideZero: ReactNode;
	/** The composition's mount shape — a video's gate fills the stage, every other kind composes in it. */
	slideZeroFill: boolean;
}) {
	const [active, setActive] = useState(0);
	const [lightbox, setLightbox] = useState<number | null>(null);

	const images = previews.filter((p) => p.kind === "image");
	const activeItem = active > 0 ? previews[active - 1] : null;

	const go = useCallback(
		(delta: -1 | 1) => {
			setActive((current) => {
				const next = current + delta;
				return next < 0 || next > previews.length ? current : next;
			});
		},
		[previews.length],
	);

	const openLightbox = (item: PreviewMediaItem) => {
		const index = images.findIndex((p) => p.id === item.id);
		if (index >= 0) setLightbox(index);
	};

	// The first English captions track is the default when one exists; nothing is forced
	// when none does. `<track default>` is what the native CC menu opens on.
	const defaultTrackId = (() => {
		const captions = (activeItem?.captions ?? []).filter(
			(t: WorkCaptionTrack) => t.kind === "captions",
		);
		return (
			captions.find((t: WorkCaptionTrack) => t.language.toLowerCase().startsWith("en"))?.id ??
			captions[0]?.id ??
			null
		);
	})();

	return (
		// A fieldset rather than a div: the carousel is a group of controls, which is what
		// the element is for, and it carries the keyboard handler without making a static
		// element interactive.
		<fieldset
			aria-label="Preview media"
			className="relative m-0 min-w-0 border-0 p-0"
			onKeyDown={(e) => {
				// The video's own controls own the arrow keys while it has focus.
				if ((e.target as HTMLElement).closest("video, input, textarea, select")) return;
				if (e.key === "ArrowLeft") {
					e.preventDefault();
					go(-1);
				} else if (e.key === "ArrowRight") {
					e.preventDefault();
					go(1);
				}
			}}
		>
			<div className="relative">
				<WorkMediaFrame fill={active === 0 ? slideZeroFill : true}>
					{active === 0 ? (
						slideZero
					) : activeItem?.kind === "video" ? (
						// V1 plays the uploaded container directly, the same posture a video
						// Work's original has. `playsInline` keeps a phone from going fullscreen
						// under the viewer.
						// biome-ignore lint/a11y/useMediaCaption: captions are the creator's to attach, and a trailer may legitimately have none yet.
						<video
							key={activeItem.id}
							controls
							playsInline
							preload="metadata"
							className="h-full w-full bg-black object-contain"
							onError={() => setActive(0)}
						>
							<source src={activeItem.url} />
							{(activeItem.captions ?? []).map((t) => (
								<track
									key={t.id}
									kind={t.kind}
									src={t.url}
									srcLang={t.language}
									label={t.label}
									default={t.id === defaultTrackId}
								/>
							))}
						</video>
					) : activeItem ? (
						<button
							type="button"
							className="flex h-full w-full cursor-zoom-in items-center justify-center"
							onClick={() => openLightbox(activeItem)}
							aria-label="Open this screenshot full size"
						>
							<img
								src={activeItem.url}
								alt={activeItem.alt || workTitle || "Preview screenshot"}
								className="h-full w-full object-contain"
								onError={() => setActive(0)}
							/>
						</button>
					) : null}
				</WorkMediaFrame>

				{/* The stage's own left and right edges — one step per click, disabled at the ends. */}
				<button
					type="button"
					className="btn btn-circle btn-sm absolute top-1/2 left-3 z-20 -translate-y-1/2 border-base-300 bg-base-100/85 shadow-md sm:left-4"
					aria-label="Previous preview"
					disabled={active === 0}
					onClick={() => go(-1)}
				>
					<ChevronLeftIcon className="h-5 w-5" />
				</button>
				<button
					type="button"
					className="btn btn-circle btn-sm absolute top-1/2 right-3 z-20 -translate-y-1/2 border-base-300 bg-base-100/85 shadow-md sm:right-4"
					aria-label="Next preview"
					disabled={active === previews.length}
					onClick={() => go(1)}
				>
					<ChevronRightIcon className="h-5 w-5" />
				</button>
			</div>

			{/* The thumbnail strip sits under the stage, the Steam shape: the first tile is
			    the lock-and-price composition, so it is always one click back. */}
			<div className="mt-2 flex gap-2 overflow-x-auto">
				<button
					type="button"
					aria-label="The locked Work"
					aria-pressed={active === 0}
					className={`relative block aspect-video h-12 w-20 shrink-0 overflow-hidden rounded border-2 ${
						active === 0 ? "border-primary" : "border-base-300"
					}`}
					onClick={() => setActive(0)}
				>
					{thumbnail ? (
						<img src={thumbnail} alt="" className="h-full w-full object-cover blur-[2px]" />
					) : (
						<div className="h-full w-full bg-gradient-to-br from-base-300 to-base-200" />
					)}
					<span className="absolute inset-0 flex items-center justify-center text-base-content/60">
						<svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
							<path d="M12 1a5 5 0 0 0-5 5v3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a5 5 0 0 0-5-5Zm3 8H9V6a3 3 0 1 1 6 0v3Z" />
						</svg>
					</span>
				</button>
				{previews.map((item, index) => (
					<button
						key={item.id}
						type="button"
						aria-label={`Preview ${index + 1}: ${item.kind === "video" ? "trailer" : "screenshot"}`}
						aria-pressed={active === index + 1}
						className={`relative block aspect-video h-12 w-20 shrink-0 overflow-hidden rounded border-2 ${
							active === index + 1 ? "border-primary" : "border-base-300"
						}`}
						onClick={() => setActive(index + 1)}
					>
						{item.kind === "image" ? (
							<img src={item.url} alt="" className="h-full w-full object-cover" />
						) : (
							<span className="block h-full w-full bg-base-300">
								<PlayMark />
							</span>
						)}
					</button>
				))}
			</div>

			<p role="status" className="sr-only">
				{active === 0
					? "Showing the locked Work."
					: `Showing preview ${active} of ${previews.length}.`}
			</p>

			<Lightbox
				images={images.map((p) => p.url)}
				alts={images.map((p) => p.alt || workTitle || "Preview screenshot")}
				index={lightbox}
				onIndex={setLightbox}
				alt={previews.find((p) => p.kind === "image")?.alt || workTitle || "Preview screenshot"}
			/>
		</fieldset>
	);
}
