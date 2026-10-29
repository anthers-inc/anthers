// SPDX-License-Identifier: Apache-2.0
/**
 * The Goods Management panel's pictures — a physical good's storefront gallery.
 *
 * ⭐ **A good's art is a gallery, not a 16:9 poster** (Parker, 2026-10-29): a creator uploads
 * square product photos, the buyer meets them as a carousel beside the variants, and the
 * first one becomes the catalog card's cover. The Work's old thumbnail field was the wrong
 * shape for the thing being sold and is no longer edited here.
 *
 * Each add, remove, reorder and description is saved immediately through `useListing`, which
 * re-reads the row first so the Manage tab's parcel facts cannot be clobbered. The pictures
 * upload before the listing save, one key per file, through the same public display-image
 * endpoint a thumbnail uses.
 */

import { keyToPreview, uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { type PhysicalImage, useListing } from "./physical-listing";
import { WORK_DETAILS_HEADING_CLASS } from "./WorkLayout";

/** The service's own ceiling; mirrored here so the picker stops at the same number. */
const MAX_IMAGES = 8;

export default function PhysicalImagesSection({ workId }: { workId: number }) {
	const { listing, loadError, save } = useListing(workId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Descriptions being typed, keyed by the image's storage key. */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const picker = useRef<HTMLInputElement | null>(null);

	if (loadError) return <p className="text-sm text-error">{loadError}</p>;
	if (!listing) return <p className="text-sm text-base-content/50">Reading the pictures…</p>;

	const images = listing.images ?? [];
	const atCap = images.length >= MAX_IMAGES;

	const add = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const room = MAX_IMAGES - images.length;
		const picked = [...files].slice(0, Math.max(0, room));
		if (picked.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const uploaded: PhysicalImage[] = [];
			for (const file of picked) {
				const { key } = await uploadImageFile(file, "thumbnail");
				uploaded.push({ key, alt: "" });
			}
			await save({ images: [...images, ...uploaded] });
		} catch (err) {
			setError(err instanceof Error ? err.message : "That picture didn't upload.");
		} finally {
			setBusy(false);
			if (picker.current) picker.current.value = "";
		}
	};

	const remove = async (index: number) => {
		setBusy(true);
		setError(null);
		try {
			await save({ images: images.filter((_, i) => i !== index) });
		} catch (err) {
			setError(err instanceof Error ? err.message : "That picture didn't come out.");
		} finally {
			setBusy(false);
		}
	};

	const move = async (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= images.length) return;
		const next = [...images];
		[next[index], next[target]] = [next[target], next[index]];
		setBusy(true);
		setError(null);
		try {
			await save({ images: next });
		} catch (err) {
			setError(err instanceof Error ? err.message : "The pictures didn't reorder.");
		} finally {
			setBusy(false);
		}
	};

	const saveAlt = async (key: string, alt: string) => {
		const current = images.find((image) => image.key === key);
		if (!current || current.alt === alt.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await save({
				images: images.map((image) => (image.key === key ? { ...image, alt: alt.trim() } : image)),
			});
			setDrafts((currentDrafts) => {
				const next = { ...currentDrafts };
				delete next[key];
				return next;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "That description didn't save.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h3 className={WORK_DETAILS_HEADING_CLASS}>Photos</h3>
					<p className="text-xs text-base-content/60">
						Square photos on a plain background read best. The first one is the cover buyers see on
						your catalog.
					</p>
				</div>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || atCap}
					onClick={() => picker.current?.click()}
				>
					{busy ? "Working…" : "Add photos"}
				</button>
			</div>
			<input
				ref={picker}
				type="file"
				accept="image/*"
				multiple
				className="hidden"
				onChange={(e) => void add(e.target.files)}
			/>

			{images.length === 0 ? (
				<button
					type="button"
					className="flex flex-col items-center gap-3 rounded-box border border-dashed border-base-content/20 p-8 text-center"
					disabled={busy}
					onClick={() => picker.current?.click()}
				>
					<PhotoIcon className="size-7 text-base-content/30" />
					<span className="text-sm text-base-content/60">
						No photos yet. This is the first thing a buyer looks at.
					</span>
				</button>
			) : (
				<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
					{images.map((image, index) => (
						<li
							key={image.key}
							className="flex min-w-0 flex-col gap-2 rounded-box border border-base-300 p-2"
						>
							<div className="relative aspect-square overflow-hidden rounded-lg bg-base-100">
								<img
									src={keyToPreview(image.key)}
									alt={image.alt || `Photo ${index + 1}`}
									className="h-full w-full object-contain"
									loading="lazy"
								/>
								{index === 0 && (
									<span className="badge badge-primary badge-sm absolute top-2 left-2">Cover</span>
								)}
							</div>
							<input
								aria-label={`Describe photo ${index + 1}`}
								className="input input-bordered input-sm w-full"
								placeholder="Describe the photo…"
								value={drafts[image.key] ?? image.alt}
								onChange={(e) =>
									setDrafts((current) => ({ ...current, [image.key]: e.target.value }))
								}
								onBlur={(e) => void saveAlt(image.key, e.target.value)}
							/>
							<div className="flex items-center justify-between gap-1">
								<div className="join">
									<button
										type="button"
										className="btn btn-ghost btn-xs join-item"
										aria-label={`Move photo ${index + 1} earlier`}
										disabled={busy || index === 0}
										onClick={() => void move(index, -1)}
									>
										←
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs join-item"
										aria-label={`Move photo ${index + 1} later`}
										disabled={busy || index === images.length - 1}
										onClick={() => void move(index, 1)}
									>
										→
									</button>
								</div>
								<button
									type="button"
									className="btn btn-ghost btn-xs text-error"
									aria-label={`Remove photo ${index + 1}`}
									disabled={busy}
									onClick={() => void remove(index)}
								>
									Remove
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{atCap && (
				<p className="text-xs text-base-content/60">
					{MAX_IMAGES} photos is the most a gallery holds.
				</p>
			)}
			{error && <p className="text-sm text-error">{error}</p>}
		</div>
	);
}
