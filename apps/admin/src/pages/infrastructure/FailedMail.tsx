// SPDX-License-Identifier: Apache-2.0
/**
 * Failed mail — the send the app decided to make and the provider did not complete.
 *
 * 🚨 **Deliberately a page, not an alert** (Parker, 2026-10-08): a send-time alert would
 * train the ops channel to skim exactly the failures worth reading, which is how the
 * escalation channel learned the cost of noisy mail (390 fixture alerts in one hour).
 * This page is where an operator who is already curious looks — and the rule that makes
 * the looking honest is that it must be visibly empty when nothing is wrong, the same way
 * the queue health page is.
 *
 * The three lists name three distinct failures, NOT one failure in three copies:
 *
 * - **Unsent notifications** — the app intended an email (`emailIntended` recorded before
 *   the send was attempted) and no `emailSentAt` ever landed. The provider refused, the
 *   key was missing, or the process died mid-send. These are the ones an operator may
 *   want to re-run by hand; the in-app copy still exists, so the person was told here if
 *   not in their inbox.
 * - **Refused receipts** — `receipt_sends.sent = false`. A money record nobody got.
 *   There is no in-app copy for money (the settled decision), so a refused receipt is a
 *   person genuinely not told.
 * - **Bounced or complained** — the provider ACCEPTED the send and the receiving side
 *   answered against it later, matched from Resend's webhook on the provider message id.
 *   A bounced receipt is the person-not-told case one layer deeper; a repeated bounce on
 *   one address is the "this inbox is dead" signal worth acting on before the next
 *   essential notice to it fails the same way.
 *
 * Read-only by design: nothing here re-sends, because a re-send that bypasses the
 * dedupe latch is the double-mail failure `receipt_sends` exists to stop. The action an
 * operator takes is off-platform (reply to the address, check the provider's dashboard)
 * and the page says so rather than pretending a button would be safe.
 */
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../../components/ui";
import { useAdminData } from "../../lib/load";

interface FailedNote {
	id: number;
	kind: string;
	category: string;
	title: string;
	email: string | null;
	createdAt: string;
	deliveryEvent: string | null;
	deliveryEventAt: string | null;
}

interface RefusedReceipt {
	id: number;
	kind: string;
	role: string;
	email: string;
	createdAt: string;
}

interface BouncedReceipt {
	id: number;
	kind: string;
	role: string;
	email: string;
	sent: boolean;
	createdAt: string;
	deliveryEvent: string;
	deliveryEventAt: string | null;
}

interface FailedMailResponse {
	failedNotes: FailedNote[];
	refusedReceipts: RefusedReceipt[];
	bouncedOrWorse: BouncedReceipt[];
}

function shortDate(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

const EVENT_LABELS: Record<string, string> = {
	bounced: "Bounced",
	failed: "Failed",
	complained: "Marked spam",
	canceled: "Canceled",
};

function eventLabel(event: string): string {
	return EVENT_LABELS[event] ?? event;
}

export default function FailedMail() {
	const { data, loading, error, reload } =
		useAdminData<FailedMailResponse>("/api/admin/failed-mail");

	if (loading) return <Loading />;
	if (error) return <ErrorAlert>{error}</ErrorAlert>;
	if (!data) return <ErrorAlert>No response.</ErrorAlert>;

	const total = data.failedNotes.length + data.refusedReceipts.length + data.bouncedOrWorse.length;

	return (
		<div>
			<PageHeader
				title="Failed Mail"
				description={
					total === 0
						? "No failed sends. Every email the app decided to send was accepted, and nothing bounced."
						: "Sends the app intended that did not complete. Nothing here re-sends from this page — reply to the address or check the provider's dashboard, and fix the underlying cause."
				}
				onRefresh={reload}
				loading={loading}
			/>

			{total === 0 && (
				<div className="alert alert-success">
					<span>All clear.</span>
				</div>
			)}

			{data.failedNotes.length > 0 && (
				<section className="mb-8">
					<SectionHeading>Unsent notifications ({data.failedNotes.length})</SectionHeading>
					<p className="text-sm text-base-content/60 mb-3">
						The app decided to email these and the send never completed. The in-app copy still
						exists — these people were told here, just not in their inbox.
					</p>
					<ul className="flex flex-col gap-2">
						{data.failedNotes.map((n) => (
							<li key={n.id} className="rounded-box border border-warning bg-base-100 p-4">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span className="badge badge-warning">Unsent</span>
									<span className="badge badge-ghost">{n.category}</span>
									<span className="font-medium">{n.title}</span>
									<span className="ml-auto text-xs text-base-content/60">
										{shortDate(n.createdAt)}
									</span>
								</div>
								<p className="text-xs text-base-content/60 mt-1">
									kind <code>{n.kind}</code>
									{n.email && (
										<>
											{" · "}
											<a className="link" href={`mailto:${n.email}`}>
												{n.email}
											</a>
										</>
									)}
								</p>
							</li>
						))}
					</ul>
				</section>
			)}

			{data.refusedReceipts.length > 0 && (
				<section className="mb-8">
					<SectionHeading>Refused receipts ({data.refusedReceipts.length})</SectionHeading>
					<p className="text-sm text-base-content/60 mb-3">
						The provider refused these money emails outright. There is no in-app copy of a receipt —
						these people were not told, full stop.
					</p>
					<ul className="flex flex-col gap-2">
						{data.refusedReceipts.map((r) => (
							<li key={r.id} className="rounded-box border border-error bg-base-100 p-4">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span className="badge badge-error">Refused</span>
									<span className="badge badge-ghost">
										{r.kind} · {r.role}
									</span>
									<a className="link" href={`mailto:${r.email}`}>
										{r.email}
									</a>
									<span className="ml-auto text-xs text-base-content/60">
										{shortDate(r.createdAt)}
									</span>
								</div>
							</li>
						))}
					</ul>
				</section>
			)}

			{data.bouncedOrWorse.length > 0 && (
				<section className="mb-8">
					<SectionHeading>Bounced ({data.bouncedOrWorse.length})</SectionHeading>
					<p className="text-sm text-base-content/60 mb-3">
						The provider accepted these and the receiving side answered against them — reported by
						Resend's webhook. A repeat on one address is a dead inbox; the next essential notice to
						it will fail the same way.
					</p>
					<ul className="flex flex-col gap-2">
						{data.bouncedOrWorse.map((r) => (
							<li key={r.id} className="rounded-box border border-error bg-base-100 p-4">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span className="badge badge-error">{eventLabel(r.deliveryEvent)}</span>
									<span className="badge badge-ghost">
										{r.kind} · {r.role}
									</span>
									<a className="link" href={`mailto:${r.email}`}>
										{r.email}
									</a>
									<span className="ml-auto text-xs text-base-content/60">
										{shortDate(r.deliveryEventAt)}
									</span>
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
