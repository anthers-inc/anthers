// SPDX-License-Identifier: Apache-2.0
/**
 * The Anthers save shim's message contract — the one vocabulary both ends of the
 * save-sync channel speak.
 *
 * 🚨 **The channel exists because the session cannot.** A build runs on its own
 * delivery origin where the Anthers session never arrives (the privacy policy's
 * promise), so a build must never call the save API itself — and must never be ABLE to.
 * The bridge is postMessage: the shim inside the frame posts to `window.parent`, and
 * the parent (the Work page or the play page, which holds the session) makes the API
 * call. Everything in this module declares only the message shape; everything with
 * authority lives on the parent.
 *
 * 🚨 **The parent validates the sender.** A frame's messages arrive from whatever the
 * frame loaded; `event.origin` is checked against the delivery host it minted, and the
 * `source` is the frame it minted. A message from anywhere else is dropped. This
 * module carries the shared shape so both ends cannot drift; the carrying of it is
 * each side's own code.
 *
 * The message vocabulary is deliberately tiny — put/loaded/taken — and the sync
 * posture is the settled one: newest write wins, full stop; the local save is the
 * floor; sync is the perk. A shim that speaks nothing saves locally, exactly as
 * before.
 */

/** What the shim inside the frame sends up. */
export type SaveShimOutbound =
	/** The frame booted and wants any cloud save for this Work, before/at engine boot. */
	| { type: "anthers-save:load" }
	/**
	 * The engine flushed its persistent filesystem; here are the bytes. Sent on sync
	 * points (Godot's `user://` flushes) and on page teardown. The parent decides what
	 * to do — usually PUT — never the frame.
	 */
	| { type: "anthers-save:put"; blob: string; note?: string }
	/** The frame asks what the sync posture is (Badge held? last sync fine?). */
	| { type: "anthers-save:status" };

/** What the parent sends down. */
export type SaveShimInbound =
	/** A cloud save existed (or didn't) — the frame writes it into its filesystem before boot proceeds. */
	| { type: "anthers-save:loaded"; blob: string | null; updatedAt?: string }
	/** The parent took (or refused) the put; `ok: false` carries why, for a passive notice. */
	| { type: "anthers-save:ack"; ok: boolean; reason?: "badge" | "cap" | "access" | "error" }
	/** The posture: sync live, or local-only with the reason. */
	| {
			type: "anthers-save:posture";
			syncing: boolean;
			reason?: "badge" | "access" | "error";
			updatedAt?: string;
	  };

/** The shape both ends agree a message carries — one kind tag, one payload. */
export type SaveShimMessage = SaveShimOutbound | SaveShimInbound;

/** The `type` prefix, so a stray message from any other script is ignorable by kind. */
export function isSaveShimMessage(data: unknown): data is SaveShimMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { type?: unknown }).type === "string" &&
		(data as { type: string }).type.startsWith("anthers-save:")
	);
}
