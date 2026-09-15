// SPDX-License-Identifier: Apache-2.0
/**
 * Replies — finding a thread, finding what a reply is ultimately about, and putting a thread
 * in the order a reader sees it.
 *
 * ⭐ **A reply is a comment whose subject is another comment.** It is stored as
 * `subject_type = 'comment'` with the replied-to comment's id as `subject_id`, which is the same
 * fact `org.anthers.comment` publishes: its `subject` names the comment it answers. 🚨 **There
 * is no parent column and there must never be one** — the subject already says what a reply
 * answers, and a `parent_id` beside it would store that fact twice, where the two copies can
 * disagree. `comment-thread.test.ts` fails on a column that looks like one.
 *
 * ⚠️ **The price is that nothing in a reply's own row says which post it is under.** Anything
 * that needs the post — who a Sticker pays, which page the moderation queue links to, which
 * replies go when a post is deleted — has to walk the subjects up or down, and this module is
 * where that walk lives so there is one copy of it. Asking a reply's `subject_id` for a post
 * directly finds an unrelated post that happens to share the parent comment's id.
 */
import { db } from "@anthers/db/client";
import { type SQL, sql } from "drizzle-orm";

/** The `subject_type` a reply carries: the thing it is about is a comment. */
export const REPLY_SUBJECT_TYPE = "comment";

/** What a comment or a thread ultimately hangs off — a post, or a Work for older rows. */
export interface ThreadRoot {
	subjectType: string;
	subjectId: number;
}

