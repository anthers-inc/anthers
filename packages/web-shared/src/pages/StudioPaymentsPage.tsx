// SPDX-License-Identifier: Apache-2.0
/**
 * Studio Payments — the money surface: payout setup, the connected account's Stripe view,
 * the balance and the transfer record, in one tab.
 *
 * 🚨 **This page is the destination of `STRIPE_RETURN_PATHS.connectReturn` and
 * `connectRefresh`, so the `stripe` parameter it reads is a contract with the API rather
 * than a local detail.** Moving this page to a different path, or changing which value of
 * `stripe` it answers to, breaks the end of Connect onboarding in the one place no test of
 * ours makes a request: the return URL is navigated by the creator's browser, not by us.
 * `packages/shared/src/redirect-paths.ts` carries the values; the e2e walk
 * (`stripe-return-paths.authed.e2e.ts`) asserts this page answers them.
 *
 * ⚠️ **Everything Stripe-shaped here is a read, never a verdict.** `payoutStanding` in the
 * API stays the only authority on whether a creator can be paid; what this page renders is
 * Stripe's own account state so a creator can see what Stripe wants and why a hold is a
 * hold. Anthers adds no predicate beside it.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioUrl } from "../lib/studio";
import type { CreatorEarnings, StripeAccountStatus } from "../lib/types";

/**
 * The three setup states, derived from Stripe's own truth rather than from a query
 * parameter: `connected` renders the account view, `pending` the waiting banner, and
 * `none` the start-here card. A refused onboarding is Stripe's to explain, and the
 * requirements list is where it does.
 *
 * Exported for its test; the derivation is the page's one piece of judgment and the
 * pending/incomplete distinction is the defect that earned it.
 */
export type SetupState = "none" | "pending" | "connected" | "incomplete";

export function deriveSetupState(d: StripeAccountStatus | null): SetupState {
	if (!d?.hasAccount) return "none";
	if (d.chargesEnabled && d.onboardingComplete) return "connected";
	// Stripe has the submission and has not yet finished deciding — the state the settings
	// card used to render as an offer to start over, which the creator had already done.
	if (d.onboardingComplete === false && d.chargesEnabled === false && d.detailsSubmitted) {
		return "pending";
	}
	return "incomplete";
}

/** Stripe's requirement keys, as the sentences they are for a creator. */
const REQUIREMENT_COPY: Record<string, string> = {
	external_account: "A bank account to pay you into",
	"tos_acceptance.date": "Agreement to Stripe's terms",
	"tos_acceptance.ip": "Agreement to Stripe's terms",
	"representative.first_name": "The account representative's first name",
	"representative.last_name": "The account representative's last name",
	"individual.first_name": "Your first name",
	"individual.last_name": "Your last name",
	"individual.dob.day": "Your date of birth",
	"individual.dob.month": "Your date of birth",
	"individual.dob.year": "Your date of birth",
	"individual.address.line1": "Your address",
	"individual.address.city": "Your city",
	"individual.address.postal_code": "Your postal code",
	business_type: "Your business type",
	"business_profile.mcc": "What your business does (a category code)",
	"business_profile.url": "Your business's web address",
};

function requirementSentence(key: string): string {
	return REQUIREMENT_COPY[key] ?? `Stripe needs ${humanizeRequirement(key)}`;
}

function humanizeRequirement(key: string): string {
	return key
		.split(/[._]/)
		.filter((w) => w !== "individual" && w !== "representative")
		.join(" ");
}

/** The payout schedule, as the sentence a creator reads. Exported for its test. */
export function scheduleSentence(s: NonNullable<StripeAccountStatus["schedule"]>): string {
	if (!s) return "Not set";
	switch (s.interval) {
		case "manual":
			return "Manual — money moves only when you choose to move it";
		case "daily":
			return `Daily, paid out automatically${s.delayDays ? ` ${s.delayDays} day${s.delayDays === 1 ? "" : "s"} after it arrives` : ""}`;
		case "weekly":
			return "Weekly, paid out automatically";
		case "monthly":
			return "Monthly, paid out automatically";
		default:
			return s.interval;
	}
}

