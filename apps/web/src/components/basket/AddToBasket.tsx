// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Add to basket", beside a purchasable Work's Buy control.
 *
 * Sits *next to* buying rather than replacing it, because one item is the overwhelming
 * case and routing it through a basket would be ceremony. The basket earns its place only
 * when there is more than one thing: Stripe's fixed **$0.30 is per charge, not per item**,
 * so two Works bought together leave more with the creator than the same two bought apart
 * — and Anthers keeps nothing either way, so the whole difference is theirs.
 *
 * ⚠️ A basket holds **one creator at a time** (Stripe's `transfer_data.destination` names
 * a single account). Adding across creators replaces rather than refuses, and says so —
 * finding out at the payment step would be the worst possible moment.
 */
import { Link } from "@anthers/web-shared/router";
import { CheckIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useBasket } from "@/lib/basket";

interface AddToBasketProps {
	workId: number;
	slug: string;
	title: string;
	price: string;
	creatorUsername: string;
	thumbnail?: string | null;
}

export default function AddToBasket(props: AddToBasketProps) {
	const { add, has, count } = useBasket();
	const [replaced, setReplaced] = useState<string | null>(null);
	const inBasket = has(props.workId);

	/**
	 * 🚨 Rendered ABOVE the branch, not inside the pre-add one.
	 *
	 * Adding is exactly what makes `inBasket` true, so the component swaps branches on the
	 * same tick the message is set — and the first version put this warning in the branch
	 * that had just stopped rendering. It set state on a view that immediately unmounted:
	 * the basket was correctly replaced and the reader was told nothing, which is the one
	 * outcome worse than refusing the add. (Same family as the signup ceremony's
	 * auth-context bug: a view that changes shape in response to the very action whose
	 * result it needs to report.) Verified in a browser, because nothing about it fails.
	 */
	const notice = replaced && (
		<p className="text-xs text-warning">
			Your basket held work by {replaced}, so it was replaced — a basket covers one creator at a
			time, because each is paid directly.
		</p>
	);

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
				{notice}
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<button
				type="button"
				className="btn btn-outline btn-sm"
				onClick={() => {
					const r = add({
						workId: props.workId,
						slug: props.slug,
						title: props.title,
						price: props.price,
						creatorUsername: props.creatorUsername,
						thumbnail: props.thumbnail ?? null,
					});
					setReplaced(r.replacedCreator ?? null);
				}}
			>
				<ShoppingBagIcon className="w-4 h-4" /> Add to basket
			</button>
			{notice}
			<p className="text-xs text-base-content/50">
				Buying several things from {props.creatorUsername} together sends them more: the card fee is
				charged once per purchase, not once per item.
			</p>
		</div>
	);
}
