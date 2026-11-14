// SPDX-License-Identifier: Apache-2.0
/**
 * A post's body, rendered from its stored markdown with the spoiler convention applied.
 *
 * Both places the page draws a body — the creator's inline preview and the reader's copy —
 * go through this one component, so a spoiler cannot render in one and print its words in
 * the other. The prose wrapper and the `post-body` variant belong here for the same reason.
 */
import { Spoiler } from "@anthers/web-shared/post/Spoiler";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSpoiler } from "./remark-spoiler";

type SpanProps = ComponentPropsWithoutRef<"span"> & { children?: ReactNode };

/**
 * The only span remark produces is the spoiler's own, so the map is a check rather than a
 * whitelist: anything else (which markdown has no syntax to produce here) stays a span.
 */
function SpoilerSpan({ className, children, ...rest }: SpanProps) {
	if (className?.split(/\s+/).includes("spoiler")) return <Spoiler>{children}</Spoiler>;
	return (
		<span className={className} {...rest}>
			{children}
		</span>
	);
}

export default function PostBody({ markdown }: { markdown: string }) {
	return (
		<div className="prose prose-sm max-w-none flush post-body">
			<Markdown remarkPlugins={[remarkGfm, remarkSpoiler]} components={{ span: SpoilerSpan }}>
				{markdown}
			</Markdown>
		</div>
	);
}
