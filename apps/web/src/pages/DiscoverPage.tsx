// SPDX-License-Identifier: Apache-2.0
/**
 * **Discovery** — one stream over Anthers, and the recipe that draws it.
 *
 * 🚨 **The recipe is the product.** The reader can always see how the corpus is being
 * drawn and change it, so the stream renders its active recipe above the content and
 * exposes the three choices behind it: the candidate set, the window, and whether the
 * mix spreads creators. There is no hidden ranking, and nothing here is paid placement.
 *
 * ⭐ **Network retired into this page on 2026-10-24, as its first preset.** The two tabs
 * ran one route, one card, one set of filters and one set of lenses; the only thing
 * Network could do that a recipe could not was the membership narrowing, and that became
 * a candidate value. So the network feed is now **My Network** — a named recipe a reader
 * selects in a click, and the one a new account opens on — rather than a second page
 * whose difference from this one the reader had to infer from a subtitle.
 *
 * ⭐ **The account is the default layer and the URL is the override.** A bare
 * `/discovery` opens on the recipe the account last chose; a link carrying recipe
 * parameters answers that visit, and only a change the reader makes here writes the
 * account. That is what keeps somebody else's shared recipe, or an onboarding link, from
 * silently rewriting what a reader opens on — and it is why selecting a chip writes the
 * whole triple rather than leaning on the built-in defaults.
 *
 * ⭐ **A reader's own recipes live beside the site's two.** Saving the recipe on screen
 * names it, colors it and adds a chip; the pencil beside the controls renames, recolors,
 * reorders and removes it. The list is stored whole on the account (`savedRecipes`) for
 * the same reason the opening recipe is stored as values: a name is a preference, not a
 * pointer into a preset table, so a saved recipe survives any change to the built-ins.
 * `Ctrl+[` and `Ctrl+]` step through the whole row, saved chips included.
 *
 * The graph's shared-follow ranking is a route (`GET /api/accounts/me/graph`) and a
 * recipe builder with no page drawing them: a network of follows ranks nearly everyone a
 * reader can already see until the platform holds enough content for the edges to say
 * something. Discovery carried it as a second mode until 2026-10-23; the mode machinery
 * is gone rather than left holding a single live row.
 *
 * Browse was removed on 2026-10-19, carrying none of its controls: search lives in the
 * top-level bar, and view-specific terms ride the `q` the Filter mode already writes.
 * Inbox was removed the same day for having no backend to stand on.
 */

import { BOOKSHELF_WORK_TYPES } from "@anthers/shared/content";
import {
	asRecipeCandidates,
	asRecipeMix,
	asRecipeWindow,
	choiceForRecipe,
	DISCOVERY_STAGE_LABELS,
	type DiscoveryReason,
	nextRecipeColor,
	RECIPE_CANDIDATE_LABELS,
	RECIPE_CANDIDATES,
	RECIPE_COLOR_VALUES,
	RECIPE_COLORS,
	RECIPE_PRESETS,
	type Recipe,
	type RecipeCandidates,
	type RecipeChoice,
	type RecipeColor,
	type RecipeMix,
	type RecipeWindow,
	recipeChoices,
	recipeFrom,
	recipeQuery,
	SAVED_RECIPE_LABEL_MAX,
	SAVED_RECIPE_LIMIT,
	type SavedRecipe,
	savedRecipesFrom,
	streamRecipe,
	suggestedRecipeName,
} from "@anthers/shared/discovery";
import { matchesChord } from "@anthers/shared/keybindings";
import { useAuth } from "@anthers/web-shared/auth";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	ArrowPathIcon,
	CheckIcon,
	MagnifyingGlassIcon,
	PencilSquareIcon,
	PlusIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FeedTile from "../components/cards/FeedTile";
import SharedFilterSections, {
	SHARED_FILTER_TYPES,
} from "../components/layout/SharedFilterSections";
import SharedLensesSection, { ALL_LENS_IDS } from "../components/layout/SharedLensesSection";
import { useFilterable, useViewFilter } from "../components/layout/search/filter-context";
import TabHeader from "../components/layout/TabHeader";
import BookshelfLens from "../components/library/BookshelfLens";
import ChannelGuideLens, {
	channelGuideChannelsFromLibrary,
} from "../components/library/ChannelGuideLens";
import MusicDial from "../components/library/MusicDial";
import MusicLens from "../components/library/MusicLens";
import { feedLensItems } from "../lib/feed-lenses";
import { useKeyboardShortcuts } from "../lib/keyboard-shortcuts";
import { isApplePlatform } from "../lib/platform";

