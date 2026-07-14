// SPDX-License-Identifier: AGPL-3.0-or-later

import { AuthProvider } from "@anthers/web-shared/auth";
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
				<MediaPlayerProvider>
					<App />
				</MediaPlayerProvider>
			</AuthProvider>
		</BrowserRouter>
	</SiteGate>,
);
