import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import RichTextEditor from "../components/editor/RichTextEditor";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { Post, Project } from "../lib/types";
import { uploadMediaFile } from "../lib/upload";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

type ContentType = "text" | "video" | "audio";
type Visibility = "public" | "subscribers_only" | "gated";

export default function PostFormPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const isEdit = Boolean(id);

	// Form state
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [bodyHtml, setBodyHtml] = useState("");
	const [contentType, setContentType] = useState<ContentType>("text");
	const [projectId, setProjectId] = useState<string>("");
	const [isPublished, setIsPublished] = useState(false);
	const [isPremium, setIsPremium] = useState(false);
	const [visibility, setVisibility] = useState<Visibility>("public");
	const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
	const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);

	// Media upload state
	const [mediaFile, setMediaFile] = useState<File | null>(null);
	const [uploadProgress, setUploadProgress] = useState(0);
	const [uploadedStorageKey, setUploadedStorageKey] = useState<string | null>(null);

	// UI state
	const [myProjects, setMyProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(isEdit);
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});

	useEffect(() => {
		fetch(apiBase + "/api/content/projects?mine=true", {
			credentials: "include",
		})
			.then((res) => res.json())
			.then((data: { projects: Project[] }) => setMyProjects(data.projects))
			.catch(() => {});

		if (isEdit && id) {
			client.api.content.posts[":id"]
				.$get({ param: { id } })
				.then((res) => res.json() as Promise<unknown>)
				.then((data: unknown) => {
					const post = (data as { post: Post }).post;
					setTitle(post.title || "");
					setBody(post.body || "");
					setBodyHtml(post.bodyHtml || "");
					setContentType(post.contentType as ContentType);
					setProjectId(post.projectId ? String(post.projectId) : "");
					setIsPublished(post.isPublished ?? false);
					setIsPremium(post.isPremium ?? false);
					setVisibility(post.visibility as Visibility);
					if (post.thumbnail) setThumbnailPreview(post.thumbnail);
				})
				.catch(() => setError("Failed to load post."))
				.finally(() => setLoading(false));
		}
	}, [id, isEdit]);

	const handleMediaSelect = async (file: File) => {
		setMediaFile(file);
		setUploadProgress(0);
		setUploading(true);
		setError(null);
		try {
			const key = await uploadMediaFile(file, contentType as "video" | "audio", setUploadProgress);
			setUploadedStorageKey(key);
		} catch (err) {
			setError(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
			setMediaFile(null);
		} finally {
			setUploading(false);
		}
	};

	const handleThumbnailSelect = (file: File) => {
		setThumbnailFile(file);
		setThumbnailPreview(URL.createObjectURL(file));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		setErrors({});

		try {
			const formData = new FormData();
			formData.append("title", title);
			formData.append("contentType", contentType);
			formData.append("visibility", visibility);
			formData.append("isPremium", String(isPremium));
			formData.append("isPublished", String(isPublished));
			if (projectId) formData.append("project", projectId);

			if (contentType === "text") {
				formData.append("body", body);
				formData.append("bodyHtml", bodyHtml);
			} else {
				// Optional description for media posts
				if (body) formData.append("body", body);
				if (bodyHtml) formData.append("bodyHtml", bodyHtml);
			}

			if (thumbnailFile) {
				formData.append("thumbnail", thumbnailFile);
			}

			// For media posts with uploaded file, set the file field
			if (contentType === "video" && uploadedStorageKey) {
				formData.append("videoFile", uploadedStorageKey);
			}
			if (contentType === "audio" && uploadedStorageKey) {
				formData.append("audioFile", uploadedStorageKey);
			}

			if (isEdit) {
				await fetch(`${apiBase}/api/content/posts/${id}`, {
					method: "PATCH",
					credentials: "include",
					body: formData,
				}).then((res) => {
					if (!res.ok) throw res;
					return res.json();
				});
			} else {
				await fetch(`${apiBase}/api/content/posts`, {
					method: "POST",
					credentials: "include",
					body: formData,
				}).then((res) => {
					if (!res.ok) throw res;
					return res.json();
				});
			}
			navigate("/dashboard");
		} catch (err) {
			if (err instanceof Response) {
				try {
					const data = await err.json();
					if (data && typeof data === "object") {
						const fieldErrors: Record<string, string> = {};
						for (const [key, val] of Object.entries(data as Record<string, string[]>)) {
							fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
						}
						setErrors(fieldErrors);
						return;
					}
				} catch {
					// Fall through
				}
			}
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

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				{/* Content type selector */}
				<FormField label="Content Type">
					<div className="flex gap-2">
						{(["text", "video", "audio"] as const).map((type) => (
							<button
								key={type}
								type="button"
								className={`btn btn-sm ${contentType === type ? "btn-primary" : "btn-outline"}`}
								onClick={() => {
									setContentType(type);
									setMediaFile(null);
									setUploadedStorageKey(null);
									setUploadProgress(0);
								}}
							>
								{type === "text" ? "Article" : type === "video" ? "Video" : "Audio"}
							</button>
						))}
					</div>
				</FormField>

				<FormField label="Title" error={errors.title}>
					<input
						type="text"
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Post title"
					/>
				</FormField>

				{/* Text content */}
				{contentType === "text" && (
					<FormField label="Content" required error={errors.bodyHtml || errors.body}>
						<RichTextEditor
							content={bodyHtml || body}
							onChange={(html) => {
								setBodyHtml(html);
								// Strip tags for plain text fallback
								const tmp = document.createElement("div");
								tmp.innerHTML = html;
								setBody(tmp.textContent || "");
							}}
							placeholder="Write your article..."
						/>
					</FormField>
				)}

				{/* Video upload */}
				{contentType === "video" && (
					<>
						<FormField label="Video File" required error={errors.videoFile}>
							{mediaFile ? (
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
										<span className="text-sm truncate flex-1">{mediaFile.name}</span>
										{uploading ? (
											<span className="text-xs font-mono">{uploadProgress}%</span>
										) : uploadedStorageKey ? (
											<span className="badge badge-success badge-sm">Uploaded</span>
										) : null}
									</div>
									{uploading && (
										<progress
											className="progress progress-primary w-full"
											value={uploadProgress}
											max="100"
										/>
									)}
								</div>
							) : (
								<FileUpload
									accept="video/*"
									maxSize={2 * 1024 * 1024 * 1024}
									onFileSelect={handleMediaSelect}
									label="Drop a video file or click to browse"
								/>
							)}
						</FormField>

						<FormField label="Description" error={errors.body}>
							<RichTextEditor
								content={bodyHtml || body}
								onChange={(html) => {
									setBodyHtml(html);
									const tmp = document.createElement("div");
									tmp.innerHTML = html;
									setBody(tmp.textContent || "");
								}}
								placeholder="Optional description..."
							/>
						</FormField>
					</>
				)}

				{/* Audio upload */}
				{contentType === "audio" && (
					<>
						<FormField label="Audio File" required error={errors.audioFile}>
							{mediaFile ? (
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
										<span className="text-sm truncate flex-1">{mediaFile.name}</span>
										{uploading ? (
											<span className="text-xs font-mono">{uploadProgress}%</span>
										) : uploadedStorageKey ? (
											<span className="badge badge-success badge-sm">Uploaded</span>
										) : null}
									</div>
									{uploading && (
										<progress
											className="progress progress-primary w-full"
											value={uploadProgress}
											max="100"
										/>
									)}
								</div>
							) : (
								<FileUpload
									accept="audio/*"
									maxSize={500 * 1024 * 1024}
									onFileSelect={handleMediaSelect}
									label="Drop an audio file or click to browse"
								/>
							)}
						</FormField>

						<FormField label="Description" error={errors.body}>
							<RichTextEditor
								content={bodyHtml || body}
								onChange={(html) => {
									setBodyHtml(html);
									const tmp = document.createElement("div");
									tmp.innerHTML = html;
									setBody(tmp.textContent || "");
								}}
								placeholder="Optional description..."
							/>
						</FormField>
					</>
				)}

				{/* Thumbnail */}
				<FormField label="Thumbnail" error={errors.thumbnail}>
					<FileUpload
						accept="image/*"
						maxSize={10 * 1024 * 1024}
						onFileSelect={handleThumbnailSelect}
						onClear={() => {
							setThumbnailFile(null);
							setThumbnailPreview(null);
						}}
						preview={thumbnailPreview}
						label="Upload a thumbnail image"
						compact
					/>
				</FormField>

				{/* Visibility */}
				<FormField label="Visibility">
					<select
						className="select select-bordered w-full"
						value={visibility}
						onChange={(e) => setVisibility(e.target.value as Visibility)}
					>
						<option value="public">Public</option>
						<option value="subscribers_only">Subscribers Only</option>
						<option value="gated">Gated (Boost Pool)</option>
					</select>
				</FormField>

				{/* Linked Project */}
				<FormField label="Linked Project" error={errors.project}>
					<select
						className="select select-bordered w-full"
						value={projectId}
						onChange={(e) => setProjectId(e.target.value)}
					>
						<option value="">None</option>
						{myProjects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.title}
							</option>
						))}
					</select>
				</FormField>

				{/* Toggles */}
				<div className="flex gap-6">
					<div className="form-control">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-primary"
								checked={isPublished}
								onChange={(e) => setIsPublished(e.target.checked)}
							/>
							<span className="label-text">Publish</span>
						</label>
					</div>
					<div className="form-control">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-secondary"
								checked={isPremium}
								onChange={(e) => setIsPremium(e.target.checked)}
							/>
							<span className="label-text">Premium</span>
						</label>
					</div>
				</div>

				<div className="flex gap-2 mt-2">
					<button
						type="submit"
						className={`btn btn-primary ${saving || uploading ? "btn-disabled" : ""}`}
						disabled={saving || uploading}
					>
						{saving ? "Saving..." : isEdit ? "Update Post" : "Create Post"}
					</button>
					<button type="button" className="btn btn-ghost" onClick={() => navigate("/dashboard")}>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}
