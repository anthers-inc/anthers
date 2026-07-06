// SPDX-License-Identifier: AGPL-3.0-or-later

import { client } from "@anthers/web-shared/rpc";
import type { Asset, ContentElement, Post } from "@anthers/web-shared/types";
import FormField from "@anthers/web-shared/ui/FormField";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { uploadMediaFile } from "@anthers/web-shared/upload";
import { ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EmptyState from "../components/ui/EmptyState";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Label for a content element in the target picker / builds table. */
function elementLabel(el: ContentElement): string {
	return el.title || `${el.contentType} #${el.position + 1}`;
}

/** Replace the assets of one content element inside a post immutably. */
function withElementAssets(
	post: Post,
	contentId: number,
	updater: (assets: Asset[]) => Asset[],
): Post {
	return {
		...post,
		contents: (post.contents ?? []).map((el) =>
			el.id === contentId ? { ...el, assets: updater(el.assets) } : el,
		),
	};
}

export default function BuildsPage() {
	const { slug } = useParams<{ slug: string }>();

	const [post, setPost] = useState<Post | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Upload form
	const [file, setFile] = useState<File | null>(null);
	const [contentId, setContentId] = useState<number | null>(null);
	const [platform, setPlatform] = useState("windows");
	const [version, setVersion] = useState("");
	const [isPrimary, setIsPrimary] = useState(false);
	const [uploading, setUploading] = useState(false);

	useEffect(() => {
		if (!slug) return;
		client.api.content.posts[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setError("Failed to load post.");
					return;
				}
				const data = (await res.json()) as unknown as { post: Post };
				setPost(data.post);
				// Default the upload target to a download-capable element (game/software),
				// otherwise the first content element.
				const els = data.post.contents ?? [];
				const preferred =
					els.find((el) => el.contentType === "game" || el.contentType === "software") ?? els[0];
				setContentId(preferred ? preferred.id : null);
			})
			.catch(() => setError("Failed to load post."))
			.finally(() => setLoading(false));
	}, [slug]);

	const handleUpload = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!file || !slug || contentId == null) return;
			setUploading(true);
			setError(null);

			try {
				// Upload the build to storage (presigned → Spaces in prod, direct in
				// dev), then create the asset record on the chosen content element.
				const key = await uploadMediaFile(file, "asset");
				const res = await client.api.content.posts[":slug"].contents[":contentId"].assets.$post({
					param: { slug, contentId: String(contentId) },
					json: {
						file: key,
						filename: file.name,
						fileSize: file.size,
						mimeType: file.type || "application/octet-stream",
						platform,
						version,
						isPrimary,
					},
				});
				if (!res.ok) throw new Error("Create failed");
				const data = (await res.json()) as unknown as { asset: Asset };
				setPost((prev) =>
					prev ? withElementAssets(prev, contentId, (assets) => [data.asset, ...assets]) : prev,
				);
				setFile(null);
				setVersion("");
				setIsPrimary(false);
			} catch {
				setError("Failed to upload build.");
			} finally {
				setUploading(false);
			}
		},
		[file, slug, contentId, platform, version, isPrimary],
	);

	const handleDelete = useCallback(
		async (targetContentId: number, assetId: number) => {
			if (!slug) return;
			try {
				const res = await client.api.content.posts[":slug"].contents[":contentId"].assets[
					":id"
				].$delete({
					param: { slug, contentId: String(targetContentId), id: String(assetId) },
				});
				if (!res.ok) throw new Error("Delete failed");
				setPost((prev) =>
					prev
						? withElementAssets(prev, targetContentId, (assets) =>
								assets.filter((a) => a.id !== assetId),
							)
						: prev,
				);
			} catch {
				setError("Failed to delete build.");
			}
		},
		[slug],
	);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!post) {
		return (
			<div className="max-w-7xl mx-auto px-4 py-8">
				<p className="text-error">{error || "Post not found."}</p>
			</div>
		);
	}

	const contents = post.contents ?? [];
	// Flatten every content element's builds into rows, tagged with their element.
	const builds = contents.flatMap((el) => el.assets.map((asset) => ({ asset, element: el })));
	const multipleTargets = contents.length > 1;

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			<div className="flex items-center gap-2 mb-6">
				<Link to="/dashboard" className="link text-sm">
					Dashboard
				</Link>
				<span className="text-base-content/30">/</span>
				<h1 className="text-2xl font-bold">{post.title || "Untitled"}—Builds</h1>
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			{/* Upload form */}
			{contents.length === 0 ? (
				<div className="alert alert-warning mb-8">
					<span>This post has no content elements to attach builds to.</span>
				</div>
			) : (
				<div className="card bg-base-200 mb-8">
					<div className="card-body">
						<h2 className="card-title text-lg">Upload Build</h2>
						<form onSubmit={handleUpload} className="flex flex-col gap-3">
							<div className="flex flex-col sm:flex-row gap-3 items-end">
								<div className="flex-1">
									<FormField label="File">
										<input
											type="file"
											className="file-input file-input-bordered w-full"
											onChange={(e) => setFile(e.target.files?.[0] || null)}
										/>
									</FormField>
								</div>
								{multipleTargets && (
									<FormField label="Attach to">
										<select
											className="select select-bordered"
											value={contentId ?? ""}
											onChange={(e) => setContentId(e.target.value ? Number(e.target.value) : null)}
										>
											{contents.map((el) => (
												<option key={el.id} value={el.id}>
													{elementLabel(el)}
												</option>
											))}
										</select>
									</FormField>
								)}
								<FormField label="Platform">
									<select
										className="select select-bordered"
										value={platform}
										onChange={(e) => setPlatform(e.target.value)}
									>
										<option value="windows">Windows</option>
										<option value="mac">macOS</option>
										<option value="linux">Linux</option>
										<option value="web">Web</option>
										<option value="android">Android</option>
										<option value="ios">iOS</option>
										<option value="other">Other</option>
									</select>
								</FormField>
								<FormField label="Version">
									<input
										type="text"
										className="input input-bordered w-28"
										value={version}
										onChange={(e) => setVersion(e.target.value)}
										placeholder="1.0.0"
									/>
								</FormField>
								<button
									type="submit"
									className={`btn btn-primary ${uploading || !file ? "btn-disabled" : ""}`}
									disabled={uploading || !file}
								>
									{uploading ? (
										<LoadingSpinner size="sm" />
									) : (
										<ArrowUpTrayIcon className="w-4 h-4" />
									)}
									Upload
								</button>
							</div>
							<label className="label cursor-pointer justify-start gap-2 w-fit">
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={isPrimary}
									onChange={(e) => setIsPrimary(e.target.checked)}
								/>
								<span className="label-text">Primary build</span>
							</label>
						</form>
					</div>
				</div>
			)}

			{/* Existing builds */}
			{builds.length > 0 ? (
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								{multipleTargets && <th>Content</th>}
								<th>Filename</th>
								<th>Platform</th>
								<th>Version</th>
								<th>Size</th>
								<th>Uploaded</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{builds.map(({ asset, element }) => (
								<tr key={asset.id}>
									{multipleTargets && (
										<td className="text-sm text-base-content/60">{elementLabel(element)}</td>
									)}
									<td className="font-mono text-sm">
										{asset.filename}
										{asset.isPrimary && (
											<span className="badge badge-primary badge-xs ml-2">Primary</span>
										)}
									</td>
									<td>
										<span className="badge badge-sm badge-outline capitalize">
											{asset.platform}
										</span>
									</td>
									<td>{asset.version || "—"}</td>
									<td className="text-sm text-base-content/60">
										{formatFileSize(asset.fileSize ?? 0)}
									</td>
									<td className="text-sm text-base-content/60">
										{new Date(asset.createdAt).toLocaleDateString()}
									</td>
									<td>
										<button
											type="button"
											className="btn btn-ghost btn-xs text-error"
											onClick={() => handleDelete(element.id, asset.id)}
										>
											<TrashIcon className="w-4 h-4" />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				contents.length > 0 && (
					<EmptyState
						icon={<ArrowUpTrayIcon className="w-12 h-12" />}
						title="No builds uploaded"
						description="Upload your first build above."
					/>
				)
			)}
		</div>
	);
}
