// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Share links — the single exception to "consuming a Work requires an account", and the
 * sole writer of `share_links`.
 *
 * 🚨 **A share link conveys an ALLOWANCE and never a PERMISSION** (Parker, 2026-08-27). It
 * tells somebody where a Work is; what they may reach is still decided by their own account
 * and by `resolveAccess` as the only thing that decides it. Read *"viewing time attributes
 * to the sharer"* as a billing rule, never as an access rule.
 *
 * **Why that is coherent rather than a loophole.** Requiring an account for delivery was
 * never about identity for its own sake — it is how terms are accepted, how 13+ is asserted,
 * and above all how attention is *attributed*, because the Time Pool cannot pay a creator for
 * time it cannot attribute to anyone. A share link supplies exactly that missing piece: the
 * time belongs to the sharer, who does have an account. It supplies nothing else, and this
 * module hands out nothing else.
 *
 * ⚠️ **So "ungated work only" is enforced by construction, not by a check anybody has to
 * remember to write.** A share context resolves with a **null viewer** carrying `sharedBy`,
 * and `sharedBy` is read at exactly one line of `resolveAccessSync` — the branch where access
 * would otherwise be granted to free work. Everything above that line still runs on the
 * ordinary rules:
 *
 *   - a **gated** Work has no qualifying allowed row for a null viewer → `login_required`;
 *   - a **priced** Work → `payment_required`;
 *   - an **Adult** Work → `adult_gated`, because a share context carries no opt-in and can
 *     never be given one. That is the stronger property 40.13 asks for: Adult work is
 *     invisible to a signed-out visitor entirely, and a link is precisely the surface that
 *     would otherwise breach it, since whoever follows it has no setting to consult;
 *   - a **quarantine** or a **takedown** outranks all of it, as everywhere else.
 *
 * The same reasoning reaches a **signed-in** recipient, which is the half that is easy to get
 * wrong. A share link followed by somebody with an account does nothing at all: their own
 * `userId` is non-null, so `sharedBy` is never consulted and they resolve on their own
 * standing, drawing their own allowance. A link that granted access would bypass that
 * person's own Adult opt-in exactly as it bypasses an anonymous visitor's absent one.
 */

import { db } from "@anthers/db/client";
import { shareLinks, works } from "@anthers/db/schema";
import { requiresAdultVerification } from "@anthers/shared/content-rating";
import { and, eq, isNull } from "drizzle-orm";

/** A live share link, resolved from its token. */
export interface ResolvedShareLink {
	workId: number;
	/** Whose allowance and Time Pool slice this viewing spends. */
	sharerId: number;
	token: string;
}

/**
 * Why a Work cannot be shared.
 *
 * `not_shareable` deliberately covers gated, priced and unreleased alike, and says which in
 * a message rather than in a code — the creator's own Work page already tells them what its
 * access is, and a taxonomy here would be a second place for that to drift.
 */
export type ShareRefusal = "not_found" | "not_shareable";

/** 128 bits of URL-safe randomness. Long enough that guessing is not a strategy. */
function mintToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether this Work may have a link minted for it at all.
 *
 * ⚠️ **A convenience, and never the enforcement.** Everything here is re-decided at every
 * delivery request by the resolver, which has to be true anyway: a Work's rating and gates can
 * change long after a link is pasted somewhere, and a link minted against yesterday's state
 * must not open today's. What this buys is that a creator is told *now* rather than handing a
 * friend a link that silently does nothing.
 *
 * Adult is refused here for the additional reason that it is **invisible** rather than merely
 * locked: minting a link for one would be an admission that it exists.
 */
function shareable(work: {
	visibility: string;
	maturity: string;
	streamEnabled: boolean;
	seedAccess: { threshold: number; allow: boolean; price: string }[] | null;
	takedownStatus: string;
	quarantineStatus: string;
}): boolean {
	if (work.visibility !== "released") return false;
	if (work.takedownStatus !== "active" || work.quarantineStatus !== "none") return false;
	if (requiresAdultVerification(work.maturity)) return false;
	if (!work.streamEnabled) return false;
	// Universally free: the baseline row allowed at $0. The same shape `resolveAccessSync`
	// calls `isFree`, checked here against the rows the Work carries rather than by building a
	// context, because there is no viewer yet to build one for.
	const baseline = (work.seedAccess ?? []).find((r) => Number(r.threshold) === 0);
	return baseline?.allow === true && Number(baseline.price) <= 0;
}

/**
 * The link for this (sharer, Work), minting one the first time.
 *
 * Idempotent on purpose: re-sharing hands back the link you already gave somebody, so a URL
 * pasted into a message keeps working and revoking it means something. A revoked link is
 * **re-armed** rather than replaced, for the same reason — the person who has it is usually
 * the person you meant to un-revoke it for.
 */
export async function shareLinkFor(
	sharerId: number,
	workId: number,
): Promise<{ link: ResolvedShareLink } | { refusal: ShareRefusal }> {
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	if (!work) return { refusal: "not_found" };
	if (!shareable(work)) return { refusal: "not_shareable" };

	const [existing] = await db
		.select()
		.from(shareLinks)
		.where(and(eq(shareLinks.sharerId, sharerId), eq(shareLinks.workId, workId)))
		.limit(1);

	if (existing) {
		if (existing.revokedAt != null) {
			await db
				.update(shareLinks)
				.set({ revokedAt: null })
				.where(eq(shareLinks.id, existing.id))
				.execute();
		}
		return { link: { workId, sharerId, token: existing.token } };
	}

	const [row] = await db
		.insert(shareLinks)
		.values({ token: mintToken(), workId, sharerId })
		.returning();
	return { link: { workId, sharerId, token: row.token } };
}

/** Stop a link working, without freeing its token for anybody else. */
export async function revokeShareLink(sharerId: number, workId: number): Promise<boolean> {
	const rows = await db
		.update(shareLinks)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(shareLinks.sharerId, sharerId),
				eq(shareLinks.workId, workId),
				isNull(shareLinks.revokedAt),
			),
		)
		.returning({ id: shareLinks.id });
	return rows.length > 0;
}

/**
 * The live link a token names, or null.
 *
 * 🚨 **Returns the sharer and the Work and nothing else, which is the module's whole
 * contract.** It cannot return an access verdict because it does not have one to give:
 * whether the bytes may go out is `resolveAccessSync`'s answer, and routing a token through
 * anything that looked like an entitlement is exactly the mistake 40.13 names.
 */
export async function resolveShareToken(token: string): Promise<ResolvedShareLink | null> {
	if (!token || token.length > 64) return null;
	const [row] = await db
		.select({
			workId: shareLinks.workId,
			sharerId: shareLinks.sharerId,
			token: shareLinks.token,
		})
		.from(shareLinks)
		.where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)))
		.limit(1);
	return row ?? null;
}
