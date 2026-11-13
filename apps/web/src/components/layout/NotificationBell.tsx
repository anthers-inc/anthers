// SPDX-License-Identifier: Apache-2.0
/**
 * The bell — the header's way into the notifications feed, wearing the unread count.
 *
 * 🚨 **Always here, with only the badge conditional** (Parker, 2026-11-13): a bell with a
 * `0` badge is furniture, but a bell that comes and goes is worse — the door to the feed
 * should not depend on a count that is zero for most accounts most days, and the cart
 * settled on the same rule earlier the same day. So the bell renders unconditionally and
 * `unread > 0` is only what puts a number on it. A person who has read everything still
 * needs the way back, which is why the badge clears rather than the bell disappearing.
 *
 * The count is the store's (`lib/notifications.ts`): one poll shared across pages,
 * refreshed here on every navigation so moving around the site is itself the poll the
 * sitting-still interval backs up.
 */
import { Link, useLocation } from "@anthers/web-shared/router";
import { BellIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import {
	refreshUnreadCount,
	startUnreadPolling,
	useNotificationCounts,
} from "../../lib/notifications";

export default function NotificationBell() {
	const counts = useNotificationCounts();

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

	// `null` is "signed out or not yet loaded" — the bell still renders, wearing no badge,
	// and the first poll fills the count in.
	const unread = counts?.unread ?? 0;

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
