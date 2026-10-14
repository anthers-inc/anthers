// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's Work-edit address — a redirect only, since the kinds pass
 * (2026-10-14) put every kind's editing surface on the Work's own page
 * (`components/work/OwnerWorkEditor.tsx`), the video pass having proved the
 * shape and this pass having propagated it.
 *
 * The route stays because it is a published address: e2e walks and old bookmarks
 * round it, and the redirect keeps them honest. The batch editor this page
 * carried — `WorkEditor` and its save model in `work-edit.ts`, whose
 * one-shared-error bar and unsaved-changes key the per-field surface learned
 * from — died with the move; git history carries both if anything there is
 * wanted again.
 *
 * The route is keyed on **`publicId`**, the durable public address a Work
 * carries, not on the internal row id. `GET /works/:id` resolves either and
 * short-circuits to the owner-facing serialization for the creator; the Work's
 * page that receives this redirect reads the same answer. Nothing renders here
 * before the Work resolves, because the address is not a destination — a
 * spinner while the row is found, then on its way.
 */

import { workUrl } from "@anthers/web-shared/postUrl";
import { Link, Navigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type { Work } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";

/** The creator's own view of one Work, or null when it is not theirs or does not exist. */
async function fetchOwnWork(id: string | number): Promise<Work | null> {
	const res = await client.api.content.works[":id"].$get({ param: { id: String(id) }, query: {} });
	if (!res.ok) return null;
	const { work } = (await res.json()) as unknown as { work: Work };
	return work;
}

export default function WorkEditPage() {
	const { publicId } = useParams<{ publicId: string }>();
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState<Work | null>(null);

	useEffect(() => {
		if (!publicId) return;
		let live = true;
		fetchOwnWork(publicId)
			.then((work) => {
				if (live) setLoaded(work);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [publicId]);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!loaded) {
		return (
			<div className="max-w-3xl mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold">We can't find that Work</h1>
				<p className="mt-2 text-sm text-base-content/60">
					It may have been deleted, or it belongs to someone else.
				</p>
				<Link to={studioUrl("/works")} className="btn btn-primary btn-sm mt-6">
					Back to your Works
				</Link>
			</div>
		);
	}

	return <Navigate to={workUrl(loaded)} replace />;
}
