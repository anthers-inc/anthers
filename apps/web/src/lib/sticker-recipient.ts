// SPDX-License-Identifier: Apache-2.0
/**
 * Who a Sticker would pay, asked once when a picker opens.
 *
 * ⭐ **A Sticker beside somebody's words looks like a tip to them, and often is not one.** The
 * money follows the nearest creator up the thread, so a picker that showed only three drawings
 * would leave the giver guessing which person they were supporting. This asks the server, which
 * answers with the same `stickerRecipient` the give itself uses — there is no second definition
 * of the rule on the client.
 *
 * ⚠️ **Asked only when the picker is open**, not per rendered control: a thread draws one of
 * these per comment, and none of them is a question anybody asked until it is opened.
 */
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

export interface StickerRecipientHint {
	/** The name to show, or null when the server answered without one. */
	name: string | null;
	/** Why a Sticker here would be refused, when it would. */
	error: string | null;
}

export function useStickerRecipient(
	subjectType: "work" | "post" | "comment" | "review",
	subjectId: number,
	enabled: boolean,
): StickerRecipientHint | null {
	const [hint, setHint] = useState<StickerRecipientHint | null>(null);

	useEffect(() => {
		if (!enabled || hint) return;
		let live = true;
		client.api.subscriptions.stickers.recipient
			.$get({ query: { subjectType, subjectId: String(subjectId) } })
			.then(async (res) => {
				if (!res.ok || !live) return;
				const data = (await res.json()) as {
					recipient: { handle: string | null; displayName: string | null } | null;
					error?: string;
				};
				setHint({
					name:
						data.recipient?.displayName ||
						(data.recipient?.handle ? `@${data.recipient.handle}` : null),
					error: data.error ?? null,
				});
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [enabled, hint, subjectType, subjectId]);

	return hint;
}
