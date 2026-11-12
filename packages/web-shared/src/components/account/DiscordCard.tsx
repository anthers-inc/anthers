// SPDX-License-Identifier: Apache-2.0
/**
 * The Discord connection — one card on both settings pages.
 *
 * ⭐ **One component, because the two pages would otherwise drift into two different accounts**
 * of the same connection, exactly as `SignedInAccountCard` says of itself.
 *
 * ⭐ **The card leads with state and roles, not with prose.** The title row says whether the
 * account is connected, the chips say which Discord roles it holds, and the button says what
 * can be done; the callback's success outcome is deliberately silent, because the linked state
 * is already on the card and a green alert repeating it was the loudest thing here.
 *
 * ⚠️ **Disconnecting is not leaving.** It stops the role updates and takes back the Creator role,
 * and the person stays in the server holding the members' role. The line under the button says
 * so, because "Disconnect" reads like "leave" to anyone who has used another app's button.
 */
import { ExclamationCircleIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { isNative } from "../../lib/desktop";
import { useSearchParams } from "../../lib/router";
import { apiBaseUrl, apiFetch } from "../../lib/rpc";

/** What the callback's `discord=` code means, in words somebody can act on. */
const OUTCOMES: Record<string, string> = {
	taken: "That Discord account is already connected to a different Anthers account.",
	state: "That took too long. Try again.",
	denied: "The Discord sign-in was canceled, so nothing changed.",
	join: "Discord wouldn't add you to the server. Try again in a moment.",
	signin: "Sign in to Anthers again before connecting Discord.",
	unavailable: "The Discord connection isn't open yet.",
	error: "Discord didn't answer the way we expected. Try again.",
};

export default function DiscordCard({ className }: { className?: string }) {
	const { user, refreshUser } = useAuth();
	const [params, setParams] = useSearchParams();
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Read the callback's outcome once, then take it out of the address so a refresh does not
	// repeat a message about something that happened yesterday. A successful link is silent:
	// the card already shows the connection, and saying it again was the redundancy that made
	// this card read like a paragraph.
	useEffect(() => {
		const outcome = params.get("discord");
		if (!outcome) return;
		if (outcome !== "linked") setNotice(OUTCOMES[outcome] ?? OUTCOMES.error);
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
		setNotice(null);
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
	// A linked creator's two role chips already say they are in the server with both roles; a
	// sentence repeating it is exactly the filler this card is shedding. The two states that
	// still need a line are the one that has a next step and the one that has an action.
	const body = linked
		? verified
			? null
			: "Creator setup opens the creators' channels."
		: "Join the Anthers server.";
	const message = error ?? notice;

	return (
		<div
			data-discord-card
			className={`card border border-base-content/5 bg-base-200 ${className ?? ""}`}
		>
			<div className="card-body gap-0">
				<div className="flex flex-wrap items-center gap-4">
					<span
						aria-hidden="true"
						className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-base-300 text-base-content/60"
					>
						<UserGroupIcon className="h-6 w-6" />
					</span>

					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<h3 className="card-title text-lg">Discord</h3>
							{linked && (
								<span
									role="status"
									className="inline-flex items-center gap-1.5 text-xs font-medium text-base-content/55"
								>
									<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
									Connected
								</span>
							)}
						</div>
						{body && <p className="mt-1 text-sm text-base-content/60">{body}</p>}
						{linked && (
							<div className="mt-2 flex flex-wrap gap-1.5">
								<span className="badge badge-ghost badge-sm">Member</span>
								{verified && <span className="badge badge-ghost badge-sm">Creator</span>}
							</div>
						)}
					</div>

					<div className="flex shrink-0 flex-col items-end gap-1">
						{linked ? (
							<>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={disconnect}
									disabled={busy}
									aria-describedby="discord-disconnect-note"
								>
									{busy ? "Disconnecting…" : "Disconnect"}
								</button>
								<span id="discord-disconnect-note" className="text-xs text-base-content/45">
									You stay in the server.
								</span>
							</>
						) : (
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={() => window.location.assign(`${apiBaseUrl()}/api/discord/connect`)}
							>
								Connect
							</button>
						)}
					</div>
				</div>

				{message && (
					<p role="alert" className="mt-3 flex items-start gap-2 text-sm text-base-content/70">
						<ExclamationCircleIcon
							aria-hidden="true"
							className="mt-0.5 h-4 w-4 shrink-0 text-warning"
						/>
						<span>{message}</span>
					</p>
				)}
			</div>
		</div>
	);
}
