// SPDX-License-Identifier: Apache-2.0
/**
 * A **Project's editing surface, on the Project's own page** — the pattern Parker set in
 * motion on the Work page (`OwnerWorkEditor`) and extended to Projects 2026-10-17: the
 * creator and any user see the SAME page, and the creator's edit controls live inline in
 * the very places the user sees the result.
 *
 * ⭐ **The Studio ends at the Projects list.** Editing one Project happens on its page,
 * which is a place users can see; what a user never sees is the studio edit route, which
 * folds away to a redirect, and the editable shelves below — working lists, the same
 * exemption a Work's Manage tab carries.
 *
 * Every editable thing is an `InlineField` — pencil opens it, X cancels, checkmark saves
 * the field alone; there is no page-wide Save. The one deliberate exception is the
 * cover, which acts on its read state (upload and remove are the acts a Work page's
 * thumbnail field carries; there is no pencil and no separate edit state to save).
 *
 * ⚠️ **Saves are narrow, one field per request, and adopt the response.** The server's
 * own rules answer in their own words — the publish refusal most of all — and a field's
 * error shows where the field lives. The cover's change is checked server-side against
 * the creator's own storage prefix, as every stored file reference is.
 */

import ProjectPosts from "@anthers/web-shared/content/ProjectPosts";
import ProjectWorks from "@anthers/web-shared/content/ProjectWorks";
import { RecordLinkButton } from "@anthers/web-shared/content/RecordLink";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import { uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import { publishingPermissionMissing, usePublishingState } from "@anthers/web-shared/publishing";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type { Project } from "@anthers/web-shared/types";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineField } from "../work/Editing";
import { WorkViewAsRow } from "../work/ViewAs";

