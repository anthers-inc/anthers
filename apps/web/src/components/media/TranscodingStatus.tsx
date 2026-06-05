interface TranscodingStatusProps {
	status: string;
	progress: number;
	errorMessage?: string;
}

export default function TranscodingStatus({
	status,
	progress,
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
