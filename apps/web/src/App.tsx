// SPDX-License-Identifier: AGPL-3.0-or-later
import { Route, Routes } from "react-router-dom";
import Layout from "./components/layout/Layout";
import LoggedInLayout from "./components/layout/LoggedInLayout";
import LoggedOutLayout from "./components/layout/LoggedOutLayout";
import ProjectRedirect from "./components/ui/ProjectRedirect";
import ProtectedRoute from "./components/ui/ProtectedRoute";
import RootRedirect from "./components/ui/RootRedirect";
import AboutPage from "./pages/AboutPage";
import AnalyticsDashboardPage from "./pages/AnalyticsDashboardPage";
import ATProtoCallbackPage from "./pages/ATProtoCallbackPage";
// Authenticated home page
import AuthenticatedHomePage from "./pages/AuthenticatedHomePage";
import BuildsPage from "./pages/BuildsPage";
import CompareGhostPage from "./pages/CompareGhostPage";
import CompareItchPage from "./pages/CompareItchPage";
import CreatorBreakdownDemoPage from "./pages/CreatorBreakdownDemoPage";
import CreatorDemoPage from "./pages/CreatorDemoPage";
import CreatorProfilePage from "./pages/CreatorProfilePage";
// Protected pages
import DashboardPage from "./pages/DashboardPage";
// Shared content pages (work for both logged-in and logged-out)
import DiscoverPage from "./pages/DiscoverPage";
import FAQPage from "./pages/FAQPage";
// Public marketing pages
import ForCreatorsPage from "./pages/ForCreatorsPage";
import ForUsersPage from "./pages/ForUsersPage";
import ImportPage from "./pages/ImportPage";
import InfrastructureDemoPage from "./pages/InfrastructureDemoPage";
import JamFormPage from "./pages/JamFormPage";
import JamPage from "./pages/JamPage";
import JamsPage from "./pages/JamsPage";
import LibraryPage from "./pages/LibraryPage";
// Auth pages
import LoginPage from "./pages/LoginPage";
import PostFormPage from "./pages/PostFormPage";
import PostPage from "./pages/PostPage";
import ProjectFormPage from "./pages/ProjectFormPage";
import ProjectPage from "./pages/ProjectPage";
import PurchasesPage from "./pages/PurchasesPage";
import RoadmapPage from "./pages/RoadmapPage";
import SettingsPage from "./pages/SettingsPage";
import SignupPage from "./pages/SignupPage";
import SubscribePage from "./pages/SubscribePage";
import SubscriptionPage from "./pages/SubscriptionPage";
import UserDemoPage from "./pages/UserDemoPage";
import VerticalSlicePage from "./pages/VerticalSlicePage";
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
				<Route path="/" element={<RootRedirect />} />
				<Route path="/for-creators" element={<ForCreatorsPage />} />
				<Route path="/for-users" element={<ForUsersPage />} />
				<Route path="/compare/itch-io" element={<CompareItchPage />} />
				<Route path="/compare/ghost" element={<CompareGhostPage />} />
				<Route path="/demo-creator-page" element={<CreatorDemoPage />} />
				<Route path="/demo-creator-breakdown" element={<CreatorBreakdownDemoPage />} />
				<Route path="/demo-infrastructure" element={<InfrastructureDemoPage />} />
				<Route path="/demo-user" element={<UserDemoPage />} />
				<Route path="/wiki/*" element={<WikiPage />} />
				<Route path="/about" element={<AboutPage />} />
				<Route path="/vertical-slice" element={<VerticalSlicePage />} />
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
				<Route
					path="/dashboard"
					element={
						<ProtectedRoute>
							<DashboardPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/projects/new"
					element={
						<ProtectedRoute>
							<ProjectFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/projects/:slug/edit"
					element={
						<ProtectedRoute>
							<ProjectFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/projects/:slug/builds"
					element={
						<ProtectedRoute>
							<BuildsPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/posts/new"
					element={
						<ProtectedRoute>
							<PostFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/posts/:id/edit"
					element={
						<ProtectedRoute>
							<PostFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/jams/new"
					element={
						<ProtectedRoute>
							<JamFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/jams/:slug/edit"
					element={
						<ProtectedRoute>
							<JamFormPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/import"
					element={
						<ProtectedRoute>
							<ImportPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/dashboard/analytics"
					element={
						<ProtectedRoute>
							<AnalyticsDashboardPage />
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
				<Route path="/discover" element={<DiscoverPage />} />
				<Route path="/discover/:slug" element={<ProjectRedirect />} />
				<Route path="/posts/:id" element={<PostPage />} />
				<Route path="/subscribe" element={<SubscribePage />} />
				<Route path="/jams" element={<JamsPage />} />
				<Route path="/jams/:slug" element={<JamPage />} />
				<Route path="/faq" element={<FAQPage />} />
				<Route path="/roadmap" element={<RoadmapPage />} />

				{/* Creator site routes */}
				<Route path="/:username/:slug" element={<ProjectPage />} />
				<Route path="/:username/posts/:id" element={<PostPage />} />

				{/* Creator profile -- must be last to avoid catching other routes */}
				<Route path="/:username" element={<CreatorProfilePage />} />
			</Route>
		</Routes>
	);
}
