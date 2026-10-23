// SPDX-License-Identifier: Apache-2.0
/**
 * The Accept/Decline row a person meets on a credit that names them.
 *
 * 🚨 **It renders from a server-issued fact and never decides identity for itself.** The
 * Work page renders it only where the user overlay set `awaitingYourConfirmation`, and the
 * creator's Credits tab only from the endpoint's `pending` list — which the server fills for
 * the account alone. The component takes the Work id and role because that pair is what the
 * acceptance keys on; who the viewer is was already settled upstream.
 *
 * One implementation for both surfaces: a person's word settles the same claim whether they
 * met it on the Work or in their own credits list.
 */

import { client } from "@anthers/web-shared/rpc";
import { useState } from "react";

export default function CreditConfirmationControls({
	workId,
	role,
	onDecided,
}: {
	workId: number;
	role: string;
	/**
	 * Re-read the surface after a decision lands, so it renders the server's own answer —
	 * accepted resolves to a name and leaves the pending list; declined removes the row.
	 */
	onDecided: () => void;
}) {
	const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const decide = async (verb: "accept" | "decline") => {
		setBusy(verb);
		setNotice(null);
		try {
			const res =
				verb === "accept"
					? await client.api.content.works[":id"].credits.accept.$post({
							param: { id: String(workId) },
							json: { role },
						})
					: await client.api.content.works[":id"].credits.reject.$post({
							param: { id: String(workId) },
							json: { role },
						});
			if (!res.ok) {
				// The server's own words — every refusal here is a decision the person can act
				// on (sign back in for the widened scope, the credit changed under them), and a
				// generic string turns all of them into "something went wrong".
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setNotice(body?.error ?? "Couldn't record that just now. Please try again.");
				return;
			}
			onDecided();
		} catch {
			setNotice("Couldn't record that just now. Please try again.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<span className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					className="btn btn-xs btn-primary"
					disabled={busy !== null}
					onClick={() => decide("accept")}
				>
					{busy === "accept" ? "Accepting…" : "Accept"}
				</button>
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					disabled={busy !== null}
					onClick={() => decide("decline")}
				>
					{busy === "decline" ? "Declining…" : "Decline"}
				</button>
			</span>
			{notice && <p className="w-full text-xs text-base-content/60">{notice}</p>}
		</>
	);
}
