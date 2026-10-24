// SPDX-License-Identifier: Apache-2.0
/**
 * The note that tells somebody a Work reached them through a share — who sent it, and the way
 * to an account of their own — as a paper-airplane affordance on the media itself.
 *
 * It replaces the card that used to sit *under* the deliverable (`SharedWorkBanner`, 2026-10-23).
 * That card was wrong in two different places for two different reasons:
 *
 * - **On an embed it was never invited.** A third-party page asks for a player, and the frame
 *   handed it the player plus a signup box below it — the one part of the embed that is not the
 *   thing the site asked for. So on an embed the affordance is inert until the pointer is over
 *   the media, the way a player's own controls are, and the card never opens by itself.
 * - **On a share link it was below the fold of attention.** Somebody who followed a link should
 *   learn early that the creator is still paid and that an account is free, so the card opens on
 *   arrival there — and gets out of the way after {@link AUTO_OPEN_SECONDS} seconds, or the
 *   moment they touch the thing they came to watch.
 *
 * 🚨 **It links to the one signup door rather than signing anybody up in place** (Parker,
 * 2026-09-13). Every account is an ATProto identity, so an account needs a handle chosen or a
 * Bluesky identity proved before it can exist, and a second copy of that ceremony under a video
 * would be a second place that mints accounts. `/signup` asks for nothing more than that — the
 * support ladder on it is an offer, not a cost, and signing up costs nothing — and `next`
 * brings the person straight back to this Work once they have finished, signed in and watching
 * on their own allowance.
 *
 * ⚠️ **`next` is the Work's own page, never the embed.** Somebody who signs up from a frame on
 * another site goes back to the Work rather than being dropped inside somebody else's page —
 * which is also why the embed's link opens in a new tab.
 *
 * The media stage it draws over is whatever carries `data-media-stage` and the `group` class:
 * `WorkMediaFrame`'s stage on a page, and the wrapper `WorkDeliverable` puts around an unframed
 * medium on the embed route. That contract is what lets the embed reveal the trigger on hover
 * without any JavaScript tracking the pointer.
 */
import { withNextPath } from "@anthers/shared/next-path";
import { Link, useLocation } from "@anthers/web-shared/router";
import { PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/** How long a share link's card stands on its own before it gets out of the way. */
const AUTO_OPEN_SECONDS = 30;

export default function SharedWorkNotice({
	sharedBy,
	mode,
	returnTo,
}: {
	/** Display name of whoever sent the link, when we know it. */
	sharedBy?: string | null;
	/**
	 * `page` — a share link's landing page: the trigger stands, and the card opens on arrival.
	 * `embed` — a frame on another site: both appear only when the media is under the pointer.
	 */
	mode: "page" | "embed";
	/** Where signing up returns to, when the page's own address is not the right answer. */
	returnTo?: string;
}) {
	const location = useLocation();
	const [open, setOpen] = useState(false);
	/** Opened by the person, so pointer-leave does not take it away from them. */
	const [pinned, setPinned] = useState(false);
	const inside = useRef(false);

	const close = useCallback(() => {
		setOpen(false);
		setPinned(false);
	}, []);

	// A share link announces itself, then leaves on its own.
	useEffect(() => {
		if (mode !== "page") return;
		setOpen(true);
		const timer = window.setTimeout(() => {
			if (!inside.current) close();
		}, AUTO_OPEN_SECONDS * 1000);
		return () => window.clearTimeout(timer);
	}, [mode, close]);

	// Touching the media is taking up the invitation: the card goes, whether it arrived on its
	// own or was opened by hand. `play` does not bubble, so both listeners capture.
	useEffect(() => {
		if (!open) return;
		const onMedia = (event: Event) => {
			const target = event.target as Element | null;
			if (!target?.closest("[data-media-stage]")) return;
			if (target.closest("[data-share-notice]")) return;
			close();
		};
		document.addEventListener("pointerdown", onMedia, true);
		document.addEventListener("play", onMedia, true);
		return () => {
			document.removeEventListener("pointerdown", onMedia, true);
			document.removeEventListener("play", onMedia, true);
		};
	}, [open, close]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, close]);

	const signupPath = withNextPath("/signup", returnTo ?? location.pathname);
	const cardId = useId();

	return (
		<div
			data-share-notice
			className={`absolute right-3 top-3 z-20 flex flex-col items-end gap-2 ${
				mode === "embed"
					? "pointer-events-none opacity-0 transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
					: ""
			}`}
			onPointerEnter={() => {
				inside.current = true;
				setOpen(true);
			}}
			onPointerLeave={() => {
				inside.current = false;
				if (!pinned) setOpen(false);
			}}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={cardId}
				aria-label="Who shared this"
				className="btn btn-circle btn-sm border border-base-300 bg-base-100/90 shadow-sm backdrop-blur"
				onClick={() => {
					setPinned(!open);
					setOpen(!open);
				}}
			>
				<PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />
			</button>

			{open && (
				<div
					id={cardId}
					className="w-[min(18rem,calc(100vw-4rem))] rounded-lg border border-base-300 bg-base-100 p-3 text-left shadow-lg"
				>
					<div className="flex items-start gap-2">
						<p className="flex-1 text-xs leading-relaxed text-base-content/80">
							{sharedBy ? <strong>{sharedBy}</strong> : "Someone"} shared this with you, so you can
							watch it without an account — and the creator is paid for your time either way.
						</p>
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-circle -mr-1 -mt-1"
							aria-label="Close"
							onClick={close}
						>
							<XMarkIcon className="h-3.5 w-3.5" />
						</button>
					</div>
					{mode === "embed" ? (
						// A frame on somebody else's page: signup opens outside it, and lands the
						// new account on the Work rather than back inside the frame.
						<a
							href={signupPath}
							target="_blank"
							rel="noopener noreferrer"
							className="btn btn-primary btn-xs mt-2"
						>
							Create a Free Account
						</a>
					) : (
						// The share token stays out of `next`: a signed-in user watches on their
						// own allowance, which is the point of making the account.
						<Link to={signupPath} className="btn btn-primary btn-xs mt-2">
							Create a Free Account
						</Link>
					)}
				</div>
			)}
		</div>
	);
}
