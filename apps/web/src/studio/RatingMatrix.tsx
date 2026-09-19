// SPDX-License-Identifier: Apache-2.0
/**
 * The rating matrix: each kind of content marked *Not in it* or at a rung, and the Work rated at
 * the highest rung any row reaches (Parker, 2026-09-18). A Work's type decides which of the two
 * grids it shows: the visual grid's General, Mature and Adult, or the light grid's *In It* and
 * *Explicit*, with Adult on sexual content alone (`gridFor`).
 *
 * ⭐ **The cells are the explanation.** Each one carries the Rating Standard's own line for where
 * that rung begins on that row, from `RATING_ROWS`, so the difference between General, Mature
 * and Adult is written in the place a creator chooses it rather than in a page they would have to
 * go and find. A rung a row never reaches is shown and not offered.
 *
 * ⭐ ***Not in it* is an answer, and an unanswered row is not.** Parker kept the column because it
 * helps a reader who does not mind rated work but has one thing they want to avoid: a row
 * marked *Not in it* is a statement their own filter can rely on. So the matrix never fills a row
 * on the creator's behalf, and the Work stays unrated until every row has been answered.
 */

import {
	type ContentNote,
	GRID_ANSWER_LABELS,
	type MaturityRows,
	RATING_ROWS,
	type RatingGrid,
	type RowLevel,
} from "@anthers/shared/content-rating";

const COLUMNS: readonly RowLevel[] = ["none", "general", "mature", "adult"];

/** How the grid asks, before the table: what a row is marked by, with an example of each side of the line. */
const INTRO: Record<RatingGrid, string> = {
	visual:
		"Mark how each kind of content is shown, not what the Work is about: a story about addiction is General, and a scene showing how to synthesize something is Mature. The Work takes the highest rating any row reaches.",
	light:
		"Mark each kind of content by how it's described, not by what the Work is about: a song about addiction is In It, and lyrics that spell out a dose are Explicit. Any row marked Explicit makes the Work Mature, and only explicit sexual content can make it Adult. Rate any pictures inside the Work by the same lines.",
};

/** A chosen cell wears its rung's color, the same one its badge wears everywhere else. */
function chosenClass(level: RowLevel): string {
	if (level === "mature") return "border-warning bg-warning/15";
	if (level === "adult") return "border-error bg-error/10";
	return "border-primary bg-primary/10";
}

export default function RatingMatrix({
	grid,
	rows,
	onChange,
}: {
	grid: RatingGrid;
	rows: MaturityRows;
	onChange: (next: MaturityRows) => void;
}) {
	const answerLabel = GRID_ANSWER_LABELS[grid];
	const set = (note: ContentNote, level: RowLevel) => onChange({ ...rows, [note]: level });
	const unanswered = RATING_ROWS.filter((row) => rows[row.note] === undefined).length;
	const markRestNone = () => {
		const next: MaturityRows = { ...rows };
		for (const row of RATING_ROWS) if (next[row.note] === undefined) next[row.note] = "none";
		onChange(next);
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-base-content/60">
				{INTRO[grid]} A Work's rating can change how it's shown to a reader, or whether it's shown
				at all, depending on their settings and whether they've verified through a payment that
				they're 18 or older.
			</p>

			{/* Wider than a phone, so it scrolls sideways there rather than squeezing each cell's
			    line into a column too narrow to read. */}
			<div className="overflow-x-auto">
				<table className="table table-sm table-fixed w-full min-w-[40rem]">
					<thead>
						<tr>
							<th className="w-36" />
							{COLUMNS.map((level) => (
								<th key={level} className={level === "none" ? "w-24" : ""}>
									{answerLabel[level]}
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
										{row.after && (
											<span className="mt-1 block text-[11px] font-normal text-base-content/50">
												{row.after}
											</span>
										)}
									</th>
									{COLUMNS.map((level) => {
										const line = level === "none" ? null : row.rungs[grid][level];
										if (level !== "none" && line === null) {
											return (
												<td key={level}>
													<div className="rounded-md border border-dashed border-base-300 p-2 text-[11px] text-base-content/30">
														Never on this row
													</div>
												</td>
											);
										}
										const on = pick === level;
										return (
											<td key={level}>
												<label
													className={`flex h-full cursor-pointer gap-2 rounded-md border p-2 text-xs ${
														level === "none" ? "items-center justify-center" : ""
													} ${on ? chosenClass(level) : "border-base-300 hover:border-primary/50"}`}
												>
													<input
														type="radio"
														className="radio radio-xs mt-0.5 shrink-0"
														name={`rating-row-${row.note}`}
														aria-label={`${row.label}: ${answerLabel[level]}`}
														checked={on}
														onChange={() => set(row.note, level)}
													/>
													{line && <span className={on ? "" : "text-base-content/70"}>{line}</span>}
												</label>
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{unanswered > 0 && (
				<div className="flex flex-wrap items-center gap-3">
					<button type="button" className="btn btn-outline btn-sm" onClick={markRestNone}>
						Mark the Rest "Not in It"
					</button>
					<span className="text-xs text-warning">
						{RATING_ROWS.length - unanswered} of {RATING_ROWS.length} rows are answered, and it
						can't be released until every row is.
					</span>
				</div>
			)}
			<p className="text-xs text-base-content/50">
				Queer characters, relationships and identity are never a factor in any row, and neither is a
				difficult subject on its own.
			</p>
		</div>
	);
}
