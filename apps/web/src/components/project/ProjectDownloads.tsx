// SPDX-License-Identifier: AGPL-3.0-or-later

import { P2pDownloadButton } from "@anthers/web-shared/content/P2pDownloadButton";
import type { Asset } from "@anthers/web-shared/types";
import { LockClosedIcon } from "@heroicons/react/24/outline";

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
										{/*
										 * The ONLY download path. Parker, 2026-08-10: all downloads use the
										 * P2P architecture even when the hub is the sole host, so there are
										 * not two protocols to maintain (45.01 § 3, "one architecture, not
										 * two"). The signed-URL button that used to sit here is gone; the
										 * endpoint behind it remains for API and CLI consumers.
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
