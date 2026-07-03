// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EmptyState from "../components/ui/EmptyState";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { Asset, Post } from "../lib/types";
import { uploadMediaFile } from "../lib/upload";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function BuildsPage() {
	const { slug } = useParams<{ slug: string }>();

	const [post, setPost] = useState<Post | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Upload form
	const [file, setFile] = useState<File | null>(null);
	const [platform, setPlatform] = useState("windows");
	const [version, setVersion] = useState("");
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
				const data = await res.json();
				setPost(data.post as Post);
			})
			.catch(() => setError("Failed to load post."))
			.finally(() => setLoading(false));
	}, [slug]);

	const handleUpload = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!file || !slug) return;
			setUploading(true);
			setError(null);

			try {
				// Upload the build to storage (presigned → Spaces in prod, direct in
				// dev), then create the asset record referencing the returned key.
				const key = await uploadMediaFile(file, "asset");
				const res = await client.api.content.posts[":slug"].assets.$post({
					param: { slug },
					json: {
						file: key,
						filename: file.name,
						fileSize: file.size,
						mimeType: file.type || "application/octet-stream",
						platform,
						version,
					},
				});
				if (!res.ok) throw new Error("Create failed");
				const data = (await res.json()) as { asset: Asset };
				setPost((prev) =>
					prev ? { ...prev, assets: [data.asset, ...(prev.assets || [])] } : prev,
				);
				setFile(null);
				setVersion("");
			} catch {
				setError("Failed to upload build.");
			} finally {
				setUploading(false);
			}
		},
		[file, slug, platform, version],
	);

	const handleDelete = useCallback(
		async (assetId: number) => {
			if (!slug) return;
			try {
				const res = await client.api.content.posts[":slug"].assets[":id"].$delete({
					param: { slug, id: String(assetId) },
				});
				if (!res.ok) throw new Error("Delete failed");
				setPost((prev) =>
					prev
						? {
								...prev,
								assets: (prev.assets || []).filter((a) => a.id !== assetId),
							}
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

	const assets = post.assets || [];

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
			<div className="card bg-base-200 mb-8">
				<div className="card-body">
					<h2 className="card-title text-lg">Upload Build</h2>
					<form onSubmit={handleUpload} className="flex flex-col sm:flex-row gap-3 items-end">
						<div className="flex-1">
							<FormField label="File">
								<input
									type="file"
									className="file-input file-input-bordered w-full"
									onChange={(e) => setFile(e.target.files?.[0] || null)}
								/>
							</FormField>
						</div>
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
							{uploading ? <LoadingSpinner size="sm" /> : <ArrowUpTrayIcon className="w-4 h-4" />}
							Upload
						</button>
					</form>
				</div>
			</div>

			{/* Existing builds */}
			{assets.length > 0 ? (
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Filename</th>
								<th>Platform</th>
								<th>Version</th>
								<th>Size</th>
								<th>Uploaded</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{assets.map((asset) => (
								<tr key={asset.id}>
									<td className="font-mono text-sm">{asset.filename}</td>
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
											onClick={() => handleDelete(asset.id)}
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
				<EmptyState
					icon={<ArrowUpTrayIcon className="w-12 h-12" />}
					title="No builds uploaded"
					description="Upload your first build above."
				/>
			)}
		</div>
	);
}
