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
 *
 * Alongside the accept/reject flow, this module owns the **user overlay** (`creditsForUser`)
 * and the credit-offered notification (`notifyCreditedAccounts`) — the two halves of showing
 * credits to people who were not in the room when they were written. The routes call both and
 * decide nothing.
 */
import { db } from "@anthers/db/client";
import {
	creditAcceptances,
	creditRejections,
	users,
	type WorkCredit,
	works,
} from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
	CREDIT_ACCEPTANCE_COLLECTION,
	CREDIT_ACCEPTANCE_KIND,
	carryOutPlan,
	planRecord,
} from "./atproto-record-plan.js";
/**
 * Whether a credit's contributor string names an on-network identity.
 *
 * The one DID-parse lives in `atproto-records.ts`; this module asks it rather than
 * re-deriving the rule about what counts as a DID.
 */
import { creditContributorIsDid } from "./atproto-records.js";
import { isBlocked } from "./blocks.js";
import { notify } from "./notifications.js";
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

// ─── The user overlay ───────────────────────────────────────────────────────

/**
 * One credit as a given user may see it.
 *
 * The two flag fields are emitted by the overlay below and exist nowhere in storage:
 *
 * - `awaitingYourConfirmation` — the user IS the credited person and has not accepted yet.
 *   The front-end renders Accept/Decline controls from it. Only the named person's own
 *   serialization carries it, and the credit ships with its role and types intact because
 *   those are what they need to act.
 * - `awaitingContributorConfirmation` — the user is the Work's creator, looking at a
 *   credit that names somebody else and is not accepted yet. Only an owner-facing
 *   serialization carries it.
 *
 * A `did:` string never survives into `contributor` on any serialization a stranger can
 * read: an accepted credit resolves to the account's name (display name or handle), and
 * an unaccepted one is withheld from everyone but the two parties above.
 */
export type UserWorkCredit = WorkCredit & {
	awaitingYourConfirmation?: true;
	awaitingContributorConfirmation?: true;
};

/** A Work as the overlay needs it — enough to decide, with no row-shaped dependency. */
interface OverlayWork {
	id: number;
	creatorId: number | null;
	slug: string;
	publicId: number;
	title: string | null;
	credits: WorkCredit[] | null;
}

/**
 * The credits a given user should see on a Work.
 *
 * The published record already withholds an unaccepted `did`-naming credit (see
 * `creditToRecord`); this is the same rule on the API's own serialization, so a credit a
 * person has not confirmed does not render to strangers as fact. Three answers:
 *
 * - **Non-DID credits pass through untouched**, whatever the user.
 * - **An accepted DID credit ships resolved** — `contributor` becomes the account's display
 *   name or handle, never a bare `did:` string. Acceptance requires a signed-in account
 *   whose identity IS the credited DID, so a `users` row always resolves; if one is ever
 *   missing the credit is withheld rather than named, the same safe direction the record
 *   fails in.
 * - **An unaccepted DID credit is withheld** from everyone except the named person (who
 *   sees it flagged `awaitingYourConfirmation`) and the Work's creator (who sees everything,
 *   flagged `awaitingContributorConfirmation`).
 *
 * ⚠️ **Only queries when a Work's credits actually contain a DID string**, so the common
 * case — no credits, or none naming an identity — pays nothing.
 *
 * Like the rest of this module, it trusts its caller for who the user is: `userId` is
 * the signed-in account's id or null for a signed-out user.
 */
