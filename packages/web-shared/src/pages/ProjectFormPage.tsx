// SPDX-License-Identifier: Apache-2.0
/**
 * The **creation** form for a Project — one route, `/studio/projects/new`, and the only
 * screen left at which a Project is built rather than seen (the unified-editor pass,
 * 2026-10-17). Editing happens on the Project's own page, where the shelves and the
 * pencilled fields live; this route's edit form folded away to the redirect below.
 *
 * Why creation stays a form at all: every membership endpoint is keyed on the Project's
 * slug, so there is nothing to attach a Work to until the Project exists — the same
 * shape as "create the Work first, then add builds". Creating lands on the new public
 * page, which is the editor.
 */

import { THUMBNAIL_RULE } from "@anthers/shared/content";
import type { ImageCrop } from "@anthers/shared/image-frame";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { frameImageFile, uploadImageFile } from "../components/post/mediaUpload";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import ImageFrameModal from "../components/ui/ImageFrameModal";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { usePayoutsReady } from "../lib/payouts";
import { creatorProjectUrl } from "../lib/profile";
import { usePublishingPermissionMissing } from "../lib/publishing";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioUrl } from "../lib/studio";
import type { Project } from "../lib/types";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Best-effort extraction of an { error } message from a non-ok JSON response. */
function errorMessage(data: unknown, fallback: string): string {
	if (data && typeof data === "object" && "error" in data) {
		const err = (data as { error: unknown }).error;
		if (typeof err === "string") return err;
	}
	return fallback;
}

/**
 * The edit route's redirect. The old editor lives on the Project's page now, so arriving
 * here means arriving a step late: the page is fetched enough to resolve the public URL
 * and the creator is sent on — the Work edit route's shape, applied.
 */
function ProjectEditRedirect({ slug }: { slug: string }) {
	const navigate = useNavigate();
	const { user } = useAuth();
	const [redirecting, setRedirecting] = useState(true);

	useEffect(() => {
		let live = true;
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) throw new Error("not found");
				const { project } = (await res.json()) as { project: Project };
				if (live)
					navigate(
						creatorProjectUrl(project.creator?.handle ?? user?.handle ?? "me", project.slug),
						{
							replace: true,
						},
					);
			})
			.catch(() => {})
			.finally(() => live && setRedirecting(false));
		return () => {
			live = false;
		};
	}, [slug, navigate, user?.handle]);

	if (!redirecting) {
		return (
			<div className="max-w-3xl mx-auto px-4 py-8">
				<p className="text-sm text-base-content/60">
					Couldn't find that Project, or it isn't yours. Projects are edited on their own page.
				</p>
			</div>
		);
	}
	return (
		<div className="flex justify-center py-16">
			<LoadingSpinner size="lg" />
		</div>
	);
}

