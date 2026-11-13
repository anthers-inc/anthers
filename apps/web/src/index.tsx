// SPDX-License-Identifier: Apache-2.0

import { AuthProvider } from "@anthers/web-shared/auth";
import { ContentPreferencesProvider } from "@anthers/web-shared/content-preferences";
import { LanguageFilterProvider } from "@anthers/web-shared/language-filter";
import { SidebarProvider } from "@anthers/web-shared/sidebar";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ScrollToTop from "./components/ui/ScrollToTop";
import { MediaPlayerProvider } from "./lib/media-player";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
	<BrowserRouter>
		<ScrollToTop />
		<AuthProvider>
			{/* Inside AuthProvider, because who the user is decides which preferences
			    they get — and outside the player, because a cover is veiled long before
			    anything plays. */}
			<ContentPreferencesProvider>
				{/* Beside the rating preferences, for the same reason: both are things a
				    user asked for about how text and covers are shown to them, and both
				    are read by surfaces far from where they are set. */}
				<LanguageFilterProvider>
					<MediaPlayerProvider>
						{/* ⭐ **The sidebar's open/closed choice is the session's, not the layout's.**
						    Two route groups mount a signed-in layout — the authenticated group and
						    `PublicShell`'s shared pages — so a Work and Library, Discovery or
						    Settings are drawn by different shell instances, and moving between
						    them remounts the layout. A provider inside the layout would forget
						    the choice at that seam; here one boolean survives every route
						    change, and only narrowing the window puts the sidebar away (its
						    reasoning lives in `web-shared/src/lib/sidebar.tsx`). */}
						<SidebarProvider>
							<App />
						</SidebarProvider>
					</MediaPlayerProvider>
				</LanguageFilterProvider>
			</ContentPreferencesProvider>
		</AuthProvider>
	</BrowserRouter>,
);
