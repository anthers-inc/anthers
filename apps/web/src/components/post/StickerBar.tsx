// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Stickers on something, and the way to add one.
 *
 * ⭐ **Choosing the art is choosing the amount** (Parker, 2026-09-04). The batch runs
 * simple to elaborate, so a reader can tell what a Sticker cost from how much drawing is
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
 * sum twice unless it says so; this control quotes only what is left to direct.
 */

import {
	ALL_STICKER_ART,
	CURRENT_BATCH,
	STICKER_BATCHES,
	type StickerArt,
	stickerArt,
} from "@anthers/shared/stickers";
import { useAuth } from "@anthers/web-shared/auth";
import { BadgeMark } from "@anthers/web-shared/economics";
import { client } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useState } from "react";

export type StickerSubject = "work" | "post" | "comment";

/** One art's worth of Stickers on this subject, as the server groups them. */
interface StickerGroup {
	artKey: string;
	count: number;
	/** Row ids belonging to the viewer — the only ones they may take back. */
	mine: number[];
}

interface Allowance {
	allowance: number;
	directed: number;
	remaining: number;
	cycle: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export default function StickerBar({
	subjectType,
	subjectId,
	label,
}: {
	subjectType: StickerSubject;
	subjectId: number;
	/** What the Sticker is being given to, for a screen reader. */
	label: string;
}) {
	const { isAuthenticated } = useAuth();
	const [groups, setGroups] = useState<StickerGroup[]>([]);
	const [allowance, setAllowance] = useState<Allowance | null>(null);
	const [picking, setPicking] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

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
	// card for a control most readers never touch.
	useEffect(() => {
		if (!picking || !isAuthenticated || allowance) return;
		void (async () => {
			const res = await client.api.subscriptions.stickers.allowance.$get();
			if (res.ok) setAllowance((await res.json()) as Allowance);
		})();
	}, [picking, isAuthenticated, allowance]);

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
			setPicking(false);
			// Both, because giving changes the wall and what is left to give. Refetched
			// rather than adjusted locally: somebody else may have given one since load,
			// and a count that drifts from its rows looks exactly like a count.
			setAllowance(null);
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

	const total = groups.reduce((n, g) => n + g.count, 0);

	/**
	 * ⚠️ **Nothing is ever retired from giving** (Parker, 2026-09-04), so this list grows by
	 * three every quarter and cannot simply be rendered flat. The current batch leads and
	 * everything before it is one click away — which keeps the ordinary choice three wide
	 * while honoring the rule that a Sticker somebody liked never stops being giveable.
	 */
	const older = STICKER_BATCHES.filter((b) => b.id !== CURRENT_BATCH.id);
	const pickable: StickerArt[] = showAll ? ALL_STICKER_ART.slice() : CURRENT_BATCH.art.slice();

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

			{isAuthenticated && !picking && (
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={() => setPicking(true)}
					aria-label={`Give a Sticker to ${label}`}
				>
					{total === 0 ? "Give a Sticker" : "＋"}
				</button>
			)}

			{picking && (
				<div className="flex w-full flex-col gap-2 rounded-box border border-base-300 p-3">
					<div className="flex items-center justify-between">
						<span className="font-medium text-sm">
							Give a Sticker{showAll ? "" : ` — ${CURRENT_BATCH.name}`}
						</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => setPicking(false)}
						>
							Cancel
						</button>
					</div>

					{/* Says whose money this is, because it is the giver's own Time Pool being
					    pointed at one creator rather than anything extra being charged. */}
					<p className="text-base-content/60 text-xs">
						This directs part of the support you already give Anthers to this creator. It does not
						charge you anything more.
					</p>

					<div className="flex flex-wrap gap-3">
						{pickable.map((art: StickerArt) => {
							const tooDear = allowance ? art.amount > allowance.remaining + 0.001 : false;
							return (
								<button
									key={art.key}
									type="button"
									disabled={busy || tooDear}
									onClick={() => give(art.key)}
									aria-label={`${art.label}, ${money(art.amount)}`}
									title={tooDear ? "More than you have left to direct this month" : art.label}
									className={`flex flex-col items-center gap-1 rounded-box border p-2 ${
										tooDear ? "opacity-40" : "hover:border-primary"
									} border-base-300`}
								>
									<BadgeMark
										shape={art.shape}
										color={art.color}
										emblem={art.emblem}
										label={art.label}
										clipId={`sticker-pick-${subjectType}-${subjectId}-${art.key}`}
										size="h-10 w-10"
									/>
									<span className="text-xs tabular-nums">{money(art.amount)}</span>
								</button>
							);
						})}
					</div>

					{older.length > 0 && (
						<button
							type="button"
							className="btn btn-ghost btn-xs self-start"
							onClick={() => setShowAll((v) => !v)}
						>
							{showAll
								? `Just ${CURRENT_BATCH.name.toLowerCase()}`
								: `Earlier Stickers (${older.reduce((n, b) => n + b.art.length, 0)})`}
						</button>
					)}

					{allowance && (
						<p className="text-base-content/60 text-xs">
							{allowance.allowance <= 0
								? "A free account has no Time Pool to direct by hand."
								: `${money(allowance.remaining)} left to direct this month, of ${money(allowance.allowance)}.`}
						</p>
					)}
					{problem && <p className="text-error text-xs">{problem}</p>}
				</div>
			)}
		</div>
	);
}