export default function OwnerProjectEditor({
	project,
	onAdopt,
}: {
	project: Project;
	/** A field save's answer is the row the page now shows; the page merges it in. */
	onAdopt: (row: Omit<Project, "works" | "posts" | "creator">) => void;
}) {
	// The cover, as the row holds it — the read state the upload and remove acts write.
	const [coverImage, setCoverImage] = useState(project.coverImage ?? "");
	const [coverError, setCoverError] = useState<string | null>(null);
	const [coverBusy, setCoverBusy] = useState(false);

	const payoutsReady = usePayoutsReady();
	const publishing = usePublishingState();
	const permissionMissing = publishingPermissionMissing(publishing);

	const saveFields = async (fields: {
		title?: string;
		description?: string;
		shortDescription?: string;
		coverImage?: string;
		isPublished?: boolean;
	}): Promise<void> => {
		const res = await client.api.content.projects[":slug"].$patch({
			param: { slug: project.slug },
			json: fields,
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? "Failed to save this Project.");
		}
		const { project: updated } = await res.json();
		onAdopt(updated);
	};

	// The cover acts on its read state: upload settles into a save, remove saves empty.
	const uploadCover = async (file: File) => {
		setCoverError(null);
		setCoverBusy(true);
		try {
			const { url } = await uploadImageFile(file, "cover");
			setCoverImage(url);
			await saveFields({ coverImage: url });
		} catch (err) {
			setCoverError(err instanceof Error ? err.message : "The image didn't upload. Try it again.");
		} finally {
			setCoverBusy(false);
		}
	};

	// Published, as the row holds it — the toggle's disabled state reads the SAVED value,
	// because the gates are on the transition into published, never on editing what is one.
	const isPublished = project.isPublished === true;
	const publishBlocked = !isPublished && (payoutsReady === false || permissionMissing === true);

	const removeCover = async () => {
		setCoverError(null);
		setCoverBusy(true);
		try {
			setCoverImage("");
			await saveFields({ coverImage: "" });
		} catch (err) {
			setCoverError(err instanceof Error ? err.message : "Couldn't remove the cover just now.");
		} finally {
			setCoverBusy(false);
		}
	};

	return (
		<div className="container mx-auto px-4 py-8 max-w-5xl">
			{/* The View As row stands where the Studio route's redirect left the creator: the
			    page itself is the edit surface, and the modes are the ways to look at it. */}
			<div className="mb-4 flex flex-col gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wide text-base-content/40">
					View As
				</h3>
				<WorkViewAsRow subject="Project" />
			</div>

			{/* The cover — the user's hero, with the acts on it. The blank frame holds the
			    page's shape while no cover exists, as the Work page's thumbnail does. */}
			{coverImage ? (
				<div className="w-full h-56 md:h-72 overflow-hidden rounded-lg mb-6">
					<img src={coverImage} alt={project.title} className="w-full h-full object-cover" />
				</div>
			) : (
				<div
					aria-hidden="true"
					className="mb-6 flex h-56 md:h-72 items-center justify-center rounded-lg border border-dashed border-base-content/25 bg-base-200/30 text-base-content/25"
				>
					<PhotoIcon className="h-8 w-8" />
				</div>
			)}
			<div className="mb-6 flex flex-wrap items-center gap-2">
				<label className={`btn btn-outline btn-sm ${coverBusy ? "btn-disabled" : ""}`}>
					Upload an image
					<input
						type="file"
						accept="image/*"
						className="hidden"
						disabled={coverBusy}
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) void uploadCover(file);
						}}
					/>
				</label>
				{coverImage && (
					<button
						type="button"
						className="btn btn-ghost btn-sm text-error"
						disabled={coverBusy}
						onClick={() => void removeCover()}
					>
						Remove
					</button>
				)}
				{coverError && <p className="text-xs text-error">{coverError}</p>}
			</div>

			{/* Title — centered read like the public page's h1, pencil beside it. */}
			<div className="mb-2 flex flex-col gap-1">
				<InlineField<string>
					label="Title"
					saved={project.title}
					renderRead={() => <h1 className="text-3xl font-bold">{project.title}</h1>}
					renderEdit={(draft, setDraft) => (
						<input
							type="text"
							aria-label="Title"
							className="input input-bordered w-full text-xl"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
						/>
					)}
					save={(draft) => {
						const trimmed = draft.trim();
						if (!trimmed) throw new Error("A Project needs a title.");
						return saveFields({ title: trimmed });
					}}
				/>
				{project.creator && (
					<p className="text-sm text-base-content/70">
						by {project.creator.displayName || project.creator.handle}
					</p>
				)}
			</div>

			{/* The tagline, then the description — each field its own pencil, each read the
			    user's version rendered. An empty field says it is here. */}
			<div className="mb-4 flex flex-col gap-3">
				<InlineField<string>
					label="Tagline"
					saved={project.shortDescription ?? ""}
					renderRead={() =>
						project.shortDescription ? (
							<p className="text-sm text-base-content/70">{project.shortDescription}</p>
						) : (
							<p className="text-sm text-base-content/40">No tagline yet.</p>
						)
					}
					renderEdit={(draft, setDraft) => (
						<input
							type="text"
							aria-label="Tagline"
							className="input input-bordered input-sm w-full"
							value={draft}
							maxLength={300}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="A brief tagline for this project"
						/>
					)}
					save={(draft) => saveFields({ shortDescription: draft.trim() })}
				/>
				<InlineField<string>
					label="Description"
					saved={project.description ?? ""}
					renderRead={() =>
						project.description ? (
							<div className="prose prose-sm max-w-none">
								<Markdown remarkPlugins={[remarkGfm]}>{project.description}</Markdown>
							</div>
						) : (
							<p className="text-sm text-base-content/40">No description yet.</p>
						)
					}
					renderEdit={(draft, setDraft) => (
						<textarea
							aria-label="Description"
							className="textarea textarea-bordered w-full min-h-[150px]"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="Full description of this project (Markdown supported)"
						/>
					)}
					save={(draft) => saveFields({ description: draft.trim() })}
				/>
			</div>

			{/* The project's listing on the network — the same record link the hero carried,
			    placed after the fields so the editing form reads in one column. */}
			<div className="mb-6">
				<RecordLinkButton recordUrl={project.recordUrl} />
			</div>

			{/* Publish, as the release field is for a Work: the read of what is stored, the
			    toggle behind the pencil, and the server's refusals said in place. */}
			<div className="mb-8">
				<InlineField
					label="Publish"
					saved={isPublished}
					renderRead={() => (
						<p className="text-sm">
							{isPublished
								? "Published — this Project is visible to everyone."
								: "Unpublished — a draft only you can read."}
						</p>
					)}
					renderEdit={(draft, setDraft) => (
						<div className="flex flex-col gap-2">
							<label className="label cursor-pointer justify-start gap-3">
								<input
									type="checkbox"
									aria-label="Publish this Project"
									className="toggle toggle-primary"
									checked={Boolean(draft)}
									disabled={publishBlocked}
									onChange={(e) => setDraft(e.target.checked)}
								/>
								<span className="label-text text-sm font-medium">Published</span>
							</label>
							{permissionMissing === true && (
								<p className="text-xs text-warning">
									Give Anthers permission to publish in{" "}
									<Link to={studioUrl("/settings")} className="link">
										Studio settings
									</Link>{" "}
									before publishing, since a project is written into your own repository. You can
									keep building the project as a draft until then.
								</p>
							)}
							{payoutsReady === false && (
								<p className="text-xs text-warning">
									Set up payouts in{" "}
									<Link to={studioUrl("/payments")} className="link">
										the Studio's Payments tab
									</Link>{" "}
									before publishing. You can keep building the project as a draft until then.
								</p>
							)}
							<p className="text-xs text-base-content/50">
								Published projects are visible to everyone
							</p>
						</div>
					)}
					save={(draft) => saveFields({ isPublished: Boolean(draft) })}
				/>
			</div>

			{/* The shelves — the working lists on the creator's copy of the page. A Work's
			    member posts shelf says the same in fewer words; the works shelf's docblock
			    carries the persist-per-act ruling. */}
			<div className="mb-8">
				<h2 className="font-semibold text-sm mb-1">Works</h2>
				<p className="text-xs text-base-content/50 mb-3">
					The Works on this Project's shelf, in order. Putting one here changes nothing about who
					can open it.
				</p>
				<ProjectWorks projectSlug={project.slug} />
			</div>

			<div className="mb-8">
				<h2 className="font-semibold text-sm mb-1">Posts</h2>
				<p className="text-xs text-base-content/50 mb-3">
					The posts about this Project, in order — its devlogs, patch notes and announcements.
				</p>
				<ProjectPosts projectSlug={project.slug} />
			</div>
		</div>
	);
}
