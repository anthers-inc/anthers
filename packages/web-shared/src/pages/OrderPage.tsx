// SPDX-License-Identifier: Apache-2.0
/**
 * One order, from the buyer's side — what they bought, where it is, and what they can do
 * about it.
 *
 * 🚨 **This page is the only place a buyer can act on a physical purchase.** A receipt is a
 * record; an order is a thing in motion, and the two acts that matter are both here: saying
 * it arrived (the strongest delivery signal the platform has without a carrier integration)
 * and reporting a problem, which is only offered while the window the shipment stamped is
 * still open. A closed window is stated rather than silently missing the button, because a
 * buyer who expected to be able to complain needs to know why they cannot.
 *
 * ⚠️ **Nothing here is computed.** The state, the deadline and the window all arrive from
 * the server's reading of the shipment's dates.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";

interface OrderDetail {
	id: number;
	title: string | null;
	quantity: number;
	options: Array<{ name: string; label: string }> | null;
	amount: string;
	shippingAmount: string;
	purchasedAt: string;
	creatorHandle: string | null;
	shipment: {
		state: string;
		carrier: string | null;
		trackingNumber: string | null;
		trackingUrl: string | null;
		shipByAt: string;
		shippedAt: string | null;
		deliveredAt: string | null;
		complaintWindowEndsAt: string | null;
	};
	complaint: { reason: string; details: string; status: string; createdAt: string } | null;
}

const REASONS = [
	{ value: "not_as_described", label: "It isn't what was described" },
	{ value: "damaged", label: "It arrived damaged" },
	{ value: "never_arrived", label: "It never arrived" },
	{ value: "other", label: "Something else" },
];

function dateSentence(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString(undefined, {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

function stateSentence(order: OrderDetail): string {
	switch (order.shipment.state) {
		case "awaiting_shipment":
			return `The creator is preparing it, due to send by ${dateSentence(order.shipment.shipByAt)}.`;
		case "in_transit":
			return "It's on its way.";
		case "delivered":
			return order.complaint ? "It arrived, and you've reported a problem." : "It arrived.";
		default:
			return "This order is closed.";
	}
}

export default function OrderPage({ orderId }: { orderId: number }) {
	const [order, setOrder] = useState<OrderDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [showProblem, setShowProblem] = useState(false);
	const [reason, setReason] = useState("damaged");
	const [details, setDetails] = useState("");
	const [problemError, setProblemError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await client.api.orders[":id"].$get({ param: { id: String(orderId) } });
		if (!res.ok) {
			setError("We couldn't find that order.");
			return;
		}
		const body = (await res.json()) as { order: OrderDetail };
		setOrder(body.order);
	}, [orderId]);

	useEffect(() => {
		void load();
	}, [load]);

	const confirmReceipt = async () => {
		setBusy(true);
		try {
			const res = await client.api.orders[":id"].received.$post({
				param: { id: String(orderId) },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That didn't save.");
				return;
			}
			const body = (await res.json()) as { order: OrderDetail };
			setOrder(body.order);
		} finally {
			setBusy(false);
		}
	};

	const reportProblem = async () => {
		setBusy(true);
		setProblemError(null);
		try {
			const res = await client.api.orders[":id"].problem.$post({
				param: { id: String(orderId) },
				json: { reason, details: details.trim() },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setProblemError(body?.error ?? "That didn't save.");
				return;
			}
			setShowProblem(false);
			await load();
		} finally {
			setBusy(false);
		}
	};

	if (error) {
		return (
			<div className="mx-auto max-w-2xl px-4 py-12">
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			</div>
		);
	}

	if (!order) {
		return (
			<div className="flex justify-center py-16">
				<span className="loading loading-spinner loading-md" />
			</div>
		);
	}

	const windowOpen =
		order.shipment.complaintWindowEndsAt != null &&
		new Date(order.shipment.complaintWindowEndsAt).getTime() > Date.now();
	const canConfirm = Boolean(order.shipment.shippedAt) && !order.shipment.deliveredAt;

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
			<header className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h1 className="text-2xl font-bold">{order.title ?? "An order"}</h1>
					<p className="text-sm text-base-content/60">
						{order.quantity} ×{" "}
						{order.options?.map((o) => `${o.name}: ${o.label}`).join(" · ") || "as listed"}
						{order.creatorHandle && (
							<>
								{" "}
								from{" "}
								<Link to={`/@${order.creatorHandle}`} className="link">
									@{order.creatorHandle}
								</Link>
							</>
						)}
					</p>
				</div>
				<span className="badge badge-ghost">Bought {dateSentence(order.purchasedAt)}</span>
			</header>

			<section className="card bg-base-200 border border-base-300">
				<div className="card-body gap-3">
					<p className="text-sm">{stateSentence(order)}</p>
					{order.shipment.trackingUrl && (
						<p className="text-sm">
							<a
								href={order.shipment.trackingUrl}
								target="_blank"
								rel="noreferrer"
								className="link"
							>
								Track it with {order.shipment.carrier?.toUpperCase()}
							</a>{" "}
							<span className="text-base-content/50">{order.shipment.trackingNumber}</span>
						</p>
					)}
					{order.shipment.trackingNumber && !order.shipment.trackingUrl && (
						<p className="text-sm">
							Tracking number{" "}
							<span className="font-mono text-xs">{order.shipment.trackingNumber}</span>
						</p>
					)}
					<p className="text-xs text-base-content/50">
						You paid ${order.amount}
						{Number(order.shippingAmount) > 0 && ` including $${order.shippingAmount} shipping`},
						plus tax.
					</p>
				</div>
			</section>

			{canConfirm && (
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						className="btn btn-sm btn-primary"
						disabled={busy}
						onClick={() => void confirmReceipt()}
					>
						It arrived
					</button>
					<span className="text-xs text-base-content/50">
						Saying so starts the window for reporting a problem.
					</span>
				</div>
			)}

			{order.complaint ? (
				<div className="alert alert-warning text-sm">
					<span>
						You reported: {order.complaint.details || order.complaint.reason}. The creator's share
						stays held while this is open.
					</span>
				</div>
			) : windowOpen ? (
				<section className="flex flex-col gap-2">
					{!showProblem ? (
						<button
							type="button"
							className="btn btn-sm btn-outline self-start"
							onClick={() => setShowProblem(true)}
						>
							Report a problem
						</button>
					) : (
						<div className="flex flex-col gap-2 rounded-lg border border-base-300 p-3">
							<label className="form-control">
								<span className="label-text text-xs text-base-content/60">What went wrong</span>
								<select
									aria-label="What went wrong"
									className="select select-sm select-bordered"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
								>
									{REASONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
							<textarea
								aria-label="Tell the creator what happened"
								className="textarea textarea-bordered textarea-sm"
								rows={3}
								value={details}
								onChange={(e) => setDetails(e.target.value)}
								placeholder="Tell the creator what happened."
							/>
							{problemError && <p className="text-xs text-error">{problemError}</p>}
							<div className="flex gap-2">
								<button
									type="button"
									className="btn btn-sm btn-primary"
									disabled={busy}
									onClick={() => void reportProblem()}
								>
									Send
								</button>
								<button
									type="button"
									className="btn btn-sm btn-ghost"
									onClick={() => setShowProblem(false)}
								>
									Cancel
								</button>
							</div>
						</div>
					)}
					{order.shipment.complaintWindowEndsAt && (
						<p className="text-xs text-base-content/50">
							You can report a problem until {dateSentence(order.shipment.complaintWindowEndsAt)}.
						</p>
					)}
				</section>
			) : order.shipment.complaintWindowEndsAt ? (
				<p className="text-xs text-base-content/50">
					The window for reporting a problem closed on{" "}
					{dateSentence(order.shipment.complaintWindowEndsAt)}.
				</p>
			) : null}
		</div>
	);
}
