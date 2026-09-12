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

/**
 * The slice of a generated schema that record-planning code actually uses.
 *
 * ⚠️ Narrow on purpose. A planner needs to ask one question — does this record
 * satisfy the Lexicon that will publish it — and typing the parameter as the
 * full generated schema would couple every caller to the codegen's shape.
 */
export interface LexiconValidator {
	safeParse(value: unknown): { success: true } | { success: false; error: unknown };
}

export type { Main as CommentRecordValue } from "./generated/lexicons/org/anthers/comment.defs.js";
export { default as commentRecord } from "./generated/lexicons/org/anthers/comment.js";
export type { Main as FollowRecordValue } from "./generated/lexicons/org/anthers/follow.defs.js";
export { default as followRecord } from "./generated/lexicons/org/anthers/follow.js";
export type { Main as PostRecordValue } from "./generated/lexicons/org/anthers/post.defs.js";
export { default as postRecord } from "./generated/lexicons/org/anthers/post.js";
export type { Main as ProjectRecordValue } from "./generated/lexicons/org/anthers/project.defs.js";
export { default as projectRecord } from "./generated/lexicons/org/anthers/project.js";
export type { Main as ReviewRecordValue } from "./generated/lexicons/org/anthers/review.defs.js";
export { default as reviewRecord } from "./generated/lexicons/org/anthers/review.js";
export type { Main as VoteRecordValue } from "./generated/lexicons/org/anthers/vote.defs.js";
export { default as voteRecord } from "./generated/lexicons/org/anthers/vote.js";
export type { Main as WorkRecordValue } from "./generated/lexicons/org/anthers/work.defs.js";
export { default as workRecord } from "./generated/lexicons/org/anthers/work.js";
