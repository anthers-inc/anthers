// SPDX-License-Identifier: Apache-2.0
/**
 * The Work page's hosted-browser-build player: the click-to-play frame for a build
 * Anthers serves itself, on the Work's own delivery origin.
 *
 * 🚨 **The play address is minted on press, never carried.** The Work payload carries
 * only `webPlayable` — a boolean the access verdict already decided — because a build's
 * play address is an entitlement: signed, expiring, and minted by
 * `GET /works/:id/play` at a moment the gates were just re-checked. Carrying a minted
 * address in the payload would put it in every serialized listing and every cache the
 * payload crosses; *How a File Reaches You* names that shape as the one the rule
 * refuses.
 *
 * The frame's sandbox is ProjectEmbed's, with the same reason: `allow-same-origin`
 * beside `allow-scripts` is only safe while the framed origin differs from the page's,
 * and a build's delivery origin is a different site from Anthers by design — that is
 * the whole hosting arrangement. A saved game in the frame lives in that origin's
 * storage, per Work.
 *
 * ⚠️ Owner shape note: the owner's own Work page also renders this — the owner passes
 * the same gates trivially (access says yes for the creator's own Work), and what they
 * see is what a player sees.
 */

import { PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import { client } from "../../lib/rpc";

interface HostedEmbedProps {
	workId: number;
	/** The viewer-resolved verdict to show the play button under. */
	title: string;
}

export default function HostedEmbed({ workId, title }: HostedEmbedProps) {
	const [active, setActive] = useState(false);
	const [src, setSrc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pressed, setPressed] = useState(false);

	const play = async () => {
		setPressed(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].play.$get({
				param: { id: String(workId) },
			});
			if (!res.ok) {
				// 402 carries the Public Access meter; other statuses are the access refusal
				// itself. Either way the user is told, the same way the players do it.
				const body = (await res.json()) as { error?: string; budget?: unknown };
				setError(body.error ?? "The play address could not be minted.");
				return;
			}
			const { src: playSrc } = (await res.json()) as { src: string };
			setSrc(playSrc);
			setActive(true);
		} catch {
			setError("The play address could not be minted.");
		} finally {
			setPressed(false);
		}
	};

	if (!active) {
		return (
			<div className="relative bg-base-300 rounded-lg overflow-hidden">
				<div className="flex flex-col items-center justify-center py-16 gap-4">
					<button
						type="button"
						className="btn btn-primary btn-lg gap-2"
						onClick={() => void play()}
						disabled={pressed}
					>
						<PlayIcon className="w-6 h-6" />
						Play in Browser
					</button>
					<p className="text-sm text-base-content/50">
						Runs hosted by Anthers, in a sandboxed frame
					</p>
					{error && <p className="text-sm text-error">{error}</p>}
				</div>
			</div>
		);
	}

	return (
		<div className="relative bg-black rounded-lg overflow-hidden">
			<div className="flex justify-end p-1 bg-base-300">
				<button type="button" className="btn btn-ghost btn-xs" onClick={() => setActive(false)}>
					<XMarkIcon className="w-4 h-4" />
					Close
				</button>
			</div>
			{/* Same sandbox pair as ProjectEmbed, same reason — see that component's note.
			    The src is the freshly minted play address; closing and replaying mints a new
			    one, so an expired token never lingers past the frame that held it. */}
			<iframe
				src={src ?? undefined}
				title={title}
				className="w-full"
				style={{ height: "480px" }}
				sandbox="allow-scripts allow-same-origin allow-popups"
				allowFullScreen
			/>
		</div>
	);
}
