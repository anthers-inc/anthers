// SPDX-License-Identifier: AGPL-3.0-or-later
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import EditorToolbar from "./EditorToolbar";

interface RichTextEditorProps {
	content: string;
	onChange: (html: string) => void;
	placeholder?: string;
}

/** Matches a single, whitespace-free http(s) URL (a "lone URL" paste). */
const LONE_URL = /^https?:\/\/\S+$/;

export default function RichTextEditor({
	content,
	onChange,
	placeholder = "Write your content...",
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

	return (
		<div className="border border-base-300 rounded-lg overflow-hidden">
			<EditorToolbar editor={editor} />
			<EditorContent
				editor={editor}
				className="prose prose-sm max-w-none p-4 min-h-[200px] focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-base-content/30 [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none"
			/>
		</div>
	);
}
