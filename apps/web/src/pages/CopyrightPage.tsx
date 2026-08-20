// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The copyright / DMCA page.
 *
 * § 512(c)(2) requires the designated agent's name, address, phone and email
 * to be "available through the service, including on the website in a location
 * accessible to the public." This page is that location, and it also carries
 * the notice intake form, the counter-notice information, and the repeat-
 * infringer policy.
 *
 * 🚨 Unlike the other legal pages, this one does NOT use `effectiveDate: null`
 * for a "not yet in force" banner. A statutory agent designation is either
 * registered or it isn't — there is no "pending" state, because the § 512
 * safe harbour does not apply until the registration is on file. So the page
 * gates on `DMCA_AGENT_REGISTERED`: when the agent is registered, the details
 * render; when not, the page says "we are in the process of designating our
 * DMCA agent" and the rest of the page (how to file, how to counter-file, the
 * repeat-infringer policy) is still visible.
 *
 * The notice form posts to `POST /api/dmca/notices` — the six required
 * elements (§ 512(c)(3)(A)(i)–(vi)) are individual fields so a rejection can
 * name which one failed. Email to `copyright@anthers.org` is the statutory
 * fallback a web form cannot replace, and is stated alongside the form.
 *
 * The page serves three audiences, and only the first is obvious:
 *
 * 1. **A rights holder** — the agent details and the notice form.
 * 2. **A creator whose work came down** (`MyNotices`, added 2026-08-16). The
 *    counter-notice existed only as an API endpoint until then, so the takedown
 *    notification pointed a creator at a page explaining a right they had no way
 *    to exercise. A remedy nobody can reach is not a remedy. This half also
 *    carries the *concede* action, which is the answer nobody thinks to build.
 * 3. **Anyone at all** — the transparency counts, which are what make the
 *    repeat-infringer policy legible rather than merely asserted.
 *
 * 🚨 The counter-notice exposure is rendered ABOVE the fields, not beside the
 * submit button. For a pseudonymous creator, whether to counter-notice *is* the
 * decision, and it must be made before they have already typed their home
 * address in.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mt-10">
			<h2 className="mb-3 text-xl font-bold">{title}</h2>
			<div className="space-y-3 leading-relaxed text-base-content/90">{children}</div>
		</section>
	);
}

interface DmcaAgentConfig {
	registered: boolean;
	agentName: string;
	agentAddress: string;
	agentEmail: string;
	agentPhone: string;
}

interface AttestationText {
	notice: string;
	counterNotice: string;
}

/** A notice filed against one of the signed-in creator's own Works. */
interface MyNotice {
	id: number;
	status: string;
	workTitle: string;
	complainantName: string;
	copyrightedWorkDescription: string;
	infringingMaterialDescription: string;
	actionedAt: string | null;
	counterNoticeDueBy: string | null;
	counterNoticeFiledAt: string | null;
	restoreNoEarlierThan: string | null;
	suitFiledAt: string | null;
	finalizedAt: string | null;
}

/** Aggregate notice counts — see `dmcaSummary` in the API for what is and isn't published. */
interface DmcaCounts {
	received: number;
	screening: number;
	actioned: number;
	rejected: number;
	counterNoticed: number;
	restored: number;
	withdrawn: number;
	total: number;
}

const SIX_ELEMENTS: { label: string; hint: string }[] = [
	{
		label: "Your name (signature)",
		hint: "A physical or electronic signature of a person authorized to act on behalf of the copyright owner.",
	},
	{
		label: "Identification of the copyrighted work",
		hint: "Describe the copyrighted work you claim is infringed, or a representative list if there are multiple.",
	},
	{
		label: "Identification of the infringing material",
		hint: "Identify the material you claim is infringing, with enough information for us to locate it.",
	},
	{ label: "Your contact information", hint: "Your address, telephone number, and email address." },
	{
		label: "Good-faith belief statement",
		hint: "A statement that you have a good faith belief that the use is not authorized by the owner, its agent, or the law.",
	},
	{
		label: "Authorization statement",
		hint: "A statement that the information is accurate and, under penalty of perjury, that you are authorized to act on behalf of the owner.",
	},
];

