// SPDX-License-Identifier: Apache-2.0
/**
 * The title editor with a `@` picker for the author's Works.
 *
 * ⭐ **The input shows the title a reader would see; the stored title is the link form.**
 * Typing `@` offers the author's released Works; picking one inserts `@Curtains` and
 * remembers which Work that run of characters names. The canonical markdown
 * (`[@Curtains](/works/curtains-534000269)`) is what `onChange` emits and what the post
 * stores, so a later retitle still resolves through the id. Editing inside a mention's
 * characters drops the link and leaves plain text — the same thing that happens when you
 * edit an `@` on any other network.
 *
 * Only released Works are offered: a public post naming an unreleased Work would be a
 * leak in the title itself, and the API strips such a mention on write anyway. Mentions of
 * another creator's Work are not offered yet (the search that would need to carry the
 * full visibility allow-list is its own task); the resolver already handles them.
 */

import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { client } from "../../lib/rpc";
import type { Work } from "../../lib/types";
import {
	activeMention,
	fromCanonical,
	insertMention,
	type MentionState,
	type MentionWork,
	reconcileRanges,
	toCanonical,
} from "./title-mention-ranges";

export default function MentionTitleInput({
	canonical,
	onChange,
}: {
	/** The stored title, as `InlineField`'s draft. */
	canonical: string;
	onChange: (next: string) => void;
}) {
	const [works, setWorks] = useState<Work[]>([]);
	const [state, setState] = useState<MentionState>(() => ({ plain: "", ranges: [] }));
	const [caret, setCaret] = useState<number | null>(null);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	/** Set the first time the author changes the field, so late Catalog loads stop resetting it. */
	const dirty = useRef(false);
	const byId = useMemo(() => {
		const map = new Map<number, MentionWork>();
		for (const work of works) {
			if (work.publicId == null) continue;
			map.set(work.publicId, {
				publicId: work.publicId,
				slug: work.slug ?? "",
				title: work.title,
			});
		}
		return map;
	}, [works]);

	// The author's Catalog, offered once the field opens. A failure leaves the picker
	// empty and the field still usable as a plain title.
	useEffect(() => {
		client.api.content.works
			.$get()
			.then(async (res) =>
				res.ok ? ((await res.json()) as unknown as { works: Work[] }).works : [],
			)
			.then(setWorks)
			.catch(() => setWorks([]));
	}, []);

	// Adopt the stored title on open, and re-read the visible names once the Catalog
	// arrives — unless the author has already started typing into the field.
	useEffect(() => {
		if (dirty.current) return;
		setState(fromCanonical(canonical, byId));
	}, [canonical, byId]);

	const emit = (next: MentionState) => {
		dirty.current = true;
		setState(next);
		onChange(toCanonical(next.plain, next.ranges, byId));
	};

	const mention = caret != null ? activeMention(state.plain, caret) : null;
	const matches = useMemo(() => {
		if (!mention) return [];
		const query = mention.query.toLowerCase();
		return works
			.filter((work) => work.visibility === "released" && work.publicId != null)
			.filter((work) => (work.title ?? "").toLowerCase().includes(query))
			.slice(0, 6);
	}, [mention, works]);
	const listOpen = open && mention != null && matches.length > 0;

	const choose = (work: Work) => {
		if (!mention || work.publicId == null || !work.slug) return;
		const end = caret ?? state.plain.length;
		const next = insertMention(state, mention.start, end, {
			publicId: work.publicId,
			slug: work.slug,
			title: work.title,
		});
		emit(next);
		setOpen(false);
		const at = next.ranges[next.ranges.length - 1]?.end ?? mention.start;
		setCaret(at);
		requestAnimationFrame(() => {
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			input.setSelectionRange(at, at);
		});
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (!listOpen) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((index) => (index + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((index) => (index - 1 + matches.length) % matches.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const work = matches[active];
			if (work) choose(work);
		} else if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		}
	};

	return (
		<div className="relative w-full">
			<input
				ref={inputRef}
				type="text"
				role="combobox"
				className="input input-bordered w-full"
				value={state.plain}
				onChange={(event) => {
					const plain = event.target.value;
					const ranges = reconcileRanges(state.plain, plain, state.ranges);
					emit({ plain, ranges });
					setCaret(event.target.selectionStart ?? plain.length);
					setOpen(true);
					setActive(0);
				}}
				onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
				onClick={(event) => {
					setCaret(event.currentTarget.selectionStart);
					setOpen(true);
				}}
				onKeyDown={onKeyDown}
				onBlur={() => setOpen(false)}
				placeholder="Post title"
				aria-label="Post title"
				aria-expanded={listOpen}
				aria-controls="post-title-mentions"
				aria-autocomplete="list"
				aria-activedescendant={listOpen ? `post-title-mention-${active}` : undefined}
			/>
			<p className="mt-1 text-xs text-base-content/60">Type @ to mention one of your Works.</p>
			{listOpen && (
				<div
					id="post-title-mentions"
					role="listbox"
					aria-label="Your Works"
					className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-box border border-base-300 bg-base-100 shadow-lg"
				>
					{matches.map((work, index) => (
						<button
							key={work.publicId}
							type="button"
							id={`post-title-mention-${index}`}
							role="option"
							aria-selected={index === active}
							className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
								index === active ? "bg-base-200" : ""
							}`}
							onMouseDown={(event) => {
								event.preventDefault();
								choose(work);
							}}
						>
							<span className="font-medium">{work.title || "Untitled"}</span>
							<span className="text-xs text-base-content/50">{work.type}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
