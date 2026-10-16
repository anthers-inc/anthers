// SPDX-License-Identifier: Apache-2.0
/**
 * The record link, in the two forms a page that carries one uses. One vocabulary
 * everywhere (the widening task, 2026-10-10): the record's own address on Taproot
 * (`https://atproto.at/uri/{at-uri}`), the one form a reader can follow, against a
 * sentence that says what it is. Nothing renders while there is no record, which is
 * ordinary rather than a fault — the noun is carried by whichever page renders this,
 * so either form reads as that page's thing.
 */
import { GlobeAltIcon } from "@heroicons/react/24/outline";

export default function RecordLinkLine({ recordUrl }: { recordUrl?: string | null }) {
	if (!recordUrl) return null;
	return (
		<p className="text-xs text-base-content/60">
			Its listing is on the network, where other software can read it.{" "}
			<a href={recordUrl} target="_blank" rel="noreferrer" className="link">
				View the record
			</a>
		</p>
	);
}

/**
 * The record link as a small globe — the standard icon form (Parker, 2026-10-16), for
 * where the sentence's full width would be chrome: it sits inline to the right of
 * whatever already names the thing's place, a post's date stamp first. The tooltip
 * carries the sentence's wording, and there is no record, no button.
 */
export function RecordLinkButton({ recordUrl }: { recordUrl?: string | null }) {
	if (!recordUrl) return null;
	return (
		<a
			href={recordUrl}
			target="_blank"
			rel="noreferrer"
			title="Its listing is on the network, where other software can read it"
			aria-label="View the record on the network"
			className="inline-flex items-center text-base-content/50 hover:text-primary"
		>
			<GlobeAltIcon className="h-4 w-4" />
		</a>
	);
}
