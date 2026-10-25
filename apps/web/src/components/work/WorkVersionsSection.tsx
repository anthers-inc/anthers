// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's media versions, for its creator — the current version's name and date, and the
 * archived originals a replacement retired.
 *
 * ⭐ **A version's name and date are public once it was added after release.** The current
 * version's name is set here and carried into its archived row when a replacement takes
 * over; readers see the pair in the byline and the Details tab. Files, sizes, downloads and
 * every version uploaded before release stay owner-only. Removing a version therefore
 * removes its entry from that public history as well as its originals.
 *
 * ⚠️ **The list reloads when the Work's `versionAddedAt` moves**, which is what a replace
 * changes; the upload store's landing already re-reads the Work, so the new row appears
 * without a second polling timer.
 *
 * ⭐ **A `Preserved` tag says these bytes are kept indefinitely** (Parker, 2026-10-25).
 * The tag belongs to the version, because a version is what Anthers actually keeps: the
 * current version carries the Work's own flag, and each archived row carries the flag it
 * held while it was current. The date beside the tag is that version's upload date — when
 * the bytes were made — rather than when the preservation decision was taken.
 */

import { client } from "@anthers/web-shared/rpc";
import type { WorkMediaVersionSummary } from "@anthers/web-shared/types";
import { ArrowDownTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { type FormEvent, useEffect, useRef, useState } from "react";

function dateTime(iso: string): string {
	return new Date(iso).toLocaleString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** The program's mark, explained once beside the tab's own heading. */
function PreservedTag() {
	return (
		<span
			className="badge badge-ghost badge-sm align-middle font-normal"
			title="Somebody saved this Work to their Library, so Anthers keeps these bytes indefinitely — no allowance is charged for them, and nothing expires."
		>
			Preserved
		</span>
	);
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
	versionLabel,
}: {
	workId: number;
	/** The current version's date; changing it reloads the archive. */
	versionAddedAt?: string | null;
	/** The current version's name, carried into its archived row when it is replaced. */
	versionLabel?: string | null;
}) {
	const [versions, setVersions] = useState<WorkMediaVersionSummary[]>([]);
	const [preserved, setPreserved] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [removeTarget, setRemoveTarget] = useState<WorkMediaVersionSummary | null>(null);
	const [label, setLabel] = useState(versionLabel ?? "");
	const [labelSaving, setLabelSaving] = useState(false);
	const [labelSaved, setLabelSaved] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);

	// A replacement arrives as a new prop; the field follows the Work rather than keeping
	// the name of the version it has already retired.
	useEffect(() => {
		setLabel(versionLabel ?? "");
		setLabelSaved(false);
	}, [versionLabel]);

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
		const body = (await res.json()) as {
			versions: WorkMediaVersionSummary[];
			preserved: boolean;
		};
		setVersions(body.versions);
		setPreserved(body.preserved);
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
				const body = (await res.json()) as {
					versions: WorkMediaVersionSummary[];
					preserved: boolean;
				};
				setVersions(body.versions);
				setPreserved(body.preserved);
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

	const saveLabel = async (event: FormEvent) => {
		event.preventDefault();
		if (labelSaving) return;
		setLabelSaving(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(workId) },
				json: { versionLabel: label.trim() },
			});
			if (!res.ok) {
				setError("Couldn't save that version's name.");
				return;
			}
			setLabel(label.trim());
			setLabelSaved(true);
		} catch {
			setError("Couldn't save that version's name.");
		} finally {
			setLabelSaving(false);
		}
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
				<p className="font-medium">Current version {preserved && <PreservedTag />}</p>
				<p className="text-xs text-base-content/60">
					{versionAddedAt ? `Added ${dateTime(versionAddedAt)}` : "No media version yet"}
				</p>
				{versionAddedAt && (
					<form onSubmit={saveLabel} className="mt-2 flex flex-wrap items-end gap-2">
						<label className="min-w-40 flex-1">
							<span className="text-xs text-base-content/60">Name this version</span>
							<input
								className="input input-sm input-bordered mt-0.5 w-full"
								maxLength={80}
								value={label}
								placeholder="Optional"
								onChange={(event) => {
									setLabel(event.target.value);
									setLabelSaved(false);
								}}
							/>
						</label>
						<button type="submit" className="btn btn-sm" disabled={labelSaving || labelSaved}>
							{labelSaving ? "Saving…" : labelSaved ? "Saved" : "Save"}
						</button>
					</form>
				)}
				{versionAddedAt && (
					<p className="mt-1 text-xs text-base-content/50">
						Readers see this name beside the date only for versions added after release.
					</p>
				)}
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
								<p className="text-sm">
									{version.versionLabel
										? `${version.versionLabel} · ${dateTime(version.uploadedAt)}`
										: dateTime(version.uploadedAt)}{" "}
									{version.preserved && <PreservedTag />}
								</p>
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
						anyone has already downloaded, are untouched. If the version was added after the Work
						was released, its entry also leaves the version history readers see.
					</p>
					{removeTarget && (
						<p className="mt-2 text-xs text-base-content/50">
							{removeTarget.versionLabel ? `${removeTarget.versionLabel} · ` : ""}
							{dateTime(removeTarget.uploadedAt)}
						</p>
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
