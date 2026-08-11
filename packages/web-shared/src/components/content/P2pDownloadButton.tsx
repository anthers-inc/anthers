// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The verified-download control — the first consumer of `/api/p2p` in any app.
 *
 * Sits beside the ordinary download rather than replacing it, deliberately. The two are
 * not the same trade: a signed URL streams natively to disk, while this assembles in
 * origin-private storage and costs a second copy on the way out. What this buys instead is
 * per-chunk verification against the manifest and, once the swarm is warm, bytes that cost
 * Anthers nothing. See `useP2pDownload` for the full reasoning.
 *
 * The copy is deliberately plain about what it does. "Verified download" is what a user
 * gets; peer-to-peer is how, and how is not the user's problem until it changes what they
 * should expect.
 */

import { ArrowDownTrayIcon, CheckCircleIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { useP2pDownload } from "../../lib/p2p/useP2pDownload.js";

function formatBytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024).toFixed(0)} KB`;
}

export function P2pDownloadButton({
	workId,
	assetId,
	filename,
	mimeType,
	className = "",
}: {
	workId: number | string;
	assetId: number;
	filename: string;
	mimeType?: string;
	className?: string;
}) {
	const download = useP2pDownload({ workId, assetId, filename, mimeType });

	if (download.state === "downloading" || download.state === "starting") {
		const pct = download.fraction === null ? null : Math.round(download.fraction * 100);
		return (
			<div className={`flex items-center gap-2 ${className}`}>
				<progress
					className="progress progress-primary w-24"
					value={pct ?? undefined}
					max={100}
					aria-label={`Downloading ${filename}`}
				/>
				<span className="text-xs tabular-nums text-base-content/70">
					{pct === null ? "Starting…" : `${pct}%`}
				</span>
				{download.progress && download.progress.peerBytes > 0 && (
					// Only shown when it is actually true — a "from peers" badge on a download
					// the hub served would be a claim about the architecture rather than a fact
					// about this file.
					<span className="badge badge-ghost badge-sm">
						{formatBytes(download.progress.peerBytes)} from peers
					</span>
				)}
				<button type="button" className="btn btn-ghost btn-xs" onClick={download.cancel}>
					Cancel
				</button>
			</div>
		);
	}

	if (download.state === "done") {
		return (
			<span className={`inline-flex items-center gap-1 text-success text-sm ${className}`}>
				<CheckCircleIcon className="w-4 h-4" />
				Downloaded and verified
			</span>
		);
	}

	return (
		<div className={`flex flex-col items-start gap-1 ${className}`}>
			<button
				type="button"
				className="btn btn-sm btn-outline"
				onClick={download.start}
				title="Downloads in verified pieces, checking each one against the file's fingerprint."
			>
				<ShieldCheckIcon className="w-4 h-4" />
				Verified download
			</button>
			{download.error && (
				<span className="text-error text-xs max-w-xs" role="alert">
					{download.error}
				</span>
			)}
		</div>
	);
}

/** The plain download, kept as the default path. Exported together so the pairing is visible. */
export function StandardDownloadIcon() {
	return <ArrowDownTrayIcon className="w-4 h-4" />;
}
