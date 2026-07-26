// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { consumerOrigin } from "../lib/consumer";

/**
 * The Studio (v1) owns only the authoring routes. Every other path — including where
 * `PostFormPage` navigates after save (the post's view page) or cancel (`/dashboard`) —
 * belongs to the consumer site, a separate origin. This catch-all hard-navigates to
 * the SAME path on the consumer origin, so those in-app navigations land correctly on
 * anthers.org instead of dead-ending in the Studio.
 */
export default function ConsumerRedirect() {
	const { pathname, search } = useLocation();

	useEffect(() => {
		window.location.href = `${consumerOrigin()}${pathname}${search}`;
	}, [pathname, search]);

	return (
		<div className="flex justify-center items-center min-h-[60vh] text-base-content/60">
			Returning to Anthers…
		</div>
	);
}
