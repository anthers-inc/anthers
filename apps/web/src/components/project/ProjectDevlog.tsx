import { useEffect, useState } from "react";
import type { Post } from "../../lib/types";
import PostCard from "../cards/PostCard";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

export default function ProjectDevlog({ slug }: { slug: string }) {
	const [posts, setPosts] = useState<Post[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch(apiBase + "/api/content/posts?project=" + slug, {
			credentials: "include",
		})
			.then((res) => res.json())
			.then((data) => setPosts(data.posts))
			.catch((err) => console.error("Failed to load devlog:", err))
			.finally(() => setLoading(false));
	}, [slug]);

	if (loading || posts.length === 0) return null;

	return (
		<div>
			<h2 className="text-xl font-bold mb-4">Devlog</h2>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				{posts.slice(0, 4).map((post) => (
					<PostCard key={post.id} post={post} />
				))}
			</div>
		</div>
	);
}
