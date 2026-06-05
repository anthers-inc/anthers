import {
	BoldIcon,
	CodeBracketIcon,
	ItalicIcon,
	LinkIcon,
	ListBulletIcon,
	PhotoIcon,
} from "@heroicons/react/24/outline";
import type { Editor } from "@tiptap/react";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

interface EditorToolbarProps {
	editor: Editor;
}

function ToolbarButton({
	onClick,
	isActive,
	children,
	title,
}: {
	onClick: () => void;
	isActive?: boolean;
	children: React.ReactNode;
	title: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`btn btn-ghost btn-xs ${isActive ? "btn-active" : ""}`}
			title={title}
		>
			{children}
		</button>
	);
}

export default function EditorToolbar({ editor }: EditorToolbarProps) {
	const handleImageUpload = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;

			const formData = new FormData();
			formData.append("image", file);

			try {
				const res = await fetch(`${apiBase}/api/content/inline-images`, {
					method: "POST",
					body: formData,
					credentials: "include",
				});
				const data = await res.json();
				editor.chain().focus().setImage({ src: data.inlineImage.image }).run();
			} catch (err) {
				console.error("Image upload failed:", err);
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
				title="Bullet list"
			>
				<ListBulletIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleOrderedList().run()}
				isActive={editor.isActive("orderedList")}
				title="Numbered list"
			>
				<span className="text-xs font-mono">1.</span>
			</ToolbarButton>

			<div className="divider divider-horizontal mx-0 w-px" />

			<ToolbarButton
				onClick={() => editor.chain().focus().toggleCodeBlock().run()}
				isActive={editor.isActive("codeBlock")}
				title="Code block"
			>
				<CodeBracketIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton onClick={handleLink} isActive={editor.isActive("link")} title="Link">
				<LinkIcon className="w-4 h-4" />
			</ToolbarButton>

			<ToolbarButton onClick={handleImageUpload} title="Insert image">
				<PhotoIcon className="w-4 h-4" />
			</ToolbarButton>
		</div>
	);
}
