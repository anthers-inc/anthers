// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of an image Work — the gallery the Work displays, as the creator
 * arranges it (2026-10-18). The paged set editor's sibling: the same routes under it
 * (`GET`/`POST`/order-PATCH/DELETE over `work_source_files`), the same first-file rail —
 * the Upload page's pick attaches as the set's first row — and the same refusal to press a
 * second button while a save runs. What differs: each row previews the picture it holds,
 * the first row is the cover the Work's listings show, and nothing re-renders after a
 * mutation, because the files are the deliverable rather than a book's ingredients.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import type { WorkSourceFile } from "../../lib/work-sources";
import { useSourceUpload, type WorkUpload, workUploads } from "../../lib/work-uploads";
import { uploadImageFile } from "../post/mediaUpload";
import FormField from "../ui/FormField";
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

function humanBytes(bytes: number | null): string {
	if (bytes == null) return "";
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageSourceFiles({ work }: { work: Work }) {
	const upload = useSourceUpload(work.id);
	const [rows, setRows] = useState<WorkSourceFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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

	/** Add one or many picked images: upload each, attach as a row, in pick order. */
	const addFiles = async (picked: File[]) => {
		if (picked.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		try {
			for (const file of picked) {
				const { url } = await uploadImageFile(file, "image");
				const res = await client.api.content.works[":id"]["source-files"].$post({
					param: { id: String(work.id) },
					json: { file: url, filename: file.name, fileSize: file.size, mimeType: file.type },
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setError(body?.error || `Couldn't attach ${file.name}.`);
					break;
				}
			}
			await reload();
		} finally {
			setBusy(false);
		}
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
				One image or several. The Work displays them in the order listed here, and the first one is
				what listings show.
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
						</div>
					))}
				</div>
			)}
			{rows && rows.length === 0 && (
				<p className="mb-2 text-sm text-warning">
					This Work has no pictures yet, so it can't be released. If it was uploading in a tab that
					has since closed, upload them again here.
				</p>
			)}
			<MultipleImageInput onFiles={addFiles} disabled={busy} />
		</FormField>
	);
}

/**
 * The several-image input: one drag or browse can join many pictures at once, attached in
 * the order the picker or drop handed them. A local input rather than a `multiple` flag
 * on the shared `FileUpload`, which every other caller reads as strictly one file.
 */
function MultipleImageInput({
	onFiles,
	disabled,
}: {
	onFiles: (files: File[]) => void;
	disabled?: boolean;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	return (
		<div>
			<input
				style={{ display: "none" }}
				ref={inputRef}
				type="file"
				accept="image/*"
				multiple
				onChange={(e) => {
					const files = Array.from(e.target.files ?? []);
					if (files.length > 0) onFiles(files);
					e.target.value = "";
				}}
			/>
			<button
				type="button"
				className={`flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-sm ${
					over ? "border-primary bg-primary/5" : "border-base-300"
				}`}
				onClick={() => inputRef.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setOver(false);
					const files = Array.from(e.dataTransfer.files);
					if (files.length > 0 && !disabled) onFiles(files);
				}}
			>
				<span>{disabled ? "Working…" : "Drop images to add, or click to browse"}</span>
			</button>
		</div>
	);
}
