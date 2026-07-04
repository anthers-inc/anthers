// SPDX-License-Identifier: AGPL-3.0-or-later
interface TranscodingStatusProps {
	status: string;
	progress: number;
	etaSeconds?: number | null;
	errorMessage?: string;
}

/** Human ETA, e.g. "~2m 30s remaining". */
function formatEta(sec: number): string {
	if (sec < 60) return `~${sec}s remaining`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return s > 0 ? `~${m}m ${s}s remaining` : `~${m}m remaining`;
	const h = Math.floor(m / 60);
	return `~${h}h ${m % 60}m remaining`;
}

export default function TranscodingStatus({
	status,
	progress,
	etaSeconds,
	errorMessage,
}: TranscodingStatusProps) {
	if (status === "completed") return null;

	return (
		<div className="rounded-lg bg-base-200 p-4">
			{status === "pending" && (
				<div className="flex items-center gap-3">
					<span className="loading loading-spinner loading-sm" />
					<span className="text-sm">Waiting to process...</span>
				</div>
			)}

			{status === "processing" && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-sm">
						<span className="flex items-center gap-2">
							<span className="loading loading-spinner loading-sm" />
							Processing...
						</span>
						<span className="font-mono">{progress}%</span>
					</div>
					<progress className="progress progress-primary w-full" value={progress} max="100" />
					{etaSeconds != null && etaSeconds > 0 && (
						<span className="text-xs text-base-content/50 self-end">{formatEta(etaSeconds)}</span>
					)}
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
