// SPDX-License-Identifier: Apache-2.0
/**
 * The framing dialog: choose what part of an image fills its frame, by pausing it anywhere
 * and zooming within it.
 *
 * ⭐ **This is the only place a display image is cropped, and it never crops the file it was
 * given.** The caller passes a source URL — a file the creator just chose, or the full upload
 * behind an existing image — and receives the window the creator chose. The save uploads that
 * window as a derivative and keeps the source, so opening this again starts from the whole
 * picture.
 *
 * ⚠️ **The stage is a real control, not a picture with handlers.** It is focusable, arrow keys
 * pan and `+`/`-` zoom, and the zoom slider carries the same value for anyone who cannot use a
 * wheel. The crop math lives in `framing.ts` and is tested there.
 */

import {
	IMAGE_FRAME_SPECS,
	type ImageCrop,
	type ImageFrameType,
} from "@anthers/shared/image-frame";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type FrameView,
	imageBox,
	initialView,
	MAX_FRAME_ZOOM,
	panView,
	viewCrop,
	viewFromCrop,
	zoomView,
} from "./framing";
import Modal from "./Modal";

export default function ImageFrameModal({
	open,
	src,
	mediaType,
	busy = false,
	error,
	initialCrop,
	onCancel,
	onSave,
}: {
	open: boolean;
	src: string | null;
	mediaType: ImageFrameType;
	busy?: boolean;
	error?: string | null;
	/** The crop the image is already shown at, so a reposition reopens there. */
	initialCrop?: ImageCrop | null;
	onCancel: () => void;
	/** The chosen window, in fractions of the source; the caller uploads it. */
	onSave: (crop: ImageCrop) => void;
}) {
	const spec = IMAGE_FRAME_SPECS[mediaType];
	const aspect = spec.width / spec.height;
	const stageRef = useRef<HTMLButtonElement>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [view, setView] = useState<FrameView>(initialView);
	const [dragging, setDragging] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const lastPoint = useRef<{ x: number; y: number } | null>(null);
	/** Which source the loaded dimensions belong to, so a reopen does not wait on a new load. */
	const loadedSrc = useRef<string | null>(null);

	// A new source is a new picture: the stage clears and the view starts over. A reopen of the
	// same picture starts at its saved crop, so a reposition adjusts the composition in place.
	useEffect(() => {
		if (!open) return;
		setLoadError(null);
		if (!src) {
			setNatural(null);
			return;
		}
		if (loadedSrc.current !== src) {
			setNatural(null);
			setView(initialView());
			return;
		}
		if (natural) {
			setView(
				initialCrop
					? viewFromCrop(natural.width, natural.height, aspect, initialCrop)
					: initialView(),
			);
		}
	}, [aspect, initialCrop, natural, open, src]);

	const stageRatio = useCallback(() => {
		const rect = stageRef.current?.getBoundingClientRect();
		return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
	}, []);

	const nudge = useCallback(
		(deltaX: number, deltaY: number) => {
			if (!src) return;
			const stage = stageRatio();
			setView((current) =>
				natural
					? panView({
							imageWidth: natural.width,
							imageHeight: natural.height,
							aspect,
							view: current,
							deltaX,
							deltaY,
							stageWidth: stage.width,
							stageHeight: stage.height,
						})
					: current,
			);
		},
		[aspect, natural, src, stageRatio],
	);

	const zoomTo = useCallback(
		(next: number, anchor?: { x: number; y: number }) => {
			if (!src) return;
			setView((current) =>
				natural
					? zoomView({
							imageWidth: natural.width,
							imageHeight: natural.height,
							aspect,
							view: current,
							zoom: next,
							anchor,
						})
					: current,
			);
		},
		[aspect, natural, src],
	);

	// The wheel is a native listener so it can refuse to scroll the page behind the dialog;
	// React's own wheel handler is passive in the browser this app ships against.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || !natural) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = stage.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;
			const anchor = {
				x: (event.clientX - rect.left) / rect.width,
				y: (event.clientY - rect.top) / rect.height,
			};
			setView((current) =>
				zoomView({
					imageWidth: natural.width,
					imageHeight: natural.height,
					aspect,
					view: current,
					zoom: current.zoom * Math.exp(-event.deltaY * 0.0015),
					anchor,
				}),
			);
		};
		stage.addEventListener("wheel", onWheel, { passive: false });
		return () => stage.removeEventListener("wheel", onWheel);
	}, [aspect, natural]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [busy, onCancel, open]);

	const box = natural ? imageBox(natural.width, natural.height, aspect, view) : null;
	const ready = natural !== null && !loadError;
	const stageWidth = `min(100%, ${(52 * aspect).toFixed(2)}vh)`;

	return (
		<Modal open={open}>
			<div className="modal-box max-w-3xl">
				<h3 className="text-lg font-semibold">Position the {spec.noun}</h3>
				<p className="mt-1 text-xs text-base-content/60">
					Drag the image to choose what shows. Scroll or use the slider to zoom.
				</p>

				<div className="mt-4">
					<button
						ref={stageRef}
						type="button"
						// The stage is a real button so the keyboard can reach it; arrows and
						// +/- are handled below, and clicking it does nothing on its own.
						aria-label={`Frame the ${spec.noun}`}
						className={`relative mx-auto block touch-none overflow-hidden rounded-lg border border-base-300 bg-base-300 outline-none focus-visible:ring-2 focus-visible:ring-primary ${
							dragging ? "cursor-grabbing" : ready ? "cursor-grab" : "cursor-default"
						}`}
						style={{ width: stageWidth, aspectRatio: String(aspect) }}
						onPointerDown={(event) => {
							if (!ready) return;
							event.currentTarget.setPointerCapture(event.pointerId);
							lastPoint.current = { x: event.clientX, y: event.clientY };
							setDragging(true);
						}}
						onPointerMove={(event) => {
							if (!dragging || !lastPoint.current) return;
							const dx = event.clientX - lastPoint.current.x;
							const dy = event.clientY - lastPoint.current.y;
							lastPoint.current = { x: event.clientX, y: event.clientY };
							nudge(dx, dy);
						}}
						onPointerUp={() => {
							lastPoint.current = null;
							setDragging(false);
						}}
						onPointerCancel={() => {
							lastPoint.current = null;
							setDragging(false);
						}}
						onKeyDown={(event) => {
							if (!ready) return;
							const step = Math.max(8, stageRatio().width * 0.02);
							if (event.key === "ArrowLeft") nudge(-step, 0);
							else if (event.key === "ArrowRight") nudge(step, 0);
							else if (event.key === "ArrowUp") nudge(0, -step);
							else if (event.key === "ArrowDown") nudge(0, step);
							else if (event.key === "+" || event.key === "=") zoomTo(view.zoom * 1.1);
							else if (event.key === "-" || event.key === "_") zoomTo(view.zoom / 1.1);
							else return;
							event.preventDefault();
						}}
					>
						{src && !loadError && (
							<img
								src={src}
								alt=""
								draggable={false}
								onLoad={(event) => {
									const image = event.currentTarget;
									if (!image.naturalWidth || !image.naturalHeight) {
										setLoadError("That image couldn't be read. Try another file.");
										return;
									}
									setNatural({ width: image.naturalWidth, height: image.naturalHeight });
									loadedSrc.current = src;
								}}
								onError={() => setLoadError("That image couldn't be read. Try another file.")}
								className="pointer-events-none absolute select-none"
								style={
									box
										? {
												width: `${box.width}%`,
												height: `${box.height}%`,
												left: `${box.left}%`,
												top: `${box.top}%`,
												maxWidth: "none",
											}
										: { visibility: "hidden" }
								}
							/>
						)}
						{open && !ready && (
							<span className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-base-content/50">
								{loadError ?? "Loading the image…"}
							</span>
						)}
					</button>
				</div>

				<div className="mt-4 flex items-center gap-3">
					<label className="flex flex-1 items-center gap-2 text-xs text-base-content/60">
						<span className="shrink-0">Zoom</span>
						<input
							type="range"
							min={1}
							max={MAX_FRAME_ZOOM}
							step={0.01}
							value={view.zoom}
							disabled={!ready || busy}
							aria-label="Zoom"
							className="range range-xs range-primary flex-1"
							onChange={(event) => zoomTo(Number(event.target.value))}
						/>
						<span className="w-10 shrink-0 text-right tabular-nums">
							{Math.round(view.zoom * 100)}%
						</span>
					</label>
					<button
						type="button"
						className="btn btn-ghost btn-sm gap-1"
						disabled={!ready || busy || view.zoom === 1}
						onClick={() => setView(initialView())}
					>
						<ArrowPathIcon className="h-4 w-4" />
						Reset
					</button>
				</div>

				{error && <p className="mt-3 text-xs text-error">{error}</p>}

				<div className="modal-action">
					<button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-primary btn-sm"
						disabled={!ready || busy}
						onClick={() => {
							if (!natural) return;
							onSave(viewCrop(natural.width, natural.height, aspect, view));
						}}
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
