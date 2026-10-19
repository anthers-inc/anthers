// SPDX-License-Identifier: Apache-2.0
/**
 * Studio Settings — the creator-operational settings that live on the Studio side of
 * the boundary: the Communications table for creator emails, the account's AT Protocol
 * connection, and the Badge ladder. Account settings (profile, password, email,
 * identity, the become-a-creator toggle) stay on anthers.org/settings.
 *
 * ⚠️ **Payout setup is not here.** Its surface is the Studio's Payments tab
 * (`/studio/payments`), which is also where Connect's return legs land and where Stripe's
 * requirements, schedule and balance are shown. A Settings card that only linked there
 * was redundant with the nav (removed 2026-10-19).
 */
import {
	CREATOR_EMAIL_KINDS,
	type CreatorEmailKind,
	type CreatorEmailMode,
	resolvedCreatorEmailDelivery,
} from "@anthers/shared/creator-emails";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BadgeMaker from "../components/post/BadgeMaker";
import { useAuth } from "../lib/auth";
import type { PublishingState } from "../lib/publishing";
import { apiFetch } from "../lib/rpc";

/** The order and copy of the Studio's Communications table. */
const CREATOR_EMAIL_COPY: Record<CreatorEmailKind, { label: string; hint: string }> = {
	sale: {
		label: "Sales",
		hint: "An email each time somebody buys one of your Works.",
	},
	refund: {
		label: "Refunds",
		hint: "An email each time a sale on your work is refunded.",
	},
	payout: {
		label: "Payouts",
		hint: "An email each time money moves to your Stripe balance.",
	},
};

/**
 * Communications — every creator email Anthers offers, with one switch each.
 *
 * ⭐ **One row per kind, because the old single switch bundled three different mails.**
 * A creator who wants payout mail but not a message per sale had no way to say it. The
 * kinds are the shared registry's, so a control cannot appear for a mail Anthers never
 * sends; app notifications are a later column on the same table once they exist for
 * these alerts, which is why this reads as a table rather than a list of toggles.
 *
 * ⚠️ **The write carries the whole map**, the same rule the Notifications section uses:
 * the page holds every kind's state, and a per-key patch would need a story for setting
 * one back to the default.
 */