export default function ProjectFormPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const { user } = useAuth();
	const isEdit = Boolean(slug);

	// Project metadata.
	const [title, setTitle] = useState("");
	const [projectSlug, setProjectSlug] = useState("");
	const [slugManual, setSlugManual] = useState(false);
	const [description, setDescription] = useState("");
	const [coverImage, setCoverImage] = useState("");
	/** The full upload the image was framed from, so the Project page can reposition it later. */
	const [coverSource, setCoverSource] = useState("");
	/** The window it was framed at, so a later reposition reopens there. */
	const [coverCrop, setCoverCrop] = useState<ImageCrop | null>(null);
	const [coverPreview, setCoverPreview] = useState<string | null>(null);
	const [isPublished, setIsPublished] = useState(false);
	const payoutsReady = usePayoutsReady();
	const permissionMissing = usePublishingPermissionMissing();

	// UI state.
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Auto-generate slug from the title on create until the user edits it.
	useEffect(() => {
		if (!slugManual) setProjectSlug(slugify(title));
	}, [title, slugManual]);

	// A chosen file is framed before it is stored: the dialog's save uploads the full source,
	// asks the server for the 2:1 derivative and keeps both.
	const [framing, setFraming] = useState<{ preview: string; file: File } | null>(null);

	const handleCoverSelect = (file: File) => {
		setError(null);
		setFraming({ preview: URL.createObjectURL(file), file });
	};

	const closeFraming = () => {
		if (framing) URL.revokeObjectURL(framing.preview);
		setFraming(null);
	};

	const saveFramedCover = async (crop: { x: number; y: number; width: number; height: number }) => {
		if (!framing) return;
		setUploading(true);
		setError(null);
		try {
			const source = (await uploadImageFile(framing.file, "cover")).url;
			const framed = await frameImageFile(source, "cover", crop);
			setCoverImage(framed.url);
			setCoverSource(source);
			setCoverCrop(crop);
			setCoverPreview(framed.url);
			closeFraming();
		} catch (err) {
			setError(err instanceof Error ? err.message : "The thumbnail didn't upload. Try it again.");
		} finally {
			setUploading(false);
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.content.projects.$post({
				json: {
					title,
					slug: projectSlug,
					description,
					coverImage,
					coverSource,
					coverCrop,
					isPublished,
				},
			});
			if (!res.ok) {
				const data: unknown = await res.json();
				setError(errorMessage(data, "Failed to create project."));
				return;
			}
			const { project } = (await res.json()) as { project: Project };
			// Creating ends on the Project's own page — which is the editor now, shelves and
			// all. The old landing (the studio form) is the route that redirects away.
			navigate(creatorProjectUrl(user?.handle ?? "me", project.slug));
		} catch {
			setError("Failed to save project.");
		} finally {
			setSaving(false);
		}
	};

	// An edit URL is a redirect, not a form — the form below is creation's only.
	if (isEdit && slug) {
		return <ProjectEditRedirect slug={slug} />;
	}

	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">New Project</h1>
			<p className="text-sm text-base-content/60 mb-6">
				A Project groups related Works and Posts — an album and its tracks, a game and its devlogs,
				a book and its chapters. Create it here, then add and reorder both on its page.
			</p>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<FormField label="Title" required>
					<input
						type="text"
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="My Project"
					/>
				</FormField>

				<FormField label="Slug" required>
					<input
						type="text"
						className="input input-bordered w-full"
						value={projectSlug}
						onChange={(e) => {
							setProjectSlug(e.target.value);
							setSlugManual(true);
						}}
						placeholder="my-project"
					/>
					<p className="text-xs text-base-content/50 mt-1">
						URL: /@{user?.handle ?? "you"}/{projectSlug || "..."}
					</p>
				</FormField>

				<FormField label="Description">
					<textarea
						className="textarea textarea-bordered w-full min-h-[150px]"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Full description of this project (Markdown supported)"
					/>
				</FormField>

				{/* A Project's thumbnail shows in listings as a Work's does, so it is held to the same
				    rule. The column and the upload's media type are still called `cover`. */}
				<FormField label="Thumbnail" hint={THUMBNAIL_RULE}>
					<FileUpload
						accept="image/*"
						maxSize={10 * 1024 * 1024}
						preview={coverPreview}
						label="Upload a thumbnail (recommended 630x500)"
						onFileSelect={handleCoverSelect}
						onClear={() => {
							setCoverImage("");
							setCoverPreview(null);
						}}
					/>
				</FormField>

				<div className="form-control">
					<label className="label cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={isPublished}
							onChange={(e) => setIsPublished(e.target.checked)}
							disabled={payoutsReady === false || permissionMissing === true}
						/>
						<div>
							<span className="label-text font-medium">Publish</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Published projects are visible to everyone
							</p>
						</div>
					</label>
					{permissionMissing === true && (
						<p className="text-xs text-warning mt-1">
							Give Anthers permission to publish in{" "}
							<Link to={studioUrl("/settings")} className="link">
								Studio settings
							</Link>{" "}
							before publishing, since a project is written into your own repository. You can keep
							building the project as a draft until then.
						</p>
					)}
					{payoutsReady === false && (
						<p className="text-xs text-warning mt-1">
							Set up payouts in{" "}
							<Link to={studioUrl("/payments")} className="link">
								the Studio's Payments tab
							</Link>{" "}
							before publishing. You can keep building the project as a draft until then.
						</p>
					)}
				</div>

				<div className="flex gap-2 mt-2">
					<button
						type="submit"
						className={`btn btn-primary ${saving || uploading ? "btn-disabled" : ""}`}
						disabled={saving || uploading}
					>
						{saving ? "Saving..." : "Create Project"}
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => navigate(studioUrl("/"))}>
						Cancel
					</button>
				</div>
			</form>

			<ImageFrameModal
				open={framing !== null}
				src={framing?.preview ?? null}
				mediaType="cover"
				busy={uploading}
				error={error}
				onCancel={closeFraming}
				onSave={(crop) => void saveFramedCover(crop)}
			/>
		</div>
	);
}
