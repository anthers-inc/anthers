// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownTrayIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { client } from "../../lib/rpc";
import type { Asset } from "../../lib/types";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const PLATFORM_LABELS: Record<string, string> = {
	windows: "Windows",
	mac: "macOS",
	linux: "Linux",
	web: "Web",
	android: "Android",
	ios: "iOS",
};

export default function ProjectDownloads({
	assets,
	contentType,
	postSlug,
	canAccess,
}: {
	assets: Asset[];
	contentType: string;
	postSlug: string;
	canAccess: boolean;
}) {
	if (assets.length === 0) return null;

	// If the viewer can't access this post, show a gated message instead of files.
	if (!canAccess) {
		return (
			<div>
				<h2 className="text-xl font-bold mb-4">Downloads</h2>
				<div className="card bg-base-200">
					<div className="card-body items-center text-center py-8">
						<LockClosedIcon className="w-8 h-8 text-base-content/40" />
						<p className="text-base-content/60">Purchase this post to access downloads.</p>
					</div>
				</div>
			</div>
		);
	}

	// Group by platform for multi-platform deliverables (games / software).
	const showPlatform = contentType === "game" || contentType === "software";
	const grouped = showPlatform
		? assets.reduce<Record<string, Asset[]>>((acc, asset) => {
				const key = asset.platform || "other";
				if (!acc[key]) acc[key] = [];
				acc[key].push(asset);
				return acc;
			}, {})
		: { downloads: assets };

	return (
		<div>
			<h2 className="text-xl font-bold mb-4">Downloads</h2>
			<div className="overflow-x-auto">
				<table className="table table-sm">
					<thead>
						<tr>
							{showPlatform && <th>Platform</th>}
							<th>File</th>
							<th>Size</th>
							{assets.some((a) => a.version) && <th>Version</th>}
							<th></th>
						</tr>
					</thead>
					<tbody>
						{Object.entries(grouped).map(([platform, platformAssets]) =>
							platformAssets.map((asset) => (
								<tr key={asset.id}>
									{showPlatform && (
										<td className="font-medium">{PLATFORM_LABELS[platform] ?? platform}</td>
									)}
									<td>{asset.filename}</td>
									<td className="text-base-content/60">{formatSize(asset.fileSize ?? 0)}</td>
									{assets.some((a) => a.version) && (
										<td className="text-base-content/60">{asset.version}</td>
									)}
									<td>
										<button
											type="button"
											className="btn btn-sm btn-primary"
											onClick={async () => {
												try {
													const res = await client.api.content.posts[":slug"].assets[
														":id"
													].download.$post({
														param: { slug: postSlug, id: String(asset.id) },
													});
													if (!res.ok) {
														window.location.href = asset.file;
														return;
													}
													const data = await res.json();
													window.location.href = data.url;
												} catch {
													// Fallback to direct link
													window.location.href = asset.file;
												}
											}}
										>
											<ArrowDownTrayIcon className="w-4 h-4" />
											Download
										</button>
									</td>
								</tr>
							)),
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
