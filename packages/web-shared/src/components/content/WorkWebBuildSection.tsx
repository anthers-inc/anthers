// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's browser-build section: the multi-file upload surface for a game or
 * software Work's own hosted build.
 *
 * 🚨 **A build is one unit with a whole file list, and `complete` is the creator's act.**
 * The flow is: create the build (naming the entry file), upload each file (presigned PUT
 * per file, progress per file), register the file list, complete. Nothing here guesses
 * when an export is finished — the creator says so — and a build that is not completed is
 * an ordinary draft state the row records, not an error to clean up.
 *
 * ⚠️ **This uploads; the delivery route is what plays.** The files land in the private
 * bucket under the build's own prefix and `routes/build-delivery.ts` serves them on the
 * Work's delivery origin, every request resolved against `work_build_files`. The lane is
 * built and proven on the dev base; its production ingress is not open yet, so nothing
 * here is described as live. What this section does today is put the bytes in the right
 * place with the right records.
 *
 * ⭐ **The Work's media area starts the same build** (Parker, 2026-10-23): the empty card's
 * intake and the media manager both mount this lane, and `lib/web-build-uploads` carries
 * the folder or zip's files here. This section shows that upload's progress so the creator
 * who is already on the Work's page sees the build they just started rather than an empty
 * section.
 */

