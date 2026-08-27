// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reporting illegal content, and what Anthers actually does about it.
 *
 * 🚨 **Every sentence here has to be true in the present tense, and the temptation is
 * the other direction.** Detection went live on 2026-08-26 and this page had to change the
 * same day, because it had said plainly that nothing was scanned — a sentence that was
 * true that morning and false by the evening. That is the failure mode to watch for here:
 * not a lie anybody wrote, but a true sentence left alone while the system moved. The honest version is also the more distinctive one,
 * on exactly the reasoning that made the privacy policy say plainly that we do not
 * verify anyone's age. If a sentence below stops being true, this page is wrong before
 * the marketing is.
 *
 * 🚨 **It publishes the posture, the limits that close for nobody, and eventually the
 * transparency counts — never the current coverage map.** Naming which surfaces go
 * unscanned *today* is an evasion map with a shelf life. The one absence that does
 * belong here is the permanent one: an encrypted or obfuscated archive cannot be
 * hash-scanned by anyone, because there is nothing to hash until it is opened. That is
 * true of every platform doing hash matching, it tells an adversary nothing they do not
 * already know, and stating it is what keeps the page from implying coverage it will
 * never have. Everything temporary — *"we do not unpack archives yet"* — stays in the
 * wiki (40.12).
 *
 * **Why this route rather than `/abuse`.** The subject-named URL matches the
 * `/privacy` · `/terms` · `/copyright` · `/parents` family and leaves room for the rest
 * of the trust-and-safety surface later; `/abuse` redirects here so the RFC 2142 name
 * providers and researchers guess still lands somewhere (Parker, 2026-08-25).
 *
 * 🚨 **It points away from copyright rather than absorbing it.** Copyright
 * notice-and-action and illegal-content notice-and-action are separate duties under
 * separate statutes, and somebody scanning a copyright page for where to report child
 * sexual abuse material is a bad two minutes to design. `/copyright` points here for the
 * same reason, in the other direction.
 */

import {
	MODERATION_REASON_GROUPS,
	MODERATION_REASONS,
	reasonsInGroup,
} from "@anthers/shared/moderation";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useState } from "react";

/** The address on the NCMEC registration. A constant here, and a re-notification to move. */
const ABUSE_EMAIL = "abuse@anthers.org";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mt-10">
			<h2 className="mb-3 text-xl font-bold">{title}</h2>
			<div className="space-y-3 leading-relaxed text-base-content/90">{children}</div>
		</section>
	);
}

