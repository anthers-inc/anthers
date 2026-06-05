import { ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EmptyState from "../components/ui/EmptyState";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { Asset, Project } from "../lib/types";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function BuildsPage() {
	const { slug } = useParams<{ slug: string }>();

	const [project, setProject] = useState<Project | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Upload form
	const [file, setFile] = useState<File | null>(null);
	const [platform, setPlatform] = useState("windows");
	const [version, setVersion] = useState("");
	const [uploading, setUploading] = useState(false);

	useEffect(() => {
		if (!slug) return;
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then((res) => res.json())
			.then((data) => setProject((data as { project: Project }).project))
			.catch(() => setError("Failed to load project."))
			.finally(() => setLoading(false));
	}, [slug]);

	const handleUpload = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!file || !slug) return;
			setUploading(true);
			setError(null);

			const formData = new FormData();
			formData.append("file", file);
			formData.append("filename", file.name);
			formData.append("fileSize", String(file.size));
			formData.append("mimeType", file.type || "application/octet-stream");
			formData.append("platform", platform);
			formData.append("version", version);

			try {
				const res = await fetch(`${apiBase}/api/content/projects/${slug}/assets`, {
					method: "POST",
					credentials: "include",
					body: formData,
				});
				if (!res.ok) throw new Error("Upload failed");
				const data = (await res.json()) as { asset: Asset };
				setProject((prev) =>
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
				const res = await fetch(`${apiBase}/api/content/projects/${slug}/assets/${assetId}`, {
					method: "DELETE",
					credentials: "include",
				});
				if (!res.ok) throw new Error("Delete failed");
				setProject((prev) =>
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

	if (!project) {
		return (
			<div className="max-w-7xl mx-auto px-4 py-8">
				<p className="text-error">{error || "Project not found."}</p>
			</div>
		);
	}

	const assets = project.assets || [];

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			<div className="flex items-center gap-2 mb-6">
				<Link to="/dashboard" className="link text-sm">
					Dashboard
				</Link>
				<span className="text-base-content/30">/</span>
				<h1 className="text-2xl font-bold">{project.title}—Builds</h1>
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
