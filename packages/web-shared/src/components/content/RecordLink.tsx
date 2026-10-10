// SPDX-License-Identifier: Apache-2.0
/**
 * The record link, as the sentence every page that carries one uses.
 *
 * One wording everywhere (the widening task, 2026-10-10): "Its listing is on the network,
 * where other software can read it," linked to the record's own address on Taproot
 * (`https://atproto.at/uri/{at-uri}`), the one form a reader can follow. Nothing renders
 * while there is no record, which is ordinary rather than a fault — the noun is carried by
 * whichever page renders this, so the sentence reads as that page's thing.
 */
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
