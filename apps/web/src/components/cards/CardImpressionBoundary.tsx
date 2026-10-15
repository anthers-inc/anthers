// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef } from "react";
import { trackCardDisplay } from "../../lib/traffic";

/**
 * The boundary around one Discover card that counts its impressions.
 *
 * Wraps the card rather than living inside it, so a card stays usable everywhere
 * without carrying a measurement its other surfaces never opted into: only the page
 * that decides a card is *discovery* wraps it. An impression is the card reaching the
 * viewport; a click-through is a click on the card that is not on a nested control
 * (a Follow button is engagement with the card, not an open of the subject).
 * `lib/traffic.ts` carries what the beacon sends and what it deliberately does not.
 *
 * The subject ids are row ids (`projects.id`, `users.id`) — never publicIds. The
 * server resolves the creator the subject belongs to when it aggregates, which is
 * what makes the figure creator-attributed without the beacon carrying anything.
 */
export default function CardImpressionBoundary({
	subjectKind,
	subjectId,
	children,
}: {
	subjectKind: "project" | "creator";
	subjectId: number;
	children: React.ReactNode;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	// One tracker per subject, held across re-renders — the "shown once per card per
	// page view" dedupe lives in it, so a re-render resets nothing.
	const tracker = useMemo(() => trackCardDisplay(subjectKind, subjectId), [subjectKind, subjectId]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		return tracker.observe(el);
	}, [tracker]);

	return (
		<div ref={ref} onClickCapture={tracker.onClickCapture} className="h-full">
			{children}
		</div>
	);
}
