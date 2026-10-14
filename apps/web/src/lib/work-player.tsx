// SPDX-License-Identifier: Apache-2.0
/**
 * The binding between a Work's inline player and the rest of its page.
 *
 * A chapter or a timestamp inside the description, or inside a review, sits OUTSIDE
 * the player component — the players own their own elements and their own `seekTo` —
 * and YouTube's model (Parker, 2026-10-13) makes those texts the authoring surface:
 * the timestamps are links, and a link must reach the thing that is playing. This
 * scope is that reach: the player mounted under it hands its `seek` up on mount, and
 * any text under it renders its timestamps as links that call down into the player.
 *
 * ⚠️ One inline player per page — a video's two delivery branches never mount
 * together — so a single seek slot suffices; a registering player replaces whatever
 * was bound and hands back its own unregister. With no player mounted the seek is
 * null, and the text renderers degrade to plain text rather than promising to seek
 * somewhere nothing can (a locked video has no player, and its description reads
 * exactly the same, links unlit).
 *
 * The scope lives in `WorkColumn`, which every Work page and editor wraps with —
 * one provider where the player and the texts that link to it are siblings, and
 * nothing further out knows it exists.
 */
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

interface WorkPlayerScopeValue {
	/**
	 * Hand the scope the player's seek function. Returns the unregister — the player
	 * unmounting must leave the scope empty rather than pointing at a torn-down element.
	 */
	bind: (seek: (seconds: number) => void) => () => void;
	/** The bound player's seek, or null while nothing is mounted. */
	seek: ((seconds: number) => void) | null;
}

const WorkPlayerScopeContext = createContext<WorkPlayerScopeValue | null>(null);

export function WorkPlayerProvider({ children }: { children: ReactNode }) {
	const [seek, setSeek] = useState<((seconds: number) => void) | null>(null);
	/** The seek currently bound, so an unregister only clears its own slot. */
	const bound = useRef<((seconds: number) => void) | null>(null);
	const bind = useCallback((fn: (seconds: number) => void) => {
		bound.current = fn;
		setSeek(() => fn);
		return () => {
			if (bound.current === fn) {
				bound.current = null;
				setSeek(null);
			}
		};
	}, []);
	const value = useMemo(() => ({ bind, seek }), [bind, seek]);
	return (
		<WorkPlayerScopeContext.Provider value={value}>{children}</WorkPlayerScopeContext.Provider>
	);
}

/**
 * The player's side: hand the page the player's seek. A stable `seek` callback (the
 * players' own are) binds once per mount; one that changes re-binds on the change.
 * Outside a scope nothing happens — the Studio previews that carry no page around
 * the player simply bind nothing.
 */
export function useBindPlayerSeek(seek: ((seconds: number) => void) | null) {
	const scope = useContext(WorkPlayerScopeContext);
	useEffect(() => {
		if (!scope || !seek) return;
		return scope.bind(seek);
	}, [scope, seek]);
}

/** The text side of the binding — seek the mounted player, or null to degrade to text. */
export function useSeekPlayer(): ((seconds: number) => void) | null {
	const scope = useContext(WorkPlayerScopeContext);
	return scope?.seek ?? null;
}
