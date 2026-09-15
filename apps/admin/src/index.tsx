// SPDX-License-Identifier: Apache-2.0
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./lib/session";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// No SiteGate: the admin app's own sign-in is its gate, and the pre-launch password protects the
// site rather than the people who run it.
createRoot(root).render(
	<BrowserRouter>
		<SessionProvider>
			<App />
		</SessionProvider>
	</BrowserRouter>,
);
