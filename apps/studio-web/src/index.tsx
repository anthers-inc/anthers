// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Anthers Studio entry point.
 *
 * The Studio is a separate, cross-origin-isolated origin (studio.anthers.org) that
 * hosts the creator authoring UX — sharing the consumer session via the
 * `.anthers.org`-scoped cookie (see epic E50 - Creator Studio). It mounts the shared
 * post builder (`@anthers/web-shared/PostFormPage`) behind the shared `AuthProvider`,
 * so a creator logged into anthers.org is logged into the Studio.
 *
 * Phase 1's isolation/SAB/shared-auth diagnostics proved the plumbing (crossOriginIsolated
 * true, SharedArrayBuffer available, shared session recognized); the authoring flow now
 * exercises that same cross-origin auth in production use.
 */
import { AuthProvider } from "@anthers/web-shared/auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import { isDesktop } from "./lib/desktop";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

/**
 * `HashRouter` when bundled into the desktop shell, `BrowserRouter` on the web.
 *
 * A webview serves the SPA from `tauri://localhost` with no server behind it to
 * rewrite unknown paths back to `index.html`, so a `BrowserRouter` deep link (or a
 * reload on any route but `/`) resolves to a missing file. The hash keeps the whole
 * route client-side. This is the [[Standard Library Stack]] 16.05 rule for
 * webview-hosted apps; the browser Studio keeps clean URLs, since `serve.ts` does the
 * SPA fallback for it.
 */
const Router = isDesktop() ? HashRouter : BrowserRouter;

createRoot(root).render(
	<StrictMode>
		<Router>
			<AuthProvider>
				<App />
			</AuthProvider>
		</Router>
	</StrictMode>,
);
