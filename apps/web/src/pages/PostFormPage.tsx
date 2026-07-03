// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import RichTextEditor from "../components/editor/RichTextEditor";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { client } from "../lib/rpc";
import type { Post } from "../lib/types";
import { uploadMediaFile } from "../lib/upload";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

/** Content types the creator can pick in the form. */
type FormContentType = "text" | "image" | "audio" | "video" | "game" | "software";
type PricingMode = "fixed" | "pwyw";
type Access = "free" | "paid";
type EntitlementKind = "none" | "tier" | "boost";
type EntitlementTier = "root" | "sprout" | "petal" | "bloom";
type Listing = "timeline" | "unlisted" | "shop";

const CONTENT_TYPE_OPTIONS: { value: FormContentType; label: string }[] = [
	{ value: "text", label: "Text / Article" },
	{ value: "image", label: "Image" },
	{ value: "audio", label: "Audio" },
	{ value: "video", label: "Video" },
	{ value: "game", label: "Game" },
	{ value: "software", label: "Software" },
];

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Upload a display image (cover/thumbnail) via the direct endpoint; returns its public URL. */
async function uploadImage(file: File): Promise<string> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("mediaType", "cover");
	const res = await fetch(`${apiBase}/api/content/media-upload/direct`, {
		method: "POST",
		credentials: "include",
		body: formData,
	});
	if (!res.ok) throw new Error("Image upload failed");
	const data = (await res.json()) as { key: string; url: string };
	return data.url;
}

