// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The buyer-facing receipt. Since 2026-08-03 the listed price IS the advertised
// price: card processing and the first download come OUT of it, Anthers keeps $0,
// and sales tax is the only thing added — the sole carve-out mandatory-fee
// disclosure law allows. So this renders a disclosure of where the price went,
// never a stack of extras being piled on.
interface ReceiptLine {
	label: string;
	amount: number;
	note?: string;
	/** True when this line is ADDED to the price (sales tax) rather than taken from it. */
	added?: boolean;
}

interface TransparentReceiptProps {
	/** The listed, all-in price — what the buyer was shown. */
	price: number;
	/** Price + sales tax — what the buyer is charged. */
	buyerTotal: number;
	/** Where the price went, plus any tax added on top. */
	lines: ReceiptLine[];
	/** What the creator receives: price less the deductions. Falls back to price. */
	creatorReceives?: number;
}

function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

export default function TransparentReceipt({
	price,
	buyerTotal,
	lines,
	creatorReceives,
}: TransparentReceiptProps) {
	const takenFrom = lines.filter((l) => !l.added);
	const added = lines.filter((l) => l.added);
	const toCreator = creatorReceives ?? price - takenFrom.reduce((sum, l) => sum + l.amount, 0);

	return (
		<div className="card bg-base-200 text-sm">
			<div className="card-body p-4 gap-0">
				<h3 className="font-semibold mb-2">Transparent Receipt</h3>
				<div className="flex justify-between mb-1">
					<span>Listed price</span>
					<span className="font-medium">{fmt(price)}</span>
				</div>
				{takenFrom.map((line, i) => (
					<div key={`t${i}`} className="flex justify-between text-base-content/60">
						<span>
							{line.label}
							{line.note && <span className="text-xs ml-1">({line.note})</span>}
						</span>
						<span>−{fmt(line.amount)}</span>
					</div>
				))}
				<div className="flex justify-between text-base-content/60">
					<span>
						Anthers<span className="text-xs ml-1">(no cut, ever)</span>
					</span>
					<span>−{fmt(0)}</span>
				</div>
				{added.length > 0 && <div className="divider my-1" />}
				{added.map((line, i) => (
					<div key={`a${i}`} className="flex justify-between text-base-content/60">
						<span>
							{line.label}
							{line.note && <span className="text-xs ml-1">({line.note})</span>}
						</span>
						<span>+{fmt(line.amount)}</span>
					</div>
				))}
				<div className="divider my-1" />
				<div className="flex justify-between font-semibold">
					<span>You pay</span>
					<span>{fmt(buyerTotal)}</span>
				</div>
				<div className="flex justify-between text-success text-xs mt-1">
					<span>Creator receives</span>
					<span>{fmt(toCreator)}</span>
				</div>
			</div>
		</div>
	);
}
