// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What stands where a Work's deliverable would be, when the viewer cannot have it.
 *
 * For a gated Work that is an unlock: instead of bouncing the viewer to the creator's
 * Badges page, this names the *exact minimum upgrade* that opens it — the lowest Badge rung
 * that clears the gate — right where the viewer hit it.
 *
 * ⚠️ **There is exactly one route out of a gate: the creator's own ladder.** A second branch offering to clear it by giving Anthers more survived here until
 * 2026-08-29, complete with an inline subscribe flow and a confirmation modal — it read
 * `access.unlock.anthers`, which the server has never emitted since `UnlockOffer` lost that
 * field. It typechecked because the *client* type still declared it, which is the whole
 * lesson: a dead branch stays compilable exactly as long as the type it reads keeps the
 * field alive.
 *
 * ⚠️ **Since 2026-08-28 it also stands in front of free work, for a signed-out visitor**,
 * because consuming a Work requires an account. That case is not a gate and must not be
 * dressed as one; see the `login_required` branch, which reads `isFree` to tell the two
 * apart. It is also the surface that replaced `AnonymousViewerBanner` — the invitation to
 * make an account now stands *instead of* the player rather than underneath one.
 */
import { withNextPath } from "@anthers/shared/next-path";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { Link, useLocation } from "@anthers/web-shared/router";
import type { AccessResult } from "@anthers/web-shared/types";
import { LockClosedIcon, UserPlusIcon } from "@heroicons/react/24/solid";

/** The MARGINAL ask — what the viewer still has to add, not what the gate requires. */
function seedsToGo(moreNeeded: number): string {
	// ⚠️ **A MONEY amount, never a count.** Rendering it as a count
	// would be wrong in two directions at once now: there is no unit to count, and a
	// marginal ask of $2.50 has no whole-number form to round to that isn't a lie.
	return `$${moreNeeded.toFixed(2)} more`;
}

/** Only the creator identity is needed — this works for any gated thing. */
interface UnlockSubject {
	creator?: { username: string; displayName?: string | null } | null;
}

