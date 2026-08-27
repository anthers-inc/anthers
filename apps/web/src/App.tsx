// SPDX-License-Identifier: AGPL-3.0-or-later

import { lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import LoggedInLayout from "./components/layout/LoggedInLayout";
import MeadowDecorLayout from "./components/layout/MeadowDecorLayout";
import PublicShell from "./components/layout/PublicShell";
import RouteSuspense from "./components/layout/RouteSuspense";
import AdminRoute from "./components/ui/AdminRoute";
import ProjectRedirect from "./components/ui/ProjectRedirect";
import ProtectedRoute from "./components/ui/ProtectedRoute";
import RootRedirect from "./components/ui/RootRedirect";
import { SiteGatePanel } from "./components/ui/SiteGate";
import StudioRedirect from "./components/ui/StudioRedirect";

/**
 * The Studio — the creator authoring surface, merged in from `apps/studio-web` on
 * 2026-08-11 and now a SECTION of this app rather than a separate origin.
 *
 * LAZY, and that is the whole reason this is tolerable: these eight pages drag in the
 * authoring stack (TipTap, recharts) which a reader browsing the site must never
 * download. `React.lazy` keeps them in their own chunks, fetched on first navigation
 * into /studio. (ffmpeg.wasm was the heaviest of them until 2026-08-17, when the
 * browser encoder was removed — see WorkEditor.)
 *
 * The origin split existed to give the Studio cross-origin isolation for multi-threaded
 * ffmpeg.wasm. That is DORMANT (`@ffmpeg/core-mt` hangs at pthread spawn in-browser, so
 * the Studio ran the same single-threaded path as the site), and isolation is per-DOCUMENT
 * rather than per-origin anyway — so the split was buying nothing while costing a second
 * app, a second origin, a CORS allowlist and a dot-prefixed cookie domain.
 */
const StudioShell = lazy(() => import("./studio/StudioShell"));
const StudioAuthGate = lazy(() => import("./studio/StudioAuthGate"));
const DashboardPage = lazy(() => import("@anthers/web-shared/DashboardPage"));
const CatalogPage = lazy(() => import("@anthers/web-shared/CatalogPage"));
const AnalyticsDashboardPage = lazy(() => import("@anthers/web-shared/AnalyticsDashboardPage"));
const PostFormPage = lazy(() => import("@anthers/web-shared/PostFormPage"));
const ProjectFormPage = lazy(() => import("@anthers/web-shared/ProjectFormPage"));
// ImportPage lazy import kept commented — the route is hidden (see below) but the
// component remains so re-enabling is a one-line change when the lane ships.
// const ImportPage = lazy(() => import("@anthers/web-shared/ImportPage"));
const StudioSettingsPage = lazy(() => import("@anthers/web-shared/StudioSettingsPage"));

/** Shell + creator gate + a suspense boundary, wrapped once for every /studio route. */
function StudioLayout() {
	return (
		<RouteSuspense>
			<StudioAuthGate>
				<StudioShell>
					<Outlet />
				</StudioShell>
			</StudioAuthGate>
		</RouteSuspense>
	);
}

/**
 * Every route page is LAZY. Only the homepage is not, and it is reached through
 * `RootRedirect`, which imports `ForUsersPage` statically because it IS the first paint.
 *
 * Measured before this change: a cold visitor landing on `/` downloaded 3306 KB, of which
 * ~1.4 MB belonged to two pages they were not looking at — `WikiPage` dragging in the MDX
 * pipeline (refractor 433 KB, acorn 230 KB, parse5 125 KB, katex 265 KB) and `AdminPage`
 * dragging in recharts (257 KB). A static import in this file is the whole reason: it puts
 * the module in the entry graph no matter which route renders.
 *
 * 🚨 So DON'T add a static page import here — that is the mistake this comment exists to
 * prevent, and it is invisible until someone measures. The cost of getting it wrong is
 * paid by every reader on every visit; the cost of `lazy` is one spinner on first
 * navigation to that route.
 */
const AboutPage = lazy(() => import("./pages/AboutPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const ATProtoCallbackPage = lazy(() => import("./pages/ATProtoCallbackPage"));
const AuthenticatedHomePage = lazy(() => import("./pages/AuthenticatedHomePage"));
const CompareGhostPage = lazy(() => import("./pages/CompareGhostPage"));
const CompareItchPage = lazy(() => import("./pages/CompareItchPage"));
const CreatorBreakdownDemoPage = lazy(() => import("./pages/CreatorBreakdownDemoPage"));
const CreatorDemoPage = lazy(() => import("./pages/CreatorDemoPage"));
const CreatorMonetizationCalculatorPage = lazy(
	() => import("./pages/CreatorMonetizationCalculatorPage"),
);
const CreatorPayComparisonPage = lazy(() => import("./pages/CreatorPayComparisonPage"));
const CreatorProfilePage = lazy(() => import("./pages/CreatorProfilePage"));
const DesktopAuthorizePage = lazy(() => import("./pages/DesktopAuthorizePage"));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage"));
const FAQPage = lazy(() => import("./pages/FAQPage"));
const ForCreatorsPage = lazy(() => import("./pages/ForCreatorsPage"));
const InfrastructureDemoPage = lazy(() => import("./pages/InfrastructureDemoPage"));
const LegalPage = lazy(() => import("./pages/LegalPage"));
const CopyrightPage = lazy(() => import("./pages/CopyrightPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const BasketPage = lazy(() => import("./pages/BasketPage"));
const ParentsPage = lazy(() => import("./pages/ParentsPage"));
const SafetyPage = lazy(() => import("./pages/SafetyPage"));
const PostPage = lazy(() => import("./pages/PostPage"));
const ProjectPage = lazy(() => import("./pages/ProjectPage"));
const PurchasesPage = lazy(() => import("./pages/PurchasesPage"));
const ResourcesPage = lazy(() => import("./pages/ResourcesPage"));
const RoadmapPage = lazy(() => import("./pages/RoadmapPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const FinishSignupPage = lazy(() => import("./pages/FinishSignupPage"));
const SubscribePage = lazy(() => import("./pages/SubscribePage"));
const SubscriptionPage = lazy(() => import("./pages/SubscriptionPage"));
const UserDemoPage = lazy(() => import("./pages/UserDemoPage"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage"));
const WelcomePage = lazy(() => import("./pages/WelcomePage"));
const VideoStorageCalculatorPage = lazy(() => import("./pages/VideoStorageCalculatorPage"));
const WikiPage = lazy(() => import("./pages/WikiPage"));
const WorkPage = lazy(() => import("./pages/WorkPage"));

/**
 * A LAST-RESORT boundary, for routes that render outside a layout. The boundaries that
 * actually catch page loads are the ones around each `<Outlet />` — in LoggedOutLayout,
 * LoggedInLayout and MeadowDecorLayout — because React uses the *nearest* one, and
 * suspending up here would tear down the shell and repaint the botanical decor on every
 * navigation. That decor not remounting is the whole reason PublicShell exists (read its
 * header), so a page chunk arriving must never be able to unmount it.
 */
export default function App() {
	return (
		<RouteSuspense>
			<Routes>
				{/*
				Preview route for the pre-launch SiteGate. The gate normally renders as a
				wall outside the router (see index.tsx), so once you're past it locally its
				look can't be revisited without clearing the anthers_site_access flag. This
				mounts the same panel on its own URL so it's easy to tinker with. Reaching
				it at all means you're already authorized, so the panel is just a preview.
			*/}
				<Route path="/site-gate" element={<SiteGatePanel />} />

				{/*
				Marketing / logged-out layout
				These pages always show the marketing chrome (sign up/log in buttons,
				marketing nav links) — `forceMarketing` keeps it that way even for
				logged-in users. Authenticated users hitting / get redirected to /feed.
				Shares the PublicShell component with the shared-content group below so
				the botanical decor never remounts as you navigate between them.
			*/}
				<Route element={<PublicShell forceMarketing />}>
					{/* The For Users page is the homepage (RootRedirect renders it for logged-out
					visitors; authed users go to /feed). It renders its own <MeadowDecor>. */}
					<Route path="/" element={<RootRedirect />} />
					{/* /for-users is retired as a destination — redirect old links to the homepage. */}
					<Route path="/for-users" element={<Navigate to="/" replace />} />
					{/* For Creators renders its own <MeadowDecor> (editorial page). */}
					<Route path="/for-creators" element={<ForCreatorsPage />} />
					{/* Secondary marketing pages share the botanical decor (vines + pollen) via
					the nested MeadowDecorLayout; the grassy floor comes from LoggedOutLayout. */}
					<Route element={<MeadowDecorLayout />}>
						<Route path="/compare/itch-io" element={<CompareItchPage />} />
						<Route path="/compare/ghost" element={<CompareGhostPage />} />
						<Route path="/demo-creator-page" element={<CreatorDemoPage />} />
						<Route path="/demo-creator-breakdown" element={<CreatorBreakdownDemoPage />} />
						<Route path="/demo-infrastructure" element={<InfrastructureDemoPage />} />
						<Route path="/demo-user" element={<UserDemoPage />} />
						<Route path="/about" element={<AboutPage />} />
					</Route>
					<Route path="/wiki/*" element={<WikiPage />} />
					{/* Logging in to an account that already exists. Signing UP is /subscribe —
					    one door, one ceremony (email → code → /welcome for the handle and the
					    terms). The four-field Create Account card was deleted 2026-08-17; see
					    pages/LoginPage.tsx. /signup is kept as a redirect because it is the URL
					    people (and old links, and the browser's own autofill heuristics) expect. */}
					<Route path="/login" element={<LoginPage />} />
					<Route path="/signup" element={<Navigate to="/subscribe" replace />} />
					<Route path="/auth/atproto/callback" element={<ATProtoCallbackPage />} />
					{/* Finishing a signup, and it belongs in the LOGGED-OUT shell beside the other
					    two: the person standing here has a pending signup and no account, so the
					    signed-in layout would offer them a sidebar of things they cannot reach.
					    It is deliberately not behind `ProtectedRoute` either — what admits
					    somebody is the pending signup rather than a session. 🚨 The page's own
					    guard is what stops this becoming a second signup door: with no pending
					    record it sends you to `/subscribe`, and there is no way to start one
					    from here. */}
					<Route path="/finish" element={<FinishSignupPage />} />
				</Route>

				{/*
				Authenticated layout
				Protected routes that require login. Shows the user-focused nav
				(discover, library, dashboard, avatar dropdown).
			*/}
				<Route element={<LoggedInLayout />}>
					{/*
					Onboarding. Signed in but nameless — so it sits inside the logged-in
					layout yet deliberately OUTSIDE ProtectedRoute, whose own guard sends a
					handle-less account here. Wrapping it would redirect it to itself. The
					page does the equivalent check itself, and bounces anyone who has no
					business here (signed out, or already named).
				*/}
					<Route path="/welcome" element={<WelcomePage />} />
					<Route
						path="/feed"
						element={
							<ProtectedRoute>
								<AuthenticatedHomePage />
							</ProtectedRoute>
						}
					/>
					{/*
					Creator tooling lives under /studio. Keep the whole /dashboard/* tree as a
					redirect safety net for bookmarks and stale links — StudioRedirect strips
					the /dashboard prefix and navigates, in-app, to the /studio equivalent.
				*/}
					<Route
						path="/dashboard/*"
						element={
							<ProtectedRoute>
								<StudioRedirect />
							</ProtectedRoute>
						}
					/>
					{/* Discover is a logged-in browse/search experience (search sends queries
					here). It's intentionally gated — logged-out visitors are bounced to
					login rather than seeing it dressed in marketing chrome. The legacy
					/discover/:slug redirect stays public (it just bounces to canonical URLs). */}
					<Route
						path="/discover"
						element={
							<ProtectedRoute>
								<DiscoverPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/library"
						element={
							<ProtectedRoute>
								<LibraryPage />
							</ProtectedRoute>
						}
					/>
					{/*
					 * Deliberately NOT a ProtectedRoute. A basket is a scratchpad in
					 * localStorage, so a logged-out reader can fill one and is asked to log
					 * in at the point of payment — where the ask is motivated — rather than
					 * at the point of browsing, where it is a wall.
					 */}
					<Route path="/basket" element={<BasketPage />} />
					<Route
						path="/subscription"
						element={
							<ProtectedRoute>
								<SubscriptionPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/purchases"
						element={
							<ProtectedRoute>
								<PurchasesPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/settings"
						element={
							<ProtectedRoute>
								<SettingsPage />
							</ProtectedRoute>
						}
					/>
					{/* Desktop Studio sign-in confirmation. Opened in the system browser by the
					packaged app; the creator confirms here and the app receives a one-time
					code over its anthers:// scheme. Handles its own auth bounce so the
					sign-in round trip returns to this exact URL (challenge intact). */}
					<Route path="/desktop/authorize" element={<DesktopAuthorizePage />} />
					{/* Admin / operations console — platform operators only (AdminRoute
					mirrors the API's requireAdmin; non-admins are bounced home). */}
					<Route
						path="/admin"
						element={
							<AdminRoute>
								<AdminPage />
							</AdminRoute>
						}
					/>
				</Route>

				{/*
				Shared content routes
				These use the auth-switching PublicShell: logged-in users see
				LoggedInLayout, logged-out users see LoggedOutLayout. Content is
				accessible to everyone. Same component as the marketing group above
				(there with `forceMarketing`), so the logged-out shell + decor stay
				mounted when navigating across the whole public surface.
			*/}
				<Route element={<PublicShell />}>
					<Route path="/verify-email" element={<VerifyEmailPage />} />
					<Route path="/discover/:slug" element={<ProjectRedirect />} />
					<Route path="/posts/:slug" element={<PostPage />} />
					{/* A Work stands on its own — reachable whether or not a post ever mentioned it. */}
					<Route path="/works/:slug" element={<WorkPage />} />
					<Route path="/subscribe" element={<SubscribePage />} />
					<Route path="/faq" element={<FAQPage />} />
					{/* Published PENDING — no effective date, and a banner saying so. See
				    pages/LegalPage.tsx: the date is what turns a draft into a
				    representation, and it is a deliberate act rather than a tidy-up. */}
					<Route path="/privacy" element={<LegalPage slug="privacy" />} />
					<Route path="/terms" element={<LegalPage slug="terms" />} />
					<Route path="/creator-terms" element={<LegalPage slug="creator-terms" />} />
					<Route path="/copyright" element={<CopyrightPage />} />
					<Route path="/parents" element={<ParentsPage />} />
					<Route path="/safety" element={<SafetyPage />} />
					{/* The subject-named route is canonical; `/abuse` is the RFC 2142 name a
					    provider or researcher guesses, kept reachable so a guess lands somewhere
					    rather than on a 404. Parker, 2026-08-25. */}
					<Route path="/abuse" element={<Navigate to="/safety" replace />} />
					<Route path="/roadmap" element={<RoadmapPage />} />

					{/* Resource tools / calculators — public, work logged-in or out.
					Must be registered before the /:username catch-alls below. */}
					<Route element={<MeadowDecorLayout />}>
						{/* The resources landing gets the botanical decor; the calculators and the
						pay-comparison stay plain so nothing crowds their dense controls/tables. */}
						<Route path="/resources" element={<ResourcesPage />} />
					</Route>
					<Route path="/resources/pay-comparison" element={<CreatorPayComparisonPage />} />
					<Route path="/resources/video-storage" element={<VideoStorageCalculatorPage />} />
					<Route
						path="/resources/creator-monetization"
						element={<CreatorMonetizationCalculatorPage />}
					/>

					{/* The Studio. Placed before the /:username catch-alls for readability, NOT for
					correctness — React Router v6 ranks matches by specificity rather than by
					registration order, so a static `/studio` segment beats a dynamic `/:username`
					wherever it sits. Verified by moving this block below the catch-all: every
					route test still passed. The real hazard is a creator actually named
					"studio", which route order cannot help with either. */}
					<Route path="/studio" element={<StudioLayout />}>
						<Route index element={<DashboardPage />} />
						<Route path="catalog" element={<CatalogPage />} />
						{/* kept so existing Studio links and bookmarks don't break */}
						<Route path="library" element={<CatalogPage />} />
						<Route path="analytics" element={<AnalyticsDashboardPage />} />
						<Route path="posts/new" element={<PostFormPage />} />
						<Route path="posts/:slug/edit" element={<PostFormPage />} />
						<Route path="projects/new" element={<ProjectFormPage />} />
						<Route path="projects/:slug/edit" element={<ProjectFormPage />} />
						{/* Import route hidden — the itch.io import endpoints all return
					    "not yet implemented", so a creator who reaches this page finds a
					    form that always fails. Restore when the Cross-Publishing lane
					    ships its import endpoints. */}
						{/* <Route path="import" element={<ImportPage />} /> */}
						<Route path="settings" element={<StudioSettingsPage />} />
					</Route>

					{/* Creator site routes */}
					<Route path="/:username/:slug" element={<ProjectPage />} />
					<Route path="/:username/posts/:slug" element={<PostPage />} />
					<Route path="/:username/works/:slug" element={<WorkPage />} />

					{/* Creator profile -- must be last to avoid catching other routes */}
					<Route path="/:username" element={<CreatorProfilePage />} />
				</Route>
			</Routes>
		</RouteSuspense>
	);
}
