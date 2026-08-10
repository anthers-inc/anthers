// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * For parents and guardians.
 *
 * This page exists because of what Anthers **declined** to do. Patreon and others
 * carry a guardian-permission rule for under-18s; Anthers doesn't, on the grounds that
 * a rule nobody can check is a way of moving responsibility rather than accepting it,
 * and stating one would be pretending to enforce something we can't.
 *
 * The position that replaces it: *it is on us to build a healthy platform, and beyond
 * that parents get to be parents* — **which is only possible if a parent can find out
 * what this place actually is.** That is the whole job of this page, and it is why it
 * sits at a findable URL in plain language rather than as a clause in the terms.
 *
 * 🚨 **It must claim nothing we cannot back.** The reason it exists is that the
 * alternative was a rule we'd have been pretending to enforce, so a reassuring
 * sentence we can't stand behind would reproduce the exact failure it was written to
 * avoid. Every control named here is one that shipped. If something below stops being
 * true, this page is wrong before the marketing is.
 *
 * It deliberately landed AFTER blocking and person-reporting rather than before, for
 * the same reason.
 */

import { Link } from "@anthers/web-shared/router";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mt-10">
			<h2 className="mb-3 text-xl font-bold">{title}</h2>
			<div className="space-y-3 leading-relaxed text-base-content/90">{children}</div>
		</section>
	);
}

export default function ParentsPage() {
	return (
		<div className="container mx-auto max-w-3xl px-4 py-10">
			<h1 className="text-3xl font-bold">For parents and guardians</h1>
			<p className="mt-3 text-lg text-base-content/70">
				If someone in your family uses Anthers, here is what it is, in plain language — including
				the parts we can't promise.
			</p>

			<Section title="What Anthers is">
				<p>
					Anthers is a place where people publish work — games, videos, audio, and writing — and
					where the people who enjoy that work can pay them for it directly.
				</p>
				<p>
					It's run by <strong>Anthers, Inc.</strong>, a Colorado nonprofit. We take no cut of what
					anyone gives a creator. There are no investors to pay back and nobody here profits from
					how much time your kid spends on the site.
				</p>
			</Section>

			<Section title="There is no advertising, and nothing here is designed to be sticky">
				<p>
					<strong>There is no advertising on Anthers at all</strong>, and no mechanism anywhere that
					makes us money from someone's attention. No ad identifiers, no tracking pixels, no data
					sold to anyone, ever.
				</p>
				<p>
					That's not a feature we added — it's a consequence of how the organisation is built. An
					engagement-maximising feed would earn Anthers nothing, so there isn't one.
				</p>
			</Section>

			<Section title="Accounts are 13+, and we don't verify that">
				<p>
					You have to be 13 or older to have an account.{" "}
					<strong>We don't ask anyone's age and we don't check it</strong>, so someone younger could
					sign up by not telling us. We'd rather say that plainly than let you believe there's a
					check.
				</p>
				<p>
					The reason we don't check is that doing it properly means collecting identity documents or
					dates of birth from <em>everyone</em>, and we aren't willing to hold that about people in
					order to verify a fact about a few. Several countries are currently pushing platforms
					toward exactly that, and we think it's the wrong trade.
				</p>
				<p>
					One age rule here is real, and it's enforced by something other than trust:{" "}
					<strong>anyone who publishes work on Anthers is a verified adult</strong>, because
					publishing requires completing payment verification with Stripe. Minors can't publish
					here.
				</p>
			</Section>

			<Section title="What a teenager can encounter">
				<p>
					Anthers hosts work by adults, and comments and reviews written by other people. That means
					the ordinary risks of any space where people talk to each other: rudeness, arguments, and
					occasionally someone behaving badly.
				</p>
				<p>
					<strong>There is no sexually explicit material on Anthers.</strong> A category for work
					with mature themes is planned but not open, and when it opens it will require a payment
					method and won't be reachable by browsing.
				</p>
				<p>
					Paid content requires a payment method, which is a real practical limit on what a young
					person can buy — but it's a limit created by how payment works, not a rule we police.
				</p>
			</Section>

			<Section title="What they can do about someone">
				<p>
					<strong>Blocking.</strong> Anyone can block anyone, from that person's profile. It takes
					effect immediately, nobody reviews it, and it works in both directions — afterwards
					neither person sees the other's profile, comments, or reviews anywhere on the site, and
					any follows between them are removed.
				</p>
				<p>
					<strong>Reporting.</strong> Separately, they can report a comment, a review, or a person.
					That goes to a human at Anthers. Reporting and blocking are deliberately different things:
					blocking is a boundary they set themselves and doesn't need anyone's permission.
				</p>
			</Section>

			<Section title="What we hold, and how to get rid of it">
				<p>
					We keep what's needed to run the place and pay creators: an account, what was published,
					what was bought, and a record of what was watched or played and for how long (which is how
					creators get paid by time spent).
				</p>
				<p>
					<strong>Creators never see who watched their work</strong> — only totals. And the
					per-person viewing records are deleted after 180 days, leaving only anonymous totals
					behind.
				</p>
				<p>
					Any account can download everything we hold about it, or delete itself, from the settings
					page. Deletion takes seven days, and signing back in during that week cancels it. Full
					detail is in the{" "}
					<Link to="/privacy" className="link link-primary">
						Privacy Policy
					</Link>
					.
				</p>
			</Section>

			<Section title="What we can't do">
				<p>
					We can't tell you whether your child has an account, or show you their activity. We don't
					know who is related to whom, and building that would mean collecting exactly the identity
					information we've said we won't.
				</p>
				<p>
					<strong>We also don't have a guardian-permission rule</strong>, and that's deliberate
					rather than an oversight. Other platforms state one; nobody can actually check it, and a
					rule that can't be checked mostly serves to move responsibility onto you if something goes
					wrong. We'd rather do the work of making this a decent place to be, tell you honestly what
					it is, and leave parenting to you.
				</p>
			</Section>

			<Section title="Reaching a human">
				<p>
					You can email{" "}
					<a className="link link-primary" href="mailto:privacy@anthers.org">
						privacy@anthers.org
					</a>{" "}
					and a person will read it. If you believe someone under 13 has an account, tell us and
					we'll remove it.
				</p>
				<p className="text-sm text-base-content/60">
					Anthers, Inc. · PO Box 21233, Denver, CO 80221
				</p>
			</Section>
		</div>
	);
}
