// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * New / Edit Post builder. Four sections: Basics (title + body + timeline + project),
 * Content (an ordered list of text blocks + references to library content items),
 * Access (stream/download + the Boost and Anthers access tables), and Publish
 * (pin + draft/publish).
 *
 * The post body is the always-visible rich text shown to anyone with visibility —
 * it is NOT the deliverable. The deliverable is the post-entry list. Tags are parsed
 * from `#hashtag` tokens in the body on save; the server derives contentType,
 * thumbnail, and read time.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import RichTextEditor from "../components/editor/RichTextEditor";
import AccessTables, {
	type AnthersRowDraft,
	type BoostRowDraft,
	buildAnthersRows,
	buildBoostRows,
	serializeAnthersRows,
	serializeBoostRows,
} from "../components/post/AccessTables";
import PostContentEditor, {
	draftFromPostEntry,
	type PostEntryDraft,
	serializePostEntry,
} from "../components/post/PostContentEditor";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { postUrl } from "../lib/postUrl";
import { client } from "../lib/rpc";
import type { CreatorGate, Post, Project } from "../lib/types";

/** Parse `#hashtag` tokens out of the body text into a deduped tag list. */
function parseTags(text: string): string[] {
	const set = new Set<string>();
	for (const m of text.matchAll(/#([\p{L}0-9_-]+)/gu)) set.add(m[1]);
	return [...set];
}

/** Best-effort extraction of an { error } message from a non-ok JSON response. */
function errorMessage(data: unknown, fallback: string): string {
	if (data && typeof data === "object" && "error" in data) {
		const err = (data as { error: unknown }).error;
		if (typeof err === "string") return err;
	}
	return fallback;
}

export default function PostFormPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const isEdit = Boolean(slug);

	// ── Basics ──
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [bodyHtml, setBodyHtml] = useState("");
	const [showOnTimeline, setShowOnTimeline] = useState(true);
	const [projectId, setProjectId] = useState<string>("");
	const [projects, setProjects] = useState<Project[]>([]);

	// ── Content ──
	const [entries, setEntries] = useState<PostEntryDraft[]>([]);

	// ── Access ──
	const [streamEnabled, setStreamEnabled] = useState(true);
	const [downloadEnabled, setDownloadEnabled] = useState(false);
	const [boostRows, setBoostRows] = useState<BoostRowDraft[]>([]);
	const [anthersRows, setAnthersRows] = useState<AnthersRowDraft[]>([]);

	// ── Publish ──
	const [isPinned, setIsPinned] = useState(false);

	// ── UI ──
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Physical/Service content forces download-only delivery.
	const forceDownloadOnly = entries.some(
		(e) => e.item?.type === "physical" || e.item?.type === "service",
	);

	useEffect(() => {
		if (forceDownloadOnly) {
			setStreamEnabled(false);
			setDownloadEnabled(true);
		}
	}, [forceDownloadOnly]);

	// Initial load: boost gates (for the Boost Access rows) + the post being edited.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			let boostGates: CreatorGate[] = [];
			try {
				const gatesRes = await client.api.subscriptions.gates.$get();
				if (gatesRes.ok) {
					const data = (await gatesRes.json()) as { gates: CreatorGate[] };
					boostGates = (data.gates ?? []).filter((g) => g.gateType === "boost");
				}
			} catch {
				// non-creator or no gates — fall through with an empty ladder
			}
			if (cancelled) return;

			if (isEdit && slug) {
				try {
					const res = await client.api.content.posts[":slug"].$get({ param: { slug } });
					if (!res.ok) {
						if (!cancelled) setError("Failed to load post.");
						return;
					}
					const { post } = (await res.json()) as { post: Post };
					if (cancelled) return;
					setTitle(post.title ?? "");
					setBody(post.body ?? "");
					setBodyHtml(post.bodyHtml ?? "");
					setShowOnTimeline(post.showOnTimeline);
					setStreamEnabled(post.streamEnabled);
					setDownloadEnabled(post.downloadEnabled);
					setIsPinned(post.isPinned);
					setEntries((post.contents ?? []).map(draftFromPostEntry));
					setBoostRows(buildBoostRows(boostGates, post.boostAccess));
					setAnthersRows(buildAnthersRows(post.anthersAccess));
				} catch {
					if (!cancelled) setError("Failed to load post.");
				}
			} else {
				setBoostRows(buildBoostRows(boostGates, null));
				setAnthersRows(buildAnthersRows(null));
			}
			if (!cancelled) setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [slug, isEdit]);

	const fetchProjects = () => {
		client.api.content.projects
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((data) => setProjects((data as { projects: Project[] }).projects ?? []))
			.catch(() => {});
	};

	const handleBodyChange = (html: string) => {
		setBodyHtml(html);
		const tmp = document.createElement("div");
		tmp.innerHTML = html;
		setBody(tmp.textContent || "");
	};

	const handleSubmit = async (publish: boolean) => {
		const stream = forceDownloadOnly ? false : streamEnabled;
		const download = forceDownloadOnly ? true : downloadEnabled;
		if (!stream && !download) {
			setError("Enable at least one access type (stream or download).");
			return;
		}
		setSaving(true);
		setError(null);

		const base = {
			title,
			body,
			bodyHtml,
			streamEnabled: stream,
			downloadEnabled: download,
			anthersAccess: serializeAnthersRows(anthersRows),
			boostAccess: serializeBoostRows(boostRows),
			showOnTimeline,
			isPinned,
			tags: parseTags(body),
			isPublished: publish,
			contents: entries
				.map(serializePostEntry)
				.filter((e): e is NonNullable<typeof e> => e !== null),
		};

		// After save: publish → the live post view (a separate origin on the Studio, which
		// ConsumerRedirect carries the creator to); draft → stay in the Studio editor so
		// they can keep filling media (E50 Phase 3 — authoring lives in the Studio, v1).
		try {
			if (isEdit && slug) {
				const res = await client.api.content.posts[":slug"].$patch({
					param: { slug },
					json: base,
				});
				if (!res.ok) {
					setError(errorMessage(await res.json(), "Failed to save post."));
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				navigate(publish ? postUrl(post) : `/posts/${post.slug}/edit`);
			} else {
				const json = projectId ? { ...base, projectId: Number(projectId) } : base;
				const res = await client.api.content.posts.$post({ json });
				if (!res.ok) {
					setError(errorMessage(await res.json(), "Failed to create post."));
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				navigate(publish ? postUrl(post) : `/posts/${post.slug}/edit`);
			}
		} catch {
			setError("Failed to save post.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">{isEdit ? "Edit Post" : "New Post"}</h1>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			<form
				onSubmit={(e) => {
					e.preventDefault();
				}}
				className="flex flex-col gap-8"
			>
				{/* ── 1. Basics ── */}
				<section className="flex flex-col gap-4">
					<h2 className="text-lg font-semibold">Basics</h2>

					<FormField label="Title">
						<input
							type="text"
							className="input input-bordered w-full"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Post title"
						/>
						<p className="text-xs text-base-content/50 mt-1">
							The URL slug is generated from the title automatically.
						</p>
					</FormField>

					<FormField label="Body">
						<RichTextEditor
							content={bodyHtml || body}
							onChange={handleBodyChange}
							placeholder="Write your post... (use #tags to categorize)"
						/>
						<p className="text-xs text-base-content/50 mt-1">
							Shown to anyone who can see the post. The deliverable is the Content section below.
						</p>
					</FormField>

					<label className="label cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={showOnTimeline}
							onChange={(e) => setShowOnTimeline(e.target.checked)}
						/>
						<span className="label-text">Show on Timeline</span>
					</label>

					{!isEdit && (
						<FormField label="Project (optional)">
							<select
								className="select select-bordered w-full"
								value={projectId}
								onFocus={fetchProjects}
								onMouseDown={fetchProjects}
								onChange={(e) => setProjectId(e.target.value)}
							>
								<option value="">No project</option>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.title}
									</option>
								))}
							</select>
							<p className="text-xs text-base-content/50 mt-1">
								Attach this post to one of your projects.
							</p>
						</FormField>
					)}
				</section>

				{/* ── 2. Content ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-6">
					<div>
						<h2 className="text-lg font-semibold">Content</h2>
						<p className="text-xs text-base-content/50">
							The deliverable — an ordered list of text blocks and attached library content. May be
							left empty for a body-only post.
						</p>
					</div>
					<PostContentEditor value={entries} onChange={setEntries} />
				</section>

				{/* ── 3. Access ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-6">
					<h2 className="text-lg font-semibold">Access</h2>

					<div>
						<h3 className="font-semibold text-sm mb-2">Access Type</h3>
						<div className="flex flex-wrap gap-6">
							<label
								className={`label justify-start gap-3 ${forceDownloadOnly ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
							>
								<input
									type="checkbox"
									className="checkbox checkbox-primary"
									checked={forceDownloadOnly ? false : streamEnabled}
									disabled={forceDownloadOnly}
									onChange={(e) => setStreamEnabled(e.target.checked)}
								/>
								<span className="label-text">Stream</span>
							</label>
							<label className="label cursor-pointer justify-start gap-3">
								<input
									type="checkbox"
									className="checkbox checkbox-primary"
									checked={forceDownloadOnly ? true : downloadEnabled}
									disabled={forceDownloadOnly}
									onChange={(e) => setDownloadEnabled(e.target.checked)}
								/>
								<span className="label-text">Download</span>
							</label>
						</div>
						{forceDownloadOnly && (
							<p className="text-xs text-base-content/50 mt-1">
								Physical / Service content is download-only; streaming is disabled.
							</p>
						)}
					</div>

					<AccessTables
						boostRows={boostRows}
						anthersRows={anthersRows}
						onBoostChange={setBoostRows}
						onAnthersChange={setAnthersRows}
					/>
				</section>

				{/* ── 4. Publish ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-6">
					<h2 className="text-lg font-semibold">Publish</h2>

					<label className="label cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-secondary"
							checked={isPinned}
							onChange={(e) => setIsPinned(e.target.checked)}
						/>
						<span className="label-text">Pin Post</span>
					</label>

					<div className="flex flex-wrap gap-2 mt-2">
						<button
							type="button"
							className="btn btn-ghost"
							onClick={() => navigate("/dashboard")}
							disabled={saving}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-outline"
							onClick={() => handleSubmit(false)}
							disabled={saving}
						>
							{saving ? "Saving..." : "Save as Draft"}
						</button>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => handleSubmit(true)}
							disabled={saving}
						>
							{saving ? "Saving..." : "Publish Post"}
						</button>
					</div>
				</section>
			</form>
		</div>
	);
}
