// SPDX-License-Identifier: Apache-2.0
import {
	BoldIcon,
	CodeBracketIcon,
	ItalicIcon,
	LinkIcon,
	ListBulletIcon,
	PhotoIcon,
} from "@heroicons/react/24/outline";
import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { uploadInlineImage } from "./editorImages";

interface EditorToolbarProps {
	editor: Editor;
}

function ToolbarButton({
	onClick,
	isActive,
	disabled,
	children,
	title,
}: {
	onClick: () => void;
	isActive?: boolean;
	disabled?: boolean;
	children: React.ReactNode;
	title: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`btn btn-ghost btn-xs ${isActive ? "btn-active" : ""} ${disabled ? "btn-disabled" : ""}`}
			title={title}
		>
			{children}
		</button>
	);
}

export default function EditorToolbar({ editor }: EditorToolbarProps) {
	// The insert-image flow's live state, shown in place — a multi-second upload with
	// no "nothing happened" explanation is the failure mode an earlier shape of this
	// button shipped (it logged to the console only), and it is Parker's own report.
	const [uploading, setUploading] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);

	const handleImageUpload = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			setUploading(true);
			setImageError(null);
			try {
				const url = await uploadInlineImage(file);
				// The description is asked at insertion, the moment the image is in hand — the
				// same blocking prompt the link flow above uses. A cancel inserts the image
				// undescribed rather than throwing away the upload that just finished, and the
				// selected-image field under this toolbar is where a description is added or
				// fixed afterwards.
				const description = window.prompt("Describe this image for screen readers (alt text)");
				const alt = description?.trim();
				editor
					.chain()
					.focus()
					.setImage({ src: url, ...(alt ? { alt } : {}) })
					.run();
			} catch (err) {
				setImageError(err instanceof Error ? err.message : "The image didn't upload.");
			} finally {
				setUploading(false);
			}
		};
		input.click();
	};

	const handleLink = () => {
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("URL", previousUrl || "https://");
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
		} else {
			editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
		}
	};

	return (
		<div className="flex flex-wrap gap-1 border-b border-base-300 p-2 bg-base-100 rounded-t-lg">
			<ToolbarButton
				onClick={() => editor.chain().focus().toggleBold().run()}
				isActive={editor.isActive("bold")}
				title="Bold"
			>
				<BoldIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleItalic().run()}
				isActive={editor.isActive("italic")}
				title="Italic"
			>
				<ItalicIcon className="w-4 h-4" />
			</ToolbarButton>

			<div className="divider divider-horizontal mx-0 w-px" />

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
				isActive={editor.isActive("heading", { level: 2 })}
				title="Heading 2"
			>
				<span className="text-xs font-bold">H2</span>
			</ToolbarButton>

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
				isActive={editor.isActive("heading", { level: 3 })}
				title="Heading 3"
			>
				<span className="text-xs font-bold">H3</span>
			</ToolbarButton>

			<div className="divider divider-horizontal mx-0 w-px" />

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleBulletList().run()}
				isActive={editor.isActive("bulletList")}
				title="Bullet List"
			>
				<ListBulletIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleOrderedList().run()}
				isActive={editor.isActive("orderedList")}
				title="Numbered List"
			>
				<span className="text-xs font-mono">1.</span>
			</ToolbarButton>

			<div className="divider divider-horizontal mx-0 w-px" />

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleCodeBlock().run()}
				isActive={editor.isActive("codeBlock")}
				title="Code Block"
			>
				<CodeBracketIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton onClick={handleLink} isActive={editor.isActive("link")} title="Link">
				<LinkIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton onClick={handleImageUpload} title="Insert Image" disabled={uploading}>
				<PhotoIcon className="w-4 h-4" />
			</ToolbarButton>

			{(uploading || imageError) && (
				<span
					className={`w-full text-xs ${imageError ? "text-error" : "text-base-content/60"}`}
					role={imageError ? "alert" : undefined}
				>
					{imageError ?? "Uploading the image…"}
				</span>
			)}

			{/* The selected image's description. Clicking an image in the editor selects it, and
			    this is where its alt text is set or fixed — the flow above covers the moment of
			    insertion, but a stored body comes back from the markdown it is stored as with
			    the image's alt already on it, and editing a post would otherwise make every
			    description write-once. */}
			{editor.isActive("image") &&
				(() => {
					const attr = editor.getAttributes("image").alt;
					return (
						<input
							type="text"
							className="w-full input input-bordered input-xs"
							aria-label="Image description (alt text)"
							placeholder="Describe this image for screen readers (alt text)"
							value={typeof attr === "string" ? attr : ""}
							onChange={(e) =>
								editor.chain().updateAttributes("image", { alt: e.target.value }).run()
							}
						/>
					);
				})()}
		</div>
	);
}
