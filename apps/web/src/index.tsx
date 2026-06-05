// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import SiteGate from "./components/ui/SiteGate";
import { AuthProvider } from "./lib/auth";
import { MediaPlayerProvider } from "./lib/media-player";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
	<SiteGate>
		<BrowserRouter>
			<AuthProvider>
				<MediaPlayerProvider>
					<App />
				</MediaPlayerProvider>
			</AuthProvider>
		</BrowserRouter>
	</SiteGate>,
);
