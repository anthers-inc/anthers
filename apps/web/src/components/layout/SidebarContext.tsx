import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface SidebarContextValue {
  /** Whether the sidebar drawer is open */
  sidebarOpen: boolean;
  /** Toggle sidebar open/closed */
  toggleSidebar: () => void;
  /** Page-specific sidebar content rendered below the persistent nav */
  pageContent: ReactNode | null;
  /** Called by pages to register their sidebar content; returns a cleanup fn */
  setPageContent: (content: ReactNode | null) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pageContent, setPageContentState] = useState<ReactNode | null>(null);

  const toggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), []);
  const setPageContent = useCallback(
    (content: ReactNode | null) => setPageContentState(content),
    [],
  );

  return (
    <SidebarContext value={{
      sidebarOpen,
      toggleSidebar,
      pageContent,
      setPageContent,
    }}>
      {children}
    </SidebarContext>
  );
}

/** No-op fallback for pages rendered outside LoggedInLayout (e.g. logged-out Discover) */
const NOOP_SIDEBAR: SidebarContextValue = {
  sidebarOpen: false,
  toggleSidebar: () => {},
  pageContent: null,
  setPageContent: () => {},
};

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  return ctx ?? NOOP_SIDEBAR;
}
