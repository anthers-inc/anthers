// SPDX-License-Identifier: Apache-2.0
/**
 * The rating table — the one face of the rating, shown in full on the Rating tab in both of
 * the tab's views (Parker, 2026-10-16): interactive in the creator's, read-only in a user's.
 * The tab exists for the table, so the table is always there, whatever the Work is rated — a
 * General Work shows its all-General table, and an unrated one shows every row waiting, each
 * with its warning bar, which is what "Unrated" means made visible.
 *
 * ⭐ **The table is the choices, not its own explanation.** Each cell holds just its answer,
 * and each answer's ⓘ carries the Rating Standard's own line for where that rung begins on
 * that row, from `RATING_ROWS` — hover replaces a line of text a creator has already read by
 * their third Work. A rung a row never reaches is shown and not offered.
 *
 * ⭐ **The column headings answer the whole table.** Clicking one sets every row at that
 * answer, at the closest rung the row actually reaches (`closestRungLevel`) — Adult sets
 * Violence to Explicit on the light grid, because there is no Adult rung for violence to set.
 * It is a starting point a creator corrects row by row, never a completion of the matrix on
 * their behalf: rows already answered are set too, because a heading names a whole rating,
 * and a creator who wants only one row changed uses the row.
 *
 * ⭐ ***None* is an answer, and an unanswered row is not.** The column exists because a row
 * marked *None* is a statement a user's own filter can rely on. So the table never fills a
 * row on the creator's behalf, and the Work stays unrated until every row has been answered —
 * a draft awaiting its save included, the state reading from the table as it stands.
 */

import {
	type ContentNote,
	closestRungLevel,
	GRID_ANSWER_LABELS,
	type MaturityRows,
	RATING_ROWS,
	RATINGS_WIKI_URL,
	type RatingGrid,
	type RowLevel,
} from "@anthers/shared/content-rating";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { InformationCircleIcon } from "@heroicons/react/24/outline";

const COLUMNS: readonly RowLevel[] = ["none", "general", "mature", "adult"];

/** How the grid asks, above the table: one link, in a new tab, to the standard itself. */
function RatingsLearnMore() {
	return (
		<a href={RATINGS_WIKI_URL} target="_blank" rel="noopener noreferrer" className="link text-xs">
			Learn More About Our Ratings
		</a>
	);
}

/** A chosen cell wears its rung's color, the same one its badge wears everywhere else. */
function chosenClass(level: RowLevel): string {
	if (level === "mature") return "border-warning bg-warning/15";
	if (level === "adult") return "border-error bg-error/10";
	return "border-primary bg-primary/10";
}

/**
 * One row's cells, shared by both faces. In the read-only face an unanswered row shows no
 * selection at all, which is the fact "—" names elsewhere; the row's warning bar says the
 * same thing in the creator's face, where an answer is owed.
 */
function RowCells({
	grid,
	row,
	pick,
	onPick,
}: {
	grid: RatingGrid;
	row: (typeof RATING_ROWS)[number];
	pick: RowLevel | undefined;
	onPick?: (level: RowLevel) => void;
}) {
	const answerLabel = GRID_ANSWER_LABELS[grid];
	return (
		<>
			{COLUMNS.map((level) => {
				const line = level === "none" ? null : row.rungs[grid][level];
				if (level !== "none" && line === null) {
					return (
						<td key={level}>
							<div className="rounded-md border border-dashed border-base-300 p-2 text-[11px] text-base-content/30">
								N/A
							</div>
						</td>
					);
				}
				const on = pick === level;
				// The id pairs the radio with its label's htmlFor — Biome's a11y rule wants a
				// static association, and a stable id per cell is one anyway (the name groups
				// the row's answers).
				const id = `rating-row-${row.note}-${level}`;
				// A read-only radio still announces its checked state to a screen reader;
				// readOnly satisfies the checked-without-onChange shape for React.
				const radio = (
					<input
						id={id}
						type="radio"
						className="radio radio-xs shrink-0"
						name={`rating-row-${row.note}`}
						aria-label={`${row.label}: ${answerLabel[level]}`}
						checked={on}
						readOnly={!onPick}
						tabIndex={!onPick ? -1 : undefined}
						onChange={() => onPick?.(level)}
					/>
				);
				const word = <span className={on ? "" : "text-base-content/70"}>{answerLabel[level]}</span>;
				return (
					<td key={level}>
						<div
							className={`flex h-full items-center gap-1.5 rounded-md border p-2 text-xs ${
								level === "none" ? "justify-center " : ""
							}${on ? chosenClass(level) : "border-base-300"}`}
						>
							{onPick ? (
								// The choice (radio and word both) is the click target; the ⓘ sits
								// beside it, hover for the line, never a second click.
								<label htmlFor={id} className="flex cursor-pointer items-center gap-2">
									{radio}
									{word}
								</label>
							) : (
								<>
									{radio}
									{word}
								</>
							)}
							{line && (
								<div className="tooltip tooltip-left ml-auto shrink-0" data-tip={line}>
									<button
										type="button"
										tabIndex={!onPick ? -1 : 0}
										aria-label={`${row.label}, ${answerLabel[level]}: ${line}`}
									>
										<InformationCircleIcon className="size-3.5 text-base-content/30 hover:text-base-content/70" />
									</button>
								</div>
							)}
						</div>
					</td>
				);
			})}
		</>
	);
}