function rowsOf<T>(result: unknown): T[] {
	return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

function idList(ids: number[]): SQL {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

/**
 * Every comment in a thread — the comments on a subject and every reply beneath them, at any
 * depth, in every moderation state.
 *
 * ⚠️ **Hidden rows are included on purpose.** A reply under a removed comment is still a reply
 * somebody wrote, and a walk that stopped at the removed one would lose everything beneath it.
 * Deciding what a reader may see is `shapeThread`'s job, not this query's.
 *
 * `UNION` rather than `UNION ALL`, so a cycle — which no route can write, since a reply's
 * subject has to exist first — ends the walk rather than running it forever.
 */
export async function threadCommentIds(root: ThreadRoot): Promise<number[]> {
	const result = await db.execute(sql`
		WITH RECURSIVE thread(id) AS (
			SELECT c.id FROM comments c
			WHERE c.subject_type = ${root.subjectType} AND c.subject_id = ${root.subjectId}
			UNION
			SELECT c.id FROM comments c
			JOIN thread t ON c.subject_type = ${REPLY_SUBJECT_TYPE} AND c.subject_id = t.id
		)
		SELECT id FROM thread
	`);
	return rowsOf<{ id: number }>(result).map((r) => Number(r.id));
}

/** One step on the way from a comment up to what its thread hangs off. */
export interface AncestorComment {
	id: number;
	userId: number | null;
	subjectType: string;
	subjectId: number;
	moderationStatus: string;
}

/**
 * A comment and every comment above it, nearest first, ending at the top-level comment.
 *
 * The last entry's subject is the thread's root. An empty array means the comment does not
 * exist; a chain that stops short of a top-level comment means a comment above it was deleted
 * outright, and `rootOfAncestry` answers null for it.
 */
export async function commentAncestry(commentId: number): Promise<AncestorComment[]> {
	const result = await db.execute(sql`
		WITH RECURSIVE up(id, user_id, subject_type, subject_id, moderation_status, depth) AS (
			SELECT c.id, c.user_id, c.subject_type, c.subject_id, c.moderation_status, 0
			FROM comments c WHERE c.id = ${commentId}
			UNION
			SELECT c.id, c.user_id, c.subject_type, c.subject_id, c.moderation_status, up.depth + 1
			FROM comments c
			JOIN up ON up.subject_type = ${REPLY_SUBJECT_TYPE} AND c.id = up.subject_id
			WHERE up.depth < ${ANCESTRY_LIMIT}
		)
		SELECT id, user_id, subject_type, subject_id, moderation_status FROM up ORDER BY depth
	`);
	return rowsOf<{
		id: number;
		user_id: number | null;
		subject_type: string;
		subject_id: number;
		moderation_status: string;
	}>(result).map((r) => ({
		id: Number(r.id),
		userId: r.user_id === null ? null : Number(r.user_id),
		subjectType: r.subject_type,
		subjectId: Number(r.subject_id),
		moderationStatus: r.moderation_status,
	}));
}

/**
 * How far up a walk goes before it stops. The upward walk carries a depth, so `UNION` alone
 * would not end a cycle; no real thread comes near this.
 */
const ANCESTRY_LIMIT = 10_000;

/** What an ancestry ultimately hangs off, or null when the chain is broken. */
export function rootOfAncestry(ancestry: AncestorComment[]): ThreadRoot | null {
	const top = ancestry.at(-1);
	if (!top || top.subjectType === REPLY_SUBJECT_TYPE) return null;
	return { subjectType: top.subjectType, subjectId: top.subjectId };
}

/**
 * What each of several comments ultimately hangs off, in one query.
 *
 * For the surfaces that hold many comments at once — the moderation queue — where asking one
 * at a time would be a query per row. A comment missing from the map does not exist or sits
 * under a comment that was deleted outright.
 */
export async function commentRoots(commentIds: number[]): Promise<Map<number, ThreadRoot>> {
	const out = new Map<number, ThreadRoot>();
	if (commentIds.length === 0) return out;
	const result = await db.execute(sql`
		WITH RECURSIVE up(origin, subject_type, subject_id) AS (
			SELECT c.id, c.subject_type, c.subject_id FROM comments c WHERE c.id IN (${idList(commentIds)})
			UNION
			SELECT up.origin, c.subject_type, c.subject_id
			FROM comments c
			JOIN up ON up.subject_type = ${REPLY_SUBJECT_TYPE} AND c.id = up.subject_id
		)
		SELECT origin, subject_type, subject_id FROM up WHERE subject_type <> ${REPLY_SUBJECT_TYPE}
	`);
	for (const r of rowsOf<{ origin: number; subject_type: string; subject_id: number }>(result)) {
		out.set(Number(r.origin), { subjectType: r.subject_type, subjectId: Number(r.subject_id) });
	}
	return out;
}

/** What `shapeThread` needs to know about one comment. */
export interface ThreadNode {
	id: number;
	subjectType: string;
	subjectId: number;
	createdAt: Date;
	/** The published score, the same number the reader sees. */
	score: number;
	/** Not removed by moderation. */
	visible: boolean;
	/** Written by somebody this viewer and the author cannot meet, in either direction. */
	blocked: boolean;
}

/**
 * One entry in a thread as a reader receives it: a comment, or the place a removed one was.
 */
export type ThreadEntry<T extends ThreadNode> =
	| { kind: "comment"; node: T }
	| { kind: "removed"; node: T };

/**
 * A thread in the order a reader sees it: every comment followed by its replies, depth first.
 *
 * 🚨 **A removed comment is kept only as the place its replies hang from.** It becomes a
 * `removed` entry when something beneath it is still shown, so the replies group under the gap
 * and the gap can say why it is there; with nothing beneath it, it is left out exactly as it
 * always was. The caller builds a `removed` entry from nothing but its id, subject and time,
 * because this function only says where it goes.
 *
 * 🚨 **A blocked author's comment takes its replies with it.** A blocked pair does not meet in
 * a thread, and the replies to somebody's comment are a conversation with them. Leaving a gap
 * instead would be a placeholder that states the block, which nothing on Anthers does.
 *
 * ⭐ **Ordered by the number on screen, then by time**, which is the rule the flat thread
 * followed: nothing ranks a comment that the reader cannot see. The tiebreak runs in opposite
 * directions at the two levels. The comments on a post put the newest first, while the replies
 * to a comment put the oldest first, because a reply is read after what it answers and a
 * conversation printed newest-first reads backwards.
 *
 * Walked with explicit stacks rather than recursion, so a chain of replies thousands deep costs
 * memory rather than the call stack.
 */
export function shapeThread<T extends ThreadNode>(root: ThreadRoot, nodes: T[]): ThreadEntry<T>[] {
	const key = (type: string, id: number) => `${type}:${id}`;
	const rootKey = key(root.subjectType, root.subjectId);

	const children = new Map<string, T[]>();
	for (const node of nodes) {
		const k = key(node.subjectType, node.subjectId);
		const list = children.get(k);
		if (list) list.push(node);
		else children.set(k, [node]);
	}
	for (const [k, list] of children) {
		const newestFirst = k === rootKey;
		list.sort(
			(a, b) =>
				b.score - a.score ||
				(newestFirst
					? b.createdAt.getTime() - a.createdAt.getTime()
					: a.createdAt.getTime() - b.createdAt.getTime()),
		);
	}
	const childrenOf = (node: T | null) =>
		(children.get(node === null ? rootKey : key(REPLY_SUBJECT_TYPE, node.id)) ?? []).filter(
			(child) => !child.blocked,
		);

	// Every comment a reader could reach, parents before children, so walking it backwards
	// settles each comment's replies before the comment itself.
	const reachable: T[] = [];
	const pending = [...childrenOf(null)];
	const seen = new Set<number>();
	while (pending.length > 0) {
		const node = pending.pop() as T;
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		reachable.push(node);
		pending.push(...childrenOf(node));
	}
	const shown = new Set<number>();
	for (let i = reachable.length - 1; i >= 0; i--) {
		const node = reachable[i];
		if (node.visible || childrenOf(node).some((child) => shown.has(child.id))) shown.add(node.id);
	}

	const out: ThreadEntry<T>[] = [];
	const emitted = new Set<number>();
	const stack = [...childrenOf(null)].reverse();
	while (stack.length > 0) {
		const node = stack.pop() as T;
		if (!shown.has(node.id) || emitted.has(node.id)) continue;
		emitted.add(node.id);
		out.push({ kind: node.visible ? "comment" : "removed", node });
		stack.push(...childrenOf(node).reverse());
	}
	return out;
}
