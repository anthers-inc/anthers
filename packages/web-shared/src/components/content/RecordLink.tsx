// SPDX-License-Identifier: Apache-2.0
/**
 * The record link — the one component every page that names a thing's ATProto record
 * uses: a small globe fed by anything's record address
 * (`https://atproto.at/uri/{at-uri}`), the one form a reader can follow. Reusable by
 * shape — a Work's listing, a Project's, a post's record, anything carrying an ATProto
 * link — and the one form everywhere (Parker, 2026-10-16): the sentence form that used
 * to stand beside it was retired here, so the globe and its tooltip are the only
 * wording left. Nothing renders while there is no record, which is ordinary rather
 * than a fault — the noun is carried by whichever page renders this.
 */
import { GlobeAltIcon } from "@heroicons/react/24/outline";

export function RecordLinkButton({ recordUrl }: { recordUrl?: string | null }) {
	if (!recordUrl) return null;
	return (
		<a
			href={recordUrl}
			target="_blank"
			rel="noreferrer"
			title="Click this to view the raw ATProto record on Taproot"
			aria-label="View the raw ATProto record on Taproot"
			className="inline-flex items-center text-base-content/50 hover:text-primary"
		>
			<GlobeAltIcon className="h-4 w-4" />
		</a>
	);
}
