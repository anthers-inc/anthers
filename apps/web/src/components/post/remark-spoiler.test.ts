// SPDX-License-Identifier: Apache-2.0
/**
 * The post-body half of the spoiler convention. The transform is pure mdast, so the tests
 * hand it trees rather than going through a parser: the point is where a delimiter pair lands
 * when it wraps formatting, and that only needs the shape.
 */
import { describe, expect, it } from "bun:test";
import { remarkSpoiler } from "./remark-spoiler";

interface Node {
	type: string;
	value?: string;
	children?: Node[];
	data?: Record<string, unknown>;
}

const spoilerNode = (children: Node[]): Node => ({
	type: "spoiler",
	children,
	data: { hName: "span", hProperties: { className: ["spoiler"] } },
});

function run(children: Node[]): Node[] {
	const tree: Node = { type: "root", children: [{ type: "paragraph", children }] };
	remarkSpoiler()(tree);
	return tree.children?.[0].children ?? [];
}

describe("remarkSpoiler", () => {
	it("turns a plain-text pair into the spoiler node", () => {
		expect(run([{ type: "text", value: "before ||hidden|| after" }])).toEqual([
			{ type: "text", value: "before " },
			spoilerNode([{ type: "text", value: "hidden" }]),
			{ type: "text", value: " after" },
		]);
	});

	it("wraps formatting that sits between the delimiters", () => {
		expect(
			run([
				{ type: "text", value: "a ||" },
				{ type: "strong", children: [{ type: "text", value: "b" }] },
				{ type: "text", value: "|| c" },
			]),
		).toEqual([
			{ type: "text", value: "a " },
			spoilerNode([{ type: "strong", children: [{ type: "text", value: "b" }] }]),
			{ type: "text", value: " c" },
		]);
	});

	it("finds a spoiler inside bold", () => {
		expect(run([{ type: "strong", children: [{ type: "text", value: "||hidden||" }] }])).toEqual([
			{
				type: "strong",
				children: [spoilerNode([{ type: "text", value: "hidden" }])],
			},
		]);
	});

	it("leaves an unpaired delimiter literal", () => {
		expect(run([{ type: "text", value: "a || b" }])).toEqual([{ type: "text", value: "a || b" }]);
	});

	it("leaves empty delimiters as typed", () => {
		expect(run([{ type: "text", value: "||||" }])).toEqual([{ type: "text", value: "||||" }]);
	});

	it("never looks inside a code span", () => {
		const code = { type: "inlineCode", value: "||secret||" };
		expect(run([code])).toEqual([code]);
	});
});
