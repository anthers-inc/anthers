// SPDX-License-Identifier: Apache-2.0
/**
 * Studio Orders — the creator's packing list for physical goods.
 *
 * 🚨 **This is the only surface where a creator learns an order exists.** A sale opens a
 * shipment silently at completion; without this page the goods lane sells into nothing, and
 * the ship-by deadline nobody sees is the same as no deadline at all. What each card answers
 * is the three questions a packer has: what to send, where to send it, and by when.
 *
 * The state and the clock are the shipment's own (`shipmentState` and `isOverdue` in the API)
 * — this page renders what the server read off the dates rather than working anything out
 * from them, so an order cannot read "in transit" here and something else at the buyer.
 *
 * Marking shipped is the one write, and it is deliberately plain: a carrier from the short
 * list (normalized server-side, so a creator's "USPS Ground" still links to USPS) and the
 * tracking number, which is the buyer's only way to follow the parcel.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioUrl } from "../lib/studio";

interface OrderAddress {
	line1: string | null;
	line2: string | null;
	city: string | null;
	state: string | null;
	postalCode: string | null;
	country: string | null;
}

interface SellerOrder {
	id: number;
	title: string | null;
	quantity: number;
	options: Array<{ name: string; label: string }> | null;
	amount: string;
	shippingAmount: string;
	creatorEarnings: string;
	purchasedAt: string;
	status: string;
	buyer: { handle: string | null };
	address: OrderAddress;
	shipment: {
		state: string;
		overdue: boolean;
		carrier: string | null;
		carrierName: string | null;
		trackingNumber: string | null;
		trackingUrl: string | null;
		handlingBusinessDays: number;
		shipByAt: string;
		shippedAt: string | null;
		deliveredAt: string | null;
		complaintWindowEndsAt: string | null;
	};
	complaint: { reason: string; details: string; createdAt: string } | null;
}

const CARRIERS = [
	{ value: "usps", label: "USPS" },
	{ value: "ups", label: "UPS" },
	{ value: "fedex", label: "FedEx" },
	{ value: "dhl", label: "DHL" },
	{ value: "other", label: "Another carrier" },
];

/** The state, in the words a creator acts on rather than the enum's. */
function stateLabel(order: SellerOrder): string {
	if (order.complaint) return "A buyer reported a problem";
	switch (order.shipment.state) {
		case "awaiting_shipment":
			return order.shipment.overdue ? "Overdue to ship" : "To ship";
		case "in_transit":
			return "On its way";
		case "delivered":
			return "Delivered";
		default:
			return "Closed";
	}
}

function stateClass(order: SellerOrder): string {
	if (order.complaint) return "badge-error";
	if (order.shipment.state === "awaiting_shipment")
		return order.shipment.overdue ? "badge-warning" : "badge-info";
	if (order.shipment.state === "in_transit") return "badge-info";
	return "badge-success";
}

