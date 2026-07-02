// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { client } from "../../lib/rpc";
import LoadingSpinner from "./LoadingSpinner";

/**
 * Legacy /discover/:slug redirect.
 *
 * Fetches the project to resolve the creator username, then redirects
 * to the canonical /:username/:slug URL on the creator's site.
 */
export default function ProjectRedirect() {
	const { slug } = useParams<{ slug: string }>();
	const [target, setTarget] = useState<string | null>(null);
	const [notFound, setNotFound] = useState(false);

	useEffect(() => {
		if (!slug) return;
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setNotFound(true);
					return;
				}
				const { project } = await res.json();
				if (project.creator?.username) {
					setTarget(`/${project.creator.username}/${project.slug}`);
				} else {
					setNotFound(true);
				}
			})
			.catch(() => setNotFound(true));
	}, [slug]);

	if (notFound) {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold mb-2">Not Found</h1>
				<p className="text-base-content/60">Project not found.</p>
			</div>
		);
	}

	if (target) {
		return <Navigate to={target} replace />;
	}

	return (
		<div className="flex justify-center items-center min-h-[60vh]">
			<LoadingSpinner size="lg" />
		</div>
	);
}