export default function InlineUnlock({
	post,
	access,
}: {
	post: UnlockSubject;
	access: AccessResult;
}) {
	const location = useLocation();

	const creatorName = post.creator?.displayName || post.creator?.username || "this creator";
	const creatorUsername = post.creator?.username;

	/*
	 * Not logged in → both doors, and both of them come back here.
	 *
	 * 🚨 This offered **only "Log in"**, and it did not return anyone anywhere: no `?next=`,
	 * no router state. So a visitor with no account had nothing to click at all, and one
	 * with an account was signed in and dropped on their feed, having lost the Work they
	 * were looking at. The comment above this block said "return to the post" and had said
	 * so since it was written — the behaviour was never there.
	 *
	 * ⚠️ It is easy to think this was collateral from deleting the Create Account card on
	 * 2026-08-17. It wasn't. The component that carried a return was `UnlockModal` in
	 * `web-shared/post/unlock.tsx` — which **nothing rendered**, and which was deleted the
	 * same day for that reason. This is the live gated-Work surface (`WorkPage`), and it
	 * never had one. The transferable half: reading a file tells you what a component would
	 * do, not whether anything renders it.
	 *
	 * `?next=` rather than router state, because it has to survive the whole signup detour
	 * — `/subscribe` → an emailed code → a possible payment modal → `/welcome` — and a
	 * reload in the middle of it, which is a normal thing to do while checking your email.
	 * Sanitized at every read; see `shared/next-path.ts`.
	 */
	if (access.reason === "login_required") {
		const back = `${location.pathname}${location.search}`;

		/*
		 * 🚨 **Two genuinely different situations arrive here, and one copy for both would
		 * be wrong for whichever it wasn't.** Since 2026-08-28 a signed-out visitor resolves
		 * `login_required` for **free** work as well as gated work, because consuming a Work
		 * requires an account. On a gated Work the visitor's access really is in question and
		 * signing in might settle it. On a Public Access Work nothing is in question at all:
		 * it is free to everyone and stays free, and the only thing they lack is an account
		 * for the time to be attributed to. Telling that person to "check your access" would
		 * describe a gate that isn't there, on the most common Work on the platform.
		 *
		 * `isFree` is what tells them apart, and it survives the refusal for exactly this
		 * reason — see `resolveAccessSync`, which withholds the bytes without withdrawing
		 * the claim that the Work is free.
		 *
		 * Sign-up leads on the free branch and log-in leads on the gated one, which is the
		 * likelier next step in each case: somebody meeting free work with no account
		 * probably has none, and somebody meeting a gate probably does.
		 */
		if (access.isFree) {
			return (
				<UnlockCard
					icon="account"
					heading="Free to everyone on Anthers"
					blurb={`This Work costs nothing to watch. Make a free account and it's yours — ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access every month, and ${creatorName} is paid for the time you spend on it.`}
				>
					<Link to={withNextPath("/subscribe", back)} className="btn btn-primary btn-wide">
						Create a free account
					</Link>
					<Link to={withNextPath("/login", back)} className="btn btn-ghost btn-sm">
						Log in
					</Link>
				</UnlockCard>
			);
		}

		return (
			<UnlockCard blurb={`Log in to check your access to this Work from ${creatorName}.`}>
				<Link to={withNextPath("/login", back)} className="btn btn-primary btn-wide">
					Log in to unlock
				</Link>
				<Link to={withNextPath("/subscribe", back)} className="btn btn-ghost btn-sm">
					Create an account
				</Link>
			</UnlockCard>
		);
	}

	// The unlock route comes from the RESOLVER, which owns the thresholds — the client no
	// longer derives them. It used to, and got the label wrong: it named the highest Badge
	// at-or-below the gate, which by definition does not clear a gate sitting above it, and
	// silently dropped the price whenever the gate fell between Badges. `badge` on the route
	// is the Badge sitting EXACTLY at the threshold, or null when none does.
	const creatorRoute = access.unlock?.creator ?? null;

	return (
		<UnlockCard
			// No blurb when there is a route: the button already says what to do and to whom,
			// and a sentence restating it just makes the reader parse the same fact twice.
			// The blurb survives only where nothing else explains the situation.
			blurb={
				creatorRoute
					? undefined
					: `Support ${creatorName} monthly to unlock this post and their other members-only work.`
			}
		>
			{creatorRoute && creatorUsername ? (
				<Link to={`/${creatorUsername}?tab=badges`} className="btn btn-primary btn-wide">
					{`Unlock with ${seedsToGo(creatorRoute.moreNeeded)} to ${creatorName}`}
				</Link>
			) : null}

			{!creatorRoute && creatorUsername ? (
				<Link to={`/${creatorUsername}?tab=badges`} className="btn btn-primary btn-wide">
					Join to unlock
				</Link>
			) : null}
		</UnlockCard>
	);
}

function UnlockCard({
	blurb,
	heading,
	icon = "lock",
	children,
}: {
	/** Only for states the action itself doesn't explain (login, or no route at all). */
	blurb?: string;
	/** Overrides the default "Unlock this post" — for the states that are not unlocks. */
	heading?: string;
	/**
	 * 🚨 **A padlock is a claim, and on Public Access work it is a false one.** Every state
	 * this card renders was a gate until 2026-08-28, so the lock was drawn unconditionally.
	 * Now one of them is a free Work waiting on an account, where a padlock and the word
	 * "Unlock" would tell the visitor they have hit a price that does not exist.
	 */
	icon?: "lock" | "account";
	children: React.ReactNode;
}) {
	const Icon = icon === "lock" ? LockClosedIcon : UserPlusIcon;
	return (
		<div className="card bg-base-200 border border-base-300">
			<div className="card-body items-center text-center gap-3">
				<div className="w-12 h-12 rounded-full bg-base-300 flex items-center justify-center">
					<Icon className="w-6 h-6 text-base-content/70" />
				</div>
				<h3 className="font-bold text-lg">{heading ?? "Unlock this post"}</h3>
				{blurb ? <p className="text-sm text-base-content/60 max-w-sm">{blurb}</p> : null}
				{children}
			</div>
		</div>
	);
}
