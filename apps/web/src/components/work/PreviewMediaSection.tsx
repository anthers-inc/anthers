// SPDX-License-Identifier: Apache-2.0
/**
 * The Manage tab's preview-media editor — the screenshots and trailer a locked viewer
 * sees under the price or unlock card (Parker, 2026-10-19).
 *
 * Uploads ride `useWorkUploads`, the same module store a Work's own file and a game's
 * builds use, so progress, retry, the tab-close warning and the "upload outlives the
 * page" rule are the platform's existing behavior rather than a second mechanism. Each
 * landed file is appended to the preview set; the section then re-reads the Work, because
 * the carousel and this list are both read from `Work.previewMedia`.
 *
 * A trailer opens the same caption editor the Accessibility tab uses, pointed at the
 * preview's own endpoints. The `.vtt` parse and the replace-by-language rule are the
 * server's, unchanged.
 */

import { MAX_PREVIEW_MEDIA } from "@anthers/shared/content";
import { client } from "@anthers/web-shared/rpc";
import type { PreviewMediaItem, WorkCaptionTrack } from "@anthers/web-shared/types";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { useWorkUploads, workUploads } from "@anthers/web-shared/work-uploads";
import { useEffect, useRef, useState } from "react";
import WorkCaptionsEditor from "../../studio/WorkCaptionsEditor";
import { WORK_DETAILS_HEADING_CLASS } from "./WorkLayout";

interface PreviewMediaSectionProps {
	work: {
		id: number;
		title: string | null;
		previewMedia?: PreviewMediaItem[];
	};
	/** Re-read the Work's media payload after a landed upload or an edit. */
	onChanged?: () => void;
}

/** A 16:9 tile: the screenshot itself, or a play mark standing for the trailer. */
function PreviewThumb({ item }: { item: PreviewMediaItem }) {
	if (item.kind === "video") {
		return (
			<span className="flex h-full w-full items-center justify-center bg-base-300 text-base-content/70">
				<svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden="true">
					<path d="M8 5v14l11-7z" />
				</svg>
			</span>
		);
	}
	return <img src={item.url} alt="" className="h-full w-full object-cover" />;
}

