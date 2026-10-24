// SPDX-License-Identifier: Apache-2.0
/**
 * Theater mode: the Work page's media area filling the content column.
 *
 * **The mode is page-level, the control is the player's.** Growing the media card means
 * breaking out of the page's reading width (`WorkColumn`'s centered cap), which no player
 * can do from inside itself — so the toggle lives in a context the deliverable mounts,
 * and the card, the player's button and the player's keymap all read the same state.
 *
 * ⚠️ **The area is measured, not guessed.** "Everything inside the topbar and sidebar" is
 * the scroll container's own content box, which changes with the window, the sidebar's
 * rail state, and any banner above the body. A `100vw`/`100dvh` sum would be wrong for
 * every one of those, so the card measures `main` and follows its `ResizeObserver` while
 * the mode is on.
 *
 * ⭐ **The page stays in flow.** Theater mode is a tall first block, not a fixed overlay:
 * scrolling down still reaches the title, the byline and the tabs below the work, which
 * is the difference between this and the browser's full screen.
 */
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";

export interface WorkTheater {
	theater: boolean;
	toggle: () => void;
}

const WorkTheaterContext = createContext<WorkTheater | null>(null);

export function WorkTheaterProvider({
	enabled = true,
	children,
}: {
	/** False on a surface with no page to grow into — the embed's bare window. */
	enabled?: boolean;
	children: ReactNode;
}) {
	const [theater, setTheater] = useState(false);
	const toggle = useCallback(() => setTheater((on) => !on), []);
	const value = useMemo<WorkTheater | null>(
		() => (enabled ? { theater, toggle } : null),
		[enabled, theater, toggle],
	);
	return <WorkTheaterContext.Provider value={value}>{children}</WorkTheaterContext.Provider>;
}

/** The page's theater state, or null where the surface has no page to grow into. */
export function useWorkTheater(): WorkTheater | null {
	return useContext(WorkTheaterContext);
}

export interface ContentStageSize {
	width: number;
	height: number;
}

/**
 * The scroll container's content box, measured from an element inside the page.
 *
 * Returns null until the first measurement lands (and again as soon as the mode is off),
 * which keeps the card at its ordinary shape rather than snapping through a zero size.
 * The measurement is a layout effect so the first theater paint is already the grown one.
 */
export function useContentStage(
	ref: RefObject<HTMLElement | null>,
	active: boolean,
): ContentStageSize | null {
	const [size, setSize] = useState<ContentStageSize | null>(null);

	useLayoutEffect(() => {
		if (!active) {
			setSize(null);
			return;
		}
		const main = ref.current?.closest("main");
		if (!main) return;

		const measure = () => {
			const next = { width: main.clientWidth, height: main.clientHeight };
			// Identity-stable when nothing changed: a ResizeObserver callback that sets a
			// fresh object every time would re-render for every pixel of an unrelated
			// layout change.
			setSize((prev) =>
				prev && prev.width === next.width && prev.height === next.height ? prev : next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(main);
		// The work is what the mode puts in front of the reader, so entering it starts at
		// the work rather than wherever the page was scrolled to.
		ref.current?.scrollIntoView({ block: "start" });
		return () => observer.disconnect();
	}, [active, ref]);

	return size;
}
