// SPDX-License-Identifier: Apache-2.0
import { useLocation } from "@anthers/web-shared/router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * The width at which the sidebar sits BESIDE the page; below it, the sidebar opens OVER
 * the page and starts closed. It is Tailwind's `md`, and `LoggedInLayout` spells the same
 * boundary with `md:` classes, so change both or neither.
 *
 * 🚨 **Beside the page is wrong on a phone, and it is not a matter of taste.** The sidebar
 * is 16rem, so at 390px an open one leaves the page about 140px, which wraps comment text
 * every few characters and pushes nested replies off the screen. `mobile-overflow.e2e.ts`
 * cannot see it, because it measures only logged-out routes, so `sidebar-phone.authed.e2e.ts`
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
	 * The TAB-SHARED filter sections — Type and Tags — rendered behind one more
	 * divider below the middle section, registered separately so the layout owns
	 * the seams (Parker, 2026-10-11). A page with no shared filters simply
	 * registers nothing.
	 */
	sharedContent: ReactNode | null;
	/** Same contract as `setPageContent`, for the shared sections. */
	setSharedContent: (content: ReactNode | null) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
	const [sidebarOpen, setSidebarOpen] = useState(sidebarFitsBeside);
	const [pageContent, setPageContentState] = useState<ReactNode | null>(null);
	const [sharedContent, setSharedContentState] = useState<ReactNode | null>(null);
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
			}}
		>
			{children}
		</SidebarContext>
	);
}

/** No-op fallback for pages rendered outside LoggedInLayout (e.g. logged-out Discover) */
const NOOP_SIDEBAR: SidebarContextValue = {
	sidebarOpen: false,
	toggleSidebar: () => {},
	closeSidebar: () => {},
	pageContent: null,
	setPageContent: () => {},
	sharedContent: null,
	setSharedContent: () => {},
};

export function useSidebar() {
	const ctx = useContext(SidebarContext);
	return ctx ?? NOOP_SIDEBAR;
}
