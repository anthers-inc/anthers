// SPDX-License-Identifier: Apache-2.0

/*
 * Badges & Purchases — one page for everything this account has given.
 *
 * Both halves answer the same question, which is why they share a page: the Badges section
 * is the standing monthly relationship (what the account holds from Anthers and from the
 * creators it backs), and the Purchases section is the one-time receipts below it. They
 * were two destinations until 2026-10-23, which made a reader choose a page before they
 * knew which half their answer was in (Parker).
 *
 * `/purchases` is the canonical address, and that is deliberate: it answers at the URL the
 * account menu, the billing portal's return path and the post-subscribe redirect already
 * name, so `/badges` and `/subscription` redirect here rather than every reference moving.
 *
 * `min-w-0 w-full max-w-full` breaks the flex-column min-content cascade so this wrapper
 * can shrink below its inner content's min-content width on mobile (the same fix the other
 * top-level pages carry). Without `w-full`, `mx-auto` on a flex item disables the default
 * `align-self: stretch`, so the wrapper falls back to its content's intrinsic width (up to
 * the cap), which can push past the mobile viewport. The page takes a reading measure
 * rather than a dashboard width — what it holds is lists and cards, not a wide grid.
 */

import BadgesSection from "../components/account/BadgesSection";
import PurchasesSection from "../components/account/PurchasesSection";

export default function PurchasesPage() {
	return (
		<div className="mx-auto min-w-0 w-full max-w-full max-w-4xl px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">Badges &amp; Purchases</h1>
			<BadgesSection />
			<PurchasesSection />
		</div>
	);
}