function dateSentence(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function addressLines(address: OrderAddress): string[] {
	return [
		address.line1,
		address.line2,
		[address.city, address.state].filter(Boolean).join(", "),
		address.postalCode,
	].filter((line): line is string => Boolean(line));
}

function ShipForm({ order, onShipped }: { order: SellerOrder; onShipped: () => void }) {
	const [carrier, setCarrier] = useState("usps");
	const [tracking, setTracking] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.orders[":id"].shipped.$post({
				param: { id: String(order.id) },
				json: { carrier, trackingNumber: tracking.trim() },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That didn't save.");
				return;
			}
			onShipped();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-end gap-2">
				<label className="form-control">
					<span className="label-text text-xs text-base-content/60">Carrier</span>
					<select
						aria-label="Carrier"
						className="select select-sm select-bordered"
						value={carrier}
						onChange={(e) => setCarrier(e.target.value)}
					>
						{CARRIERS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</label>
				<label className="form-control flex-1">
					<span className="label-text text-xs text-base-content/60">Tracking number</span>
					<input
						aria-label="Tracking number"
						className="input input-sm input-bordered w-full"
						value={tracking}
						onChange={(e) => setTracking(e.target.value)}
						placeholder="9400 1118 9995 5555 5555 55"
					/>
				</label>
				<button
					type="button"
					className="btn btn-sm btn-primary"
					disabled={busy || tracking.trim().length === 0}
					onClick={() => void submit()}
				>
					{busy ? "Saving…" : "Mark shipped"}
				</button>
			</div>
			{error && <p className="text-xs text-error">{error}</p>}
		</div>
	);
}

export default function OrdersPage() {
	const [orders, setOrders] = useState<SellerOrder[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await client.api.orders.selling.$get();
			if (!res.ok) {
				setError("Couldn't read your orders.");
				return;
			}
			const body = (await res.json()) as { orders: SellerOrder[] };
			setOrders(body.orders);
		} catch {
			setError("Couldn't read your orders.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
			<header>
				<h1 className="text-2xl font-bold">Orders</h1>
				<p className="text-sm text-base-content/60">
					Physical goods someone bought from you, newest first. Mark one shipped when it leaves; the
					buyer sees the carrier and the tracking number from then on.
				</p>
			</header>

			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{orders == null ? (
				<div className="flex justify-center py-10">
					<span className="loading loading-spinner loading-md" />
				</div>
			) : orders.length === 0 ? (
				<div className="card bg-base-200">
					<div className="card-body text-center text-base-content/60">
						<p>No orders yet.</p>
						<p className="text-sm">
							A good you list shows up here the moment somebody buys it.{" "}
							<Link to={studioUrl("/works")} className="link">
								Manage your Works
							</Link>
						</p>
					</div>
				</div>
			) : (
				<ul className="flex flex-col gap-4">
					{orders.map((order) => {
						const shipped = Boolean(order.shipment.shippedAt);
						return (
							<li key={order.id} className="card bg-base-200 border border-base-300">
								<div className="card-body gap-3">
									<div className="flex flex-wrap items-start justify-between gap-2">
										<div>
											<h2 className="text-lg font-semibold">{order.title ?? "A good"}</h2>
											<p className="text-sm text-base-content/60">
												{order.quantity} ×{" "}
												{order.options?.map((o) => `${o.name}: ${o.label}`).join(" · ") ||
													"as listed"}
											</p>
										</div>
										<span className={`badge ${stateClass(order)}`}>{stateLabel(order)}</span>
									</div>

									<div className="grid gap-3 sm:grid-cols-2 text-sm">
										<div>
											<p className="text-xs uppercase tracking-wide text-base-content/50">
												Ship to
											</p>
											{addressLines(order.address).length > 0 ? (
												<address className="not-italic leading-snug">
													{addressLines(order.address).map((line) => (
														<span key={line} className="block">
															{line}
														</span>
													))}
												</address>
											) : (
												<p className="text-base-content/50">No address on this order.</p>
											)}
										</div>
										<div className="flex flex-col gap-1">
											<p className="text-xs uppercase tracking-wide text-base-content/50">Timing</p>
											<p>
												{shipped
													? `Sent ${dateSentence(order.shipment.shippedAt)}`
													: order.shipment.overdue
														? `Should have gone by ${dateSentence(order.shipment.shipByAt)}`
														: `Send by ${dateSentence(order.shipment.shipByAt)}`}
											</p>
											{order.shipment.deliveredAt && (
												<p className="text-base-content/60">
													Delivered {dateSentence(order.shipment.deliveredAt)}
													{order.shipment.complaintWindowEndsAt &&
														` — buyer may report a problem until ${dateSentence(order.shipment.complaintWindowEndsAt)}`}
												</p>
											)}
											{order.shipment.trackingUrl && (
												<a
													href={order.shipment.trackingUrl}
													target="_blank"
													rel="noreferrer"
													className="link text-sm"
												>
													{order.shipment.carrierName || order.shipment.carrier?.toUpperCase()} ·{" "}
													{order.shipment.trackingNumber}
												</a>
											)}
										</div>
									</div>

									{order.complaint && (
										<div className="alert alert-error text-sm">
											<span>
												The buyer reported: {order.complaint.details || order.complaint.reason}.
												Their share is held until this is settled.
											</span>
										</div>
									)}

									{!shipped ? (
										<ShipForm order={order} onShipped={() => void load()} />
									) : (
										<p className="text-xs text-base-content/50">
											You'll receive ${order.creatorEarnings} for this order, including the $
											{order.shippingAmount} shipping you charged.
										</p>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
