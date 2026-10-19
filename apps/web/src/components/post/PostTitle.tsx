// SPDX-License-Identifier: Apache-2.0
/**
 * A post's title with its `@` mentions rendered as links to the Works they name.
 *
 * The stored title holds an id in the link destination and a name in its text, and that
 * text may be out of date the moment the Work is retitled. `mentionedWorks` carries the
 * Works resolved for this reader, so the name shown is the current one; a Work that did
 * not resolve keeps the stored text and is not a link, the same decay a body embed has
 * when its Work is gone.
 *
 * Every surface that reads a title can keep using the plain `displayTitle` string — this
 * component is for the places where a mention should be clickable.
 */
import { postTitleSegments, workMentionLabel } from "@anthers/shared/post-title";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import type { PostMentionedWork } from "@anthers/web-shared/types";

export default function PostTitle({
	title,
	displayTitle,
	mentionedWorks,
}: {
	/** The stored title, whose mention links carry the durable Work ids. */
	title: string | null | undefined;
	/** The resolved title, for a caller that has no Works — the plain fallback. */
	displayTitle?: string | null;
	mentionedWorks?: PostMentionedWork[] | null;
}) {
	const segments = postTitleSegments(title);
	const works = new Map((mentionedWorks ?? []).map((work) => [work.publicId, work]));
	if (!segments.some((segment) => segment.kind === "mention")) {
		return <>{displayTitle ?? title}</>;
	}
	let offset = 0;
	return (
		<>
			{segments.map((segment) => {
				const key = `${segment.kind}-${offset}`;
				offset += segment.text.length;
				if (segment.kind === "text") return <span key={key}>{segment.text}</span>;
				const work = works.get(segment.publicId);
				if (!work) return <span key={key}>{segment.text}</span>;
				return (
					<Link
						key={key}
						to={workUrl({ slug: work.slug, publicId: work.publicId })}
						className="link link-hover"
					>
						{workMentionLabel(work.title)}
					</Link>
				);
			})}
		</>
	);
}
