// SPDX-License-Identifier: Apache-2.0
/**
 * The files a source-set editor is still adding — the ones not on the Work yet.
 *
 * The set editors' shared piece (2026-10-19): `PagedSourceFiles` and `ImageSourceFiles` both
 * hand a pick to `lib/work-uploads`, and this renders what the store is carrying — the file on
 * the wire with its name, size and percent, the one that failed with its retry, and how many
 * are waiting their turn. It sits below the landed rows, because these files append to the end
 * of the set.
 *
 * ⚠️ **The pick outlives the section that started it.** Leaving the Manage tab does not stop
 * anything: the store keeps the batch, the section reads it again when it mounts, and the tab's
 * unload guard already covers it. Only a cancel stops a file, and only "Stop adding the rest"
 * drops the ones that have not started.
 */

import {
	useSetRowBatch,
	useWorkUploads,
	type WorkUpload,
	workUploads,
} from "../../lib/work-uploads";

/** A byte count as a creator reads it, for a row's file size. */
export function humanBytes(bytes: number | null): string {
	if (bytes == null) return "";
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SourceSetAdds({ workId, noun }: { workId: number; noun: "page" | "picture" }) {
	const batch = useSetRowBatch(workId);
	const uploads = useWorkUploads();
	if (!batch) return null;

	const mine = uploads.filter((u) => u.batch?.id === batch.id);
	const added = mine.filter((u) => u.status === "done").length;
	const live = mine.filter((u) => u.status !== "done");

	return (
		<div className="mb-2 flex flex-col gap-2">
			<div className="flex items-center gap-2 text-xs text-base-content/60">
				<span className="flex-1">
					Adding {noun}s: {added} of {batch.total} added
					{batch.waiting > 0 && `, ${batch.waiting} waiting`}
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={() => workUploads.cancelBatch(batch.id)}
				>
					Stop adding the rest
				</button>
			</div>
			{live.map((upload) => (
				<AddRow key={upload.id} upload={upload} />
			))}
		</div>
	);
}

/** One file of a pick: its name, size and percent, with the one action that file has. */
function AddRow({ upload }: { upload: WorkUpload }) {
	const label =
		upload.status === "attaching"
			? "Finishing"
			: upload.progress == null
				? "Uploading"
				: `${upload.progress}%`;
	return (
		<div className="flex flex-col gap-1 rounded-lg bg-base-200 p-2 text-sm">
			<div className="flex items-center gap-2">
				<span className="flex-1 truncate">{upload.fileName}</span>
				<span className="text-xs text-base-content/50">{humanBytes(upload.fileSize)}</span>
				<span className="font-mono text-xs">{label}</span>
				{upload.status === "failed" ? (
					<>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => workUploads.retry(upload.id)}
						>
							Try again
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							aria-label={`Skip ${upload.fileName}`}
							onClick={() => workUploads.dismiss(upload.id)}
						>
							Skip
						</button>
					</>
				) : (
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						aria-label={`Stop ${upload.fileName}`}
						onClick={() => workUploads.cancel(upload.id)}
					>
						Cancel
					</button>
				)}
			</div>
			{upload.status === "failed" ? (
				<p className="text-xs text-error">{upload.error}</p>
			) : upload.progress == null || upload.status === "attaching" ? (
				<progress className="progress progress-primary w-full" />
			) : (
				<progress className="progress progress-primary w-full" value={upload.progress} max="100" />
			)}
		</div>
	);
}
