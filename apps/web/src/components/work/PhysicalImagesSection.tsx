// SPDX-License-Identifier: Apache-2.0
/**
 * The pictures behind the storefront's carousel, edited in the media area itself.
 *
 * ⭐ **The carousel's own pencil opens this** (Parker, 2026-10-29): a physical good has no
 * media manager, so the picture editor takes the carousel's place while it is open and
 * returns it when the creator is done. The parent owns the listing and passes `images` and
 * `onChange`; this component owns only the upload, description, order and removal gestures,
 * so the storefront below cannot drift from the editor above it.
 *
 * Each add, remove, reorder and description is saved immediately through `onChange`. The
 * parent's save re-reads the listing row first, so the policy fields edited below the price
 * box cannot be clobbered.
 */

import { keyToPreview, uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import type { PhysicalImage } from "./physical-listing";

/** The service's own ceiling; mirrored here so the picker stops at the same number. */
const MAX_IMAGES = 8;

export function PhysicalImagesEditor({
	images,
	onChange,
	onDone,
}: {
	images: PhysicalImage[];
	onChange: (images: PhysicalImage[]) => Promise<void>;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Descriptions being typed, keyed by the image's storage key. */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const picker = useRef<HTMLInputElement | null>(null);

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
			await onChange([...images, ...uploaded]);
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
			await onChange(images.filter((_, i) => i !== index));
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
			await onChange(next);
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
			await onChange(
				images.map((image) => (image.key === key ? { ...image, alt: alt.trim() } : image)),
			);
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
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-semibold">Photos</h3>
				<button type="button" className="btn btn-ghost btn-xs" onClick={onDone}>
					Done
				</button>
			</div>
			<p className="text-xs text-base-content/60">
				Square photos on a plain background read best. The first one is the cover buyers see on your
				catalog.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || atCap}
					onClick={() => picker.current?.click()}
				>
					{busy ? "Working…" : "Add photos"}
				</button>
				{atCap && (
					<span className="text-xs text-base-content/60">
						{MAX_IMAGES} photos is the most a gallery holds.
					</span>
				)}
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
				<ul className="grid grid-cols-2 gap-3">
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
			{error && <p className="text-sm text-error">{error}</p>}
		</div>
	);
}
