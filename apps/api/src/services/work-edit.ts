// SPDX-License-Identifier: Apache-2.0
/**
 * Editing a Work's public listing fields — the fields its network record carries.
 *
 * 🚨 **One service, two doors, and the extraction is the point.** A Work's title and
 * description are written by its creator (`routes/content.ts` PATCH `/works/:id`, whose
 * route carries the release gates a listing edit does not need) and, as of this module, by
 * an operator correcting drift or cleaning up after a takedown (`routes/admin.ts`). Both
 * doors call `editWorkListing`, so there is exactly one writer of these two fields, the
 * record follows the row through the same enqueue in both cases, and an operator correction
 * cannot silently diverge from what a creator's edit of the same fields would do.
 *
 * 🚨 **The creator-ownership line is deliberate and narrow.** An operator edits what the
 * Work SAYS to the public — the listing — and nothing the Work IS: not the body, not the
 * file, not the gate, not the rating (which `content-rating.ts` owns, with its appeal path).
 * Parker's ruling settling this task: an operator may correct listing fields for cleanup and
 * takedown-adjacent fixes, with every change logged and the creator told.
 *
 * ⚠️ **A quarantined Work is not editable here either**, matching the creator route's 404 —
 * material under a preservation hold is not renamed by anybody, and the same silence about
 * why applies.
 */
import { db } from "@anthers/db";
import { moderationActions, works } from "@anthers/db/schema";
import type { ModerationActionType } from "@anthers/shared/moderation";
import { eq } from "drizzle-orm";
import { queueWorkListingSync } from "./work-listing.js";

/** The full works row, as every service that reads one whole types it. */
type WorkRow = typeof works.$inferSelect;

/** The listing fields an operator may correct, and their bounds (mirroring the creator schema). */
export interface WorkListingEdit {
	title?: string;
	description?: string;
}

/** The result of an operator listing edit. */
export type WorkListingEditResult =
	| { status: "edited"; work: WorkRow; changed: (keyof WorkListingEdit)[] }
	| { status: "no_work" }
	| { status: "quarantined" }
	| { status: "no_change" };

/** How long a recorded note may be — the same cap a moderation action note carries. */
const NOTE_MAX = 1000;

export const LISTING_EDIT_ACTION: ModerationActionType = "listing_corrected";

/**
 * Correct a Work's listing fields as an operator, record the correction, and ask for the
 * record to follow.
 *
 * The write, the log row and the enqueue are one sequence rather than three options: an
 * edit with no log is the correction that cannot be appealed, and an edit with no enqueue is
 * the drift this module exists to correct — the row and the record would part ways at the
 * moment of the fix.
 *
 * ⚠️ **Blank-means-absent is the creator route's own convention**, carried here unchanged:
 * title defaults to `""` in the schema, so an edit to `""` is an edit to untitled — refused,
 * because an untitled listing is worse than no listing and the mapper refuses one anyway. An
 * edit to the value already stored reports `no_change` and writes nothing, so a retry after
 * an unclear client response is harmless.
 */
export async function editWorkListing(input: {
	workId: number;
	/** The admin account acting — the audit trail's actor. */
	adminId: number;
	/** A free-text note: why the listing was corrected. */
	note?: string;
	edits: WorkListingEdit;
}): Promise<WorkListingEditResult> {
	const [work] = await db.select().from(works).where(eq(works.id, input.workId)).limit(1);
	if (!work) return { status: "no_work" };
	if (work.quarantineStatus === "quarantined") return { status: "quarantined" };

	// Only fields that were sent AND differ are corrections; the rest are not written at all,
	// so `updatedAt` does not move for a request that changed nothing.
	const updates: Partial<typeof works.$inferInsert> = {};
	const changed: (keyof WorkListingEdit)[] = [];
	if (input.edits.title !== undefined && input.edits.title !== work.title) {
		if (!input.edits.title.trim()) return { status: "no_change" };
		updates.title = input.edits.title;
		changed.push("title");
	}
	if (input.edits.description !== undefined && input.edits.description !== work.description) {
		updates.description = input.edits.description;
		changed.push("description");
	}
	if (changed.length === 0) return { status: "no_change" };

	const now = new Date();
	updates.updatedAt = now;

	const [updated] = await db
		.update(works)
		.set(updates)
		.where(eq(works.id, input.workId))
		.returning();

	// The record follows the row — the same enqueue the creator's edit fires, for the same
	// reason the creator route's comment gives: working out which edits matter to the listing
	// is exactly the reasoning the re-read-and-decide job exists to make unnecessary.
	await queueWorkListingSync(input.workId);

	// The audit trail: what changed, from what, to what, by whom. Appended, never edited.
	const before_after: Record<string, { from: string | null; to: string | null }> = {};
	for (const field of changed) {
		before_after[field] = {
			from: (work[field] as string | null) ?? null,
			to: (updated[field] as string | null) ?? null,
		};
	}
	await db.insert(moderationActions).values({
		subjectType: "work",
		subjectId: input.workId,
		action: LISTING_EDIT_ACTION,
		adminActorId: input.adminId,
		reason: "",
		note: `${
			(input.note ?? "").trim().slice(0, NOTE_MAX) ||
			`listing fields corrected: ${changed.join(", ")}`
		} | ${JSON.stringify(before_after)}`,
	});

	return { status: "edited", work: updated, changed };
}

/**
 * Tell the creator their Work's listing was corrected.
 *
 * 🚨 **This is what makes the correction legitimate rather than merely permitted** — the same
 * reasoning `correctRating`'s notification carries. A listing changed without the creator
 * knowing is one they cannot recognize, contest or fix forward; one they are told about is a
 * decision they can act on. It rides the `essential` category because it is a decision about
 * their work, not activity around it.
 *
 * Separate from the edit itself so the door that must not fail (the correction lands) and the
 * door that may (the mail blinks) stay distinct — the edit is the record of what happened;
 * this is the telling.
 */
export async function notifyListingCorrected(
	work: WorkRow,
	edit: { changed: (keyof WorkListingEdit)[]; note?: string },
): Promise<void> {
	if (work.creatorId == null) return;
	const { notify } = await import("./notifications.js");
	const fields = edit.changed.map((f) => (f === "title" ? "title" : "description")).join(" and ");
	// Per correction, not per Work — the same choice the rating correction makes: a second
	// correction months later is news again, so the key is this edit's moment, and a retry
	// of the same edit (same logged action, same timestamp) collapses.
	await notify({
		userId: work.creatorId,
		category: "essential",
		kind: "listing_corrected",
		dedupeKey: `listing-corrected:${work.id}:${work.updatedAt?.toISOString()}`,
		title: `“${work.title ?? "Your Work"}” — an operator corrected its ${fields}`,
		body:
			`An operator changed this Work's ${fields}. ` +
			(edit.note?.trim() ? `They noted: ${edit.note.trim()} ` : "") +
			"You can appeal this by reaching out to Anthers if you believe it was a mistake.",
	});
}