/** One entry of the feed's stream, as `?scope=global` sends it. */
type FeedEntry = {
	kind: "post" | "release";
	id: number;
	at: string;
	title?: string | null;
	creator?: { handle?: string; displayName?: string | null } | null;
	/** Why the entry is here, as the API states it. */
	reason?: DiscoveryReason;
} & Record<string, unknown>;

/**
 * The three choices a recipe is made of. The route runs the candidate set and the mix as
 * query parameters over one corpus, and the window narrows what came back, so every
 * option offered here is a value something actually obeys — there is no control whose
 * only setting is the one already chosen.
 *
 * The labels come from the shared vocabulary rather than being retyped here, so the
 * control and the recipe's own stage row cannot describe the same value differently.
 */
const WINDOW_OPTIONS: ReadonlyArray<{ value: RecipeWindow; label: string }> = [
	{ value: "all", label: "Everything" },
	{ value: "day", label: "The last day" },
	{ value: "week", label: "The last week" },
];

const CANDIDATE_OPTIONS: ReadonlyArray<{ value: RecipeCandidates; label: string }> =
	RECIPE_CANDIDATES.map((value) => ({ value, label: RECIPE_CANDIDATE_LABELS[value] }));

const MIX_OPTIONS: ReadonlyArray<{ value: RecipeMix; label: string }> = [
	{ value: "spread", label: "Spread creators" },
	{ value: "straight", label: "Newest first" },
];

/**
 * The preset the empty state offers a reader whose own network has nothing: the whole
 * site is one click away, and it is the one widening that always has more to show.
 * Looked up by id rather than by position, so a later preset inserted above it cannot
 * silently point the button at a different recipe.
 */
const ACROSS_ANTHERS = RECIPE_PRESETS.find((preset) => preset.id === "across-anthers") ?? null;

/** Which recipe dialog is open: saving the recipe on screen, or editing a saved one. */
type RecipeDialogState = { mode: "create" } | { mode: "edit"; id: string };

/**
 * The chips: the site's presets, the reader's saved recipes, and — when the recipe on
 * screen is neither — a way to save it.
 *
 * A chip sets the whole recipe, so it is a named starting point rather than a fourth
 * control; a reader who then narrows one stage lands on no chip at all, and the row says
 * so by lighting nothing. That is the honest state: matching is exact, because a chip that
 * lit up for a recipe it would not reproduce would lie about what a click does.
 *
 * ⭐ **A line rather than a dropdown.** The set grows with the reader's own recipes, and a
 * line is what makes switching one click instead of two — which is what makes the keyboard
 * cycle worth having.
 *
 * ⚠️ **The color is a dot, and the pressed state is the tint plus the weight.** A reader
 * who cannot tell the colors apart still has the label, the bold name and `aria-pressed`;
 * color is an accent rather than the signal, per the task that added it.
 */
function PresetChips({
	choices,
	activeId,
	onSelect,
	onSave,
	canSave,
}: {
	choices: readonly RecipeChoice[];
	activeId: string | null;
	onSelect: (choice: RecipeChoice) => void;
	onSave: () => void;
	canSave: boolean;
}) {
	return (
		<fieldset className="mb-3 min-w-0">
			<legend className="sr-only">Recipes</legend>
			<div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
				{choices.map((choice) => {
					const selected = activeId === choice.id;
					const color = RECIPE_COLOR_VALUES[choice.color];
					return (
						<button
							key={choice.id}
							type="button"
							aria-pressed={selected}
							title={choice.blurb}
							onClick={() => onSelect(choice)}
							style={
								selected ? { borderColor: color.hex, backgroundColor: `${color.hex}1f` } : undefined
							}
							className={`btn btn-ghost btn-sm shrink-0 gap-2 border ${
								selected ? "font-semibold text-base-content" : "border-base-300"
							}`}
						>
							<span
								aria-hidden="true"
								className="h-2 w-2 shrink-0 rounded-full"
								style={{ background: color.hex }}
							/>
							{choice.label}
						</button>
					);
				})}
				{canSave && (
					<button
						type="button"
						className="btn btn-ghost btn-sm shrink-0 gap-1.5 border border-dashed border-base-300 text-base-content/70"
						onClick={onSave}
					>
						<PlusIcon className="h-4 w-4" aria-hidden="true" />
						Save recipe
					</button>
				)}
			</div>
		</fieldset>
	);
}

