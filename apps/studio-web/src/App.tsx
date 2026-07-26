// SPDX-License-Identifier: AGPL-3.0-or-later
import AnalyticsDashboardPage from "@anthers/web-shared/AnalyticsDashboardPage";
import ContentLibraryPage from "@anthers/web-shared/ContentLibraryPage";
import DashboardPage from "@anthers/web-shared/DashboardPage";
import ImportPage from "@anthers/web-shared/ImportPage";
import JamFormPage from "@anthers/web-shared/JamFormPage";
import PostFormPage from "@anthers/web-shared/PostFormPage";
import ProjectFormPage from "@anthers/web-shared/ProjectFormPage";
import StudioSettingsPage from "@anthers/web-shared/StudioSettingsPage";
import { Outlet, Route, Routes } from "react-router-dom";
import ConsumerRedirect from "./components/ConsumerRedirect";
import StudioAuthGate from "./components/StudioAuthGate";
import StudioShell from "./components/StudioShell";

/**
 * The Studio is the all-in-one creator management surface (E50 Phase 4): the creator
 * dashboard, the content library, analytics, post/project/jam authoring, itch.io import,
 * and creator settings (payouts, platform connections, Seed tiers). Consumer/account
 * surfaces (profile, account settings, library, viewing) stay on anthers.org — every
 * non-creator path bounces there via ConsumerRedirect.
 */
function StudioLayout() {
	return (
		<StudioAuthGate>
			<StudioShell>
				<Outlet />
			</StudioShell>
		</StudioAuthGate>
	);
}

export default function App() {
	return (
		<Routes>
			<Route element={<StudioLayout />}>
				<Route path="/" element={<DashboardPage />} />
				<Route path="/library" element={<ContentLibraryPage />} />
				<Route path="/analytics" element={<AnalyticsDashboardPage />} />
				<Route path="/posts/new" element={<PostFormPage />} />
				<Route path="/posts/:slug/edit" element={<PostFormPage />} />
				<Route path="/projects/new" element={<ProjectFormPage />} />
				<Route path="/projects/:slug/edit" element={<ProjectFormPage />} />
				<Route path="/jams/new" element={<JamFormPage />} />
				<Route path="/jams/:slug/edit" element={<JamFormPage />} />
				<Route path="/import" element={<ImportPage />} />
				<Route path="/settings" element={<StudioSettingsPage />} />
			</Route>
			<Route path="*" element={<ConsumerRedirect />} />
		</Routes>
	);
}
