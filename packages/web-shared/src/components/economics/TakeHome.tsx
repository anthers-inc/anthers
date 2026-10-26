// SPDX-License-Identifier: Apache-2.0
import {
	BUYER_TAX_RATE_MAX,
	BUYER_TAX_RATE_MIN,
	CARD_FLAT,
	CARD_RATE,
	cardFeeDisplay,
	STRIPE_MIN_CHARGE,
	STRIPE_TAX_FEE_RATE,
} from "@anthers/shared/constants";
import { RIVAL_STOREFRONTS } from "@anthers/shared/figures";

/**
 * What a creator actually receives, shown beside the field where they set the number.
 *
 * 🚨 **A percentage is the wrong headline and would cost us creators.** A $1.00 track nets
 * $0.67 — read as "33%" against a 15% they think they understand, a creator leaves. Read as
 * **$0.67 beside itch's $0.57 and Bandcamp's $0.52**, the same number says they earn more
 * here. So the take-home is the headline, the deduction is shown as a table rather than
 * buried in a sentence, and the comparison is to named alternatives.
 *
 * ⭐ **The figure is a range, because the buyer's tax rate is not one number** (Parker,
 * 2026-10-26). A no-tax jurisdiction pays the list price; the highest combined U.S.
 * jurisdiction pays well above it, and Stripe's 0.5% tax-collection fee is a share of that
 * larger charge. The range's ends come from `BUYER_TAX_RATE_MIN`/`MAX` and
 * `STRIPE_TAX_FEE_RATE`, so a creator sees both what the buyer may pay and what they may
 * receive instead of a single average that hides both ends.
 *
 * **Inform, never restrict** (Parker, 2026-08-13). No minimum of ours, no confirmation
 * step, no nagging. A floor would ban prices we are genuinely competitive at and sit
 * against Article I(c) — so this component's job is to make the consequence visible, never
 * to refuse it.
 *
 * ⚠️ **One amount is now refused, and it is not an exception to that rule so much as a case
 * the rule never covered.** Since 2026-08-29 an amount between zero and `STRIPE_MIN_CHARGE`
 * is rejected by the validators, because it is not a low price we disapprove of — it is a
 * price the payment rail will not accept, so a creator who sets one has published something
 * nobody can buy and finds out through a stranger failing at checkout. Everything above that
 * floor stays entirely theirs, underwater prices included, and this component still explains
 * rather than nags. **Do not let this grow into a minimum of ours.**
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
 * pull decimal.js in. Rival rates come from `figures.ts`, so a page cannot
 * quietly disagree with 62.04.
 */

/** Below this, the fixed fee dominates hard enough that it needs explaining rather than showing. */
const EXPLAIN_BELOW = 1;

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A signed display figure — the typographic minus the headline and table both use. */
const signedUsd = (n: number) => (n < 0 ? `−${usd(-n)}` : usd(n));

