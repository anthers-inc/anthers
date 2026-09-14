// SPDX-License-Identifier: Apache-2.0
/**
 * How a thread is put in front of a reader: replies under what they answer, removed comments
 * kept only as the place replies hang from, and a blocked author's replies gone with them.
 *
 * 🚨 **The absence of a parent column is a claim, and a claim about an absence needs a test.** A
 * reply's subject already says what it answers, so a `parent_id` beside it would be the same
 * fact stored twice — and it is exactly the column somebody adds "to make the query easier".
 */
import { describe, expect, it } from "bun:test";
import { comments } from "@anthers/db/schema";
import { getTableColumns } from "drizzle-orm";
import { shapeThread, type ThreadNode } from "../services/comment-thread.js";

const ROOT = { subjectType: "post", subjectId: 1 };

let clock = 0;
/** A comment on the post, or a reply when `on` names the comment it answers. */
function node(id: number, on: number | null, overrides: Partial<ThreadNode> = {}): ThreadNode {
	clock += 1;
	return {
		id,
		subjectType: on === null ? "post" : "comment",
		subjectId: on === null ? 1 : on,
		createdAt: new Date(Date.UTC(2031, 0, 1, 0, clock)),
		score: 0,
		visible: true,
		blocked: false,
		...overrides,
	};
}

const shape = (nodes: ThreadNode[]) =>
	shapeThread(ROOT, nodes).map((e) => (e.kind === "removed" ? `removed:${e.node.id}` : e.node.id));

describe("the comments table", () => {
	it("🚨 has no parent column — a reply's subject is the only record of what it answers", () => {
		const columns = Object.values(getTableColumns(comments)).map((c) => c.name);
		expect(columns).toContain("subject_type");
		expect(columns).toContain("subject_id");
		expect(columns.filter((name) => /parent|reply|thread|root/i.test(name))).toEqual([]);
	});
});

describe("shapeThread", () => {
	it("puts every reply straight after what it answers, depth first", () => {
		const nodes = [node(1, null), node(2, null), node(3, 1), node(4, 3), node(5, 1)];
		// 2 is the newer top-level comment, so it leads; 1's replies follow 1, and 4 follows 3.
		expect(shape(nodes)).toEqual([2, 1, 3, 4, 5]);
	});

	it("⭐ ranks by the score on screen first, at every level", () => {
		const nodes = [
			node(1, null, { score: 0 }),
			node(2, null, { score: 5 }),
			node(3, 2, { score: 0 }),
			node(4, 2, { score: 2 }),
		];
		expect(shape(nodes)).toEqual([2, 4, 3, 1]);
	});

	it("⭐ breaks a tie newest first on the post, and oldest first among replies", () => {
		const nodes = [node(1, null), node(10, 1), node(11, 1), node(2, null), node(12, 1)];
		// A conversation reads in the order it happened; the post's comments lead with the fresh.
		expect(shape(nodes)).toEqual([2, 1, 10, 11, 12]);
	});

	it("🚨 keeps a removed comment as a gap when something beneath it is still shown", () => {
		const nodes = [node(1, null, { visible: false }), node(2, 1), node(3, 2)];
		expect(shape(nodes)).toEqual(["removed:1", 2, 3]);
	});

	it("🚨 leaves a removed comment out entirely when nothing beneath it is shown", () => {
		const nodes = [
			node(1, null),
			node(2, 1, { visible: false }),
			node(3, null, { visible: false }),
			node(4, 3, { visible: false }),
		];
		// 3's only reply is removed too, so neither is a gap anything hangs from.
		expect(shape(nodes)).toEqual([1]);
	});

	it("keeps a chain of removed comments as gaps down to the reply that is still shown", () => {
		const nodes = [node(1, null, { visible: false }), node(2, 1, { visible: false }), node(3, 2)];
		expect(shape(nodes)).toEqual(["removed:1", "removed:2", 3]);
	});

	it("🚨 takes a blocked author's replies with them, and leaves no gap that states the block", () => {
		const nodes = [node(1, null), node(2, 1, { blocked: true }), node(3, 2), node(4, 1)];
		expect(shape(nodes)).toEqual([1, 4]);
	});

	it("does not let a reply under a blocked author hold a removed comment above it open", () => {
		const nodes = [node(1, null, { visible: false }), node(2, 1, { blocked: true }), node(3, 2)];
		expect(shape(nodes)).toEqual([]);
	});

	it("ignores a reply whose comment is not in the thread", () => {
		expect(shape([node(1, null), node(2, 99)])).toEqual([1]);
	});

	it("⚠️ walks a chain thousands deep without using the call stack", () => {
		const nodes = [node(1, null)];
		for (let id = 2; id <= 20_000; id++) nodes.push(node(id, id - 1));
		const shaped = shape(nodes);
		expect(shaped).toHaveLength(20_000);
		expect(shaped.at(-1)).toBe(20_000);
	});
});
