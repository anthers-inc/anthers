// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's credits editor — the liner-notes table of the Work Edit page, extracted from
 * `WorkEditPage.tsx` for the same reason `RatingMatrix.tsx` is: one working control, one file.
 *
 * What the bare text input it replaced grew, and the task that moved it here:
 *
 * - **Me** — a button beside every contributor field writing the signed-in account's own
 *   DID into that row, so crediting your own contribution is one action rather than pasting
 *   a handle or a DID by hand. The account's identity is already on the page (`useAuth`);
 *   and the autocomplete finds you the same way it finds anybody — your own handle and
 *   display name are in the same index.
 * - **Identity autocomplete** — as-you-type suggestions from `/api/accounts/identity-search`,
 *   the accounts Anthers already knows. ⚠️ **A picked suggestion writes the DID into the row,
 *   never the display name** — the Studio edit path sends `contributor` back verbatim on save
 *   and the acceptance keys on the DID, so resolving a suggestion to a name would overwrite
 *   the identity on the next save and break the acceptance linkage (`WorkCredit`'s
 *   serialization rules carry this). A freeform name stays exactly that: a name, legal for a
 *   contributor who is not on-network.
 * - **Role suggestions** — the §-category vocabulary as an opt-in `<datalist>`: a prompt to
 *   pick from, never a gate, because roles are freeform by the settled design.
 * - **Guidance at the point of assignment** — the inline copy and the type hovers carry the
 *   rules the 30.04 page teaches, where the creator is choosing: `Created` names who; `AI`
 *   never names a model; a blend is a genuine mixed credit; precision is the rewarded move.
 *
 * One rule is enforced here as on the server: a **Created** credit names its contributor —
 * the Contributor box is disabled and cleared unless Created is among the ticked types.
 */

import { client } from "@anthers/web-shared/rpc";
import type { WorkCredit, WorkCreditType } from "@anthers/web-shared/types";
import { useEffect, useRef, useState } from "react";

