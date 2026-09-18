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
 * Used in two places: the Upload page at `/studio/works/new`, and `QuickWorkCreate` inside the
 * Work picker. ⚠️ **Don't grow either copy into a second editor** — everything past these three
 * inputs belongs to the Work's page.
 */

import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { client } from "../../lib/rpc";
import type { ContentType, Work, WorkInput } from "../../lib/types";
import { workUploads } from "../../lib/work-uploads";
import { serializeSeedRows } from "../post/AccessTables";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";
import { fileRules, isFileWorkType } from "./work-media";
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
	/**
	 * Where the creator ends up. The Upload page moves them to the Work's page, while the picker's
	 * dialog hands the Work back to the post they are writing, and the copy has to say which.
	 */
	next?: "page" | "stay";
}

export default function WorkUploadForm({ onCreated, next = "page" }: WorkUploadFormProps) {
	const [type, setType] = useState<ContentType>("video");
	const [title, setTitle] = useState("");
	const [platform, setPlatform] = useState("windows");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const create = async (file: File | null) => {
		setCreating(true);
		setError(null);
		const input: WorkInput & { type: ContentType } = {
			type,
			title: title.trim() || (file ? titleFromFileName(file.name) : ""),
			seedAccess: serializeSeedRows([{ threshold: 0, label: "Everyone", allow: true, price: "0" }]),
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
			if (file && isFileWorkType(type)) {
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

			<FormField
				label="Type"
				hint={
					// The one moment a creator chooses between a piece of writing and a post, and the
					// only place the difference can still be acted on without writing it twice.
					type === "text"
						? "Writing is written on its own page and reads as an article. Like any Work it can be gated, sold or given away; for an announcement, write a post instead."
						: undefined
				}
			>
				<select
					className="select select-bordered w-full"
					value={type}
					disabled={creating}
					onChange={(e) => setType(e.target.value as ContentType)}
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
					isFileWorkType(type) || isBuildType(type)
						? `Leave it blank to use the file's name. You can change it ${next === "page" ? "on the next page" : "on the Work's own page"}.`
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
				<FormField
					label="File"
					hint={
						next === "page"
							? "Choosing the file adds this Work to your Catalog, privately, and takes you to its page to fill in the rest while it uploads."
							: "Choosing the file adds this Work to your Catalog, privately, and attaches it here while it uploads."
					}
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
			)}

			{isBuildType(type) && (
				<>
					<FormField label="Platform">
						<select
							className="select select-bordered w-full"
							value={platform}
							disabled={creating}
							onChange={(e) => setPlatform(e.target.value)}
						>
							{BUILD_PLATFORMS.map((p) => (
								<option key={p.value} value={p.value}>
									{p.label}
								</option>
							))}
						</select>
					</FormField>
					<FormField
						label="Build (optional)"
						hint={`A build you add here becomes this Work's primary download. More builds, and a browser build hosted on another site, are added ${next === "page" ? "on the next page" : "on the Work's own page"}.`}
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

			{!isFileWorkType(type) && !isBuildType(type) && (
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
			)}
		</div>
	);
}
