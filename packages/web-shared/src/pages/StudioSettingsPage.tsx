// SPDX-License-Identifier: Apache-2.0
/**
 * Studio Settings — the creator-operational settings that live on the Studio side of
 * the boundary: payout setup's summary card (the surface itself is the Payments tab),
 * publishing to the creator's own repository on the AT Protocol network, and the Badge
 * ladder. Account settings (profile, password, email, identity, the become-a-creator
 * toggle) stay on anthers.org/settings.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BadgeLadderEditor from "../components/post/BadgeLadderEditor";
import { useAuth } from "../lib/auth";
import type { PublishingState } from "../lib/publishing";
import { Link } from "../lib/router";
import { apiFetch, client } from "../lib/rpc";
import { studioUrl } from "../lib/studio";
import type { StripeAccountStatus } from "../lib/types";

/**
 * Payouts — now a doorway rather than the surface.
 *
 * 🚨 **Payout setup lives on the Studio's Payments tab (`/studio/payments`)**, which is
 * also where Connect's return legs land and where Stripe's requirements, schedule and
 * balance are shown. This card carries the one-line state and the link, so a creator who
 * reaches settings for the publishing or Badges sections still finds their payout state
 * named rather than absent.
 *
 * ⚠️ **Called "Payouts" here and "Payments" in the nav deliberately**: the nav names the
 * *place* (Payments), the card names the *need* (Payouts — getting paid is the thing a
 * creator is looking for when they arrive). `payoutRefusalMessage` says "Open Payments in
 * the Studio" to match the nav.
 */
function StripeOnboardingSection() {
	const [stripeStatus, setStripeStatus] = useState<StripeAccountStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [searchParams] = useSearchParams();

	const stripeResult = searchParams.get("stripe");

	useEffect(() => {
		client.api.payments.stripe.onboard
			.$get()
			.then((res) => res.json() as Promise<unknown>)
			.then((data) => setStripeStatus(data as StripeAccountStatus))
			.catch(() => setStripeStatus(null))
			.finally(() => setLoading(false));
	}, []);

	if (loading) {
		return (
			<div className="card bg-base-200">
				<div className="card-body">
					<h3 className="card-title text-lg">Payouts</h3>
					<p className="text-sm text-base-content/60">Loading...</p>
				</div>
			</div>
		);
	}

	const isConnected = stripeStatus?.chargesEnabled && stripeStatus?.onboardingComplete;
	const isPending =
		stripeStatus?.hasAccount &&
		stripeStatus.chargesEnabled === false &&
		stripeStatus.onboardingComplete === false &&
		// Pending means Stripe has the submission; without the flag the incomplete state is
		// indistinguishable from unstarted, which is why the detail shape carries it.
		stripeStatus.detailsSubmitted;

	const stateLine = isConnected
		? "Your Stripe account is connected and ready to receive payments."
		: isPending
			? "Stripe onboarding is submitted and being reviewed."
			: stripeStatus?.hasAccount
				? "Your Stripe account setup is incomplete."
				: "Payouts are not set up yet.";

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Payouts</h3>
				{stripeResult === "refresh" && (
					<div className="alert alert-warning text-sm">
						<span>Stripe onboarding link expired. Continue from the Payments tab.</span>
					</div>
				)}
				<p className="text-sm text-base-content/60">{stateLine}</p>
				<div className="card-actions justify-end">
					<Link to={studioUrl("/payments")} className="btn btn-primary btn-sm">
						Open Payments
					</Link>
				</div>
			</div>
		</div>
	);
}

/**
 * Publishing a creator's records into the repository behind their own identity.
 *
 * 🚨 **`ungranted` is a warning, and this card is where it is said most fully.** An identity
 * Anthers can write to is mandatory (Parker, 2026-09-12), so a creator whose identity is held
 * elsewhere and who has declined, withdrawn or lost the permission cannot release a Work or
 * publish a post or a project — the API refuses them. The card says so plainly, says what is
 * asked for, and carries the one button that fixes it. The banner on every other page points
 * the same way and stays off this one.
 *
 * ⚠️ **It renders nothing when Anthers is not asking for the permission**, because a warning
 * with no button is a creator told about a problem they cannot fix, and the API refuses nobody
 * in that state either.
 */