export async function creditsForUser(
	work: OverlayWork,
	userId: number | null,
): Promise<UserWorkCredit[]> {
	const credits = work.credits ?? [];
	// The one DID-parse is `creditContributorIsDid`; nothing here re-derives it.
	if (!credits.some((c) => creditContributorIsDid(c.contributor))) return credits;

	const didCredits = credits.filter((c) => creditContributorIsDid(c.contributor));
	const dids = [...new Set(didCredits.map((c) => c.contributor))];

	// One read each for the acceptances and the accounts behind the DIDs, batched over the
	// whole credits array — a Work naming five identities still pays two queries.
	const [acceptedRows, accountRows, userRows] = await Promise.all([
		db
			.select({ contributorDid: creditAcceptances.contributorDid, role: creditAcceptances.role })
			.from(creditAcceptances)
			.where(
				and(eq(creditAcceptances.workId, work.id), inArray(creditAcceptances.contributorDid, dids)),
			),
		db
			.select({
				atprotoDid: users.atprotoDid,
				displayName: users.displayName,
				handle: users.atprotoHandle,
			})
			.from(users)
			.where(inArray(users.atprotoDid, dids)),
		// The named-person exception needs the user's own DID. A second users read rather
		// than a parameter, because the call sites hold a user id and nothing else.
		userId != null
			? db.select({ atprotoDid: users.atprotoDid }).from(users).where(eq(users.id, userId)).limit(1)
			: Promise.resolve([] as { atprotoDid: string }[]),
	]);
	const accepted = new Set(acceptedRows.map((r) => `${r.contributorDid}|${r.role}`));
	const nameForDid = new Map(
		accountRows.map((r) => [r.atprotoDid, r.displayName?.trim() || r.handle]),
	);
	const userDid = userRows[0]?.atprotoDid ?? null;
	const isCreator = userId != null && userId === work.creatorId;

	const visible: UserWorkCredit[] = [];
	for (const credit of credits) {
		if (!creditContributorIsDid(credit.contributor)) {
			visible.push(credit);
			continue;
		}
		if (accepted.has(`${credit.contributor}|${credit.role}`)) {
			const name = nameForDid.get(credit.contributor);
			// An acceptance implies a users row (acceptance is a signed-in account acting on
			// its own DID), so a miss is the invariant broken. Withheld rather than named: a
			// bare `did:` string in public copy is exactly what this overlay exists to prevent.
			if (name) visible.push({ ...credit, contributor: name });
			else if (isCreator || userDid === credit.contributor) visible.push(credit);
			continue;
		}
		if (userDid === credit.contributor) {
			visible.push({ ...credit, awaitingYourConfirmation: true });
			continue;
		}
		if (isCreator) {
			visible.push({ ...credit, awaitingContributorConfirmation: true });
		}
		// Everybody else — signed-out and third-party users alike — does not see the
		// credit at all: an unconfirmed claim about a third party is not a liner note.
	}
	return visible;
}

/**
 * The credits for an owner-facing serialization — the Studio load and the create/PATCH
 * responses. The creator sees everything they wrote, exactly as it is stored, with the
 * contributor's own confirmation state as a flag.
 *
 * 🚨 **The raw stored contributor, never a resolved name.** The Studio edit form loads
 * `credits` from this shape and sends `contributor` back verbatim on every save, so an
 * owner shape that substitutes a rendered name for the stored identity is a
 * data-destroying save, not a nicer read: the acceptance row keys on the DID, and the
 * stored DID replaced by a display name would stop matching it — the published record
 * would then withhold a credit the person had accepted, and an unrelated title edit
 * would be what destroyed the linkage. Resolution-to-name is the USER overlay's job
 * (`creditsForUser`), because the public Work page only renders.
 *
 * The flags carry the only thing an owner cannot see from the raw rows alone: which
 * identity credits are still awaiting their contributor's word.
 */
export async function creditsForOwner(work: OverlayWork): Promise<UserWorkCredit[]> {
	const credits = work.credits ?? [];
	if (!credits.some((c) => creditContributorIsDid(c.contributor))) return credits;

	const didCredits = credits.filter((c) => creditContributorIsDid(c.contributor));
	const dids = [...new Set(didCredits.map((c) => c.contributor))];
	const [acceptedRows, rejectedRows] = await Promise.all([
		db
			.select({ contributorDid: creditAcceptances.contributorDid, role: creditAcceptances.role })
			.from(creditAcceptances)
			.where(
				and(eq(creditAcceptances.workId, work.id), inArray(creditAcceptances.contributorDid, dids)),
			),
		db
			.select({ contributorDid: creditRejections.contributorDid, role: creditRejections.role })
			.from(creditRejections)
			.where(
				and(eq(creditRejections.workId, work.id), inArray(creditRejections.contributorDid, dids)),
			),
	]);
	const decided = new Set(
		[...acceptedRows, ...rejectedRows].map((r) => `${r.contributorDid}|${r.role}`),
	);

	// Pass-through-plus-flags: every credit ships with its stored contributor untouched.
	// A rejected credit is absent from `works.credits` (the reject flow removed it), so the
	// rejection read above is belt-and-braces — it keeps a hand-edited row from reporting
	// itself as merely pending.
	return credits.map((credit) =>
		creditContributorIsDid(credit.contributor) &&
		!decided.has(`${credit.contributor}|${credit.role}`)
			? { ...credit, awaitingContributorConfirmation: true }
			: credit,
	);
}

