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
import { BrowserRouter } from "react-router-dom";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<AuthProvider>
				<App />
			</AuthProvider>
		</BrowserRouter>
	</StrictMode>,
);