export default function SafetyPage() {
	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">Reporting Illegal Content</h1>
			<p className="mt-3 text-lg text-base-content/70">
				Anyone can report illegal content on Anthers. You do not need an account, and you do not
				need to tell us who you are.
			</p>

			<div className="mt-6 rounded-box border border-base-300 bg-base-200 p-5">
				<p className="font-semibold">
					If a child is in immediate danger, contact the police first.
				</p>
				<p className="mt-2 text-base-content/80">
					In the United States, the NCMEC CyberTipline takes reports of child sexual exploitation at{" "}
					<a
						href="https://report.cybertip.org"
						className="link"
						rel="noreferrer noopener"
						target="_blank"
					>
						report.cybertip.org
					</a>{" "}
					or 1-800-843-5678. You can report to them directly, whether or not you tell us.
				</p>
			</div>

			<Section title="How to Report">
				<p>
					Use the form at the bottom of this page, or email us at{" "}
					<a href={`mailto:${ABUSE_EMAIL}`} className="link font-semibold">
						{ABUSE_EMAIL}
					</a>
					. Both reach the same place. The address is monitored, and a report about a child's safety
					raises an alert rather than waiting in a queue.
				</p>
				<p>
					Tell us <strong>where</strong> — the exact link — and <strong>what</strong> is wrong. We
					cannot act on a report we cannot locate, and the link is the part people most often leave
					out.
				</p>
				<p>
					{/* Points away rather than absorbing. Two duties, two statutes, two processes. */}
					<strong>Copyright is a different process.</strong> If work of yours has been published
					here without permission, that is a formal notice with legal requirements we cannot meet on
					your behalf — file it at{" "}
					<Link to="/copyright" className="link">
						Copyright
					</Link>{" "}
					instead. Nothing on this page can remove content for a copyright claim.
				</p>
				<p>
					If you are signed in and want to report a comment, review, or person rather than illegal
					content, the report control on the item itself is the faster route — it tells us exactly
					what you are looking at.
				</p>
			</Section>

			<Section title="What Happens Next">
				<p>
					A report of child sexual abuse material, the enticement of a child, or child sex
					trafficking goes to a named person here, out of band, rather than sitting in a queue until
					somebody opens it. Reports of threats and other illegal content take the same route.
				</p>
				<p>
					When we find that material is what a report says it is, we take it out of reach of
					everybody — including anyone who paid for it — and we{" "}
					<strong>preserve it rather than deleting it</strong>. That is not our choice: US federal
					law requires a provider who reports child sexual abuse material to preserve what the
					report names for a year, and destroying it would be a crime. It is also why{" "}
					<Link to="/privacy" className="link">
						our deletion promises
					</Link>{" "}
					have an exception for material under a legal preservation order.
				</p>
				<p>
					<strong>Reporting to authorities is done by a person, not by a machine.</strong> We do not
					file automatically on a suspicion, because a wrongly-filed report is its own harm to
					whoever it names.
				</p>
				<p>
					<strong>We may not be able to tell you what happened.</strong> If you leave an email
					address we will confirm we received your report, and where we can say more we will — but
					what we do about a specific account is often something we are not free to discuss.
				</p>
			</Section>

			<Section title="What We Do, and What We Do Not Do Yet">
				<p>
					Anthers is small and new, and we would rather tell you where we actually stand than
					describe a system we have not finished building.
				</p>
				<p>
					<strong>
						Uploaded images are checked against databases of known child sexual abuse material.
					</strong>{" "}
					We are still extending that to other kinds of media, and alongside it we act on what
					people report to us and what we find ourselves.
				</p>
				<p>
					{/* The privacy half, stated here as well as in the privacy policy, because the
					    person reading THIS page is the one wondering what we do with their files. */}
					<strong>Your files do not leave Anthers to be checked.</strong> We calculate a short
					mathematical fingerprint of an image — not the picture, and nothing anyone could turn back
					into it — and ask whether that fingerprint is known. A fingerprint that matches nothing,
					which is very nearly all of them, tells the other side nothing whatsoever about you or
					what you uploaded.
				</p>
				<p>
					<strong>We do not monitor what you read, watch, or say.</strong> There is no automated
					review of comments or messages, and there will not be one that reads private
					communication.
				</p>
				<p>
					{/* The one absence that closes for nobody — see the module note. */}
					<strong>One limit will not close, however much we build.</strong> Detection of known
					material works by comparing a file against a database of known files. An encrypted or
					password-protected archive cannot be compared by anyone, because there is nothing to
					compare until it is opened. That is true of every platform doing this, and it is why
					reports from people are not a fallback for detection — they are part of how this works.
				</p>
			</Section>

			<Section title="What We Do Not Act On">
				{/* 🚨 The refusal lives HERE rather than in the report dialog, and the length is
				    the reason. Anything short enough to fit beside a radio button reads as the
				    concession rather than as the refusal, and an early draft that tried to fit
				    it into a hint ended up listing queer lives as an example of mature work —
				    asserting exactly the premise this paragraph exists to refuse. Wiki 40.09. */}
				<p>
					<strong>
						Work about queer lives is routinely reported as sexual content on other platforms.
					</strong>{" "}
					It is not sexual content, and we do not act on reports that treat it as such. A queer
					character existing in a story does not make it adult material. Neither does a trans
					character, a same-sex relationship, or a discussion of identity. Reports of that kind are
					closed without action, however many of them arrive.
				</p>
				<p>
					The same distinction runs through everything on this page:{" "}
					<strong>a subject is not the same as its treatment.</strong> Work <em>about</em> violence,
					addiction or sex is not the thing it depicts, and difficult art is not a rule-break. What
					we act on is what a work does, not what it is about.
				</p>
			</Section>

			<Section title="Where the Rules Are Written Down">
				<p>
					What is and is not allowed here is in the{" "}
					<Link to="/terms" className="link">
						Terms of Service
					</Link>
					. What we collect and how long we keep it, including the preservation exception above, is
					in the{" "}
					<Link to="/privacy" className="link">
						Privacy Policy
					</Link>
					. If you are a parent trying to work out what this place is,{" "}
					<Link to="/parents" className="link">
						For Parents
					</Link>{" "}
					is written for you.
				</p>
			</Section>

			<Section title="Report Something">
				<AbuseReportForm />
			</Section>
		</div>
	);
}

