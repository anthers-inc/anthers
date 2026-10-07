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
 * ⚠️ **This uploads; it does not deliver.** The files land in the private bucket under
 * the build's own prefix and the Work page embeds nothing from here yet — hosting
 * delivery is the hosting task's remaining half. What this section does today is put the
 * bytes in the right place with the right records.
 */

import { useEffect, useRef, useState } from "react";
import { apiBaseUrl, apiSendsCookies, client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import FormField from "../ui/FormField";

/** One file's progress through its own upload. */
interface FileProgress {
	name: string;
	percent: number;
	done: boolean;
	failed?: string;
}

/** Small enough to be a mistake rather than a build. A real export carries tens of MB. */
const BUILD_FILE_MAX = 500 * 1024 * 1024;

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * PUT one file to its presigned URL, with progress. Mirrors `upload.ts`'s xhrUpload —
 * XHR because fetch has no upload progress — but without the multipart path: a build
 * file's key is minted by the build route and the PUT goes straight to storage.
 */
function putToStorage(
	url: string,
	file: File,
	headers: Record<string, string>,
	onPercent: (p: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
		});
		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) resolve();
			else reject(new Error(`Upload failed with status ${xhr.status}`));
		});
		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.send(file);
	});
}

/**
 * POST one file to the build route's direct endpoint (local dev), with progress.
 * Mirrors `upload.ts`'s `xhrUploadFormData`: XHR because fetch has no upload progress,
 * which also means it bypasses `apiFetch`, so the base URL and credentials are resolved
 * the same way `apiFetch` would.
 */
function directUpload(
	path: string,
	file: File,
	buildPath: string,
	onPercent: (p: number) => void,
): Promise<{ key: string }> {
	return new Promise((resolve, reject) => {
		const form = new FormData();
		form.append("file", file);
		form.append("path", buildPath);
		const xhr = new XMLHttpRequest();
		const full = path.startsWith("/") ? `${apiBaseUrl()}${path}` : path;
		xhr.open("POST", full);
		xhr.withCredentials = apiSendsCookies();
		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
		});
		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
			else reject(new Error(`Upload failed with status ${xhr.status}`));
		});
		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.send(form);
	});
}

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
					const body = await directUpload(info.uploadUrl, file, path, (p) => {
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
		<section className="flex flex-col gap-3">
			<h2 className="font-semibold">Browser Build</h2>
			<p className="text-sm text-base-content/60">
				Upload a build that runs in the browser (an HTML entry, its scripts, assets) and Anthers
				hosts it. Delivery to players arrives with the hosted-build launch; today this puts the
				files where they will be served from.
			</p>

			{error && (
				<div className="alert alert-error text-sm">
					<span className="flex-1">{error}</span>
				</div>
			)}

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
						{formatFileSize(b.files.reduce((sum, f) => sum + (f.fileSize ?? 0), 0))}
					</p>
					<ul className="mt-2 max-h-40 overflow-y-auto text-xs font-mono text-base-content/70">
						{b.files.map((f) => (
							<li key={f.id} className="truncate">
								{f.path}{" "}
								<span className="text-base-content/40">({formatFileSize(f.fileSize ?? 0)})</span>
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
