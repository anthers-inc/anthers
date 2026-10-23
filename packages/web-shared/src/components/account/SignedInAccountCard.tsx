// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account, named where the session can be ended: who this browser is
 * signed in as, with **Log Out** beside it.
 *
 * ⭐ **It has a card on both settings pages** — the user settings page's Account tab and
 * the creator settings page — because each page is reachable without the other, and one
 * shared component is what keeps the two from drifting into two different accounts.
 *
 * ⚠️ **Switch Account is coming, and this is the seat it takes.** When one browser can
 * hold several accounts at once, its button sits to the left of Log Out; that work is
 * parked in its own task, so the comment below marks the place rather than building it.
 */

import { useAuth } from "../../lib/auth";
import { displayHandle } from "../../lib/profile";
import { useNavigate } from "../../lib/router";

export default function SignedInAccountCard({ className }: { className?: string }) {
	const { user, signOut } = useAuth();
	const navigate = useNavigate();

	// The page is behind ProtectedRoute, but the shell can re-render here after a sign-out.
	if (!user) return null;

	const name = user.displayName || user.handle;

	const handleLogout = async () => {
		await signOut();
		navigate("/");
	};

	return (
		<div data-signed-in-account className={`card bg-base-200 ${className ?? ""}`}>
			<div className="card-body flex-row flex-wrap items-center gap-4">
				{user.avatar ? (
					<img src={user.avatar} alt="" className="w-12 h-12 shrink-0 rounded-full object-cover" />
				) : (
					<span
						aria-hidden="true"
						className="w-12 h-12 shrink-0 rounded-full bg-base-300 text-lg font-semibold flex items-center justify-center text-base-content/60"
					>
						{name.charAt(0).toUpperCase()}
					</span>
				)}

				<div className="min-w-0">
					<p className="text-xs text-base-content/50">Signed in as</p>
					<p className="truncate font-medium">{name}</p>
					<p className="truncate text-xs text-base-content/50">{displayHandle(user.handle)}</p>
				</div>

				<div className="ml-auto flex shrink-0 items-center gap-2">
					{/* Switch Account goes here, to the left of Log Out, once one browser can
					    hold several signed-in accounts at once. */}
					<button type="button" className="btn btn-outline btn-sm" onClick={handleLogout}>
						Log Out
					</button>
				</div>
			</div>
		</div>
	);
}
