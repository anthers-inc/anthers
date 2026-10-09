// SPDX-License-Identifier: Apache-2.0
/**
 * The one-click unsubscribe landing — where an activity email's link arrives.
 *
 * 🚨 **This page works with no session, by token, and holds nothing about the person.**
 * The click comes from a mail client; the token in the query IS the credential, and the
 * write has already happened server-side by the time this page renders (the API route
 * redirects here only on success). So this page's whole job is to SAY what was done and
 * offer the way back in — it performs no write of its own, and a reload writes nothing
 * twice.
 *
 * The API's redirect lands on `/settings?tab=activity&unsubscribed=<group>` for a person
 * who has a session (their Settings shows the acknowledgment inline). This page is for
 * the person who clicked from a browser with no session — the common case, since the
 * link's whole premise is "you're reading this in mail, not on the site". It renders the
 * fact of the unsubscribe and points at sign-in for everything else.
 */
import { Link } from "@anthers/web-shared/router";

const GROUP_LABELS: Record<string, string> = {
	conversation: "replies and comments",
	reviews: "reviews",
	followers: "new followers",
	credits: "credits",
	reportAnswers: "report answers",
};

export default function UnsubscribePage() {
	// The group is in the query the API's redirect composed. Absent (somebody typing the
	// bare URL): the page says what the links are for and does not pretend something
	// happened.
	const params = new URLSearchParams(window.location.search);
	const group = params.get("group");
	const label = group ? (GROUP_LABELS[group] ?? "that kind of notification") : null;

	return (
		<div className="max-w-xl mx-auto p-8">
			<div className="card bg-base-200">
				<div className="card-body">
					{label ? (
						<>
							<h1 className="card-title text-xl">You're unsubscribed</h1>
							<p className="text-sm text-base-content/70 mt-2">
								You won't get emails about {label} anymore. You'll still see them in your
								notifications feed on Anthers — sign in and open the bell to read them there.
							</p>
						</>
					) : (
						<>
							<h1 className="card-title text-xl">Unsubscribe from notification emails</h1>
							<p className="text-sm text-base-content/70 mt-2">
								This page is where the links in Anthers' notification emails land. If you got here
								by typing the address, there's nothing to do — the link in the email is what turns a
								kind of email off, and you can change any of it later in your settings.
							</p>
						</>
					)}
					<div className="mt-4">
						<Link to="/settings?tab=activity" className="btn btn-primary btn-sm w-fit">
							Notification settings
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
