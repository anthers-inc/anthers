// SPDX-License-Identifier: Apache-2.0
/**
 * "Add to basket", beside a purchasable Work's Buy control.
 *
 * Sits *next to* buying rather than replacing it, because one item is the overwhelming
 * case and routing it through a basket would be ceremony. The basket earns its place only
 * when there is more than one thing: Stripe's fixed **$0.30 is per charge, not per item**,
 * so two Works bought together leave more with the creator than the same two bought apart
 * — and Anthers keeps nothing either way, so the whole difference is theirs.
 *
 * A basket holds any number of creators (2026-10-15): one charge settles it, and the
 * completion path splits the money per creator, so adding across creators appends
 * exactly like any other add.
 */
import { Link } from "@anthers/web-shared/router";
import { CheckIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { useBasket } from "@/lib/basket";

interface AddToBasketProps {
	workId: number;
	slug: string;
	title: string;
	price: string;
	creatorHandle: string;
	thumbnail?: string | null;
}

export default function AddToBasket(props: AddToBasketProps) {
	const { add, has, count } = useBasket();
	const inBasket = has(props.workId);

	if (inBasket) {
		return (
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="inline-flex items-center gap-1 text-success">
						<CheckIcon className="w-4 h-4" /> In your basket
					</span>
					<Link to="/basket" className="link link-hover">
						View basket{count > 1 ? ` (${count})` : ""}
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<button
				type="button"
				className="btn btn-outline btn-sm w-full"
				onClick={() => {
					// `add` is async in server mode and sync in scratch mode; `Promise`
					// handles both, and neither carries anything the button needs back —
					// a refusal surfaces through the basket's own error state.
					void Promise.resolve(
						add({
							workId: props.workId,
							slug: props.slug,
							title: props.title,
							price: props.price,
							creatorHandle: props.creatorHandle,
							thumbnail: props.thumbnail ?? null,
						}),
					);
				}}
			>
				<ShoppingBagIcon className="w-4 h-4" /> Add to basket
			</button>
		</div>
	);
}