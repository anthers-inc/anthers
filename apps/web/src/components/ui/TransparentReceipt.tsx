interface ReceiptLine {
	label: string;
	amount: number;
	note?: string;
}

interface TransparentReceiptProps {
	price: number;
	lines: ReceiptLine[];
	creatorTotal: number;
}

function fmt(n: number): string {
	return `$${n.toFixed(2)}`;
}

export default function TransparentReceipt({
	price,
	lines,
	creatorTotal,
}: TransparentReceiptProps) {
	return (
		<div className="card bg-base-200 text-sm">
			<div className="card-body p-4 gap-0">
				<h3 className="font-semibold mb-2">Transparent Receipt</h3>
				<div className="flex justify-between mb-1">
					<span>Purchase price</span>
					<span className="font-medium">{fmt(price)}</span>
				</div>
				<div className="divider my-1" />
				{lines.map((line, i) => (
					<div key={i} className="flex justify-between text-base-content/60">
						<span>
							{line.label}
							{line.note && (
								<span className="text-xs ml-1">({line.note})</span>
							)}
						</span>
						<span>-{fmt(line.amount)}</span>
					</div>
				))}
				<div className="divider my-1" />
				<div className="flex justify-between font-semibold text-success">
					<span>Creator receives</span>
					<span>{fmt(creatorTotal)}</span>
				</div>
			</div>
		</div>
	);
}
