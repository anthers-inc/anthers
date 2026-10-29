// SPDX-License-Identifier: Apache-2.0
/**
 * The pictures behind the storefront's carousel, edited in the media area itself.
 *
 * ⭐ **The carousel's own pencil opens this** (Parker, 2026-10-29): a physical good has no
 * media manager, so the picture editor takes the whole editing area while it is open and
 * returns the panel when the creator is done. The parent owns the listing and passes
 * `images` and `onChange`; this component owns only the upload, cover, description, order
 * and removal gestures, so the storefront below cannot drift from the editor above it.
 *
 * Each add, cover, remove, reorder and description is saved immediately through `onChange`.
 * The parent's save re-reads the listing row first, so the policy fields edited below the
 * price box cannot be clobbered.
 */

import { keyToPreview, uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import {
	Bars3Icon,
	PlusIcon,
	StarIcon as StarOutlineIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
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
	const [dragged, setDragged] = useState<number | null>(null);
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
				uploaded.push({ key, alt: "", cover: images.length === 0 && uploaded.length === 0 });
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
		if (!window.confirm("Remove this photo?")) return;
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

	const reorder = async (from: number, to: number) => {
		if (from === to) return;
		const next = [...images];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setBusy(true);
		setError(null);
		try {
			await onChange(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The pictures didn't reorder.");
		} finally {
			setBusy(false);
			setDragged(null);
		}
	};

	const setCover = async (key: string) => {
		setBusy(true);
		setError(null);
		try {
			await onChange(images.map((image) => ({ ...image, cover: image.key === key })));
		} catch (err) {
			setError(err instanceof Error ? err.message : "That cover didn't save.");
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
			<input
				ref={picker}
				type="file"
				accept="image/*"
				multiple
				className="hidden"
				onChange={(e) => void add(e.target.files)}
			/>

			<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
				{images.map((image, index) => (
					<li
						key={image.key}
						onDragOver={(e) => e.preventDefault()}
						onDrop={(e) => {
							e.preventDefault();
							if (dragged != null) void reorder(dragged, index);
						}}
						className="flex min-w-0 flex-col gap-2 rounded-box border border-base-300 p-2"
					>
						<div className="relative aspect-square overflow-hidden rounded-lg bg-base-100">
							<img
								src={keyToPreview(image.key)}
								alt={image.alt || `Photo ${index + 1}`}
								className="h-full w-full object-contain"
								loading="lazy"
							/>
							<button
								type="button"
								aria-label={
									image.cover
										? `Photo ${index + 1} is the cover`
										: `Set photo ${index + 1} as cover`
								}
								aria-pressed={image.cover}
								disabled={busy || image.cover}
								onClick={() => void setCover(image.key)}
								className="btn btn-circle btn-xs absolute top-2 left-2 border-0 bg-base-100/85 text-base-content/70 backdrop-blur hover:text-base-content"
							>
								{image.cover ? (
									<StarSolidIcon className="size-4 text-warning" />
								) : (
									<StarOutlineIcon className="size-4" />
								)}
							</button>
							<button
								type="button"
								draggable
								onDragStart={(e) => {
									setDragged(index);
									e.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={() => setDragged(null)}
								title="Drag to reorder"
								aria-label={`Drag photo ${index + 1} to reorder`}
								className="absolute top-2 left-1/2 -translate-x-1/2 cursor-grab rounded bg-base-100/85 p-1 text-base-content/60 backdrop-blur"
							>
								<Bars3Icon className="size-4" />
							</button>
							<button
								type="button"
								aria-label={`Remove photo ${index + 1}`}
								disabled={busy}
								onClick={() => void remove(index)}
								className="btn btn-circle btn-xs absolute top-2 right-2 border-0 bg-base-100/85 text-error backdrop-blur"
							>
								<TrashIcon className="size-4" />
							</button>
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
					</li>
				))}
				{!atCap && (
					<li>
						<button
							type="button"
							aria-label="Add photos"
							disabled={busy}
							onClick={() => picker.current?.click()}
							className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-base-content/25 bg-base-200/30 text-base-content/40 transition-colors hover:border-base-content/40 hover:text-base-content/70"
						>
							<PlusIcon className="size-8" />
						</button>
					</li>
				)}
			</ul>
			{atCap && (
				<p className="text-xs text-base-content/60">
					{MAX_IMAGES} photos is the most a gallery holds.
				</p>
			)}
			{error && <p className="text-sm text-error">{error}</p>}
		</div>
	);
}
