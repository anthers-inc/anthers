// SPDX-License-Identifier: Apache-2.0
/**
 * Render every standing page to the body a document carries for a reader without
 * JavaScript.
 *
 * 🚨 **Build-time only, and never in the browser bundle.** `build.ts` imports this after
 * the bundler has run, and nothing under `src/components` or `src/pages` imports it, so
 * `react-dom/server` and the whole page graph stay out of what a visitor downloads. A page
 * module that imported this would pull the server renderer into the app.
 *
 * The provider stack mirrors `src/index.tsx` minus the two pieces that only exist in a
 * browser: `BrowserRouter` becomes `MemoryRouter` at the page's own path, and `ScrollToTop`
 * is dropped. `AuthProvider` is kept rather than stubbed because the marketing pages read
 * `useAuth` for their call to action — its effects do not run during a static render, so it
 * answers the signed-out state, which is what a reader without JavaScript is.
 */
import { AuthProvider } from "@anthers/web-shared/auth";
import { ContentPreferencesProvider } from "@anthers/web-shared/content-preferences";
import { LanguageFilterProvider } from "@anthers/web-shared/language-filter";
import { SidebarProvider } from "@anthers/web-shared/sidebar";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { STANDING_PAGES } from "../pages/standing-pages";
import { MediaPlayerProvider } from "./media-player";
import { noscriptBody, stripForReaders } from "./reader-body";

/** Every standing page's reader body, by address, wrapped in the block the document carries. */
export function renderStandingPages(): Record<string, string> {
	const bodies: Record<string, string> = {};
	for (const [path, page] of Object.entries(STANDING_PAGES)) {
		const markup = renderToStaticMarkup(
			<MemoryRouter initialEntries={[path]}>
				<AuthProvider>
					<ContentPreferencesProvider>
						<LanguageFilterProvider>
							<MediaPlayerProvider>
								<SidebarProvider>{page()}</SidebarProvider>
							</MediaPlayerProvider>
						</LanguageFilterProvider>
					</ContentPreferencesProvider>
				</AuthProvider>
			</MemoryRouter>,
		);
		bodies[path] = noscriptBody(stripForReaders(markup));
	}
	return bodies;
}
