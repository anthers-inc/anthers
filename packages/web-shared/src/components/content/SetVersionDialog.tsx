// SPDX-License-Identifier: Apache-2.0
/**
 * "Add a New Version…" for a set-kind Work — a comic, a book or an image gallery.
 *
 * 🚨 **A released Work's set does not change in place.** Append, reorder and remove edit the
 * version a reader is looking at, so the server refuses them once the Work is released. A new
 * version is a whole new set: the current one becomes a version in the Work's history, the
 * new set's pages are rendered in its place, and only the current version keeps those
 * rendered pages. The dialog is where the creator agrees to that trade before picking.
 *
 * The pick rides the same upload store as an append, with `replace` set on its target, so a
 * multi-file pick keeps its per-file progress, its cancel, and one request at the end.
 */
import { useRef, useState } from "react";
import type { Work } from "../../lib/types";
import { type WorkUploadSetRowTarget, workUploads } from "../../lib/work-uploads";
import MultipleFileInput from "./MultipleFileInput";
import type { FileWorkType } from "./work-media";

export default function SetVersionDialog({
	work,
	accept,
	label,
	noun,
}: {
	work: Work;
	/** What the picker takes, per kind: page images, or any image. */
	accept: string;
	/** The picker's line — the act it performs, named for the kind. */
	label: string;
	/** What is being replaced, in the copy: "set of pages", "gallery". */
	noun: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [picked, setPicked] = useState<File[]>([]);

	const close = () => {
		setPicked([]);
		dialog.current?.close();
	};

	const start = () => {
		if (picked.length === 0) return;
		const target: WorkUploadSetRowTarget = {
			kind: "set-row",
			type: work.type as FileWorkType,
			replace: true,
		};
		workUploads.startBatch(work.id, picked, target);
		close();
	};

	return (
		<>
			<button
				type="button"
				className="btn btn-outline btn-sm self-start"
				onClick={() => dialog.current?.showModal()}
			>
				Add a New Version…
			</button>
			<dialog ref={dialog} className="modal">
				<div className="modal-box">
					<h3 className="text-lg font-semibold">Add a New Version</h3>
					<p className="mt-1 text-sm text-base-content/70">
						The current {noun} becomes a version in this Work's history, and the new one is rendered
						in its place. Only the current version keeps its rendered copies.
					</p>
					<div className="mt-4">
						<MultipleFileInput
							accept={accept}
							label={label}
							onFiles={(files) => setPicked(files)}
						/>
						{picked.length > 0 && (
							<p className="mt-2 text-sm text-base-content/70" role="status">
								{picked.length === 1
									? "1 file picked."
									: `${picked.length} files picked, in order.`}
							</p>
						)}
					</div>
					<div className="modal-action">
						<button type="button" className="btn btn-ghost btn-sm" onClick={close}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							disabled={picked.length === 0}
							onClick={start}
						>
							Add Version
						</button>
					</div>
				</div>
				<form method="dialog" className="modal-backdrop">
					<button type="button" onClick={close}>
						close
					</button>
				</form>
			</dialog>
		</>
	);
}
