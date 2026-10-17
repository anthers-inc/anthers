// SPDX-License-Identifier: Apache-2.0
/**
 * A toggle that changes how tall the page is — opening a field for edit, closing it
 * again — must never cost the reader their place in the page.
 *
 * ⚠️ **Tab switches are not this module's ground any more** (Parker, 2026-10-17):
 * the Work page's tab groups hold a stable height (`TabPanels` stacks every panel
 * in one grid cell, as tall as the tallest), so a switch changes nothing that could
 * move the page and passes through no keeper at all. What still changes the height
 * is a panel's own content — a field opening for edit is the case this module
 * covers, from `Editing.tsx`.
 *
 * The shell's pages scroll on a container, not on the document (`LoggedInLayout`'s
 * `<main>` is the app's scroll surface), so the offset lives on a container element
 * found here from an anchor inside the changing content: the nearest ancestor carrying
 * a vertical overflow, the document standing in when nothing nearer qualifies.
 *
 * `keepScroll` captures the container's offset, lets `commit`'s state update carry out
 * the change, and restores the offset before the new shape paints. The restore races
 * two things:
 *
 * - **Clamping.** A page whose new shape is too short to honor the offset cannot keep it
 *   at all; the browser clamps to its real bottom, which is the closest a shorter page
 *   can come to keeping the place.
 * - **Adjustments that follow the commit.** Scroll anchoring, a focus move the toggle
 *   itself causes, a browser's own compensation — each can move the container a frame
 *   after the restore. The reassertion guard in `keepScroll` answers them: it reasserts
 *   the captured offset on any move off it until the scrolls go quiet a moment or the
 *   hard cap passes, then hands scrolling back to the reader.
 *
 * ⚠️ A harness click is NOT a reader's click: Playwright scrolls a target it finds
 * below the fold into view before activating it, so a toggle's captured offset already
 * carries that pre-scroll, and no keeper can hold a place the harness itself moved.
 * The e2e walk for this module drives raw `page.mouse` clicks on measured positions
 * for exactly this reason.
 */

/** The element this part of the page actually scrolls on. */
export function scrollHolderOf(anchor: HTMLElement | null): HTMLElement {
	for (let node = anchor?.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === "auto" || overflow === "scroll") return node;
	}
	return document.documentElement;
}

/** Capture the scroll offset, make the change, restore the offset. */
export function keepScroll<T>(anchor: HTMLElement | null, commit: () => T): T {
	const holder = scrollHolderOf(anchor);
	const top = holder.scrollTop;
	const active = document.activeElement;
	// Chromium walks to the next focusable after the toggle removes the activated
	// control; blurring first leaves it less to walk from.
	if (active instanceof HTMLElement && active !== document.body && anchor?.contains(active)) {
		active.blur();
	}
	const result = commit();
	// The instant restore, ahead of the paint, and the reassertion guard behind it —
	// every move off the captured offset is answered with the offset itself, until the
	// scrolls go quiet for a moment (the change's own are done) or the cap passes, at
	// which point the reader's own scrolling, which is theirs, is never pulled back. A
	// page too short to honor the offset clamps each reassertion to its real bottom, as
	// above.
	let quiet: ReturnType<typeof setTimeout> | undefined;
	const detach = () => {
		holder.removeEventListener("scroll", reassert);
		clearTimeout(quiet);
	};
	const reassert = () => {
		clearTimeout(quiet);
		if (holder.scrollTop !== top) holder.scrollTop = top;
		// Quiet a moment and the change's own scrolls are done — the page is the
		// reader's again.
		quiet = setTimeout(detach, 250);
	};
	holder.addEventListener("scroll", reassert, { passive: true });
	requestAnimationFrame(() => {
		holder.scrollTop = top;
	});
	// If the browser's adjustment never comes, detach on the cap so no listener
	// outlives its change.
	quiet = setTimeout(detach, 1500);
	return result;
}
