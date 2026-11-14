// SPDX-License-Identifier: Apache-2.0
/**
 * The standing pages, by address, as the renderer needs them.
 *
 * `page-meta.ts` lists the same addresses for a different job — the served card, the
 * sitemap — and deliberately carries no components, because `serve.ts` imports it and a
 * React import there would drag the app into the server. This file is the other half:
 * path to the page that renders it, used only by the build's prerender pass and by the
 * test that keeps the two lists equal.
 *
 * 🚨 **A page added to one list belongs in both.** A path in `page-meta.ts` with no entry
 * here ships a document with no body, and an entry here with no card there would be a page
 * a reader can reach and a sitemap cannot name; `standing-pages.test.ts` fails either way.
 *
 * `/status` is the one entry that is not its page. Its answers arrive from `GET /api/status`
 * on an interval, so there is nothing to render at build time — a rendered `StatusPage` is
 * a loading shell. What a reader without JavaScript needs instead is the one fact the page
 * itself would tell them: the standalone status page is served from a different machine.
 */
import type { ReactElement } from "react";
import AboutPage from "./AboutPage";
import AbusePage from "./AbusePage";
import CompareGhostPage from "./CompareGhostPage";
import CompareItchPage from "./CompareItchPage";
import CopyrightPage from "./CopyrightPage";
import CreatorFinancialsPage from "./CreatorFinancialsPage";
import CreatorPayComparisonPage from "./CreatorPayComparisonPage";
import FAQPage from "./FAQPage";
import ForCreatorsPage from "./ForCreatorsPage";
import ForUsersPage from "./ForUsersPage";
import HowMoneyMovesPage from "./HowMoneyMovesPage";
import LegalPage from "./LegalPage";
import MediaMonthCalculatorPage from "./MediaMonthCalculatorPage";
import ParentsPage from "./ParentsPage";
import ReleaseNotesPage from "./ReleaseNotesPage";
import ResourcesPage from "./ResourcesPage";

/** What a reader without JavaScript gets instead of the live status page. */
function StatusBody(): ReactElement {
	return (
		<p>
			This page's answers are live, and reading them needs JavaScript. The standalone page at{" "}
			<a href="https://status.anthers.org">status.anthers.org</a> is served from a different
			machine, and stays up when this one does not.
		</p>
	);
}

/** The element each standing page renders at its own address. */
export const STANDING_PAGES: Record<string, () => ReactElement> = {
	"/": () => <ForUsersPage />,
	"/for-creators": () => <ForCreatorsPage />,
	"/compare/itch-io": () => <CompareItchPage />,
	"/compare/ghost": () => <CompareGhostPage />,
	"/about": () => <AboutPage />,
	"/faq": () => <FAQPage />,
	"/parents": () => <ParentsPage />,
	"/abuse": () => <AbusePage />,
	"/copyright": () => <CopyrightPage />,
	"/resources": () => <ResourcesPage />,
	"/resources/pay-comparison": () => <CreatorPayComparisonPage />,
	"/resources/creator-financials": () => <CreatorFinancialsPage />,
	"/resources/how-money-moves": () => <HowMoneyMovesPage />,
	"/resources/media-month": () => <MediaMonthCalculatorPage />,
	"/release-notes": () => <ReleaseNotesPage />,
	"/status": () => <StatusBody />,
	"/privacy": () => <LegalPage slug="privacy" />,
	"/terms": () => <LegalPage slug="terms" />,
	"/creator-terms": () => <LegalPage slug="creator-terms" />,
};
