// SPDX-License-Identifier: Apache-2.0
/**
 * Accepting or rejecting credit for a Work.
 *
 * A `did`-naming credit on a Work is a public claim about a third party, so it is withheld from
 * the published Work record until that third party accepts. Acceptance writes an
 * `org.anthers.creditAcceptance` record in the CONTRIBUTOR's own repository — it is the
 * contributor saying "yes, I did this." Rejection is private: it removes the credit from the
 * Work and records the refusal so the same claim cannot be re-added.
 *
 * ⚠️ This module intentionally does not decide whether the caller is the contributor. The
 * route layer checks that; this layer trusts its caller to supply the right user id.
 */
import { db } from "@anthers/db/client";
import { creditAcceptances, creditRejections, type WorkCredit, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
	CREDIT_ACCEPTANCE_COLLECTION,
	CREDIT_ACCEPTANCE_KIND,
	carryOutPlan,
	planRecord,
} from "./atproto-record-plan.js";
import { writerForAccount } from "./repo-writer.js";
import { queueWorkListingSync } from "./work-listing.js";

/** What happened when a contributor accepted credit. */
export type AcceptCreditResult =
	| { ok: true; atprotoUri: string | null }
	| {
			ok: false;
			code: "not_credited" | "already_accepted" | "rejected" | "no_identity" | "not_granted";
	  };

/** What happened when a contributor rejected credit. */
export type RejectCreditResult =
	| { ok: true }
	| { ok: false; code: "not_credited" | "already_rejected" };

/**
 * Find the credit on a Work whose contributor matches the given DID.
 *
 * Returns the matching row and its index, or null when no such credit exists. The index is used
 * by rejection to remove the credit in place without re-serializing the whole array.
 */
function findDidCredit(
	credits: WorkCredit[] | null,
	contributorDid: string,
	role: string,
): { credit: WorkCredit; index: number } | null {
	if (!credits) return null;
	const index = credits.findIndex((c) => c.contributor === contributorDid && c.role === role);
	if (index === -1) return null;
	return { credit: credits[index], index };
}

/**
 * Accept credit for a Work.
 *
 * The caller is the contributor. The acceptance is written as a record into the caller's own
 * repository, not the Work author's. While the collection is unpublished, no network write
 * happens and the local `credit_acceptances` row becomes the signal that the credit may be
 * published once the Lexicon goes live.
 */
export async function acceptCredit(opts: {
	callerUserId: number;
	callerDid: string;
	workId: number;
	workUri: string;
	role: string;
}): Promise<AcceptCreditResult> {
	const [work] = await db
		.select({ credits: works.credits })
		.from(works)
		.where(eq(works.id, opts.workId))
		.limit(1);
	if (!work) return { ok: false, code: "not_credited" };

	const match = findDidCredit(work.credits, opts.callerDid, opts.role);
	if (!match) return { ok: false, code: "not_credited" };

	const [rejected] = await db
		.select({ id: creditRejections.id })
		.from(creditRejections)
		.where(
			and(
				eq(creditRejections.workId, opts.workId),
				eq(creditRejections.contributorDid, opts.callerDid),
				eq(creditRejections.role, opts.role),
			),
		)
		.limit(1);
	if (rejected) return { ok: false, code: "rejected" };

	const [alreadyAccepted] = await db
		.select({ id: creditAcceptances.id })
		.from(creditAcceptances)
		.where(
			and(
				eq(creditAcceptances.workId, opts.workId),
				eq(creditAcceptances.contributorDid, opts.callerDid),
				eq(creditAcceptances.role, opts.role),
			),
		)
		.limit(1);
	if (alreadyAccepted) return { ok: false, code: "already_accepted" };

	const acceptedAt = new Date();

	// Upsert the local acceptance row. The unique index on (workId, contributorDid, role)
	// makes a second accept a no-op at this layer.
	await db
		.insert(creditAcceptances)
		.values({
			workId: opts.workId,
			contributorDid: opts.callerDid,
			role: opts.role,
			acceptedAt,
		})
		.onConflictDoUpdate({
			target: [creditAcceptances.workId, creditAcceptances.contributorDid, creditAcceptances.role],
			set: { acceptedAt },
		});

	// Attempt the record write. While the collection is unpublished this yields a `none`
	// plan and no network traffic; the row above still records the acceptance.
	const opened = await writerForAccount(opts.callerUserId, {
		collections: [CREDIT_ACCEPTANCE_COLLECTION],
	});
	if (!opened.writer) {
		// Hosted identities always get a writer; this branch matters for OAuth identities that
		// have not granted the credit-confirmation collection.
		return { ok: false, code: opened.reason === "no_identity" ? "no_identity" : "not_granted" };
	}

	const outcome = await carryOutPlan(
		opened.writer,
		CREDIT_ACCEPTANCE_COLLECTION,
		planRecord(
			CREDIT_ACCEPTANCE_KIND,
			{ workUri: opts.workUri, role: opts.role, acceptedAt },
			null,
		),
		null,
	);

	// Store the record address when one was created or replaced. With the Lexicon unpublished
	// this stays null, which is the expected inert state.
	if (outcome.uri) {
		await db
			.update(creditAcceptances)
			.set({ atprotoUri: outcome.uri })
			.where(
				and(
					eq(creditAcceptances.workId, opts.workId),
					eq(creditAcceptances.contributorDid, opts.callerDid),
					eq(creditAcceptances.role, opts.role),
				),
			);
	}

	// Re-queue the Work listing so the newly accepted credit is included in the next sync.
	await queueWorkListingSync(opts.workId);

	return { ok: true, atprotoUri: outcome.uri };
}

