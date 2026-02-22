import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Post, type Comment, type PaginatedResponse } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMediaPlayer } from "../lib/media-player";
import VideoPlayer from "../components/media/VideoPlayer";
import AudioPlayer from "../components/media/AudioPlayer";
import TranscodingStatus from "../components/media/TranscodingStatus";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import {
  ClockIcon,
  FilmIcon,
  MusicalNoteIcon,
} from "@heroicons/react/24/outline";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = useAuth();
  const mediaPlayer = useMediaPlayer();
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);

    Promise.all([
      api.get<Post>(`/api/v1/content/posts/${id}/`),
      api
        .get<PaginatedResponse<Comment>>(`/api/v1/content/posts/${id}/comments/`)
        .catch(() => ({ results: [] as Comment[] })),
    ])
      .then(([postData, commentData]) => {
        setPost(postData);
        setComments(commentData.results);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  const handleComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentBody.trim() || !id) return;
    setSubmitting(true);
    try {
      const comment = await api.post<Comment>(
        `/api/v1/content/posts/${id}/comments/`,
        { body: commentBody }
      );
      setComments([comment, ...comments]);
      setCommentBody("");
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-2">Not Found</h1>
        <p className="text-base-content/60">This post doesn't exist.</p>
      </div>
    );
  }

  const date = new Date(post.created_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Get latest transcoding job for media posts
  const latestJob = post.transcoding_jobs?.[0];
  const videoSrc = latestJob?.hls_manifest_url || (post.video_file ?? undefined);
  const audioSrc = latestJob?.output_file_url || (post.audio_file ?? undefined);

  const handlePlayInMiniPlayer = () => {
    if (!audioSrc || !post) return;
    mediaPlayer.playTrack({
      src: audioSrc,
      title: post.title || "Untitled",
      creator: post.creator,
      thumbnail: post.thumbnail,
      postId: post.id,
      waveform: latestJob?.waveform_data,
    });
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <article>
        {/* Post header */}
        {post.title && <h1 className="text-3xl font-bold mb-3">{post.title}</h1>}
        <div className="flex items-center gap-3 mb-6 text-sm">
          {post.creator_avatar ? (
            <img
              src={post.creator_avatar}
              alt={post.creator}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-base-300 flex items-center justify-center font-bold">
              {(post.creator_username ?? post.creator).charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <Link
              to={`/${post.creator_username}`}
              className="font-medium link link-hover"
            >
              {post.creator}
            </Link>
            <p className="text-base-content/50 text-xs">{date}</p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {post.content_type === "text" && post.estimated_read_minutes && (
              <span className="flex items-center gap-1 text-xs text-base-content/50">
                <ClockIcon className="w-3 h-3" />
                {post.estimated_read_minutes} min read
              </span>
            )}
            {post.content_type === "video" && post.duration_seconds && (
              <span className="flex items-center gap-1 text-xs text-base-content/50">
                <FilmIcon className="w-3 h-3" />
                {formatDuration(post.duration_seconds)}
              </span>
            )}
            {post.content_type === "audio" && post.duration_seconds && (
              <span className="flex items-center gap-1 text-xs text-base-content/50">
                <MusicalNoteIcon className="w-3 h-3" />
                {formatDuration(post.duration_seconds)}
              </span>
            )}
            {post.is_premium && (
              <span className="badge badge-secondary badge-sm">Premium</span>
            )}
            {post.project_title && (
              <Link
                to={`/explore/${post.project_slug}`}
                className="badge badge-outline"
              >
                {post.project_title}
              </Link>
            )}
          </div>
        </div>

        {/* Video content */}
        {post.content_type === "video" && (
          <div className="mb-6">
            {latestJob && latestJob.status !== "completed" ? (
              <TranscodingStatus
                status={latestJob.status}
                progress={latestJob.progress}
                errorMessage={latestJob.error_message}
              />
            ) : videoSrc ? (
              <VideoPlayer
                src={videoSrc}
                poster={post.thumbnail ?? undefined}
              />
            ) : (
              <div className="aspect-video bg-base-200 rounded-lg flex items-center justify-center text-base-content/30">
                <FilmIcon className="w-16 h-16" />
              </div>
            )}
          </div>
        )}

        {/* Audio content */}
        {post.content_type === "audio" && (
          <div className="mb-6">
            {latestJob && latestJob.status !== "completed" ? (
              <TranscodingStatus
                status={latestJob.status}
                progress={latestJob.progress}
                errorMessage={latestJob.error_message}
              />
            ) : audioSrc ? (
              <AudioPlayer
                src={audioSrc}
                waveform={latestJob?.waveform_data}
                onPlayInMiniPlayer={handlePlayInMiniPlayer}
              />
            ) : (
              <div className="h-24 bg-base-200 rounded-lg flex items-center justify-center text-base-content/30">
                <MusicalNoteIcon className="w-12 h-12" />
              </div>
            )}
          </div>
        )}

        {/* Post body */}
        <div className="prose prose-sm max-w-none mb-8">
          {post.body_html ? (
            <div dangerouslySetInnerHTML={{ __html: post.body_html }} />
          ) : post.body ? (
            <Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
          ) : null}
        </div>
      </article>

      {/* Comments */}
      <div className="border-t border-base-300 pt-6">
        <h2 className="text-xl font-bold mb-4">
          Comments ({comments.length})
        </h2>

        {isAuthenticated && (
          <form onSubmit={handleComment} className="mb-6">
            <textarea
              className="textarea textarea-bordered w-full"
              placeholder="Write a comment..."
              rows={3}
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm mt-2"
              disabled={submitting || !commentBody.trim()}
            >
              {submitting ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                "Post comment"
              )}
            </button>
          </form>
        )}

        {comments.length === 0 ? (
          <p className="text-base-content/50 text-sm">
            No comments yet.{" "}
            {isAuthenticated ? "Be the first!" : "Log in to comment."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {comments.map((comment) => (
              <div key={comment.id} className="flex gap-3">
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
                      {new Date(comment.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm mt-1">{comment.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
