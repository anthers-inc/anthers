// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, Route, Routes } from "react-router-dom";
import LoggedInLayout from "./components/layout/LoggedInLayout";
import MeadowDecorLayout from "./components/layout/MeadowDecorLayout";
import PublicShell from "./components/layout/PublicShell";
import AdminRoute from "./components/ui/AdminRoute";
import ProjectRedirect from "./components/ui/ProjectRedirect";
import ProtectedRoute from "./components/ui/ProtectedRoute";
import RootRedirect from "./components/ui/RootRedirect";
import { SiteGatePanel } from "./components/ui/SiteGate";
import StudioRedirect from "./components/ui/StudioRedirect";
import AboutPage from "./pages/AboutPage";
import AdminPage from "./pages/AdminPage";
import ATProtoCallbackPage from "./pages/ATProtoCallbackPage";
// Authenticated home page
import AuthenticatedHomePage from "./pages/AuthenticatedHomePage";
import AuthPage from "./pages/AuthPage";
import CompareGhostPage from "./pages/CompareGhostPage";
import CompareItchPage from "./pages/CompareItchPage";
import CreatorBreakdownDemoPage from "./pages/CreatorBreakdownDemoPage";
import CreatorDemoPage from "./pages/CreatorDemoPage";
import CreatorMonetizationCalculatorPage from "./pages/CreatorMonetizationCalculatorPage";
import CreatorPayComparisonPage from "./pages/CreatorPayComparisonPage";
import CreatorProfilePage from "./pages/CreatorProfilePage";
// Shared content pages (work for both logged-in and logged-out)
import DesktopAuthorizePage from "./pages/DesktopAuthorizePage";
import DiscoverPage from "./pages/DiscoverPage";
import FAQPage from "./pages/FAQPage";
// Public marketing pages
import ForCreatorsPage from "./pages/ForCreatorsPage";
import InfrastructureDemoPage from "./pages/InfrastructureDemoPage";
import JamPage from "./pages/JamPage";
import JamsPage from "./pages/JamsPage";
import LibraryPage from "./pages/LibraryPage";
import PostPage from "./pages/PostPage";
import ProjectPage from "./pages/ProjectPage";
import PurchasesPage from "./pages/PurchasesPage";
import ResourcesPage from "./pages/ResourcesPage";
import RoadmapPage from "./pages/RoadmapPage";
import SettingsPage from "./pages/SettingsPage";
import SubscribePage from "./pages/SubscribePage";
import SubscriptionPage from "./pages/SubscriptionPage";
import UserDemoPage from "./pages/UserDemoPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import VideoBandwidthCalculatorPage from "./pages/VideoBandwidthCalculatorPage";
import VideoStorageCalculatorPage from "./pages/VideoStorageCalculatorPage";
import WikiPage from "./pages/WikiPage";
import WorkPage from "./pages/WorkPage";

export default function App() {
	return (
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
				{/* One combined auth page; /signup just deep-links into its signup card. */}
				<Route path="/login" element={<AuthPage initialMode="login" />} />
				<Route path="/signup" element={<AuthPage initialMode="signup" />} />
				<Route path="/auth/atproto/callback" element={<ATProtoCallbackPage />} />
			</Route>

			{/*
				Authenticated layout
				Protected routes that require login. Shows the user-focused nav
				(discover, library, dashboard, avatar dropdown).
			*/}
			<Route element={<LoggedInLayout />}>
				<Route
					path="/feed"
					element={
						<ProtectedRoute>
							<AuthenticatedHomePage />
						</ProtectedRoute>
					}
				/>
				{/*
					Creator tooling lives in the Studio (studio.anthers.org) now. Keep the whole
					/dashboard/* tree as a redirect safety net for bookmarks/stale links — it
					hard-redirects to the Studio equivalent (StudioRedirect strips /dashboard).
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
				<Route path="/jams" element={<JamsPage />} />
				<Route path="/jams/:slug" element={<JamPage />} />
				<Route path="/faq" element={<FAQPage />} />
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
				<Route path="/resources/video-bandwidth" element={<VideoBandwidthCalculatorPage />} />
				<Route
					path="/resources/creator-monetization"
					element={<CreatorMonetizationCalculatorPage />}
				/>

				{/* Creator site routes */}
				<Route path="/:username/:slug" element={<ProjectPage />} />
				<Route path="/:username/posts/:slug" element={<PostPage />} />
				<Route path="/:username/works/:slug" element={<WorkPage />} />

				{/* Creator profile -- must be last to avoid catching other routes */}
				<Route path="/:username" element={<CreatorProfilePage />} />
			</Route>
		</Routes>
	);
}