/** One identity suggestion under the contributor field. */
interface IdentitySuggestion {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

/** What a credit type is called in the editor, in the order the checkboxes appear. */
const CREDIT_TYPES: { value: WorkCreditType; label: string }[] = [
	{ value: "created", label: "Created" },
	{ value: "licensed", label: "Licensed" },
	{ value: "ai", label: "AI" },
];

/**
 * The hover detail on the type boxes — the point-of-assignment ask, said where choosing
 * happens rather than on a page a creator would have to open. One line per type.
 */
const TYPE_TIPS: Partial<Record<WorkCreditType, string>> = {
	created:
		"A human made this part — alone, or blended with AI or a licensed source. Created names who made it: their identity on the network, or a plain name when they're not on it.",
	licensed:
		"Pre-existing material was used under a right. Name the source or leave it blank — many licenses, Anthers' own Badge art among them, do not require attribution.",
	ai: "A machine made this part. Name the part, never the model — a model owns nothing and is granted nothing. A model's draft you then made your own is a blend: tick Created beside AI, and split the two credits rather than one.",
};

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

export default function CreditsSection({
	rows,
	onChange,
	selfIdentity,
}: {
	rows: WorkCredit[];
	onChange: (next: WorkCredit[]) => void;
	/** The signed-in account's own identity, for the Me button on every row; null when signed out. */
	selfIdentity: { did: string; handle: string; displayName: string | null } | null;
}) {
	const setRow = (index: number, next: WorkCredit) => {
		onChange(rows.map((r, i) => (i === index ? next : r)));
	};
	const toggleType = (index: number, type: WorkCreditType, checked: boolean) => {
		const row = rows[index];
		const types = checked ? [...row.types, type] : row.types.filter((t) => t !== type);
		// Contributor is created-only: unticking the last Created clears it rather than
		// leaving a name attached to a credit that no longer asserts one.
		//
		// ⚠️ The overlay flag drops here rather than surviving the edit: the flag says
		// "this identity has not confirmed yet," and a creator editing the row has
		// changed what the person would be confirming. The flag is display state the
		// server re-derives on the next load, never something this form sends back.
		setRow(index, {
			...row,
			types,
			contributor: types.includes("created") ? row.contributor : "",
			awaitingContributorConfirmation: undefined,
		});
	};
	const missingContributor = (row: WorkCredit) =>
		row.types.includes("created") && row.contributor.trim() === "";

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-base-content/50">
				Who and what made this — users see these as liner notes on the Work. A Created credit names
				who; Licensed and AI credits may stay anonymous. An AI credit never names the model — a tool
				owns nothing. A blend (Created and AI together) is a genuine mixed credit, and precision is
				the rewarded move: say what the machine did beside what the human did. A Work needs at least
				one credit naming a human creator before it can be released.
			</p>
			{rows.length === 0 && (
				<p className="text-xs text-warning">
					No credits yet — add one with its Created box ticked before this can be released.
				</p>
			)}
			{rows.map((row, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: a credit row has no id of its own; the inputs are controlled by position and rows are replaced wholesale on save.
					key={i}
					className="flex flex-wrap items-center gap-3 rounded-lg border border-base-300 p-3"
				>
					<RoleInput
						ariaLabel={`Credit ${i + 1} role`}
						value={row.role}
						onChange={(value) =>
							setRow(i, { ...row, role: value, awaitingContributorConfirmation: undefined })
						}
					/>
					<div className="flex items-center gap-3">
						{CREDIT_TYPES.map((t) => (
							<TypeLabel
								key={t.value}
								label={t.label}
								tip={TYPE_TIPS[t.value]}
								ariaLabel={`Credit ${i + 1} ${t.label}`}
								checked={row.types.includes(t.value)}
								onChange={(e) => toggleType(i, t.value, e.target.checked)}
							/>
						))}
					</div>
					<ContributorInput
						ariaLabel={`Credit ${i + 1} contributor`}
						types={row.types}
						value={row.contributor}
						selfDid={selfIdentity?.did ?? null}
						onChange={(value) =>
							setRow(i, { ...row, contributor: value, awaitingContributorConfirmation: undefined })
						}
					/>
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						aria-label={`Remove credit ${i + 1}`}
						onClick={() => onChange(rows.filter((_, j) => j !== i))}
					>
						Remove
					</button>
					{row.awaitingContributorConfirmation && (
						<p className="w-full text-xs text-base-content/50">
							Waiting on the contributor of this {row.role || "credit"} to confirm it. The DID stays
							as written — it is who the acceptance keys on, and it shows as their name once they
							confirm.
						</p>
					)}
					{missingContributor(row) && (
						<p className="w-full text-xs text-error">
							A Created credit names its contributor — say who made this part.
						</p>
					)}
				</div>
			))}
			{rows.some(missingContributor) && (
				<div className="alert alert-error text-sm">
					<span>Every Created credit names its contributor before this can save.</span>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					className="btn btn-outline btn-sm"
					onClick={() => onChange([...rows, { role: "", contributor: "", types: [] }])}
				>
					Add a credit
				</button>
			</div>
			<p className="text-xs text-base-content/40">
				As you type a contributor, the field suggests the accounts Anthers knows — anyone on the
				network who holds an Anthers account or brought their identity here. Picking one records
				their identity, so they can confirm the credit; anyone not on the network is still credited
				by a plain name.
			</p>
		</div>
	);
}

/** One checkbox-with-hover on a row's type strip. */
function TypeLabel({
	label,
	tip,
	ariaLabel,
	checked,
	onChange,
}: {
	label: string;
	tip?: string;
	ariaLabel: string;
	checked: boolean;
	onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
	const [show, setShow] = useState(false);
	return (
		<label className="label cursor-pointer gap-1.5 py-0">
			<input
				type="checkbox"
				className="checkbox checkbox-sm checkbox-primary"
				aria-label={ariaLabel}
				checked={checked}
				onChange={onChange}
			/>
			<span className="label-text text-sm">{label}</span>
			{tip && (
				<button
					type="button"
					aria-label={`About the ${label} type`}
					className="relative inline-flex cursor-help align-middle"
					onMouseEnter={() => setShow(true)}
					onMouseLeave={() => setShow(false)}
				>
					<span
						aria-hidden="true"
						className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-base-content/20 text-[9px] font-semibold leading-none text-base-content/40"
					>
						i
					</span>
					<span
						className={`pointer-events-none absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 ${
							show ? "block" : "hidden"
						}`}
					>
						<span className="block w-56 rounded-lg border border-base-content/10 bg-base-300 px-3 py-2 text-left text-xs font-normal leading-relaxed normal-case tracking-normal text-base-content/70 shadow-lg">
							{tip}
						</span>
					</span>
				</button>
			)}
		</label>
	);
}

/**
 * The contributor field, with the identity autocomplete on it and the Me button beside it.
 *
 * 🚨 **The stored value is whatever the creator typed, or the DID of a picked suggestion —
 * never the suggestion's display name.** The save sends this field back verbatim and the
 * acceptance keys on the DID; a rendered name in its place is the data-destroying save the
 * `WorkCredit` serialization rules exist to prevent.
 *
 * The fetch is debounced and asks for at least two characters, so a keystroke never turns
 * into a request. The door is rate-limited server-side too; neither layer is the other's
 * substitute.
 *
 * **Me** sits beside the field rather than beside the table (Parker, 2026-10-08): a row is
 * created like any other, and crediting yourself is an answer the field offers, not a
 * second row-shape. The autocomplete finds you too — your own handle and display name are
 * in the same index — so Me is the shortcut, not the only path.
 */
function ContributorInput({
	ariaLabel,
	types,
	value,
	selfDid,
	onChange,
}: {
	ariaLabel: string;
	types: WorkCreditType[];
	value: string;
	/** The signed-in account's own DID; null hides the Me button. */
	selfDid: string | null;
	onChange: (value: string) => void;
}) {
	const createdTicked = types.includes("created");
	/** What the current query has fetched, or null while it has nothing settled to show. */
	const [results, setResults] = useState<IdentitySuggestion[] | null>(null);
	const [open, setOpen] = useState(false);
	/** The run counter — a settled answer is dropped when a newer keystroke has superseded it. */
	const seqRef = useRef(0);

	useEffect(() => {
		const q = value.trim();
		// A DID is already resolved — the value came from a pick (or a hand paste), and
		// suggesting identities over a DID is nonsense.
		if (q.length < 2 || isDid(q)) {
			setResults(null);
			setOpen(false);
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
				setOpen(true);
			} catch {
				setResults(null);
				setOpen(false);
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [value]);

	const showList = open && results != null && results.length > 0 && !isDid(value.trim());
	const didStored = isDid(value);

	return (
		<div className="flex flex-1 min-w-40 items-center gap-1">
			<div className="relative flex-1 min-w-0">
				<input
					type="text"
					aria-label={ariaLabel}
					className="input input-bordered input-sm w-full"
					placeholder={
						!createdTicked ? "Optional" : didStored ? "Credited by identity" : "Who made this part"
					}
					value={value}
					disabled={!createdTicked}
					onFocus={() => {
						if (results != null && results.length > 0) setOpen(true);
					}}
					onBlur={() => setOpen(false)}
					onChange={(e) => onChange(e.target.value)}
				/>
				{showList && (
					<ul className="absolute top-full left-0 z-50 mt-1 w-full rounded-lg border border-base-content/10 bg-base-100 py-1 shadow-lg">
						{results.map((s, j) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: two credits can name the same identity under different roles, so the DID is not unique in this list; the order is stable per fetch.
							<li key={`${s.did}-${j}`}>
								<button
									type="button"
									className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-base-200"
									// mousedown, not click: fires before the input's blur,
									// which would tear this list down before the click ran.
									onMouseDown={(e) => {
										e.preventDefault();
										onChange(s.did);
										setOpen(false);
									}}
								>
									{s.avatar ? (
										<img src={s.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
									) : (
										<div className="flex h-6 w-6 items-center justify-center rounded-full bg-base-300 text-xs font-bold">
											{(s.displayName ?? s.handle).charAt(0).toUpperCase()}
										</div>
									)}
									<span className="font-medium">{s.displayName ?? s.handle}</span>
									<span className="text-xs text-base-content/50">{s.handle}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
			{selfDid && createdTicked && value.trim() !== selfDid && (
				<button
					type="button"
					aria-label={`${ariaLabel} — credit yourself`}
					title="Credit yourself on this row"
					className="btn btn-ghost btn-xs shrink-0"
					onClick={() => onChange(selfDid)}
				>
					Me
				</button>
			)}
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
		<div className="relative w-44">
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
				<ul className="absolute top-full left-0 z-50 mt-1 w-full rounded-lg border border-base-content/10 bg-base-100 py-1 shadow-lg">
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
