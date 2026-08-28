// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Share" on a Work, for somebody who has an account.
 *
 * 🚨 **What it hands over is an allowance, not a permission, and the copy has to say so.**
 * Time watched through this link is attributed to the sharer — that is what makes a
 * stranger's minute payable to the creator at all — and it draws a **separate** monthly
 * budget, so sharing never costs the sharer any of their own ten hours and a link that goes
 * viral cannot dilute what their own watching pays the creators they chose.
 *
 * ⚠️ The button is offered on every Work and the *server* decides shareability, rather than
 * this component deciding from `access`. A Work's rating and gates can change after a page
 * loads, and a client-side rule would be a second copy of `shareable()` free to disagree with
 * the first — the direction that matters being the one where a stale page offers to share
 * something that has since become Adult.
 */
import {
	FREE_PUBLIC_ACCESS_HOURS,
	SHARED_PUBLIC_ACCESS_SECONDS,
} from "@anthers/shared/public-access";
import { client } from "@anthers/web-shared/rpc";
import { CheckIcon, ShareIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

/** "1 hour" / "30 minutes" — the relay budget, in words, from the constant. */
function sharedBudgetLabel(): string {
	const minutes = Math.round(SHARED_PUBLIC_ACCESS_SECONDS / 60);
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return hours === 1 ? "an hour" : `${hours} hours`;
	}
	return `${minutes} minutes`;
}

export default function ShareLinkButton({ workId }: { workId: number }) {
	const [url, setUrl] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const make = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"]["share-link"].$post({
				param: { id: String(workId) },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "Couldn't make a link just now. Please try again.");
				return;
			}
			const { url: link } = (await res.json()) as { url: string };
			setUrl(link);
			// A clipboard write can be refused (permissions, an insecure origin, a browser that
			// wants a fresher gesture), and the link is on screen either way — so a failure here
			// costs nothing and must not be reported as one.
			try {
				await navigator.clipboard.writeText(link);
				setCopied(true);
			} catch {
				/* the input below is selectable */
			}
		} catch {
			setError("Couldn't make a link just now. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	if (error) {
		return <p className="text-sm text-base-content/60">{error}</p>;
	}

	if (!url) {
		return (
			<button
				type="button"
				className="btn btn-ghost btn-sm gap-2"
				onClick={make}
				disabled={loading}
			>
				<ShareIcon className="h-4 w-4" />
				{loading ? "Making a link…" : "Share"}
			</button>
		);
	}

	return (
		<div className="w-full space-y-2 rounded-lg border border-base-300 bg-base-200/60 p-3">
			<div className="flex items-center gap-2">
				<input
					type="text"
					readOnly
					value={url}
					aria-label="Share link"
					className="input input-sm input-bordered flex-1 font-mono text-xs"
					onFocus={(e) => e.currentTarget.select()}
				/>
				<button
					type="button"
					className="btn btn-sm gap-1"
					onClick={() => {
						navigator.clipboard.writeText(url).then(
							() => setCopied(true),
							() => {},
						);
					}}
				>
					{copied ? <CheckIcon className="h-4 w-4" /> : null}
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			<p className="text-xs text-base-content/60">
				Anyone with this link can watch without an account. Their time counts as yours and is paid
				to the creator — from a separate {sharedBudgetLabel()} a month, so it never touches your{" "}
				{FREE_PUBLIC_ACCESS_HOURS} free hours.
			</p>
		</div>
	);
}
