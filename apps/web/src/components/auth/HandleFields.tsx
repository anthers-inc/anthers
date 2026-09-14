// SPDX-License-Identifier: Apache-2.0
/**
 * The two identity fields signup asks for: a handle Anthers issues, and a Bluesky handle.
 *
 * Shared by `/subscribe`, where a signup begins, and `/finish`, where somebody resuming a signup
 * in another browser chooses or confirms its identity. ⚠️ **One copy, because the markup is
 * load-bearing in ways that are easy to break** — the sizer that keeps the suffix flush against
 * the typed name, the label that makes the whole box clickable, and the status line that must
 * never change height — and a second copy is where one of those would be quietly lost.
 */
import { type HandleStatus, handleStatusLine, handleStatusTone } from "../../lib/hosted-handle";

/**
 * The line under a handle field, held open on BOTH doors whether or not it has anything to say.
 *
 * ⚠️ **It is always two lines tall, and the Bluesky field reserves it too.** The Anthers field
 * reports on the name as somebody types — checking, taken, yours — so its line must not grow
 * with its message, or the button moves out from under the pointer heading for it. One line is
 * not enough, because at 390px the longest of these messages wraps. The Bluesky field says
 * something here only when it has a refusal to report, and holds the same line open otherwise so
 * the two panels are the same height and switching tabs never resizes the card. `2lh` follows
 * the line height, so tightening the leading tightens the reservation with it.
 */
export const FIELD_STATUS = "mt-1 min-h-[2lh] text-xs leading-tight";

/** The margin a button under one of these fields takes, so every panel is the same height. */
export const FIELD_BUTTON_GAP = "mt-2";

export function HostedHandleField({
	id,
	label = "What would you like to be called?",
	name,
	onNameChange,
	status,
	suffix,
	refusal,
}: {
	id: string;
	label?: string;
	/** The name being typed — just the name, never the suffix. */
	name: string;
	onNameChange: (value: string) => void;
	/** What the availability check last said about `name`. */
	status: HandleStatus;
	/** The suffix issued handles hang under, as the API reports it. Empty until it answers. */
	suffix: string;
	/**
	 * A refusal from the server for the name as submitted, shown in place of the availability
	 * line. ⚠️ The caller clears it when the name changes, because it describes a name that is no
	 * longer in the field.
	 */
	refusal?: string | null;
}) {
	return (
		<>
			<label className="label px-0 pb-1" htmlFor={id}>
				<span className="text-sm font-semibold">{label}</span>
			</label>
			{/* A handle is a domain name, so this is `text` with a URL keyboard and no
			    autocapitalization — the same treatment the Bluesky field gets, for the same
			    reason. */}
			{/* ⭐ **The suffix lives in the field rather than in a sentence under it** (Parker,
			    2026-09-08, following Bluesky's own signup). A line saying *"your handle will end
			    in .anthers.social"* is an explanation of something the field could simply show,
			    and showing it means an empty field already reads `.anthers.social` and a filled
			    one reads the whole handle as it will exist.

			    ⚠️ **The input sizes itself to its own content, which is what puts the suffix
			    immediately after what somebody typed instead of against the far edge.** An
			    invisible copy of the value holds the box open and the input is laid over it, taken
			    OUT of flow. Sharing a grid cell with the sizer does not work, because a text input
			    contributes its own intrinsic width to that cell and wins whenever the value is
			    short, which leaves a character of dead space between the name and a suffix that
			    should be flush against it. `whitespace-pre` is load-bearing too: without it a
			    trailing space collapses and the suffix jumps left while the caret does not.

			    🚨 **The box is a `<label>` for the field, and that is what makes it clickable.**
			    The input itself is only as wide as what has been typed — a single space's width
			    while empty — so without the label nearly every click in the box lands on the
			    `@`, the suffix or the padding and focuses nothing. */}
			<label
				htmlFor={id}
				className="input input-bordered flex w-full items-center gap-0 overflow-hidden"
			>
				<span aria-hidden="true" className="shrink-0 text-base-content/40">
					@
				</span>
				<span className="relative min-w-0 shrink">
					<input
						id={id}
						type="text"
						inputMode="url"
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="none"
						// ⚠️ **`size={1}` is what lets the sizer decide the width.** An input carries an
						// intrinsic width of about twenty characters, and that intrinsic width would win
						// over an empty sizer and put the suffix against the far edge of the box.
						size={1}
						aria-label="The handle you'd like"
						aria-describedby={`${id}-status`}
						className="absolute inset-0 w-full bg-transparent p-0 outline-none"
						value={name}
						onChange={(e) => onNameChange(e.target.value)}
					/>
					{/* ⚠️ **A single space when empty, rather than a minimum width on the input.** A
					    minimum on the input survives into the typed state and leaves a gap between the
					    name and the suffix. */}
					<span aria-hidden="true" className="invisible block whitespace-pre">
						{name || " "}
					</span>
				</span>
				{/* The suffix is not editable and not part of what anybody types, so it is text
				    rather than a value — which is also what lets an empty field read as the domain a
				    handle will hang under. */}
				<span aria-hidden="true" className="shrink-0 text-base-content/40">
					.{suffix || "anthers.social"}
				</span>
			</label>
			<p
				id={`${id}-status`}
				aria-live="polite"
				className={`${FIELD_STATUS} ${refusal ? "text-error" : handleStatusTone(status)}`}
			>
				{refusal || handleStatusLine(status)}
			</p>
		</>
	);
}

/**
 * Whether a handle Anthers could issue is one the button may submit.
 *
 * ⚠️ Refused only for what is knowably wrong. A name that could not be checked — the API was
 * unreachable — still goes through, because the node is the authority and a browser that could
 * not ask has learned nothing about the name.
 */
export function hostedNameSubmittable(name: string, status: HandleStatus): boolean {
	return !!name.trim() && status.status !== "invalid" && status.status !== "taken";
}

export function BlueskyHandleField({
	id,
	label = "What’s your handle?",
	value,
	onChange,
	refusal,
}: {
	id: string;
	label?: string;
	value: string;
	onChange: (value: string) => void;
	/** Something to say about the handle, in the reserved line — a refusal from the last attempt. */
	refusal?: string | null;
}) {
	return (
		<>
			<label className="label px-0 pb-1" htmlFor={id}>
				<span className="text-sm font-semibold">{label}</span>
			</label>
			{/* A handle is a domain name, so this is `text` with a URL keyboard rather than an
			    `email`-shaped field. The `@` is drawn in the box, the same as on the Anthers field,
			    because it is how people write a handle and not part of one — so one typed anyway is
			    stripped on submit rather than fought with while typing. The box is a `<label>` so a
			    click anywhere in it, the `@` included, lands in the field. */}
			<label htmlFor={id} className="input input-bordered flex w-full items-center gap-0">
				<span aria-hidden="true" className="shrink-0 text-base-content/40">
					@
				</span>
				<input
					id={id}
					type="text"
					inputMode="url"
					autoComplete="username"
					spellCheck={false}
					autoCapitalize="none"
					placeholder="alice.bsky.social"
					aria-label="Bluesky handle"
					className="min-w-0 flex-1 bg-transparent p-0 outline-none"
					value={value}
					onChange={(e) => onChange(e.target.value)}
				/>
			</label>
			<p aria-live="polite" className={`${FIELD_STATUS} text-error`}>
				{refusal ?? ""}
			</p>
		</>
	);
}
