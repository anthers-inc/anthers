// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Studio Settings — the creator-operational settings that live on the Studio side of
 * the boundary (E50 Phase 4): Stripe payout onboarding, external platform connections
 * (cross-publish / unified analytics), and the Badge ladder. Account settings
 * (profile, password, email, identity, the become-a-creator toggle) stay on
 * anthers.org/settings.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BadgeLadderEditor from "../components/post/BadgeLadderEditor";
import { useAuth } from "../lib/auth";
import { apiFetch, client } from "../lib/rpc";
import type { PlatformConnection, StripeAccountStatus } from "../lib/types";

/**
 * Payouts — where Connect onboarding starts, and where Stripe returns somebody afterwards.
 *
 * 🚨 **This section is the destination of `STRIPE_RETURN_PATHS.connectReturn`, so the `stripe`
 * parameter it reads is a contract with the API rather than a local detail.** Renaming this
 * section, moving it to a page of its own, or changing which value of `stripe` it answers to
 * breaks the end of Connect onboarding, and it breaks it in the one place no test of ours
 * makes a request: the return URL is navigated by the creator's browser, not by us.
 *
 * ⚠️ **Called "Payouts" rather than "Stripe Payments" because that is what a creator is
 * looking for.** Stripe is how it is done and the body says so; getting paid is the thing.
 * `payoutRefusalMessage` sends a blocked creator to "Payouts under Studio settings", so the
 * heading and that sentence have to keep agreeing.
 */
