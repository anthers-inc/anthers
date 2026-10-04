// SPDX-License-Identifier: Apache-2.0
/**
 * "Buy Now" on a purchasable Work — add to the basket, then go straight to it.
 *
 * 🚨 **Buy Now never skips the basket's checkout flow; it skips only the dwell.** The
 * purchase is completed exactly where every purchase is completed — the basket page's
 * embedded Checkout (`BasketCheckout`) — so there is one address form, one fee receipt,
 * one error surface, and one flow to test. What this button adds is momentum: the
 * single-item basket is now the *primary* flow rather than an edge case, because the
 * Work page's own inline checkout is retired (Parker, 2026-10-03 — "we really just
 * shouldn't have a payment/billing form on the Work page at all").
 *
 * Adding goes through `useBasket().add`, the same mechanism "Add to basket" uses — a
 * second basket would be a second truth about what the buyer means to buy.
 */
import { useNavigate } from "@anthers/web-shared/router";
import { BoltIcon } from "@heroicons/react/24/outline";
import { useBasket } from "@/lib/basket";

interface BuyNowProps {
	workId: number;
	slug: string;
	title: string;
	price: string;
	creatorHandle: string;
	thumbnail?: string | null;
}

export default function BuyNow(props: BuyNowProps) {
	const { add } = useBasket();
	const navigate = useNavigate();

	return (
		<button
			type="button"
			className="btn btn-primary"
			onClick={() => {
				// Replace-clash handling is the basket's own behavior (the server's in
				// server mode, the hook's in scratch mode): a basket held across creators is
				// replaced, and Add to-basket's own notice explains it when the buyer looks.
				// Here the basket page is where they're about to be. The add is awaited in
				// server mode so navigation lands on the basket the server actually holds —
				// navigating first would race the POST the page's own GET then answers.
				void Promise.resolve(
					add({
						workId: props.workId,
						slug: props.slug,
						title: props.title,
						price: props.price,
						creatorHandle: props.creatorHandle,
						thumbnail: props.thumbnail ?? null,
					}),
				).then(() => navigate("/basket"));
			}}
		>
			<BoltIcon className="w-4 h-4" /> Buy Now
		</button>
	);
}
