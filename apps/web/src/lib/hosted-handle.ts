// SPDX-License-Identifier: Apache-2.0
/**
 * Asking whether a handle Anthers could issue is still free, from a field somebody is typing
 * into.
 *
 * 🚨 **One copy, because the subtle half is the part that would be copied wrong.** Two surfaces
 * ask this question now — the signup card at `/subscribe` and the identity section in settings
 * — and the rule that makes either of them correct is that a stale answer is discarded rather
 * than displayed. A second hand-written copy of that would work in every test anybody thinks to
 * write and would be wrong on a slow connection, which is exactly how seven copies of the API
 * base URL happened.
 *
 * ⚠️ **The node is the authority over availability and nothing here decides it.** Syntax is
 * answered locally because it is knowable locally; everything else is the API's answer,
 * including "we could not tell".
 */
import { handleSyntaxProblem, normalizeHandleName } from "@anthers/shared/handles";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** What the API says about a name somebody is typing into a handle field. */
export type HandleStatus =
	| { status: "idle" }
	| { status: "checking" }
	| { status: "invalid"; problem: string }
	| { status: "taken"; handle: string }
	| { status: "available"; handle: string }
	| { status: "unknown" };

/**
 * Ask whether the name being typed is free.
 *
 * ⚠️ **Debounced, and every answer is discarded if a newer one is in flight.** Without the
 * second half a slow request about `ali` lands after a fast one about `alice` and the line
 * describes a name nobody is looking at any more — which is the worst possible thing for a
 * field whose whole job is telling you whether you may have what you typed.
 *
 * The idle state is deliberately restored the moment the field empties, rather than left
 * showing the last verdict about a name that is no longer there.
 *
 * @param raw What is in the field, however it was typed.
 * @param opts `open` is whether Anthers is issuing handles at all, and `suffix` is what they
 *   hang under — both learned from `/api/atproto/config` rather than kept as a second copy.
 */
export function useHandleAvailability(
	raw: string,
	opts: { open: boolean; suffix: string },
): HandleStatus {
	const { open, suffix } = opts;
	const [status, setStatus] = useState<HandleStatus>({ status: "idle" });

	useEffect(() => {
		const name = normalizeHandleName(raw, suffix);
		if (!open || !name) {
			setStatus({ status: "idle" });
			return;
		}

		// 🚨 **Spelling is answered here, without asking and without waiting.** An underscore is
		// wrong in a way the browser already knows, so sending it would spend a debounce plus a
		// round trip to say something immediate — and would report *"we couldn't check"* rather
		// than *"that is not allowed"* whenever the API is unreachable, which is the wrong
		// answer given locally sufficient information. Only a name that could be a handle is
		// worth asking the node about. See `@anthers/shared/handles` for why the reserved-name
		// list stays on the server and this half does not.
		const problem = handleSyntaxProblem(name);
		if (problem) {
			setStatus({ status: "invalid", problem });
			return;
		}

		let live = true;
		setStatus({ status: "checking" });
		const timer = setTimeout(() => {
			client.api.atproto["handle-available"]
				.$get({ query: { name } })
				.then((res) => res.json())
				.then((body) => {
					if (!live) return;
					setStatus(
						body.status === "invalid"
							? { status: "invalid", problem: body.problem }
							: body.status === "taken" || body.status === "available"
								? { status: body.status, handle: body.handle }
								: { status: "unknown" },
					);
				})
				.catch(() => {
					if (live) setStatus({ status: "unknown" });
				});
		}, 400);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [raw, open, suffix]);

	return status;
}

/**
 * What to say under a handle field.
 *
 * ⭐ **The available case names the whole handle rather than saying "available"**, because the
 * suffix is the part somebody has not thought about. A person types `alice` and is picking
 * `alice.anthers.social`, which is a domain name they will effectively control — telling them
 * that once, at the moment they choose it, is cheaper than explaining it later.
 *
 * ⚠️ **`unknown` says we could not check rather than nothing.** Silence there reads as
 * approval, and the one thing that must not happen is somebody believing a name is theirs
 * because a failed request left the line empty.
 */
export function handleStatusLine(status: HandleStatus): string {
	switch (status.status) {
		case "idle":
			// ⭐ **Nothing, deliberately** (Parker, 2026-09-08). This line used to name the suffix
			// and state the alphabet before anybody had typed anything. The field now shows the
			// suffix itself, and the alphabet is better said by validation at the moment it is
			// broken than as a rule to remember beforehand — which is also one less sentence
			// between somebody and the only field on the card.
			return "";
		case "checking":
			return "Checking…";
		case "invalid":
			return status.problem;
		case "taken":
			return `${status.handle} is taken.`;
		case "available":
			return `${status.handle} is yours.`;
		case "unknown":
			// ⚠️ **The tail says "when you ask for it" rather than "when you finish"**, because
			// two surfaces show this line now and only one of them is a flow with an end. What
			// both have is a button that asks the node again, and that is what the sentence
			// promises.
			return "We couldn't check that just now — we'll try again when you ask for it.";
	}
}

export function handleStatusTone(status: HandleStatus): string {
	if (status.status === "available") return "text-success";
	if (status.status === "invalid" || status.status === "taken") return "text-error";
	return "text-base-content/50";
}