export default function PreviewMediaSection({ work, onChanged }: PreviewMediaSectionProps) {
	const previews = work.previewMedia ?? [];
	const uploads = useWorkUploads().filter(
		(u) =>
			u.workId === work.id &&
			(u.target.kind === "preview-image" || u.target.kind === "preview-video"),
	);
	const landedSeen = useRef<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openCaptions, setOpenCaptions] = useState<number | null>(null);
	const [altDrafts, setAltDrafts] = useState<Record<number, string>>({});
	const imagesInput = useRef<HTMLInputElement>(null);
	const trailerInput = useRef<HTMLInputElement>(null);

	// Each landed upload refreshes the Work once, then leaves the store so a done line
	// does not sit there forever — the item it added is now in the list below.
	useEffect(() => {
		const landed = uploads.filter((u) => u.status === "done" && !landedSeen.current.has(u.id));
		if (landed.length === 0) return;
		for (const u of landed) landedSeen.current.add(u.id);
		for (const u of landed) workUploads.dismiss(u.id);
		onChanged?.();
	}, [uploads, onChanged]);

	const atCap = previews.length >= MAX_PREVIEW_MEDIA;

	const addImages = (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const room = MAX_PREVIEW_MEDIA - previews.length;
		const picked = [...files].slice(0, Math.max(0, room));
		for (const file of picked) workUploads.start(work.id, file, { kind: "preview-image" });
		if (imagesInput.current) imagesInput.current.value = "";
	};

	const addTrailer = (file: File | null) => {
		if (!file) return;
		// V1 plays the uploaded container directly, the same posture a video Work's
		// original has. The refusal is at attach, with a line the creator can read.
		if (!/^video\/(mp4|webm)$/.test(file.type)) {
			setError("The trailer needs to be an MP4 or WebM file.");
			return;
		}
		setError(null);
		workUploads.start(work.id, file, { kind: "preview-video" });
		if (trailerInput.current) trailerInput.current.value = "";
	};

	const saveAlt = async (item: PreviewMediaItem) => {
		const alt = altDrafts[item.id];
		if (alt == null || alt === item.alt) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].previews[":previewId"].$patch({
				param: { id: String(work.id), previewId: String(item.id) },
				json: { alt },
			});
			if (!res.ok) throw new Error("The alt text could not be saved.");
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "The alt text could not be saved.");
		} finally {
			setBusy(false);
		}
	};

	const move = async (index: number, delta: -1 | 1) => {
		const target = index + delta;
		if (target < 0 || target >= previews.length) return;
		const order = previews.map((p) => p.id);
		[order[index], order[target]] = [order[target], order[index]];
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].previews.order.$put({
				param: { id: String(work.id) },
				json: { previewIds: order },
			});
			if (!res.ok) throw new Error("The order could not be saved.");
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "The order could not be saved.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (item: PreviewMediaItem) => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].previews[":previewId"].$delete({
				param: { id: String(work.id), previewId: String(item.id) },
			});
			if (!res.ok) throw new Error("The preview item could not be removed.");
			if (openCaptions === item.id) setOpenCaptions(null);
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "The preview item could not be removed.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="flex flex-col gap-2" data-testid="preview-media-section">
			<h3 className={`${WORK_DETAILS_HEADING_CLASS} flex items-center`}>
				Preview Media
				<InfoTip text="Screenshots and a trailer shown under the price or unlock card, so someone can see the Work before buying it." />
			</h3>
			<p className="text-xs text-base-content/60">
				Shown to people who have not unlocked this Work. Up to {MAX_PREVIEW_MEDIA} images and
				trailers, in this order.
			</p>

			{previews.length > 0 && (
				<ul className="flex flex-col divide-y divide-base-300">
					{previews.map((item, index) => (
						<li
							key={item.id}
							className="flex flex-col gap-2 py-3"
							data-testid={`preview-item-${item.id}`}
						>
							<div className="flex items-start gap-3">
								<span className="block aspect-video w-24 shrink-0 overflow-hidden rounded border border-base-300 bg-base-300">
									<PreviewThumb item={item} />
								</span>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">
										{item.kind === "video" ? "Trailer" : "Screenshot"}
									</p>
									{item.kind === "image" ? (
										<input
											type="text"
											aria-label="Image description"
											className="input input-bordered input-sm mt-1 w-full"
											placeholder="What does the picture show?"
											value={altDrafts[item.id] ?? item.alt}
											onChange={(e) =>
												setAltDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
											}
											onBlur={() => void saveAlt(item)}
										/>
									) : (
										<button
											type="button"
											className="btn btn-ghost btn-xs mt-1"
											onClick={() => setOpenCaptions((open) => (open === item.id ? null : item.id))}
										>
											Captions ({item.captions?.length ?? 0})
										</button>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										aria-label="Move preview earlier"
										disabled={busy || index === 0}
										onClick={() => void move(index, -1)}
									>
										←
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										aria-label="Move preview later"
										disabled={busy || index === previews.length - 1}
										onClick={() => void move(index, 1)}
									>
										→
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs text-error"
										disabled={busy}
										onClick={() => void remove(item)}
									>
										Remove
									</button>
								</div>
							</div>
							{openCaptions === item.id && item.kind === "video" && (
								<WorkCaptionsEditor
									workId={work.id}
									previewId={item.id}
									captions={(item.captions ?? []) as WorkCaptionTrack[]}
									onChanged={onChanged}
								/>
							)}
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<input
					ref={imagesInput}
					type="file"
					accept="image/*"
					multiple
					className="hidden"
					onChange={(e) => addImages(e.target.files)}
				/>
				<button
					type="button"
					className="btn btn-sm"
					disabled={busy || atCap}
					onClick={() => imagesInput.current?.click()}
				>
					Add images
				</button>
				<input
					ref={trailerInput}
					type="file"
					accept="video/mp4,video/webm"
					className="hidden"
					onChange={(e) => addTrailer(e.target.files?.[0] ?? null)}
				/>
				<button
					type="button"
					className="btn btn-sm"
					disabled={busy || atCap}
					onClick={() => trailerInput.current?.click()}
				>
					Add trailer
				</button>
				{atCap && (
					<span className="text-xs text-base-content/60">
						That is the whole set — remove one to add another.
					</span>
				)}
			</div>

			{uploads.length > 0 && (
				<ul className="flex flex-col gap-1">
					{uploads.map((u) => (
						<li key={u.id} className="flex items-center gap-2 text-xs">
							<span className="min-w-0 flex-1 truncate">{u.fileName}</span>
							{u.status === "uploading" || u.status === "attaching" ? (
								<progress
									className="progress progress-primary w-24"
									value={u.progress ?? undefined}
									max={100}
								/>
							) : u.status === "failed" ? (
								<>
									<span className="text-error">{u.error}</span>
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => workUploads.retry(u.id)}
									>
										Retry
									</button>
								</>
							) : (
								<span className="text-success">Added</span>
							)}
						</li>
					))}
				</ul>
			)}

			{error && (
				<p role="alert" className="text-xs text-error">
					{error}
				</p>
			)}
		</section>
	);
}
