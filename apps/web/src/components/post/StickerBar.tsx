// SPDX-License-Identifier: Apache-2.0
/**
 * The Stickers on something, and the way to add one.
 *
 * ⭐ **Choosing the art is choosing the amount** (Parker, 2026-09-04). The batch runs
 * simple to elaborate, so a user can tell what a Sticker cost from how much drawing is
 * in it. There is no second control asking for money, and the server reads the amount off
 * the art rather than taking it from here — see `@anthers/shared/stickers`.
 *
 * ⚠️ **A Sticker is a monetary commitment that can still be removed from display**
 * (Parker, 2026-09-04). Taking one back leaves the creator paid and does not return the
 * money, because giving one may earn visibility or goodwill that nobody should be able to
 * collect and then refund. The confirmation says so in as many words rather than hinting.
 *
 * 🚨 **The amount directed comes out of the giver's OWN Time Pool and is not new money.**
 * A surface that shows both a rung's Time Pool and its Sticker allowance is showing one
 * sum twice unless it says so; this picker names only what each drawing is worth and how
 * many of that denomination the giver still has left this month.
 *
 * The picker is an overlaid dropdown, not an inline expansion (Parker, 2026-10-16): giving
 * must never shift the layout under it. Each row carries the money it directs and the
 * count still affordable, so the giver can compare the three denominations without doing
 * division in their head.
 */

import { CURRENT_BATCH, type StickerArt, stickerArt } from "@anthers/shared/stickers";
import { useAuth } from "@anthers/web-shared/auth";
import { BadgeMark } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStickerRecipient } from "../../lib/sticker-recipient";

export type StickerSubject = "work" | "post" | "comment";

/** One art's worth of Stickers on this subject, as the server groups them. */
interface StickerGroup {
	artKey: string;
	count: number;
	/** Row ids belonging to the user — the only ones they may take back. */
	mine: number[];
}

