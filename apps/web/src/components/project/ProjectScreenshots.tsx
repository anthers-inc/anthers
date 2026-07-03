// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import type { GalleryImage } from "../../lib/types";

interface ProjectScreenshotsProps {
	images: GalleryImage[];
}

export default function ProjectScreenshots({ images }: ProjectScreenshotsProps) {
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

	const close = useCallback(() => setLightboxIndex(null), []);
	const prev = useCallback(
		() => setLightboxIndex((i) => (i !== null ? (i - 1 + images.length) % images.length : null)),
		[images.length],
	);
	const next = useCallback(
		() => setLightboxIndex((i) => (i !== null ? (i + 1) % images.length : null)),
		[images.length],
	);

	useEffect(() => {
		if (lightboxIndex === null) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			if (e.key === "ArrowLeft") prev();
			if (e.key === "ArrowRight") next();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [lightboxIndex, close, prev, next]);

	if (images.length === 0) return null;

	return (
		<div>
			<h2 className="text-xl font-bold mb-4">Gallery</h2>
			<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
				{images.map((img, i) => (
					<button
						type="button"
						key={img.id}
						onClick={() => setLightboxIndex(i)}
						className="overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
					>
						<img
							src={img.image}
							alt={img.caption || "Gallery image"}
							className="w-full h-40 object-cover hover:opacity-80 transition-opacity"
						/>
					</button>
				))}
			</div>

			{/* Lightbox */}
			{lightboxIndex !== null && (
				<div
					className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
					onClick={close}
				>
					<button
						type="button"
						className="absolute top-4 right-4 btn btn-circle btn-ghost text-white"
						onClick={close}
					>
						<XMarkIcon className="w-6 h-6" />
					</button>

					{images.length > 1 && (
						<>
							<button
								type="button"
								className="absolute left-4 btn btn-circle btn-ghost text-white"
								onClick={(e) => {
									e.stopPropagation();
									prev();
								}}
							>
								<ChevronLeftIcon className="w-6 h-6" />
							</button>
							<button
								type="button"
								className="absolute right-4 btn btn-circle btn-ghost text-white"
								onClick={(e) => {
									e.stopPropagation();
									next();
								}}
							>
								<ChevronRightIcon className="w-6 h-6" />
							</button>
						</>
					)}

					<div className="max-w-5xl max-h-[85vh] p-4" onClick={(e) => e.stopPropagation()}>
						<img
							src={images[lightboxIndex].image}
							alt={images[lightboxIndex].caption || "Gallery image"}
							className="max-w-full max-h-[80vh] object-contain mx-auto"
						/>
						{images[lightboxIndex].caption && (
							<p className="text-center text-white/70 text-sm mt-2">
								{images[lightboxIndex].caption}
							</p>
						)}
						<p className="text-center text-white/40 text-xs mt-1">
							{lightboxIndex + 1} / {images.length}
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
