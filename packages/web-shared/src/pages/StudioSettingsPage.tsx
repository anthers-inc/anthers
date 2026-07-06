// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Studio Settings — the creator-operational settings that live on the Studio side of
 * the boundary (E50 Phase 4): Stripe payout onboarding, external platform connections
 * (cross-publish / unified analytics), and the boost-tier ladder. Account settings
 * (profile, password, email, identity, the become-a-creator toggle) stay on
 * anthers.org/settings.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BoostLadderEditor from "../components/post/BoostLadderEditor";
import { apiBaseUrl, client } from "../lib/rpc";
import type { PlatformConnection, StripeAccountStatus } from "../lib/types";

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
					<h3 className="card-title text-lg">Stripe Payments</h3>
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
				<h3 className="card-title text-lg">Stripe Payments</h3>

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
							Stripe Connect—you keep 100% of earnings, only real costs are passed through.
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
			const res = await fetch(`${apiBaseUrl()}/api/integrations/platforms/youtube/auth`, {
				method: "POST",
				credentials: "include",
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
			const res = await fetch(`${apiBaseUrl()}/api/integrations/platforms/${platform}/disconnect`, {
				method: "DELETE",
				credentials: "include",
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

export default function StudioSettingsPage() {
	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Creator Settings</h1>
			<p className="text-sm text-base-content/50 mb-6">
				Payouts, platform connections, and boost tiers. Account settings (profile, email, identity)
				live on your Anthers account.
			</p>

			<div className="flex flex-col gap-6">
				<StripeOnboardingSection />
				<PlatformConnectionsSection />
				<div>
					<h2 className="text-lg font-semibold mb-2">Boost Tiers</h2>
					<BoostLadderEditor />
				</div>
			</div>
		</div>
	);
}
