// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MDX Renderer Component
 *
 * Compiles and renders MDX content at runtime with custom components.
 * Supports:
 * - Standard markdown
 * - GitHub-flavored markdown (tables, strikethrough, task lists)
 * - Math equations (LaTeX via rehype-katex: $...$ for inline, $$...$$ for display)
 * - Syntax-highlighted code blocks
 */

import { compile, run } from "@mdx-js/mdx";
import { useCallback, useEffect, useRef, useState } from "react";
import * as runtime from "react/jsx-runtime";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import CodeBlock from "./CodeBlock";

/**
 * Props for the MDXRenderer component.
 */
interface MDXRendererProps {
	/** Raw MDX/Markdown content to render */
	content: string;
	/** Custom components to make available in MDX */
	components?: Record<string, React.ComponentType<unknown>>;
	/** Callback for internal navigation (e.g., wiki links) */
	onNavigate?: (section: string, file: string) => void;
	/** CSS class for the article wrapper */
	className?: string;
}

/**
 * Default components provided to all MDX content.
 * These override standard HTML elements with enhanced versions.
 */
const createDefaultComponents = (onNavigate?: (section: string, file: string) => void) => ({
	// Enhanced code block with syntax highlighting
	code: ({
		inline,
		className,
		children,
	}: {
		inline?: boolean;
		className?: string;
		children: React.ReactNode;
	}) => {
		const codeString = String(children).replace(/\n$/, "");

		// Render code with syntax highlighting
		return (
			<CodeBlock inline={inline} className={className}>
				{codeString}
			</CodeBlock>
		);
	},

	// Custom link handler for internal wiki links
	a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
		const hrefStr = href || "";
		// Check if it's an internal wiki link
		if (hrefStr.startsWith("./") || hrefStr.startsWith("../")) {
			const cleanHref = hrefStr.replace(/^\.\.?\//, "");
			const parts = cleanHref.split("/");
			if (parts.length >= 2 && onNavigate) {
				const targetSection = parts[parts.length - 2];
				const targetFile = parts[parts.length - 1];
				return (
					<button
						type="button"
						onClick={() => onNavigate(targetSection, targetFile)}
						className="link link-primary"
					>
						{children}
					</button>
				);
			}
		}
		// External link
		return (
			<a href={href} {...props} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	},

	// H2 with ID for table of contents and soft divider
	h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
		const id = String(children)
			.toLowerCase()
			.replace(/[^\w\s-]/g, "")
			.replace(/\s+/g, "-");
		return (
			<>
				<h2 id={id} {...props}>
					{children}
				</h2>
				<hr className="border-base-content/10 mt-2 mb-6" />
			</>
		);
	},

	// H3 with ID for table of contents
	h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
		const id = String(children)
			.toLowerCase()
			.replace(/[^\w\s-]/g, "")
			.replace(/\s+/g, "-");
		return (
			<h3 id={id} {...props}>
				{children}
			</h3>
		);
	},
});

/**
 * MDXRenderer - Compiles and renders MDX content at runtime.
 *
 * This component takes raw MDX/Markdown content and renders it with:
 * - Full MDX support (embedded JSX components)
 * - GitHub-flavored markdown (tables, strikethrough, etc.)
 * - Math equations via KaTeX
 * - Syntax-highlighted code blocks
 * - Custom component overrides
 */
export default function MDXRenderer({
	content,
	components: customComponents = {},
	onNavigate,
	className = "",
}: MDXRendererProps) {
	const [compiledContent, setCompiledContent] = useState<React.ReactNode>(null);
	const [error, setError] = useState<string | null>(null);
	const [isCompiling, setIsCompiling] = useState(true);

	// Use refs to store stable callback references
	const onNavigateRef = useRef(onNavigate);
	const customComponentsRef = useRef(customComponents);

	// Update refs when props change (but don't trigger re-render)
	useEffect(() => {
		onNavigateRef.current = onNavigate;
	}, [onNavigate]);

	useEffect(() => {
		customComponentsRef.current = customComponents;
	}, [customComponents]);

	// Stable function to get current components - doesn't change between renders
	const getComponents = useCallback(
		() => ({
			...createDefaultComponents(onNavigateRef.current),
			...customComponentsRef.current,
		}),
		[],
	);

	useEffect(() => {
		let isMounted = true;

		const compileMDX = async () => {
			setIsCompiling(true);
			setError(null);

			try {
				// Compile MDX to JavaScript
				// rehype-katex must come after rehype-raw to properly process math nodes
				const compiled = await compile(content, {
					outputFormat: "function-body",
					remarkPlugins: [remarkGfm, remarkMath],
					rehypePlugins: [rehypeRaw, rehypeKatex],
					development: false,
				});

				// Run the compiled code to get the React component
				const { default: MDXContent } = await run(String(compiled), {
					...runtime,
					baseUrl: import.meta.url,
				});

				if (isMounted) {
					const components = getComponents();
					setCompiledContent(<MDXContent components={components} />);
					setIsCompiling(false);
				}
			} catch (err) {
				console.error("MDX compilation error:", err);
				if (isMounted) {
					setError(err instanceof Error ? err.message : "Failed to compile MDX content");
					setIsCompiling(false);
				}
			}
		};

		compileMDX();

		return () => {
			isMounted = false;
		};
	}, [content, getComponents]);

	if (isCompiling) {
		return (
			<div className="flex items-center justify-center py-12">
				<span className="loading loading-spinner loading-lg"></span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="alert alert-error">
				<span>Error rendering content: {error}</span>
			</div>
		);
	}

	return <article className={className}>{compiledContent}</article>;
}
