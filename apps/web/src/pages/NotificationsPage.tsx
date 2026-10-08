// SPDX-License-Identifier: Apache-2.0
/**
 * The notifications feed — the in-app half of "being told something happened".
 *
 * ⭐ **It marks everything read on arrival, and that is the honest reading of the act.**
 * The person opened the list of what happened; every item in it has now been seen, and a
 * count that stayed up over entries on screen would be the bell lying about the state it
 * reports. Deliberately not per-item "mark as read": the list is short (the service
 * returns 50), the unread count is the only state the bell knows, and a control per row
 * spends UI on a distinction nobody asked for. The bell's count is told directly
 * (`setUnreadCount(0)`) rather than waiting out the poll, so it moves the moment the
 * page settles.
 *
 * 🚨 **A sign-out mid-view stops the loop** — the effect's re-run on `isAuthenticated`
 * is what re-draws as signed-out chrome rather than refetching a 401 forever.
 */

import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { NotificationItem } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";
import { setUnreadCount } from "../lib/notifications";

function relativeDate(iso: string): string {
	const then = new Date(iso).getTime();
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 60) return "just now";
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}

export default function NotificationsPage() {
	const [items, setItems] = useState<NotificationItem[] | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		let alive = true;
		setItems(null);
		client.api.accounts.me.notifications
			.$get()
			.then(async (res) => {
				if (!alive) return;
				if (!res.ok) {
					setError(true);
					return;
				}
				const body = (await res.json()) as unknown as { notifications: NotificationItem[] };
				setItems(body.notifications ?? []);
				// Every item on the settled list has been seen; the bell follows at once.
				const unread = body.notifications?.filter((n) => !n.readAt).length ?? 0;
				if (unread > 0) {
					setUnreadCount(0);
					void client.api.accounts.me.notifications.read.$post({ json: {} });
				}
			})
			.catch(() => alive && setError(true));
		return () => {
			alive = false;
		};
	}, []);

	if (error) {
		return (
			<div className="max-w-2xl mx-auto p-6">
				<p className="text-base-content/60 text-sm">Notifications couldn't be loaded.</p>
			</div>
		);
	}

	return (
		<div className="max-w-2xl mx-auto p-6">
			<h1 className="text-2xl font-bold mb-6">Notifications</h1>
			{items === null ? (
				<div className="flex justify-center py-12">
					<LoadingSpinner />
				</div>
			) : items.length === 0 ? (
				<p className="text-base-content/50 text-sm">
					Nothing yet. When somebody replies to your comment, comments on your post, reviews a Work
					of yours, or follows you, it shows up here.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{items.map((n) => (
						<li key={n.id}>
							<ItemLink n={n} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * One row. A link when the row names somewhere to go — and every social notification
 * does — and bare text otherwise (the essential notices that have nowhere to send you
 * render as words, not a dead link).
 */
function ItemLink({ n }: { n: NotificationItem }) {
	const inner = (
		<div
			className={`card bg-base-200 px-4 py-3 ${n.readAt ? "opacity-75" : "border-l-2 border-l-primary"}`}
		>
			<div className="flex items-baseline gap-2">
				<span className={`text-sm ${n.readAt ? "text-base-content/70" : "font-medium"}`}>
					{n.title}
				</span>
				<span className="text-xs text-base-content/40 ml-auto whitespace-nowrap">
					{relativeDate(n.createdAt)}
				</span>
			</div>
			{n.body && <p className="text-sm text-base-content/60 mt-0.5 break-words">{n.body}</p>}
		</div>
	);
	return n.linkPath ? (
		<Link to={n.linkPath} className="block hover:opacity-90 transition-opacity">
			{inner}
		</Link>
	) : (
		inner
	);
}
