// SPDX-License-Identifier: Apache-2.0
/**
 * One row of the search dropdown: content or a navigable destination.
 *
 * The row owns the type chip and the connection chip. A connected row is not a different
 * color of row — it is the same row with one extra chip, because the ranking already
 * put it first and a second visual language for "connected" would compete with the type.
 */
import type { SearchConnection, SearchHit, SearchType } from "@anthers/shared/search";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { creatorProjectUrl, profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import {
	BoltIcon,
	Cog6ToothIcon,
	DocumentTextIcon,
	RectangleStackIcon,
	Square3Stack3DIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";
import {
	NAVIGATION_KIND_LABEL,
	type NavigationEntry,
	type NavigationKind,
} from "./navigation-index";

export type RowKind = SearchType | NavigationKind;

export interface PanelRow {
	key: string;
	kind: RowKind;
	title: string;
	subtitle: string | null;
	thumbnail: string | null;
	href: string;
	connection: SearchConnection;
}

const TYPE_LABEL: Record<RowKind, string> = {
	creator: "Creator",
	work: "Work",
	project: "Project",
	post: "Post",
	mode: NAVIGATION_KIND_LABEL.mode,
	setting: NAVIGATION_KIND_LABEL.setting,
};

const KIND_ICON: Record<RowKind, ComponentType<{ className?: string }>> = {
	creator: UserCircleIcon,
	work: Square3Stack3DIcon,
	project: RectangleStackIcon,
	post: DocumentTextIcon,
	mode: BoltIcon,
	setting: Cog6ToothIcon,
};

const CONNECTION_LABEL: Record<Exclude<SearchConnection, null>, string> = {
	self: "Yours",
	library: "In Your Library",
	following: "Following",
};

/** The canonical link for a content hit, through the helpers that own URL shape. */
export function hitHref(hit: SearchHit): string | null {
	switch (hit.kind) {
		case "creator":
			return hit.handle ? profileUrl(hit.handle) : null;
		case "work":
			return workUrl({ slug: hit.slug, publicId: hit.publicId });
		case "post":
			return hit.publicId != null
				? postUrl({ slug: hit.slug ?? "", publicId: hit.publicId })
				: null;
		case "project":
			return hit.handle && hit.slug ? creatorProjectUrl(hit.handle, hit.slug) : null;
	}
}

export function hitToRow(hit: SearchHit): PanelRow | null {
	const href = hitHref(hit);
	if (!href) return null;
	return {
		key: `${hit.kind}:${hit.id}`,
		kind: hit.kind,
		title: hit.title || "Untitled",
		subtitle: hit.subtitle,
		thumbnail: hit.thumbnail,
		href,
		connection: hit.connection,
	};
}

export function navToRow(entry: NavigationEntry): PanelRow {
	return {
		key: entry.id,
		kind: entry.kind,
		title: entry.label,
		subtitle: null,
		thumbnail: null,
		href: entry.href,
		connection: null,
	};
}

export default function SearchRow({
	row,
	index,
	active,
	onHover,
	onOpen,
}: {
	row: PanelRow;
	index: number;
	active: boolean;
	onHover: () => void;
	onOpen: () => void;
}) {
	const Icon = KIND_ICON[row.kind];
	return (
		<li role="none">
			<Link
				to={row.href}
				id={`search-row-${index}`}
				role="option"
				aria-selected={active}
				onMouseEnter={onHover}
				onClick={onOpen}
				className={`flex items-center gap-3 px-3 py-2 transition-colors ${
					active ? "bg-base-300/60" : "hover:bg-base-300/30"
				}`}
			>
				{row.thumbnail ? (
					<img src={row.thumbnail} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
				) : (
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-base-300">
						<Icon className="h-4 w-4 text-base-content/35" />
					</div>
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{row.title}</p>
					{row.subtitle && <p className="truncate text-xs text-base-content/50">{row.subtitle}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{row.connection && (
						<span
							className={`badge badge-xs ${
								row.connection === "self"
									? "badge-primary"
									: row.connection === "library"
										? "badge-secondary"
										: "badge-ghost"
							}`}
						>
							{CONNECTION_LABEL[row.connection]}
						</span>
					)}
					<span className="badge badge-ghost badge-xs">{TYPE_LABEL[row.kind]}</span>
				</div>
			</Link>
		</li>
	);
}
