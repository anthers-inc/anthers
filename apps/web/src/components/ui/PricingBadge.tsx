// SPDX-License-Identifier: AGPL-3.0-or-later
interface PricingBadgeProps {
	pricingType: string;
	price?: string | null;
}

export default function PricingBadge({ pricingType, price }: PricingBadgeProps) {
	if (pricingType === "free") {
		return <span className="badge badge-sm badge-success">Free</span>;
	}
	if (pricingType === "pwyw") {
		return <span className="badge badge-sm badge-warning">PWYW</span>;
	}
	// paid
	return (
		<span className="badge badge-sm badge-neutral">
			${price ? parseFloat(price).toFixed(2) : "—"}
		</span>
	);
}
