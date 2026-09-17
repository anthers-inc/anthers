// SPDX-License-Identifier: Apache-2.0
/**
 * Whether Anthers can publish the signed-in creator's records, so the site can warn them before
 * they try rather than when a release is refused.
 *
 * An identity Anthers can write to is mandatory, so a creator whose identity is held elsewhere
 * and who has declined or lost the permission cannot release a Work or publish a post or a
 * project. `publishRefusal` in the API is the authority, and `GET /api/atproto/publishing` is
 * what this reads. That request is also what rechecks a grant with the creator's own server, so
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
	route: "hosted" | "granted" | "ungranted" | "none";
	offered: boolean;
	did: string | null;
	handle: string;
	listed: number;
}

/** How often a page left open asks again, which matches how often the API will recheck. */
export const PUBLISHING_RECHECK_MS = 15 * 60 * 1000;

/**
 * The publishing state, read on mount and, with `poll`, again every quarter hour.
 *
 * ⚠️ **Only the banner polls.** It is mounted on every signed-in page, so it is the one reader
 * that sees a tab left open for an afternoon. A form reads once, which is enough to decide
 * whether its publish control should be offered.
 */
export function usePublishingState(opts: { enabled?: boolean; poll?: boolean } = {}) {
	const { enabled = true, poll = false } = opts;
	const [state, setState] = useState<PublishingState | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const load = () =>
			apiFetch("/api/atproto/publishing")
				.then((res) => (res.ok ? (res.json() as Promise<PublishingState>) : null))
				.then((next) => {
					if (live && next) setState(next);
				})
				.catch(() => {});
		load();
		const timer = poll ? setInterval(load, PUBLISHING_RECHECK_MS) : undefined;
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
