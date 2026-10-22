// SPDX-License-Identifier: Apache-2.0
/**
 * The notifications feed — the in-app half of "being told something happened".
 *
 * ⭐ **The list is grouped by day, because the question the page answers is "what has
 * happened since I last looked".** A flat column of relative times answers that one row
 * at a time; a day heading says it once. The sections come from the server's order
 * (newest first, tiebroken on id), never re-sorted here.
 *
 * ⭐ **It marks everything read on arrival, and that is the honest reading of the act.**
 * The person opened the list of what happened; every item in it has now been seen, and a
 * count that stayed up over entries on screen would be the bell lying about the state it
 * reports. Deliberately not per-item "mark as read": the list is short (the service
 * returns 50), the unread count is the only state the bell knows, and a control per row
 * spends UI on a distinction nobody asked for. The bell's count is told directly
 * (`clearUnread()`) rather than waiting out the poll, so it moves the moment the page
 * settles.
 *
 * 🚨 **A sign-out mid-view unmounts this page rather than re-running it**, and the
 * `alive` flag is what keeps a response that was already in flight from setting state on
 * a torn-down component. `PublicShell` picks its layout by auth state and the two layouts
 * are different component types, so signing out tears the whole logged-in tree down —
 * there is no "refetch as signed out" path here to guard.
 */

import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { NotificationItem } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";
import { clearUnread, refreshUnreadCount } from "../lib/notifications";

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

/**
 * The heading a row belongs under: today and yesterday by name, anything older by its
 * date.
 *
 * Day boundaries are built from the local calendar (`new Date(y, m, d)`), not by
 * subtracting 24 hours, so the two days either side of a daylight-saving change are still
 * whole days.
 */
function dayLabel(iso: string, now = new Date()): string {
	const then = new Date(iso);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
	const at = then.getTime();
	if (at >= startOfToday) return "Today";
	if (at >= startOfYesterday) return "Yesterday";
	return then.toLocaleDateString(undefined, { dateStyle: "medium" });
}

interface DaySection {
	label: string;
	items: NotificationItem[];
}

/** Runs of adjacent rows sharing a heading — the server's order is preserved. */
function sectionsOf(items: NotificationItem[]): DaySection[] {
	const sections: DaySection[] = [];
	for (const item of items) {
		const label = dayLabel(item.createdAt);
		const last = sections[sections.length - 1];
		if (last?.label === label) last.items.push(item);
		else sections.push({ label, items: [item] });
	}
	return sections;
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
				// ⚠️ **The re-read waits for the write.** The list was fetched BEFORE these rows
				// were marked read, so a poll landing in between would repaint the badge the
				// page just cleared; asking again only after the POST resolves is what makes
				// the count describe the state the person is looking at.
				const unread = body.notifications?.filter((n) => !n.readAt).length ?? 0;
				if (unread > 0) {
					clearUnread();
					void client.api.accounts.me.notifications.read
						.$post({ json: {} })
						.then(() => refreshUnreadCount())
						.catch(() => {});
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
					Nothing yet. Replies, comments on your posts, reviews of your Work and new followers will
					show up here.
				</p>
			) : (
				<div className="flex flex-col gap-6">
					{sectionsOf(items).map((section) => (
						<section key={section.label}>
							<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/60">
								{section.label}
							</h2>
							<ul className="flex flex-col gap-2">
								{section.items.map((n) => (
									<li key={n.id}>
										<ItemLink n={n} />
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
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
				<time
					dateTime={n.createdAt}
					className="text-xs text-base-content/40 ml-auto whitespace-nowrap"
				>
					{relativeDate(n.createdAt)}
				</time>
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
