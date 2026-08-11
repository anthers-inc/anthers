// SPDX-License-Identifier: AGPL-3.0-or-later

import { P2pDownloadButton } from "@anthers/web-shared/content/P2pDownloadButton";
import { client } from "@anthers/web-shared/rpc";
import type { Asset } from "@anthers/web-shared/types";
import { ArrowDownTrayIcon, LockClosedIcon } from "@heroicons/react/24/outline";

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
	workId,
	canAccess,
}: {
	assets: Asset[];
	contentType: string;
	workId: number;
	canAccess: boolean;
}) {
	if (assets.length === 0) return null;

	// If the viewer can't access this Work, show a gated message instead of files.
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
													// Downloads are Work-scoped: the asset belongs to a Work, and the
													// Work carries the gate the endpoint re-checks.
													const res = await client.api.content.works[":id"].assets[
														":assetId"
													].download.$post({
														param: { id: String(workId), assetId: String(asset.id) },
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
									<td>
										{/*
										 * The P2P path, offered rather than forced. It verifies every chunk
										 * against the manifest and, once the swarm is warm, costs Anthers
										 * nothing to serve — but it assembles in origin-private storage and
										 * pays a second copy on the way out, where the signed URL above
										 * streams straight to disk. Making it the default would be a UX
										 * regression today; see `useP2pDownload` for the whole trade.
										 */}
										<P2pDownloadButton
											workId={workId}
											assetId={asset.id}
											filename={asset.filename}
											mimeType={asset.mimeType ?? undefined}
										/>
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
