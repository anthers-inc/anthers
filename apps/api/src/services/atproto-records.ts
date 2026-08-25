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
export type UnpublishableReason =
	| "not_released"
	| "taken_down"
	| "quarantined"
	| "missing_release_date";

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
	// 🚨 First, and stated separately from the visibility check below even though a
	// quarantine also flips `visibility` to `private`. The two must not be one test: a
	// record is public and cached by strangers, so the thing that stops this material
	// reaching the network has to be the material's own state rather than a side effect of
	// it, which some later change to how quarantine delists could quietly remove.
	if (work.quarantineStatus === "quarantined") return "quarantined";
	if (work.takedownStatus !== "active") return "taken_down";
	if (work.visibility !== "released") return "not_released";
	// A released Work with no release date is a state no current path produces — the update
	// route stamps it on first release, and the seed script sets it too. Reporting it is
	// therefore better than papering over it: if it ever appears in production it is a bug
	// worth seeing, and the alternative was writing an approximate date into a record that
	// other people cache.
	if (!work.releasedAt) return "missing_release_date";
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

/** Build the public record for a Work, or `null` when it must not have one. */
export function workToRecord(work: PublishableWork, opts: { baseUrl: string }): WorkRecord | null {
	if (unpublishableReason(work) !== null) return null;
	// `unpublishableReason` has already established this. Re-checking rather than asserting
	// because a non-null assertion here would be a lie waiting to become true if the two
	// ever drift apart, and the cost of the extra branch is nothing.
	if (!work.releasedAt) return null;

	const record: WorkRecord = {
		$type: "org.anthers.work",
		kind: work.type,
		title: work.title ?? "",
		url: workUrl(work, opts.baseUrl),
		releasedAt: work.releasedAt.toISOString(),
		access: accessForStrangers(work),
	};

	// An empty string is not a value: writing `description: ""` into a public record says
	// the creator wrote an empty description, where absence says they wrote none.
	if (work.description) record.description = work.description;

	return record;
}
