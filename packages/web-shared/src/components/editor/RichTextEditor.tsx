// SPDX-License-Identifier: Apache-2.0
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { FONTS } from "../../styles/fonts";
import EditorToolbar from "./EditorToolbar";

interface RichTextEditorProps {
	content: string;
	onChange: (html: string) => void;
	placeholder?: string;
	/**
	 * `article` sets the text as a piece of writing reads, in a text serif at a reading size, so
	 * a text Work is written in the typography it is read in. The default is the compact form a
	 * post is written in.
	 */
	variant?: "compact" | "article";
}

/** What both forms share: the cursor across the whole area, and the empty-state placeholder. */
const EDITABLE =
	"focus-within:outline-none [&_.tiptap]:cursor-text [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-base-content/30 [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none";

/** Matches a single, whitespace-free http(s) URL (a "lone URL" paste). */
const LONE_URL = /^https?:\/\/\S+$/;

export default function RichTextEditor({
	content,
	onChange,
	placeholder = "Write your content...",
	variant = "compact",
}: RichTextEditorProps) {
	const editor = useEditor({
		extensions: [
			StarterKit,
			Image.configure({ inline: false }),
			Link.configure({
				openOnClick: false,
				// Linkify URLs as they're typed and when pasting over a text selection.
				autolink: true,
				linkOnPaste: true,
				HTMLAttributes: { class: "link link-primary" },
			}),
			Placeholder.configure({ placeholder }),
		],
		content,
		editorProps: {
			// Pasting a lone URL onto an empty selection inserts it as a link
			// (linkOnPaste already covers the "URL pasted over a selection" case).
			handlePaste: (view, event) => {
				const text = event.clipboardData?.getData("text/plain")?.trim();
				if (!text || !LONE_URL.test(text)) return false;
				const { state } = view;
				if (!state.selection.empty) return false;
				const linkMark = state.schema.marks.link;
				if (!linkMark) return false;
				const node = state.schema.text(text, [linkMark.create({ href: text })]);
				view.dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView());
				return true;
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});

	if (!editor) return null;

	if (variant === "article") {
		// No box around the page: the text sits where the reader's will, with the toolbar above
		// it and a frame only while the creator is pointing at it or typing.
		return (
			<div className="rounded-lg border border-transparent hover:border-base-300 focus-within:border-base-300">
				<div className="sticky top-0 z-10 rounded-t-lg bg-base-100/95 backdrop-blur">
					<EditorToolbar editor={editor} />
				</div>
				<EditorContent
					editor={editor}
					style={{ fontFamily: FONTS.spectral }}
					className={`prose prose-lg max-w-none leading-relaxed prose-headings:font-semibold [&_.tiptap]:min-h-[320px] [&_.tiptap]:px-2 [&_.tiptap]:py-4 ${EDITABLE}`}
				/>
			</div>
		);
	}

	return (
		<div className="border border-base-300 rounded-lg overflow-hidden bg-base-100">
			<EditorToolbar editor={editor} />
			{/* Padding + min-height live on the editable (.tiptap) itself — not the
			    wrapper — so clicking anywhere in the area places the cursor, and
			    cursor:text covers the whole box. */}
			<EditorContent
				editor={editor}
				className={`prose prose-sm max-w-none [&_.tiptap]:min-h-[200px] [&_.tiptap]:p-4 ${EDITABLE}`}
			/>
		</div>
	);
}
