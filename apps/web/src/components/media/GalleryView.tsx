// SPDX-License-Identifier: Apache-2.0
/**
 * The gallery an image Work renders when its source set carries more than one picture
 * (2026-10-18): every image, stacked full-width in the order the creator arranged, and
 * the shared lightbox for looking at one closer.
 *
 * ⚠️ The images arrive as display URLs on the Work payload (`Work.gallery`), gated by the
 * same verdict that gates `sourceKey`, so this component fetches nothing and re-resolves
 * nothing: it is a viewer, not a delivery path. The single-picture Work renders the plain
 * `<img>` it always rendered and never reaches here.
 */

import { useState } from "react";
import Lightbox from "./Lightbox";

/** The gallery's one piece of authored text: the Work's alt text, or its title. */
export default function GalleryView({ images, alt }: { images: string[]; alt: string }) {
	const [open, setOpen] = useState<number | null>(null);

	return (
		<>
			<div className="flex flex-col gap-3">
				{images.map((src, i) => (
					<button
						key={src}
						type="button"
						className="focus-visible:outline-2 cursor-zoom-in"
						aria-label={`View image ${i + 1} of ${images.length}`}
						onClick={() => setOpen(i)}
					>
						<img src={src} alt={alt} loading="lazy" className="w-full rounded-lg" />
					</button>
				))}
			</div>
			<Lightbox images={images} index={open} onIndex={setOpen} alt={alt} />
		</>
	);
}