export default function CopyrightPage() {
	const [agent, setAgent] = useState<DmcaAgentConfig | null>(null);
	const [attestation, setAttestation] = useState<AttestationText | null>(null);
	const [counts, setCounts] = useState<DmcaCounts | null>(null);
	const [myNotices, setMyNotices] = useState<MyNotice[]>([]);
	const { user } = useAuth();

	useEffect(() => {
		window.scrollTo(0, 0);
		apiFetch("/api/dmca/config")
			.then((r) => r.json())
			.then(setAgent)
			.catch(() => {});
		apiFetch("/api/dmca/attestation")
			.then((r) => r.json())
			.then(setAttestation)
			.catch(() => {});
		apiFetch("/api/dmca/transparency")
			.then((r) => r.json())
			.then(setCounts)
			.catch(() => {});
	}, []);

	// Gated on being signed in rather than firing and handling the 401. The
	// endpoint refuses a stranger either way, so this is not the access control —
	// it is that /copyright is a page a signed-out rights holder is *expected* to
	// land on, and greeting every one of them with a 401 in the console makes the
	// page look broken to anyone who looks.
	useEffect(() => {
		if (!user) {
			setMyNotices([]);
			return;
		}
		apiFetch("/api/dmca/notices/mine")
			.then((r) => (r.ok ? r.json() : { notices: [] }))
			.then((d) => setMyNotices(d.notices ?? []))
			.catch(() => {});
	}, [user]);

	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">Copyright & DMCA</h1>
			<p className="mt-3 text-lg text-base-content/70">
				How to report copyright infringement on Anthers, and what happens next.
			</p>

			<Section title="DMCA designated agent">
				{agent?.registered ? (
					<div className="alert alert-info">
						{/* 🚨 ONE child, deliberately. daisyUI's `.alert` is a grid with
						    `grid-auto-flow: column`, so every direct child becomes its own COLUMN —
						    the three that used to sit here laid out side by side and pushed the last
						    one 56px past a 390px viewport. Nothing errors and it looks fine on a
						    desktop, which is why `mobile-overflow.e2e.ts` is what found it. */}
						<div>
							<p>Our DMCA designated agent, registered with the U.S. Copyright Office:</p>
							<div className="mt-2 text-sm">
								<p className="font-semibold">{agent.agentName}</p>
								<p>{agent.agentAddress}</p>
								<p>{agent.agentPhone}</p>
								<p>
									<a className="link link-primary" href={`mailto:${agent.agentEmail}`}>
										{agent.agentEmail}
									</a>
								</p>
							</div>
							<p className="mt-3 text-sm">
								You can also file a notice by email to{" "}
								<a className="link link-primary" href={`mailto:${agent.agentEmail}`}>
									{agent.agentEmail}
								</a>
								. A web form can be offered but cannot be required — email to the agent is the
								statutory path.
							</p>
						</div>
					</div>
				) : (
					<div className="alert alert-warning">
						<p>
							We are in the process of designating our DMCA agent. Until the registration is on file
							with the U.S. Copyright Office, the § 512 safe harbour does not apply to Anthers. If
							you need to report copyright infringement, please contact us at{" "}
							<a className="link link-primary" href="mailto:contact@anthers.org">
								contact@anthers.org
							</a>
							.
						</p>
					</div>
				)}
			</Section>

			<Section title="How to file a copyright notice">
				<p>
					A DMCA notice under 17 U.S.C. § 512(c)(3)(A) must include <strong>all six</strong> of the
					following elements. You can file using the form below, or by email to our designated
					agent. A notice missing required elements may be rejected — we will tell you what is
					missing and how to fix it.
				</p>
				<ol className="list-decimal space-y-2 pl-6">
					{SIX_ELEMENTS.map((el, i) => (
						<li key={i}>
							<strong>{el.label}.</strong> {el.hint}
						</li>
					))}
				</ol>
				<p className="text-sm text-base-content/70">
					We will review your notice and act on it promptly. We do not automatically remove material
					— a human reviews every notice. If your notice is facially defective, we will contact you
					to help you correct it rather than discarding it silently.
				</p>
				<p className="text-sm text-base-content/70">
					<strong>Under § 512(f)</strong>, a person who knowingly materially misrepresents that
					material is infringing — or that it was removed by mistake — may be subject to liability
					for damages.
				</p>
			</Section>

			<Section title="File a notice">
				<DmcaNoticeForm attestation={attestation?.notice ?? null} />
			</Section>

			<Section title="What happens after you file">
				<ol className="list-decimal space-y-2 pl-6">
					<li>We review your notice. A human looks at every one — nothing is automated.</li>
					<li>
						If the notice is valid, we remove the material <strong>promptly</strong> and notify the
						creator, who has the right to file a counter-notice.
					</li>
					<li>
						If the notice is missing required elements, we contact you to help you correct it rather
						than discarding it.
					</li>
					<li>
						If the creator files a counter-notice, we forward it to you and the material is restored
						in 10–14 business days — unless you file a court action to restrain them first.
					</li>
					<li>
						If no counter-notice arrives within 10 business days, or the creator concedes, the
						removal is <strong>final</strong> — and anyone who had bought the work is refunded in
						full.
					</li>
				</ol>
			</Section>

			<Section title="If you bought something that is taken down">
				<p>
					Everywhere else on Anthers, <strong>what you buy, you keep</strong>. A copyright takedown
					is the one case where a third party — not you, and not the creator — can take that away,
					and we would rather say so plainly here than let you find out.
				</p>
				<p>
					If a work you bought is removed following a copyright notice, you lose access to it and{" "}
					<strong>we refund what you paid, in full</strong>. Continuing to deliver the work to you
					would mean continuing to infringe, so keeping the promise is not something we are able to
					choose.
				</p>
				<p className="text-sm text-base-content/70">
					<strong>The refund comes when the removal is final</strong>, not the moment the work comes
					down — the creator has 10 business days to answer the notice, and a work that comes back
					is a sale that was never wrong. If the creator does answer and the work is restored, it
					returns to sale rather than to your library: your money has already come back to you, and
					buying it again is your choice to make.
				</p>
				<p className="text-sm text-base-content/70">
					A refund for a takedown never counts against your refund limit. It was not your decision.
				</p>
			</Section>

			<MyNotices notices={myNotices} attestation={attestation?.counterNotice ?? null} />

			<Section title="Counter-notice">
				<p>
					If your work is removed following a DMCA notice and you believe it was a mistake or
					misidentification, you can file a counter-notice under § 512(g)(3).
				</p>
				<div className="alert alert-warning">
					<p className="font-semibold">A counter-notice exposes your identity.</p>
					<p className="mt-1 text-sm">
						A counter-notice requires your <strong>legal name</strong>,{" "}
						<strong>postal address</strong>, and <strong>telephone number</strong>, plus your
						consent to federal jurisdiction. These details are forwarded to the complainant. For a
						pseudonymous creator, this is not a remedy — it is a second exposure. Read the full
						attestation before deciding.
					</p>
				</div>
				<p className="text-sm text-base-content/70">
					If you file a counter-notice, the material is restored in 10–14 business days unless the
					complainant files a court action. If they do, the material stays down until the court
					decides.
				</p>
			</Section>

			<Section title="Repeat-infringer policy">
				<p>
					We terminate the accounts of users who repeatedly infringe copyright, in appropriate
					circumstances. What counts as "appropriate circumstances" is a human decision, made case
					by case — we do not use an automatic strike counter, because that turns a bad notice into
					an instant penalty and a good-faith mistake into a strike.
				</p>
				<p>
					A termination is a decision a person makes and records, and you can ask us why and get a
					real answer. We publish no strike threshold — a stated number invites gaming from both
					directions, and § 512(i) does not ask for one.
				</p>
				<p className="text-sm text-base-content/70">
					This policy is stated in our{" "}
					<Link className="link link-primary" to="/terms">
						Terms of Service
					</Link>{" "}
					and{" "}
					<Link className="link link-primary" to="/creator-terms">
						Creator Terms
					</Link>
					, and you agreed to it when you signed up.
				</p>
			</Section>

			<Section title="What we do not do">
				<ul className="list-disc space-y-1 pl-6">
					<li>
						<strong>No automated removal.</strong> § 512(m) means we owe nobody a filter, and a
						human reviews every notice. Automated removal is the thing that turns a bad notice into
						an instant outcome.
					</li>
					<li>
						<strong>No content matching or fingerprinting.</strong> We do not scan, match, or
						fingerprint uploads. The same no-third-party-data posture that applies everywhere else
						on Anthers applies here.
					</li>
					<li>
						<strong>No catalog-wide removal.</strong> One notice takes down the identified Work —
						never a creator's entire catalog, and never an account.
					</li>
				</ul>
			</Section>

			<TransparencySection counts={counts} />

			<div className="mt-12 border-t border-base-300 pt-6 text-sm text-base-content/60">
				<p>
					Questions about this process go to{" "}
					<a className="link link-primary" href="mailto:contact@anthers.org">
						contact@anthers.org
					</a>
					, or Anthers, Inc., PO Box 21233, Denver, CO 80221.
				</p>
			</div>
		</div>
	);
}

