// SPDX-License-Identifier: Apache-2.0
/**
 * The first step of making a Work: a type, a title, and the file. Picking the file creates the
 * Work, starts the upload, and hands the Work back while the bytes are still travelling.
 *
 * 🚨 **Creation happens on the pick, not when the upload finishes** (Parker, 2026-09-16). It is
 * what Vimeo does and it is the reason the step is separate at all: a creator uploading a large
 * video fills in its details on the Work's own page during the upload, rather than watching a
 * bar and then starting on the form. `lib/work-uploads` carries the upload from here and
 * attaches the file when it lands.
 *
 * ⭐ **Both invariants hold because this step asks almost nothing.** The Work is born `private`
 * — there is no release control, and `POST /works` refuses `visibility: "released"` anyway — and
 * born `unrated`, because there is no rating control to default. Both questions are asked on the
 * Work's page, where Release is.
 *
 * ⚠️ **Access is proposed as Public Access, as the single form proposed it before this split.**
 * The server's own default is free but fully locked, which is right for an API and wrong for a
 * person: it releases something nobody can open. Proposing it here is not answering for the
 * creator, because nothing is reachable until release and the access table is on the page this
 * step lands on, above the Release control.
 *
 * Used in one place: the Upload page at `/studio/works/new`, which is the only way a Work is
 * made — the picker that once minted one in a dialog retired the path (Parker, 2026-10-10:
 * pickers pick, and creation belongs to this page). ⚠️ **Don't grow this into a second
 * editor** — everything past these three inputs belongs to the Work's page.
 *
 * ⭐ **A file is optional** (Parker, 2026-10-10). A Work can be drafted before its file exists,
 * and an upload that failed must not cost the title and type typed beside it — so the page
 * offers a fileless create that lands on the Work's own page, where the Work placeholder's
 * own dropper (`WorkFileDropzone`) holds the no-file state and release refuses until the file
 * arrives. A fileless create needs a title, because a Work with neither file nor name is a
 * row, not a draft.
 *
 * ⭐ **The card under the picker follows the kind** (Parker, 2026-10-19): a video's set, a
 * book's set and a build's platform are three different facts, and `WorkTypeFacts` states the
 * one for the kind currently chosen rather than every kind at once. It sits below the upload
 * area the fact belongs to, before the skip or continue action.
 *
 * ⭐ **A Web build is the hosted lane, on this page** (Parker, 2026-10-19): a browser build is
 * a folder of files, not one downloadable asset, so choosing Web swaps the single-file picker
 * for the export-folder or `.zip` picker whose files the page-one upload starts. The entry and
 * threaded posture are answered here because the build row fixes both at create time;
 * `lib/web-build-uploads` carries the files to their registered list while the creator moves
 * on to the Work's page. Every other platform keeps the downloadable build.
 */

import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { client } from "../../lib/rpc";
import type { ContentType, Work, WorkInput } from "../../lib/types";
import {
	formatBuildFileSize,
	pickBuildFolder,
	pickBuildZip,
	type WebBuildPick,
} from "../../lib/web-build-files";
import { webBuildUploads } from "../../lib/web-build-uploads";
import { workUploads } from "../../lib/work-uploads";
import { serializeAccessRows } from "../post/AccessTables";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";
import { fileRules, isFileWorkType, WorkTypeFacts } from "./work-media";
import { isBuildType, LIBRARY_TYPE_OPTIONS } from "./works";

const BUILD_PLATFORMS = [
	{ value: "windows", label: "Windows" },
	{ value: "mac", label: "macOS" },
	{ value: "linux", label: "Linux" },
	{ value: "web", label: "Web" },
	{ value: "android", label: "Android" },
	{ value: "ios", label: "iOS" },
	{ value: "other", label: "Other" },
];

/** A file's name without its extension — the title a Work gets when none was typed. */
function titleFromFileName(name: string): string {
	const dot = name.lastIndexOf(".");
	return (dot > 0 ? name.slice(0, dot) : name).trim();
}

interface WorkUploadFormProps {
	/** Called with the created Work. Any upload it started is already running. */
	onCreated: (work: Work) => void;
}

