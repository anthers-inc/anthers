// SPDX-License-Identifier: AGPL-3.0-or-later

import { AuthProvider } from "@anthers/web-shared/auth";
import { ContentPreferencesProvider } from "@anthers/web-shared/content-preferences";
import { LanguageFilterProvider } from "@anthers/web-shared/language-filter";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ScrollToTop from "./components/ui/ScrollToTop";
import SiteGate from "./components/ui/SiteGate";
import { MediaPlayerProvider } from "./lib/media-player";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
	<SiteGate>
		<BrowserRouter>
			<ScrollToTop />
			<AuthProvider>
				{/* Inside AuthProvider, because who the reader is decides which preferences
				    they get — and outside the player, because a cover is veiled long before
				    anything plays. */}
				<ContentPreferencesProvider>
					{/* Beside the rating preferences, for the same reason: both are things a
					    reader asked for about how text and covers are shown to them, and both
					    are read by surfaces far from where they are set. */}
					<LanguageFilterProvider>
						<MediaPlayerProvider>
							<App />
						</MediaPlayerProvider>
					</LanguageFilterProvider>
				</ContentPreferencesProvider>
			</AuthProvider>
		</BrowserRouter>
	</SiteGate>,
);