function formatDate(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * The creator's side: notices filed against their own Works, with the two
 * answers they can give.
 *
 * Without this the counter-notice existed only as an API endpoint, and the
 * takedown notification pointed a creator at a page that explained a right they
 * had no way to exercise. A remedy nobody can reach is not a remedy.
 *
 * Renders nothing for a signed-out visitor or a creator with no notices, so the
 * page reads the same for everyone else.
 */
function MyNotices({ notices, attestation }: { notices: MyNotice[]; attestation: string | null }) {
	if (notices.length === 0) return null;

	return (
		<Section title="Notices about your work">
			<p>
				These are copyright notices filed against Works you published. Nobody else can see this
				section.
			</p>
			{notices.map((notice) => (
				<MyNoticeCard key={notice.id} notice={notice} attestation={attestation} />
			))}
		</Section>
	);
}

function MyNoticeCard({ notice, attestation }: { notice: MyNotice; attestation: string | null }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [subscriberName, setSubscriberName] = useState("");
	const [subscriberAddress, setSubscriberAddress] = useState("");
	const [subscriberPhone, setSubscriberPhone] = useState("");
	const [agreed, setAgreed] = useState(false);

	const answered = notice.status !== "actioned" || notice.counterNoticeFiledAt != null;

	async function submitCounter(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/dmca/notices/${notice.id}/counter`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subscriberName,
					subscriberAddress,
					subscriberPhone,
					jurisdictionConsent: attestation ?? "I consent to federal jurisdiction.",
					goodFaithStatement:
						"I swear under penalty of perjury that the material was removed as a result of mistake or misidentification.",
				}),
			});
			const body = await res.json();
			if (!res.ok) {
				setError(body.error ?? "Could not file the counter-notice.");
				return;
			}
			setDone(
				`Counter-notice filed. Your name, address and telephone number have been forwarded to ${notice.complainantName}. The work is restored on or after ${formatDate(body.restoreNoEarlierThan)} unless they file a court action.`,
			);
		} catch {
			setError("Could not file the counter-notice. Please try again.");
		} finally {
			setBusy(false);
		}
	}

	async function concede() {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/dmca/notices/${notice.id}/concede`, { method: "POST" });
			const body = await res.json();
			if (!res.ok) {
				setError(body.error ?? "Could not record that.");
				return;
			}
			setDone(
				body.buyersRefunded > 0
					? `Recorded. ${body.buyersRefunded} buyer${body.buyersRefunded === 1 ? " has" : "s have"} been refunded.`
					: "Recorded. There were no buyers to refund.",
			);
		} catch {
			setError("Could not record that. Please try again.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-box border border-base-300 p-4">
			<h3 className="font-bold">{notice.workTitle || "A Work of yours"}</h3>
			<p className="mt-1 text-sm text-base-content/70">
				Filed by <strong>{notice.complainantName}</strong>
				{notice.actionedAt ? ` · removed ${formatDate(notice.actionedAt)}` : ""}
			</p>
			<p className="mt-2 text-sm">
				<strong>They say they own:</strong> {notice.copyrightedWorkDescription}
			</p>
			<p className="mt-1 text-sm">
				<strong>And that this infringes it:</strong> {notice.infringingMaterialDescription}
			</p>

			{notice.counterNoticeFiledAt && (
				<p className="mt-3 text-sm">
					You filed a counter-notice on {formatDate(notice.counterNoticeFiledAt)}.{" "}
					{notice.suitFiledAt
						? "They have filed a court action, so the work stays down until a court decides."
						: `The work is restored on or after ${formatDate(notice.restoreNoEarlierThan)}.`}
				</p>
			)}
			{notice.status === "restored" && <p className="mt-3 text-sm">This work is back up.</p>}
			{notice.finalizedAt && notice.status === "actioned" && (
				<p className="mt-3 text-sm text-base-content/70">
					This removal is settled and any buyers have been refunded. You can still answer it — the
					deadline governed the refunds, not your right to reply.
				</p>
			)}

			{done && <div className="alert alert-success mt-3 text-sm">{done}</div>}
			{error && <div className="alert alert-error mt-3 text-sm">{error}</div>}

			{!answered && !done && (
				<>
					{notice.counterNoticeDueBy && (
						<p className="mt-3 text-sm">
							If you do nothing by <strong>{formatDate(notice.counterNoticeDueBy)}</strong>, we
							treat the removal as final and refund anyone who bought this work.
						</p>
					)}
					<div className="mt-3 flex flex-wrap gap-2">
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={() => setOpen((v) => !v)}
						>
							{open ? "Cancel" : "File a counter-notice"}
						</button>
						<button
							type="button"
							className="btn btn-sm btn-ghost"
							disabled={busy}
							onClick={concede}
						>
							I agree the notice was right
						</button>
					</div>

					{open && (
						<form className="mt-4 space-y-3" onSubmit={submitCounter}>
							{/* The exposure sits ABOVE the fields, not beside the submit button.
							    For a pseudonymous creator this is the decision, and it has to be
							    made before they have already typed their address in. */}
							<div className="alert alert-warning text-sm">
								<div>
									<p className="font-semibold">
										Everything you enter below is sent to {notice.complainantName}.
									</p>
									<p className="mt-1">
										A counter-notice requires your legal name, postal address and telephone number,
										and your consent to be sued in federal court where you live. We are required to
										forward all of it to them. If you publish under a name that is not your own,
										this hands your accuser your identity and your address.
									</p>
								</div>
							</div>

							<label className="form-control">
								<span className="label-text">Your legal name</span>
								<input
									className="input input-bordered"
									required
									value={subscriberName}
									onChange={(e) => setSubscriberName(e.target.value)}
								/>
							</label>
							<label className="form-control">
								<span className="label-text">Your postal address</span>
								<textarea
									className="textarea textarea-bordered"
									required
									rows={2}
									value={subscriberAddress}
									onChange={(e) => setSubscriberAddress(e.target.value)}
								/>
							</label>
							<label className="form-control">
								<span className="label-text">Your telephone number</span>
								<input
									className="input input-bordered"
									required
									value={subscriberPhone}
									onChange={(e) => setSubscriberPhone(e.target.value)}
								/>
							</label>

							{attestation && (
								<pre className="whitespace-pre-wrap rounded-box bg-base-200 p-3 text-xs">
									{attestation}
								</pre>
							)}
							<label className="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									className="checkbox checkbox-sm mt-0.5"
									checked={agreed}
									onChange={(e) => setAgreed(e.target.checked)}
								/>
								<span>
									I have read the above, I swear to it under penalty of perjury, and I understand
									that my contact details are forwarded to the person who filed the notice.
								</span>
							</label>

							<button type="submit" className="btn btn-primary" disabled={busy || !agreed}>
								{busy ? "Filing…" : "File counter-notice"}
							</button>
						</form>
					)}
				</>
			)}
		</div>
	);
}

/**
 * The transparency numbers — Phase 6.1, Parker's call to publish (2026-08-16).
 *
 * Counts only. No per-notice detail: publishing a notice publishes the
 * complainant's contact details and identifies the creator, which is a privacy
 * decision rather than a default. Lumen-style per-notice publication is deferred,
 * not declined.
 *
 * ⚠️ The honest caveat is rendered on the page rather than kept in a comment: at
 * launch volumes these numbers are close to naming someone, and a reader deserves
 * to know that before drawing a conclusion from "1".
 */
function TransparencySection({ counts }: { counts: DmcaCounts | null }) {
	// Render nothing at all rather than a row of zeroes on a failed fetch — a
	// zero we did not measure is a claim we did not make.
	if (!counts) return null;

	const rows: { label: string; value: number; hint: string }[] = [
		{ label: "Notices received", value: counts.total, hint: "Every notice filed, by any route." },
		{
			label: "Acted on",
			value: counts.actioned,
			hint: "A work was removed following the notice.",
		},
		{
			label: "Rejected",
			value: counts.rejected,
			hint: "Facially defective. We contacted the sender to help them correct it.",
		},
		{
			label: "Counter-noticed",
			value: counts.counterNoticed,
			hint: "The creator answered under § 512(g)(3).",
		},
		{ label: "Restored", value: counts.restored, hint: "The work went back up." },
		{
			label: "Withdrawn",
			value: counts.withdrawn,
			hint: "The complainant withdrew the notice.",
		},
	];

	return (
		<Section title="Transparency">
			<p>
				What this process has actually done, in numbers. A repeat-infringer policy nobody can see
				the shape of is a claim rather than a practice.
			</p>
			<div className="overflow-x-auto">
				<table className="table table-sm">
					<tbody>
						{rows.map((row) => (
							<tr key={row.label}>
								<th className="font-semibold">{row.label}</th>
								<td className="font-mono text-lg">{row.value}</td>
								<td className="text-sm text-base-content/70">{row.hint}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-sm text-base-content/70">
				We publish counts and not notices. Publishing a notice would publish the complainant's name,
				address and telephone number, and would identify the creator it names — so per-notice
				publication is a decision we have deferred rather than one we have taken by default.
			</p>
			<p className="text-sm text-base-content/70">
				<strong>Read small numbers carefully.</strong> While these totals are low, a single count
				beside a work that visibly went missing can identify the people involved. We would rather
				publish them from the start than begin only once there is volume to hide in.
			</p>
		</Section>
	);
}

function DmcaNoticeForm({ attestation }: { attestation: string | null }) {
	const [workId, setWorkId] = useState("");
	const [complainantName, setComplainantName] = useState("");
	const [complainantEmail, setComplainantEmail] = useState("");
	const [complainantAddress, setComplainantAddress] = useState("");
	const [complainantPhone, setComplainantPhone] = useState("");
	const [copyrightedWork, setCopyrightedWork] = useState("");
	const [infringingMaterial, setInfringingMaterial] = useState("");
	const [goodFaith, setGoodFaith] = useState(false);
	const [authorized, setAuthorized] = useState(false);
	const [fairUse, setFairUse] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setResult(null);
		try {
			const res = await apiFetch("/api/dmca/notices", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workId: Number(workId),
					complainantName,
					complainantEmail,
					complainantAddress,
					complainantPhone,
					copyrightedWorkDescription: copyrightedWork,
					infringingMaterialDescription: infringingMaterial,
					goodFaithStatement: goodFaith
						? "I have a good faith belief that the use is not authorized."
						: "",
					authorizationStatement: authorized
						? "The information is accurate and I am authorized to act."
						: "",
					fairUseConsidered: fairUse,
				}),
			});
			if (res.status === 201) {
				const body = await res.json();
				setResult({
					ok: true,
					message: `Your notice has been filed (reference #${body.noticeId}). We will review it and act on it promptly.`,
				});
			} else {
				const body = await res.json().catch(() => ({}));
				setResult({
					ok: false,
					message:
						body.error || body.message || "Something went wrong. Please try again or email us.",
				});
			}
		} catch {
			setResult({ ok: false, message: "Network error. Please try again or email us." });
		}
		setSubmitting(false);
	}

	if (result?.ok) {
		return (
			<div className="alert alert-success">
				<p>{result.message}</p>
			</div>
		);
	}

	// ⚠️ Every `.label` here carries `whitespace-normal` for the same reason `FormField`
	// does: daisyUI sets `white-space: nowrap` on `.label`, so a statutory prompt like
	// "Identify the copyrighted work you claim is infringed" renders as one 405px line and
	// scrolls the page sideways on a phone. This form hand-rolls its labels rather than
	// using `FormField`, so it does not inherit that component's fix — keep the class on
	// any label added below.
	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<label className="label whitespace-normal" htmlFor="workId">
					<span className="label-text font-semibold">Work ID</span>
				</label>
				<input
					id="workId"
					type="number"
					required
					min={1}
					className="input input-bordered w-full"
					value={workId}
					onChange={(e) => setWorkId(e.target.value)}
					placeholder="The numeric ID of the Work (from its URL)"
				/>
				<p className="mt-1 text-xs text-base-content/60">
					Found in the Work's URL: <code>/works/{"{slug}-{id}"}</code> — the number after the dash.
				</p>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<label className="label whitespace-normal" htmlFor="name">
						<span className="label-text font-semibold">Your name</span>
					</label>
					<input
						id="name"
						required
						className="input input-bordered w-full"
						value={complainantName}
						onChange={(e) => setComplainantName(e.target.value)}
					/>
				</div>
				<div>
					<label className="label whitespace-normal" htmlFor="email">
						<span className="label-text font-semibold">Your email</span>
					</label>
					<input
						id="email"
						type="email"
						required
						className="input input-bordered w-full"
						value={complainantEmail}
						onChange={(e) => setComplainantEmail(e.target.value)}
					/>
				</div>
			</div>

			<div>
				<label className="label whitespace-normal" htmlFor="address">
					<span className="label-text font-semibold">Your postal address</span>
				</label>
				<textarea
					id="address"
					required
					rows={2}
					className="textarea textarea-bordered w-full"
					value={complainantAddress}
					onChange={(e) => setComplainantAddress(e.target.value)}
				/>
			</div>

			<div>
				<label className="label whitespace-normal" htmlFor="phone">
					<span className="label-text font-semibold">Your telephone number</span>
				</label>
				<input
					id="phone"
					className="input input-bordered w-full"
					value={complainantPhone}
					onChange={(e) => setComplainantPhone(e.target.value)}
				/>
			</div>

			<div>
				<label className="label whitespace-normal" htmlFor="copyrightedWork">
					<span className="label-text font-semibold">
						Identify the copyrighted work you claim is infringed
					</span>
				</label>
				<textarea
					id="copyrightedWork"
					required
					rows={3}
					className="textarea textarea-bordered w-full"
					value={copyrightedWork}
					onChange={(e) => setCopyrightedWork(e.target.value)}
					placeholder="e.g. 'My original game Example Quest, released 2024'"
				/>
			</div>

			<div>
				<label className="label whitespace-normal" htmlFor="infringingMaterial">
					<span className="label-text font-semibold">
						Identify the material you claim is infringing
					</span>
				</label>
				<textarea
					id="infringingMaterial"
					required
					rows={3}
					className="textarea textarea-bordered w-full"
					value={infringingMaterial}
					onChange={(e) => setInfringingMaterial(e.target.value)}
					placeholder="e.g. 'The Work at this URL is a copy of my game'"
				/>
			</div>

			{attestation && (
				<div className="rounded-lg bg-base-200 p-4 text-sm leading-relaxed">
					<p className="mb-2 font-semibold">Attestations you are making:</p>
					<pre className="whitespace-pre-wrap font-sans text-sm text-base-content/80">
						{attestation}
					</pre>
				</div>
			)}

			<div className="space-y-2">
				<label className="flex cursor-pointer items-start gap-3">
					<input
						type="checkbox"
						checked={goodFaith}
						onChange={(e) => setGoodFaith(e.target.checked)}
						className="checkbox checkbox-sm mt-0.5"
					/>
					<span className="text-sm">
						I have a good faith belief that the use of the material in the manner complained of is
						not authorized by the copyright owner, its agent, or the law.
					</span>
				</label>
				<label className="flex cursor-pointer items-start gap-3">
					<input
						type="checkbox"
						checked={authorized}
						onChange={(e) => setAuthorized(e.target.checked)}
						className="checkbox checkbox-sm mt-0.5"
					/>
					<span className="text-sm">
						The information in this notice is accurate, and under penalty of perjury I am authorized
						to act on behalf of the owner of the exclusive right that is allegedly infringed.
					</span>
				</label>
				<label className="flex cursor-pointer items-start gap-3">
					<input
						type="checkbox"
						checked={fairUse}
						onChange={(e) => setFairUse(e.target.checked)}
						className="checkbox checkbox-sm mt-0.5"
					/>
					<span className="text-sm">
						I have considered whether the use I am reporting is a fair use, and I believe it is not.
					</span>
				</label>
			</div>

			{result && !result.ok && (
				<div className="alert alert-error">
					<p>{result.message}</p>
				</div>
			)}

			<button
				type="submit"
				disabled={submitting || !goodFaith || !authorized}
				className="btn btn-primary"
			>
				{submitting ? "Filing…" : "File notice"}
			</button>
			<p className="text-xs text-base-content/60">
				You can also file by email to our designated agent. A web form can be offered but cannot be
				required.
			</p>
		</form>
	);
}