function AtmospherePublishingSection() {
	const { grantPublishing } = useAuth();
	const [state, setState] = useState<PublishingState | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [searchParams] = useSearchParams();

	const outcome = searchParams.get("publishing");

	const load = () => {
		apiFetch("/api/atproto/publishing")
			.then((res) => (res.ok ? (res.json() as Promise<PublishingState>) : null))
			.then(setState)
			.catch(() => setState(null))
			.finally(() => setLoading(false));
	};
	// One read on mount, by design.
	useEffect(load, []);

	if (loading || !state) return null;
	// No such account — every account holds an identity, so this is a failed read, not a state.
	if (state.route === "none") return null;
	// Nothing granted and no way to ask — say nothing rather than warn about a closed door.
	if (state.route === "ungranted" && !state.offered) return null;

	const handleGrant = async () => {
		setBusy(true);
		setError(null);
		try {
			await grantPublishing();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't start the Bluesky permission.");
			setBusy(false);
		}
	};

	const handleStop = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/atproto/publishing/stop", { method: "POST" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't take your listings down.");
			}
			load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't take your listings down.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Your Catalog on the Network</h3>

				{outcome === "on" && (
					<div className="alert alert-success text-sm">
						<span>Your records are on their way to your repository.</span>
					</div>
				)}
				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{state.route === "hosted" && (
					<p className="text-sm text-base-content/70">
						Anthers publishes a record for each released Work, post and project into the repository
						behind <span className="font-medium">@{state.handle}</span>, the handle it issued you.
						Nothing to set up.
					</p>
				)}

				{state.route === "granted" && (
					<>
						<p className="text-sm text-base-content/70">
							Anthers keeps a record for each released Work, post and project in your own
							repository, under <span className="font-medium">@{state.handle}</span>. A Work's
							listing says what it is and where to reach it — never the work itself, and never who
							may open it.
						</p>
						<p className="text-sm text-base-content/50">
							{state.listed === 0
								? "Nothing is listed yet."
								: `${state.listed} ${state.listed === 1 ? "work is" : "works are"} listed.`}
						</p>
						<div className="card-actions justify-end">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={handleStop}
								disabled={busy}
							>
								{busy ? "Taking them down…" : "Stop Publishing"}
							</button>
						</div>
						{/* ⚠️ Said before they press it, not after. Stopping removes the records, and a
						    deletion cannot be undone by us — it is their repository. */}
						<p className="text-xs text-base-content/50">
							Stopping removes the Works, posts and projects already on the network and hands the
							permission back, and you won't be able to release or publish anything until you give
							it again.
						</p>
					</>
				)}

				{state.route === "ungranted" && (
					<>
						<div className="alert alert-warning text-sm">
							<span>
								{/* A decline lands here, so the lead says what just happened rather than
								    stacking a second warning on this one. */}
								<strong>
									{outcome === "declined"
										? "No permission was given."
										: "Anthers can't publish for you yet."}
								</strong>{" "}
								You can't release Works or publish posts and projects until you give Anthers
								permission to write them into your repository under{" "}
								<span className="font-medium">@{state.handle}</span>.
							</span>
						</div>
						<p className="text-sm text-base-content/70">
							Anthers keeps a record for each of your released Works, posts and projects in your own
							repository, so your catalog is readable by other software on the network and outlives
							any one service — including this one.
						</p>
						<p className="text-sm text-base-content/50">
							It asks for permission over Anthers' own kinds of record and nothing else: not your
							Bluesky posts, not your messages, not anything another app wrote. A Work's listing
							carries the title, description and a link — never the work itself, and never who may
							open it.
						</p>
						<div className="card-actions justify-end">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={handleGrant}
								disabled={busy}
							>
								{busy ? "Starting…" : "Give Permission"}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Receipt emails on the creator's side of a transaction: a sale, a refund, mailed to the
 * account address for every one, on by default. Low volume is when every creator starts
 * (and where the platform is today), so the default is on and the switch is the way out
 * at scale — the reasoning lives on the column.
 *
 * The toggle hides entirely until a Stripe account exists: a creator still onboarding
 * has received no money and can receive none, so a switch about sale emails would render
 * as dead UI — the same show-nothing rule `AtmospherePublishingSection` applies to a
 * closed door. PATCH is refused by the API in that state anyway.
 */
function CreatorReceiptEmailsSection() {
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [exists, setExists] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		apiFetch("/api/payments/stripe/receipt-emails")
			.then(async (res) => {
				if (!res.ok) {
					// 409 is the no-Stripe-account answer, which is the hide case, not an error.
					if (res.status === 409) setExists(false);
					return null;
				}
				return (res.json() as Promise<{ enabled: boolean }>).then((d) => d.enabled);
			})
			.then((v) => v !== null && setEnabled(v))
			.catch(() => setExists(false));
	}, []);

	const toggle = async () => {
		if (enabled === null) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/payments/stripe/receipt-emails", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: !enabled }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't save the setting.");
			}
			const data = (await res.json()) as { enabled: boolean };
			setEnabled(data.enabled);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save the setting.");
		} finally {
			setBusy(false);
		}
	};

	if (!exists || enabled === null) return null;

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Email me about every transaction</h3>
				<p className="text-sm text-base-content/60">
					An email each time somebody buys or is refunded on your work, sent to your account
					address. It's on while volume is low; turn it off any time.
				</p>
				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}
				<div>
					<button className="btn btn-sm btn-outline" onClick={toggle} disabled={busy}>
						{enabled ? "Turn off" : "Turn on"}
					</button>
				</div>
			</div>
		</div>
	);
}

export default function StudioSettingsPage() {
	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Creator Settings</h1>
			<p className="text-sm text-base-content/50 mb-6">
				Payouts, publishing and Badges. Account settings (profile, email, identity) live on your
				Anthers account.
			</p>

			<div className="flex flex-col gap-6">
				<StripeOnboardingSection />
				<CreatorReceiptEmailsSection />
				<AtmospherePublishingSection />
				<div>
					<h2 className="text-lg font-semibold mb-2">Badges</h2>
					<BadgeLadderEditor />
				</div>
			</div>
		</div>
	);
}
