// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a brand-new account sees instead of its own empty profile.
 *
 * The signup ceremony used to end with `navigate(`/${username}`)` — dropping someone who
 * had held an account for ninety seconds onto a page about themselves, with nothing on
 * it. That is the worst available answer to *"what now?"*, and it lands at the one moment
 * a person is most willing to be told.
 *
 * 🚨 **It branches, because the arriving account is not in one state** (Parker's call,
 * 2026-08-12). Three people reach this page having been asked completely different
 * things, and one message hedged to fit all of them fits none:
 *
 *   • **supporting** — came through `/subscribe` and gave Seeds. Telling them to "set up
 *     your Seeds" is telling them to do what they just did.
 *   • **free** — came through `/subscribe` and took the free account. They have already
 *     declined once, and asking again ninety seconds later is how a funnel becomes a nag.
 *   • **cold** — came through the classic signup page and was never asked anything.
 *
 * ⚠️ **This must not become a second conversion ask.** With Anthers Gates retired, the
 * platform's only conversion event is the free-limit moment — a person converts when
 * they want something specific, not when a page asks twice. A first-run screen leading
 * with "give us $3" competes with the moment that is supposed to do that work, and does
 * it worse. The **cold** case is the one exception, and only because for them it is a
 * *first* ask rather than a second.
 */

import { FREE_TIME_POOL, SEED_PRICE } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";

const serif = { fontFamily: FONTS.fraunces };

/** Where `/subscribe` leaves what the visitor chose. Must match `PICKS_KEY` there. */
const PICKS_KEY = "anthers_subscribe_picks";

/**
 * How this account arrived.
 *
 * Read from the picks `/subscribe` left rather than from the server, and the reason is
 * timing: **the Seed count is applied by a Stripe webhook**, so an account that has just
 * paid may still read `anthersSeeds: 0` for a moment. Branching on server truth would
 * greet someone who just paid with the free-tier message — the single worst outcome
 * available here. What they *chose* is known immediately and is what the copy should
 * answer.
 */
export type Arrival =
	| { kind: "supporting"; anthers: boolean; creators: number }
	| { kind: "free"; follows: number }
	| { kind: "cold" };

/**
 * Work out which of the three states applies.
 *
 * Falls back to **cold** whenever the picks are missing or unreadable — a visitor with
 * storage disabled, a new tab, or the classic signup page. That is the right default: it
 * assumes nothing about what the person has already been asked, which is the only safe
 * assumption when we cannot tell.
 */
export function readArrival(): Arrival {
	try {
		const raw = sessionStorage.getItem(PICKS_KEY);
		if (!raw) return { kind: "cold" };
		const picks = JSON.parse(raw) as {
			anthers?: boolean | null;
			follow?: string[];
			seed?: string[];
		};
		const creators = picks.seed?.length ?? 0;
		const anthers = picks.anthers === true;
		if (anthers || creators > 0) return { kind: "supporting", anthers, creators };
		return { kind: "free", follows: picks.follow?.length ?? 0 };
	} catch {
		return { kind: "cold" };
	}
}

function Actions({
	primary,
	secondary,
}: {
	primary: [string, string];
	secondary: [string, string];
}) {
	return (
		<div className="mt-8 flex flex-col gap-3 sm:flex-row">
			<Link to={primary[1]} className="btn btn-primary">
				{primary[0]}
			</Link>
			<Link to={secondary[1]} className="btn btn-outline">
				{secondary[0]}
			</Link>
		</div>
	);
}

export default function FirstRun({ arrival, username }: { arrival: Arrival; username: string }) {
	if (arrival.kind === "supporting") {
		const backing =
			arrival.creators > 0
				? `${arrival.creators} creator${arrival.creators === 1 ? "" : "s"}`
				: null;
		return (
			<div>
				<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
					You're in, @{username}
				</p>
				<h1 style={serif} className="mt-2 text-3xl font-light leading-tight sm:text-4xl">
					Your Seeds are set up
				</h1>
				<p className="mt-3 text-base leading-relaxed text-base-content/70">
					{backing && arrival.anthers
						? `You're backing ${backing} directly, and your Seed for Anthers keeps Public Access open — with no monthly limit for you.`
						: backing
							? `You're backing ${backing} directly. Every one of those $${SEED_PRICE} Seeds reaches them with no platform cut.`
							: "Your Seed for Anthers keeps Public Access open to everyone — and there's no monthly limit on what you watch."}{" "}
					From here, the time you spend with a creator's work is what pays them.
				</p>
				{/* Deliberately no ask. They have just given; the next useful thing is to
				    use it, and the only honest suggestion is more creators to spend time
				    with — which is the thing that decides where their money actually goes. */}
				<Actions
					primary={["Find more creators", "/discover"]}
					secondary={["See your Seeds", "/subscription"]}
				/>
			</div>
		);
	}

	if (arrival.kind === "free") {
		return (
			<div>
				<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
					You're in, @{username}
				</p>
				<h1 style={serif} className="mt-2 text-3xl font-light leading-tight sm:text-4xl">
					Free, forever — starting now
				</h1>
				<p className="mt-3 text-base leading-relaxed text-base-content/70">
					You get <strong>{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month</strong>, at
					full quality, for as long as you have an account. Following is free, and so is keeping a
					library.
				</p>
				{/*
				 * 🚨 The one thing worth saying to somebody who just declined, and it is not
				 * an ask — it is the fact that makes the free tier honest. Anthers funds a
				 * Time Pool on their behalf, so their watching pays creators at $0. Leading
				 * with "upgrade" here would be the second ask in ninety seconds.
				 */}
				<p className="mt-3 text-base leading-relaxed text-base-content/70">
					And your time still pays: Anthers puts{" "}
					<strong>${FREE_TIME_POOL.toFixed(2)} a month</strong> into the Time Pool for every free
					account, split between the creators you actually spend time with.
				</p>
				<Actions
					primary={[
						arrival.follows > 0 ? "Go to your feed" : "Find creators to follow",
						arrival.follows > 0 ? "/feed" : "/discover",
					]}
					secondary={["Browse what's open to everyone", "/discover"]}
				/>
			</div>
		);
	}

	return (
		<div>
			<p className="text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
				You're in, @{username}
			</p>
			<h1 style={serif} className="mt-2 text-3xl font-light leading-tight sm:text-4xl">
				Welcome to Anthers
			</h1>
			<p className="mt-3 text-base leading-relaxed text-base-content/70">
				Anthers is a non-profit home for creators — no ads, no shareholders. Your account is free
				forever and comes with{" "}
				<strong>{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month</strong>: the work
				creators leave open to everyone.
			</p>
			{/*
			 * The one case where mentioning support is fair, because this person has never
			 * been asked. It is a link, not a pitch, and it sits below the thing they came
			 * here to do — which is find something to read or watch.
			 */}
			<p className="mt-3 text-base leading-relaxed text-base-content/70">
				When you want to go further, that's a Seed — ${SEED_PRICE} a month, pointed at Anthers or
				straight at a creator.{" "}
				<Link to="/subscribe" className="link link-primary">
					How support works
				</Link>
			</p>
			<Actions
				primary={["Find creators to follow", "/discover"]}
				secondary={["Go to your feed", "/feed"]}
			/>
		</div>
	);
}