/**
 * The no-account report form.
 *
 * Posts to `POST /api/moderation/abuse-reports`, which is public and unauthenticated —
 * DSA Art. 16 requires the mechanism be open to anyone, and the authenticated report
 * endpoint is not that. Two fields are required: the location and what is wrong. The
 * email address is optional and the label says why, because asking for it without saying
 * it is optional is how an anonymous route quietly becomes an identified one.
 */
function AbuseReportForm() {
	const [url, setUrl] = useState("");
	const [reason, setReason] = useState("illegal");
	const [details, setDetails] = useState("");
	const [reporterEmail, setReporterEmail] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setResult(null);
		try {
			const res = await apiFetch("/api/moderation/abuse-reports", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url, reason, details, reporterEmail }),
			});
			if (res.status === 201) {
				const body = await res.json();
				setResult({
					ok: true,
					message: `Your report has reached us (reference #${body.reportId}). Somebody will read it.`,
				});
				setUrl("");
				setDetails("");
				setReporterEmail("");
			} else {
				const body = await res.json().catch(() => ({}));
				setResult({
					ok: false,
					message:
						body.error ||
						`Something went wrong sending that. Please email ${ABUSE_EMAIL} instead — do not let this stop you reporting.`,
				});
			}
		} catch {
			setResult({
				ok: false,
				message: `Something went wrong sending that. Please email ${ABUSE_EMAIL} instead — do not let this stop you reporting.`,
			});
		} finally {
			setSubmitting(false);
		}
	}

	const chosen = MODERATION_REASONS.find((r) => r.value === reason);

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">Link to what you are reporting</span>
				</div>
				<input
					type="text"
					required
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://anthers.org/works/..."
					className="input input-bordered w-full"
				/>
				<p className="mt-1 text-sm text-base-content/60">
					Paste the address from your browser. If you cannot get a link, describe where it is below.
				</p>
			</label>

			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">What is wrong</span>
				</div>
				{/* Grouped, in the same two groups and the same order as the in-app dialog. The
				    split is legal versus rule-breaking rather than urgent versus not, and a flat
				    list here would present a piece of spam and a report of child sexual abuse
				    material as the same class of thing. */}
				<select
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					className="select select-bordered w-full"
				>
					{MODERATION_REASON_GROUPS.map((group) => (
						<optgroup key={group.key} label={group.heading.toUpperCase()}>
							{reasonsInGroup(group.key).map((r) => (
								<option key={r.value} value={r.value}>
									{r.label}
								</option>
							))}
						</optgroup>
					))}
				</select>
				{chosen ? <p className="mt-1 text-sm text-base-content/60">{chosen.hint}</p> : null}
				{/* The same confirmation the in-app dialog poses, and it has to be here too: a
				    select cannot interrupt, so this warns in place and offers the switch as a
				    control rather than as advice. Splitting the old single sexual reason made
				    it possible to file something involving a minor as a rule-break, and this is
				    one of the three things that stop it. */}
				{chosen?.confirm ? (
					// A plain bordered block rather than `alert`, whose default two-column grid
					// squeezes the button into a four-line column at every width this form has.
					<div className="mt-2 rounded-box border border-warning bg-warning/15 p-4 text-sm">
						<p>{chosen.confirm.question}</p>
						<button
							type="button"
							className="btn btn-sm btn-neutral mt-3"
							onClick={() => setReason(chosen.confirm!.switchTo)}
						>
							{chosen.confirm.switchLabel}
						</button>
					</div>
				) : null}
			</label>

			<label className="form-control w-full">
				<div className="label">
					<span className="label-text font-semibold">Tell us what you saw</span>
				</div>
				<textarea
					required
					minLength={10}
					rows={5}
					value={details}
					onChange={(e) => setDetails(e.target.value)}
					placeholder="What is on the page, and why you think it breaks the law."
					className="textarea textarea-bordered w-full"
				/>
				{/* Stated at the field rather than in a policy paragraph nobody reaches. */}
				<p className="mt-1 text-sm text-base-content/60">
					Please describe it rather than attaching or re-uploading anything.
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
					Only so we can confirm we received this and ask a question if we have one. Leave it blank
					and your report still counts.
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
