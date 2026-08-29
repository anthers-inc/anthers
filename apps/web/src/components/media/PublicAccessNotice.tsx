// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the Public Access meter says, and when.
 *
 * Two surfaces, in ascending order of how much they interrupt:
 *
 *   • {@link PublicAccessCountdown} — a line under a player, only in the last hour.
 *   • {@link PublicAccessWall} — replaces the player once the allowance is spent.
 *
 * There was a third, {@link PublicAccessFooter} explains where it went.
 *
 * 🚨 **The whole point is to speak before the stop, not after it.** A limit that arrives
 * unannounced reads as a broken player, and the person it happens to has no way to know
 * they were three minutes from the end of a monthly allowance — or that $3 a month removes
 * it. That is why the countdown exists at all: the wall on its own would be a working
 * feature and a dishonest one.
 *
 * ⚠️ **This is the platform's only conversion event.**
 * It is the one moment a free user is asked for money by something they actually wanted,
 * rather than by an argument on a marketing page. Which cuts both ways — it earns the
 * right to be a real interruption, and it is the last place that should feel like a
 * nag, so nothing here appears until the last hour and nothing here blocks a page.
 */

import {
	formatMultiple,
	PUBLIC_ACCESS_PRICE,
	timePoolMultipleFor,
} from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { useAuth } from "@anthers/web-shared/auth";
import { Link } from "@anthers/web-shared/router";
import {
	describeRemaining,
	type PublicAccessBudget,
	shouldWarn,
	useMeteredBudget,
} from "../../lib/public-access";

/**
 * The multiplier, derived rather than typed.
 *
 * 21.01 §9.4 words this as "six times more", and six is `timePoolFor(PUBLIC_ACCESS_PRICE) /
 * FREE_TIME_POOL` — a ratio between two dials, one of which (`FREE_TIME_POOL`) is
 * explicitly provisional. Typing it would put a silent lie in the single piece of copy
 * the conversion argument rests on, the day anyone tunes it.
 */
const MULTIPLE = formatMultiple(timePoolMultipleFor());

/** Shared close: what supporting Anthers does, in the two sentences that are actually true. */
function SeedPitch({ compact = false }: { compact?: boolean }) {
	return (
		<p className={compact ? "text-xs text-base-content/60" : "text-sm text-base-content/70"}>
			Supporting Anthers is ${PUBLIC_ACCESS_PRICE} a month and removes the limit entirely — and
			every creator you spend time with is paid <strong>{MULTIPLE} more</strong> for your attention.
		</p>
	);
}

/**
 * The last-hour line. Renders nothing at all until the budget is low.
 *
 * Deliberately not a badge showing "7h 12m left" all month: a meter that is always on
 * screen turns a generous allowance into a thing being counted, which is the opposite of
 * what "free forever" is supposed to feel like.
 */
export function PublicAccessCountdown() {
	const budget = useMeteredBudget();
	if (!shouldWarn(budget) || !budget || budget.remainingSeconds === null) return null;

	const spent = budget.remainingSeconds === 0;
	return (
		<div
			className={`mt-3 rounded-lg border px-4 py-3 ${
				spent ? "border-warning/40 bg-warning/10" : "border-base-300 bg-base-200/60"
			}`}
			// Announced politely: this appears mid-playback, and a live region that
			// interrupts a screen reader to mention a countdown would be worse than silent.
			role="status"
			aria-live="polite"
		>
			<p className="text-sm">
				{spent ? (
					<>You've used your {FREE_PUBLIC_ACCESS_HOURS} free hours of Public Access this month.</>
				) : (
					<>
						<strong>{describeRemaining(budget.remainingSeconds)}</strong> of Public Access left this
						month.
					</>
				)}
			</p>
			<SeedPitch compact />
			<Link to="/subscribe" className="btn btn-primary btn-sm mt-3">
				Support Anthers
			</Link>
		</div>
	);
}

/**
 * What stands where the player would be, once the allowance is spent.
 *
 * 🚨 Note what this is **not**: it is not a locked-content panel, and it must never
 * borrow that language. The Work is free to everyone and stays free to everyone — what
 * ran out belongs to the *viewer*, and the copy has to put it that way round or the
 * commons quietly reads as stratified again, which is exactly what retiring Anthers
 * Gates was for. "You've used your ten hours", never "this is locked".
 */
export function PublicAccessWall({ budget }: { budget: PublicAccessBudget }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-base-300 bg-base-200 px-6 py-12 text-center">
			<h3 className="text-lg font-bold">
				That's your {FREE_PUBLIC_ACCESS_HOURS} hours for this month
			</h3>
			<p className="max-w-md text-sm text-base-content/70">
				Every account gets {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, free forever —
				and yours start again next month. This work stays free to everyone; it's the hours that ran
				out, not the work.
			</p>
			<div className="max-w-md">
				<SeedPitch />
			</div>
			<Link to="/subscribe" className="btn btn-primary mt-1">
				Support Anthers
			</Link>
			{/* "watched" was wrong here on three of the four media — the allowance is one pool
			    of time spent however the viewer likes, which is the equal-time principle the
			    Hub is explicit about. A minute is a minute, whatever it is spent on. */}
			{budget.usedSeconds > 0 && (
				<p className="text-xs text-base-content/45">
					{describeRemaining(budget.usedSeconds)} of Public Access this month.
				</p>
			)}
		</div>
	);
}

/**
 * The one thing a player renders under itself.
 *
 * 🚨 **`AnonymousViewerBanner` used to be the other branch of this and is gone (2026-08-28),
 * along with the local tally it counted from.** It sat under a player a logged-out visitor
 * was watching, and invited them to make an account after half an hour. Consuming a Work now
 * requires an account, so no player renders for a signed-out visitor at all and the branch
 * became unreachable — the invitation is what stands *instead* of the player now, in
 * `InlineUnlock`, which is a better place for it than underneath something already playing.
 *
 * Reduced to one case rather than deleted outright: the players call this, it names the one
 * thing a metered viewer needs told, and a second branch will come back the day share links
 * land — at which point the recipient really is watching without an account of their own.
 */
export function PublicAccessFooter() {
	const { user } = useAuth();
	if (!user) return null;
	return <PublicAccessCountdown />;
}
