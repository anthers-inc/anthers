// SPDX-License-Identifier: Apache-2.0
/**
 * The navigable destinations the topbar can search besides content: **Modes** and
 * **Settings**.
 *
 * These are not database rows, so there is no endpoint to query. They are a small static
 * list, filtered in the browser with the same token matcher the API uses. The list mirrors
 * the definitions the pages already hold — `NAV_LINKS` in `LoggedInLayout`, `LENSES` in
 * `SharedLensesSection`, `TAB_LABELS` in `SettingsPage` — and it is deliberately explicit
 * rather than importing those components into the layout: importing a page into its own
 * header is a dependency cycle, and the copy below is what a reader would say anyway.
 *
 * ⚠️ **The Discovery rework renames and trims these modes.** When that lands, its Phase A
 * is the moment to update this list: a result that names a mode the page no longer has is
 * a dead link the reader cannot tell from a live one.
 *
 * ⚠️ **A Settings section's deepest addressable destination is its tab.** The cards have
 * no anchors today, so a result for "Notifications" lands on Activity & Data rather than
 * scrolling to the card. That is honest about where it can take somebody.
 */

export type NavigationKind = "mode" | "setting";

export interface NavigationEntry {
	/** Stable within the list; also the React key. */
	id: string;
	label: string;
	/** What somebody might type instead of the label. */
	keywords: string[];
	href: string;
	kind: NavigationKind;
}

export const NAVIGATION_INDEX: readonly NavigationEntry[] = [
	// ── The three tabs ──────────────────────────────────────────────────────
	{
		id: "mode-feed",
		label: "Feed",
		keywords: ["home", "timeline", "network", "following", "chronological"],
		href: "/feed",
		kind: "mode",
	},
	{
		id: "mode-library",
		label: "Library",
		keywords: ["saved", "purchases", "shelf", "collection", "keep"],
		href: "/library",
		kind: "mode",
	},
	{
		id: "mode-discover",
		label: "Discover",
		keywords: ["explore", "discovery", "browse", "find"],
		href: "/discover",
		kind: "mode",
	},

	// ── Discover's current modes ────────────────────────────────────────────
	{
		id: "mode-discover-browse",
		label: "Browse",
		keywords: ["discover", "search", "grid", "catalog"],
		href: "/discover",
		kind: "mode",
	},
	{
		id: "mode-discover-inbox",
		label: "Inbox",
		keywords: ["discover", "shared", "friends", "messages"],
		href: "/discover?mode=inbox",
		kind: "mode",
	},
	{
		id: "mode-discover-network",
		label: "Network Graph",
		keywords: ["discover", "creators", "connections", "graph"],
		href: "/discover?mode=network",
		kind: "mode",
	},
	{
		id: "mode-discover-ticker",
		label: "Ticker",
		keywords: ["discover", "live", "new", "stream", "recent"],
		href: "/discover?mode=ticker",
		kind: "mode",
	},

	// ── The Library's lenses ────────────────────────────────────────────────
	{
		id: "mode-lens-none",
		label: "No Lens",
		keywords: ["library", "plain", "grid", "shelf"],
		href: "/library",
		kind: "mode",
	},
	{
		id: "mode-lens-music",
		label: "Music Player",
		keywords: ["library", "lens", "albums", "tracks", "music", "listen"],
		href: "/library?lens=music",
		kind: "mode",
	},
	{
		id: "mode-lens-channel-guide",
		label: "Channel Guide",
		keywords: ["library", "lens", "channels", "video", "television", "guide"],
		href: "/library?lens=channel-guide",
		kind: "mode",
	},
	{
		id: "mode-lens-bookshelf",
		label: "Bookshelf",
		keywords: ["library", "lens", "books", "reading", "ebooks", "comics"],
		href: "/library?lens=bookshelf",
		kind: "mode",
	},

	// ── Settings' four tabs ─────────────────────────────────────────────────
	{
		id: "setting-account",
		label: "Account Settings",
		keywords: ["settings", "account", "creator mode", "profile"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-identity",
		label: "Identity & Devices",
		keywords: ["settings", "identity", "handle", "recovery key", "sessions", "devices"],
		href: "/settings?tab=identity",
		kind: "setting",
	},
	{
		id: "setting-content",
		label: "Content & Safety",
		keywords: ["settings", "mature", "adult", "parental", "blocked", "safety"],
		href: "/settings?tab=content",
		kind: "setting",
	},
	{
		id: "setting-activity",
		label: "Activity & Data",
		keywords: ["settings", "notifications", "history", "export", "deletion", "data"],
		href: "/settings?tab=activity",
		kind: "setting",
	},

	// ── Settings' cards, each pointing at its tab ───────────────────────────
	{
		id: "setting-keyboard-shortcuts",
		label: "Keyboard Shortcuts",
		keywords: ["settings", "search", "filter", "keys", "bindings", "chords"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-supporters",
		label: "List Me on the Supporters Page",
		keywords: ["settings", "supporters", "listing", "privacy"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-billing-address",
		label: "Billing Address",
		keywords: ["settings", "billing", "address", "receipts", "tax"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-media-play",
		label: "Media & Play",
		keywords: ["settings", "previews", "audio", "playback", "volume", "browser"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-miniplayer",
		label: "The Miniplayer",
		keywords: ["settings", "player", "audio", "footer", "playback"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-creator-mode",
		label: "Enable Creator Mode",
		keywords: ["settings", "creator", "publish", "studio"],
		href: "/settings?tab=account",
		kind: "setting",
	},
	{
		id: "setting-mature-content",
		label: "Mature Content",
		keywords: ["settings", "mature", "adult", "blur", "hide", "rating"],
		href: "/settings?tab=content",
		kind: "setting",
	},
	{
		id: "setting-parental-controls",
		label: "Parental Controls",
		keywords: ["settings", "parental", "children", "pin", "family"],
		href: "/settings?tab=content",
		kind: "setting",
	},
	{
		id: "setting-blocked",
		label: "Blocked Accounts",
		keywords: ["settings", "blocked", "blocks", "unblock", "people"],
		href: "/settings?tab=content",
		kind: "setting",
	},
	{
		id: "setting-notifications",
		label: "Notifications",
		keywords: ["settings", "notifications", "email", "app", "alerts"],
		href: "/settings?tab=activity",
		kind: "setting",
	},
	{
		id: "setting-activity-history",
		label: "Your Activity History",
		keywords: ["settings", "activity", "history", "attention"],
		href: "/settings?tab=activity",
		kind: "setting",
	},
	{
		id: "setting-data",
		label: "Your Data",
		keywords: ["settings", "data", "export", "deletion", "delete account", "download"],
		href: "/settings?tab=activity",
		kind: "setting",
	},
] as const;

/** The labels the type chips use. "Mode" and "Setting" are the two local kinds. */
export const NAVIGATION_KIND_LABEL: Record<NavigationKind, string> = {
	mode: "Mode",
	setting: "Setting",
};
