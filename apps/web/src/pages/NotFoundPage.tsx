// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What answers a path nothing else claims.
 *
 * 🚨 **This page is the other half of `@`-prefixed profiles, not a decoration.** A site whose
 * last route is a bare `/:handle` has no unmatched paths at all — every wrong link resolves to
 * a profile lookup and renders something plausible, which is how a mis-typed `return_url`, a
 * stale nav item and a retired marketing card each pointed nowhere for weeks while every test
 * stayed green. Refusing a segment that is not a handle only helps if something answers after
 * the refusal, and this is that something.
 *
 * ⚠️ **So do not remove it, and do not let a route pattern grow broad enough to swallow it.**
 * `apps/web/tests/e2e/profile-urls.e2e.ts` asserts it still answers.
 */
import { Link } from "@anthers/web-shared/router";

export default function NotFoundPage() {
	return (
		<div className="mx-auto max-w-md px-4 py-24 text-center">
			<h1 className="text-2xl font-bold">There's Nothing at This Address</h1>
			<p className="mt-3 text-base-content/70">
				The page may have moved, or the link that brought you here may be wrong. A creator's page
				lives at an address beginning with <span className="font-mono">@</span>, like{" "}
				<span className="font-mono">/@name</span>.
			</p>
			{/* One destination, and it is the one that works signed out. `/discover` is behind
			    ProtectedRoute, so offering it here would bounce a logged-out reader to `/login`
			    from the page that just told them their link was wrong. */}
			<Link to="/" className="btn btn-primary mt-6">
				Go to Anthers
			</Link>
		</div>
	);
}
