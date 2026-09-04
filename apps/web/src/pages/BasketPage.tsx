// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The basket: what you're about to buy, what it costs, and what buying it together saves.
 *
 * 🚨 **The saving is the whole reason this page exists**, so it is stated in money and
 * before the decision rather than after it. Stripe's fixed **$0.30 is per charge, not per
 * item** — five $1 tracks pay $1.65 in card fees bought one at a time and $0.45 bought
 * together — and because Anthers keeps nothing either way, every cent of that difference
 * is the creator's. A basket that merely batched clicks would not be worth building.
 *
 * Every figure here comes from `/basket/quote`, which computes it with the same
 * `calculateFees` that checkout charges from. Nothing on this page does money arithmetic:
 * a receipt that derives its own totals stops reconciling the moment a dial moves, which
 * is the failure this codebase has already had twice.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { creatorWorkUrl, profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ShoppingBagIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { useBasket } from "@/lib/basket";
import BasketCheckout from "../components/basket/BasketCheckout";

interface Quote {
	items: { workId: number; slug: string; title: string | null; price: string }[];
	subtotal: string;
	processingFee: string;
	salesTax: string;
	creatorEarnings: string;
	buyerTotal: string;
	feeSeparately: string;
	creatorGains: string;
}

export default function BasketPage() {
	const { user } = useAuth();
	const { items, remove, clear, count } = useBasket();
	const [quote, setQuote] = useState<Quote | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const creator = items[0]?.creatorUsername ?? null;

	const refresh = useCallback(async () => {
		if (count === 0) {
			setQuote(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const res = await client.api.payments.basket.quote.$post({
				json: { workIds: items.map((i) => i.workId) },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "Couldn't price your basket.");
				setQuote(null);
				return;
			}
			setQuote((await res.json()) as unknown as Quote);
		} catch {
			setError("Couldn't price your basket.");
		} finally {
			setLoading(false);
		}
		// `items` is re-read from storage on every change, so its identity is the signal.
	}, [items, count]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (count === 0) {
		return (
			<div className="container mx-auto max-w-2xl px-4 py-12">
				<EmptyState
					icon={<ShoppingBagIcon className="w-12 h-12" />}
					title="Your basket is empty"
					description="Add a few things from one creator and buy them together — the card fee is charged once per purchase, not once per item, so buying together leaves more with them."
				/>
			</div>
		);
	}

	return (
		<div className="container mx-auto max-w-2xl px-4 py-8">
			<h1 className="text-2xl font-bold mb-1">Your basket</h1>
			{creator && (
				<p className="text-sm text-base-content/60 mb-6">
					Work by{" "}
					<Link to={profileUrl(creator)} className="link link-hover font-medium">
						{creator}
					</Link>
					. A basket holds one creator at a time, because each is paid directly.
				</p>
			)}

			{error && (
				<div className="alert alert-error text-sm mb-4">
					<span>{error}</span>
				</div>
			)}

			<ul className="mb-6 divide-y divide-base-300 rounded-lg border border-base-300">
				{items.map((item) => (
					<li key={item.workId} className="flex items-center gap-3 p-3">
						<div className="min-w-0 flex-1">
							<Link to={creatorWorkUrl(item.creatorUsername, item.slug)} className="link-hover">
								<span className="block truncate text-sm font-medium">{item.title}</span>
							</Link>
						</div>
						<span className="shrink-0 text-sm tabular-nums">${item.price}</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs shrink-0"
							onClick={() => remove(item.workId)}
							aria-label={`Remove ${item.title}`}
						>
							<XMarkIcon className="w-4 h-4" />
						</button>
					</li>
				))}
			</ul>

			{loading && !quote ? (
				<div className="flex justify-center py-6">
					<LoadingSpinner size="sm" />
				</div>
			) : quote ? (
				<>
					<div className="rounded-lg border border-base-300 p-4 text-sm">
						<div className="flex justify-between py-1">
							<span>Subtotal</span>
							<span className="tabular-nums">${quote.subtotal}</span>
						</div>
						<div className="flex justify-between py-1 text-base-content/60">
							<span>
								Card processing <span className="text-xs">at cost</span>
							</span>
							<span className="tabular-nums">−${quote.processingFee}</span>
						</div>
						<div className="flex justify-between py-1 text-base-content/60">
							<span>
								Sales tax <span className="text-xs">est.</span>
							</span>
							<span className="tabular-nums">+${quote.salesTax}</span>
						</div>
						<div className="mt-2 flex justify-between border-t border-base-300 pt-2 font-semibold">
							<span>You pay</span>
							<span className="tabular-nums">${quote.buyerTotal}</span>
						</div>
						<div className="mt-1 flex justify-between text-success">
							<span>{creator} receives</span>
							<span className="tabular-nums">${quote.creatorEarnings}</span>
						</div>
					</div>

					{/*
					 * Only shown when it is actually non-zero — a "you saved $0.00" on a
					 * single-item basket would teach the reader to ignore the line that
					 * matters. Anthers keeps nothing either way, so the saving is not ours
					 * to share: it is entirely the creator's, and the copy says so.
					 */}
					{Number(quote.creatorGains) > 0 && (
						<p className="mt-3 rounded-lg bg-success/10 p-3 text-sm text-success-content">
							Buying these together sends <strong>${quote.creatorGains} more</strong> to {creator}{" "}
							than buying them one at a time would. The card fee is charged once per purchase rather
							than once per item, and Anthers keeps none of it either way.
						</p>
					)}

					<div className="mt-6">
						{user ? (
							<BasketCheckout
								workIds={items.map((i) => i.workId)}
								buyerTotal={quote.buyerTotal}
								onComplete={() => {
									clear();
									void refresh();
								}}
							/>
						) : (
							<Link to="/login" className="btn btn-primary w-full">
								Log in to buy
							</Link>
						)}
					</div>
				</>
			) : null}
		</div>
	);
}