import { WEB_BUILD_FILE_MAX } from "@anthers/shared/web-build";
import { useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import { formatBuildFileSize } from "../../lib/web-build-files";
import {
	directBuildUpload,
	putToStorage,
	useWebBuildUploads,
	webBuildUploads,
} from "../../lib/web-build-uploads";
import FormField from "../ui/FormField";

/** One file's progress through its own upload. */
interface FileProgress {
	name: string;
	percent: number;
	done: boolean;
	failed?: string;
}

/** Small enough to be a mistake rather than a build. A real export carries tens of MB. */
const BUILD_FILE_MAX = WEB_BUILD_FILE_MAX;

export default function WebBuildSection({
	work,
	onChanged,
}: {
	work: Work;
	/** Called after a build completes or is deleted, so the page can re-read the Work. */
	onChanged?: () => void;
}) {
	const builds = work.webBuilds ?? [];
	// `current` re-renders this section from the page's re-read after each landed upload.
	const [creating, setCreating] = useState(false);
	const [label, setLabel] = useState("");
	const [picked, setPicked] = useState<File[]>([]);
	const [entryPath, setEntryPath] = useState("");
	const [requiresIsolation, setRequiresIsolation] = useState(false);
	const [fileProgress, setFileProgress] = useState<FileProgress[]>([]);
	const [phase, setPhase] = useState<"idle" | "uploading" | "registering">("idle");
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[],
	);

	const uploading = phase !== "idle";
	// A hosted build started from the media area keeps going while the creator is here.
	// These are its files and their progress; a completed one disappears into the build
	// list on the page's re-read.
	const incoming = useWebBuildUploads().filter((u) => u.workId === work.id && u.status !== "done");

	const start = async () => {
		setError(null);
		if (picked.length === 0) return;
		const entry = entryPath.trim();
		if (!picked.some((f) => f.webkitRelativePath === entry || f.name === entry)) {
			setError("The entry point has to be one of the picked files.");
			return;
		}
		const oversized = picked.find((f) => f.size > BUILD_FILE_MAX);
		if (oversized) {
			setError(`${oversized.name} is over the 500 MB per-file limit.`);
			return;
		}
		setPhase("uploading");
		try {
			// 1. Create the build unit.
			const res = await client.api["web-builds"].works[":id"]["web-build"].$post({
				param: { id: String(work.id) },
				json: { label: label.trim(), entryPath: entry, requiresIsolation },
			});
			if (!res.ok) throw new Error("Could not create the build.");
			const { build } = await res.json();

			// 2. Upload each file to its own URL.
			const refs: { path: string; storageRef: string; fileSize: number; contentType: string }[] =
				[];
			for (const file of picked) {
				const path = file.webkitRelativePath || file.name;
				const presign = await client.api["web-builds"].works[":id"]["web-build"][
					":buildId"
				].presign.$post({
					param: { id: String(work.id), buildId: String(build.id) },
					json: { path, contentType: file.type || "application/octet-stream" },
				});
				if (!presign.ok) throw new Error(`Could not get an upload URL for ${path}.`);
				const info = (await presign.json()) as {
					method: "presigned" | "direct";
					uploadUrl: string;
					headers?: Record<string, string>;
					key: string;
				};
				if (info.method === "presigned") {
					await putToStorage(info.uploadUrl, file, info.headers ?? {}, (p) => {
						if (alive.current) {
							setFileProgress((prev) =>
								prev.map((f) => (f.name === file.name ? { ...f, percent: p } : f)),
							);
						}
					});
				} else {
					// Local dev: POST the bytes to the build route's direct endpoint.
					const body = await directBuildUpload(info.uploadUrl, file, path, (p) => {
						if (alive.current) {
							setFileProgress((prev) =>
								prev.map((f) => (f.name === file.name ? { ...f, percent: p } : f)),
							);
						}
					});
					info.key = body.key;
				}
				refs.push({
					path,
					storageRef: info.key,
					fileSize: file.size,
					contentType: file.type || "",
				});
				if (alive.current) {
					setFileProgress((prev) =>
						prev.map((f) => (f.name === file.name ? { ...f, percent: 100, done: true } : f)),
					);
				}
			}

			// 3. Register the file list, then say the list is whole.
			setPhase("registering");
			const reg = await client.api["web-builds"].works[":id"]["web-build"][":buildId"].files.$post({
				param: { id: String(work.id), buildId: String(build.id) },
				json: { files: refs },
			});
			if (!reg.ok) throw new Error("Could not register the build's files.");
			// The server makes the first completed build primary; promoting a later one is
			// the server's default-avoiding explicit path, kept out of this form until the
			// Work has a build to swap for.
			await client.api["web-builds"].works[":id"]["web-build"][":buildId"].complete.$post({
				param: { id: String(work.id), buildId: String(build.id) },
				json: { entryPath: entry, label: label.trim() || undefined },
			});
			onChanged?.();
			if (alive.current) {
				setCreating(false);
				setPicked([]);
				setEntryPath("");
				setFileProgress([]);
				setLabel("");
			}
		} catch (err) {
			if (alive.current) setError(err instanceof Error ? err.message : "Upload failed.");
		} finally {
			if (alive.current) setPhase("idle");
		}
	};

	const remove = async (buildId: number) => {
		setError(null);
		try {
			const res = await client.api["web-builds"].works[":id"]["web-build"][":buildId"].$delete({
				param: { id: String(work.id), buildId: String(buildId) },
			});
			if (!res.ok) throw new Error("Delete failed");
			onChanged?.();
		} catch {
			setError("Could not delete that build.");
		}
	};

	return (
		// No heading of its own: the Manage tab's section names it ("Hosted Build")
		// already, and a second heading over one section read twice (Parker's conformance
		// pass, 2026-10-16).
		<section className="flex flex-col gap-3">
			<p className="text-sm text-base-content/60">
				Upload a build that runs in the browser — the HTML entry, its loader, the wasm and the
				assets beside it. A game or piece of software can also start one from this media area.
				Delivery to players opens with the hosted-build launch; today this stores the files a player
				will load.
			</p>

			{error && (
				<div className="alert alert-error text-sm">
					<span className="flex-1">{error}</span>
				</div>
			)}

			{incoming.map((u) => (
				<div key={u.id} className="rounded-box border border-base-300 bg-base-200/40 p-4">
					<div className="flex items-center gap-2">
						<h3 className="font-medium">Hosted build uploading</h3>
						<div className="flex-1" />
						{u.status === "failed" ? (
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => webBuildUploads.dismiss(u.id)}
							>
								Dismiss
							</button>
						) : (
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								onClick={() => webBuildUploads.cancel(u.id)}
							>
								Cancel
							</button>
						)}
					</div>
					<p className="mt-1 text-xs font-mono text-base-content/60">
						Entry: {u.entryPath} · {u.files.filter((f) => f.done).length} of {u.files.length} files
						{u.requiresIsolation ? " · threaded" : ""}
					</p>
					{u.status === "failed" ? (
						<div className="alert alert-error mt-2 text-sm">
							<span>{u.error}</span>
						</div>
					) : (
						<ul className="mt-2 flex flex-col gap-1 text-xs">
							{u.files.map((f) => (
								<li key={f.path} className="flex items-center gap-2">
									<span className="w-48 truncate font-mono">{f.path}</span>
									<progress
										className="progress progress-primary flex-1"
										value={f.percent}
										max={100}
									/>
									<span className="w-10 text-right">{f.percent}%</span>
								</li>
							))}
						</ul>
					)}
				</div>
			))}

			{builds.map((b) => (
				<div key={b.id} className="rounded-box border border-base-300 bg-base-200/40 p-4">
					<div className="flex items-center gap-2">
						<h3 className="font-medium">{b.label || "Build"}</h3>
						{b.isPrimary && <span className="badge badge-primary badge-xs">Primary</span>}
						<div className="flex-1" />
						<button
							type="button"
							className="btn btn-ghost btn-xs text-error"
							onClick={() => remove(b.id)}
						>
							Delete
						</button>
					</div>
					<p className="mt-1 text-xs font-mono text-base-content/60">
						Entry: {b.entryPath} · {b.files.length} file{b.files.length === 1 ? "" : "s"} ·{" "}
						{formatBuildFileSize(b.files.reduce((sum, f) => sum + (f.fileSize ?? 0), 0))}
					</p>
					<ul className="mt-2 max-h-40 overflow-y-auto text-xs font-mono text-base-content/70">
						{b.files.map((f) => (
							<li key={f.id} className="truncate">
								{f.path}{" "}
								<span className="text-base-content/40">
									({formatBuildFileSize(f.fileSize ?? 0)})
								</span>
							</li>
						))}
					</ul>
				</div>
			))}

			{creating ? (
				<div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200/40 p-4">
					<FormField label="Build name (optional)">
						<input
							className="input input-bordered input-sm"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="e.g. Teaser build"
							disabled={uploading}
						/>
					</FormField>
					<FormField label="Files">
						<input
							type="file"
							className="file-input file-input-bordered file-input-sm w-full"
							multiple
							ref={(el) => {
								// A directory pick keeps the build's own paths; a multi-file pick
								// needs plain names. Both are supported; paths drive everything.
								if (el) {
									el.setAttribute("webkitdirectory", "");
								}
							}}
							onChange={(e) => {
								const files = Array.from(e.target.files ?? []);
								setPicked(files);
								const index = files.find((f) =>
									/index\.html?$/i.test(f.webkitRelativePath || f.name),
								);
								setEntryPath(index ? index.webkitRelativePath || index.name : "");
								setFileProgress(files.map((f) => ({ name: f.name, percent: 0, done: false })));
							}}
							disabled={uploading}
						/>
					</FormField>
					<FormField label="Entry file" hint="The file the game loads first — usually index.html.">
						<input
							className="input input-bordered input-sm font-mono"
							value={entryPath}
							onChange={(e) => setEntryPath(e.target.value)}
							placeholder="index.html"
							disabled={uploading}
						/>
					</FormField>
					<label className="label cursor-pointer justify-start gap-2 w-fit">
						<input
							type="checkbox"
							className="checkbox checkbox-sm"
							checked={requiresIsolation}
							onChange={(e) => setRequiresIsolation(e.target.checked)}
							disabled={uploading}
						/>
						<span className="label-text text-sm">
							Threaded build (SharedArrayBuffer)
							<span className="block text-xs text-base-content/60">
								On when your export preset had Thread Support enabled. Plays on a dedicated page
								with the isolation headers, rather than inline.
							</span>
						</span>
					</label>

					{uploading && (
						<ul className="flex flex-col gap-1 text-xs">
							{fileProgress.map((f) => (
								<li key={f.name} className="flex items-center gap-2">
									<span className="w-40 truncate font-mono">{f.name}</span>
									<progress
										className="progress progress-primary flex-1"
										value={f.percent}
										max={100}
									/>
									<span className="w-10 text-right">{f.percent}%</span>
								</li>
							))}
						</ul>
					)}

					<div className="flex gap-2">
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={start}
							disabled={uploading || picked.length === 0 || !entryPath.trim()}
						>
							{phase === "uploading"
								? "Uploading…"
								: phase === "registering"
									? "Registering…"
									: "Upload build"}
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => {
								setCreating(false);
								setPicked([]);
							}}
							disabled={uploading}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="btn btn-outline btn-sm self-start"
					onClick={() => setCreating(true)}
				>
					Add browser build
				</button>
			)}
		</section>
	);
}
