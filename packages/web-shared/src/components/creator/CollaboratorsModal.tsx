// SPDX-License-Identifier: Apache-2.0
/**
 * The collaborators list behind a {@link ComboAvatar}.
 *
 * It is deliberately the app's ordinary person card, not a bespoke row: the same avatar,
 * name, handle, follower count, Follow control and profile link a reader meets on a
 * creator listing. A shared Badge's co-owner is a creator to meet, and the modal is the
 * place the reader chooses which of them to follow or visit.
 */
import type { BadgeOwner } from "../../lib/types";
import Modal from "../ui/Modal";
import CreatorCard from "./CreatorCard";

export default function CollaboratorsModal({
	owners,
	open,
	onClose,
}: {
	owners: BadgeOwner[];
	open: boolean;
	onClose: () => void;
}) {
	return (
		<Modal open={open} label="Collaborators">
			<div className="modal-box max-w-lg">
				<button
					type="button"
					className="btn btn-sm btn-circle btn-ghost absolute top-2 right-2"
					onClick={onClose}
					aria-label="Close"
				>
					✕
				</button>
				<h3 className="text-lg font-bold">Collaborators</h3>
				<p className="mt-1 text-sm text-base-content/60">
					The creators who share this. Follow any of them, or open their page.
				</p>
				<div className="mt-4 space-y-2">
					{owners.map((owner) => (
						<CreatorCard key={owner.id} creator={owner} />
					))}
				</div>
			</div>
		</Modal>
	);
}
