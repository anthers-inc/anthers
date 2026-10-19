// SPDX-License-Identifier: Apache-2.0
/**
 * The **New Post** builder — create, and only create.
 *
 * 🚨 **There is no edit form any more** (Parker, 2026-10-16): editing a post happens on
 * the post's own page, the same place every user reads it — the unified surface every
 * kind's Work page ran on first (`OwnerWorkEditor.tsx` carries that pattern's ruling).
 * The `/studio/posts/:slug/edit` address a bookmark may hold redirects to the page this
 * once edited (`apps/web/src/studio/PostEditPage.tsx`).
 *
 * That also answers the three complaints the change came from: the edit page had no way
 * to the published post, the edit page and the view page were two totally separate
 * surfaces, and a landing on it made a posted item look not-posted. The page everything
 * sources from is the viewable one, and the creator's view is that page with pencils in
 * it.
 *
 * Sections: Basics (title + body + project attach), Publish (schedule + draft/publish).
 * Pinning is not a create-time control any more: a creator pins the post they want featured
 * from the post's own page, where the one-pin rule can name the post it would replace. A post carries NO linked-Works field (Parker, 2026-10-16): you put a
 * Work's link in the body and the page renders the card for it under the text, the way a
 * Bluesky post renders an embedded player for the link it carries. There is no Access
 * section: a post is an announcement — it carries a body, some links and nothing
 * gateable. Delivery and access are edited on the **Work**, in the Catalog.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import RichTextEditor from "../components/editor/RichTextEditor";
import FormField from "../components/ui/FormField";
import { usePayoutsReady } from "../lib/payouts";
import { tagsFromBodyHtml } from "../lib/post-tags";
import { postUrl } from "../lib/postUrl";
import { usePublishingPermissionMissing } from "../lib/publishing";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioUrl } from "../lib/studio";
import type { Post, Project } from "../lib/types";

/** Best-effort extraction of an { error } message from a non-ok JSON response. */
function errorMessage(data: unknown, fallback: string): string {
	if (data && typeof data === "object" && "error" in data) {
		const err = (data as { error: unknown }).error;
		if (typeof err === "string") return err;
	}
	return fallback;
}

export default function PostFormPage() {
	const navigate = useNavigate();

	// ── Basics ──
	const [title, setTitle] = useState("");
	// One body, held as the editor's HTML and converted to markdown at the API's write
	// boundary — the stored, canonical form. Nothing else about the body is sent.
	const [bodyHtml, setBodyHtml] = useState("");
	const [projectId, setProjectId] = useState<string>("");
	const [projects, setProjects] = useState<Project[]>([]);

	// ── Publish ──
	// Optional auto-publish time (datetime-local string). Non-empty = scheduled draft.
	const [scheduledFor, setScheduledFor] = useState<string>("");

	const payoutsReady = usePayoutsReady();
	const permissionMissing = usePublishingPermissionMissing();
	/** Going live is refused for either, so neither is offered. */
	const goLiveBlocked = payoutsReady === false || permissionMissing === true;

	// ── UI ──
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Publishing is no longer blocked by a linked Work still encoding. Readiness belongs to
	// the media, the media belongs to the Work, and an announcement has nothing to wait for
	// — the gate moved to releasing the Work.
	const isScheduling = scheduledFor.trim() !== "";

	/**
	 * The creator's Projects, for the attach-on-create select.
	 *
	 * ⚠️ On mount rather than on focus. It used to fetch from `onFocus` and `onMouseDown`,
	 * which meant the options existed only if the control was pointed at first — a keyboard
	 * user tabbing through and a screen reader announcing the list both met "No project" and
	 * nothing else, with no request in flight to explain it.
	 */
	useEffect(() => {
		let live = true;
		client.api.content.projects
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((data) => {
				if (live) setProjects((data as { projects: Project[] }).projects ?? []);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	const handleBodyChange = (html: string) => {
		setBodyHtml(html);
	};

	const handleSubmit = async (publish: boolean) => {
		setSaving(true);
		setError(null);

		const base = {
			title,
			bodyHtml,
			tags: tagsFromBodyHtml(bodyHtml),
			isPublished: publish,
			// Publishing now clears any schedule; otherwise persist the chosen auto-publish time.
			scheduledFor: publish || !scheduledFor ? null : new Date(scheduledFor).toISOString(),
		};

		// After save: the post's page — for either kind of save. A draft's owner view is
		// the same page with the Draft badge and the Publish button on it; the viewable
		// version is the source of everything now.
		try {
			const json = projectId ? { ...base, projectId: Number(projectId) } : base;
			const res = await client.api.content.posts.$post({ json });
			if (!res.ok) {
				setError(errorMessage(await res.json(), "Failed to create post."));
				return;
			}
			const { post } = (await res.json()) as { post: Post };
			navigate(postUrl(post));
		} catch {
			setError("Failed to create post.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">New Post</h1>

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
							The URL slug is generated from the title, and follows it when the title changes.
						</p>
					</FormField>

					<FormField label="Body">
						<RichTextEditor
							content={bodyHtml}
							onChange={handleBodyChange}
							placeholder="Write your post... (use #tags to categorize)"
						/>
						<p className="text-xs text-base-content/50 mt-1">
							Shown to anyone who can see the post. To feature a Work here, put its link in the text
							— the card rides under it.
						</p>
					</FormField>

					<FormField
						label="Project (optional)"
						hint="Attach this post to one of your Projects. You can move it later from the Project itself."
					>
						<select
							className="select select-bordered w-full"
							value={projectId}
							onChange={(e) => setProjectId(e.target.value)}
						>
							<option value="">No project</option>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.title}
								</option>
							))}
						</select>
					</FormField>
				</section>

				{/* ── 2. Publish ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-6">
					<h2 className="text-lg font-semibold">Publish</h2>

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

					{permissionMissing === true && (
						<div className="alert alert-warning text-sm">
							<span>
								<strong>Give Anthers permission to publish first.</strong> A post is written into
								your own repository when it goes out, and Anthers doesn't have your permission to do
								that. You can keep this as a draft until then.{" "}
								<Link to={studioUrl("/payments")} className="link">
									Give it in the Studio's Payments tab
								</Link>
								.
							</span>
						</div>
					)}

					{payoutsReady === false && (
						<div className="alert alert-warning text-sm">
							<span>
								<strong>Set up payouts before publishing.</strong> A post can be paid for with
								Stickers, and payout setup is also what lets us say every creator here is an adult.
								You can keep this as a draft until then.{" "}
								<Link to={studioUrl("/payments")} className="link">
									Set it up in the Studio's Payments tab
								</Link>
								.
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
								disabled={saving || goLiveBlocked}
							>
								{saving ? "Saving..." : "Schedule"}
							</button>
						) : (
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => handleSubmit(true)}
								disabled={saving || goLiveBlocked}
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
