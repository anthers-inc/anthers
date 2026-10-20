// SPDX-License-Identifier: Apache-2.0
/**
 * The plain-text view of a title whose stored form carries `@` mention links, and the
 * mapping between the two. Split out of the editor so the edit arithmetic is testable
 * without a DOM.
 *
 * The stored title is markdown (`[@Curtains](/works/curtains-534000269) Discussion`); the
 * author edits `@Curtains Discussion`. Each mention is a run of the plain text plus the
 * Work's public id, and an edit that touches a run's characters drops the link while an
 * edit elsewhere merely shifts its offsets — the same behavior editing an `@` has on any
 * network.
 */
import { postTitleSegments, workMentionLabel } from "@anthers/shared/post-title";

/** What a range needs from a Work: its id, its public path, and its current name. */
export interface MentionWork {
	publicId: number;
	slug: string;
	title: string | null;
}

/** A run of the visible title that names a Work. */
export interface MentionRange {
	publicId: number;
	start: number;
	end: number;
}

export interface MentionState {
	plain: string;
	ranges: MentionRange[];
}

function labelFor(work: MentionWork): string {
	return workMentionLabel(work.title ?? "");
}

/** The visible title and the runs that are mentions, read from the stored form. */
export function fromCanonical(canonical: string, works: Map<number, MentionWork>): MentionState {
	let plain = "";
	const ranges: MentionRange[] = [];
	for (const segment of postTitleSegments(canonical)) {
		if (segment.kind === "text") {
			plain += segment.text;
			continue;
		}
		const work = works.get(segment.publicId);
		const label = work ? labelFor(work) : segment.text;
		const start = plain.length;
		plain += label;
		ranges.push({ publicId: segment.publicId, start, end: plain.length });
	}
	return { plain, ranges };
}

/** The stored form: every mention run wrapped back into its markdown link. */
export function toCanonical(
	plain: string,
	ranges: MentionRange[],
	works: Map<number, MentionWork>,
): string {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const range of sorted) {
		out += plain.slice(cursor, range.start);
		const work = works.get(range.publicId);
		const label = plain.slice(range.start, range.end);
		out += work?.slug ? `[${label}](/works/${work.slug}-${range.publicId})` : label;
		cursor = range.end;
	}
	return out + plain.slice(cursor);
}

/**
 * Carry the mention runs through one edit of the plain text. A run entirely outside the
 * changed region survives, shifted by the edit's length; a run the edit touched loses its
 * link, because its text is no longer the Work's name.
 */
export function reconcileRanges(
	before: string,
	after: string,
	ranges: MentionRange[],
): MentionRange[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	const changedStart = prefix;
	const changedEnd = before.length - suffix;
	const delta = after.length - before.length;

	const kept: MentionRange[] = [];
	for (const range of ranges) {
		if (range.end <= changedStart) {
			kept.push(range);
		} else if (range.start >= changedEnd) {
			kept.push({ ...range, start: range.start + delta, end: range.end + delta });
		}
	}
	return kept;
}

/**
 * Replace `[start, end)` with a Work's `@` name and record the new run. Used by the
 * picker, where the replaced span is the `@query` the author was typing.
 */
export function insertMention(
	state: MentionState,
	start: number,
	end: number,
	work: MentionWork,
): MentionState {
	const label = labelFor(work);
	const plain = state.plain.slice(0, start) + label + state.plain.slice(end);
	const delta = label.length - (end - start);
	const ranges = state.ranges
		.filter((range) => range.end <= start || range.start >= end)
		.map((range) =>
			range.start >= end ? { ...range, start: range.start + delta, end: range.end + delta } : range,
		);
	ranges.push({ publicId: work.publicId, start, end: start + label.length });
	return { plain, ranges };
}

/** The `@query` under the caret, if the caret is in one. */
export function activeMention(
	text: string,
	caret: number,
): { start: number; query: string } | null {
	let index = caret - 1;
	while (index >= 0 && !/\s/.test(text[index] ?? "")) index--;
	const token = text.slice(index + 1, caret);
	if (!token.startsWith("@") || token.length > 40) return null;
	// A second `@` means this is not the start of a mention (an address, say).
	if (token.indexOf("@", 1) !== -1) return null;
	return { start: index + 1, query: token.slice(1) };
}