interface Allowance {
	allowance: number;
	directed: number;
	remaining: number;
	cycle: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * How many Stickers at one denomination the remaining allowance can still afford.
 *
 * Exported for {@link ./sticker-picker.test | its suite}. The floor is the honest
 * answer — affording a $0.50 Sticker with $0.25 left would spend money that is not
 * there — and the epsilon absorbs float drift from the arithmetic the allowance
 * travels through, so a true $0.75 never reads as two affordable $0.25s.
 * `remaining` arrives as a binary-float number over JSON; every denomination here is a
 * quarter or a half, which is exactly the value drift puts *just below* an integer.
 */
export function stickersLeftFor(remaining: number, amount: number): number {
	if (remaining <= 0) return 0;
	return Math.floor(remaining / amount + 1e-9);
}

export default function StickerBar({
	subjectType,
	subjectId,
	label,
	align = "start",
}: {
	subjectType: StickerSubject;
	subjectId: number;
	/** What the Sticker is being given to, for a screen reader. */
	label: string;
	/** Which side the dropdown hugs — the Work's bar sits at the right of the verdict row. */
	align?: "start" | "end";
}) {
	const { isAuthenticated } = useAuth();
	const [groups, setGroups] = useState<StickerGroup[]>([]);
	const [allowance, setAllowance] = useState<Allowance | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const detailsRef = useRef<HTMLDetailsElement | null>(null);
	// Who this Sticker would pay, asked when the picker opens — a Sticker beside somebody's
	// words looks like a tip to them, and the money follows the nearest creator up the thread.
	const recipient = useStickerRecipient(subjectType, subjectId, open);

	/** Programmatic close: assigning `open` fires `toggle`, which syncs the React state. */
	const close = useCallback(() => {
		const details = detailsRef.current;
		if (details) details.open = false;
		setOpen(false);
	}, []);

	const loadStickers = useCallback(async () => {
		const res = await client.api.subscriptions.stickers.$get({
			query: { subjectType, subjectId: String(subjectId) },
		});
		if (res.ok) setGroups(((await res.json()) as { stickers: StickerGroup[] }).stickers);
	}, [subjectType, subjectId]);

	useEffect(() => {
		void loadStickers();
	}, [loadStickers]);

	// ⚠️ Only when the picker opens. The allowance is a per-user number that nobody reading
	// a page needs, and fetching it on every render of every Work would be a request per
	// card for a control most users never touch.
	useEffect(() => {
		if (!open || !isAuthenticated || allowance) return;
		void (async () => {
			const res = await client.api.subscriptions.stickers.allowance.$get();
			if (res.ok) setAllowance((await res.json()) as Allowance);
		})();
	}, [open, isAuthenticated, allowance]);

	// A native <details> dropdown never closes on its own — not for a click outside it,
	// not for Escape. Both are what a picker this ordinary owes its reader: the outside
	// click because the picker covers content below the trigger, Escape because a
	// keyboard user needs a way out that is not Tab-ordering past the last row.
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

	async function give(artKey: string) {
		setBusy(true);
		setProblem(null);
		try {
			const res = await client.api.subscriptions.stickers.$post({
				json: { subjectType, subjectId, artKey },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setProblem(body.error ?? "That did not go through.");
				return;
			}
			// Both, because giving changes the wall and what is left to give. Refetched
			// rather than adjusted locally: somebody else may have given one since load,
			// and a count that drifts from its rows looks exactly like a count. The
			// allowance is dropped entirely; the next open refetches it whole.
			setAllowance(null);
			close();
			await loadStickers();
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: number) {
		if (
			!confirm(
				"Take this Sticker off the page?\n\nThe creator stays paid — removing it does not " +
					"return the money.",
			)
		) {
			return;
		}
		setBusy(true);
		try {
			await client.api.subscriptions.stickers[":id"].$delete({ param: { id: String(id) } });
			await loadStickers();
		} finally {
			setBusy(false);
		}
	}

	/**
	 * ⚠️ **Nothing is ever retired from giving** (Parker, 2026-09-04), so this picker grows
	 * by three every quarter. Today the only batch is the current one and the picker is
	 * simply its whole flat list — no batch-name heading, either (Parker, 2026-10-16):
	 * how named sticker groups display is a conversation that happens when a second batch
	 * exists, and reaching earlier batches then is part of that same conversation.
	 */
	const pickable = CURRENT_BATCH.art as readonly StickerArt[];

	const total = groups.reduce((n, g) => n + g.count, 0);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{groups.map((group) => {
				const art = stickerArt(group.artKey);
				// ⚠️ A row whose art is not in any batch still renders, as a count without a
				// drawing. Dropping it would silently remove a gift somebody paid for.
				const mine = group.mine.length > 0;
				return (
					<button
						key={group.artKey || "unknown"}
						type="button"
						disabled={!mine || busy}
						onClick={() => mine && remove(group.mine[0] as number)}
						title={
							mine
								? `You gave this. Click to take it off the page — the creator stays paid.`
								: `${group.count} × ${art?.label ?? "Sticker"}`
						}
						className={`flex items-center gap-1 rounded-full border px-2 py-1 ${
							mine ? "border-primary/40 bg-primary/5" : "border-base-300"
						} ${mine ? "cursor-pointer" : "cursor-default"}`}
					>
						{art ? (
							<BadgeMark
								shape={art.shape}
								color={art.color}
								emblem={art.emblem}
								label={art.label}
								clipId={`sticker-${subjectType}-${subjectId}-${group.artKey}`}
								size="h-6 w-6"
							/>
						) : null}
						<span className="text-sm tabular-nums">{group.count}</span>
					</button>
				);
			})}

			{isAuthenticated && (
				<details
					ref={detailsRef}
					className={`dropdown ${align === "end" ? "dropdown-end" : "dropdown-start"}`}
					onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
				>
					{/* The trigger reads as an offer to give, not an edit control: a pill,
					    slightly tinted toward the primary, so it sits beside the votes without
					    pretending to be one of the controls that act on the subject. */}
					<summary
						className="btn btn-sm border-primary/40 bg-primary/5 gap-1 rounded-full text-primary marker:hidden hover:border-primary [&::-webkit-details-marker]:hidden"
						aria-label={`Add a Sticker to ${label}`}
					>
						<PlusIcon className="size-4" aria-hidden />
						Sticker
						{total > 0 ? <span className="sr-only">— you gave {total}</span> : null}
					</summary>

					<div className="dropdown-content z-20 mt-2 w-60 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
						{pickable.map((art: StickerArt) => {
							// `null` while the allowance is still loading, so rows stay enabled
							// and the server is the authority on what is left — the counts are
							// orientation for the giver, not the gate.
							const left = allowance ? stickersLeftFor(allowance.remaining, art.amount) : null;
							const tooDear = left === 0;
							return (
								<button
									key={art.key}
									type="button"
									disabled={busy || tooDear}
									onClick={() => give(art.key)}
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
										clipId={`sticker-pick-${subjectType}-${subjectId}-${art.key}`}
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
						{problem && <p className="text-error px-1 pt-2 text-xs">{problem}</p>}
					</div>
				</details>
			)}
		</div>
	);
}
