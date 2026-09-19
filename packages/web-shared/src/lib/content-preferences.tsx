// SPDX-License-Identifier: Apache-2.0
/**
 * What the reader has asked to meet, on the client side: the Hide / Blur / Show settings for each
 * rung and for each kind of content, and the veil that applies the blur.
 *
 * 🚨 **The blur is the client's job and the hide is the server's, and the split is not
 * arbitrary.** A hidden Work must not be in the response at all — the whole point is that it
 * is absent — so hiding is a `WHERE` clause in `services/content-preferences.ts`. A blurred
 * Work *is* in the response, listed and reachable, with its cover covered until the reader
 * chooses to look. Doing the blur here rather than server-side is what keeps that true: the
 * Work, its title and its rating all arrive, and only the picture waits.
 *
 * ⚠️ **A warning that arrives with the thing is not a warning**, which is why the rating, its
 * notes and its rows travel on every Work serialization. This reads what already came rather
 * than asking again per card.
 */

import {
	type ContentNote,
	DEFAULT_MATURITY_DISPLAY,
	type MaturityDisplay,
	type MaturityRows,
	maturityLabel,
	mayContain,
	type NoteDisplays,
	normalizeNoteDisplays,
	RATING_ROWS,
	requiresAdultVerification,
} from "@anthers/shared/content-rating";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { apiFetch } from "./rpc";

export interface ContentPreferences {
	mature: MaturityDisplay;
	adult: MaturityDisplay;
	/** Hide, Blur or Show for each kind of content, whatever a Work's rating. */
	notes: NoteDisplays;
	adultAccess: { optIn: boolean; verifiedAt: string | null; canReach: boolean };
}

/**
 * What a reader gets before anything has loaded, and what a signed-out visitor gets forever.
 *
 * 🚨 **Mature blurs here, not just on the server.** This value is what renders during the
 * fetch, so a default of `show` would flash every Mature cover unblurred on first paint and
 * then cover them — which is the one failure this whole feature exists to prevent, delivered
 * in the most visible way possible. The default has to be the cautious one at every layer
 * that can render.
 */
export const DEFAULT_PREFERENCES: ContentPreferences = {
	mature: DEFAULT_MATURITY_DISPLAY.mature,
	adult: DEFAULT_MATURITY_DISPLAY.adult,
	notes: normalizeNoteDisplays(null),
	adultAccess: { optIn: false, verifiedAt: null, canReach: false },
};

const PreferencesContext = createContext<{
	prefs: ContentPreferences;
	refresh: () => Promise<void>;
}>({
	prefs: DEFAULT_PREFERENCES,
	refresh: async () => {},
});

/**
 * Loads the reader's preferences once and shares them.
 *
 * A context rather than a hook per card, because a Catalog page renders dozens of covers and
 * each one needs the same answer — and because the settings page has to be able to push a
 * change through without a reload.
 */
export function ContentPreferencesProvider({ children }: { children: ReactNode }) {
	const [prefs, setPrefs] = useState<ContentPreferences>(DEFAULT_PREFERENCES);

	const refresh = useCallback(async () => {
		try {
			const res = await apiFetch("/api/accounts/me/content-preferences");
			if (!res.ok) return;
			const loaded = (await res.json()) as ContentPreferences;
			// Every row present whatever came back, so a response from an older server cannot leave
			// a row undefined for `coverFor` to misread.
			setPrefs({ ...loaded, notes: normalizeNoteDisplays(loaded.notes) });
		} catch {
			// Leave the cautious defaults in place. A failed fetch must not un-blur
			// anything, which is why nothing is cleared here.
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<PreferencesContext.Provider value={{ prefs, refresh }}>{children}</PreferencesContext.Provider>
	);
}

export function useContentPreferences() {
	return useContext(PreferencesContext);
}

/** How a Work of this rating should be presented to this reader. */
export function displayFor(prefs: ContentPreferences, maturity?: string | null): MaturityDisplay {
	if (maturity === "mature") return prefs.mature;
	// Anything this build does not recognize is treated as the most restricted rung it
	// knows, on the same err-toward-not-showing-it rule the server gates by.
	if (requiresAdultVerification(maturity)) return prefs.adult;
	// `general` and `unrated` are never covered. An unrated Work is one nobody has answered
	// for, and covering it would be asserting a rating on the creator's behalf — the same
	// thing `unrated` exists in the schema to refuse.
	return "show";
}

/**
 * Why a Work's cover is covered for this reader, or null when nothing covers it.
 *
 * `byRung` is the reader's setting for the Work's rating; `byNotes` is every kind of content they
 * asked to cover that the Work may contain, in the matrix's order, which is what the veil names.
 *
 * 🚨 **A kind of content the reader HIDES covers the Work wherever it still appears.** The server
 * keeps it out of every listing, so a card only meets one where no listing filtered it, such as
 * the reader's own Work, and a reader who asked never to see a kind of content is not shown it
 * uncovered there. A hidden rung keeps its own behavior, which `displayFor` decides.
 *
 * ⚠️ **A row nobody answered counts as present** (`mayContain`), the same rule the listings use, so
 * a Work released before the matrix existed is covered for a reader who blurs any kind of content.
 */
export function coverFor(
	prefs: ContentPreferences,
	work: { maturity?: string | null; maturityRows?: MaturityRows | null },
): { byRung: boolean; byNotes: ContentNote[] } | null {
	const byRung = displayFor(prefs, work.maturity) === "blur";
	const byNotes = RATING_ROWS.filter(
		(row) => prefs.notes[row.note] !== "show" && mayContain(work.maturityRows, row.note),
	).map((row) => row.note);
	return byRung || byNotes.length > 0 ? { byRung, byNotes } : null;
}

/**
 * A cover the reader has asked to have covered, with a click to reveal.
 *
 * ⭐ **The label names the rating and the notes**, because a veil that says only "hidden"
 * makes the reader uncover it to find out whether they wanted to — which defeats the point. A
 * Work covered only for a kind of content it holds names that kind instead, through `because`,
 * since its rating is not what the reader asked about.
 * The reveal is per card and not remembered: a reader who uncovered one Work has not asked
 * to uncover the next one, and persisting it would quietly turn their Blur into a Show.
 */
export function MaturityVeil({
	maturity,
	notes,
	because,
	children,
	className = "",
}: {
	maturity?: string | null;
	notes?: string[];
	/** The kinds of content that covered it, when its rating did not. */
	because?: string[];
	children: ReactNode;
	className?: string;
}) {
	const [revealed, setRevealed] = useState(false);
	if (revealed) return <>{children}</>;

	const byContent = because !== undefined && because.length > 0;
	const label = byContent ? because.join(" · ") : maturityLabel(maturity ?? "");
	const detail = byContent ? null : notes && notes.length > 0 ? notes.join(" · ") : label;

	return (
		<div className={`relative overflow-hidden bg-base-300 ${className}`}>
			{/* Blur AND scale, so the blurred edges do not leave a readable frame border —
			    the same trick `LockedCover` uses, for the same reason. */}
			<div className="w-full h-full blur-xl scale-110">{children}</div>
			<button
				type="button"
				className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 text-white"
				onClick={(e) => {
					// The cover usually sits inside a link to the Work. Uncovering is not
					// navigating, so the click stops here.
					e.preventDefault();
					e.stopPropagation();
					setRevealed(true);
				}}
			>
				<span className="badge badge-neutral font-medium">{label}</span>
				{detail && <span className="text-xs opacity-80">{detail}</span>}
				<span className="text-xs underline opacity-90">Show anyway</span>
			</button>
		</div>
	);
}
