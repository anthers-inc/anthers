// SPDX-License-Identifier: Apache-2.0

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useLocation } from "./router";

/**
 * The width at which the sidebar sits BESIDE the page; below it, the sidebar opens OVER
 * the page and starts closed. It is Tailwind's `md`, and the signed-in layout spells the
 * same boundary with `md:` classes, so change both or neither.
 *
 * 🚨 **Beside the page is wrong on a phone, and it is not a matter of taste.** The sidebar
 * is 16rem, so at 390px an open one leaves the page about 140px, which wraps comment text
 * every few characters and pushes nested replies off the screen. The layout that renders
 * this sidebar carries the same breakpoint in its classes, and `sidebar-phone.authed.e2e.ts`
 * is the guard.
 */
const SIDEBAR_BESIDE_QUERY = "(min-width: 48rem)";

/** No window to measure: assume the wide layout, which is the one the sidebar is designed as. */
const sidebarFitsBeside = () =>
	typeof window === "undefined" || window.matchMedia(SIDEBAR_BESIDE_QUERY).matches;

interface SidebarContextValue {
	/** Whether the sidebar drawer is open */
	sidebarOpen: boolean;
	/** Toggle sidebar open/closed */
	toggleSidebar: () => void;
	/** Close the sidebar — the backdrop's action on a phone */
	closeSidebar: () => void;
	/**
	 * The page's MIDDLE-SECTION sidebar content, rendered behind the persistent divider
	 * under the nav (Parker, 2026-10-11): Bookmarks and Access on the Feed, the Lenses
	 * on the Library. The layout owns that divider; the page owns only its content.
	 */
	pageContent: ReactNode | null;
	/** Called by pages to register their sidebar content; returns a cleanup fn */
	setPageContent: (content: ReactNode | null) => void;
	/**
	 * The TAB-SHARED filter sections — Types and Tags — rendered behind one more
	 * divider below the middle section, registered separately so the layout owns
	 * the seams (Parker, 2026-10-11). A page with no shared filters simply
	 * registers nothing.
	 */
	sharedContent: ReactNode | null;
	/** Same contract as `setPageContent`, for the shared sections. */
	setSharedContent: (content: ReactNode | null) => void;
	/**
	 * The page's content for the header's CENTER — the slot the search bar occupies in
	 * user mode (Parker, 2026-11-07). A subject's owner registers the View As control
	 * here, so the same control lands in the same place on every subject page that has
	 * one; a page that registers nothing leaves the search bar alone.
	 */
	topBarContent: ReactNode | null;
	/** Called by pages to register their header content; returns a cleanup fn. */
	setTopBarContent: (content: ReactNode | null) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

/**
 * ⭐ **The open/closed choice belongs to the session, not to whichever layout is drawing the
 * sidebar.** Two route groups mount a signed-in layout — the authenticated group and
 * `PublicShell`'s shared pages — so React tears one shell down and builds the other when a
 * person moves between a Work and Library, Discovery or Settings. This provider therefore
 * wraps `<App />` at the root in `index.tsx`, above the router's `<Routes>`; a choice made on
 * either side is the same boolean on the other, and nothing about navigation resets it.
 *
 * 🚨 **The one exception for a sidebar beside the page is the window narrowing across the
 * breakpoint above.** A sidebar open beside a wide window has nowhere to sit once the page
 * turns vertical, so it puts itself away there. Widening again deliberately does not reopen
 * it: the person's last choice is still the one to keep, and only the toggle changes it. (A
 * phone's drawer is the over-page shape, and its own rule closes it on navigation — the
 * effect below.)
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
	const [sidebarOpen, setSidebarOpen] = useState(sidebarFitsBeside);
	const [pageContent, setPageContentState] = useState<ReactNode | null>(null);
	const [sharedContent, setSharedContentState] = useState<ReactNode | null>(null);
	const [topBarContent, setTopBarContentState] = useState<ReactNode | null>(null);
	const { pathname } = useLocation();

	const toggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), []);
	const closeSidebar = useCallback(() => setSidebarOpen(false), []);
	const setPageContent = useCallback(
		(content: ReactNode | null) => setPageContentState(content),
		[],
	);
	const setSharedContent = useCallback(
		(content: ReactNode | null) => setSharedContentState(content),
		[],
	);
	const setTopBarContent = useCallback(
		(content: ReactNode | null) => setTopBarContentState(content),
		[],
	);

	// A drawer over the page hides the page it just navigated to, so on a phone going
	// somewhere closes it. Only the path counts: the Feed's filters rewrite the query string,
	// and closing on each one would shut the drawer between two taps on the same filter list.
	// ⚠️ It skips the first render on purpose. The starting state is `sidebarFitsBeside`'s
	// job, and an effect that also closed the drawer on mount would hide a phone starting
	// open behind a slide-shut animation rather than letting it fail.
	const lastPathname = useRef(pathname);
	useEffect(() => {
		if (lastPathname.current === pathname) return;
		lastPathname.current = pathname;
		if (!sidebarFitsBeside()) setSidebarOpen(false);
	}, [pathname]);

	// The window's one vote: narrowing across the breakpoint collapses the sidebar, because
	// below it the sidebar opens OVER the page rather than beside it and an open one would
	// cover the content. The rule runs one way on purpose — widening does not reopen what
	// somebody closed; that is the toggle's job.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const query = window.matchMedia(SIDEBAR_BESIDE_QUERY);
		const handleChange = (event: MediaQueryListEvent) => {
			if (!event.matches) setSidebarOpen(false);
		};
		query.addEventListener("change", handleChange);
		return () => query.removeEventListener("change", handleChange);
	}, []);

	return (
		<SidebarContext
			value={{
				sidebarOpen,
				toggleSidebar,
				closeSidebar,
				pageContent,
				setPageContent,
				sharedContent,
				setSharedContent,
				topBarContent,
				setTopBarContent,
			}}
		>
			{children}
		</SidebarContext>
	);
}

/** No-op fallback for pages rendered outside a layout carrying the sidebar */
const NOOP_SIDEBAR: SidebarContextValue = {
	sidebarOpen: false,
	toggleSidebar: () => {},
	closeSidebar: () => {},
	pageContent: null,
	setPageContent: () => {},
	sharedContent: null,
	setSharedContent: () => {},
	topBarContent: null,
	setTopBarContent: () => {},
};

export function useSidebar() {
	const ctx = useContext(SidebarContext);
	return ctx ?? NOOP_SIDEBAR;
}
