// SPDX-License-Identifier: Apache-2.0
/**
 * Whether Anthers can write the signed-in account's records, so the site can warn them before
 * they try rather than when something is refused.
 *
 * An identity Anthers can write to is mandatory, so an account whose identity is held elsewhere
 * and whose permission is declined or lost cannot create the records that permission covers: a
 * creator cannot release a Work or publish a post or a project, and anybody cannot comment,
 * review, vote or follow. `publishRefusal` and `interactionPermissionRefusal` in the API are the
 * authority, and `GET /api/atproto/publishing` is what this reads. That request is also what rechecks a grant with the creator's own server, so
 * reading it is how a permission taken back somewhere else reaches the page.
 *
 * 🚨 **A prediction, never the decision**, on the same terms as `usePayoutsReady`: `null` means
 * the answer has not arrived, and a control stays enabled until it does. Callers test
 * `=== true`, never truthiness.
 */

import { useEffect, useState } from "react";
import { apiFetch } from "./rpc";

/** What `GET /api/atproto/publishing` answers. Mirrors `PublishingState` in the API. */
export interface PublishingState {
	/** The creator tier: Works, posts and projects. */
	route: "hosted" | "granted" | "ungranted" | "none";
	/** The tier every account has: comments, reviews, votes and follows. */
	interactions: "hosted" | "granted" | "ungranted" | "none";
	offered: boolean;
	did: string | null;
	handle: string;
	listed: number;
}

/** How often a page left open asks again, which matches how often the API will recheck. */
export const PUBLISHING_RECHECK_MS = 15 * 60 * 1000;

/** How long one answer is shared by every control that asks, before the next ask goes out. */
const SHARED_FOR_MS = 60 * 1000;

let shared: { at: number; answer: Promise<PublishingState | null> } | null = null;

/**
 * One request's answer, shared by every caller within a minute of it.
 *
 * ⚠️ **Shared because a thread has a vote control per comment**, and each asking separately would
 * be a request per comment for one fact about the viewer.
 */
function readPublishingState(fresh = false): Promise<PublishingState | null> {
	const now = Date.now();
	if (!fresh && shared && now - shared.at < SHARED_FOR_MS) return shared.answer;
	const answer = apiFetch("/api/atproto/publishing")
		.then((res) => (res.ok ? (res.json() as Promise<PublishingState>) : null))
		.catch(() => null);
	shared = { at: now, answer };
	return answer;
}

/**
 * The publishing state, read on mount and, with `poll`, again every quarter hour.
 *
 * ⚠️ **Only the banner polls.** It is mounted on every signed-in page, so it is the one reader
 * that sees a tab left open for an afternoon. A control reads once, which is enough to decide
 * whether it should be offered.
 */
export function usePublishingState(opts: { enabled?: boolean; poll?: boolean } = {}) {
	const { enabled = true, poll = false } = opts;
	const [state, setState] = useState<PublishingState | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const load = (fresh: boolean) =>
			readPublishingState(fresh).then((next) => {
				if (live && next) setState(next);
			});
		load(false);
		const timer = poll ? setInterval(() => load(true), PUBLISHING_RECHECK_MS) : undefined;
		return () => {
			live = false;
			if (timer) clearInterval(timer);
		};
	}, [enabled, poll]);

	return state;
}

/**
 * Whether publishing is blocked on the permission: true or false once known, null until then.
 *
 * ⚠️ **Only while Anthers is asking for it**, exactly as the API refuses. With asking closed
 * there is nothing a creator could press, so nothing is blocked and nothing is said.
 */
export function publishingPermissionMissing(state: PublishingState | null): boolean | null {
	if (!state) return null;
	return state.route === "ungranted" && state.offered;
}

/** The one-read form, for a page with a publish control. */
export function usePublishingPermissionMissing(): boolean | null {
	return publishingPermissionMissing(usePublishingState());
}

/**
 * Whether commenting, reviewing, voting and following are blocked on the permission: true or
 * false once known, null until then.
 *
 * ⚠️ **Not tied to whether Anthers is asking creators to publish**, exactly as the API refuses:
 * the reader tier is asked for at every door, so it can always be given again.
 */
export function interactionPermissionMissing(state: PublishingState | null): boolean | null {
	if (!state) return null;
	return state.interactions === "ungranted";
}

/**
 * The one-read form, for a comment box, a review form, a vote or a follow.
 *
 * Off for a signed-out viewer, who has no permission to be missing and whose controls send them
 * to sign in instead.
 */
export function useInteractionPermissionMissing(signedIn: boolean): boolean | null {
	return interactionPermissionMissing(usePublishingState({ enabled: signedIn }));
}

/** What a disabled comment, review, vote or follow control says about why. */
export const INTERACTION_PERMISSION_HINT =
	"Give Anthers permission to write to your repository first — the banner at the top of the page has the button.";
