// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's routes. Everything but sign-in is behind an admin session, and the Accounts
 * section is additionally super-admin only, which the API enforces as well.
 */
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { useSession } from "./lib/session";
import Accounts from "./pages/Accounts";
import Home from "./pages/Home";
import Infrastructure from "./pages/Infrastructure";
import AbuseReports from "./pages/legal/AbuseReports";
import Dmca from "./pages/legal/Dmca";
import LegalHolds from "./pages/legal/LegalHolds";
import Quarantine from "./pages/legal/Quarantine";
import RightsRequests from "./pages/legal/RightsRequests";
import ModerationQueue from "./pages/moderation/ModerationQueue";
import People from "./pages/moderation/People";
import RatingAppeals from "./pages/moderation/RatingAppeals";
import SignIn from "./pages/SignIn";

export default function App() {
	const { account, loading } = useSession();

	if (loading) return <Loading />;
	if (!account) return <SignIn />;

	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Home />} />
				<Route path="legal/rights-requests" element={<RightsRequests />} />
				<Route path="legal/quarantine" element={<Quarantine />} />
				<Route path="legal/abuse-reports" element={<AbuseReports />} />
				<Route path="legal/dmca" element={<Dmca />} />
				<Route path="legal/holds" element={<LegalHolds />} />
				<Route path="moderation" element={<ModerationQueue />} />
				<Route path="moderation/appeals" element={<RatingAppeals />} />
				<Route path="moderation/people" element={<People />} />
				<Route path="moderation/people/:id" element={<People />} />
				<Route path="infrastructure" element={<Infrastructure />} />
				<Route
					path="accounts"
					element={account.isSuperAdmin ? <Accounts /> : <Navigate to="/" replace />}
				/>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Route>
		</Routes>
	);
}
