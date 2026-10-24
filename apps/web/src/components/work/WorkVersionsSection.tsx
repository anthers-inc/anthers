// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's media versions, for its creator — the current version's date and the archived
 * originals a replacement retired.
 *
 * ⭐ **The current version is the page's fact; the archive is the creator's.** A reader sees
 * only `versionAddedAt` in the byline. This list, every download and every removal are
 * owner-only routes, and a version holds only original bytes: no ladder, no MP3, no rendered
 * page, no reflow section. Removing one deletes its own originals and nothing else.
 *
 * ⚠️ **The list reloads when the Work's `versionAddedAt` moves**, which is what a replace
 * changes; the upload store's landing already re-reads the Work, so the new row appears
 * without a second polling timer.
 */

import { client } from "@anthers/web-shared/rpc";
import type { WorkMediaVersionSummary } from "@anthers/web-shared/types";
import { ArrowDownTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";

function dateTime(iso: string): string {
	return new Date(iso).toLocaleString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function bytes(value: number): string {
	if (value <= 0) return "";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function WorkVersionsSection({
	workId,
	versionAddedAt,
}: {
	workId: number;
	/** The current version's date; changing it reloads the archive. */
	versionAddedAt?: string | null;
}) {
	const [versions, setVersions] = useState<WorkMediaVersionSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [removeTarget, setRemoveTarget] = useState<WorkMediaVersionSummary | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);

	const load = async () => {
		setError(null);
		const res = await client.api.content.works[":id"].versions.$get({
			param: { id: String(workId) },
		});
		if (!res.ok) {
			setError("Couldn't read this Work's earlier versions.");
			setLoading(false);
			return;
		}
		const body = (await res.json()) as { versions: WorkMediaVersionSummary[] };
		setVersions(body.versions);
		setLoading(false);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: a replacement moves `versionAddedAt`, and that is how the new row reaches the list.
	useEffect(() => {
		let live = true;
		setLoading(true);
		client.api.content.works[":id"].versions
			.$get({ param: { id: String(workId) } })
			.then(async (res) => {
				if (!live) return;
				if (!res.ok) {
					setError("Couldn't read this Work's earlier versions.");
					setLoading(false);
					return;
				}
				const body = (await res.json()) as { versions: WorkMediaVersionSummary[] };
				setVersions(body.versions);
				setLoading(false);
			})
			.catch(() => {
				if (live) {
					setError("Couldn't read this Work's earlier versions.");
					setLoading(false);
				}
			});
		return () => {
			live = false;
		};
	}, [workId, versionAddedAt]);

	const download = (version: WorkMediaVersionSummary) => {
		// A top-level navigation, not a fetch: the route redirects a single original to a
		// signed attachment URL and streams a zip for a set or build version, and neither
		// needs the page to touch the bytes.
		window.location.assign(`/api/content/works/${workId}/versions/${version.id}/download`);
	};

	const confirmRemove = async () => {
		if (!removeTarget) return;
		const target = removeTarget;
		setBusyId(target.id);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].versions[":versionId"].$delete({
				param: { id: String(workId), versionId: String(target.id) },
			});
			if (!res.ok) {
				setError("Couldn't remove that version.");
				return;
			}
			dialog.current?.close();
			setRemoveTarget(null);
			await load();
		} catch {
			setError("Couldn't remove that version.");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<div className="rounded-lg bg-base-200/50 p-3 text-sm">
				<p className="font-medium">Current version</p>
				<p className="text-xs text-base-content/60">
					{versionAddedAt ? `Added ${dateTime(versionAddedAt)}` : "No media version yet"}
				</p>
			</div>

			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{loading ? (
				<p className="text-sm text-base-content/50">Reading earlier versions…</p>
			) : versions.length === 0 ? (
				<p className="text-sm text-base-content/50">No earlier versions.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{versions.map((version) => (
						<li
							key={version.id}
							className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 p-3"
						>
							<div className="min-w-0 flex-1">
								<p className="text-sm">{dateTime(version.uploadedAt)}</p>
								<p className="text-xs text-base-content/50">
									{[
										`${version.fileCount} file${version.fileCount === 1 ? "" : "s"}`,
										bytes(version.totalBytes),
									]
										.filter(Boolean)
										.join(" · ")}
								</p>
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								disabled={busyId === version.id}
								onClick={() => download(version)}
							>
								<ArrowDownTrayIcon className="size-4" />
								Download original
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								disabled={busyId === version.id}
								onClick={() => {
									setRemoveTarget(version);
									dialog.current?.showModal();
								}}
							>
								<TrashIcon className="size-4" />
								Remove
							</button>
						</li>
					))}
				</ul>
			)}

			<dialog ref={dialog} className="modal">
				<div className="modal-box">
					<h3 className="text-lg font-semibold">Remove this version?</h3>
					<p className="mt-1 text-sm text-base-content/70">
						This deletes the original files this version holds. The current version, and anything
						anyone has already downloaded, are untouched.
					</p>
					{removeTarget && (
						<p className="mt-2 text-xs text-base-content/50">{dateTime(removeTarget.uploadedAt)}</p>
					)}
					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => {
								dialog.current?.close();
								setRemoveTarget(null);
							}}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-error btn-sm"
							disabled={busyId != null}
							onClick={() => void confirmRemove()}
						>
							{busyId != null ? "Removing…" : "Remove version"}
						</button>
					</div>
				</div>
				<form method="dialog" className="modal-backdrop">
					<button type="button" aria-label="Close the remove dialog" />
				</form>
			</dialog>
		</section>
	);
}
