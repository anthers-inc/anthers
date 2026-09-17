// SPDX-License-Identifier: Apache-2.0
/**
 * The comment thread under a post, with the replies under each comment.
 *
 * 🚨 **Only posts have comments.** A Work takes no comments and no votes, because a review is
 * the only feedback a Work accepts (Parker, 2026-09-13).
 *
 * ⭐ **A reply is a comment whose subject is another comment**, and the thread arrives flat and
 * already in reading order, so this groups each reply under the comment it answers and keeps the
 * order it was given. Nothing here ranks anything; `shapeThread` on the server does.
 *
 * ⚠️ **Nesting stops indenting at `MAX_INDENT`, and deeper replies line up at that level**, each
 * naming who it answers. Indenting without limit runs a long exchange off a phone's width, and
 * the reply chain is still honest because every reply still sits under what it answers.
 */
import { useAuth } from "@anthers/web-shared/auth";
import {
	INTERACTION_PERMISSION_HINT,
	useInteractionPermissionMissing,
} from "@anthers/web-shared/publishing";
import { client } from "@anthers/web-shared/rpc";
import type { Comment, ThreadComment } from "@anthers/web-shared/types";
import { FlagIcon } from "@heroicons/react/24/outline";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReportDialog from "../ui/ReportDialog";
import VoteControl from "./VoteControl";

/** How many levels of reply indent before deeper replies line up at the last one. */
export const MAX_INDENT = 3;

interface CommentThreadProps {
	subject: { kind: "post"; slug: string };
}

interface ThreadState {
	isAuthenticated: boolean;
	repliesTo: (id: number) => ThreadComment[];
	byId: Map<number, ThreadComment>;
	replyingTo: number | null;
	setReplyingTo: (id: number | null) => void;
	submitReply: (replyTo: number, body: string) => Promise<boolean>;
	report: (target: { id: number; label: string }) => void;
}

const ThreadContext = createContext<ThreadState | null>(null);

function useThread(): ThreadState {
	const state = useContext(ThreadContext);
	if (!state) throw new Error("A comment row must be inside a CommentThread");
	return state;
}

/**
 * The name a comment is shown under.
 *
 * 🚨 A tombstone — `username` null — is an author who deleted their account, and the comment
 * stayed so the thread still reads. Says only WHO, never WHY: a removal by moderation is a
 * `RemovedComment` and is drawn as one, and conflating them would tell readers a user deleted
 * something they did not.
 */
function authorOf(comment: Comment): string {
	return comment.username ?? "deleted by user";
}

