import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ClipboardDocumentIcon, CheckIcon } from "@heroicons/react/24/outline";

/**
 * Code block component with syntax highlighting and copy functionality.
 * Handles both inline code (inside paragraphs) and block code (standalone).
 */
interface CodeBlockProps {
    children: string;
    className?: string;
    inline?: boolean;
}

export default function CodeBlock({ children, className, inline }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);

    // Extract language from className (format: language-xxx)
    const match = /language-(\w+)/.exec(className || "");
    const language = match ? match[1] : "";

    // Determine if this is truly inline code:
    // - explicitly marked as inline
    // - OR no language specified AND no newlines in content
    const isInline = inline === true || (!language && !children.includes("\n"));

    const handleCopy = async () => {
        await navigator.clipboard.writeText(children);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Inline code - must return span-level element to avoid div-in-p hydration error
    if (isInline) {
        return <code className={className}>{children}</code>;
    }

    // Block code with syntax highlighting
    return (
        <div className="relative group not-prose my-4">
            <button
                onClick={handleCopy}
                className="absolute right-2 top-2 p-2 rounded bg-base-100/80 hover:bg-base-100 border border-base-300 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                title="Copy code"
            >
                {copied ? (
                    <CheckIcon className="h-4 w-4 text-success" />
                ) : (
                    <ClipboardDocumentIcon className="h-4 w-4 text-base-content" />
                )}
            </button>
            <SyntaxHighlighter
                style={oneDark}
                language={language || "text"}
                PreTag="div"
                customStyle={{
                    margin: 0,
                    borderRadius: "0.5rem",
                    border: "1px solid rgba(255, 255, 255, 0.1)",
                }}
            >
                {children}
            </SyntaxHighlighter>
        </div>
    );
}