// ─── Telling the credited person ──────────────────────────────────────────────

/**
 * Notify every on-network person a Work's credits newly name.
 *
 * Called by whatever makes the credit PUBLIC — the PATCH route when it releases the Work
 * or changes credits on an already-released one, and the scheduled-release sweep for the
 * releases nobody attends. A Work is born private and the accept route refuses with
 * `no_listing` until its record exists, so notifying on a draft would link the
 * contributor to a page that 404s and an Accept control that refuses; the notification
 * is owed when the Work can actually be seen and acted on. A credit that names a `did`
 * is a claim about a third party, and the person it names is owed the chance to see it:
 * without this they have no way to discover the credit exists.
 *
 * Skips, in order, everything that must not produce a notification:
 *
 * - an off-platform DID — no `users` row means no account to notify and no Accept control;
 * - the creator's own DID — they wrote it; it is not news to them;
 * - a credit with an acceptance or rejection row already — accepted means told (acceptance
 *   follows the notification) and rejected means the credit cannot stand anyway;
 * - a blocked pair, either direction — a notification is a place two users meet (see
 *   `services/notifications.ts`), so this runs the same block check a comment thread does.
 *
 * The `dedupeKey` is the whole re-save guarantee: `credit-offered:{workId}:{did}:{role}` is
 * stable across saves, so a creator re-saving the Work over and over notifies nobody twice.
 */
export async function notifyCreditedAccounts(
	work: OverlayWork,
	creatorUserId: number,
): Promise<void> {
	const didCredits = (work.credits ?? []).filter((c) => creditContributorIsDid(c.contributor));
	if (didCredits.length === 0) return;

	const dids = [...new Set(didCredits.map((c) => c.contributor))];
	const [accountRows, acceptedRows, rejectedRows] = await Promise.all([
		db
			.select({ id: users.id, atprotoDid: users.atprotoDid })
			.from(users)
			.where(inArray(users.atprotoDid, dids)),
		db
			.select({ contributorDid: creditAcceptances.contributorDid, role: creditAcceptances.role })
			.from(creditAcceptances)
			.where(
				and(eq(creditAcceptances.workId, work.id), inArray(creditAcceptances.contributorDid, dids)),
			),
		db
			.select({ contributorDid: creditRejections.contributorDid, role: creditRejections.role })
			.from(creditRejections)
			.where(
				and(eq(creditRejections.workId, work.id), inArray(creditRejections.contributorDid, dids)),
			),
	]);
	// The creator's own DID is skipped by comparing ids, not DIDs, so a NULL or odd DID on the
	// creator's row cannot make a self-credit look like somebody else's.
	const creatorAccount = accountRows.find((a) => a.id === creatorUserId);
	const decided = new Set(
		[...acceptedRows, ...rejectedRows].map((r) => `${r.contributorDid}|${r.role}`),
	);
	const accounts = new Map(accountRows.map((a) => [a.atprotoDid, a.id]));

	for (const credit of didCredits) {
		if (decided.has(`${credit.contributor}|${credit.role}`)) continue;
		const accountId = accounts.get(credit.contributor);
		if (accountId == null) continue;
		if (creatorAccount && creatorAccount.atprotoDid === credit.contributor) continue;
		if (await isBlocked(creatorUserId, accountId)) continue;

		const title = (work.title?.trim() || "An untitled Work") as string;
		// `notify`'s insert conflict is the idempotency guarantee; the awaits are so a save
		// cannot outlive its notifications, and so a test can read the row back.
		await notify({
			userId: accountId,
			category: "activity",
			kind: "credit_offered",
			title: `You're credited on “${title}”`,
			body: `A creator credited you as ${credit.role} on “${title}”. You can accept or decline the credit on the Work's page.`,
			// Same shape as `workUrl` in `@anthers/web-shared/postUrl` — the app-relative
			// canonical page, which is where the Accept/Decline controls live.
			linkPath: `/works/${work.slug}-${work.publicId}`,
			dedupeKey: `credit-offered:${work.id}:${credit.contributor}:${credit.role}`,
		});
	}
}
