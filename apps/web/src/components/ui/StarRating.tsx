// SPDX-License-Identifier: AGPL-3.0-or-later
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import { StarIcon as StarSolid } from "@heroicons/react/24/solid";

interface StarRatingProps {
	rating: number | null;
	count?: number;
	interactive?: boolean;
	onRate?: (score: number) => void;
	size?: "sm" | "md";
}

export default function StarRating({
	rating,
	count,
	interactive = false,
	onRate,
	size = "md",
}: StarRatingProps) {
	const displayRating = rating ?? 0;
	const sizeClass = size === "sm" ? "w-4 h-4" : "w-5 h-5";

	return (
		<div className="flex items-center gap-1">
			<div className="flex">
				{[1, 2, 3, 4, 5].map((star) => {
					const filled = star <= Math.round(displayRating);
					const Icon = filled ? StarSolid : StarOutline;
					return (
						<button
							key={star}
							type="button"
							disabled={!interactive}
							className={`${interactive ? "cursor-pointer hover:scale-110 transition-transform" : "cursor-default"} ${filled ? "text-warning" : "text-base-content/30"}`}
							onClick={() => interactive && onRate?.(star)}
						>
							<Icon className={sizeClass} />
						</button>
					);
				})}
			</div>
			{count !== undefined && (
				<span className="text-xs text-base-content/50 ml-1">
					{rating !== null ? displayRating.toFixed(1) : "—"} ({count})
				</span>
			)}
		</div>
	);
}
