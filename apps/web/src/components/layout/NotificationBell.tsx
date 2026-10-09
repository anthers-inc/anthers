// SPDX-License-Identifier: Apache-2.0
/**
 * The bell — the header's way into the notifications feed, wearing the unread count.
 *
 * 🚨 **Rendered the way the basket is: only when it has something to say.** A bell with a
 * `0` badge is furniture; the header is tight on mobile and a permanent control that
 * answers "nothing has happened" belongs behind something that has. The first
 * notification opens it, and from then on it stays — the affordance someone who has been
 * told something once may need again is worth the corner of chrome.
 *
 * The count is the store's (`lib/notifications.ts`): one poll shared across pages,
 * refreshed here on every navigation so moving around the site is itself the poll the
 * sitting-still interval backs up.
 */
import { Link, useLocation } from "@anthers/web-shared/router";
import { BellIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { refreshUnreadCount, startUnreadPolling, useUnreadCount } from "../../lib/notifications";

export default function NotificationBell() {
	const unread = useUnreadCount();

	// Mount = first count; every route change = another. The interval covers sitting
	// still; navigation covers the person actively using the site, who should see a reply
	// land within a click rather than within 30 seconds. (Biome reads no dependency here
	// — `pathname` is INTENDED as the re-run trigger, the way the billing timer re-arms.)
	const { pathname } = useLocation();
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the effect's re-run trigger — refresh on every navigation
	useEffect(() => {
		startUnreadPolling();
		refreshUnreadCount();
	}, [pathname]);

	// `null` is "signed out or not yet loaded" — the bell is not drawn from nothing.
	if (unread === null) return null;

	return (
		<Link
			to="/notifications"
			className="btn btn-ghost btn-sm btn-circle relative"
			aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
		>
			<BellIcon className="w-5 h-5" />
			{unread > 0 && (
				<span className="badge badge-primary badge-xs absolute -top-1 -right-1">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</Link>
	);
}
