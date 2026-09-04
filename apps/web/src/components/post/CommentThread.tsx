// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A comment thread over any commentable subject.
 *
 * One component for both surfaces, because a Post thread and a Work thread are the same
 * conversation UI asked about different subjects — and because the report affordance and
 * the "hidden comments simply aren't here" behavior are things it would be easy to get
 * subtly wrong in a second copy. The server already shares its read; this shares the view.
 *
 * A Work needed a thread at all because it can be released, consumed and paid for with no
 * post in sight; under the old model there was nowhere to say anything about it.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { Comment } from "@anthers/web-shared/types";
import { FlagIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import ReportDialog from "../ui/ReportDialog";
import ReactionControl from "./ReactionControl";

interface CommentThreadProps {
	subject: { kind: "post"; slug: string } | { kind: "work"; id: number };
	/**
	 * Set false to hide the composer — a Work the viewer can't open takes no comments,
	 * because commenting on something you haven't seen isn't a conversation.
	 */
	canComment?: boolean;
}

export default function CommentThread({ subject, canComment = true }: CommentThreadProps) {
	const { isAuthenticated } = useAuth();
	const [comments, setComments] = useState<Comment[]>([]);
	const [body, setBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [reporting, setReporting] = useState<number | null>(null);

	const key = subject.kind === "post" ? subject.slug : String(subject.id);

	const fetchComments = useCallback(async () => {
		const res =
			subject.kind === "post"
				? await client.api.content.posts[":slug"].comments.$get({ param: { slug: key } })
				: await client.api.content.works[":id"].comments.$get({ param: { id: key } });
		if (!res.ok) return;
		const data = (await res.json()) as unknown as { comments: Comment[] };
		setComments(data.comments ?? []);
	}, [subject.kind, key]);

	useEffect(() => {
		fetchComments().catch(() => {});
	}, [fetchComments]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!body.trim()) return;
		setSubmitting(true);
		try {
			const res =
				subject.kind === "post"
					? await client.api.content.posts[":slug"].comments.$post({
							param: { slug: key },
							json: { body: body.trim() },
						})
					: await client.api.content.works[":id"].comments.$post({
							param: { id: key },
							json: { body: body.trim() },
						});
			if (res.ok) {
				setBody("");
				await fetchComments();
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="border-t border-base-300 pt-6">
			<h2 className="text-xl font-bold mb-4">Comments ({comments.length})</h2>

			{isAuthenticated && canComment && (
				<form onSubmit={submit} className="mb-6">
					<textarea
						className="textarea textarea-bordered w-full"
						placeholder="Write a comment..."
						rows={3}
						value={body}
						onChange={(e) => setBody(e.target.value)}
					/>
					<button
						type="submit"
						className="btn btn-primary btn-sm mt-2"
						disabled={submitting || !body.trim()}
					>
						{submitting ? <span className="loading loading-spinner loading-sm" /> : "Post comment"}
					</button>
				</form>
			)}

			{comments.length === 0 ? (
				<p className="text-base-content/50 text-sm">
					No comments yet. {isAuthenticated ? "Be the first!" : "Log in to comment."}
				</p>
			) : (
				<div className="flex flex-col gap-4">
					{comments.map((comment) => (
						<CommentRow
							key={comment.id}
							comment={comment}
							isAuthenticated={isAuthenticated}
							onReport={() => setReporting(comment.id)}
						/>
					))}
				</div>
			)}

			{reporting !== null && (
				<ReportDialog
					subjectType="comment"
					subjectId={reporting}
					label="this comment"
					onClose={() => setReporting(null)}
				/>
			)}
		</div>
	);
}

/**
 * One comment, which may be folded.
 *
 * 🚨 **Collapsed is neither hidden nor deleted, and it must not be drawn like either.** A
 * moderation removal never reaches the browser at all, and a tombstone is an author who
 * left. This is a comment readers pushed below the threshold: it is still here, it says why
 * it is folded, and anyone can open it. Drawing it like a removal would have Anthers telling
 * people a moderator acted when the crowd did.
 *
 * ⭐ **Opening it is per-reader and not remembered.** Unfolding is a decision about this
 * comment right now, not a setting — and a "show me collapsed comments" preference is a
 * different feature with a different argument behind it.
 */
function CommentRow({
	comment,
	isAuthenticated,
	onReport,
}: {
	comment: Comment;
	isAuthenticated: boolean;
	onReport: () => void;
}) {
	const [collapsed, setCollapsed] = useState(comment.collapsed);

	if (collapsed) {
		return (
			<div className="flex items-center gap-2 text-sm text-base-content/45">
				<button
					type="button"
					className="link link-hover"
					onClick={() => setCollapsed(false)}
					aria-expanded={false}
				>
					Show comment
				</button>
				{/* Says who did it. "Heavily disliked" is the crowd; a moderator would not be
				    mentioned here at all, because a removed comment never arrives. */}
				<span className="text-xs">collapsed — heavily disliked ({comment.username})</span>
			</div>
		);
	}

	return (
		<div className="flex gap-3">
			{comment.avatar ? (
				<img
					src={comment.avatar}
					alt={comment.username}
					className="w-8 h-8 rounded-full object-cover flex-shrink-0"
				/>
			) : (
				<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
					{comment.username.charAt(0).toUpperCase()}
				</div>
			)}
			<div className="flex-1">
				<div className="flex items-center gap-2 text-sm">
					<span className="font-medium">{comment.username}</span>
					<span className="text-base-content/40 text-xs">
						{new Date(comment.createdAt).toLocaleDateString()}
					</span>
					{/* Reporting needs a session — there's nobody to hold accountable for an
					    anonymous report, and the one-per-person rule that keeps the queue
					    honest needs a person to count. */}
					{isAuthenticated && (
						<button
							type="button"
							className="ml-auto text-base-content/30 hover:text-base-content/70"
							onClick={onReport}
							title="Report this comment"
							aria-label={`Report ${comment.username}'s comment`}
						>
							<FlagIcon className="w-3.5 h-3.5" />
						</button>
					)}
				</div>
				<p className="text-sm mt-1">{comment.body}</p>
				<div className="mt-1.5">
					<ReactionControl
						subjectType="comment"
						subjectId={comment.id}
						score={comment.score}
						viewerReaction={comment.viewerReaction}
						label={`${comment.username}'s comment`}
					/>
				</div>
			</div>
		</div>
	);
}