function StripeOnboardingSection() {
	const [stripeStatus, setStripeStatus] = useState<StripeAccountStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [connecting, setConnecting] = useState(false);
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

	const handleConnect = async () => {
		setConnecting(true);
		try {
			const res = await client.api.payments.stripe.onboard.$post();
			const data = (await res.json()) as { url: string };
			window.location.href = data.url;
		} catch {
			setConnecting(false);
		}
	};

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
	const isIncomplete = stripeStatus && !stripeStatus.chargesEnabled;

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Payouts</h3>

				{stripeResult === "complete" && !isConnected && (
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

				{isConnected ? (
					<div className="flex items-center gap-2">
						<div className="badge badge-success">Connected</div>
						<span className="text-sm text-base-content/60">
							Your Stripe account is active and ready to receive payments.
						</span>
					</div>
				) : isIncomplete ? (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-base-content/60">
							Your Stripe account setup is incomplete. Complete onboarding to start receiving
							payments.
						</p>
						<button
							type="button"
							className={`btn btn-primary btn-sm w-fit ${connecting ? "btn-disabled" : ""}`}
							onClick={handleConnect}
							disabled={connecting}
						>
							{connecting ? "Redirecting..." : "Complete Stripe Setup"}
						</button>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-base-content/60">
							Connect a Stripe account to receive payments for your paid projects. Anthers uses
							Stripe Connect and takes no cut—only real costs are deducted, and they go to the
							processor and the CDN, never to us.
						</p>
						<button
							type="button"
							className={`btn btn-primary btn-sm w-fit ${connecting ? "btn-disabled" : ""}`}
							onClick={handleConnect}
							disabled={connecting}
						>
							{connecting ? "Redirecting..." : "Connect Stripe"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

const PLATFORM_INFO: Record<
	string,
	{ name: string; description: string; authType: "oauth" | "api_key" }
> = {
	youtube: {
		name: "YouTube",
		description: "Upload videos and track analytics from your YouTube channel.",
		authType: "oauth",
	},
	steam: {
		name: "Steam",
		description: "Sync game builds and track sales via Steam publisher API.",
		authType: "api_key",
	},
	itchio: {
		name: "itch.io",
		description: "Push builds and import analytics from your itch.io page.",
		authType: "api_key",
	},
	substack: {
		name: "Substack",
		description: "Cross-publish text posts to your Substack newsletter.",
		authType: "api_key",
	},
};

function PlatformConnectionsSection() {
	const [searchParams] = useSearchParams();
	const [connections, setConnections] = useState<PlatformConnection[]>([]);
	const [loading, setLoading] = useState(true);
	const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
	const [apiKeyInput, setApiKeyInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [disconnecting, setDisconnecting] = useState<string | null>(null);

	const youtubeResult = searchParams.get("youtube");

	const fetchConnections = () => {
		client.api.integrations.platforms
			.$get()
			.then((res) => res.json())
			.then((data) => setConnections((data as { platforms: PlatformConnection[] }).platforms))
			.catch(() => {})
			.finally(() => setLoading(false));
	};

	useEffect(fetchConnections, []);

	const connectedPlatforms = new Set(connections.map((c) => c.platform));

	const handleYouTubeConnect = async () => {
		setError(null);
		try {
			const res = await apiFetch("/api/integrations/platforms/youtube/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			if (!res.ok) {
				const data = (await res.json()) as { detail?: string };
				setError(data?.detail ?? "Failed to initiate YouTube connection.");
				return;
			}
			const data = (await res.json()) as { authorizationUrl: string };
			window.location.href = data.authorizationUrl;
		} catch {
			setError("Something went wrong.");
		}
	};

	const handleAPIKeyConnect = async (platform: string) => {
		if (!apiKeyInput.trim()) return;
		setError(null);
		try {
			const res = await client.api.integrations.platforms.connect.$post({
				json: {
					platform: platform as "steam" | "itchio" | "substack",
					apiKey: apiKeyInput.trim(),
				},
			});
			if (!res.ok) {
				const data = (await res.json()) as { detail?: string };
				throw new Error(data?.detail ?? "Failed to connect platform.");
			}
			setApiKeyInput("");
			setConnectingPlatform(null);
			fetchConnections();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		}
	};

	const handleDisconnect = async (platform: string) => {
		setDisconnecting(platform);
		setError(null);
		try {
			const res = await apiFetch(`/api/integrations/platforms/${platform}/disconnect`, {
				method: "DELETE",
			});
			if (!res.ok) {
				const data = (await res.json()) as { detail?: string };
				throw new Error(data?.detail ?? "Failed to disconnect platform.");
			}
			fetchConnections();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to disconnect platform.");
		} finally {
			setDisconnecting(null);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Platform Connections</h3>
				<p className="text-sm text-base-content/60 mb-2">
					Connect external platforms for cross-publishing and unified analytics.
				</p>

				{youtubeResult === "connected" && (
					<div className="alert alert-success text-sm mb-2">
						<span>YouTube connected successfully.</span>
					</div>
				)}
				{youtubeResult === "error" && (
					<div className="alert alert-error text-sm mb-2">
						<span>Failed to connect YouTube. Please try again.</span>
					</div>
				)}
				{error && (
					<div className="alert alert-error text-sm mb-2">
						<span>{error}</span>
					</div>
				)}

				{loading ? (
					<p className="text-sm text-base-content/50">Loading...</p>
				) : (
					<div className="flex flex-col gap-3">
						{Object.entries(PLATFORM_INFO).map(([platform, info]) => {
							const conn = connections.find((c) => c.platform === platform);
							const isConnected = connectedPlatforms.has(platform);

							return (
								<div
									key={platform}
									className="flex items-center justify-between p-3 bg-base-100 rounded-lg"
								>
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">{info.name}</span>
											{isConnected && (
												<span className="badge badge-success badge-xs">Connected</span>
											)}
										</div>
										{isConnected && conn?.platformUsername && (
											<p className="text-xs text-base-content/50">{conn.platformUsername}</p>
										)}
										{!isConnected && (
											<p className="text-xs text-base-content/40">{info.description}</p>
										)}
									</div>

									<div className="flex items-center gap-2">
										{isConnected ? (
											<button
												type="button"
												className="btn btn-outline btn-error btn-xs"
												onClick={() => handleDisconnect(platform)}
												disabled={disconnecting === platform}
											>
												{disconnecting === platform ? "..." : "Disconnect"}
											</button>
										) : connectingPlatform === platform && info.authType === "api_key" ? (
											<div className="flex gap-1">
												<input
													type="password"
													className="input input-bordered input-xs w-40"
													value={apiKeyInput}
													onChange={(e) => setApiKeyInput(e.target.value)}
													placeholder="API key"
													onKeyDown={(e) => {
														if (e.key === "Enter") handleAPIKeyConnect(platform);
													}}
												/>
												<button
													type="button"
													className="btn btn-primary btn-xs"
													onClick={() => handleAPIKeyConnect(platform)}
													disabled={!apiKeyInput.trim()}
												>
													Save
												</button>
												<button
													type="button"
													className="btn btn-ghost btn-xs"
													onClick={() => {
														setConnectingPlatform(null);
														setApiKeyInput("");
													}}
												>
													Cancel
												</button>
											</div>
										) : (
											<button
												type="button"
												className="btn btn-primary btn-xs"
												onClick={() => {
													if (info.authType === "oauth") {
														handleYouTubeConnect();
													} else {
														setConnectingPlatform(platform);
														setApiKeyInput("");
													}
												}}
											>
												Connect
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

/** What `GET /api/atproto/publishing` answers. Mirrors `PublishingState` in the API. */
interface PublishingState {
	route: "hosted" | "granted" | "available" | "none";
	offered: boolean;
	did: string | null;
	handle: string;
	listed: number;
}

/**
 * Publishing a creator's Work listings into the repository behind their own identity.
 *
 * 🚨 **`available` is an offer, never a gap, and this component is where that promise is kept
 * or quietly broken.** Publishing on Anthers has never required a network permission: a creator
 * who grants nothing releases, gates, gets paid and is found exactly as anybody else does, and
 * the only difference is that no listing goes out. So there is no warning styling here, no
 * badge, no count of what they are "missing" — the section says what would happen if they said
 * yes, and is silent about them not having.
 *
 * ⚠️ **It renders nothing at all unless there is something true to say.** An account with no
 * identity has no repository for a listing to live in, and a section explaining a thing they
 * cannot do is the nagging this design is trying not to be.
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: one read on mount, by design.
	useEffect(load, []);

	if (loading || !state) return null;
	// No identity means no repository, and nothing here would be true for them.
	if (state.route === "none") return null;
	// Nothing to offer and nothing granted — say nothing rather than advertise a closed door.
	if (state.route === "available" && !state.offered) return null;

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
						<span>Your listings are on their way to your repository.</span>
					</div>
				)}
				{outcome === "declined" && (
					<div className="alert alert-info text-sm">
						<span>No permission given, so nothing is published. Everything else is unchanged.</span>
					</div>
				)}
				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{state.route === "hosted" && (
					<p className="text-sm text-base-content/70">
						Anthers publishes a listing for each released Work into the repository behind{" "}
						<span className="font-medium">@{state.handle}</span>, the handle it issued you. Nothing
						to set up.
					</p>
				)}

				{state.route === "granted" && (
					<>
						<p className="text-sm text-base-content/70">
							Anthers keeps a listing for each released Work in your own repository, under{" "}
							<span className="font-medium">@{state.handle}</span>. A listing says what a work is
							and where to reach it — never the work itself, and never who may open it.
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
								{busy ? "Taking them down…" : "Stop publishing"}
							</button>
						</div>
						{/* ⚠️ Said before they press it, not after. Stopping removes the records, and a
						    deletion cannot be undone by us — it is their repository. */}
						<p className="text-xs text-base-content/50">
							Stopping removes the listings already on the network and hands the permission back.
						</p>
					</>
				)}

				{state.route === "available" && (
					<>
						<p className="text-sm text-base-content/70">
							Anthers can keep a listing for each of your released Works in your own repository,
							under <span className="font-medium">@{state.handle}</span>, so your catalog is
							readable by other software on the network and outlives any one service — including
							this one.
						</p>
						<p className="text-sm text-base-content/50">
							It asks for permission over that one kind of record and nothing else: not your posts,
							not your follows, not your messages. A listing carries the title, description and a
							link — never the work itself, and never who may open it.
						</p>
						<div className="card-actions justify-end">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={handleGrant}
								disabled={busy}
							>
								{busy ? "Starting…" : "Publish my catalog"}
							</button>
						</div>
					</>
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
				Payouts and Badges. Account settings (profile, email, identity) live on your Anthers
				account.
			</p>

			<div className="flex flex-col gap-6">
				<StripeOnboardingSection />
				<AtmospherePublishingSection />
				{/* Platform Connections hidden — the YouTube OAuth route does not exist
				    (404s), and the cross-publish job throws for all three targets. The
				    panel is built but its backend is stubbed, so a creator who reaches it
				    finds a form that always fails. Restore when the Cross-Publishing lane
				    lands its endpoints. */}
				{/* <PlatformConnectionsSection /> */}
				<div>
					<h2 className="text-lg font-semibold mb-2">Badges</h2>
					<BadgeLadderEditor />
				</div>
			</div>
		</div>
	);
}