export default function CommentThread({ subject }: CommentThreadProps) {
	const { isAuthenticated } = useAuth();
	const [comments, setComments] = useState<ThreadComment[]>([]);
	const [body, setBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [reporting, setReporting] = useState<{ id: number; label: string } | null>(null);
	const [replyingTo, setReplyingTo] = useState<number | null>(null);

	const key = subject.slug;

	const fetchComments = useCallback(async () => {
		const res = await client.api.content.posts[":slug"].comments.$get({ param: { slug: key } });
		if (!res.ok) return;
		const data = (await res.json()) as unknown as { comments: ThreadComment[] };
		setComments(data.comments ?? []);
	}, [key]);

	useEffect(() => {
		fetchComments().catch(() => {});
	}, [fetchComments]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!body.trim()) return;
		setSubmitting(true);
		try {
			const res = await client.api.content.posts[":slug"].comments.$post({
				param: { slug: key },
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

	const submitReply = useCallback(
		async (replyTo: number, text: string) => {
			const res = await client.api.content.posts[":slug"].comments.$post({
				param: { slug: key },
				json: { body: text, replyTo },
			});
			// A refusal means the comment went while the reply was being written — removed, or
			// out of this reader's view. Reloading shows the thread as it now stands.
			await fetchComments();
			if (res.ok) setReplyingTo(null);
			return res.ok;
		},
		[key, fetchComments],
	);

	const thread = useMemo(() => {
		const byId = new Map(comments.map((c) => [c.id, c]));
		const replies = new Map<number, ThreadComment[]>();
		const top: ThreadComment[] = [];
		for (const c of comments) {
			if (c.subjectType !== "comment") {
				top.push(c);
				continue;
			}
			const list = replies.get(c.subjectId);
			if (list) list.push(c);
			else replies.set(c.subjectId, [c]);
		}
		return { byId, top, repliesTo: (id: number) => replies.get(id) ?? [] };
	}, [comments]);

	// Gaps are not comments, so they are not counted as any.
	const count = comments.filter((c) => !c.removed).length;

	// A comment is a record in the commenter's own repository; the banner explains, and the form
	// says so rather than accepting words the server will refuse.
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;

	const state: ThreadState = {
		isAuthenticated,
		repliesTo: thread.repliesTo,
		byId: thread.byId,
		replyingTo,
		setReplyingTo,
		submitReply,
		report: setReporting,
	};

	return (
		<div className="border-t border-base-300 pt-6">
			<h2 className="text-xl font-bold mb-4">Comments ({count})</h2>

			{isAuthenticated && (
				<form onSubmit={submit} className="mb-6">
					<textarea
						className="textarea textarea-bordered w-full"
						placeholder="Write a comment..."
						rows={3}
						value={body}
						onChange={(e) => setBody(e.target.value)}
						disabled={permissionMissing}
					/>
					{permissionMissing && (
						<p className="text-xs text-warning mt-1">{INTERACTION_PERMISSION_HINT}</p>
					)}
					<button
						type="submit"
						className="btn btn-primary btn-sm mt-2"
						disabled={submitting || !body.trim() || permissionMissing}
					>
						{submitting ? <span className="loading loading-spinner loading-sm" /> : "Post comment"}
					</button>
				</form>
			)}

			{thread.top.length === 0 ? (
				<p className="text-base-content/50 text-sm">
					No comments yet. {isAuthenticated ? "Be the first!" : "Log in to comment."}
				</p>
			) : (
				<ThreadContext.Provider value={state}>
					<div className="flex flex-col gap-4">
						{thread.top.map((comment) => (
							<ThreadBranch key={comment.id} entry={comment} depth={0} />
						))}
					</div>
				</ThreadContext.Provider>
			)}

			{reporting !== null && (
				<ReportDialog
					subjectType="comment"
					subjectId={reporting.id}
					label={reporting.label}
					onClose={() => setReporting(null)}
				/>
			)}
		</div>
	);
}

/** How many replies sit beneath a comment at every depth, counted without recursion. */
function countReplies(id: number, repliesTo: (id: number) => ThreadComment[]): number {
	let n = 0;
	const pending = [...repliesTo(id)];
	while (pending.length > 0) {
		const next = pending.pop() as ThreadComment;
		if (!next.removed) n++;
		pending.push(...repliesTo(next.id));
	}
	return n;
}

/**
 * One comment and everything beneath it.
 *
 * 🚨 **Collapsed is neither removed nor deleted, and it must not be drawn like either.** A
 * removal is a gap with no text, and a tombstone is an author who left. This is a comment
 * readers pushed below the threshold: it is still here, it says why it is folded, and anyone
 * can open it. Drawing it like a removal would have Anthers telling people a moderator acted
 * when the crowd did. Folding it folds its replies with it, the way a closed branch does.
 *
 * ⭐ **Opening it is per-reader and not remembered.** Unfolding is a decision about this
 * comment right now, not a setting — and a "show me collapsed comments" preference is a
 * different feature with a different argument behind it.
 */
function ThreadBranch({ entry, depth }: { entry: ThreadComment; depth: number }) {
	const { repliesTo } = useThread();
	const [folded, setFolded] = useState(!entry.removed && entry.collapsed);
	const replies = repliesTo(entry.id);
	const isReply = depth > 0;

	// Past the last indent a reply lines up with the one it answers, so it has to say who that is.
	const answering = depth > MAX_INDENT ? <ReplyingTo subjectId={entry.subjectId} /> : null;

	if (folded && !entry.removed) {
		const hidden = countReplies(entry.id, repliesTo);
		return (
			<div className="flex flex-wrap items-center gap-2 text-sm text-base-content/45">
				<button
					type="button"
					className="link link-hover"
					onClick={() => setFolded(false)}
					aria-expanded={false}
				>
					Show {isReply ? "reply" : "comment"}
				</button>
				{/* Says who did it. "Heavily downvoted" is the crowd; a moderator's removal is a
				    different row that says so. */}
				<span className="text-xs">
					collapsed — heavily downvoted ({authorOf(entry)})
					{hidden > 0 && `, with ${hidden} ${hidden === 1 ? "reply" : "replies"}`}
				</span>
			</div>
		);
	}

	return (
		<div>
			{answering}
			{entry.removed ? (
				<RemovedRow isReply={isReply} />
			) : (
				<CommentRow comment={entry} isReply={isReply} />
			)}
			{replies.length > 0 && (
				<div
					className={
						depth < MAX_INDENT
							? "mt-3 ml-4 pl-3 border-l border-base-300 flex flex-col gap-3"
							: "mt-3 flex flex-col gap-3"
					}
				>
					{replies.map((reply) => (
						<ThreadBranch key={reply.id} entry={reply} depth={depth + 1} />
					))}
				</div>
			)}
		</div>
	);
}

/** The line above a reply that has run out of indent, naming the comment it answers. */
function ReplyingTo({ subjectId }: { subjectId: number }) {
	const { byId } = useThread();
	const parent = byId.get(subjectId);
	const name = !parent ? "a comment" : parent.removed ? "a removed comment" : authorOf(parent);
	return <p className="text-xs text-base-content/45 mb-1">Replying to {name}</p>;
}

/**
 * The place a removed comment was, kept because its replies are still shown.
 *
 * 🚨 **It says moderation removed it, and nothing else.** There is no author and no text to
 * show, because the server sends neither, and it must never read like a tombstone: an author
 * who deleted their account did something, and this author did not.
 */
function RemovedRow({ isReply }: { isReply: boolean }) {
	return (
		<p className="text-sm italic text-base-content/45">
			This {isReply ? "reply" : "comment"} was removed by moderation.
		</p>
	);
}

function CommentRow({ comment, isReply }: { comment: Comment; isReply: boolean }) {
	const { isAuthenticated, replyingTo, setReplyingTo, report } = useThread();
	const author = authorOf(comment);
	const noun = isReply ? "reply" : "comment";
	const replying = replyingTo === comment.id;

	return (
		<div className="flex gap-3">
			{comment.avatar ? (
				<img
					src={comment.avatar}
					alt={author}
					className="w-8 h-8 rounded-full object-cover flex-shrink-0"
				/>
			) : (
				<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
					{author.charAt(0).toUpperCase()}
				</div>
			)}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 text-sm">
					<span className="font-medium">{author}</span>
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
							onClick={() => report({ id: comment.id, label: `this ${noun}` })}
							title={`Report this ${noun}`}
							aria-label={`Report ${author}'s ${noun}`}
						>
							<FlagIcon className="w-3.5 h-3.5" />
						</button>
					)}
				</div>
				<p className="text-sm mt-1 break-words">{comment.body}</p>
				<div className="mt-1.5 flex items-center gap-3">
					<VoteControl
						subjectType="comment"
						subjectId={comment.id}
						score={comment.score}
						viewerVote={comment.viewerVote}
						up={comment.up}
						down={comment.down}
						label={`${author}'s ${noun}`}
					/>
					{isAuthenticated && (
						<button
							type="button"
							className="link link-hover text-xs text-base-content/60"
							onClick={() => setReplyingTo(replying ? null : comment.id)}
							aria-expanded={replying}
							aria-label={`Reply to ${author}'s ${noun}`}
						>
							Reply
						</button>
					)}
				</div>
				{replying && <ReplyForm replyTo={comment.id} author={author} />}
			</div>
		</div>
	);
}

function ReplyForm({ replyTo, author }: { replyTo: number; author: string }) {
	const { setReplyingTo, submitReply } = useThread();
	const permissionMissing = useInteractionPermissionMissing(true) === true;
	const [body, setBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [refused, setRefused] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);

	// Opening the form is asking to type, so the cursor goes where the words go.
	useEffect(() => {
		field.current?.focus();
	}, []);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!body.trim()) return;
		setSubmitting(true);
		setRefused(false);
		try {
			if (!(await submitReply(replyTo, body.trim()))) setRefused(true);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form onSubmit={submit} className="mt-2">
			<textarea
				ref={field}
				className="textarea textarea-bordered textarea-sm w-full"
				placeholder={`Reply to ${author}...`}
				aria-label={`Reply to ${author}`}
				rows={2}
				value={body}
				onChange={(e) => setBody(e.target.value)}
			/>
			{refused && (
				<p className="text-xs text-error mt-1" role="alert">
					This comment can no longer be replied to.
				</p>
			)}
			{permissionMissing && (
				<p className="text-xs text-warning mt-1">{INTERACTION_PERMISSION_HINT}</p>
			)}
			<div className="flex gap-2 mt-2">
				<button
					type="submit"
					className="btn btn-primary btn-xs"
					disabled={submitting || !body.trim() || permissionMissing}
				>
					{submitting ? <span className="loading loading-spinner loading-xs" /> : "Post reply"}
				</button>
				<button type="button" className="btn btn-ghost btn-xs" onClick={() => setReplyingTo(null)}>
					Cancel
				</button>
			</div>
		</form>
	);
}
