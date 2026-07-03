// SPDX-License-Identifier: AGPL-3.0-or-later
import { LockClosedIcon } from "@heroicons/react/24/outline";
import type { AccessResult } from "../../lib/types";

/**
 * Small access badge derived from a post's resolved AccessResult:
 * free → "Free"; purchasable → "$price"; otherwise gated → a lock.
 */
export default function PricingBadge({ access }: { access?: AccessResult | null }) {
	if (!access) return null;
	if (access.isFree) {
		return <span className="badge badge-sm badge-success">Free</span>;
	}
	if (access.requiresPurchase && access.price) {
		return <span className="badge badge-sm badge-secondary">${access.price}</span>;
	}
	if (!access.canAccess && !access.requiresPurchase) {
		return (
			<span className="badge badge-sm badge-ghost gap-1">
				<LockClosedIcon className="w-3 h-3" />
				Members
			</span>
		);
	}
	return null;
}
