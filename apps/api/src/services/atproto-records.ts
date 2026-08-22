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
	tags: string[] | null;
	websiteUrl: string | null;
	sourceUrl: string | null;
	durationSeconds: number | null;
	authoredAt: Date | null;
	authoredPrecision: string | null;
	releasedAt: Date | null;
	visibility: string;
}

export interface WorkRecord {
	$type: "org.anthers.work";
	kind: string;
	title: string;
	description?: string;
	url: string;
	access?: "open" | "gated";
	tags?: string[];
	authoredAt?: string;
	authoredPrecision?: string;
	releasedAt?: string;
	durationSeconds?: number;
	website?: string;
	source?: string;
	createdAt: string;
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
function accessForStrangers(work: PublishableWork): "open" | "gated" {
	const ctx = buildPreviewContext({
		creatorId: work.creatorId ?? -1,
		given: 0,
		owned: false,
		workIds: [],
	});
	return resolveAccessSync(work, ctx).isFree ? "open" : "gated";
}

/** The canonical page for a Work. Mirrors the app's `/works/{slug}-{publicId}` route. */
export function workUrl(work: PublishableWork, baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/works/${work.slug}-${work.publicId}`;
}

/**
 * Build the public record for a Work, or `null` when it must not have one.
 *
 * `now` is injected rather than read, so a caller re-publishing an unchanged Work can keep
 * the original `createdAt` and the function stays pure enough to test.
 */
export function workToRecord(
	work: PublishableWork,
	opts: { baseUrl: string; now: Date },
): WorkRecord | null {
	if (unpublishableReason(work) !== null) return null;

	const record: WorkRecord = {
		$type: "org.anthers.work",
		kind: work.type,
		title: work.title ?? "",
		url: workUrl(work, opts.baseUrl),
		access: accessForStrangers(work),
		createdAt: opts.now.toISOString(),
	};

	// Every remaining field is optional, and an empty string is not a value — writing
	// `description: ""` into a public record says "the creator wrote an empty description"
	// where absence says "they wrote none".
	if (work.description) record.description = work.description;
	if (work.tags?.length) record.tags = work.tags;
	if (work.websiteUrl) record.website = work.websiteUrl;
	if (work.sourceUrl) record.source = work.sourceUrl;
	if (work.durationSeconds != null) record.durationSeconds = work.durationSeconds;
	if (work.releasedAt) record.releasedAt = work.releasedAt.toISOString();

	// ⚠️ The pair travels together. `authoredPrecision` without `authoredAt` describes
	// nothing, and `authoredAt` without it invites a reader to render an invented day for a
	// work the creator only dated to a year.
	if (work.authoredAt) {
		record.authoredAt = work.authoredAt.toISOString();
		if (work.authoredPrecision) record.authoredPrecision = work.authoredPrecision;
	}

	return record;
}
