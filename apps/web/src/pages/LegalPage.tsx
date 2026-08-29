// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The legal documents, served — and served **pending**.
 *
 * These were deliberately unbuilt for a week, because Privacy Policy was written as a
 * *specification* of what we wanted rather than a description of what existed, and a
 * policy describing features that don't exist is a misrepresentation the moment it is
 * published. That gate held until six of its nine markers were cleared.
 *
 * 🚨 **What makes serving them honest now is the `pending` state, not the fact that
 * most of it is true.** These carry **no effective date**, say plainly that they are
 * not yet in force, and are behind SiteGate. Parker's call, 2026-08-10: publish as
 * pending, date them as in force once the outstanding legal review clears.
 *
 * So there is exactly one rule for whoever touches this next: **do not give a document
 * an `effectiveDate` because the copy looks finished.** The copy looking finished is
 * the same hazard the vault banner named — the date is the thing that turns a draft
 * into a representation, and it is a decision somebody makes deliberately, not a
 * TODO to tidy up. It is one field per document in `content/legal`, and a test pins
 * every one of them to `null` so that dating a document has to be deliberate.
 *
 * Canonical text lives in the vault (`Privacy Policy`, `Terms of Service`, `Creator Terms`); this is the rendered
 * copy with the internal apparatus removed — no `⚠️ NOT YET BUILT` markers, no
 * DO-NOT-PUBLISH banner, and none of the "Notes for us" section, which is reasoning
 * rather than terms.
 */

import { Link, useLocation } from "@anthers/web-shared/router";
import { useEffect } from "react";
import { LEGAL_DOCUMENTS, type LegalDocument } from "../content/legal";

/** Renders one paragraph-ish block of the very small markdown subset these use. */
function Block({ text }: { text: string }) {
	// Headings
	if (text.startsWith("## ")) {
		return <h2 className="mt-10 mb-3 text-xl font-bold">{text.slice(3)}</h2>;
	}
	if (text.startsWith("### ")) {
		return <h3 className="mt-6 mb-2 text-lg font-semibold">{text.slice(4)}</h3>;
	}
	// Bullet groups
	if (text.startsWith("- ")) {
		return (
			<ul className="my-3 list-disc space-y-1 pl-6">
				{text.split("\n").map((line) => (
					<li key={line}>
						<Inline text={line.replace(/^- /, "")} />
					</li>
				))}
			</ul>
		);
	}
	return (
		<p className="my-3 leading-relaxed">
			<Inline text={text} />
		</p>
	);
}

/**
 * Bold and links only.
 *
 * Deliberately not a markdown library and deliberately not `dangerouslySetInnerHTML`:
 * this content ships in the bundle rather than arriving from a user, but rendering
 * legal text through an HTML sink is a habit worth not having — the post pipeline
 * sanitizes server-side at the write boundary precisely because that boundary is where
 * it belongs, and there is no such boundary here.
 */
function Inline({ text }: { text: string }) {
	const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
	return (
		<>
			{parts.map((part, i) => {
				if (part.startsWith("**") && part.endsWith("**")) {
					// biome-ignore lint/suspicious/noArrayIndexKey: split output, stable per render
					return <strong key={i}>{part.slice(2, -2)}</strong>;
				}
				const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
				if (link) {
					const [, label, href] = link;
					return href.startsWith("/") ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: split output, stable per render
						<Link key={i} to={href} className="link link-primary">
							{label}
						</Link>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: split output, stable per render
						<a key={i} href={href} className="link link-primary">
							{label}
						</a>
					);
				}
				// biome-ignore lint/suspicious/noArrayIndexKey: split output, stable per render
				return <span key={i}>{part}</span>;
			})}
		</>
	);
}

function PendingBanner({ doc }: { doc: LegalDocument }) {
	if (doc.effectiveDate) return null;
	return (
		<div className="alert alert-warning my-6 block">
			<p className="font-semibold">This isn't in force yet.</p>
			<p className="mt-1 text-sm">
				Anthers hasn't launched, and this document is published in advance so you can read it before
				it applies to anyone. It has no effective date, and we'll add one — and say so — when it
				takes effect. Until then it describes how we intend to operate, and everything in it that
				describes what the software does is already true.
			</p>
		</div>
	);
}

export default function LegalPage({ slug }: { slug: string }) {
	const doc = LEGAL_DOCUMENTS[slug];
	const { pathname } = useLocation();

	useEffect(() => {
		window.scrollTo(0, 0);
	}, [pathname]);

	if (!doc) {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="mb-2 text-2xl font-bold">Not Found</h1>
				<p className="text-base-content/60">There's no document here.</p>
			</div>
		);
	}

	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">{doc.title}</h1>
			<p className="mt-2 text-sm text-base-content/60">
				{doc.effectiveDate ? `In force since ${doc.effectiveDate}.` : "Not yet in force."}{" "}
				{doc.summary}
			</p>

			<PendingBanner doc={doc} />

			<div className="text-base-content/90">
				{doc.blocks.map((block) => (
					<Block key={block.slice(0, 60)} text={block} />
				))}
			</div>

			<div className="mt-12 border-t border-base-300 pt-6 text-sm text-base-content/60">
				<p>
					Questions about any of this go to{" "}
					<a className="link link-primary" href="mailto:privacy@anthers.org">
						privacy@anthers.org
					</a>
					, or Anthers, Inc., PO Box 21233, Denver, CO 80221.
				</p>
			</div>
		</div>
	);
}