function money(amount: number, currency: string): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export default function PaymentsPage() {
	const [searchParams] = useSearchParams();
	const stripeResult = searchParams.get("stripe");

	const [status, setStatus] = useState<StripeAccountStatus | null>(null);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
	const [loading, setLoading] = useState(true);
	const [connecting, setConnecting] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		// The detail shape carries everything the tab renders; the base shape would leave
		// the requirements, schedule and balance blocks empty for an account that has them.
		client.api.payments.stripe.onboard
			.$get({ query: { detail: "1" } })
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as StripeAccountStatus) : null))
			.then((d) => {
				if (live) setStatus(d);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		client.api.subscriptions.earnings
			.$get()
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as CreatorEarnings) : null))
			.then((d) => {
				if (live && d) setEarnings(d as CreatorEarnings);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	const state = deriveSetupState(status);
	// The balance rows that render, narrowed once rather than in three JSX guards.
	const balanceRows = status?.balance ?? null;

	const handleConnect = async () => {
		setConnecting(true);
		setConnectError(null);
		try {
			const res = await client.api.payments.stripe.onboard.$post();
			if (!res.ok) {
				// 🚨 The server's sentence is the message; a Stripe refusal with a real cause
				// is exactly what this surface exists to surface, so it is never swallowed.
				const data = (await res.json()) as { error?: string };
				setConnectError(data.error ?? "Starting setup failed. Try again.");
				setConnecting(false);
				return;
			}
			const data = (await res.json()) as { url: string };
			window.location.href = data.url;
		} catch {
			setConnectError("Starting setup failed. Try again.");
			setConnecting(false);
		}
	};

	const openStripeDashboard = async () => {
		setDashboardUrl("pending");
		try {
			const res = await client.api.payments.stripe["dashboard-link"].$post();
			if (!res.ok) {
				setDashboardUrl(null);
				return;
			}
			const data = (await res.json()) as { url: string };
			setDashboardUrl(data.url);
		} catch {
			setDashboardUrl(null);
		}
	};

	if (loading) {
		return (
			<div className="max-w-2xl mx-auto px-4 py-8">
				<p className="text-sm text-base-content/60">Loading…</p>
			</div>
		);
	}

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Payments</h1>
			<p className="text-sm text-base-content/50 mb-6">
				Getting paid, your Stripe account, and where your money is.
			</p>

			<div className="flex flex-col gap-6">
				{stripeResult === "complete" && state !== "connected" && (
					<div className="alert alert-info text-sm">
						<span>
							Stripe onboarding submitted. It may take a moment for your account to be fully
							activated.
						</span>
					</div>
				)}

				{stripeResult === "refresh" && (
					<div className="alert alert-warning text-sm">
						<span>Stripe onboarding link expired. Click below to continue.</span>
					</div>
				)}

				{connectError && (
					<div className="alert alert-error text-sm">
						<span>{connectError}</span>
					</div>
				)}

				<div className="card bg-base-200">
					<div className="card-body gap-4">
						<h2 className="card-title text-lg">Payout setup</h2>

						{state === "connected" && (
							<>
								<div className="flex items-center gap-2">
									<div className="badge badge-success">Ready</div>
									<span className="text-sm text-base-content/60">
										Your Stripe account is set up and able to be paid.
									</span>
								</div>
								{status?.externalAccount && (
									<p className="text-sm text-base-content/60">
										Paid out to {status.externalAccount.bankName || "your bank"} ending{" "}
										{status.externalAccount.last4}.
									</p>
								)}
								{status?.schedule && (
									<p className="text-sm text-base-content/60">
										Payout schedule: {scheduleSentence(status.schedule)}.
									</p>
								)}
								<div className="card-actions justify-end">
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										onClick={openStripeDashboard}
										disabled={dashboardUrl === "pending"}
									>
										{dashboardUrl === "pending" ? "Opening Stripe…" : "Open Stripe Dashboard"}
									</button>
								</div>
							</>
						)}

						{state === "pending" && (
							<div className="flex items-center gap-2">
								<div className="badge badge-warning">Waiting on Stripe</div>
								<span className="text-sm text-base-content/60">
									Your onboarding is submitted and Stripe is finishing its review. This clears on
									its own; nothing more is needed from you right now.
								</span>
							</div>
						)}

						{(state === "incomplete" || state === "none") && (
							<>
								<p className="text-sm text-base-content/60">
									{state === "incomplete"
										? "Your Stripe account setup is not finished yet."
										: "Connect a Stripe account to receive payments for your work. Anthers uses Stripe Connect and takes no cut; only the processor's real costs come off anything you earn, and they go to the processor, never to us."}
								</p>
								{status?.requirements && (
									<ul className="list-disc list-inside text-sm text-base-content/60 ml-2">
										{[
											...status.requirements.pastDue,
											...status.requirements.currentlyDue,
											...status.requirements.pendingVerification,
										].map((key) => (
											<li key={key}>{requirementSentence(key)}</li>
										))}
									</ul>
								)}
								<button
									type="button"
									className={`btn btn-primary btn-sm w-fit ${connecting ? "btn-disabled" : ""}`}
									onClick={handleConnect}
									disabled={connecting}
								>
									{connecting
										? "Redirecting..."
										: state === "incomplete"
											? "Continue Stripe Setup"
											: "Connect Stripe"}
								</button>
							</>
						)}
					</div>
				</div>

				{balanceRows && (balanceRows.available.length > 0 || balanceRows.pending.length > 0) ? (
					<div className="card bg-base-200">
						<div className="card-body">
							<h2 className="card-title text-lg">Stripe balance</h2>
							<div className="grid grid-cols-2 gap-4">
								<div>
									<div className="text-xs uppercase text-base-content/50">Available</div>
									<div className="text-xl font-bold">
										{balanceRows.available
											.filter((b) => b.currency)
											.map((b) => money(b.amount / 100, b.currency))
											.join(", ")}
									</div>
								</div>
								<div>
									<div className="text-xs uppercase text-base-content/50">Pending</div>
									<div className="text-xl font-bold">
										{balanceRows.pending
											.filter((b) => b.currency)
											.map((b) => money(b.amount / 100, b.currency))
											.join(", ") || "$0.00"}
									</div>
								</div>
							</div>
							<p className="text-xs text-base-content/50">
								What has reached your Stripe balance. Money still inside its 14-day hold is not here
								yet; it shows below as Held.
							</p>
						</div>
					</div>
				) : null}

				{earnings && parseFloat(earnings.heldTotal) > 0 ? (
					<div className="card bg-base-200">
						<div className="card-body">
							<h2 className="card-title text-lg">Anthers ledger</h2>
							<div className="grid grid-cols-2 gap-4">
								<div>
									<div className="text-xs uppercase text-base-content/50">Held</div>
									<div className="text-xl font-bold">${earnings.heldTotal}</div>
								</div>
								<div>
									<div className="text-xs uppercase text-base-content/50">Transferred</div>
									<div className="text-xl font-bold">${earnings.transferredTotal}</div>
								</div>
							</div>
							<p className="text-xs text-base-content/50">
								Held is settled money waiting out its 14-day hold, which moves into your Stripe
								balance when the hold ends. Transferred has already moved.
							</p>
						</div>
					</div>
				) : null}

				<p className="text-sm text-base-content/50">
					Nothing here changes how much you earn:{" "}
					<Link to={studioUrl("/settings")} className="link">
						Studio settings
					</Link>{" "}
					still holds Badges and publishing, and your account's own settings live on{" "}
					<Link to="/settings" className="link">
						your Anthers account
					</Link>
					.
				</p>
			</div>
		</div>
	);
}
