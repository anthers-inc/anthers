// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { client } from "../lib/rpc";
import type { PlatformConnection, StripeAccountStatus } from "../lib/types";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

function BlueskySection() {
	const { user, linkBluesky, unlinkBluesky, refreshUser } = useAuth();
	const [searchParams] = useSearchParams();
	const [handle, setHandle] = useState("");
	const [linking, setLinking] = useState(false);
	const [unlinking, setUnlinking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const blueskyResult = searchParams.get("bluesky");
	const isLinked = !!user?.atprotoDid;

	useEffect(() => {
		if (blueskyResult === "linked") {
			refreshUser();
		}
	}, [blueskyResult, refreshUser]);

	const handleLink = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!handle.trim()) return;
		setError(null);
		setLinking(true);
		try {
			await linkBluesky(handle.trim());
			// linkBluesky redirects, so we won't reach here
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to link Bluesky account.");
			setLinking(false);
		}
	};

	const handleUnlink = async () => {
		setError(null);
		setUnlinking(true);
		try {
			await unlinkBluesky();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to unlink Bluesky account.");
		} finally {
			setUnlinking(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">
					<svg
						aria-hidden="true"
						viewBox="0 0 568 501"
						className="w-5 h-5 fill-current"
						xmlns="http://www.w3.org/2000/svg"
					>
						<path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 189.32 552 210.074C529.348 289.699 445.566 310.618 370.792 297.604C496.333 319.1 526.542 386.3 468.333 453.5C356.973 581.793 299.832 402.163 287.455 359.379C285.755 353.725 284.024 353.712 282.545 359.379C270.168 402.163 213.027 581.793 101.667 453.5C43.4583 386.3 73.6667 319.1 199.208 297.604C124.434 310.618 40.652 289.699 18 210.074C11.945 189.32 2 75.2916 2 57.9464C2 -28.9064 78.1345 -1.61183 123.121 33.6637Z" />
					</svg>
					Bluesky / ATProto
				</h3>

				{blueskyResult === "linked" && (
					<div className="alert alert-success text-sm">
						<span>Bluesky account linked successfully.</span>
					</div>
				)}

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{isLinked ? (
					<div className="flex flex-col gap-3">
						<div className="flex items-center gap-2">
							<div className="badge badge-success">Linked</div>
							<span className="text-sm font-medium">@{user.atprotoHandle}</span>
						</div>
						<p className="text-xs text-base-content/50">DID: {user.atprotoDid}</p>
						<button
							type="button"
							className="btn btn-outline btn-error btn-sm w-fit"
							onClick={handleUnlink}
							disabled={unlinking}
						>
							{unlinking ? "Unlinking..." : "Unlink Bluesky"}
						</button>
					</div>
				) : (
					<form onSubmit={handleLink} className="flex flex-col gap-3">
						<p className="text-sm text-base-content/60">
							Link your Bluesky account for portable identity and future federation features.
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								className="input input-bordered flex-1"
								value={handle}
								onChange={(e) => setHandle(e.target.value)}
								placeholder="alice.bsky.social"
							/>
							<button
								type="submit"
								className="btn btn-primary btn-sm"
								disabled={linking || !handle.trim()}
							>
								{linking ? "Linking..." : "Link Account"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

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
			const res = await fetch(`${apiBase}/api/integrations/platforms/youtube/auth`, {
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
			const res = await fetch(`${apiBase}/api/integrations/platforms/${platform}/disconnect`, {
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

export default function SettingsPage() {
	const { user, refreshUser } = useAuth();

	const [isCreator, setIsCreator] = useState(user?.isCreator || false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const handleCreatorToggle = async (checked: boolean) => {
		setIsCreator(checked);
		setSaving(true);
		setError(null);
		setSuccess(false);

		try {
			const res = await fetch(`${apiBase}/api/accounts/me`, {
				method: "PATCH",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isCreator: checked }),
			});

			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "Failed to save settings.");
			}

			await refreshUser();
			setSuccess(true);
		} catch (err) {
			setIsCreator(!checked); // revert on failure
			setError(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">Settings</h1>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}
			{success && (
				<div className="alert alert-success mb-4">
					<span>Settings saved.</span>
				</div>
			)}

			{/* Creator mode toggle */}
			<div className="card bg-base-200 mb-6">
				<div className="card-body">
					<div className="form-control">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-primary"
								checked={isCreator}
								onChange={(e) => handleCreatorToggle(e.target.checked)}
								disabled={saving || !user?.emailVerified}
							/>
							<div>
								<span className="label-text font-medium">Enable creator mode</span>
								<p className="text-xs text-base-content/50 mt-0.5">
									Allows you to publish projects and posts
								</p>
							</div>
						</label>
						{!user?.emailVerified && (
							<p className="text-xs text-warning mt-2">
								<Link to="/verify-email" className="link">
									Verify your email
								</Link>{" "}
								to enable creator mode.
							</p>
						)}
					</div>
				</div>
			</div>

			{/* Bluesky / ATProto */}
			<BlueskySection />

			{/* Stripe Onboarding -- only shown for creators */}
			{isCreator && (
				<div className="mt-6">
					<StripeOnboardingSection />
				</div>
			)}

			{/* Platform Connections -- only shown for creators */}
			{isCreator && (
				<div className="mt-6">
					<PlatformConnectionsSection />
				</div>
			)}
		</div>
	);
}
