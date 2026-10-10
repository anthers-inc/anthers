// SPDX-License-Identifier: Apache-2.0
/**
 * Email Library: every standard and automatic email Anthers sends, rendered with placeholder
 * data, and a test send of any of them.
 *
 * The point is cataloging and evaluating the templates as they really are — the preview
 * renders through the same template the product sends, never a second renderer, and every
 * entry carries example data only (nothing here reads production rows). The send posts one
 * template to the library's fixed recipient, one at a time by a button press: in a dev
 * session the mail catcher at `http://localhost:8025` shows it, and a public console sends
 * through Resend for real. The inbox preview is why the iframe is what it is — mail HTML
 * lives inside providers' markup with its own cascade, so `srcDoc` shows the body as a
 * message would carry it, `sandbox=""` keeps scripts and navigation out.
 */
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";

interface LibraryEntry {
	id: string;
	group: string;
	label: string;
	description: string;
	subject: string;
	html: string;
}

interface LibraryResponse {
	recipient: string;
	entries: LibraryEntry[];
}

/** What a test send answered: sent means provider acceptance, not arrival. */
interface SendResult {
	to: string;
	subject: string;
	sent: boolean;
	messageId: string | null;
}

/** Fixed-height preview: the body scrolls inside the frame rather than stretching the page. */
function EmailPreview({ html }: { html: string }) {
	return (
		<iframe
			title="Email preview"
			srcDoc={html}
			sandbox=""
			className="mt-2 h-[560px] w-full rounded border border-base-300 bg-white"
		/>
	);
}

/** One template: its description, the subject line the send carries, preview, and the send. */
function EmailCard({ entry, recipient }: { entry: LibraryEntry; recipient: string }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	const send = async () => {
		setBusy(true);
		setError(null);
		setDone(null);
		const result = await adminPost<SendResult>("/api/admin/email-library/send", {
			id: entry.id,
		});
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setDone(
			result.data.sent
				? `Sent to ${result.data.to} — check the inbox.`
				: "The provider did not accept the send (with no key or mail catcher, it went nowhere).",
		);
	};

	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<span className="text-sm font-semibold">{entry.label}</span>
					<p className="mt-1 text-xs text-base-content/60">{entry.description}</p>
					<p className="mt-1 text-xs text-base-content/45">
						subject: <span className="italic">{entry.subject}</span>
					</p>
				</div>
				<button type="button" className="btn btn-sm shrink-0" onClick={send} disabled={busy}>
					Send test
				</button>
			</div>
			<EmailPreview html={entry.html} />
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{done && <p className="mt-2 text-xs text-success">{done}</p>}
			{!error && !done && (
				<p className="mt-2 text-xs text-base-content/40">
					“Send test” sends this template, with this placeholder content, to {recipient}.
				</p>
			)}
		</div>
	);
}

export default function EmailLibrary() {
	const { data, loading, error } = useAdminData<LibraryResponse>("/api/admin/email-library");

	if (loading) return <Loading />;
	if (error) return <ErrorAlert>{error}</ErrorAlert>;
	if (!data) return null;

	const groups: string[] = [];
	for (const entry of data.entries) {
		if (!groups.includes(entry.group)) groups.push(entry.group);
	}

	return (
		<div>
			<PageHeader
				title="Email Library"
				description={`Every standard and automatic email Anthers sends, rendered with placeholder data. “Send test” posts a template to ${data.recipient} so it can be seen in a real inbox.`}
			/>
			{groups.map((group) => (
				<div className="mb-6" key={group}>
					<SectionHeading>{group}</SectionHeading>
					<div className="flex flex-col gap-4">
						{data.entries
							.filter((entry) => entry.group === group)
							.map((entry) => (
								<EmailCard key={entry.id} entry={entry} recipient={data.recipient} />
							))}
					</div>
				</div>
			))}
		</div>
	);
}
