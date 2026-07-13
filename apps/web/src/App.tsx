// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/layout/Layout";
import LoggedInLayout from "./components/layout/LoggedInLayout";
import LoggedOutLayout from "./components/layout/LoggedOutLayout";
import MeadowDecorLayout from "./components/layout/MeadowDecorLayout";
import ProjectRedirect from "./components/ui/ProjectRedirect";
import ProtectedRoute from "./components/ui/ProtectedRoute";
import RootRedirect from "./components/ui/RootRedirect";
import StudioRedirect from "./components/ui/StudioRedirect";
import AboutPage from "./pages/AboutPage";
import ATProtoCallbackPage from "./pages/ATProtoCallbackPage";
// Authenticated home page
import AuthenticatedHomePage from "./pages/AuthenticatedHomePage";
import CompareGhostPage from "./pages/CompareGhostPage";
import CompareItchPage from "./pages/CompareItchPage";
import CreatorBreakdownDemoPage from "./pages/CreatorBreakdownDemoPage";
import CreatorDemoPage from "./pages/CreatorDemoPage";
import CreatorMonetizationCalculatorPage from "./pages/CreatorMonetizationCalculatorPage";
import CreatorProfilePage from "./pages/CreatorProfilePage";
// Shared content pages (work for both logged-in and logged-out)
import DiscoverPage from "./pages/DiscoverPage";
import FAQPage from "./pages/FAQPage";
// Public marketing pages
import ForCreatorsPage from "./pages/ForCreatorsPage";
import InfrastructureDemoPage from "./pages/InfrastructureDemoPage";
import JamPage from "./pages/JamPage";
import JamsPage from "./pages/JamsPage";
import LibraryPage from "./pages/LibraryPage";
// Auth pages
import LoginPage from "./pages/LoginPage";
import PostPage from "./pages/PostPage";
import ProjectPage from "./pages/ProjectPage";
import PurchasesPage from "./pages/PurchasesPage";
import ResourcesPage from "./pages/ResourcesPage";
import RoadmapPage from "./pages/RoadmapPage";
import SettingsPage from "./pages/SettingsPage";
import SignupPage from "./pages/SignupPage";
import SubscribePage from "./pages/SubscribePage";
import SubscriptionPage from "./pages/SubscriptionPage";
import UserDemoPage from "./pages/UserDemoPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import VideoBandwidthCalculatorPage from "./pages/VideoBandwidthCalculatorPage";
import VideoStorageCalculatorPage from "./pages/VideoStorageCalculatorPage";
import WikiPage from "./pages/WikiPage";

export default function App() {
	return (
		<Routes>
			{/*
				Marketing / logged-out layout
				These pages always show the marketing chrome (sign up/log in buttons,
				marketing nav links).         Authenticated users hitting / get redirected to /feed.
			*/}
			<Route element={<LoggedOutLayout />}>
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
				<Route path="/login" element={<LoginPage />} />
				<Route path="/signup" element={<SignupPage />} />
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
			</Route>

			{/*
				Shared content routes
				These use the auth-switching Layout: logged-in users see LoggedInLayout,
				logged-out users see LoggedOutLayout. Content is accessible to everyone.
			*/}
			<Route element={<Layout />}>
				<Route path="/verify-email" element={<VerifyEmailPage />} />
				<Route path="/discover" element={<DiscoverPage />} />
				<Route path="/discover/:slug" element={<ProjectRedirect />} />
				<Route path="/posts/:slug" element={<PostPage />} />
				<Route path="/subscribe" element={<SubscribePage />} />
				<Route path="/jams" element={<JamsPage />} />
				<Route path="/jams/:slug" element={<JamPage />} />
				<Route path="/faq" element={<FAQPage />} />
				<Route path="/roadmap" element={<RoadmapPage />} />

				{/* Resource tools / calculators — public, work logged-in or out.
					Must be registered before the /:username catch-alls below. */}
				<Route element={<MeadowDecorLayout />}>
					{/* The resources landing gets the botanical decor; the calculators stay
						plain so the vines don't crowd their controls. */}
					<Route path="/resources" element={<ResourcesPage />} />
				</Route>
				<Route path="/resources/video-storage" element={<VideoStorageCalculatorPage />} />
				<Route path="/resources/video-bandwidth" element={<VideoBandwidthCalculatorPage />} />
				<Route
					path="/resources/creator-monetization"
					element={<CreatorMonetizationCalculatorPage />}
				/>

				{/* Creator site routes */}
				<Route path="/:username/:slug" element={<ProjectPage />} />
				<Route path="/:username/posts/:slug" element={<PostPage />} />

				{/* Creator profile -- must be last to avoid catching other routes */}
				<Route path="/:username" element={<CreatorProfilePage />} />
			</Route>
		</Routes>
	);
}