export default function WorkUploadForm({ onCreated }: WorkUploadFormProps) {
	const [type, setType] = useState<ContentType>("video");
	const [title, setTitle] = useState("");
	const [platform, setPlatform] = useState("windows");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The Web lane: a whole export rather than one downloadable file. Held here until the
	// creator says to create, because the entry and threaded posture are questions the
	// build row fixes at create time — and the upload starts on that click.
	const [webPick, setWebPick] = useState<WebBuildPick | null>(null);
	const [webEntry, setWebEntry] = useState("");
	const [webIsolation, setWebIsolation] = useState(false);
	const [webReading, setWebReading] = useState(false);
	const requireTitleForDraft = (): boolean => {
		if (!title.trim()) {
			setError("Give the draft a name — you can change it on its page.");
			return false;
		}
		return true;
	};

	const chooseType = (next: ContentType) => {
		setType(next);
		setWebPick(null);
		setWebEntry("");
		setError(null);
	};

	const choosePlatform = (next: string) => {
		setPlatform(next);
		setWebPick(null);
		setWebEntry("");
		setError(null);
	};

	const chooseFolder = (files: File[]) => {
		setError(null);
		try {
			const pick = pickBuildFolder(files);
			setWebPick(pick);
			setWebEntry(pick.entryPath);
		} catch (err) {
			setWebPick(null);
			setWebEntry("");
			setError(err instanceof Error ? err.message : "That folder can't be used as a build.");
		}
	};

	const chooseZip = async (file: File) => {
		setError(null);
		setWebReading(true);
		try {
			const pick = await pickBuildZip(file);
			setWebPick(pick);
			setWebEntry(pick.entryPath);
		} catch (err) {
			setWebPick(null);
			setWebEntry("");
			setError(err instanceof Error ? err.message : "That zip can't be used as a build.");
		} finally {
			setWebReading(false);
		}
	};

	const create = async (file: File | null, hosted: WebBuildPick | null = null) => {
		if (!file && !hosted && !requireTitleForDraft()) return;
		const entry = webEntry.trim();
		if (hosted && !hosted.files.some((f) => f.path === entry)) {
			setError("The entry file has to be one of the build's files.");
			return;
		}
		setCreating(true);
		setError(null);
		const input: WorkInput & { type: ContentType } = {
			type,
			title: title.trim() || (hosted ? hosted.name : file ? titleFromFileName(file.name) : ""),
			access: serializeAccessRows([{ threshold: 0, label: "Everyone", allow: true, price: "0" }]),
		};
		try {
			const res = await client.api.content.works.$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "Couldn't create this Work.");
				setCreating(false);
				return;
			}
			const { work } = (await res.json()) as unknown as { work: Work };
			if (hosted) {
				// The build's files keep going from the store while the creator lands on the
				// Work's page — the same shape a single file's upload takes.
				webBuildUploads.start(work.id, hosted, {
					entryPath: entry,
					requiresIsolation: webIsolation,
				});
			} else if (file && isFileWorkType(type)) {
				workUploads.start(work.id, file, { kind: "source", type });
			} else if (file && isBuildType(type)) {
				workUploads.start(work.id, file, { kind: "build", platform });
			}
			// Left `creating` on purpose: the caller moves on, and a form that re-enabled for an
			// instant would offer a second click that makes a second Work.
			onCreated(work);
		} catch {
			setError("Couldn't create this Work.");
			setCreating(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			<FormField label="Type">
				<select
					className="select select-bordered w-full"
					value={type}
					disabled={creating}
					onChange={(e) => chooseType(e.target.value as ContentType)}
				>
					{LIBRARY_TYPE_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			</FormField>

			<FormField
				label="Title"
				hint={
					isBuildType(type) && platform === "web"
						? "Leave it blank to use the folder's or zip's name. You can change it on the next page."
						: isFileWorkType(type) || isBuildType(type)
							? "Leave it blank to use the file's name. You can change it on the next page."
							: undefined
				}
			>
				<input
					type="text"
					className="input input-bordered w-full"
					value={title}
					disabled={creating}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Work title"
				/>
			</FormField>

			{isFileWorkType(type) && (
				<>
					<FormField
						label="File"
						hint="Choosing the file adds this Work to your Catalog, privately, and takes you to its page to fill in the rest while it uploads."
					>
						{creating ? (
							<div className="flex items-center gap-3 rounded-lg bg-base-200 p-4 text-sm">
								<span className="loading loading-spinner loading-sm" />
								Creating the Work…
							</div>
						) : (
							<FileUpload
								accept={fileRules(type).accept}
								maxSize={fileRules(type).maxSize}
								label={`Drop ${fileRules(type).noun} or click to browse`}
								onFileSelect={(file) => create(file)}
							/>
						)}
					</FormField>
					<WorkTypeFacts type={type} />
					<div>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							disabled={creating}
							onClick={() => create(null)}
						>
							Skip for now — draft it without a file <ArrowRightIcon className="h-4 w-4" />
						</button>
					</div>
				</>
			)}

			{isBuildType(type) && (
				<FormField label="Platform">
					<select
						className="select select-bordered w-full"
						value={platform}
						disabled={creating}
						onChange={(e) => choosePlatform(e.target.value)}
					>
						{BUILD_PLATFORMS.map((p) => (
							<option key={p.value} value={p.value}>
								{p.label}
							</option>
						))}
					</select>
				</FormField>
			)}

			{isBuildType(type) && platform !== "web" && (
				<>
					<FormField
						label="Build (optional)"
						hint="A build you add here becomes this Work's primary download. More builds are added on the Work's page."
					>
						{creating ? (
							<div className="flex items-center gap-3 rounded-lg bg-base-200 p-4 text-sm">
								<span className="loading loading-spinner loading-sm" />
								Creating the Work…
							</div>
						) : (
							<FileUpload
								label="Drop a build or click to browse"
								onFileSelect={(file) => create(file)}
							/>
						)}
					</FormField>
					<WorkTypeFacts type={type} platform={platform} />
					<div>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							disabled={creating}
							onClick={() => create(null)}
						>
							Continue without a build <ArrowRightIcon className="h-4 w-4" />
						</button>
					</div>
				</>
			)}

			{isBuildType(type) && platform === "web" && (
				<>
					<FormField
						label="Hosted build (optional)"
						hint="Anthers hosts a browser build and plays it on the Work's page. Choose the folder the engine's export wrote, or a .zip of it."
						spaced
					>
						{creating ? (
							<div className="flex items-center gap-3 rounded-lg bg-base-200 p-4 text-sm">
								<span className="loading loading-spinner loading-sm" />
								Creating the Work…
							</div>
						) : (
							<div className="flex flex-col gap-3">
								<label className="flex flex-col gap-1 text-sm">
									<span className="font-medium">The export folder</span>
									<input
										type="file"
										className="file-input file-input-bordered w-full"
										multiple
										disabled={creating || webReading}
										ref={(el) => {
											// A directory pick carries each file's path, which is what the build
											// is registered by; the attribute cannot be set through JSX types.
											if (el) el.setAttribute("webkitdirectory", "");
										}}
										onChange={(e) => chooseFolder(Array.from(e.target.files ?? []))}
									/>
								</label>
								<label className="flex flex-col gap-1 text-sm">
									<span className="font-medium">or a .zip of it</span>
									<input
										type="file"
										accept=".zip,application/zip"
										className="file-input file-input-bordered w-full"
										disabled={creating || webReading}
										onChange={(e) => {
											const file = e.target.files?.[0];
											if (file) void chooseZip(file);
										}}
									/>
								</label>
								{webReading && (
									<span className="flex items-center gap-2 text-xs text-base-content/60">
										<span className="loading loading-spinner loading-xs" />
										Reading the zip…
									</span>
								)}
								{webPick && (
									<p className="text-xs text-base-content/60">
										{webPick.files.length} file{webPick.files.length === 1 ? "" : "s"},{" "}
										{formatBuildFileSize(webPick.files.reduce((sum, f) => sum + f.file.size, 0))} —
										entry {webPick.entryPath}.
									</p>
								)}
							</div>
						)}
					</FormField>
					<WorkTypeFacts type={type} platform="web" />
					<FormField label="Entry file" hint="The file the build loads first — usually index.html.">
						<input
							className="input input-bordered w-full font-mono"
							value={webEntry}
							placeholder="index.html"
							disabled={creating || webReading}
							onChange={(e) => setWebEntry(e.target.value)}
						/>
					</FormField>
					<label className="label cursor-pointer justify-start gap-2 w-fit">
						<input
							type="checkbox"
							className="checkbox checkbox-sm"
							checked={webIsolation}
							onChange={(e) => setWebIsolation(e.target.checked)}
							disabled={creating || webReading}
						/>
						<span className="label-text text-sm">
							Threaded build (SharedArrayBuffer)
							<span className="block text-xs text-base-content/60">
								On when your export preset had Thread Support enabled. Plays on a dedicated page
								with the isolation headers, rather than inline.
							</span>
						</span>
					</label>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn btn-primary"
							disabled={creating || webReading || !webPick || !webEntry.trim()}
							onClick={() => void create(null, webPick)}
						>
							{creating ? "Creating…" : "Create Work and upload build"}
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							disabled={creating}
							onClick={() => void create(null)}
						>
							Continue without a build <ArrowRightIcon className="h-4 w-4" />
						</button>
					</div>
				</>
			)}

			{!isFileWorkType(type) && !isBuildType(type) && (
				<>
					<WorkTypeFacts type={type} />
					<div>
						<button
							type="button"
							className="btn btn-primary"
							disabled={creating}
							onClick={() => create(null)}
						>
							{creating ? "Creating…" : "Create Work"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
