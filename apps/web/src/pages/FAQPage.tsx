// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FAQ — restyled into the Meadow design 2026-08-14, because it was still the
// pre-design-pass page (a bare container, DaisyUI's default collapse) sitting one
// footer link away from /for-users and /for-creators. It now composes the same shared
// primitives they do: <MeadowDecor>, the hero/Section/Eyebrow rhythm, Fraunces over
// Nunito, and the closing band.
//
// ⚠️ **The questions themselves moved out on 2026-08-28** to `content/faq.tsx`, when the
// homepage, /for-creators and /subscribe each grew a short FAQ of their own. This page is
// the **union** — every question in the pool renders here, grouped by category — which is
// what lets each of those pages carry six and truthfully point at "the rest" rather than
// keeping a private copy of an answer to drift out of step. See the pool's header for the
// copy rules that govern the answers; the money figures are still generated, never typed.

import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Eyebrow, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { FAQAccordion } from "../components/ui/FAQ";
import { ALL_FAQ_ITEMS, FAQ_CATEGORIES } from "../content/faq";

const serif = { fontFamily: FONTS.fraunces };

export default function FAQPage() {
	return (
		<MeadowDecor floor={false} style={{ fontFamily: FONTS.nunito }}>
			{/* Hero — the same three-beat fade the other marketing pages open with. */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Questions &amp; Answers
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-6xl"
						>
							How this place
							<br />
							<em className="font-medium text-primary not-italic">actually works</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-base-content/75">
							Where the money goes, what supporting does, what we haven't built yet. If something
							here reads like a dodge, tell us — we'd rather fix the answer than the wording.
						</p>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-16 -mt-4 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{FAQ_CATEGORIES.map((category, c) => (
				<Section key={category} tint={c % 2 === 1}>
					<Reveal>
						<Eyebrow>{category}</Eyebrow>
					</Reveal>
					<div className="mx-auto mt-8 flex max-w-3xl flex-col gap-3 text-left">
						{ALL_FAQ_ITEMS.filter((item) => item.category === category).map((item, i) => (
							<Reveal key={item.question} delay={i * 70}>
								<FAQAccordion item={item} />
							</Reveal>
						))}
					</div>
				</Section>
			))}

			{/* Closing — the same band shape /for-users and /for-creators end on. */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-24 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-12 w-12 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-3xl font-light leading-tight sm:text-4xl"
						>
							Still have questions?
						</h2>
						<p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-base-content/70">
							The long version of nearly all of this is written down and public.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/about" className="btn btn-primary rounded-lg px-7">
								About Anthers
							</Link>
							<Link
								to="/resources"
								className="btn btn-outline rounded-lg border-base-content/20 px-7"
							>
								Resources
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</MeadowDecor>
	);
}
