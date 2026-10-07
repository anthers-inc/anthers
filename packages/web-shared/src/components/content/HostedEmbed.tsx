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

import { isSaveShimMessage, type SaveShimInbound } from "@anthers/shared/save-shim";
import { PlayIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";

/** A helper the handler uses to answer a frame through its own event.source. */
function postTo(source: MessageEventSource | null | undefined, message: SaveShimInbound): void {
	source?.postMessage(message);
}

interface HostedEmbedProps {
	workId: number;
	/** The viewer-resolved verdict to show the play button under. */
	title: string;
	/**
	 * The origin the frame answers on — what the parent validates incoming shim
	 * messages against. The play route's `src` names it; the parent derives the origin
	 * from the same src and refuses messages from anything else.
	 */
	deliveryOrigin?: string;
}

export default function HostedEmbed({ workId, title, deliveryOrigin }: HostedEmbedProps) {
	const [active, setActive] = useState(false);
	const [src, setSrc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pressed, setPressed] = useState(false);
	const frameRef = useRef<HTMLIFrameElement | null>(null);

	// ── The save-sync parent half ─────────────────────────────────────────────
	//
	// 🚨 **This page is the only side with authority.** The shim inside the frame
	// posts save bytes up; the parent (here) holds the session and makes the API
	// call. The sender is validated on both axes — same-origin as the minted frame
	// AND the actual frame object — before anything it says is acted on. This is the
	// wall the settled save design builds: a build can speak, but only to a parent
	// that checks who is speaking, and nothing the build says can act as the player
	// except within this one narrow channel (its own save slot).
	useEffect(() => {
		if (!active) return;
		let closed = false;

		const expectedOrigin = (() => {
			if (deliveryOrigin) return deliveryOrigin;
			if (!src) return null;
			try {
				return new URL(src).origin;
			} catch {
				return null;
			}
		})();

		const onMessage = async (event: MessageEvent) => {
			if (closed) return;
			if (event.source !== frameRef.current?.contentWindow) return;
			if (expectedOrigin && event.origin !== expectedOrigin) return;
			if (!isSaveShimMessage(event.data)) return;

			switch (event.data.type) {
				case "anthers-save:load": {
					// Restore: the cloud save (if any) goes down to the frame, which writes
					// it into its own store before the engine's boot pull runs.
					let blob: string | null = null;
					let updatedAt: string | undefined;
					try {
						const res = await client.api.content.works[":id"].save.$get({
							param: { id: String(workId) },
						});
						if (res.ok) {
							const body = (await res.json()) as {
								save: { blob: string; updatedAt: string } | null;
							};
							blob = body.save?.blob ?? null;
							updatedAt = body.save?.updatedAt;
						} else if (res.status === 402) {
							// No Badge: local saves keep working; say so passively.
							postTo(event.source, {
								type: "anthers-save:posture",
								syncing: false,
								reason: "badge",
							});
							return;
						}
					} catch {
						return; // A network miss restores nothing; the local save stands.
					}
					postTo(event.source, {
						type: "anthers-save:loaded",
						blob,
						...(updatedAt ? { updatedAt } : {}),
					});
					postTo(event.source, {
						type: "anthers-save:posture",
						syncing: true,
					});
					return;
				}
				case "anthers-save:put": {
					// The newest write wins: PUT the blob whole.
					try {
						const res = await client.api.content.works[":id"].save.$put({
							param: { id: String(workId) },
							json: { blob: event.data.blob, runtime: "godot" },
						});
						if (res.ok || res.status === 413) {
							postTo(event.source, {
								type: "anthers-save:ack",
								ok: res.ok,
								reason: res.ok ? undefined : "cap",
							});
						} else if (res.status === 402) {
							postTo(event.source, {
								type: "anthers-save:ack",
								ok: false,
								reason: "badge",
							});
						} else {
							postTo(event.source, {
								type: "anthers-save:ack",
								ok: false,
								reason: "error",
							});
						}
					} catch {
						postTo(event.source, { type: "anthers-save:ack", ok: false, reason: "error" });
					}
					return;
				}
				case "anthers-save:status": {
					postTo(event.source, {
						type: "anthers-save:posture",
						syncing: true,
					});
					return;
				}
			}
		};

		window.addEventListener("message", onMessage);
		return () => {
			closed = true;
			window.removeEventListener("message", onMessage);
		};
	}, [active, src, deliveryOrigin, workId]);

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
				ref={frameRef}
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
