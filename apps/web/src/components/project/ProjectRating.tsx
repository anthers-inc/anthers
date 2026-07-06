// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { RatingAggregate } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";
import StarRating from "../ui/StarRating";

export default function ProjectRating({ slug }: { slug: string }) {
	const { isAuthenticated } = useAuth();
	const [rating, setRating] = useState<RatingAggregate | null>(null);

	const fetchRating = () => {
		client.api.content.posts[":slug"].ratings
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) return;
				setRating(await res.json());
			})
			.catch(console.error);
	};

	useEffect(() => {
		fetchRating();
	}, [slug]);

	const handleRate = async (score: number) => {
		if (!isAuthenticated) return;
		try {
			await client.api.content.posts[":slug"].ratings.$post({
				param: { slug },
				json: { score },
			});
			fetchRating();
		} catch (err) {
			console.error("Failed to rate:", err);
		}
	};

	if (!rating) return null;

	return (
		<div>
			<h2 className="text-xl font-bold mb-3">Rating</h2>
			<div className="flex items-center gap-4">
				<StarRating
					rating={rating.average}
					count={rating.count}
					interactive={isAuthenticated}
					onRate={handleRate}
				/>
				{rating.userRating !== null && (
					<span className="text-sm text-base-content/60">Your rating: {rating.userRating}/5</span>
				)}
			</div>
		</div>
	);
}
