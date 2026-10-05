// SPDX-License-Identifier: Apache-2.0
/**
 * Reporting that something on Anthers is broken.
 *
 * 🚨 **This is not the abuse page, and the two must never merge or link-swap.** `/abuse`
 * is illegal-content notice-and-action — a statutory intake with a human escalation floor.
 * This page is plain bug intake about the site working wrong. A reporter who cannot tell
 * the difference is still routed safely: this page points at `/abuse` for content
 * problems in one sentence, and `/abuse` never points here, because it must not soften
 * what it is into "feedback".
 *
 * **No account is required, on purpose.** The person who hits the worst bugs is often
 * mid-signup or signed out by exactly the thing that is broken, so filing depends on no
 * session. One is read if present, so a signed-in reporter's report can name their
 * account later, but the form works signed out identically.
 *
 * The form posts to `POST /api/moderation/issue-reports`, which answers 201 with a
 * reference number and tells the reporter nothing about what happens next — what we do
 * with a report is operator information, the same silence every public intake keeps.
 * There is deliberately no promise of a reply: the email field is for us to ask a
 * question, not the beginning of a support ticket.
 */

import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useState } from "react";

/** Where the intake's rows are read. An address a person can also write to directly. */
const CONTACT_EMAIL = "support@anthers.org";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mt-10">
			<h2 className="mb-3 text-xl font-bold">{title}</h2>
			<div className="space-y-3 leading-relaxed text-base-content/90">{children}</div>
		</section>
	);
}

export default function IssueReportsPage() {
	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">Report an Issue</h1>
			<p className="mt-3 text-lg text-base-content/70">
				If something on Anthers is not working the way it should, tell us about it. You do not need
				an account, and you do not need to figure out whose bug it is. That is our job.
			</p>

			<Section title="What This Is For">
				<p>
					Broken pages, uploads that will not finish, playback that stutters, buttons that do
					nothing: anything where Anthers itself is misbehaving. Describe what you did, what you
					expected, and what happened instead.
				</p>
				<p>
					<strong>Problems with content or conduct belong on a different page.</strong> If something
					here breaks the law or breaks our rules, such as harmful material or harassment, report it
					at{" "}
					<Link to="/abuse" className="link">
						Report Abuse
					</Link>{" "}
					instead, where it reaches the process built for it.
				</p>
				<p>
					Copyright claims have their own formal process too, at{" "}
					<Link to="/copyright" className="link">
						Copyright
					</Link>
					.
				</p>
			</Section>

			<Section title="What Happens Next">
				<p>
					Every report is read by a person. What we take up joins the work shown on our{" "}
					<Link to="/roadmap" className="link">
						roadmap
					</Link>
					, and when a fix ships it is announced on the{" "}
					<Link to="/changelog" className="link">
						changelog
					</Link>
					, so what changed and when is public either way.
				</p>
				<p>
					We may not be able to reply to every report, especially ones filed anonymously. If you
					leave an email address we can ask a question if we have one, but an issue report is not a
					support ticket and there is nothing to track here.
				</p>
			</Section>

			<Section title="Report Something Broken">
				<IssueReportForm />
			</Section>
		</div>
	);
}

/**
 * The no-account issue form. Two required fields — what went wrong, and what happened —
 * plus an optional location and an optional email, both labeled as optional and why, so
 * the route never quietly becomes an identified one.
 */
function IssueReportForm() {
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [pageUrl, setPageUrl] = useState("");
	const [reporterEmail, setReporterEmail] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setResult(null);
		try {
			const res = await apiFetch("/api/moderation/issue-reports", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ summary, details, pageUrl, reporterEmail }),
			});
			if (res.status === 201) {
				const body = await res.json();
				setResult({
					ok: true,
					message: `Your report has reached us (reference #${body.issueId}). Thank you.`,
				});
				setSummary("");
				setDetails("");
				setPageUrl("");
				setReporterEmail("");
			} else {
				const body = await res.json().catch(() => ({}));
				setResult({
					ok: false,
					message:
						body.error ||
						`Something went wrong sending that. Please email ${CONTACT_EMAIL} instead.`,
				});
			}
		} catch {
			setResult({
				ok: false,
				message: `Something went wrong sending that. Please email ${CONTACT_EMAIL} instead.`,
			});
		}
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">In one line, what went wrong</span>
				</div>
				<input
					type="text"
					required
					minLength={5}
					maxLength={200}
					value={summary}
					onChange={(e) => setSummary(e.target.value)}
					placeholder="Upload button spins forever"
					className="input input-bordered w-full"
				/>
			</label>

			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">What happened</span>
				</div>
				<textarea
					required
					minLength={10}
					maxLength={4000}
					rows={6}
					value={details}
					onChange={(e) => setDetails(e.target.value)}
					placeholder="What you were doing, what you expected, and what happened instead. If an error message appeared, paste it here."
					className="textarea textarea-bordered w-full"
				/>
			</label>

			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">Where it happened (optional)</span>
				</div>
				<input
					type="text"
					value={pageUrl}
					onChange={(e) => setPageUrl(e.target.value)}
					placeholder="Paste the address from your browser, or describe the page"
					className="input input-bordered w-full"
				/>
				<p className="mt-1 text-sm text-base-content/60">
					Free to fill in however makes sense — a pasted link or a description both help.
				</p>
			</label>

			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">Your email (optional)</span>
				</div>
				<input
					type="email"
					value={reporterEmail}
					onChange={(e) => setReporterEmail(e.target.value)}
					placeholder="you@example.com"
					className="input input-bordered w-full"
				/>
				<p className="mt-1 text-sm text-base-content/60">
					Only so we can ask a question if we have one. Leave it blank and your report still counts.
				</p>
			</label>

			{result ? (
				<div className={`alert ${result.ok ? "alert-success" : "alert-error"}`}>
					<span>{result.message}</span>
				</div>
			) : null}

			<button type="submit" className="btn btn-primary" disabled={submitting}>
				{submitting ? "Sending…" : "Send Report"}
			</button>
		</form>
	);
}