function CommunicationsSection() {
	const [modes, setModes] = useState<Record<CreatorEmailKind, CreatorEmailMode> | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(() => {
		apiFetch("/api/accounts/me")
			.then(async (res) => {
				if (!res.ok) throw new Error("Could not load your email settings.");
				const body = (await res.json()) as {
					user: { creatorEmailDelivery?: Record<string, string> };
				};
				setModes(resolvedCreatorEmailDelivery(body.user.creatorEmailDelivery));
			})
			.catch((e) =>
				setError(e instanceof Error ? e.message : "Could not load your email settings."),
			);
	}, []);

	useEffect(() => load(), [load]);

	async function setMode(kind: CreatorEmailKind, mode: CreatorEmailMode) {
		if (!modes) return;
		const before = modes;
		const next = { ...modes, [kind]: mode };
		setModes(next); // Optimistic; snap back on refusal.
		setSaving(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ creatorEmailDelivery: next }),
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			setModes(before);
			setError("Couldn't save that. Try again.");
		} finally {
			setSaving(false);
		}
	}

	if (modes === null && !error) return null;

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Communications</h3>
				<p className="text-sm text-base-content/60">
					What Anthers emails you about your work and your money. Each one is on unless you turn it
					off.
				</p>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{modes !== null && (
					<table className="table mt-1">
						<thead>
							<tr>
								<th>Alert</th>
								<th className="text-right">Delivery</th>
							</tr>
						</thead>
						<tbody>
							{CREATOR_EMAIL_KINDS.map((kind) => {
								const copy = CREATOR_EMAIL_COPY[kind];
								const mode = modes[kind];
								return (
									<tr key={kind}>
										<td>
											<span className="text-sm font-medium">{copy.label}</span>
											<p className="text-xs text-base-content/50">{copy.hint}</p>
										</td>
										<td className="text-right">
											<fieldset className="join border-0 p-0 m-0">
												<legend className="sr-only">
													How {copy.label.toLowerCase()} reach you
												</legend>
												<button
													type="button"
													className={`btn btn-xs join-item w-16 ${mode === "none" ? "btn-primary" : "btn-outline"}`}
													aria-pressed={mode === "none"}
													disabled={saving}
													onClick={() => setMode(kind, "none")}
												>
													None
												</button>
												<button
													type="button"
													className={`btn btn-xs join-item w-16 ${mode === "email" ? "btn-primary" : "btn-outline"}`}
													aria-pressed={mode === "email"}
													disabled={saving}
													onClick={() => setMode(kind, "email")}
												>
													Email
												</button>
											</fieldset>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

/** The record types the card lists, in publishing order, and what to call them. */
const RECORD_LABELS: Record<PublishingState["records"][number]["kind"], string> = {
	work: "Works",
	post: "Posts",
	project: "Projects",
	comment: "Comments",
	review: "Reviews",
	vote: "Votes",
	follow: "Follows",
	creditAcceptance: "Credit Acceptances",
};

/** Taproot's viewer for one collection in one repository. */
function taprootUrl(did: string, collection: string): string {
	return `https://atproto.at/uri/at://${did}/${collection}`;
}

/**
 * The account's connection to the AT Protocol, and what Anthers has published through it.
 *
 * ⭐ **The card leads with the records rather than with the permission.** Publishing is
 * load-bearing — an identity Anthers can write to is mandatory — so a card built around
 * granting and revoking described a routine permission as a decision the creator was
 * making. What they actually want to see is their footprint, with the revoke control
 * kept but demoted to a sentence, which is the one thing that still has to be possible.
 *
 * ⚠️ **A hosted identity has no grant to revoke.** Anthers holds its keys and publishes
 * through them; there is no OAuth scope to hand back, and a button implying one would be
 * a lie. Closing the account is the way to remove that identity, so the card says that
 * rather than offering a control that does nothing.
 *
 * ⚠️ **The counts are Anthers' own record, not a network read.** Each is the number of
 * rows carrying an `atproto_uri` for this identity — what Anthers believes it published,
 * which is the claim the rest of the product makes too.
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

	// Either tier missing is a connection that cannot do what the account does.
	const needsPermission = state.route === "ungranted" || state.interactions === "ungranted";
	const hosted = state.route === "hosted";

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
				throw new Error(body?.error ?? "Couldn't revoke the permission.");
			}
			load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't revoke the permission.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Your ATProto Connection</h3>

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

				<p className="text-sm text-base-content/70">
					All of your publicly accessible Anthers content and interactions are recorded in the{" "}
					<a
						href="https://atproto.com"
						className="link link-hover"
						target="_blank"
						rel="noreferrer"
					>
						Atmosphere
					</a>
					, an open format for social data that ensures your data is owned by you, portable for use
					elsewhere, and legible to any app that wants to interact with it. Here's where you can
					find all of the records published to your identity from Anthers:
				</p>

				{state.did && (
					<table className="table table-sm mt-1">
						<thead>
							<tr>
								<th>Record Type</th>
								<th className="text-right">Published</th>
								<th className="text-right">Taproot</th>
							</tr>
						</thead>
						<tbody>
							{state.records.map((record) => (
								<tr key={record.kind}>
									<td className="text-sm">{RECORD_LABELS[record.kind] ?? record.kind}</td>
									<td className="text-right text-sm tabular-nums">{record.count}</td>
									<td className="text-right">
										<a
											href={taprootUrl(state.did as string, record.collection)}
											className="link link-hover text-xs"
											target="_blank"
											rel="noreferrer"
										>
											View
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

				{needsPermission ? (
					<div className="rounded-box border border-warning/40 p-3">
						<p className="text-sm">
							{outcome === "declined" && <strong>No permission was given.</strong>} Anthers can't
							publish or interact for you until it can write to your repository.
						</p>
						{state.offered && (
							<button
								type="button"
								className="btn btn-primary btn-sm mt-2"
								onClick={handleGrant}
								disabled={busy}
							>
								{busy ? "Starting…" : "Give Permission"}
							</button>
						)}
					</div>
				) : hosted ? (
					<p className="text-xs text-base-content/50">
						Anthers hosts this identity and holds its keys, so there is no separate permission to
						revoke. Closing your account is what removes it.
					</p>
				) : (
					<p className="text-xs text-base-content/50">
						If you're having an issue with the ATProto connection or need to shut it off for any
						reason,{" "}
						<button type="button" className="link link-hover" onClick={handleStop} disabled={busy}>
							{busy ? "Revoking…" : "click here to Revoke Permissions"}
						</button>
						. Note that if you revoke ATProto permissions, you won't be able to post or interact
						from this account until you grant the permissions again. Think of this like unplugging
						the Ethernet cable from your account. Revoking also takes down the Works, posts and
						projects Anthers published for you.
					</p>
				)}
			</div>
		</div>
	);
}

export default function StudioSettingsPage() {
	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Creator Settings</h1>
			<p className="text-sm text-base-content/50 mb-6">
				Communications, your ATProto connection and Badges. Account settings (profile, email,
				identity) live on your Anthers account.
			</p>

			<div className="flex flex-col gap-6">
				<CommunicationsSection />
				<AtmospherePublishingSection />
				<div>
					<h2 className="text-lg font-semibold mb-2">Badges</h2>
					<BadgeMaker />
				</div>
			</div>
		</div>
	);
}