/**
 * The active recipe, rendered above the content. It names what is being drawn and the
 * three stages that drew it, and the controls beside it change those stages, so the
 * reader never has to guess why a card is on screen. The stages come from the same
 * module the route ranks with, so the bar cannot describe a pipeline the server did not
 * run.
 *
 * ⭐ **Edit belongs to a saved recipe only.** The two built-ins are the site's named
 * recipes; offering a rename there would promise a change the reader cannot make. When a
 * saved recipe is active, the same row offers the pencil that renames, recolors, reorders
 * or deletes it.
 */
function RecipeBar({
	recipe,
	choices,
	activeChoice,
	onChoice,
	onRecipe,
	onSave,
	onEdit,
	canSave,
	onRefresh,
}: {
	recipe: Recipe;
	choices: readonly RecipeChoice[];
	activeChoice: RecipeChoice | null;
	onChoice: (choice: RecipeChoice) => void;
	onRecipe: (next: Recipe) => void;
	onSave: () => void;
	onEdit: (savedId: string) => void;
	canSave: boolean;
	onRefresh?: () => void;
}) {
	const drawn = streamRecipe(recipe);
	return (
		<div className="mb-6 rounded-box border border-base-300 bg-base-200/40 p-4">
			<PresetChips
				choices={choices}
				activeId={activeChoice?.id ?? null}
				onSelect={onChoice}
				onSave={onSave}
				canSave={canSave}
			/>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
						Active recipe
					</p>
					<p className="mt-1 max-w-3xl text-sm leading-relaxed text-base-content/80">
						{drawn.sentence}
					</p>
					<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
						{drawn.stages.map((stage) => (
							<div key={stage.stage} className="flex items-baseline gap-1.5">
								<dt className="text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
									{DISCOVERY_STAGE_LABELS[stage.stage]}
								</dt>
								<dd className="text-base-content/60">{stage.label}</dd>
							</div>
						))}
					</dl>
				</div>
				<div className="flex flex-wrap items-end gap-2">
					<label className="flex flex-col gap-1 text-xs text-base-content/60">
						From
						<select
							className="select select-bordered select-sm"
							value={recipe.candidates}
							onChange={(e) =>
								onRecipe({ ...recipe, candidates: asRecipeCandidates(e.target.value) })
							}
						>
							{CANDIDATE_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-base-content/60">
						Window
						<select
							className="select select-bordered select-sm"
							value={recipe.window}
							onChange={(e) => onRecipe({ ...recipe, window: asRecipeWindow(e.target.value) })}
						>
							{WINDOW_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-base-content/60">
						Order
						<select
							className="select select-bordered select-sm"
							value={recipe.mix}
							onChange={(e) => onRecipe({ ...recipe, mix: asRecipeMix(e.target.value) })}
						>
							{MIX_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					{activeChoice?.savedId && (
						<button
							type="button"
							className="btn btn-ghost btn-sm gap-1.5"
							onClick={() => onEdit(activeChoice.savedId!)}
							aria-label={`Edit ${activeChoice.label}`}
							title="Rename, recolor, reorder or remove this recipe"
						>
							<PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
							Edit
						</button>
					)}
					{onRefresh && (
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-square"
							onClick={onRefresh}
							aria-label="Refresh"
							title="Refresh"
						>
							<ArrowPathIcon className="h-4 w-4" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default function DiscoverPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent, setSharedContent } = useSidebar();
	const { user, refreshUser } = useAuth();
	const viewFilter = useViewFilter();
	// Filter mode's term is a server condition here for the same reason it is on any
	// paginated list: filtering the page already fetched would filter the wrong corpus.
	useFilterable("Discovery");

	const [entries, setEntries] = useState<FeedEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);

	const contentType = searchParams.get("media_type") ?? "";
	const access = searchParams.get("access") ?? "";
	const tags = searchParams.get("tags") ?? "";
	/** The lens is an organizing metaphor over the stream, never a mode. */
	const lens = searchParams.get("lens") ?? "";
	/** The Music Player's dial, carried the way the tabs carry it. */
	const includeSpoken = searchParams.get("spoken") === "1";

	/**
	 * The recipe this account opens on. Every stage is parsed, so a stored value this
	 * build no longer knows degrades to that stage's default rather than rendering a
	 * recipe nothing can run; an account that never chose gets the My Network preset.
	 */
	const accountRecipe = useMemo(() => recipeFrom(user?.homeRecipe), [user?.homeRecipe]);

	/**
	 * The recipe in force: the URL answers for a stage it names, and every stage it does
	 * not name comes from the account. A bare `/discovery` is therefore "my recipe", and a
	 * link that names one stage changes one stage.
	 */
	const recipe: Recipe = useMemo(() => {
		const window = searchParams.get("window");
		const candidates = searchParams.get("candidates");
		const mix = searchParams.get("mix");
		return {
			window: window ? asRecipeWindow(window) : accountRecipe.window,
			candidates: candidates ? asRecipeCandidates(candidates) : accountRecipe.candidates,
			mix: mix ? asRecipeMix(mix) : accountRecipe.mix,
		};
	}, [accountRecipe, searchParams]);

	/**
	 * The reader's own recipes, parsed row by row: a stored row this build cannot render is
	 * dropped rather than drawn as a half-chip, and the order stored is the order the chips
	 * render in.
	 */
	const saved = useMemo(() => savedRecipesFrom(user?.savedRecipes), [user?.savedRecipes]);

	/** Every chip: the site's presets, then the reader's, in that fixed two-part order. */
	const choices = useMemo(() => recipeChoices(saved), [saved]);

	/** The chip this recipe is, or null for a combination no chip names. */
	const activeChoice = useMemo(() => choiceForRecipe(choices, recipe), [choices, recipe]);

	/** Saving is offered only for a recipe no chip already names. */
	const canSave = activeChoice === null && saved.length < SAVED_RECIPE_LIMIT;

	const [dialog, setDialog] = useState<RecipeDialogState | null>(null);
	const [draftName, setDraftName] = useState("");
	const [draftColor, setDraftColor] = useState<RecipeColor>("moss");
	const [draftIndex, setDraftIndex] = useState(0);
	const [savingRecipe, setSavingRecipe] = useState(false);
	const [recipeError, setRecipeError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const dialogRef = useRef<HTMLDialogElement>(null);

	/**
	 * The Type selection rides the request as the stream's server-side condition —
	 * except under a lens, where the lens decides what it draws on and the rows outside
	 * it are grayed. Dropping it here is what keeps a lens a view of the corpus rather
	 * than a filter applied before the corpus arrives.
	 */
	const mediaType = lens ? "" : contentType;

	/**
	 * The Work types the active lens draws on, or null with No Lens. The Type rows
	 * outside this set gray out while it is active — the Library's rule, applied to the
	 * stream.
	 */
	const lensIncluded = useMemo<string[] | null>(() => {
		if (lens === "music") return includeSpoken ? ["music", "audio"] : ["music"];
		if (lens === "channel-guide") return ["video"];
		if (lens === "bookshelf") return [...BOOKSHELF_WORK_TYPES];
		return null;
	}, [lens, includeSpoken]);

	const unavailableTypes = useMemo(() => {
		if (!lensIncluded) return undefined;
		const set = new Set<string>();
		for (const type of SHARED_FILTER_TYPES) {
			if (type.id && !lensIncluded.includes(type.id)) set.add(type.id);
		}
		return set;
	}, [lensIncluded]);

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) next.set(key, value);
						else next.delete(key);
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	/**
	 * Choose a whole recipe: it becomes this visit's URL and this account's opening
	 * recipe.
	 *
	 * ⭐ **All three stages are written to the URL, never omitted when they match a
	 * built-in default.** Omitting one would make it mean "whatever the account says"
	 * rather than "this value", so clicking a chip whose stage matched the built-in
	 * default would leave the previous recipe in force until the account write landed.
	 *
	 * The account write is fire-and-forget: the stream does not wait on a preference, and
	 * a failed save leaves the reader with the recipe they asked for this session. The
	 * refresh afterwards is what keeps a later bare `/discovery` — this session or
	 * another device — opening on what they chose.
	 */
	const applyRecipe = useCallback(
		(next: Recipe) => {
			setSearchParams(
				(prev) => {
					const params = new URLSearchParams(prev);
					params.set("window", next.window);
					params.set("candidates", next.candidates);
					params.set("mix", next.mix);
					return params;
				},
				{ replace: true },
			);
			if (!user) return;
			void apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ homeRecipe: next }),
			})
				.then((res) => (res.ok ? refreshUser() : undefined))
				.catch(() => {});
		},
		[setSearchParams, refreshUser, user],
	);

	/**
	 * Write the saved list, and — when a save also makes a recipe the reader's current one
	 * — the opening recipe in the same request.
	 *
	 * ⭐ **Awaiting is the difference from `applyRecipe`.** A control that changed what is
	 * on screen can fail quietly: the stream is already showing what was asked for. Naming
	 * a recipe cannot, because the chip is the visible result, so the dialog stays open and
	 * says so instead of closing on a write that did not land.
	 */
	const writeSaved = useCallback(
		async (next: SavedRecipe[], homeRecipe?: Recipe) => {
			try {
				const res = await apiFetch("/api/accounts/me", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						homeRecipe ? { savedRecipes: next, homeRecipe } : { savedRecipes: next },
					),
				});
				if (!res.ok) return false;
				await refreshUser();
				return true;
			} catch {
				return false;
			}
		},
		[refreshUser],
	);

	const closeDialog = useCallback(() => {
		dialogRef.current?.close();
	}, []);

	const openSave = useCallback(() => {
		setDraftName(suggestedRecipeName(recipe));
		setDraftColor(nextRecipeColor(saved));
		setRecipeError(null);
		setConfirmDelete(false);
		setDialog({ mode: "create" });
		dialogRef.current?.showModal();
	}, [recipe, saved]);

	const openEdit = useCallback(
		(savedId: string) => {
			const index = saved.findIndex((row) => row.id === savedId);
			const row = saved[index];
			if (!row) return;
			setDraftName(row.label);
			setDraftColor(row.color);
			setDraftIndex(index);
			setRecipeError(null);
			setConfirmDelete(false);
			setDialog({ mode: "edit", id: savedId });
			dialogRef.current?.showModal();
		},
		[saved],
	);

	/**
	 * Save the dialog: a new recipe appended, or an existing one renamed, recolored and
	 * moved to the position the arrows chose.
	 *
	 * A new recipe also becomes what a bare `/discovery` opens on, because saving one is a
	 * change the reader made on the page — the same rule every other control here follows.
	 * A rename does not touch the opening recipe: it changed the chip's words, not what the
	 * reader is reading.
	 */
	const submitDialog = useCallback(async () => {
		if (!dialog) return;
		const label = draftName.trim();
		if (!label) return;
		setSavingRecipe(true);
		setRecipeError(null);

		let next: SavedRecipe[];
		let homeRecipe: Recipe | undefined;
		if (dialog.mode === "create") {
			next = [...saved, { id: crypto.randomUUID(), label, color: draftColor, recipe }];
			homeRecipe = recipe;
		} else {
			const current = saved.find((row) => row.id === dialog.id);
			if (!current) {
				setSavingRecipe(false);
				closeDialog();
				return;
			}
			const without = saved.filter((row) => row.id !== dialog.id);
			const at = Math.min(Math.max(draftIndex, 0), without.length);
			next = [
				...without.slice(0, at),
				{ ...current, label, color: draftColor },
				...without.slice(at),
			];
		}

		const ok = await writeSaved(next, homeRecipe);
		setSavingRecipe(false);
		if (!ok) {
			setRecipeError("That recipe couldn't be saved.");
			return;
		}
		closeDialog();
	}, [dialog, draftName, draftColor, draftIndex, recipe, saved, writeSaved, closeDialog]);

	/**
	 * Remove a saved recipe. The two-step label is the undo the list does not have: a
	 * preference has no trash, and a name and color somebody chose is worth one more click.
	 * The recipe itself stays on screen as a hand-built combination, which is what makes
	 * deleting a name harmless.
	 */
	const deleteSaved = useCallback(async () => {
		if (dialog?.mode !== "edit") return;
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		setSavingRecipe(true);
		setRecipeError(null);
		const ok = await writeSaved(saved.filter((row) => row.id !== dialog.id));
		setSavingRecipe(false);
		if (!ok) {
			setRecipeError("That recipe couldn't be removed.");
			return;
		}
		closeDialog();
	}, [dialog, confirmDelete, saved, writeSaved, closeDialog]);

	/**
	 * Step through the chips, wrapping at either end.
	 *
	 * From a recipe no chip names, forward starts at the first chip and backward starts at
	 * the last — so the keystroke always lands on a named recipe rather than doing nothing
	 * because the reader had narrowed one stage.
	 */
	const cycleRecipe = useCallback(
		(delta: 1 | -1) => {
			if (choices.length === 0) return;
			const index = activeChoice
				? choices.findIndex((choice) => choice.id === activeChoice.id)
				: -1;
			const next =
				index === -1
					? delta === 1
						? choices[0]
						: choices[choices.length - 1]
					: choices[(index + delta + choices.length) % choices.length];
			applyRecipe(next.recipe);
		},
		[choices, activeChoice, applyRecipe],
	);

	/**
	 * The recipe cycle, bound from the account's map (`Ctrl+[` / `Ctrl+]` by default).
	 *
	 * It fires with a text field focused for the sidebar's reason: a `Ctrl` chord is not an
	 * editing command, and a reader halfway through a filter term should be able to change
	 * the recipe without clicking out first. The one exception is the recipe dialog itself,
	 * where changing the stream behind a modal would be a change nobody asked for.
	 */
	const shortcuts = useKeyboardShortcuts();
	const apple = isApplePlatform();
	/**
	 * 🚨 **The handler reads the cycle through a ref rather than capturing it.** The active
	 * chip follows the URL, so `cycleRecipe` changes identity on every chord; an effect that
	 * re-binds on that identity leaves a window where the next chord is handled by the
	 * previous function, which cycles from the chip that is no longer active and reads as a
	 * lost keystroke. The ref keeps the listener stable and the state current, which is what
	 * makes two chords in quick succession step two chips.
	 */
	const cycleRef = useRef(cycleRecipe);
	cycleRef.current = cycleRecipe;
	useEffect(() => {
		const handler = (event: globalThis.KeyboardEvent) => {
			if (dialogRef.current?.open) return;
			if (matchesChord(event, shortcuts.nextRecipe, apple)) {
				event.preventDefault();
				cycleRef.current(1);
				return;
			}
			if (matchesChord(event, shortcuts.previousRecipe, apple)) {
				event.preventDefault();
				cycleRef.current(-1);
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [shortcuts.nextRecipe, shortcuts.previousRecipe, apple]);

	// The stream: the feed's own, over the candidate set the recipe names. `recipeQuery`
	// is the one place the candidate stage turns into the route's `scope` and
	// `network_source`; `mix` is the recipe's ordering stage. Both are the route's to run.
	// The refresh control bumps this counter; the feed route has no cache buster, so the
	// value exists only to make the dependency real to the linter. `mediaType` is empty
	// under a lens, so the lens draws on every type it covers.
	useEffect(() => {
		void refreshKey;
		const query = recipeQuery(recipe.candidates, recipe.mix);
		setLoading(true);
		client.api.accounts.me.feed
			.$get({
				query: {
					...query,
					...(mediaType === "posts"
						? { kind: "posts" }
						: mediaType
							? { media_type: mediaType }
							: {}),
					...(access ? { access } : {}),
					...(tags ? { tags } : {}),
					...(viewFilter.query ? { q: viewFilter.query } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as { entries: FeedEntry[] };
				setEntries(data.entries ?? []);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [recipe.candidates, recipe.mix, mediaType, access, tags, viewFilter.query, refreshKey]);

	// The window narrows the page the route returned. It is a presentation filter rather
	// than a request parameter, and the recipe bar says so by naming it a stage over the
	// stream rather than a condition on the query.
	const visibleEntries = useMemo(() => {
		const cutoff =
			recipe.window === "day"
				? Date.now() - 24 * 60 * 60 * 1000
				: recipe.window === "week"
					? Date.now() - 7 * 24 * 60 * 60 * 1000
					: null;
		if (cutoff == null) return entries;
		return entries.filter((entry) => new Date(entry.at).getTime() >= cutoff);
	}, [entries, recipe.window]);

	/** The lens's corpus: the stream's releases, translated once per fetch. */
	const lensDraw = useMemo(() => feedLensItems(visibleEntries), [visibleEntries]);

	/**
	 * Which corpus the lenses are reading, for their empty-state words. A lens over the
	 * whole site says something different from a lens over the reader's own network —
	 * before the merge that difference was two tabs, and now it is this.
	 */
	const drawsEveryone = recipe.candidates === "everyone";

	// Sidebar: the lens is the page's own section, and the shared filters sit below the
	// divider the layout draws. The URL carries the lens, so a link to "the stream under
	// the Music Player" survives. Every row is live: a lens is a view over this stream,
	// and the Music Player's dial rides its row.
	useEffect(() => {
		setPageContent(
			<SharedLensesSection
				lens={lens}
				onLens={(id) => updateParams({ lens: id })}
				live={ALL_LENS_IDS}
				extras={{
					music: (
						<MusicDial
							includeSpoken={includeSpoken}
							onIncludeSpoken={(on) => updateParams({ spoken: on ? "1" : "" })}
						/>
					),
				}}
			/>,
		);
		setSharedContent(
			<SharedFilterSections
				type={contentType}
				onType={(id) => updateParams({ media_type: id })}
				unavailableTypes={unavailableTypes}
				tags={tags}
				onTags={(value) => updateParams({ tags: value })}
				access={{ value: access, onAccess: (value) => updateParams({ access: value }) }}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [
		setPageContent,
		setSharedContent,
		contentType,
		unavailableTypes,
		access,
		tags,
		lens,
		includeSpoken,
		updateParams,
	]);

	const filtered = Boolean(contentType || access || tags || viewFilter.query || lens);

	return (
		<div className="min-h-full">
			{/* The feed's wrapper, not a centered container: the grid is meant to use the width
			    the layout already gives it, and Discovery's old centered column capped it 48
			    pixels short of the content area at a wide window. */}
			<div className="w-full px-6 py-6">
				<TabHeader
					icon={MagnifyingGlassIcon}
					title="Discovery"
					subtitle="Your network, and everything else on Anthers. Pick a recipe, or cook up your own. There's no paid promotion or hidden algorithms."
				/>

				<RecipeBar
					recipe={recipe}
					choices={choices}
					activeChoice={activeChoice}
					onChoice={(choice) => applyRecipe(choice.recipe)}
					onRecipe={applyRecipe}
					onSave={openSave}
					onEdit={openEdit}
					canSave={canSave}
					onRefresh={() => setRefreshKey((key) => key + 1)}
				/>

				{loading ? (
					<div className="flex justify-center py-16">
						<LoadingSpinner size="lg" />
					</div>
				) : lens === "music" ? (
					/* A lens reorganizes the stream, never refetches it: the corpus is the
					   same entries the grid draws. */
					<MusicLens
						items={lensDraw}
						includeSpoken={includeSpoken}
						scope={drawsEveryone ? "discovery" : "feed"}
					/>
				) : lens === "bookshelf" ? (
					/* The same shelf metaphor over the stream's written Works: spines instead
					   of tiles, alphabetical by title. */
					<BookshelfLens items={lensDraw} source={drawsEveryone ? "discovery" : "network"} />
				) : lens === "channel-guide" ? (
					/* The stream's videos as creator channels, latest at the top of each
					   column. The feed ships no payload, so the guide reads the delivery
					   address `feedLensItems` composes for it. */
					<ChannelGuideLens
						channels={channelGuideChannelsFromLibrary(lensDraw)}
						source={drawsEveryone ? "discovery" : "feed"}
					/>
				) : visibleEntries.length === 0 ? (
					<EmptyState
						title={activeChoice ? "Nothing here yet" : "Nothing matches this recipe"}
						description={
							drawsEveryone
								? filtered
									? "No Works or Posts across Anthers match these filters. Clear a filter, widen the window, or check back soon."
									: "No Works or Posts have been published across Anthers yet. Check back soon."
								: filtered
									? "Nothing from the creators this recipe draws on matches these filters. Clear a filter, widen the window, or switch From to Everyone."
									: "Nothing from the creators this recipe draws on yet. Switch From to Everyone to see the whole site, or check back soon."
						}
						action={
							drawsEveryone || !ACROSS_ANTHERS ? undefined : (
								<button
									type="button"
									className="btn btn-primary btn-sm"
									onClick={() => applyRecipe(ACROSS_ANTHERS.recipe)}
								>
									Try {ACROSS_ANTHERS.label}
								</button>
							)
						}
					/>
				) : (
					// The same auto-fill grid the Library renders: the columns count
					// themselves from a working tile width, so the shared tile shows at the
					// shared size rather than a narrower one.
					<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
						{visibleEntries.map((entry) => (
							<FeedTile key={`${entry.kind}-${entry.id}`} entry={entry} />
						))}
					</div>
				)}
			</div>

			{/*
			 * The recipe dialog, for both saving and editing. Native `<dialog>` for the
			 * same reason the Work editor uses it: focus trapping, Escape, the backdrop
			 * and the inert background come from the platform rather than from a
			 * hand-rolled modal that gets one of them wrong.
			 */}
			<dialog
				ref={dialogRef}
				className="modal"
				aria-labelledby="recipe-dialog-title"
				onClose={() => {
					setDialog(null);
					setRecipeError(null);
					setConfirmDelete(false);
				}}
			>
				<div className="modal-box max-w-md">
					<h3 id="recipe-dialog-title" className="text-lg font-semibold">
						{dialog?.mode === "edit" ? "Edit recipe" : "Save this recipe"}
					</h3>
					<p className="mt-1 text-sm leading-relaxed text-base-content/70">
						{streamRecipe(recipe).sentence}
					</p>

					<form
						onSubmit={(event) => {
							event.preventDefault();
							void submitDialog();
						}}
					>
						<label htmlFor="recipe-name" className="mt-4 block text-sm font-medium">
							Name
						</label>
						<input
							id="recipe-name"
							className="input input-bordered mt-1 w-full"
							value={draftName}
							maxLength={SAVED_RECIPE_LABEL_MAX}
							onChange={(event) => setDraftName(event.target.value)}
							autoFocus
						/>

						<fieldset className="mt-4">
							<legend className="text-sm font-medium">Color</legend>
							<div className="mt-2 flex flex-wrap gap-2">
								{RECIPE_COLORS.map((color) => {
									const value = RECIPE_COLOR_VALUES[color];
									const selected = draftColor === color;
									return (
										<label key={color} className="cursor-pointer" title={value.label}>
											<input
												type="radio"
												name="recipe-color"
												value={color}
												checked={selected}
												onChange={() => setDraftColor(color)}
												className="sr-only"
											/>
											<span
												style={{ background: value.hex }}
												className={`flex h-8 w-8 items-center justify-center rounded-full ${
													selected
														? "ring-2 ring-base-content/60 ring-offset-2 ring-offset-base-100"
														: ""
												}`}
											>
												{selected && (
													<CheckIcon className="h-4 w-4 text-white" aria-hidden="true" />
												)}
												<span className="sr-only">{value.label}</span>
											</span>
										</label>
									);
								})}
							</div>
						</fieldset>

						{dialog?.mode === "edit" && (
							<div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
								<span className="text-base-content/60">Order</span>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => setDraftIndex((index) => Math.max(0, index - 1))}
									disabled={draftIndex <= 0 || savingRecipe}
								>
									Move earlier
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => setDraftIndex((index) => Math.min(saved.length - 1, index + 1))}
									disabled={draftIndex >= saved.length - 1 || savingRecipe}
								>
									Move later
								</button>
							</div>
						)}

						{recipeError && (
							<p role="alert" className="mt-3 text-sm text-error">
								{recipeError}
							</p>
						)}

						<div className="modal-action">
							{dialog?.mode === "edit" && (
								<button
									type="button"
									className="btn btn-ghost mr-auto text-error"
									onClick={() => void deleteSaved()}
									disabled={savingRecipe}
								>
									{confirmDelete ? "Delete for good?" : "Delete"}
								</button>
							)}
							<button
								type="button"
								className="btn btn-ghost"
								onClick={closeDialog}
								disabled={savingRecipe}
							>
								Cancel
							</button>
							<button
								type="submit"
								className="btn btn-primary"
								disabled={savingRecipe || draftName.trim() === ""}
							>
								{savingRecipe ? "Saving…" : dialog?.mode === "edit" ? "Save" : "Save recipe"}
							</button>
						</div>
					</form>
				</div>
				<form method="dialog" className="modal-backdrop">
					<button type="submit">close</button>
				</form>
			</dialog>
		</div>
	);
}
