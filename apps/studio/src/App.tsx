// SPDX-License-Identifier: AGPL-3.0-or-later
import PostFormPage from "@anthers/web-shared/PostFormPage";
import { Route, Routes } from "react-router-dom";
import ConsumerRedirect from "./components/ConsumerRedirect";
import StudioAuthGate from "./components/StudioAuthGate";
import StudioShell from "./components/StudioShell";

/**
 * Studio v1 owns exactly the post authoring routes (create a draft + manage its media).
 * Everything else bounces to the consumer site (ConsumerRedirect). Analytics, settings,
 * and the rest of the creator dashboard stay on the main site for now (see epic E50).
 */
function Authoring() {
	return (
		<StudioAuthGate>
			<StudioShell>
				<PostFormPage />
			</StudioShell>
		</StudioAuthGate>
	);
}

export default function App() {
	return (
		<Routes>
			<Route path="/posts/new" element={<Authoring />} />
			<Route path="/posts/:slug/edit" element={<Authoring />} />
			<Route path="*" element={<ConsumerRedirect />} />
		</Routes>
	);
}