export default function PostFormPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const { user } = useAuth();
	const isEdit = Boolean(slug);

	// ── Basics ──
	const [title, setTitle] = useState("");
	const [postSlug, setPostSlug] = useState("");
	const [slugManual, setSlugManual] = useState(false);
	const [contentType, setContentType] = useState<FormContentType>("text");
	const [body, setBody] = useState("");
	const [bodyHtml, setBodyHtml] = useState("");

	// ── Delivery ──
	const [streamEnabled, setStreamEnabled] = useState(true);
	const [downloadEnabled, setDownloadEnabled] = useState(false);

	// ── Media ──
	const [videoKey, setVideoKey] = useState("");
	const [audioKey, setAudioKey] = useState("");
	const [mediaFileName, setMediaFileName] = useState<string | null>(null);
	const [uploadProgress, setUploadProgress] = useState(0);
	const [coverImage, setCoverImage] = useState("");
	const [coverPreview, setCoverPreview] = useState<string | null>(null);
	const [thumbnail, setThumbnail] = useState("");
	const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
	const [embedUrl, setEmbedUrl] = useState("");
	const [durationSeconds, setDurationSeconds] = useState("");

	// ── Pricing ──
	const [access, setAccess] = useState<Access>("free");
	const [pricingMode, setPricingMode] = useState<PricingMode>("fixed");
	const [basePrice, setBasePrice] = useState("");
	const [minPrice, setMinPrice] = useState("");
	const [suggestedPrice, setSuggestedPrice] = useState("");

	// ── Entitlement ──
	const [entitlementKind, setEntitlementKind] = useState<EntitlementKind>("none");
	const [entitlementTier, setEntitlementTier] = useState<EntitlementTier>("root");
	const [entitlementBoostThreshold, setEntitlementBoostThreshold] = useState("");
	const [entitlementDiscountPct, setEntitlementDiscountPct] = useState("0");
	const [purchasableWithoutEntitlement, setPurchasableWithoutEntitlement] = useState(true);

	// ── Presentation & metadata ──
	const [listing, setListing] = useState<Listing>("timeline");
	const [tagsInput, setTagsInput] = useState("");
	const [websiteUrl, setWebsiteUrl] = useState("");
	const [sourceUrl, setSourceUrl] = useState("");
	const [isPinned, setIsPinned] = useState(false);
	const [isPublished, setIsPublished] = useState(false);

	// ── UI state ──
	const [loading, setLoading] = useState(isEdit);
	const [saving, setSaving] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!isEdit || !slug) return;
		client.api.content.posts[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setError("Failed to load post.");
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				setTitle(post.title || "");
				setPostSlug(post.slug);
				setContentType((post.contentType as FormContentType) || "text");
				setBody(post.body || "");
				setBodyHtml(post.bodyHtml || "");
				setStreamEnabled(post.streamEnabled);
				setDownloadEnabled(post.downloadEnabled);
				setVideoKey(post.videoFile || "");
				setAudioKey(post.audioFile || "");
				setCoverImage(post.coverImage || "");
				setCoverPreview(post.coverImage);
				setThumbnail(post.thumbnail || "");
				setThumbnailPreview(post.thumbnail);
				setEmbedUrl(post.embedUrl || "");
				setDurationSeconds(post.durationSeconds != null ? String(post.durationSeconds) : "");
				setAccess(post.basePrice != null || post.pricingMode === "pwyw" ? "paid" : "free");
				setPricingMode(post.pricingMode === "pwyw" ? "pwyw" : "fixed");
				setBasePrice(post.basePrice || "");
				setMinPrice(post.minPrice || "");
				setSuggestedPrice(post.suggestedPrice || "");
				setEntitlementKind((post.entitlementKind as EntitlementKind) || "none");
				setEntitlementTier((post.entitlementTier as EntitlementTier) || "root");
				setEntitlementBoostThreshold(post.entitlementBoostThreshold || "");
				setEntitlementDiscountPct(String(post.entitlementDiscountPct ?? 0));
				setPurchasableWithoutEntitlement(post.purchasableWithoutEntitlement);
				setListing((post.listing as Listing) || "timeline");
				setTagsInput((post.tags ?? []).join(", "));
				setWebsiteUrl(post.websiteUrl || "");
				setSourceUrl(post.sourceUrl || "");
				setIsPinned(post.isPinned);
				setIsPublished(post.isPublished ?? false);
			})
			.catch(() => setError("Failed to load post."))
			.finally(() => setLoading(false));
	}, [slug, isEdit]);

	// Auto-generate slug from the title on create until the user edits it.
	useEffect(() => {
		if (!slugManual && !isEdit) setPostSlug(slugify(title));
	}, [title, slugManual, isEdit]);

	const handleBodyChange = (html: string) => {
		setBodyHtml(html);
		const tmp = document.createElement("div");
		tmp.innerHTML = html;
		setBody(tmp.textContent || "");
	};

	const handleMediaSelect = async (file: File, kind: "video" | "audio") => {
		setMediaFileName(file.name);
		setUploadProgress(0);
		setUploading(true);
		setError(null);
		try {
			const key = await uploadMediaFile(file, kind, setUploadProgress);
			if (kind === "video") setVideoKey(key);
			else setAudioKey(key);
		} catch (err) {
			setError(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
			setMediaFileName(null);
		} finally {
			setUploading(false);
		}
	};

	const handleImageSelect = async (file: File, kind: "cover" | "thumbnail") => {
		const localPreview = URL.createObjectURL(file);
		if (kind === "cover") setCoverPreview(localPreview);
		else setThumbnailPreview(localPreview);
		setUploading(true);
		setError(null);
		try {
			const url = await uploadImage(file);
			if (kind === "cover") {
				setCoverImage(url);
				setCoverPreview(url);
			} else {
				setThumbnail(url);
				setThumbnailPreview(url);
			}
		} catch {
			setError("Image upload failed.");
		} finally {
			setUploading(false);
		}
	};

	const deliveryValid = streamEnabled || downloadEnabled;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!deliveryValid) {
			setError("A post must enable at least one delivery method (stream or download).");
			return;
		}
		setSaving(true);
		setError(null);

		const tags = tagsInput
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		// Pricing → basePrice / minPrice / suggestedPrice.
		let basePriceOut: string | null = null;
		let minPriceOut: string | null = null;
		let suggestedPriceOut: string | null = null;
		let pricingModeOut: PricingMode = "fixed";
		if (access === "paid") {
			pricingModeOut = pricingMode;
			if (pricingMode === "fixed") {
				basePriceOut = basePrice.trim() || null;
			} else {
				minPriceOut = minPrice.trim() || null;
				suggestedPriceOut = suggestedPrice.trim() || null;
			}
		}

		// Entitlement.
		let entitlementKindOut: "tier" | "boost" | null = null;
		let entitlementTierOut: EntitlementTier | null = null;
		let entitlementBoostThresholdOut: string | null = null;
		let entitlementDiscountPctOut: number | null = null;
		if (entitlementKind === "tier") {
			entitlementKindOut = "tier";
			entitlementTierOut = entitlementTier;
			entitlementDiscountPctOut = Number(entitlementDiscountPct) || 0;
		} else if (entitlementKind === "boost") {
			entitlementKindOut = "boost";
			entitlementBoostThresholdOut = entitlementBoostThreshold.trim() || null;
			entitlementDiscountPctOut = Number(entitlementDiscountPct) || 0;
		}

		const json = {
			title,
			body,
			bodyHtml,
			contentType,
			streamEnabled,
			downloadEnabled,
			videoFile: videoKey,
			audioFile: audioKey,
			coverImage,
			thumbnail,
			embedUrl,
			durationSeconds: durationSeconds.trim() ? Number(durationSeconds) : undefined,
			basePrice: basePriceOut,
			pricingMode: pricingModeOut,
			minPrice: minPriceOut,
			suggestedPrice: suggestedPriceOut,
			entitlementKind: entitlementKindOut,
			entitlementTier: entitlementTierOut,
			entitlementBoostThreshold: entitlementBoostThresholdOut,
			entitlementDiscountPct: entitlementDiscountPctOut,
			purchasableWithoutEntitlement,
			isPinned,
			listing,
			tags,
			websiteUrl,
			sourceUrl,
			isPublished,
		};

		try {
			if (isEdit && slug) {
				const res = await client.api.content.posts[":slug"].$patch({
					param: { slug },
					json,
				});
				if (!res.ok) {
					const data: unknown = await res.json();
					setError(errorMessage(data, "Failed to save post."));
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				navigate(`/${user?.username ?? "me"}/posts/${post.slug}`);
			} else {
				const res = await client.api.content.posts.$post({
					json: { ...json, slug: postSlug.trim() || undefined },
				});
				if (!res.ok) {
					const data: unknown = await res.json();
					setError(errorMessage(data, "Failed to create post."));
					return;
				}
				const { post } = (await res.json()) as { post: Post };
				navigate(`/${user?.username ?? "me"}/posts/${post.slug}`);
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

			<form onSubmit={handleSubmit} className="flex flex-col gap-6">
				{/* ── Basics ── */}
				<section className="flex flex-col gap-4">
					<FormField label="Content Type">
						<select
							className="select select-bordered w-full"
							value={contentType}
							onChange={(e) => setContentType(e.target.value as FormContentType)}
						>
							{CONTENT_TYPE_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</FormField>

					<FormField label="Title">
						<input
							type="text"
							className="input input-bordered w-full"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Post title"
						/>
					</FormField>

					{!isEdit && (
						<FormField label="Slug">
							<input
								type="text"
								className="input input-bordered w-full"
								value={postSlug}
								onChange={(e) => {
									setPostSlug(e.target.value);
									setSlugManual(true);
								}}
								placeholder="my-post (auto-generated if left blank)"
							/>
							<p className="text-xs text-base-content/50 mt-1">
								URL: /posts/{postSlug || "..."}
							</p>
						</FormField>
					)}
				</section>

				{/* ── Content & media ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-4">
					<h2 className="text-lg font-semibold">Content & Media</h2>

					<FormField label={contentType === "text" ? "Content" : "Description"}>
						<RichTextEditor
							content={bodyHtml || body}
							onChange={handleBodyChange}
							placeholder={
								contentType === "text" ? "Write your article..." : "Optional description..."
							}
						/>
					</FormField>

					{contentType === "video" && (
						<FormField label="Video File">
							{mediaFileName || videoKey ? (
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
										<span className="text-sm truncate flex-1">
											{mediaFileName || "Existing video"}
										</span>
										{uploading ? (
											<span className="text-xs font-mono">{uploadProgress}%</span>
										) : videoKey ? (
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
									onFileSelect={(file) => handleMediaSelect(file, "video")}
									label="Drop a video file or click to browse"
								/>
							)}
						</FormField>
					)}

					{contentType === "audio" && (
						<FormField label="Audio File">
							{mediaFileName || audioKey ? (
								<div className="flex flex-col gap-2">
									<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
										<span className="text-sm truncate flex-1">
											{mediaFileName || "Existing audio"}
										</span>
										{uploading ? (
											<span className="text-xs font-mono">{uploadProgress}%</span>
										) : audioKey ? (
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
									onFileSelect={(file) => handleMediaSelect(file, "audio")}
									label="Drop an audio file or click to browse"
								/>
							)}
						</FormField>
					)}

					{(contentType === "game" || contentType === "software") && (
						<FormField label="Embed URL">
							<input
								type="url"
								className="input input-bordered w-full"
								value={embedUrl}
								onChange={(e) => setEmbedUrl(e.target.value)}
								placeholder="https://example.com/embed"
							/>
							<p className="text-xs text-base-content/50 mt-1">
								URL for an HTML5/WebGL embed (sandboxed iframe)
							</p>
						</FormField>
					)}

					{(contentType === "audio" || contentType === "video") && (
						<FormField label="Duration (seconds)">
							<input
								type="number"
								className="input input-bordered w-full"
								value={durationSeconds}
								onChange={(e) => setDurationSeconds(e.target.value)}
								min="0"
								step="1"
								placeholder="Optional — usually derived automatically"
							/>
						</FormField>
					)}

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<FormField label="Cover Image">
							<FileUpload
								accept="image/*"
								maxSize={10 * 1024 * 1024}
								preview={coverPreview}
								label="Upload a cover image"
								compact
								onFileSelect={(file) => handleImageSelect(file, "cover")}
								onClear={() => {
									setCoverImage("");
									setCoverPreview(null);
								}}
							/>
						</FormField>

						<FormField label="Thumbnail">
							<FileUpload
								accept="image/*"
								maxSize={10 * 1024 * 1024}
								preview={thumbnailPreview}
								label="Upload a thumbnail"
								compact
								onFileSelect={(file) => handleImageSelect(file, "thumbnail")}
								onClear={() => {
									setThumbnail("");
									setThumbnailPreview(null);
								}}
							/>
						</FormField>
					</div>
				</section>

				{/* ── Delivery ── */}
				<section className="flex flex-col gap-2 border-t border-base-300 pt-4">
					<h2 className="text-lg font-semibold">Delivery</h2>
					<p className="text-xs text-base-content/50 -mt-1">
						Enable at least one way for people to consume this post.
					</p>
					<div className="flex flex-wrap gap-6">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-primary"
								checked={streamEnabled}
								onChange={(e) => setStreamEnabled(e.target.checked)}
							/>
							<span className="label-text">Stream / view online</span>
						</label>
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-primary"
								checked={downloadEnabled}
								onChange={(e) => setDownloadEnabled(e.target.checked)}
							/>
							<span className="label-text">Downloadable</span>
						</label>
					</div>
					{!deliveryValid && (
						<p className="text-error text-xs">
							Enable stream, download, or both.
						</p>
					)}
				</section>

				{/* ── Pricing ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-4">
					<h2 className="text-lg font-semibold">Pricing</h2>

					<FormField label="Access">
						<select
							className="select select-bordered w-full"
							value={access}
							onChange={(e) => setAccess(e.target.value as Access)}
						>
							<option value="free">Free</option>
							<option value="paid">Paid</option>
						</select>
					</FormField>

					{access === "paid" && (
						<>
							<FormField label="Pricing Mode">
								<select
									className="select select-bordered w-full"
									value={pricingMode}
									onChange={(e) => setPricingMode(e.target.value as PricingMode)}
								>
									<option value="fixed">Fixed price</option>
									<option value="pwyw">Pay what you want</option>
								</select>
							</FormField>

							{pricingMode === "fixed" ? (
								<FormField label="Price ($)">
									<input
										type="number"
										className="input input-bordered w-full"
										value={basePrice}
										onChange={(e) => setBasePrice(e.target.value)}
										min="0"
										step="0.01"
										placeholder="9.99"
									/>
								</FormField>
							) : (
								<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
									<FormField label="Minimum Price ($)">
										<input
											type="number"
											className="input input-bordered w-full"
											value={minPrice}
											onChange={(e) => setMinPrice(e.target.value)}
											min="0"
											step="0.01"
											placeholder="0.00"
										/>
									</FormField>
									<FormField label="Suggested Price ($)">
										<input
											type="number"
											className="input input-bordered w-full"
											value={suggestedPrice}
											onChange={(e) => setSuggestedPrice(e.target.value)}
											min="0"
											step="0.01"
											placeholder="5.00"
										/>
									</FormField>
								</div>
							)}
						</>
					)}
				</section>

				{/* ── Entitlement ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-4">
					<h2 className="text-lg font-semibold">Entitlement</h2>

					<FormField label="Unlock via">
						<select
							className="select select-bordered w-full"
							value={entitlementKind}
							onChange={(e) => setEntitlementKind(e.target.value as EntitlementKind)}
						>
							<option value="none">None</option>
							<option value="tier">Anthers Tier</option>
							<option value="boost">Boost Threshold</option>
						</select>
					</FormField>

					{entitlementKind === "tier" && (
						<FormField label="Required Tier">
							<select
								className="select select-bordered w-full"
								value={entitlementTier}
								onChange={(e) => setEntitlementTier(e.target.value as EntitlementTier)}
							>
								<option value="root">Root</option>
								<option value="sprout">Sprout</option>
								<option value="petal">Petal</option>
								<option value="bloom">Bloom</option>
							</select>
						</FormField>
					)}

					{entitlementKind === "boost" && (
						<FormField label="Boost Threshold ($)">
							<input
								type="number"
								className="input input-bordered w-full"
								value={entitlementBoostThreshold}
								onChange={(e) => setEntitlementBoostThreshold(e.target.value)}
								min="0"
								step="0.01"
								placeholder="5.00"
							/>
						</FormField>
					)}

					{entitlementKind !== "none" && (
						<>
							<FormField label="Entitlement Discount (%)">
								<input
									type="number"
									className="input input-bordered w-full"
									value={entitlementDiscountPct}
									onChange={(e) => setEntitlementDiscountPct(e.target.value)}
									min="0"
									max="100"
									step="1"
									placeholder="100 = fully unlocked"
								/>
								<p className="text-xs text-base-content/50 mt-1">
									100 unlocks fully; less than 100 gives entitled viewers a discount.
								</p>
							</FormField>

							<label className="label cursor-pointer justify-start gap-3">
								<input
									type="checkbox"
									className="toggle toggle-primary"
									checked={purchasableWithoutEntitlement}
									onChange={(e) => setPurchasableWithoutEntitlement(e.target.checked)}
								/>
								<span className="label-text">Purchasable without the entitlement</span>
							</label>
						</>
					)}
				</section>

				{/* ── Presentation & metadata ── */}
				<section className="flex flex-col gap-4 border-t border-base-300 pt-4">
					<h2 className="text-lg font-semibold">Presentation & Metadata</h2>

					<FormField label="Listing">
						<select
							className="select select-bordered w-full"
							value={listing}
							onChange={(e) => setListing(e.target.value as Listing)}
						>
							<option value="timeline">Timeline (public feed)</option>
							<option value="unlisted">Unlisted</option>
							<option value="shop">Shop</option>
						</select>
					</FormField>

					<FormField label="Tags">
						<input
							type="text"
							className="input input-bordered w-full"
							value={tagsInput}
							onChange={(e) => setTagsInput(e.target.value)}
							placeholder="rpg, pixel-art, roguelike"
						/>
						<p className="text-xs text-base-content/50 mt-1">Comma-separated</p>
					</FormField>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<FormField label="Website URL">
							<input
								type="url"
								className="input input-bordered w-full"
								value={websiteUrl}
								onChange={(e) => setWebsiteUrl(e.target.value)}
								placeholder="https://example.com"
							/>
						</FormField>

						<FormField label="Source Code URL">
							<input
								type="url"
								className="input input-bordered w-full"
								value={sourceUrl}
								onChange={(e) => setSourceUrl(e.target.value)}
								placeholder="https://github.com/..."
							/>
						</FormField>
					</div>

					<div className="flex flex-wrap gap-6">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-secondary"
								checked={isPinned}
								onChange={(e) => setIsPinned(e.target.checked)}
							/>
							<span className="label-text">Pin to profile</span>
						</label>
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
				</section>

				<div className="flex gap-2 mt-2">
					<button
						type="submit"
						className={`btn btn-primary ${saving || uploading || !deliveryValid ? "btn-disabled" : ""}`}
						disabled={saving || uploading || !deliveryValid}
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

/** Best-effort extraction of an { error } message from a non-ok JSON response. */
function errorMessage(data: unknown, fallback: string): string {
	if (data && typeof data === "object" && "error" in data) {
		const err = (data as { error: unknown }).error;
		if (typeof err === "string") return err;
	}
	return fallback;
}
