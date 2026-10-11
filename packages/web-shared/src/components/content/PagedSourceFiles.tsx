// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of a comic or book — the files its pages render from, as the creator
 * arranges them (Parker, 2026-10-10: one PDF or several, each file's pages a contiguous run
 * in the set's order).
 *
 * 🚨 **The first file rides the same rail as every other Work's source upload** — created on
 * the Upload page's pick, uploaded through `work-uploads`, attached by the legacy
 * `source_key` PATCH — and the server syncs that attach into this set. So this component's
 * own adds are for files BEYOND the first, each uploaded the same rail and attached as a set
 * row, in the order the creator keeps picking; a multi-pick appends in the picker's order,
 * which is why the control says so.
 *
 * ⚠️ Every mutation re-renders the whole book server-side. The component asks nothing about
 * processing (the page's own processing panel owns that); it only keeps the list it shows
 * equal to the set the server stands at, and refuses a second button-press while a save is
 * running so reordering two files in a blink cannot send two orders that pass in the air.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import { uploadMediaFile } from "../../lib/upload";
import type { WorkSourceFile } from "../../lib/work-sources";
import { useSourceUpload, type WorkUpload, workUploads } from "../../lib/work-uploads";
import FormField from "../ui/FormField";
import { UploadProgress } from "./work-media";

/** A file's name without its extension. */
function withoutExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return (dot > 0 ? name.slice(0, dot) : name).trim();
}

/**
 * A row's label: its stored filename, or — for the first file, which arrives attached by
 * the legacy `source_key` rail that carries no name — the name of the upload this tab
 * started, if the tab still holds it. Beyond that, "Page set N" says the truth (the file
 * is in the set) without inventing a name.
 */
function rowLabel(row: WorkSourceFile, index: number, upload: WorkUpload | null): string {
	if (row.filename) return withoutExtension(row.filename) || `Page set ${index + 1}`;
	if (index === 0 && upload?.fileName) return withoutExtension(upload.fileName);
	return `Page set ${index + 1}`;
}

function humanBytes(bytes: number | null): string {
	if (bytes == null) return "";
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function PagedSourceFiles({ work }: { work: Work }) {
	const upload = useSourceUpload(work.id);
	const [rows, setRows] = useState<WorkSourceFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		const res = await client.api.content.works[":id"]["source-files"].$get({
			param: { id: String(work.id) },
		});
		if (!res.ok) {
			setError("Couldn't load this Work's files.");
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

	/** Add one or many picked files: upload each, attach as a row, in pick order. */
	const addFiles = async (picked: File[]) => {
		if (picked.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		try {
			for (const file of picked) {
				const key = await uploadMediaFile(file, "asset");
				const res = await client.api.content.works[":id"]["source-files"].$post({
					param: { id: String(work.id) },
					json: { file: key, filename: file.name, fileSize: file.size, mimeType: file.type },
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
			if (!res.ok) setError("Couldn't remove that file.");
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
			if (!res.ok) setError("Couldn't reorder the files.");
			await reload();
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormField label="Pages">
			<p className="mb-2 text-xs text-base-content/50">
				One PDF or several. Each file's pages become a run of this Work's pages, in the order listed
				here; a file with many pages keeps them all. Adding, removing or reordering re-renders the
				book.
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
				<div className="flex flex-col gap-1 mb-2">
					{rows.map((row, index) => (
						<div
							key={row.id}
							className="flex items-center gap-2 rounded-lg bg-base-200 p-2 text-sm"
						>
							<span className="font-mono text-xs text-base-content/50">{index + 1}</span>
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
			<MultipleFileInput onFiles={addFiles} disabled={busy} />
		</FormField>
	);
}

/**
 * The several-file input: one drag or browse can join many files at once, attached in
 * the order the picker or drop handed them. A local input rather than a `multiple` flag
 * on the shared `FileUpload`, which every other caller reads as strictly one file.
 */
function MultipleFileInput({
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
				accept="application/pdf"
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
				<span>{disabled ? "Working…" : "Drop a PDF or several, or click to browse"}</span>
			</button>
		</div>
	);
}
