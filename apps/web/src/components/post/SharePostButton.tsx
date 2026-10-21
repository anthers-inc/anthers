// SPDX-License-Identifier: Apache-2.0
/**
 * "Share" on a post — the post's own address, ready to copy.
 *
 * A post is an announcement, and sharing one means pointing somebody at it. There is no
 * watching link and no embed here, unlike a Work (`ShareLinkButton.tsx`): a post carries
 * no gate, no player and no allowance to mint, so the page's URL is the whole of what
 * there is to share. The modal is the same house shape, because a Share control that
 * behaved differently on the two surfaces would be a difference with nothing behind it.
 */

import Modal from "@anthers/web-shared/ui/Modal";
import { CheckIcon, ShareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";

export default function SharePostButton({ url, label }: { url: string; label: string }) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	// Escape closes, the keyboard half of the door; the pointer half is the ✕.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	const copy = () => {
		// The clipboard write can be refused (permissions, an insecure origin, a browser
		// that wants a fresher gesture); the input stays selectable either way, so a
		// failed write is never reported as one.
		navigator.clipboard.writeText(url).then(
			() => setCopied(true),
			() => {},
		);
	};

	return (
		<>
			<button
				type="button"
				className="btn btn-ghost btn-sm gap-2"
				onClick={() => {
					setCopied(false);
					setOpen(true);
				}}
			>
				<ShareIcon className="h-4 w-4" />
				Share
			</button>

			<Modal open={open} label={`Share ${label}`}>
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
					<div className="flex items-center gap-2">
						<input
							type="text"
							readOnly
							value={url}
							aria-label="Post link"
							className="input input-sm input-bordered flex-1 font-mono text-xs"
							onFocus={(e) => e.currentTarget.select()}
						/>
						<button type="button" className="btn btn-sm gap-1" onClick={copy}>
							{copied ? <CheckIcon className="h-4 w-4" /> : null}
							{copied ? "Copied" : "Copy"}
						</button>
					</div>
				</div>
			</Modal>
		</>
	);
}
