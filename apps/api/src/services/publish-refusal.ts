// SPDX-License-Identifier: Apache-2.0
/**
 * Whether an account may put something in front of people, or why not — the one place that is
 * asked for every way of publishing.
 *
 * 🚨 **Releasing a Work, publishing or scheduling a post and publishing a project all ask this,
 * and a condition added anywhere else is one that some of them walk past.** The routes in
 * `routes/content.ts`, `services/work-release.ts` and `jobs/publish-scheduled.ts` are its
 * callers, and none of them repeats a condition of its own about the creator.
 */

import { publishingPermissionRefusal } from "./atproto.js";
import { type PublishAct, payoutRefusalMessage, payoutStanding } from "./payouts.js";

/** A refusal to publish, ready to send. */
export interface PublishRefusal {
	status: 403 | 409;
	body: {
		error: string;
		code: "creator_required" | "publishing_permission_required" | "payouts_required";
		connected?: boolean;
	};
}

/**
 * Whether this account may publish, or the first reason it may not.
 *
 * 🚨 **Publishing anything takes a fully set-up creator, which is three things.**
 *
 * - **Creator mode**, which is checked first because the account holder can fix it in a click,
 *   and a person told to finish Stripe onboarding before they have even turned creator mode on
 *   would be sent the long way round.
 * - **A permission Anthers can write their records with** (Parker, 2026-09-12), for an identity
 *   held elsewhere. Every one of these acts writes a record into the creator's own repository,
 *   and publishing on Anthers while the record silently never goes out is the failure an
 *   identity being mandatory exists to prevent. Second because giving it is one round trip.
 *   `publishingPermissionRefusal` carries the rest.
 * - **Completed payout setup** (Parker, 2026-09-13). Every one of these can be paid for, a post
 *   and a Work through Stickers as well as the Time Pool, and it is what backs `/parents` and
 *   the Creator Terms in saying everyone who publishes is a verified adult.
 *
 * Drafting stays open, so a creator can prepare everything before any of these clears.
 */
export async function publishRefusal(
	user: { id: number; isCreator: boolean | null },
	act: PublishAct,
): Promise<PublishRefusal | null> {
	if (!user.isCreator) {
		return {
			status: 403,
			body: {
				error: `Only creators can ${act} on Anthers. Turn on creator mode in your account settings, then set up payouts.`,
				code: "creator_required",
			},
		};
	}

	const permission = await publishingPermissionRefusal(user.id, act);
	if (permission) return permission;

	const standing = await payoutStanding(user.id);
	if (standing.ready) return null;
	return {
		status: 409,
		body: {
			error: payoutRefusalMessage(standing, act),
			code: "payouts_required",
			// So the Studio can send them to the right place rather than guessing which half of
			// the problem they have.
			connected: standing.connected,
		},
	};
}
