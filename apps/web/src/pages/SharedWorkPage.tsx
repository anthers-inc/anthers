// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `/s/:token` — where a share link lands, and the only thing it does is point somewhere else.
 *
 * 🚨 **Deliberately not a second Work page.** The recipient is sent straight to the Work's
 * ordinary canonical URL carrying the token, so every question about what they may see is
 * asked by the same page, of the same resolver, that answers it for everybody else. A
 * separate "shared view" would be a second path to a deliverable, and therefore a second
 * place for the access rules to drift — which is precisely the failure the wiki's *Rating Standard* is guarding
 * against when it says a share link is a locator and never an entitlement.
 *
 * The URL is short and carries no Work id, slug or username, so pasting it somewhere reveals
 * nothing about what is behind it until somebody follows it.
 */
import { Link, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

export default function SharedWorkPage() {
	const { token } = useParams<{ token: string }>();
	const navigate = useNavigate();
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!token) {
			setFailed(true);
			return;
		}
		let canceled = false;
		(async () => {
			try {
				const res = await client.api.content.share[":token"].$get({ param: { token } });
				if (!res.ok) {
					if (!canceled) setFailed(true);
					return;
				}
				const link = (await res.json()) as { slug: string; publicId: number };
				if (canceled) return;
				// `replace`, so Back returns the recipient to wherever the link was posted rather
				// than to this redirect, which they never meant to visit.
				navigate(`/works/${link.slug}-${link.publicId}?share=${encodeURIComponent(token)}`, {
					replace: true,
				});
			} catch {
				if (!canceled) setFailed(true);
			}
		})();
		return () => {
			canceled = true;
		};
	}, [token, navigate]);

	if (failed) {
		return (
			<div className="mx-auto max-w-md px-4 py-24 text-center">
				<h1 className="text-2xl font-bold">This link isn't available</h1>
				{/* A revoked link and a link that never existed read the same on purpose: telling
				    them apart would confirm that somebody had shared something. */}
				<p className="mt-3 text-base-content/70">
					It may have been turned off, or the work behind it may no longer be open to everyone.
					Anthers is free to browse — have a look around.
				</p>
				<Link to="/" className="btn btn-primary mt-6">
					Go to Anthers
				</Link>
			</div>
		);
	}

	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<span className="loading loading-spinner loading-lg text-primary" />
		</div>
	);
}