/** A signed percentage, same convention: the sign lives outside the absolute value. */
const signedPct = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(0)}%`;

/**
 * The lowest price at which a sale returns the creator anything at all.
 *
 * 🚨 **Derived, not typed** — this is a published figure and it moves with `CARD_RATE`
 * and `CARD_FLAT`. Searched rather than solved (`CARD_FLAT / (1 - CARD_RATE)` gives $0.31,
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
	 * lone purchase, and anything else they give amortizes it away.
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
	const taxRateMinPct = Math.round(BUYER_TAX_RATE_MIN * 100);
	const taxRateMaxPct = Math.round(BUYER_TAX_RATE_MAX * 100);
	const taxMax = amount * BUYER_TAX_RATE_MAX;
	// Stripe Tax's fee is a share of the whole charge, tax included. The low end of the
	// take-home range is therefore the sale where the buyer is in the highest-rate
	// jurisdiction and the tax was calculated; the high end is a sale with no tax at all.
	const taxFeeMax = (amount + taxMax) * STRIPE_TAX_FEE_RATE;
	const netBest = roundCents(amount - fee);
	const netWorst = roundCents(amount - fee - taxFeeMax);
	const underwater = netBest < 0;
	const keptPctBest = (netBest / amount) * 100;
	const keptPctWorst = (netWorst / amount) * 100;
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
	// a small sale is less than the flat fee they absorb. The wiki's *How Anthers Talks About Itself* § Comparisons requires we
	// concede that, and generating it means we cannot quietly stop.
	const best = Math.max(netBest, ...rivals.map((r) => r.net ?? 0));

	return (
		<div className="rounded-box bg-base-200/60 px-3 py-2 text-sm" data-testid="take-home">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-base-content/70">You receive</span>
				<span
					className={`font-semibold tabular-nums ${underwater ? "text-error" : ""}`}
					data-testid="take-home-net"
				>
					{signedUsd(netWorst)}
					{netWorst !== netBest && `–${signedUsd(netBest)}`}
					<span className="ml-1 text-xs font-normal text-base-content/50">
						{/* `toFixed` yields an ASCII hyphen, which sat a character away from the
						    typographic minus on the headline and read as a rendering bug. */}
						of {usd(amount)} ({signedPct(keptPctWorst)}
						{keptPctWorst !== keptPctBest && `–${signedPct(keptPctBest)}`})
					</span>
				</span>
			</div>

			{/* The breakdown is a table rather than a paragraph: a creator comparing what they
			    keep needs the rows to line up, and the prose version buried the tax range in a
			    sentence. Every figure is derived from the dials in `@anthers/shared/constants`. */}
			<table className="mt-2 w-full border-collapse text-xs" data-testid="take-home-breakdown">
				<tbody>
					<tr className="border-t border-base-content/10">
						<td className="py-1 pr-2 text-base-content/60">Buyer pays</td>
						<td className="py-1 text-right tabular-nums">
							{usd(amount)}
							{`–${usd(amount + taxMax)}`}
						</td>
						<td className="py-1 pl-2 text-base-content/50">
							Price plus sales tax ({taxRateMinPct}–{taxRateMaxPct}%)
						</td>
					</tr>
					<tr className="border-t border-base-content/10">
						<td className="py-1 pr-2 text-base-content/60">Card processing</td>
						<td className="py-1 text-right tabular-nums">{`−${usd(fee)}`}</td>
						<td className="py-1 pl-2 text-base-content/50">Stripe · 2.9% + $0.30</td>
					</tr>
					<tr className="border-t border-base-content/10">
						<td className="py-1 pr-2 text-base-content/60">Tax collection</td>
						<td className="py-1 text-right tabular-nums">{`${usd(0)}–${usd(taxFeeMax)}`}</td>
						<td className="py-1 pl-2 text-base-content/50">Stripe · 0.5% when tax applies</td>
					</tr>
					<tr className="border-t border-base-content/10">
						<td className="py-1 pr-2 text-base-content/60">Anthers</td>
						<td className="py-1 text-right tabular-nums">{usd(0)}</td>
						<td className="py-1 pl-2 text-base-content/50">No platform cut</td>
					</tr>
					<tr className="border-t border-base-content/10 font-medium">
						<td className="py-1 pr-2">You receive</td>
						<td className="py-1 text-right tabular-nums">
							{signedUsd(netWorst)}
							{netWorst !== netBest && `–${signedUsd(netBest)}`}
						</td>
						<td className="py-1 pl-2 text-base-content/50">After the deductions above</td>
					</tr>
				</tbody>
			</table>

			{underwater && (
				<p className="mt-1 text-xs text-error" data-testid="take-home-underwater">
					{/* The one state that is not merely unflattering but loss-making. Stated as a
					    consequence, still with no remedy imposed — a creator may have a reason,
					    and the settled rule is inform, never restrict. */}
					At this price the {usd(fee)} card fee is <strong>more than the price</strong>, so a sale
					costs you {usd(-netBest)}. Anything under {usd(breakEvenPrice())} is underwater.
				</p>
			)}

			{amount > 0 && amount < STRIPE_MIN_CHARGE && (
				<p className="mt-1 text-xs text-error" data-testid="take-home-min-charge">
					{/* 🚨 The one amount that is refused rather than explained, and the copy has to
					    say so — this notice was informational until 2026-08-29, and a page telling
					    a creator their price merely "cannot be sold on its own" while the save
					    button refuses it would be describing a different product. The reason is
					    still the rail's rather than ours, which is why the sentence leads with it.
					    Baskets exist and one could clear the floor collectively, but a creator
					    cannot make anybody buy two things, so a lone purchase is the case that
					    decides it. */}
					Card networks will not take a charge under {usd(STRIPE_MIN_CHARGE)}, so this amount can't
					be saved. Make it {usd(STRIPE_MIN_CHARGE)} or more, or free.
				</p>
			)}

			{!underwater && amount < EXPLAIN_BELOW && (
				<p className="mt-1 text-xs text-warning" data-testid="take-home-low">
					{/* Explanation, not a warning to act on: the brief settled "inform, never
					    restrict", so this states a fact and offers no remedy and no confirm step. */}
					<strong>{flatShare.toFixed(0)}%</strong> of the deduction is Stripe's fixed $
					{CARD_FLAT.toFixed(2)}, which does not shrink with the price.
				</p>
			)}

			<div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
				<span className="text-base-content/50">Elsewhere at this price</span>
				<span className="flex gap-1">
					<span className="text-base-content/50">Anthers</span>
					<span className={netBest >= best ? "font-semibold" : ""}>{usd(netBest)}</span>
				</span>
				{rivals.map((r) => (
					<span className="flex gap-1" key={r.name}>
						<span className="text-base-content/50">{r.name}</span>
						<span className={r.net !== null && r.net >= best ? "font-semibold" : ""}>
							{r.net === null ? "—" : r.net < 0 ? `−${usd(-r.net)}` : usd(r.net)}
						</span>
					</span>
				))}
			</div>

			{kind === "badge" && (
				<p className="mt-2 text-xs text-base-content/50">
					{/* The Badge worst case, stated rather than buried. A supporter giving you and
					    nothing else pays the whole flat fee on this one line; one who also supports
					    Anthers or another creator amortizes it, and you receive more. */}
					Shown for a supporter with nothing else on their month. Anything else they give shares the{" "}
					{usd(fee)} card fee.
				</p>
			)}
		</div>
	);
}

/** Round a display figure to cents without letting float noise move the last digit. */
function roundCents(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}
