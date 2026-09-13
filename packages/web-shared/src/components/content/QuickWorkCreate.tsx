// SPDX-License-Identifier: Apache-2.0
/**
 * Make a Work without leaving the post or Project you are in the middle of — a type, a
 * file, a title, and nothing else.
 *
 * 🚨 **This is deliberately the lesser path and must stay that way** (Parker, 2026-09-11).
 * The dedicated flow at `/studio/works/new` is the better one, so this is the quiet second
 * action inside `WorkPicker` rather than a prominent button, and it exists only so that
 * realizing mid-post that the Work does not exist yet is not a reason to abandon the post.
 *
 * ⭐ **Keeping it small is what keeps the two invariants for free.** A Work made here is
 * born `private` and `unrated`, exactly as `POST /works` makes one: there is no release
 * control to refuse, because `POST /works` rejects `visibility: "released"` outright, and
 * no rating control to default, because the question belongs where the release is. What
 * the creator gets instead is a link to the Work's own page to finish it.
 *
 * ⚠️ **Don't grow this into a second editor.** Every field that arrives here is a field
 * that stops existing in one place, and the reason the Work got a page was that its
 * authoring surface had outgrown a dialog.
 */

import { useState } from "react";
import { client } from "../../lib/rpc";
import type { UploadableWorkType, Work, WorkInput } from "../../lib/types";
import FormField from "../ui/FormField";
import { useWorkMedia } from "./work-media";
import { LIBRARY_TYPE_OPTIONS } from "./works";

interface QuickWorkCreateProps {
	/** Called with the created Work, which the caller links or shelves. */
	onCreated: (work: Work) => void;
	onClose: () => void;
}

export default function QuickWorkCreate({ onCreated, onClose }: QuickWorkCreateProps) {
	const [type, setType] = useState<UploadableWorkType>("video");
	const [title, setTitle] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const media = useWorkMedia(type, null);

	const create = async () => {
		setSaving(true);
		setError(null);
		const input: WorkInput & { type: UploadableWorkType } = { type, ...media.fields() };
		if (title.trim()) input.title = title.trim();
		// A single image is its own thumbnail; everything else gets one on its own page.
		if (type === "image" && media.imageKey) input.thumbnail = media.imageKey;
		try {
			const res = await client.api.content.works.$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "Failed to create this Work.");
				return;
			}
			const { work } = await res.json();
			onCreated(work as Work);
		} catch {
			setError("Failed to create this Work.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-lg flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">New Work</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<p className="text-sm text-base-content/60">
					Enough to make it and attach it here. It stays private until you set its access and
					release it on its own page.
				</p>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<FormField label="Type">
					<select
						className="select select-bordered w-full"
						value={type}
						onChange={(e) => setType(e.target.value as UploadableWorkType)}
					>
						{LIBRARY_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</FormField>

				{media.slot}

				<FormField label="Title">
					<input
						type="text"
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Work title"
					/>
				</FormField>

				<div className="modal-action mt-0">
					<button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-primary"
						onClick={create}
						disabled={saving || media.uploading || !media.ready}
						title={media.ready ? undefined : "Add the file for this Work's type first"}
					>
						{saving ? "Creating…" : "Create Work"}
					</button>
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
