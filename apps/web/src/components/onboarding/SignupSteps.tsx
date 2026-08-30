// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The progress rail both halves of signing up wear, and the shell they sit in.
 *
 * 🚨 **It exists because of what a walkthrough on 2026-08-25 read like from the outside.**
 * Signing up through Bluesky sent Parker to bsky.social, brought him back, and asked him to
 * sign up again — with no sign that any of it had succeeded. Coming back to finish is the
 * design (an address a PDS calls confirmed is somebody else's assertion, and a code we sent
 * is ours), but nothing on the page said so, and *"a second signup form with a prefilled
 * email box is indistinguishable from having accomplished nothing"*. A rail that names the
 * steps and marks the finished ones is the smallest thing that makes progress legible.
 *
 * ⚠️ **Two routes, one shell** (Parker's call, 2026-08-26). `/finish` proves the address and
 * takes any payment; `/welcome` claims the handle and presents the terms. They stay separate
 * routes because `/welcome` has a job that has nothing to do with signing up — it is where
 * any signed-in account still owing a handle is sent, from anywhere — and folding it into
 * the finishing page would make that page reachable as a second door. Wearing the same
 * chrome is what makes them read as one flow anyway.
 *
 * ⚠️ **The rail is decoration in the strict sense: it never gates anything.** What a person
 * may do next is decided by the pending signup and the session, server-side. A step drawn as
 * done here that is not done there would be a lie, so the caller passes the state it has
 * rather than this component inferring one.
 */

import { FONTS } from "@anthers/web-shared/fonts";
import { CheckIcon } from "@heroicons/react/24/solid";

/** The same face `/welcome` and `/subscribe` set their headings in. */
const serif = { fontFamily: FONTS.fraunces };

export interface SignupStep {
	/** Stable key, so a step appearing or vanishing does not re-key the ones beside it. */
	key: string;
	/** Title case: this names a thing rather than saying something about it. */
	label: string;
	state: "done" | "current" | "todo";
}

/**
 * Build the rail for one reading of the flow.
 *
 * The Bluesky step appears only for somebody who came through that door, and the payment
 * step only when there is something to pay. A rail listing steps that will never happen
 * tells a reader the flow is longer than it is, which is the opposite of the point.
 */
export function signupSteps(input: {
	bluesky: "done" | "current" | "todo" | null;
	address: "done" | "current" | "todo";
	payment: "done" | "current" | "todo" | null;
	username: "done" | "current" | "todo";
}): SignupStep[] {
	const steps: SignupStep[] = [];
	if (input.bluesky) steps.push({ key: "bluesky", label: "Bluesky", state: input.bluesky });
	steps.push({ key: "address", label: "Your Email", state: input.address });
	if (input.payment) steps.push({ key: "payment", label: "Payment", state: input.payment });
	steps.push({ key: "username", label: "Your Username", state: input.username });
	return steps;
}

function StepMark({ index, state }: { index: number; state: SignupStep["state"] }) {
	const base =
		"flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold";
	if (state === "done") {
		return (
			<span className={`${base} bg-primary text-primary-content`}>
				<CheckIcon className="h-4 w-4" aria-hidden="true" />
			</span>
		);
	}
	if (state === "current") {
		return <span className={`${base} bg-primary text-primary-content`}>{index + 1}</span>;
	}
	return <span className={`${base} bg-base-300 text-base-content/50`}>{index + 1}</span>;
}

/**
 * The shared page shell: the rail, a heading, and whatever the step itself needs.
 *
 * `max-w-lg` matches `/welcome`, which is the narrower of the two and the one a reader
 * meets second — a flow that widens halfway through reads as two pages again.
 */
export default function SignupSteps({
	steps,
	eyebrow,
	title,
	children,
}: {
	steps: SignupStep[];
	/** Small caps line above the heading. A label, so title case. */
	eyebrow: string;
	/** The heading. A sentence about what to do here, so sentence case. */
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="mx-auto min-w-0 w-full max-w-lg px-6 py-12 sm:py-16">
			{/* An ordered list, because that is what this is — and it means a screen reader
			    hears "3 of 3" rather than three unrelated words. The visual state is carried
			    by `aria-current` and by the word in the label, never by color alone. */}
			{/* ⚠️ **No connecting lines between the steps, and that is a fix rather than a
			    simplification.** Three steps do not fit on one line in this column, so the rail
			    wraps — and a connector drawn after every step but the last leaves one dangling
			    off the end of the first row, pointing at nothing. Spacing and the numbers carry
			    the sequence at every width instead. */}
			{/* ⚠️ **Named, and the name is load-bearing for more than assistive tech.** An
			    unnamed `<ol>` is indistinguishable from every other list on the site, and the
			    first spec written against these steps matched `/subscribe`'s fee breakdown
			    instead — two list items reading "Payments" — and reported a strict-mode
			    violation where it meant to report a missing step. */}
			<ol aria-label="Signup Progress" className="flex flex-wrap items-center gap-x-6 gap-y-2">
				{steps.map((step, i) => (
					<li
						key={step.key}
						className="flex items-center gap-2"
						aria-current={step.state === "current" ? "step" : undefined}
					>
						<StepMark index={i} state={step.state} />
						<span
							className={`text-sm ${
								step.state === "todo" ? "text-base-content/45" : "font-semibold text-base-content"
							}`}
						>
							{step.label}
						</span>
						{step.state === "done" && <span className="sr-only">(done)</span>}
					</li>
				))}
			</ol>

			<p className="mt-10 text-xs font-semibold uppercase tracking-[0.2em] text-base-content/45">
				{eyebrow}
			</p>
			<h1 style={serif} className="mt-2 text-3xl font-light leading-tight sm:text-4xl">
				{title}
			</h1>

			{children}
		</div>
	);
}
