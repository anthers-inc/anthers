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
 */

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
	}, []);

	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">Copyright & DMCA</h1>
			<p className="mt-3 text-lg text-base-content/70">
				How to report copyright infringement on Anthers, and what happens next.
			</p>

			<Section title="DMCA designated agent">
				{agent?.registered ? (
					<div className="alert alert-info">
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
				</ol>
			</Section>

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
				<p className="text-sm text-base-content/70">
					This policy is stated in our [Terms of Service](/terms) and [Creator
					Terms](/creator-terms), and you agreed to it when you signed up.
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

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<label className="label" htmlFor="workId">
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
					<label className="label" htmlFor="name">
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
					<label className="label" htmlFor="email">
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
				<label className="label" htmlFor="address">
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
				<label className="label" htmlFor="phone">
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
				<label className="label" htmlFor="copyrightedWork">
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
				<label className="label" htmlFor="infringingMaterial">
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
