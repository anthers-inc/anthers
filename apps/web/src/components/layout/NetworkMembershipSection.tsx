// SPDX-License-Identifier: Apache-2.0
/**
 * The Network tab's own membership filter (Parker, 2026-10-19).
 *
 * The default network is wider than "people I follow": it is who the reader follows,
 * who they support with a Badge, and who made the posts and Works they saved or
 * bought. This section is the tab's control over that set — the one thing on the
 * sidebar that belongs to Network alone.
 *
 * 🚨 **"Following only" is the old feed, unchanged.** Narrowing to it is the escape
 * hatch for a reader who wants the strict chronological list they had before the
 * widening, so the option is not a new feature wearing a filter's name; it is the
 * previous behavior, kept reachable.
 *
 * The option ids are the `network_source` query values the feed route reads. `""` is
 * the default and means the whole network.
 */

import { BookmarkIcon, HeartIcon, UserPlusIcon, UsersIcon } from "@heroicons/react/24/outline";
import { sidebarRowClass } from "./sidebar-row-class";

const MEMBERSHIP_OPTIONS = [
	{ id: "", label: "Everyone in your network", icon: UsersIcon },
	{ id: "following", label: "Creators you follow", icon: UserPlusIcon },
	{ id: "subscribed", label: "Creators you support", icon: HeartIcon },
	{ id: "saved", label: "Saved or purchased from", icon: BookmarkIcon },
] as const;

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2";

export default function NetworkMembershipSection({
	value,
	onValue,
}: {
	/** `""` is the whole network; the rest are the feed route's `network_source` values. */
	value: string;
	onValue: (id: string) => void;
}) {
	return (
		<section>
			<h3 className={sectionTitleClass}>Membership</h3>
			<div className="flex flex-col gap-0.5">
				{MEMBERSHIP_OPTIONS.map((option) => (
					<button
						key={option.id}
						type="button"
						className={sidebarRowClass(value === option.id)}
						onClick={() => onValue(option.id)}
					>
						<option.icon className="h-5 w-5 shrink-0" />
						{option.label}
					</button>
				))}
			</div>
		</section>
	);
}
