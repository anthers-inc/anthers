// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's processing, as a block: waiting, a progress bar with an estimate when one exists, or
 * the failure. Renders nothing once processing has completed.
 *
 * Shared between the public Work page, where a creator opening their own Work sees it in place of
 * the player, and the Studio's Edit page, where a creator lands straight after uploading. The
 * wording comes from `processing.ts`, so the badge, this block and the Dashboard say it alike.
 */

import { etaLeft } from "../content/processing";

interface TranscodingStatusProps {
	status: string;
	progress: number;
	etaSeconds?: number | null;
	errorMessage?: string;
}

export default function TranscodingStatus({
	status,
	progress,
	etaSeconds,
	errorMessage,
}: TranscodingStatusProps) {
	if (status === "completed") return null;
	const eta = etaLeft(etaSeconds);

	return (
		<div className="rounded-lg bg-base-200 p-4">
			{status === "pending" && (
				<div className="flex items-center gap-3">
					<span className="loading loading-spinner loading-sm" />
					<span className="text-sm">Waiting to process…</span>
				</div>
			)}

			{status === "processing" && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-sm">
						<span className="flex items-center gap-2">
							<span className="loading loading-spinner loading-sm" />
							Processing…
						</span>
						<span className="font-mono">{progress}%</span>
					</div>
					<progress className="progress progress-primary w-full" value={progress} max="100" />
					{eta && <span className="text-xs text-base-content/50 self-end">{eta}</span>}
				</div>
			)}

			{status === "failed" && (
				<div className="flex flex-col gap-1">
					<span className="text-error text-sm font-medium">Processing failed</span>
					{errorMessage && <span className="text-xs text-base-content/50">{errorMessage}</span>}
				</div>
			)}
		</div>
	);
}