/**
 * Reject credit for a Work.
 *
 * Rejection is private: it removes the credit from the Work's credits column and writes a
 * `credit_rejections` row so the same claim cannot be re-added.
 */
export async function rejectCredit(opts: {
	callerUserId: number;
	callerDid: string;
	workId: number;
	role: string;
}): Promise<RejectCreditResult> {
	void opts.callerUserId;

	const [work] = await db
		.select({ credits: works.credits })
		.from(works)
		.where(eq(works.id, opts.workId))
		.limit(1);
	if (!work) return { ok: false, code: "not_credited" };

	const match = findDidCredit(work.credits, opts.callerDid, opts.role);
	if (!match) return { ok: false, code: "not_credited" };

	const [alreadyRejected] = await db
		.select({ id: creditRejections.id })
		.from(creditRejections)
		.where(
			and(
				eq(creditRejections.workId, opts.workId),
				eq(creditRejections.contributorDid, opts.callerDid),
				eq(creditRejections.role, opts.role),
			),
		)
		.limit(1);
	if (alreadyRejected) return { ok: false, code: "already_rejected" };

	const remaining = (work.credits ?? []).filter((_, i) => i !== match.index);

	await db.transaction(async (tx) => {
		await tx.update(works).set({ credits: remaining }).where(eq(works.id, opts.workId));
		await tx.insert(creditRejections).values({
			workId: opts.workId,
			contributorDid: opts.callerDid,
			role: opts.role,
		});
	});

	await queueWorkListingSync(opts.workId);

	return { ok: true };
}

/**
 * Whether a credit the creator is trying to add has been rejected.
 *
 * Checked by the Work create and PATCH routes so a rejected DID/role pair cannot be re-added.
 */
export async function isCreditRejected(
	workId: number,
	contributorDid: string,
	role: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: creditRejections.id })
		.from(creditRejections)
		.where(
			and(
				eq(creditRejections.workId, workId),
				eq(creditRejections.contributorDid, contributorDid),
				eq(creditRejections.role, role),
			),
		)
		.limit(1);
	return Boolean(row);
}

/**
 * Refuse a credit list that contains a rejected DID credit.
 *
 * Returns the offending (contributorDid, role) pair, or null when the list is clean. This is
 * the shared helper used by both create and PATCH.
 */
export async function findRejectedCredit(
	workId: number,
	credits: WorkCredit[] | null,
): Promise<{ contributorDid: string; role: string } | null> {
	if (!credits) return null;
	const didCredits = credits.filter((c) => c.contributor.startsWith("did:"));
	if (didCredits.length === 0) return null;

	const rows = await db
		.select({ contributorDid: creditRejections.contributorDid, role: creditRejections.role })
		.from(creditRejections)
		.where(
			and(
				eq(creditRejections.workId, workId),
				inArray(
					creditRejections.contributorDid,
					didCredits.map((c) => c.contributor),
				),
			),
		);
	const rejected = new Set(rows.map((r) => `${r.contributorDid}|${r.role}`));
	for (const credit of didCredits) {
		if (rejected.has(`${credit.contributor}|${credit.role}`)) {
			return { contributorDid: credit.contributor, role: credit.role };
		}
	}
	return null;
}
