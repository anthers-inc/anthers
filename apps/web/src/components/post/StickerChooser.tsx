// SPDX-License-Identifier: Apache-2.0
/**
 * A Sticker chosen in an editor, attached to the message as it is sent.
 *
 * ⭐ **Choosing the art is choosing the amount** (Parker, 2026-09-04), so this is the same
 * picker the bar uses — the batch's three drawings, each with what it directs and how many are
 * still affordable — held as a pending choice rather than given on the spot. The message has no
 * id until it is posted, and the Sticker's subject is that message.
 *
 * ⚠️ **The Sticker is given after the message lands, not inside its request.** A post, comment,
 * reply and review each write a record into the author's own repository, and folding a money
 * movement into that request would make a Sticker failure cost somebody their words. What the
 * editor owes instead is to say plainly when the message went and the Sticker did not, which is
 * what {@link givePendingSticker}'s answer is for.
 */

import { CURRENT_BATCH, type StickerArt, stickerArt } from "@anthers/shared/stickers";
import { useAuth } from "@anthers/web-shared/auth";
import { BadgeMark } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStickerRecipient } from "../../lib/sticker-recipient";
import { stickersLeftFor } from "./StickerBar";

interface Allowance {
	allowance: number;
	directed: number;
	remaining: number;
	cycle: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Give the Sticker an editor was holding, now that its message has an id.
 *
 * Answers `null` when it went, and the reason when it did not — the caller shows that beside
 * the message it already posted rather than pretending the whole send failed.
 */
export async function givePendingSticker(
	subjectType: "review" | "comment",
	subjectId: number,
	artKey: string,
): Promise<string | null> {
	const res = await client.api.subscriptions.stickers.$post({
		json: { subjectType, subjectId, artKey },
	});
	if (res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return body.error ?? "The Sticker could not be given.";
}

export default function StickerChooser({
	value,
	onChange,
	label,
	recipientOf,
}: {
	/** The chosen art's key, or null for none. */
	value: string | null;
	onChange: (key: string | null) => void;
	/** What the message is, for a screen reader — "your review", "your reply". */
	label: string;
	/**
	 * What the message will hang off: the Work a review is of, the post a comment answers, the
	 * comment a reply answers. A brand-new message has no creator above it of its own, so this
	 * is the subject whose recipient is the message's recipient.
	 */
	recipientOf: { subjectType: "work" | "post" | "comment"; subjectId: number };
}) {
	const { isAuthenticated } = useAuth();
	const [allowance, setAllowance] = useState<Allowance | null>(null);
	const [open, setOpen] = useState(false);
	const detailsRef = useRef<HTMLDetailsElement | null>(null);
	// The thing this message will hang off. A new message has no creator ancestors of its own,
	// so who its Sticker pays is exactly what the parent resolves to — named here before the
	// message exists, rather than left for the giver to guess.
	const recipient = useStickerRecipient(recipientOf.subjectType, recipientOf.subjectId, open);

	const close = useCallback(() => {
		const details = detailsRef.current;
		if (details) details.open = false;
		setOpen(false);
	}, []);

	// ⚠️ Only when the picker opens, like the bar's: an allowance is a per-user number nobody
	// reading a composer needs, and a request per rendered editor would be one per page.
	useEffect(() => {
		if (!open || !isAuthenticated || allowance) return;
		void (async () => {
			const res = await client.api.subscriptions.stickers.allowance.$get();
			if (res.ok) setAllowance((await res.json()) as Allowance);
		})();
	}, [open, isAuthenticated, allowance]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!detailsRef.current?.contains(e.target as Node)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close]);

	if (!isAuthenticated) return null;

	const chosen = stickerArt(value);

	return (
		<div className="flex items-center gap-2">
			{chosen && (
				<span className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-1">
					<BadgeMark
						shape={chosen.shape}
						color={chosen.color}
						emblem={chosen.emblem}
						label={chosen.label}
						clipId={`sticker-choose-${label.replace(/\s+/g, "-")}-${chosen.key}`}
						size="h-5 w-5"
					/>
					<span className="text-xs tabular-nums">{money(chosen.amount)}</span>
					<button
						type="button"
						className="text-base-content/50 hover:text-base-content"
						onClick={() => onChange(null)}
						aria-label={`Remove the Sticker from ${label}`}
					>
						<XMarkIcon className="size-3.5" aria-hidden />
					</button>
				</span>
			)}
			<details
				ref={detailsRef}
				className="dropdown dropdown-end"
				onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
			>
				<summary
					className="btn btn-sm border-primary/40 bg-primary/5 gap-1 rounded-full text-primary marker:hidden hover:border-primary [&::-webkit-details-marker]:hidden"
					aria-label={`Add a Sticker to ${label}`}
				>
					<PlusIcon className="size-4" aria-hidden />
					Sticker
				</summary>
				<div className="dropdown-content z-20 mt-2 w-60 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
					{CURRENT_BATCH.art.map((art: StickerArt) => {
						// `null` while the allowance is loading, so rows stay enabled and the server
						// stays the authority — the counts are orientation for the giver, not the gate.
						const left = allowance ? stickersLeftFor(allowance.remaining, art.amount) : null;
						const tooDear = left === 0;
						return (
							<button
								key={art.key}
								type="button"
								disabled={tooDear}
								onClick={() => {
									onChange(art.key);
									close();
								}}
								aria-label={`${art.label}, ${money(art.amount)}`}
								title={tooDear ? "None left at this amount this month" : art.label}
								className={`flex w-full items-center gap-2.5 rounded-btn p-1.5 text-left ${
									tooDear ? "opacity-40" : "hover:bg-base-200"
								}`}
							>
								<BadgeMark
									shape={art.shape}
									color={art.color}
									emblem={art.emblem}
									label={art.label}
									clipId={`sticker-choose-pick-${label.replace(/\s+/g, "-")}-${art.key}`}
									size="h-8 w-8 shrink-0"
								/>
								<span className="tabular-nums text-sm">{money(art.amount)}</span>
								{left !== null && (
									<span className="text-base-content/60 text-xs tabular-nums">({left} left)</span>
								)}
							</button>
						);
					})}
					{recipient?.name && (
						<p className="text-base-content/60 px-1 pt-2 text-xs">
							Goes to <span className="font-medium">{recipient.name}</span>
						</p>
					)}
					{recipient?.error && <p className="text-error px-1 pt-2 text-xs">{recipient.error}</p>}
					{allowance && allowance.allowance <= 0 && (
						<p className="text-base-content/60 px-1 pt-2 text-xs">
							A free account has no Time Pool to direct by hand.
						</p>
					)}
				</div>
			</details>
		</div>
	);
}
