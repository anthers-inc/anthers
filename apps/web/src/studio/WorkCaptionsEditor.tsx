// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's captions editor for a video Work — one track per language per kind, whose
 * rows the access-checked captions route serves the moment the viewer can reach the Work.
 *
 * The flow is the platform's standard two-step attach: upload the `.vtt` through the
 * caption branch of `media-upload/direct`, then attach it with its language tag, and the
 * server's parse is the ingest gate (`services/captions.ts`) — a file that is not a
 * caption file reads back as a specific refusal here rather than ever becoming a served
 * track. Re-uploading a language replaces that language's track the way a thumbnail
 * replace does, so there is deliberately no separate edit surface and no way for two
 * tracks in one language to disagree.
 *
 * A released Work may gain captions — unlike source files, which freeze at release —
 * because this is precisely the accessibility work that happens after somebody pressed
 * publish, and none of it is the deliverable itself.
 */

import { apiFetch, client } from "@anthers/web-shared/rpc";
import type { WorkCaptionTrack } from "@anthers/web-shared/types";
import { useRef, useState } from "react";

interface WorkCaptionsEditorProps {
	workId: number;
	captions: WorkCaptionTrack[];
	/** A track landed or left — the page re-reads the row's media payload, so the preview player (if it is open) gains the menu. */
	onChanged?: () => void;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

export default function WorkCaptionsEditor({
	workId,
	captions,
	onChanged,
}: WorkCaptionsEditorProps) {
	const [tracks, setTracks] = useState<WorkCaptionTrack[]>(captions);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [language, setLanguage] = useState("");
	const [label, setLabel] = useState("");
	const [kind, setKind] = useState<"captions" | "subtitles">("captions");
	const fileInput = useRef<HTMLInputElement>(null);

	const attach = async () => {
		if (!file) return;
		const lang = language.trim() || (file.name.match(/^([a-zA-Z-]{2,12})[_.]/)?.[1] ?? "en");
		setBusy(true);
		setError(null);
		try {
			const form = new FormData();
			form.append("file", file);
			form.append("mediaType", "caption");
			form.append("entityId", String(workId));
			const uploadRes = await apiFetch("/api/content/media-upload/direct", {
				method: "POST",
				body: form,
			});
			if (!uploadRes.ok) {
				throw new Error("The upload itself failed — try the file again.");
			}
			const { key } = (await uploadRes.json()) as { key: string };
			const res = await client.api.content.works[":id"].captions.$post({
				param: { id: String(workId) },
				json: { key, language: lang, label: label.trim() || "", kind },
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "The file was refused.");
			}
			const { caption } = (await res.json()) as { caption: WorkCaptionTrack };
			// Replacing a language: the server drops the old row, so the list is every
			// other track plus the new one.
			setTracks((prev) => [
				...prev.filter((t) => !(t.language === caption.language && t.kind === caption.kind)),
				caption,
			]);
			setFile(null);
			if (fileInput.current) fileInput.current.value = "";
			setLanguage("");
			setLabel("");
			setKind("captions");
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong attaching the track.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (trackId: number) => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].captions[":trackId"].$delete({
				param: { id: String(workId), trackId: String(trackId) },
			});
			if (!res.ok) throw new Error("The track could not be removed.");
			const { captions: remaining } = (await res.json()) as { captions: WorkCaptionTrack[] };
			setTracks(remaining);
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong removing the track.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			data-testid="captions-editor"
			className="rounded-box border border-base-300 bg-base-200/40 p-5"
		>
			<header className="mb-2 flex items-baseline justify-between gap-4">
				<h3 className="font-semibold">Captions</h3>
				<p className="text-xs opacity-60">
					A WebVTT file per language. Deaf and hard-of-hearing viewers, and the player's CC menu,
					get them as soon as they are here.
				</p>
			</header>

			{tracks.length > 0 && (
				<ul className="mb-3 divide-y divide-base-300 text-sm">
					{tracks.map((t) => (
						<li
							key={t.id}
							className="flex items-center gap-3 py-2"
							data-testid={`caption-row-${t.language}`}
						>
							<span className="font-mono text-xs">{t.language}</span>
							<span className="flex-1 truncate">{t.label || t.language}</span>
							<span className="text-xs opacity-60">
								{t.kind === "subtitles" ? "subtitles" : "captions"} ·{" "}
								{t.cueCount != null ? `${t.cueCount} cues` : ""}
							</span>
							<span className="text-xs opacity-60">
								{t.byteSize != null ? formatBytes(t.byteSize) : ""}
							</span>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								disabled={busy}
								onClick={() => void remove(t.id)}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap items-end gap-2">
				<div>
					<label
						htmlFor="caption-file"
						className="mb-1 block text-[10px] font-semibold uppercase tracking-wider opacity-60"
					>
						File (.vtt)
					</label>
					<input
						id="caption-file"
						ref={fileInput}
						type="file"
						accept=".vtt,text/vtt"
						className="file-input file-input-bordered file-input-sm w-full max-w-xs"
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					/>
				</div>
				<div className="w-24">
					<label
						htmlFor="caption-language"
						className="mb-1 block text-[10px] font-semibold uppercase tracking-wider opacity-60"
					>
						Language
					</label>
					<input
						id="caption-language"
						type="text"
						className="input input-bordered input-sm w-full"
						placeholder="en"
						value={language}
						onChange={(e) => setLanguage(e.target.value)}
					/>
				</div>
				<div className="w-44">
					<label
						htmlFor="caption-label"
						className="mb-1 block text-[10px] font-semibold uppercase tracking-wider opacity-60"
					>
						Label (optional)
					</label>
					<input
						id="caption-label"
						type="text"
						className="input input-bordered input-sm w-full"
						placeholder="English"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</div>
				<div className="w-36">
					<label
						htmlFor="caption-kind"
						className="mb-1 block text-[10px] font-semibold uppercase tracking-wider opacity-60"
					>
						Kind
					</label>
					<select
						id="caption-kind"
						className="select select-bordered select-sm w-full"
						value={kind}
						onChange={(e) => setKind(e.target.value === "subtitles" ? "subtitles" : "captions")}
					>
						<option value="captions">Captions</option>
						<option value="subtitles">Subtitles</option>
					</select>
				</div>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					disabled={busy || !file}
					onClick={() => void attach()}
				>
					{busy ? <span className="loading loading-spinner loading-xs" /> : null}
					{busy ? "Working…" : "Attach track"}
				</button>
			</div>

			{error && (
				<p role="alert" className="mt-2 text-xs text-error">
					{error}
				</p>
			)}
		</section>
	);
}
