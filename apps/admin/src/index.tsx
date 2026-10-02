// SPDX-License-Identifier: Apache-2.0
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./lib/session";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// The admin app's own sign-in is its gate; nothing else wraps the tree.
createRoot(root).render(
	<BrowserRouter>
		<SessionProvider>
			<App />
		</SessionProvider>
	</BrowserRouter>,
);
