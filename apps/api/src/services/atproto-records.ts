// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a Work onto its public `org.anthers.work` record.
 *
 * This is a pure function and writes nothing. It exists ahead of any dual-write because it
 * is the thing that proves the Lexicon can actually describe our data — a schema nobody has
 * mapped real rows onto is a guess, and a published Lexicon is a public API commitment that
 * is expensive to correct.
 *
 * 🚨 **The record is the LISTING, never the deliverable.** A repository is world-readable,
 * so anything a gate protects must not appear here: no `body`/`bodyHtml`, no `lyrics`, no
 * `sourceKey`, no signed URLs. That is not a policy applied afterwards — it is why the
 * Lexicon has no field capable of carrying them.
 */
import { type AccessibleWork, buildPreviewContext, resolveAccessSync } from "./access.js";

/** The Work columns a public listing is derived from. Deliberately narrow. */
export interface PublishableWork extends AccessibleWork {
	type: string;
	title: string | null;
	description: string | null;
	slug: string;
	publicId: number;
	releasedAt: Date | null;
	/** The upload date, used only as a fallback release date — see `releaseDateOf`. */
	createdAt: Date;
	visibility: string;
}

export interface WorkRecord {
	$type: "org.anthers.work";
	kind: string;
	title: string;
	url: string;
	releasedAt: string;
	description?: string;
	access?: { state: "open" | "gated" };
}

/**
 * Why a Work has no public record. Returned rather than thrown, because "this one is not
 * publishable" is an ordinary outcome of walking a Catalog, not an error.
 */
export type UnpublishableReason = "not_released" | "taken_down";

/**
 * Whether a Work may appear on the public network at all.
 *
 * 🚨 Both exclusions are correctness boundaries rather than tidiness. A `private` Work is
 * staging — uploaded, processing, or being written — and publishing one exposes something
 * its creator has not released. A `withdrawn` Work has deliberately left public circulation
 * while still being served to the people who bought it, so a listing would re-publish
 * exactly what withdrawing was meant to undo. A `taken_down` Work is under a DMCA notice,
 * where continuing to advertise it is continuing to point at the infringement.
 *
 * ⚠️ Records are public and cached by strangers. An over-permissive answer here cannot be
 * taken back by deleting the record later, which is why this fails closed on any
 * visibility value it does not recognise.
 */
export function unpublishableReason(work: PublishableWork): UnpublishableReason | null {
	if (work.takedownStatus !== "active") return "taken_down";
	if (work.visibility !== "released") return "not_released";
	return null;
}

/**
 * What a stranger would find. Reuses the real resolver with a viewer who gives nobody
 * anything and owns nothing, rather than re-deriving "is this free" from the access rows —
 * a second implementation of a gate rule is a second implementation free to disagree with
 * the first, and this one would disagree in public.
 */
function accessForStrangers(work: PublishableWork): { state: "open" | "gated" } {
	const ctx = buildPreviewContext({
		creatorId: work.creatorId ?? -1,
		given: 0,
		owned: false,
		workIds: [],
	});
	return { state: resolveAccessSync(work, ctx).isFree ? "open" : "gated" };
}

/** The canonical page for a Work. Mirrors the app's `/works/{slug}-{publicId}` route. */
export function workUrl(work: PublishableWork, baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/works/${work.slug}-${work.publicId}`;
}

/**
 * The date the record reports as the release.
 *
 * ⚠️ `releasedAt` can be null on a released Work — early rows predate the column, and
 * `routes/content.ts` already orders by `COALESCE(released_at, created_at)` for exactly
 * that reason. This applies the same rule rather than inventing a third one, and rather
 * than withholding the Work from the network over a missing column. The upload date
 * precedes the real release, so the record is early rather than wrong.
 */
function releaseDateOf(work: PublishableWork): Date {
	return work.releasedAt ?? work.createdAt;
}

/** Build the public record for a Work, or `null` when it must not have one. */
export function workToRecord(work: PublishableWork, opts: { baseUrl: string }): WorkRecord | null {
	if (unpublishableReason(work) !== null) return null;

	const record: WorkRecord = {
		$type: "org.anthers.work",
		kind: work.type,
		title: work.title ?? "",
		url: workUrl(work, opts.baseUrl),
		releasedAt: releaseDateOf(work).toISOString(),
		access: accessForStrangers(work),
	};

	// An empty string is not a value: writing `description: ""` into a public record says
	// the creator wrote an empty description, where absence says they wrote none.
	if (work.description) record.description = work.description;

	return record;
}
