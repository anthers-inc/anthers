// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FAQ accordion, and the block of them a marketing page ends on.
//
// Lifted out of `FAQPage.tsx` on 2026-08-28, when the homepage, /for-creators and
// /subscribe each gained a short FAQ of their own. The content lives in
// `content/faq.tsx`; this file is only how it looks.
//
// ⚠️ **The heading is generic and lives here, not on the pages.** Each page had its own
// eyebrow, title and lede introducing its FAQ — three pieces of bespoke copy saying the
// same thing in three voices, which is work to write, work to keep true, and worth
// nothing to a reader who can already see a stack of questions. One heading, used
// everywhere. A page that wants to say something particular can still say it above this;
// none of them needs to.

import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Eyebrow, H2 } from "@anthers/web-shared/decor/sections";
import { Link } from "@anthers/web-shared/router";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { type FAQItem, type FAQSurface, faqFor } from "../../content/faq";

/**
 * One question.
 *
 * A native `<details>` rather than DaisyUI's checkbox-and-sibling-selector collapse,
 * which is what this was. The checkbox version needed `useState` per row to hold a
 * value nothing else read, and it presented a *form control* to a screen reader for
 * something that is not a form — `<details>` announces as a disclosure, opens on Enter
 * and Space for free, and is findable by the browser's own in-page search when closed.
 * The arrow is drawn here because `list-style` on a summary is the one part of this
 * element browsers still disagree about.
 */
export function FAQAccordion({ item }: { item: FAQItem }) {
	return (
		<details className="group rounded-2xl border border-base-content/10 bg-base-100/80 shadow-sm transition-colors open:bg-base-100 hover:border-primary/30">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left text-sm font-medium marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
				{item.question}
				<ChevronDownIcon className="h-4 w-4 shrink-0 text-primary/60 transition-transform duration-200 group-open:rotate-180" />
			</summary>
			<div className="space-y-2 px-5 pb-5 text-sm leading-relaxed text-base-content/70">
				{typeof item.answer === "string" ? <p>{item.answer}</p> : item.answer}
			</div>
		</details>
	);
}

/**
 * The questions one page carries, plus the way out to the rest of them.
 *
 * 🚨 **The link to /faq is not decoration.** A page-level FAQ is a pruned selection —
 * six of twenty-odd questions — and the pruning is only honest if the reader whose
 * question was cut has somewhere to go. Dropping the link would turn a considered
 * shortlist into a page that appears to have answered everything it intends to.
 */
export function FAQBlock({ surface }: { surface: FAQSurface }) {
	return (
		<>
			<Reveal>
				<Eyebrow>FAQ</Eyebrow>
				<H2>Common questions</H2>
			</Reveal>
			<div className="mx-auto mt-10 flex max-w-3xl flex-col gap-3 text-left">
				{faqFor(surface).map((item, i) => (
					<Reveal key={item.question} delay={i * 70}>
						<FAQAccordion item={item} />
					</Reveal>
				))}
			</div>
			<Reveal delay={120}>
				<p className="mt-8 text-sm text-base-content/55">
					More of them, and the longer answers, on the{" "}
					<Link to="/faq" className="link text-primary decoration-primary/40">
						full FAQ
					</Link>
					.
				</p>
			</Reveal>
		</>
	);
}
