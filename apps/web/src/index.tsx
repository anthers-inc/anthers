// SPDX-License-Identifier: AGPL-3.0-or-later

import { AuthProvider } from "@anthers/web-shared/auth";
import { ContentPreferencesProvider } from "@anthers/web-shared/content-preferences";
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
					<MediaPlayerProvider>
						<App />
					</MediaPlayerProvider>
				</ContentPreferencesProvider>
			</AuthProvider>
		</BrowserRouter>
	</SiteGate>,
);
