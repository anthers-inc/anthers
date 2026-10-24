// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of an image Work — the gallery the Work displays, as the creator
 * arranges it (2026-10-18). The paged set editor's sibling: the same routes under it
 * (`GET`/`POST`/order-PATCH/DELETE over `work_source_files`), the same first-file rail —
 * the Upload page's pick attaches as the set's first row — the same `set-row` pick through
 * `work-uploads` for every picture after it (2026-10-19), and the same refusal to press a
 * second button while a save runs. What differs: each row previews the picture it holds,
 * the first row is the cover the Work's listings show, nothing re-renders after a
 * mutation because the files are the deliverable rather than a book's ingredients, and a
 * picture's own upload rides one direct request, so its bar is indeterminate rather than a
 * percent.
 */

import { useCallback, useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import type { WorkSourceFile } from "../../lib/work-sources";
import {
	useSetRowBatch,
	useSourceUpload,
	useWorkUploads,
	type WorkUpload,
	workUploads,
} from "../../lib/work-uploads";
import FormField from "../ui/FormField";
import MultipleFileInput from "./MultipleFileInput";
import SetVersionDialog from "./SetVersionDialog";
import { humanBytes, SourceSetAdds } from "./SourceSetAdds";
import { UploadProgress } from "./work-media";

/** A row's label: its stored filename, or — for the first file, which arrives attached by
 * the legacy `source_key` rail that carries no name — the name of the upload this tab
 * started, if the tab still holds it. Beyond that, "Image N" says the truth (the picture
 * is in the set) without inventing a name. */
function rowLabel(row: WorkSourceFile, index: number, upload: WorkUpload | null): string {
	if (row.filename) return row.filename;
	if (index === 0 && upload?.fileName) return upload.fileName;
	return `Image ${index + 1}`;
}

export function ImageSourceFiles({ work }: { work: Work }) {
	const upload = useSourceUpload(work.id);
	const adding = useSetRowBatch(work.id);
	const [rows, setRows] = useState<WorkSourceFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// A released gallery is the version its readers have; the only act is a whole new one.
	const released = work.visibility === "released";

	const reload = useCallback(async () => {
		const res = await client.api.content.works[":id"]["source-files"].$get({
			param: { id: String(work.id) },
		});
		if (!res.ok) {
			setError("Couldn't load this Work's pictures.");
			return;
		}
		const { files } = (await res.json()) as { files: WorkSourceFile[] };
		setRows(files);
	}, [work.id]);

	// Reload when an in-flight first upload lands: the store's attach is what created the
	// set's first row (the server syncs the legacy source_key into it), and `done` is the
	// one moment this component could not have seen it at mount.
	useEffect(() => {
		void reload();
	}, [reload]);

	useEffect(() => {
		if (upload?.status === "done") void reload();
	}, [upload?.status, reload]);

	// A picture landing is a row the server wrote — the pick attaches once, at its end — so the
	// gallery re-reads when that append settles.
	const landed = useWorkUploads().filter(
		(u) => u.workId === work.id && u.target.kind === "set-row" && u.status === "done",
	).length;
	useEffect(() => {
		if (landed > 0) void reload();
	}, [landed, reload]);

	/**
	 * Add one or many picked pictures. The pick goes to the upload store, which runs it one
	 * file at a time, so each carries its own name and cancel and the rest survive leaving
	 * the page. An image is one direct request, so its bar is indeterminate — the honest
	 * shape, since that request reports no percent.
	 */
	const addFiles = (picked: File[]) => {
		if (picked.length === 0 || busy || adding) return;
		setError(null);
		workUploads.startBatch(work.id, picked, { kind: "set-row", type: "image" });
	};

	const remove = async (id: number) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"]["source-files"][":fileId"].$delete({
				param: { id: String(work.id), fileId: String(id) },
			});
			if (!res.ok) setError("Couldn't remove that picture.");
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const move = async (id: number, delta: -1 | 1) => {
		if (!rows || busy) return;
		const i = rows.findIndex((row) => row.id === id);
		const j = i + delta;
		if (i < 0 || j < 0 || j >= rows.length) return;
		const order = rows.map((row) => row.id);
		[order[i], order[j]] = [order[j], order[i]];
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"]["source-files"].$patch({
				param: { id: String(work.id) },
				json: { order },
			});
			if (!res.ok) setError("Couldn't reorder the pictures.");
			await reload();
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormField label="Images">
			<p className="mb-2 text-xs text-base-content/50">
				{released
					? "This Work is released, so its gallery is the version readers have. Adding a new version replaces the whole gallery and keeps the current one in the Work's history."
					: "One image or several. The Work displays them in the order listed here, and the first one is what listings show."}
			</p>
			{error && <div className="alert alert-error text-sm mb-2">{error}</div>}
			{upload && (upload.status === "uploading" || upload.status === "attaching") && (
				<div className="mb-2">
					<UploadProgress upload={upload} />
				</div>
			)}
			{upload?.status === "failed" && (
				<div className="alert alert-error text-sm mb-2">
					<span className="flex-1">{upload.error}</span>
					<button type="button" className="btn btn-sm" onClick={() => workUploads.retry(upload.id)}>
						Try again
					</button>
				</div>
			)}
			{rows && rows.length > 0 && (
				<div className="flex flex-col gap-2 mb-2">
					{rows.map((row, index) => (
						<div
							key={row.id}
							className="flex items-center gap-2 rounded-lg bg-base-200 p-2 text-sm"
						>
							<span className="font-mono text-xs text-base-content/50">{index + 1}</span>
							<img
								src={row.file}
								alt=""
								className="h-10 w-10 rounded border border-base-300 object-cover"
							/>
							<span className="flex-1 truncate">{rowLabel(row, index, upload)}</span>
							<span className="text-xs text-base-content/50">{humanBytes(row.fileSize)}</span>
							{!released && (
								<>
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										disabled={busy || index === 0}
										aria-label={`Move ${rowLabel(row, index, upload)} earlier`}
										onClick={() => move(row.id, -1)}
									>
										↑
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										disabled={busy || index === rows.length - 1}
										aria-label={`Move ${rowLabel(row, index, upload)} later`}
										onClick={() => move(row.id, 1)}
									>
										↓
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs text-error"
										disabled={busy}
										aria-label={`Remove ${rowLabel(row, index, upload)}`}
										onClick={() => remove(row.id)}
									>
										✕
									</button>
								</>
							)}
						</div>
					))}
				</div>
			)}
			<SourceSetAdds workId={work.id} noun="picture" />
			{!released && rows && rows.length === 0 && (
				<p className="mb-2 text-sm text-warning">
					This Work has no pictures yet, so it can't be released. If it was uploading in a tab that
					has since closed, upload them again here.
				</p>
			)}
			{released ? (
				<SetVersionDialog
					work={work}
					accept="image/*"
					label="Drop the new images, or click to browse"
					noun="gallery"
				/>
			) : (
				<MultipleFileInput
					onFiles={addFiles}
					accept="image/*"
					label="Drop images to add, or click to browse"
					disabled={busy || adding != null}
				/>
			)}
		</FormField>
	);
}
