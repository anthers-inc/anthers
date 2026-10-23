// SPDX-License-Identifier: Apache-2.0
/**
 * The one question `checkUserAccess` exists to answer: may this reader read this creator's
 * gated space?
 *
 * The answer is the product's existing one. `resolveAccess` decides what a user may consume —
 * ownership, the adult gate, a purchase, the free rung — and this module maps the network's
 * question onto that resolver rather than inventing a second gate. What is genuinely new here
 * is the mapping from a space to a Work, and nothing else.
 *
 * ⭐ **The mapping is the `skey`, by design.** A creator's space type is
 * `org.anthers.creatorSpace` and its key is the Work's durable `publicId`, so a renamed Work
 * keeps its space and a repriced one keeps its URIs. The space's authority DID must be the
 * Work's creator; a space naming one creator's DID about another creator's Work is not a
 * gate to answer, it is a request to read somebody else's manifest.
 *
 * 🚨 **A private Work is reachable only by its owner.** `resolveAccess` answers about
 * consumption, not about publication — a private Work with an open access row would resolve
 * as reachable, which is right for a route that has already established the Work is listed
 * and wrong for a space that exists before the listing does. So the visibility check sits
 * above the resolver, and stops short of the owner.
 */
import { db } from "@anthers/db/client";
import { users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { type AccessibleWork, resolveAccess } from "./access.js";

/** The creator-space type whose keys are Work public ids. */
export const CREATOR_SPACE_TYPE = "org.anthers.creatorSpace";

/** Why the gate answered the way it did. Reported to logs, never to the caller. */
export type SpaceAccessReason =
	| "owner"
	| "entitled"
	| "not-entitled"
	| "unreleased"
	| "unknown-user"
	| "unknown-space"
	| "not-the-authority"
	| "not-a-creator-space"
	| "unsupported-access";

export interface SpaceAccessDecision {
	authorized: boolean;
	reason: SpaceAccessReason;
}

/** A parsed creator-space reference: the owner DID and the Work's public id. */
export interface CreatorSpaceRef {
	authority: string;
	publicId: number;
}

/**
 * Parse `at://<creator-did>/space/org.anthers.creatorSpace/<publicId>`.
 *
 * The `at://` scheme has no URL parser that treats a DID as an authority, so this splits the
 * segments itself and refuses anything else. The `space` segment is part of the protocol's
 * space reference, not decoration: it is what separates a space from an ordinary collection.
 * A `skey` that is not a positive integer is not one of our spaces; it is not coerced into one.
 */
export function parseCreatorSpace(space: string): CreatorSpaceRef | null {
	if (!space.startsWith("at://")) return null;
	const rest = space.slice("at://".length);
	const [authority, kind, type, key, ...extra] = rest.split("/");
	if (!authority || !kind || !type || !key || extra.length > 0) return null;
	if (kind !== "space") return null;
	if (type !== CREATOR_SPACE_TYPE) return null;
	if (!/^[1-9]\d*$/.test(key)) return null;
	const publicId = Number(key);
	if (!Number.isSafeInteger(publicId)) return null;
	return { authority, publicId };
}

/**
 * Decide one access question against the database.
 *
 * The caller has already verified that `authority` signed a service-auth token for this
 * method; this reads that claim together with the space reference, so a valid signature about
 * a space the signer does not own resolves to a refusal rather than to somebody else's Work.
 */
export async function authorizeSpaceAccess(query: {
	space: string;
	authority: string;
	userDid: string;
	access: string;
}): Promise<SpaceAccessDecision> {
	if (query.access !== "read" && query.access !== "write") {
		return { authorized: false, reason: "unsupported-access" };
	}

	const ref = parseCreatorSpace(query.space);
	if (!ref) return { authorized: false, reason: "not-a-creator-space" };
	if (ref.authority !== query.authority) {
		return { authorized: false, reason: "not-the-authority" };
	}

	const [reader] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoDid, query.userDid))
		.limit(1);
	// An identity with no Anthers account has nothing to resolve access against. It could
	// still be the creator, which is why the owner checks below use the Work's own row.
	if (!reader) return { authorized: false, reason: "unknown-user" };

	const [work] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			visibility: works.visibility,
			streamEnabled: works.streamEnabled,
			downloadEnabled: works.downloadEnabled,
			access: works.access,
			takedownStatus: works.takedownStatus,
			maturity: works.maturity,
			quarantineStatus: works.quarantineStatus,
			type: works.type,
			creatorDid: users.atprotoDid,
		})
		.from(works)
		.innerJoin(users, eq(users.id, works.creatorId))
		.where(eq(works.publicId, ref.publicId))
		.limit(1);
	if (!work) return { authorized: false, reason: "unknown-space" };
	if (work.creatorDid !== ref.authority) {
		// The space belongs to the Work's creator. A space owned by anyone else is not this
		// Work's gated copy, whatever it is named.
		return { authorized: false, reason: "unknown-space" };
	}

	if (work.creatorId === reader.id) return { authorized: true, reason: "owner" };

	// The creator's own writes to their space are protected by repo ownership rather than by
	// this gate; nobody else may write into it.
	if (query.access === "write") return { authorized: false, reason: "not-entitled" };

	if (work.visibility === "private") return { authorized: false, reason: "unreleased" };

	const access = await resolveAccess(work as AccessibleWork, reader.id);
	return access.canAccess
		? { authorized: true, reason: "entitled" }
		: { authorized: false, reason: "not-entitled" };
}
