// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's credits editor — the liner-notes table of the Work Edit page, extracted from
 * `WorkEditPage.tsx` for the same reason `RatingMatrix.tsx` is: one working control, one file.
 *
 * What the bare text input it replaced grew, and the task that moved it here:
 *
 * - **A contribution names one or more people.** A card is a contribution (its role and its
 *   Created/Generated boxes) over a contributor area that holds a list, so "Illustrated by
 *   John Doe, Jane Doe" is one line on the Work page. ⚠️ **The stored shape stays one credit
 *   row per person**: the published record's `contributor` is a single union, and each
 *   identity's acceptance keys on its own DID plus role, so several names are several rows
 *   sharing one role. `cardsFromRows` and `rowsFromCards` are that translation in both
 *   directions; the read side regroups them (`WorkLayout.tsx`'s `WorkCredits`).
 * - **The contributor area is the identity picker.** Clicking it offers the signed-in
 *   creator first, before any typing, marked with a "You" chip; typing searches the accounts
 *   Anthers already knows (`/api/accounts/identity-search`). ⚠️ **A picked suggestion writes
 *   the DID into the row, never the display name** — the Studio edit path sends `contributor`
 *   back verbatim on save and the acceptance keys on the DID, so resolving a suggestion to a
 *   name would overwrite the identity on the next save and break the acceptance linkage
 *   (`WorkCredit`'s serialization rules carry this). A freeform name stays exactly that: a
 *   name, legal for a contributor who is not on-network, added with Enter.
 * - **Role suggestions** — the §-category vocabulary as a soft list under the field: a prompt
 *   to pick from, never a gate, because roles are freeform by the settled design.
 * - **Guidance lives above the table and in hovers**, not in paragraphs through the flow. The
 *   policy link is the one line above the table, matching the Rating tab; each control's
 *   specific ask is an (i) beside it, in the Rating table's own tooltip treatment.
 *
 * One rule is enforced here as on the server: a **Created** credit names its contributor —
 * the contributor area is disabled and cleared unless Created is among the ticked types. The
 * inline error for an unfilled field, though, is a save-time complaint, never a live one: a
 * freshly ticked Created box stays quiet until a save attempt finds the card still empty.
 */

import { client } from "@anthers/web-shared/rpc";
import type { WorkCredit, WorkCreditType } from "@anthers/web-shared/types";
import { InformationCircleIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { CREDITS_WIKI_URL } from "../lib/wiki";

/** One identity suggestion under the contributor area. */
interface IdentitySuggestion {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

/** The signed-in account, offered as the first pick in every contributor area. */
export interface SelfIdentity {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

/** One person on a contribution card. `value` is the stored credit contributor. */
interface PersonRef {
	/** The stored value: a `did:` string, or a plain name for somebody not on the network. */
	value: string;
	/** How a DID presents as a person; null for a plain name or an unresolved identity. */
	profile?: { handle: string | null; displayName: string | null; avatar: string | null } | null;
}

/** One contribution card: row one's role and types, row two's people. */
interface CreditCard {
	role: string;
	types: WorkCreditType[];
	people: PersonRef[];
	/** The people on this card whose identity credit is still awaiting their confirmation. */
	awaiting: string[];
}

/** What a credit type is called in the editor, in the order the boxes appear. */
const CREDIT_TYPES: { value: WorkCreditType; label: string }[] = [
	{ value: "created", label: "Created" },
	{ value: "generated", label: "Generated" },
];

/**
 * The hover detail on the type boxes — the point-of-assignment ask, said where choosing
 * happens. One line per type, in the Rating table's tooltip treatment.
 */
const TYPE_TIPS: Record<WorkCreditType, string> = {
	created:
		"A person or copyright-capable entity made this part. Work-for-hire, licensed and public-domain material all credit here the same way.",
	generated:
		"A machine made this part. Never name the model. A machine's draft you then made your own is a blend: tick Created beside Generated and split the two credits.",
};

/** What the contributor area's (i) says — the guidance that used to sit under the table. */
const CONTRIBUTOR_TIP =
	"Anthers suggests accounts it knows as you type. Picking one records their identity, so they can confirm the credit. Type a name and press Enter to credit someone who is not on the network.";

/**
 * The role vocabulary the settled design kept — the law's §102 categories as a convenience
 * for finding a label, beside the industry's own terms. Freeform stays: a role is whatever
 * the industry's term for the contribution is.
 *
 * ⚠️ Rendered as a hand-rolled suggestion list rather than a `<datalist>`: a `list`-bound
 * text input is answered the `combobox` ARIA role, which would re-key every existing
 * selector on this field and diverge from the contributor field beside it, which is not
 * datalist-able at all. One shape for both.
 */
const SUGGESTED_ROLES: readonly string[] = Object.freeze([
	"Written by",
	"Directed by",
	"Composed by",
	"Lyrics by",
	"Performed by",
	"Narrated by",
	"Illustrated by",
	"Photographed by",
	"Animated by",
	"Cut by",
	"Designed by",
	"Programmed by",
	"Translated by",
	"Produced by",
]);

/** Whether a contributor string is an identity (a DID) rather than a freeform name. */
function isDid(value: string): boolean {
	return value.startsWith("did:");
}

/** The key two stored rows share when they belong on one card. */
function cardKey(role: string, types: WorkCreditType[]): string {
	return `${role}\u0000${[...types].sort().join(",")}`;
}

/**
 * Group stored credit rows into contribution cards.
 *
 * Rows sharing a role and a type set are one contribution — that is what a multi-person
 * credit looks like on the row, and grouping it back is what makes a saved
 * "Illustrated by John Doe, Jane Doe" reopen as one card rather than two.
 */
function cardsFromRows(rows: WorkCredit[]): CreditCard[] {
	const cards: CreditCard[] = [];
	const byKey = new Map<string, CreditCard>();
	for (const row of rows) {
		const key = cardKey(row.role, row.types);
		let card = byKey.get(key);
		if (!card) {
			card = { role: row.role, types: [...row.types], people: [], awaiting: [] };
			byKey.set(key, card);
			cards.push(card);
		}
		const value = row.contributor;
		if (value.trim() === "") continue; // an anonymous Generated row, or an empty Created row
		if (!card.people.some((p) => p.value === value)) {
			card.people.push({ value, profile: row.contributorProfile ?? null });
		}
		if (row.awaitingContributorConfirmation) card.awaiting.push(value);
	}
	return cards;
}

/**
 * Flatten cards back into the stored rows.
 *
 * A card with no people still emits one row, so a pure Generated credit keeps its place in
 * the list and a Created card with nobody named is the row the save's validation refuses.
 */
function rowsFromCards(cards: CreditCard[]): WorkCredit[] {
	const rows: WorkCredit[] = [];
	for (const card of cards) {
		if (card.people.length === 0) {
			rows.push({ role: card.role, contributor: "", types: [...card.types] });
			continue;
		}
		for (const person of card.people) {
			rows.push({ role: card.role, contributor: person.value, types: [...card.types] });
		}
	}
	return rows;
}

/** How a person reads in a chip: their name, their handle, or a shortened identity. */
function personName(person: PersonRef): string {
	const profile = person.profile;
	if (profile?.displayName?.trim()) return profile.displayName.trim();
	if (profile?.handle) return profile.handle;
	if (isDid(person.value)) return `${person.value.slice(0, 20)}…`;
	return person.value;
}

export default function CreditsSection({
	rows,
	onChange,
	selfIdentity,
	showErrors,
}: {
	rows: WorkCredit[];
	onChange: (next: WorkCredit[]) => void;
	/** The signed-in account, offered first in every contributor area; null when signed out. */
	selfIdentity: SelfIdentity | null;
	/** Whether a save attempt has caught a malformed row — the inline error speaks only then, never while the creator is still filling the field in. */
	showErrors: boolean;
}) {
	// The cards are local to the edit session: the parent's draft stays the flat stored
	// shape, and every card change flattens back into it. Seeded once, so grouping cannot
	// re-run mid-keystroke and merge a card with another one the creator is typing toward.
	const [cards, setCards] = useState<CreditCard[]>(() => cardsFromRows(rows));

	const commit = (next: CreditCard[]) => {
		setCards(next);
		onChange(rowsFromCards(next));
	};

	const setCard = (index: number, next: CreditCard) => {
		commit(cards.map((c, i) => (i === index ? next : c)));
	};

	const toggleType = (index: number, type: WorkCreditType, checked: boolean) => {
		const card = cards[index];
		const types = checked ? [...card.types, type] : card.types.filter((t) => t !== type);
		// Contributors are created-only: unticking the last Created clears them rather than
		// leaving people attached to a credit that no longer asserts a person made it.
		//
		// ⚠️ The awaiting note drops here rather than surviving the edit: it says "this
		// identity has not confirmed yet," and a creator editing the card has changed what
		// the person would be confirming. The note is display state the server re-derives
		// on the next load, never something this form sends back.
		setCard(index, {
			...card,
			types,
			people: types.includes("created") ? card.people : [],
			awaiting: types.includes("created") ? card.awaiting : [],
		});
	};

	const missingContributor = (card: CreditCard) =>
		card.types.includes("created") && card.people.length === 0;

	return (
		<div className="flex flex-col gap-3">
			<a href={CREDITS_WIKI_URL} target="_blank" rel="noopener noreferrer" className="link text-xs">
				Learn More About Our Credits
			</a>

			{cards.length === 0 && (
				<p className="text-xs text-warning">
					A Work needs at least one Created credit naming a human before it can be released.
				</p>
			)}

			<div className="flex flex-col gap-3">
				{cards.map((card, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a contribution card has no id of its own; the inputs are controlled by position and the cards are replaced wholesale on save.
						key={i}
						className="rounded-md border border-base-300"
					>
						{/* Row one — the contribution and what made it. */}
						<div className="flex flex-wrap items-center gap-3 border-b border-base-300 p-3">
							<div className="min-w-40 flex-1">
								<RoleInput
									ariaLabel={`Credit ${i + 1} role`}
									value={card.role}
									onChange={(role) => setCard(i, { ...card, role, awaiting: [] })}
								/>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{CREDIT_TYPES.map((t) => (
									<TypeBox
										key={t.value}
										label={t.label}
										tip={TYPE_TIPS[t.value]}
										ariaLabel={`Credit ${i + 1} ${t.label}`}
										checked={card.types.includes(t.value)}
										onChange={(e) => toggleType(i, t.value, e.target.checked)}
									/>
								))}
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-xs ml-auto"
								aria-label={`Remove credit ${i + 1}`}
								onClick={() => commit(cards.filter((_, j) => j !== i))}
							>
								Remove
							</button>
						</div>

						{/* Row two — who made it. */}
						<div className="flex flex-col gap-2 p-3">
							<ContributorPicker
								ariaLabel={`Credit ${i + 1} contributors`}
								people={card.people}
								selfIdentity={selfIdentity}
								disabled={!card.types.includes("created")}
								onChange={(people) =>
									setCard(i, {
										...card,
										people,
										awaiting: card.awaiting.filter((v) => people.some((p) => p.value === v)),
									})
								}
							/>
							{card.awaiting.map((value) => {
								const person = card.people.find((p) => p.value === value);
								if (!person) return null;
								return (
									<p key={value} className="text-xs text-base-content/50">
										Waiting on {personName(person)} to confirm this credit. It appears on the Work
										once they do.
									</p>
								);
							})}
							{showErrors && missingContributor(card) && (
								<p className="text-xs text-error">
									A Created credit names its contributor. Say who made this part.
								</p>
							)}
						</div>
					</div>
				))}
			</div>

			<div>
				<button
					type="button"
					className="btn btn-outline btn-sm"
					onClick={() => commit([...cards, { role: "", types: [], people: [], awaiting: [] }])}
				>
					Add a credit
				</button>
			</div>
		</div>
	);
}

/**
 * One type box, in the Rating table's cell shape: a bordered box whose checked state wears
 * the primary color, with the ask on an (i) that opens the same tooltip the rating rows use.
 */
function TypeBox({
	label,
	tip,
	ariaLabel,
	checked,
	onChange,
}: {
	label: string;
	tip: string;
	ariaLabel: string;
	checked: boolean;
	onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
	return (
		<div
			className={`flex items-center gap-2 rounded-md border p-2 text-xs ${
				checked ? "border-primary bg-primary/10" : "border-base-300"
			}`}
		>
			<label className="flex cursor-pointer items-center gap-2">
				<input
					type="checkbox"
					className="checkbox checkbox-xs checkbox-primary shrink-0"
					aria-label={ariaLabel}
					checked={checked}
					onChange={onChange}
				/>
				<span className={checked ? "" : "text-base-content/70"}>{label}</span>
			</label>
			<div className="tooltip tooltip-left ml-auto shrink-0" data-tip={tip}>
				<button type="button" tabIndex={0} aria-label={`About the ${label} type`} className="block">
					<InformationCircleIcon className="size-3.5 text-base-content/30 hover:text-base-content/70" />
				</button>
			</div>
		</div>
	);
}

/**
 * The contributor area: chips for the people on the contribution, and one input that both
 * searches the identity index and accepts a plain name.
 *
 * Clicking the empty area offers the signed-in creator before a keystroke — the "Me" button
 * this replaced was the same answer in a second control. A picked identity records its DID
 * and presents as its person; the DID itself never becomes the field's face.
 */
function ContributorPicker({
	ariaLabel,
	people,
	selfIdentity,
	disabled,
	onChange,
}: {
	ariaLabel: string;
	people: PersonRef[];
	selfIdentity: SelfIdentity | null;
	disabled: boolean;
	onChange: (next: PersonRef[]) => void;
}) {
	const [query, setQuery] = useState("");
	/** What the current query has fetched, or null while it has nothing settled to show. */
	const [results, setResults] = useState<IdentitySuggestion[] | null>(null);
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(-1);
	/** The run counter — a settled answer is dropped when a newer keystroke has superseded it. */
	const seqRef = useRef(0);

	useEffect(() => {
		const q = query.trim();
		// A DID is already resolved — the value came from a pick (or a hand paste), and
		// suggesting identities over a DID is nonsense.
		if (q.length < 2 || isDid(q)) {
			setResults(null);
			return;
		}
		seqRef.current += 1;
		const mySeq = seqRef.current;
		const timer = setTimeout(async () => {
			try {
				const res = await client.api.accounts["identity-search"].$get({
					query: { q },
				});
				if (!res.ok) {
					setResults(null);
					return;
				}
				const body = (await res.json()) as { identities?: IdentitySuggestion[] };
				// A stale answer (an older keystroke, resolved after a newer one) is
				// dropped rather than shown under a query it does not match.
				if (seqRef.current !== mySeq) return;
				setResults(body.identities ?? []);
			} catch {
				setResults(null);
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [query]);

	const taken = new Set(people.map((p) => p.value));
	const selfTaken = !selfIdentity || taken.has(selfIdentity.did);
	const typed = query.trim().toLowerCase();

	// The creator first, before any typing and while their name or handle still matches —
	// the one-click self-credit, as an answer the field gives.
	const selfOption: IdentitySuggestion | null =
		selfIdentity &&
		!selfTaken &&
		(!typed ||
			selfIdentity.handle.toLowerCase().includes(typed) ||
			(selfIdentity.displayName ?? "").toLowerCase().includes(typed))
			? { ...selfIdentity }
			: null;

	const searched = (results ?? []).filter((s) => !taken.has(s.did) && s.did !== selfIdentity?.did);
	const options = selfOption ? [selfOption, ...searched] : searched;
	const showList = open && !disabled && options.length > 0;

	const add = (next: PersonRef) => {
		if (taken.has(next.value)) return;
		onChange([...people, next]);
		setQuery("");
		setResults(null);
		setHighlight(-1);
	};

	const addPlainName = (name: string) => {
		const value = name.trim();
		if (!value) return;
		add({ value, profile: null });
	};

	const pick = (s: IdentitySuggestion) => {
		add({
			value: s.did,
			profile: { handle: s.handle, displayName: s.displayName, avatar: s.avatar },
		});
	};

	const selfDid = selfIdentity?.did ?? null;
	const activeOption = highlight >= 0 && highlight < options.length ? options[highlight] : null;

	return (
		<div className="flex items-start gap-2">
			<div className="relative min-w-0 flex-1">
				{/* The field is the whole box, chips included, so clicking anywhere in it opens
				    the picker — including the empty space beside a short list of names. */}
				<div
					className={`flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-1.5 py-1 ${
						disabled
							? "border-base-300 bg-base-200/50"
							: "border-base-300 bg-base-100 focus-within:border-primary"
					}`}
				>
					{people.map((person) => {
						const name = personName(person);
						const profile = person.profile;
						const self = person.value === selfDid;
						return (
							<span
								key={person.value}
								className="inline-flex items-center gap-1 rounded-full border border-base-300 bg-base-200/70 py-0.5 pl-1 pr-1.5 text-xs"
								title={person.value}
							>
								{self && selfIdentity?.avatar ? (
									<img
										src={selfIdentity.avatar}
										alt=""
										className="h-5 w-5 rounded-full object-cover"
									/>
								) : profile?.avatar ? (
									<img src={profile.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
								) : profile ? (
									<span className="flex h-5 w-5 items-center justify-center rounded-full bg-base-300 text-[10px] font-bold">
										{name.charAt(0).toUpperCase()}
									</span>
								) : (
									// A plain name wears the same-sized "no identity" circle its read side
									// does, so a contribution's people line up whatever each one is written as.
									<span className="flex h-5 w-5 items-center justify-center rounded-full bg-base-300">
										<UserIcon className="h-3.5 w-3.5 text-base-content/50" />
									</span>
								)}
								<span className="max-w-52 truncate">{name}</span>
								{self && <span className="badge badge-xs badge-primary">You</span>}
								<button
									type="button"
									className="text-base-content/40 hover:text-base-content/80"
									aria-label={`Remove ${name} from ${ariaLabel}`}
									onClick={() => {
										if (disabled) return;
										onChange(people.filter((p) => p.value !== person.value));
									}}
								>
									×
								</button>
							</span>
						);
					})}
					<input
						type="text"
						aria-label={ariaLabel}
						className="min-w-24 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
						placeholder={
							!disabled ? (people.length === 0 ? "Name or handle" : "Add another") : "Optional"
						}
						value={query}
						disabled={disabled}
						onFocus={() => setOpen(true)}
						onBlur={() => {
							setOpen(false);
							setHighlight(-1);
						}}
						onChange={(e) => {
							setQuery(e.target.value);
							setHighlight(-1);
							setOpen(true);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setHighlight((h) => Math.min(h + 1, options.length - 1));
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setHighlight((h) => Math.max(h - 1, -1));
								return;
							}
							if (e.key === "Escape") {
								setOpen(false);
								return;
							}
							if (e.key === "Enter") {
								e.preventDefault();
								if (activeOption) pick(activeOption);
								else addPlainName(query);
							}
						}}
					/>
				</div>

				{showList && (
					<ul
						aria-label="Contributor suggestions"
						className="absolute top-full left-0 z-50 mt-1 min-w-72 max-w-sm rounded-lg border border-base-content/10 bg-base-100 py-1 shadow-lg"
					>
						{options.map((s, j) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the same identity can appear once per card, so the DID is not unique across a render; the order is stable per fetch.
							<li key={`${s.did}-${j}`}>
								<button
									type="button"
									className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
										j === highlight ? "bg-base-200" : "hover:bg-base-200"
									}`}
									// mousedown, not click: fires before the input's blur,
									// which would tear this list down before the click ran.
									onMouseDown={(e) => {
										e.preventDefault();
										pick(s);
									}}
								>
									{s.avatar ? (
										<img src={s.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
									) : (
										<div className="flex h-6 w-6 items-center justify-center rounded-full bg-base-300 text-xs font-bold">
											{(s.displayName ?? s.handle).charAt(0).toUpperCase()}
										</div>
									)}
									<span className="min-w-0 truncate font-medium">{s.displayName ?? s.handle}</span>
									<span className="min-w-0 truncate text-xs text-base-content/50">{s.handle}</span>
									{s.did === selfDid && (
										<span className="badge badge-xs badge-primary ml-auto shrink-0">You</span>
									)}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* The guidance that used to sit under the table, at the control it describes. */}
			<div className="tooltip tooltip-left mt-2 shrink-0" data-tip={CONTRIBUTOR_TIP}>
				<button type="button" tabIndex={0} aria-label="About contributors">
					<InformationCircleIcon className="size-4 text-base-content/30 hover:text-base-content/70" />
				</button>
			</div>
		</div>
	);
}

/**
 * The role field, with the §-category suggestions on it.
 *
 * The suggestions are a soft prompt: a list under the field while it is focused, filtered
 * by what has been typed, and never a gate — a role is freeform by the settled design, and
 * clicking a suggestion fills the field the way a typed role would. No fetch: the whole
 * vocabulary is rendered client-side.
 */
function RoleInput({
	ariaLabel,
	value,
	onChange,
}: {
	ariaLabel: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const typed = value.trim().toLowerCase();
	// The matches, when there is anything typed to filter on: starts-with first, then
	// contains, each alphabetically — a stable order a repeated keystroke keeps.
	const matches = typed ? SUGGESTED_ROLES.filter((r) => r.toLowerCase().includes(typed)) : [];
	const showList = open && matches.length > 0 && matches[0] !== value.trim();

	return (
		<div className="relative">
			<input
				type="text"
				aria-label={ariaLabel}
				className="input input-bordered input-sm w-full"
				placeholder="Written by, Cut by…"
				value={value}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onChange={(e) => onChange(e.target.value)}
			/>
			{showList && (
				<ul className="absolute top-full left-0 z-50 mt-1 w-full min-w-56 rounded-lg border border-base-content/10 bg-base-100 py-1 shadow-lg">
					{matches.map((r, j) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the vocabulary is a frozen constant, so the index is the item's identity for as long as the build runs.
						<li key={`${r}-${j}`}>
							<button
								type="button"
								className="block w-full px-3 py-1.5 text-left text-sm hover:bg-base-200"
								// mousedown, not click: fires before the input's blur,
								// which would tear this list down before the click ran.
								onMouseDown={(e) => {
									e.preventDefault();
									onChange(r);
									setOpen(false);
								}}
							>
								{r}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
