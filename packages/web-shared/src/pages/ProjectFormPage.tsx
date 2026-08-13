// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ProjectWorks from "../components/content/ProjectWorks";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { apiFetch, client } from "../lib/rpc";
import type { Project } from "../lib/types";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Upload a cover image via the direct endpoint; returns its public URL. */
async function uploadImage(file: File): Promise<string> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("mediaType", "cover");
	const res = await apiFetch("/api/content/media-upload/direct", {
		method: "POST",
		body: formData,
	});
	if (!res.ok) throw new Error("Image upload failed");
	const data = (await res.json()) as { key: string; url: string };
	return data.url;
}

/** Best-effort extraction of an { error } message from a non-ok JSON response. */
function errorMessage(data: unknown, fallback: string): string {
	if (data && typeof data === "object" && "error" in data) {
		const err = (data as { error: unknown }).error;
		if (typeof err === "string") return err;
	}
	return fallback;
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
	const [shortDescription, setShortDescription] = useState("");
	const [coverImage, setCoverImage] = useState("");
	const [coverPreview, setCoverPreview] = useState<string | null>(null);
	const [isPublished, setIsPublished] = useState(false);

	// UI state.
	const [loading, setLoading] = useState(isEdit);
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!isEdit || !slug) return;
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setError("Failed to load project.");
					return;
				}
				const { project } = (await res.json()) as { project: Project };
				setTitle(project.title);
				setProjectSlug(project.slug);
				setDescription(project.description || "");
				setShortDescription(project.shortDescription || "");
				setCoverImage(project.coverImage || "");
				setCoverPreview(project.coverImage);
				setIsPublished(project.isPublished ?? false);
			})
			.catch(() => setError("Failed to load project."))
			.finally(() => setLoading(false));
	}, [slug, isEdit]);

	// Auto-generate slug from the title on create until the user edits it.
	useEffect(() => {
		if (!slugManual && !isEdit) setProjectSlug(slugify(title));
	}, [title, slugManual, isEdit]);

	const handleCoverSelect = async (file: File) => {
		setCoverPreview(URL.createObjectURL(file));
		setUploading(true);
		setError(null);
		try {
			const url = await uploadImage(file);
			setCoverImage(url);
			setCoverPreview(url);
		} catch {
			setError("Cover image upload failed.");
		} finally {
			setUploading(false);
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);

		try {
			if (isEdit && slug) {
				const res = await client.api.content.projects[":slug"].$patch({
					param: { slug },
					json: { title, description, shortDescription, coverImage, isPublished },
				});
				if (!res.ok) {
					const data: unknown = await res.json();
					setError(errorMessage(data, "Failed to save project."));
					return;
				}
				const { project } = (await res.json()) as { project: Project };
				navigate(`/${user?.username ?? "me"}/${project.slug}`);
			} else {
				const res = await client.api.content.projects.$post({
					json: {
						title,
						slug: projectSlug,
						description,
						shortDescription,
						coverImage,
						isPublished,
					},
				});
				if (!res.ok) {
					const data: unknown = await res.json();
					setError(errorMessage(data, "Failed to create project."));
					return;
				}
				const { project } = (await res.json()) as { project: Project };
				navigate(`/${user?.username ?? "me"}/${project.slug}`);
			}
		} catch {
			setError("Failed to save project.");
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
			<h1 className="text-2xl font-bold mb-2">{isEdit ? "Edit Project" : "New Project"}</h1>
			<p className="text-sm text-base-content/60 mb-6">
				A Project groups related Works and Posts — an album and its tracks, a game and its devlogs,
				a book and its chapters. Add and reorder them after creating it.
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

				{!isEdit && (
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
							URL: /{user?.username ?? "you"}/{projectSlug || "..."}
						</p>
					</FormField>
				)}

				<FormField label="Short Description">
					<input
						type="text"
						className="input input-bordered w-full"
						value={shortDescription}
						onChange={(e) => setShortDescription(e.target.value)}
						maxLength={300}
						placeholder="A brief tagline for this project"
					/>
				</FormField>

				<FormField label="Description">
					<textarea
						className="textarea textarea-bordered w-full min-h-[150px]"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Full description of this project (Markdown supported)"
					/>
				</FormField>

				<FormField label="Cover Image">
					<FileUpload
						accept="image/*"
						maxSize={10 * 1024 * 1024}
						preview={coverPreview}
						label="Upload cover image (recommended 630x500)"
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
						/>
						<div>
							<span className="label-text font-medium">Publish</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Published projects are visible to everyone
							</p>
						</div>
					</label>
				</div>

				{/*
				 * The shelf itself. Edit-only: every membership endpoint is keyed on the
				 * Project's slug, so there is nothing to attach a Work to until the Project
				 * exists — the same shape as "create the Work first, then add builds".
				 *
				 * Outside the form's save cycle by design; `ProjectWorks` persists each change
				 * on its own endpoint the moment it is made.
				 */}
				{isEdit && projectSlug && (
					<div className="border-t border-base-300 pt-4">
						<h2 className="font-semibold text-sm mb-1">Works</h2>
						<p className="text-xs text-base-content/50 mb-3">
							The Works on this Project's shelf, in order. Putting one here changes nothing about
							who can open it.
						</p>
						<ProjectWorks projectSlug={projectSlug} />
					</div>
				)}

				<div className="flex gap-2 mt-2">
					<button
						type="submit"
						className={`btn btn-primary ${saving || uploading ? "btn-disabled" : ""}`}
						disabled={saving || uploading}
					>
						{saving ? "Saving..." : isEdit ? "Update Project" : "Create Project"}
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => navigate("/")}>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}
