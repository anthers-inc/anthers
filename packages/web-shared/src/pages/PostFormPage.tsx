// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * New / Edit Post builder. Three sections: Basics (title + body + timeline + project),
 * Linked Works, and Publish (pin + schedule + draft/publish).
 *
 * There is no Access section any more, and that absence is the point. A post is an
 * announcement: it carries a body, some links and nothing gateable, so there is nothing
 * here to price or gate. Delivery and access are edited on the **Work**, in the Catalog,
 * where the thing being gated actually lives. Tags are parsed from `#hashtag` tokens in
 * the body on save.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import RichTextEditor from "../components/editor/RichTextEditor";
import PostWorkLinks from "../components/post/PostWorkLinks";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { postUrl } from "../lib/postUrl";
import { client } from "../lib/rpc";
import { studioEditPostUrl, studioUrl } from "../lib/studio";
import type { Post, Project, Work } from "../lib/types";

/** Parse `#hashtag` tokens out of the body text into a deduped tag list. */
function parseTags(text: string): string[] {
	const set = new Set<string>();
	for (const m of text.matchAll(/#([\p{L}0-9_-]+)/gu)) set.add(m[1]);
	return [...set];
}

/** ISO datetime → the local value an `<input type="datetime-local">` expects (no seconds). */
function isoToLocalInput(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

	// ── Linked Works (inert references — they confer no access) ──
	const [linkedWorks, setLinkedWorks] = useState<Work[]>([]);

	// ── Publish ──
	const [isPinned, setIsPinned] = useState(false);
	// Optional auto-publish time (datetime-local string). Non-empty = scheduled draft.
	const [scheduledFor, setScheduledFor] = useState<string>("");

	// ── UI ──
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Publishing is no longer blocked by a linked Work still encoding. Readiness belongs to
	// the media, the media belongs to the Work, and an announcement has nothing to wait for
	// — the gate moved to releasing the Work.
	const isScheduling = scheduledFor.trim() !== "";

	// Initial load: the post being edited.
	useEffect(() => {
		let cancelled = false;
		(async () => {
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
					setIsPinned(post.isPinned);
					setScheduledFor(isoToLocalInput(post.scheduledFor));
					setLinkedWorks((post.linkedWorks ?? []).map((r) => r.work));
				} catch {
					if (!cancelled) setError("Failed to load post.");
				}
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
		setSaving(true);
		setError(null);

		const base = {
			title,
			body,
			bodyHtml,
			showOnTimeline,
			isPinned,
			tags: parseTags(body),
			isPublished: publish,
			// Publishing now clears any schedule; otherwise persist the chosen auto-publish time.
			scheduledFor: publish || !scheduledFor ? null : new Date(scheduledFor).toISOString(),
			workIds: linkedWorks.map((w) => w.id),
		};

		// After save: publish → the live post view; draft → stay in the Studio editor so they
		// can keep filling media. Both are ordinary in-app paths — the Studio stopped being a
		// separate origin on 2026-08-11, so there is no ConsumerRedirect hop any more.
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
				navigate(publish ? postUrl(post) : studioEditPostUrl(post.slug));
			} else {
				const json = projectId ? { ...base, projectId: Number(projectId) } : base;
				const res = await client.api.content.posts.$post({ json });
				if (!res.ok) {
					setError(errorMessage(await res.json(), "Failed to create post."));
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				navigate(publish ? postUrl(post) : studioEditPostUrl(post.slug));
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

				{/* ── 2. Linked Works ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-6">
					<div>
						<h2 className="text-lg font-semibold">Linked Works</h2>
						<p className="text-xs text-base-content/50">
							Anything from your Catalog this post is about. Optional — a post can be just words.
							Access and delivery are set on the Work itself, not here.
						</p>
					</div>
					<PostWorkLinks works={linkedWorks} onChange={setLinkedWorks} />
				</section>

				{/* ── 3. Publish ── */}
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

					<FormField label="Schedule publish (optional)">
						<div className="flex flex-wrap items-center gap-2">
							<input
								type="datetime-local"
								className="input input-bordered"
								value={scheduledFor}
								onChange={(e) => setScheduledFor(e.target.value)}
							/>
							{scheduledFor && (
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => setScheduledFor("")}
									disabled={saving}
								>
									Clear
								</button>
							)}
						</div>
						<p className="text-xs text-base-content/50 mt-1">
							{isScheduling
								? "Saved as a draft now; it publishes automatically at this time."
								: "Leave empty to publish immediately or keep as a plain draft."}
						</p>
					</FormField>

					{linkedWorks.some((w) => w.visibility === "private") && (
						<div className="alert alert-info">
							<span>
								This post links a Work you haven't released yet. Publishing is fine — the link
								simply won't open for anyone until you release it from your Catalog.
							</span>
						</div>
					)}

					<div className="flex flex-wrap gap-2 mt-2">
						<button
							type="button"
							className="btn btn-ghost"
							onClick={() => navigate(studioUrl("/"))}
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
						{isScheduling ? (
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => handleSubmit(false)}
								disabled={saving}
							>
								{saving ? "Saving..." : "Schedule"}
							</button>
						) : (
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => handleSubmit(true)}
								disabled={saving}
							>
								{saving ? "Saving..." : "Publish Post"}
							</button>
						)}
					</div>
				</section>
			</form>
		</div>
	);
}