/** The creator's face: the full table, answering row by row, or all at once by its headings. */
export default function RatingMatrix({
	grid,
	rows,
	onChange,
}: {
	grid: RatingGrid;
	rows: MaturityRows;
	onChange: (next: MaturityRows) => void;
}) {
	const set = (note: ContentNote, level: RowLevel) => onChange({ ...rows, [note]: level });
	const setAll = (level: RowLevel) => {
		const next: MaturityRows = { ...rows };
		for (const row of RATING_ROWS) next[row.note] = closestRungLevel(row, grid, level);
		onChange(next);
	};

	return <RatingTable grid={grid} rows={rows} onPick={set} onSetAll={setAll} />;
}

/** A user's face: the same table with nothing clickable and no heading buttons. */
export function RatingMatrixReadOnly({ grid, rows }: { grid: RatingGrid; rows: MaturityRows }) {
	return <RatingTable grid={grid} rows={rows} />;
}

function RatingTable({
	grid,
	rows,
	onPick,
	onSetAll,
}: {
	grid: RatingGrid;
	rows: MaturityRows;
	/** Present only in the creator's face; its absence is what makes the table read-only. */
	onPick?: (note: ContentNote, level: RowLevel) => void;
	onSetAll?: (level: RowLevel) => void;
}) {
	const answerLabel = GRID_ANSWER_LABELS[grid];
	const editable = onPick !== undefined;
	return (
		<div className="flex flex-col gap-3">
			<RatingsLearnMore />

			{/* Wider than a phone, so it scrolls sideways there rather than squeezing each cell
			    into a column too narrow to read. */}
			<div className="overflow-x-auto">
				<table className="table table-sm table-fixed w-full min-w-[36rem]">
					<thead>
						<tr>
							<th className="w-36" aria-label="Kind of content" />
							{COLUMNS.map((level) => (
								<th key={level} scope="col" className={level === "none" ? "w-24" : ""}>
									{editable ? (
										<button
											type="button"
											className="text-sm hover:underline"
											title={`Marks every row ${answerLabel[level]}, at the nearest rung each row reaches`}
											onClick={() => onSetAll?.(level)}
										>
											{answerLabel[level]}
										</button>
									) : (
										<span className="text-sm">{answerLabel[level]}</span>
									)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{RATING_ROWS.map((row) => {
							const pick = rows[row.note];
							return (
								<tr key={row.note} className="align-top">
									<th
										scope="row"
										className={`text-sm font-medium ${pick === undefined ? "border-l-2 border-warning" : ""}`}
									>
										{row.label}
										{/* The line past the row's last rung is an (i) beside its heading
										    (Parker, 2026-10-19): it explains a boundary rather than a
										    rung, so it belongs in a hover rather than under a row a
										    creator has already read. `unclipped` because the table
										    scrolls sideways inside `overflow-x-auto`, whose clip
										    would otherwise cut the overlay. */}
										{row.after && <InfoTip text={row.after} unclipped />}
									</th>
									<RowCells
										grid={grid}
										row={row}
										pick={pick}
										onPick={onPick ? (level) => onPick(row.note, level) : undefined}
									/>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
