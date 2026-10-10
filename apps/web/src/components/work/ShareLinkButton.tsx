// SPDX-License-Identifier: Apache-2.0
/**
 * "Share" on a Work: a modal that is never a blocker.
 *
 * It opens with the Work's page address, ready to copy, immediately — sharing a gated or
 * priced Work is pointing somebody at it (to buy it, or because they already have access),
 * and that needs no server's blessing. Then, in the background, it asks for the **watching
 * link** — and the server decides, exactly as it always has (a stale page must not offer to
 * share something that has since become gated or Adult). When the answer is yes, the input
 * upgrades to the watching link and the Embed shape joins it; when the answer is no, the
 * note below explains why — Parker, 2026-10-10: the old refusal sentence "should appear on
 * the modal where we allow the user to copy the link, rather than being a blocker."
 *
 * 🚨 **What the watching link hands over is an allowance, not a permission, and the copy has
 * to say so.** Time watched through it is attributed to the sharer — that is what makes a
 * stranger's minute payable to the creator at all — and it draws a **separate** monthly
 * budget, so sharing never costs the sharer any of their own ten hours. The page link carries
 * no allowance at all: whoever opens it is just opening the page, and the ordinary account
 * rules apply.
 */
import {
	FREE_PUBLIC_ACCESS_HOURS,
	SHARED_PUBLIC_ACCESS_SECONDS,
} from "@anthers/shared/public-access";
import { client } from "@anthers/web-shared/rpc";
import { CheckIcon, ShareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";

/** "1 hour" / "30 minutes" — the relay budget, in words, from the constant. */
function sharedBudgetLabel(): string {
	const minutes = Math.round(SHARED_PUBLIC_ACCESS_SECONDS / 60);
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return hours === 1 ? "an hour" : `${hours} hours`;
	}
	return `${minutes} minutes`;
}

export default function ShareLinkButton({ workId, slug }: { workId: number; slug: string }) {
	const [open, setOpen] = useState(false);
	/** The watching link, once the server answers yes — null while asking, or after a refusal. */
	const [allowance, setAllowance] = useState<{ url: string; embedUrl: string } | null>(null);
	/** Whether the server has answered at all (a refusal is an answer, not a null). */
	const [asked, setAsked] = useState(false);
	/** Which shape of the allowance to show: the address alone, or it rendered as a player. */
	const [shape, setShape] = useState<"link" | "embed">("link");
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The Work's own address — the copy that is offered before anything is minted, and
	// the one on a refusal (no token exists: not pointing at the Work at all).
	const pageUrl = `${window.location.origin}/works/${slug}`;

	/** The iframe a third-party page pastes to render the player — the embed's whole output. */
	const embedSnippet = (embed: string) =>
		`<iframe src="${embed}" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen title="Anthers"></iframe>`;

	// Asked when the modal opens (once): the mint is idempotent server-side, so a
	// re-open costs one read-back — a fresh token per press would be the thing that
	// breaks already-pasted links, and that was settled when the mint was written.
	const ask = async () => {
		if (asked) return;
		setAsked(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"]["share-link"].$post({
				param: { id: String(workId) },
			});
			if (res.ok) {
				const { url: link, embedUrl: embed } = (await res.json()) as {
					url: string;
					embedUrl: string;
				};
				setAllowance({ url: link, embedUrl: embed });
			}
			// A refusal is the not-shareable note's cue, not an error — the page link
			// above is already in hand and was never blocked.
		} catch {
			setError("Couldn't make a link just now. Please try again.");
		}
	};

	const openModal = () => {
		setCopied(false);
		setShape("link");
		setOpen(true);
		void ask();
	};

	// When the allowance arrives the input swaps from the page link to the watching
	// link, and "Copied" (if the old value was copied mid-swap) resets to avoid a lie.
	useEffect(() => {
		if (allowance) setCopied(false);
	}, [allowance]);

	// Escape closes, for the keyboard half of the door; the pointer half is the ✕.
	// The backdrop itself carries no click handler (the pattern ReportDialog set: the
	// box's own controls close it, and a click-handler without a key-handler is an
	// a11y warning lint declines).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	const shown =
		shape === "embed" && allowance ? embedSnippet(allowance.embedUrl) : (allowance?.url ?? pageUrl);
	const shownLabel = shape === "embed" ? "Embed code" : allowance ? "Share link" : "Work link";
	const copy = () => {
		navigator.clipboard.writeText(shown).then(
			() => setCopied(true),
			() => {},
		);
	};

	return (
		<>
			<button type="button" className="btn btn-ghost btn-sm gap-2" onClick={openModal}>
				<ShareIcon className="h-4 w-4" />
				Share
			</button>

			{open && (
				<div className="modal modal-open" role="dialog" aria-label="Share this Work">
					<div className="modal-box max-w-md">
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2"
							aria-label="Close"
							onClick={() => setOpen(false)}
						>
							<XMarkIcon className="h-4 w-4" />
						</button>
						<h3 className="text-lg font-semibold mb-3">Share</h3>

						{/* One input, one copy. It opens on the page's own address and
						    upgrades to the watching link when the server mints one — the
						    clipboard write can be refused (permissions, an insecure origin, a
						    browser that wants a fresher gesture), and the thing to copy is
						    selectable either way, so a failed write is never reported as one. */}
						<div className="flex items-center gap-2">
							<input
								type="text"
								readOnly
								value={shown}
								aria-label={shownLabel}
								className="input input-sm input-bordered flex-1 font-mono text-xs"
								onFocus={(e) => e.currentTarget.select()}
							/>
							<button type="button" className="btn btn-sm gap-1" onClick={copy}>
								{copied ? <CheckIcon className="h-4 w-4" /> : null}
								{copied ? "Copied" : "Copy"}
							</button>
						</div>

						{allowance && (
							<div className="mt-3 space-y-2">
								<div className="flex gap-1" role="tablist" aria-label="Share as">
									{(["link", "embed"] as const).map((s) => (
										<button
											key={s}
											type="button"
											role="tab"
											aria-selected={shape === s}
											className={`btn btn-xs ${shape === s ? "btn-primary" : "btn-ghost"}`}
											onClick={() => {
												setShape(s);
												setCopied(false);
											}}
										>
											{s === "link" ? "Watching link" : "Embed"}
										</button>
									))}
								</div>
								<p className="text-xs text-base-content/60">
									{shape === "embed"
										? "Paste this into any page to play the work there. Anyone watching counts as your share — from the same separate "
										: "Anyone with this link can watch without an account. Their time counts as yours and is paid to the creator — from a separate "}
									{sharedBudgetLabel()} a month, so it never touches your {FREE_PUBLIC_ACCESS_HOURS}{" "}
									free hours.
								</p>
							</div>
						)}

						{asked && !allowance && !error && (
							<p className="mt-3 text-xs text-base-content/60">
								Only work that is free to everyone can be shared as a watching link — a gate, a
								price or an Adult rating all need the person opening it to have their own account.
								The page link above is still yours to send: it&apos;s a good way to point somebody
								at something they might buy, or to pass it to someone who already has access.
							</p>
						)}
						{error && <p className="mt-3 text-sm text-error">{error}</p>}
					</div>
				</div>
			)}
		</>
	);
}
