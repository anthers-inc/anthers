// SPDX-License-Identifier: Apache-2.0
/**
 * The remark half of the spoiler convention: `||…||` in a post's stored markdown becomes a
 * `<span class="spoiler">` the post renderer swaps for the reveal component.
 *
 * ⭐ **Pairing happens across inline nodes, not inside each text run.** A post's spoiler can
 * contain bold, emphasis or a link (`||the **ending**||`), so the delimiters are text nodes
 * on either side of a `strong` node. The walk splits each inline container's children as one
 * sequence, which is also why a spoiler inside bold (`**||ending||**`) is found by the walk
 * into `strong` itself.
 *
 * The rule is `splitSpoilers`' rule, applied to a tree rather than a string: left to right,
 * flat, an unpaired delimiter literal, and `||||` left as typed. Code spans, links'
 * destinations and HTML are consumed by their own markdown tokenizers before this walk, so a
 * `||` inside code stays code.
 */
import { SPOILER_DELIMITER } from "@anthers/shared/spoiler";

/** The part of an mdast node this transform looks at. The types are structural on purpose. */
interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
	data?: Record<string, unknown>;
}

/** Containers whose children are inline content, so a delimiter can pair across them. */
const INLINE_CONTAINERS = new Set([
	"paragraph",
	"heading",
	"tableCell",
	"emphasis",
	"strong",
	"link",
	"linkReference",
	"delete",
]);

/** The node mdast-util-to-hast renders as the span react-markdown hands to the reveal. */
function spoilerNode(children: MdNode[]): MdNode {
	return {
		type: "spoiler",
		children,
		data: { hName: "span", hProperties: { className: ["spoiler"] } },
	};
}

function splitInline(children: MdNode[]): MdNode[] {
	const out: MdNode[] = [];
	let open: MdNode[] | null = null;

	const push = (node: MdNode) => {
		if (open) open.push(node);
		else out.push(node);
	};

	/** Text at the `out` level joins its neighbor, so a literal delimiter reads as one run. */
	const outText = (value: string) => {
		const last = out.at(-1);
		if (last?.type === "text") last.value = `${last.value ?? ""}${value}`;
		else out.push({ type: "text", value });
	};

	for (const child of children) {
		if (
			child.type !== "text" ||
			typeof child.value !== "string" ||
			!child.value.includes(SPOILER_DELIMITER)
		) {
			push(child);
			continue;
		}

		const parts = child.value.split(SPOILER_DELIMITER);
		for (let part = 0; part < parts.length; part++) {
			if (part > 0) {
				if (open === null) {
					open = [];
				} else if (open.length === 0) {
					// `||||` is not a spoiler anyone meant to write; it stays as typed.
					outText(SPOILER_DELIMITER + SPOILER_DELIMITER);
					open = null;
				} else {
					out.push(spoilerNode(open));
					open = null;
				}
			}
			if (parts[part]) push({ type: "text", value: parts[part] });
		}
	}

	if (open !== null) {
		// An unclosed opener is literal, exactly as in a comment's plain text.
		outText(SPOILER_DELIMITER);
		for (const node of open) {
			if (node.type === "text") outText(node.value ?? "");
			else out.push(node);
		}
	}

	return out;
}

function walk(node: MdNode) {
	if (node.type === "spoiler" || !node.children) return;
	if (INLINE_CONTAINERS.has(node.type)) node.children = splitInline(node.children);
	for (const child of node.children) walk(child);
}

/** The remark plugin the post body renders with. */
export function remarkSpoiler() {
	return (tree: MdNode) => {
		walk(tree);
	};
}
