// SPDX-License-Identifier: AGPL-3.0-or-later
import { CARD_RATE, cardFeeDisplay, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { RIVAL_STOREFRONTS } from "@anthers/shared/figures";

/**
 * What a creator actually receives, shown beside the field where they set the number.
 *
 * 🚨 **A percentage is the wrong headline and would cost us creators.** A $1.00 track nets
 * $0.67 — read as "33%" against a 15% they think they understand, a creator leaves. Read as
 * **$0.67 beside itch's $0.57 and Bandcamp's $0.52**, the same number says they earn more
 * here. So the take-home is the headline, the deduction is explained rather than
 * summarised, and the comparison is to named alternatives.
 *
 * **Inform, never restrict** (Parker, 2026-08-13). No minimum of ours, no confirmation
 * step, no nagging. A floor would ban prices we are genuinely competitive at and sit
 * against Article I(c) — so this component's job is to make the consequence visible, never
 * to refuse it.
 *
 * 🚨 **The brief's "a creator can price at $0.25 and keep about 6%" is FALSE, found while
 * building this.** At $0.25 the fee is $0.31, so the creator receives **−$0.06** — a sale
 * loses them money. Break-even is **$0.32**, and Stripe will not take a charge under $0.50
 * at all, so anything below that cannot be sold on its own. Informing honestly therefore
 * has to include those two states; a component that showed "$0.00" would be restricting by
 * omission, which is the failure mode the rule was written against.
 *
 * ⚠️ **Everything here is DERIVED, never typed.** `cardFeeDisplay` is the browser-side card
 * formula — floats and dependency-free, pinned equal to `fees.ts`'s `cardFee()` across
 * ~2,900 amounts by `economics.test.ts` — because the SPA must never import `fees.ts` and
 * pull decimal.js in. Rival rates come from `figures.generated.ts`, so a page cannot
 * quietly disagree with 62.04.
 */

/** Below this, the fixed fee dominates hard enough that it needs explaining rather than showing. */
const EXPLAIN_BELOW = 1;

/**
 * Stripe's minimum USD charge. A price under this **cannot be taken on its own** — the
 * PaymentIntent is refused before anything of ours runs.
 *
 * Not a floor of ours, and it must not be written as one: it is a fact about the rail, and
 * a basket of several such items would clear it together once carts exist.
 */
const STRIPE_MIN_CHARGE = 0.5;

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The lowest price at which a sale returns the creator anything at all.
 *
 * 🚨 **Derived, not typed** — `econ:figures --check` refused a hardcoded `$0.32`, and it
 * was right to twice over: it is a published figure, and it moves with `CARD_RATE` and
 * `CARD_FLAT`. Searched rather than solved (`CARD_FLAT / (1 - CARD_RATE)` gives $0.31,
 * which nets exactly zero once the fee is rounded to the cent — and "you receive nothing"
 * is not break-even).
 */
function breakEvenPrice(): number {
	for (let cents = 1; cents <= 1000; cents++) {
		const price = cents / 100;
		if (price - cardFeeDisplay(price) > 0) return price;
	}
	return 0;
}

export interface TakeHomeProps {
	/** The buyer-facing list price, or the monthly amount for a Badge. */
	amount: number;
	/**
	 * What is being priced.
	 *
	 * 🚨 The two have **different worst cases**, and getting it backwards understates the
	 * deduction on the one a creator is most likely to set low. A purchase's worst case is
	 * a single-item basket. A Badge's worst case is a supporter for whom this is the only
	 * thing on the month's invoice — so the whole fixed fee lands on it, exactly as for a
	 * lone purchase, and anything else they give amortises it away.
	 */
	kind: "purchase" | "badge";
}

export function TakeHome({ amount, kind }: TakeHomeProps) {
	if (!(amount > 0)) return null;

	const fee = cardFeeDisplay(amount);
	// 🚨 NOT clamped at zero, and the first cut of this was. Below ~$0.32 the fixed fee
	// exceeds the whole price, so the creator receives **less than nothing** — clamping
	// renders that as "$0.00", which reads as "free" rather than "this costs you money".
	// A display that hides the one case a creator most needs to see is worse than no
	// display, and this component's entire justification is informing rather than
	// restricting.
	const net = amount - fee;
	const underwater = net < 0;
	const keptPct = (net / amount) * 100;
	// The share of the deduction that is the FIXED part. At $1.00 it is 91%, which is the
	// whole point: the cost is one third-party flat fee, not a rate we are taking.
	const flatShare = fee > 0 ? ((fee - amount * CARD_RATE) / fee) * 100 : 0;

	const rivals = RIVAL_STOREFRONTS.map((r) => {
		const maxPrice = "maxPrice" in r ? (r.maxPrice as number | undefined) : undefined;
		if (maxPrice !== undefined && amount > maxPrice) return { name: r.name, net: null };
		const afterShare = amount * (1 - r.share);
		const absorbs = "absorbsProcessing" in r && r.absorbsProcessing;
		return { name: r.name, net: absorbs ? afterShare : afterShare - fee };
	});
	// Computed, not marked by hand: Steam beats us below about $1.15, because their 30% of
	// a small sale is less than the flat fee they absorb. 63.01 § Comparisons requires we
	// concede that, and generating it means we cannot quietly stop.
	const best = Math.max(net, ...rivals.map((r) => r.net ?? 0));

	return (
		<div className="rounded-box bg-base-200/60 px-3 py-2 text-sm" data-testid="take-home">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-base-content/70">You receive</span>
				<span
					className={`font-semibold tabular-nums ${underwater ? "text-error" : ""}`}
					data-testid="take-home-net"
				>
					{net < 0 ? `−${usd(-net)}` : usd(net)}
					<span className="ml-1 text-xs font-normal text-base-content/50">
						of {usd(amount)} ({keptPct.toFixed(0)}%)
					</span>
				</span>
			</div>

			<p className="mt-1 text-xs text-base-content/60">
				{/* Never "our fee" and never a percentage on its own — Anthers keeps $0 here, and
				    saying so plainly is the claim that survives (63.01 § Claims). */}
				Anthers takes <strong>nothing</strong>. The {usd(fee)} is card processing, paid to Stripe.
			</p>

			{underwater && (
				<p className="mt-1 text-xs text-error" data-testid="take-home-underwater">
					{/* The one state that is not merely unflattering but loss-making. Stated as a
					    consequence, still with no remedy imposed — a creator may have a reason,
					    and the settled rule is inform, never restrict. */}
					At this price the {usd(fee)} card fee is <strong>more than the price</strong>, so a sale
					costs you {usd(-net)}. Card processing is a fixed cost per transaction, so anything under{" "}
					{usd(breakEvenPrice())} is underwater.
				</p>
			)}

			{amount > 0 && amount < STRIPE_MIN_CHARGE && (
				<p className="mt-1 text-xs text-base-content/60" data-testid="take-home-min-charge">
					{/* A fact about the payment rail, deliberately not phrased as our rule. */}
					Card networks will not take a charge under {usd(STRIPE_MIN_CHARGE)}, so this cannot be
					sold on its own.
				</p>
			)}

			{!underwater && amount < EXPLAIN_BELOW && (
				<p className="mt-1 text-xs text-warning" data-testid="take-home-low">
					{/* Explanation, not a warning to act on: the brief settled "inform, never
					    restrict", so this states a fact and offers no remedy and no confirm step. */}
					At this price <strong>{flatShare.toFixed(0)}%</strong> of that is Stripe's fixed $0.30,
					which does not shrink with the price — so small amounts keep a smaller share. That is one
					third-party fee, not a cut of ours.
				</p>
			)}

			<dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
				<div className="flex gap-1">
					<dt className="text-base-content/50">Anthers</dt>
					<dd className={net >= best ? "font-semibold" : ""}>
						{net < 0 ? `−${usd(-net)}` : usd(net)}
					</dd>
				</div>
				{rivals.map((r) => (
					<div className="flex gap-1" key={r.name}>
						<dt className="text-base-content/50">{r.name}</dt>
						<dd className={r.net !== null && r.net >= best ? "font-semibold" : ""}>
							{r.net === null ? "—" : r.net < 0 ? `−${usd(-r.net)}` : usd(r.net)}
						</dd>
					</div>
				))}
			</dl>

			{kind === "badge" && (
				<p className="mt-2 text-xs text-base-content/50">
					{/* The Badge worst case, stated rather than buried. A supporter giving you and
					    nothing else pays the whole flat fee on this one line; one who also supports
					    Anthers or another creator amortises it, and you receive more. */}
					Shown for a supporter with nothing else on their month. Anyone who also supports Anthers
					or another creator splits the {usd(fee)} across it, and you receive more.
				</p>
			)}
		</div>
	);
}

/** The Public Access price, re-exported so a caller sizing a default need not import twice. */
export { PUBLIC_ACCESS_PRICE };
