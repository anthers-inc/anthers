// SPDX-License-Identifier: Apache-2.0
/**
 * The Discord connection — one card on both settings pages.
 *
 * ⭐ **One component, because the two pages would otherwise drift into two different accounts**
 * of the same connection, exactly as `SignedInAccountCard` says of itself.
 *
 * The states are genuinely different things and the copy says which one a reader is in: never
 * linked; linked into the members' channels but not yet a creator; linked with the creators'
 * channels open; and the deployment where no application exists yet, which renders nothing at
 * all rather than a button that cannot work.
 *
 * ⚠️ **Disconnecting is not leaving.** It stops the role updates and takes back the Creator role,
 * and the person stays in the server holding the members' role — the copy has to say that,
 * because "Disconnect" reads like "leave" to anyone who has used another app's button.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { isNative } from "../../lib/desktop";
import { useSearchParams } from "../../lib/router";
import { apiBaseUrl, apiFetch } from "../../lib/rpc";

/** What the callback's `discord=` code means, in words somebody can act on. */
const OUTCOMES: Record<string, string> = {
	linked: "Your account is connected. The roles follow what the account has earned.",
	taken: "That Discord account is already connected to a different Anthers account.",
	state: "The sign-in took too long, so nothing changed. Try connecting again.",
	denied: "The Discord sign-in was canceled, so nothing changed.",
	join: "Discord wouldn't let us add you to the server. Nothing changed; try again in a moment.",
	signin: "Sign in to Anthers again before connecting Discord.",
	unavailable: "The Discord connection isn't open yet.",
	error: "Discord didn't answer the way we expected. Nothing changed.",
};

export default function DiscordCard({
	surface = "account",
	className,
}: {
	surface?: "account" | "creator";
	className?: string;
}) {
	const { user, refreshUser } = useAuth();
	const [params, setParams] = useSearchParams();
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Read the callback's outcome once, then take it out of the address so a refresh does not
	// repeat a message about something that happened yesterday.
	useEffect(() => {
		const outcome = params.get("discord");
		if (!outcome) return;
		setNotice(OUTCOMES[outcome] ?? OUTCOMES.error);
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("discord");
				return next;
			},
			{ replace: true },
		);
	}, [params, setParams]);

	const disconnect = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/discord/unlink", { method: "POST" });
			if (!res.ok) throw new Error(String(res.status));
			await refreshUser();
		} catch {
			setError("Couldn't disconnect. Try again.");
		} finally {
			setBusy(false);
		}
	}, [refreshUser]);

	// No application on this deployment: nothing to offer, and nothing to explain.
	if (!user?.isDiscordAvailable) return null;
	// ⚠️ **The desktop shell does not carry this card.** Connecting leaves the app for Discord's
	// consent screen and comes back to the web app, which would strand the desktop's session;
	// the connection is made on anthers.org's settings and the roles follow the account either way.
	if (isNative()) return null;

	const linked = user.isDiscordLinked;
	const verified = user.isCreator === true;
	const body = linked
		? verified
			? "You're in the server, with the creators' channels open."
			: "You're in the server. Finishing creator setup opens the creators' channels."
		: surface === "creator"
			? "The creators' channels on Anthers' Discord server are for creators. Connecting adds you to the server and opens them."
			: "Anthers has a Discord server where readers and creators talk. Connecting your account adds you to it and gives you the roles your account has earned.";

	return (
		<div data-discord-card className={`card bg-base-200 ${className ?? ""}`}>
			<div className="card-body">
				<h3 className="card-title text-lg">Community</h3>
				<p className="text-sm text-base-content/60">{body}</p>

				{notice && (
					<div
						className={`alert text-sm ${notice === OUTCOMES.linked ? "alert-success" : "alert-info"}`}
					>
						<span>{notice}</span>
					</div>
				)}
				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					{linked ? (
						<>
							<button
								type="button"
								className="btn btn-ghost btn-sm w-fit"
								onClick={disconnect}
								disabled={busy}
							>
								{busy ? "Disconnecting…" : "Disconnect Discord"}
							</button>
							<span className="text-xs text-base-content/50">
								Stops the role updates and leaves you in the server.
							</span>
						</>
					) : (
						<button
							type="button"
							className="btn btn-primary btn-sm w-fit"
							onClick={() => window.location.assign(`${apiBaseUrl()}/api/discord/connect`)}
						>
							Connect Discord
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
