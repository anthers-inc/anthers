// SPDX-License-Identifier: Apache-2.0
/**
 * Whether a Work's media may be changed or removed at all.
 *
 * Three states stop the bytes being touched, for three different reasons. A **quarantine**
 * takes the material out of reach and places a § 2258A(h) hold. A **takedown** stops
 * delivering infringing bytes but keeps them as evidence. A **preservation hold** is the
 * operator's own promise that a subject will not be destroyed while a matter is open.
 *
 * A creator-facing delete route that honors only the quarantine lets the other two be
 * emptied from underneath — the held object is gone, the hold row remains, and nothing
 * reads as wrong. So every route that deletes, replaces or cancels a Work's stored media
 * asks this first.
 */
import { isUnderHold } from "./legal-hold.js";

export interface MutableWork {
	id: number;
	quarantineStatus?: string | null;
	takedownStatus?: string | null;
}

export type MediaMutationRefusal =
	| { status: 404; body: { error: string } }
	| { status: 409; body: { error: string; code: string } };

/** The refusal to answer a media mutation with, or null when the media may be changed. */
export async function mediaMutabilityRefusal(
	work: MutableWork,
	options: { allowPreserved?: boolean } = {},
): Promise<MediaMutationRefusal | null> {
	if (work.quarantineStatus === "quarantined" || work.takedownStatus === "taken_down") {
		return { status: 404, body: { error: "Work not found" } };
	}
	if (options.allowPreserved !== true && (await isUnderHold("work", work.id))) {
		return {
			status: 409,
			body: {
				error: "This Work is under a preservation hold; its media cannot be changed.",
				code: "media_held",
			},
		};
	}
	return null;
}
