// SPDX-License-Identifier: Apache-2.0
/**
 * The source set of a comic or book — the files its pages render from, as the creator
 * arranges them. A comic's pages are JPG or PNG images (Parker, 2026-10-19); a book's are
 * page images, a PDF (2026-10-11's whole-book alternate) or an EPUB, each file's pages a
 * contiguous run in the set's order.
 *
 * 🚨 **The first file rides the same rail as every other Work's source upload** — created on
 * the Upload page's pick, uploaded through `work-uploads`, attached by the legacy
 * `source_key` PATCH — and the server syncs that attach into this set. So this component's
 * own adds are for files BEYOND the first, and they ride that store too: a pick becomes a
 * batch of `set-row` entries (2026-10-19), each with its own progress and cancel, the files
 * after the first waiting their turn so a hundred-page comic does not open a hundred
 * concurrent uploads, and the whole pick attaching in one request when its last file lands.
 * `SourceSetAdds` renders what the store is carrying; a multi-pick appends in the picker's
 * order, which is why the control says so.
 *
 * ⚠️ Every mutation re-renders the whole book server-side, so a pick is sent as ONE append
 * rather than one per file (2026-10-19): a hundred page images in a hundred requests would be
 * a hundred renders of a set that grew by one. The component asks nothing about processing
 * (the page's own processing panel owns that); it only keeps the list it shows equal to the
 * set the server stands at, and refuses a second button-press while a save is running so
 * reordering two files in a blink cannot send two orders that pass in the air.
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
import { type FileWorkType, UploadProgress } from "./work-media";

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

export function PagedSourceFiles({ work }: { work: Work }) {
	const upload = useSourceUpload(work.id);
	const adding = useSetRowBatch(work.id);
	const [rows, setRows] = useState<WorkSourceFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// A released Work's set is the version its readers have. It is read here, never edited
	// in place: the only act is a whole new set.
	const released = work.visibility === "released";

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

	// A page file landing is a row the server wrote — the pick attaches once, at its end — so
	// the list re-reads when that append settles rather than growing file by file.
	const landed = useWorkUploads().filter(
		(u) => u.workId === work.id && u.target.kind === "set-row" && u.status === "done",
	).length;
	useEffect(() => {
		if (landed > 0) void reload();
	}, [landed, reload]);

	/**
	 * Add one or many picked files. The pick goes to the upload store, which runs it a file at
	 * a time — so each one carries its own progress and cancel, the rest survive leaving this
	 * tab, and the whole pick reaches the Work in one append when the last file lands.
	 */
	const addFiles = (picked: File[]) => {
		if (picked.length === 0 || busy || adding) return;
		setError(null);
		workUploads.startBatch(work.id, picked, {
			kind: "set-row",
			type: work.type as FileWorkType,
		});
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
				{released
					? "This Work is released, so its pages are the version readers have. Adding a new version replaces the whole set and keeps the current one in the Work's history."
					: work.type === "comic"
						? "One page image per page (JPG or PNG). Each file becomes a run of this Work's pages, in the order listed here. Adding, removing or reordering re-renders the book."
						: "JPG or PNG page images, a PDF, or an EPUB. Each page set becomes a run of this Work's pages, in the order listed here; an EPUB reflows on its own and can't mix with page files. Adding, removing or reordering re-renders the book."}
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
			<SourceSetAdds workId={work.id} noun="page" />
			{!released && rows && rows.length === 0 && (
				<p className="mb-2 text-sm text-warning">
					This Work has no file yet, so it can't be released. If it was uploading in a tab that has
					since closed, upload it again here.
				</p>
			)}
			{released ? (
				<SetVersionDialog
					work={work}
					accept={
						work.type === "comic"
							? "image/jpeg,image/png"
							: "image/jpeg,image/png,application/pdf,application/epub+zip,.epub"
					}
					label={
						work.type === "comic"
							? "Drop the new page images (JPG or PNG), or click to browse"
							: "Drop the new page images, a PDF or an EPUB, or click to browse"
					}
					noun="set of pages"
				/>
			) : (
				<MultipleFileInput
					accept={
						work.type === "comic"
							? "image/jpeg,image/png"
							: "image/jpeg,image/png,application/pdf,application/epub+zip,.epub"
					}
					label={
						work.type === "comic"
							? "Drop page images (JPG or PNG), or click to browse"
							: "Drop page images, a PDF or an EPUB, or click to browse"
					}
					onFiles={addFiles}
					disabled={busy || adding != null}
				/>
			)}
		</FormField>
	);
}
