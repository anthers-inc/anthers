// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The curated surface over the generated Lexicon schemas.
 *
 * ⚠️ This file is hand-written and lives OUTSIDE `generated/lexicons/`, because the codegen
 * runs with `--clear` and deletes everything in that directory on each build. Import from
 * here rather than reaching into the generated tree, so a rename inside it stays an
 * implementation detail.
 *
 * Each export is both a TypeScript type and a runtime validator — `safeParse`, `parse` and
 * `assert` all come from the schema itself, which is what lets a test check a record
 * against the published Lexicon rather than against a restatement of it.
 */

export type { Main as WorkRecordValue } from "./generated/lexicons/org/anthers/work.defs.js";
export { default as workRecord } from "./generated/lexicons/org/anthers/work.js";
