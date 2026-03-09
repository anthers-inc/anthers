"""
Platform-specific publishing logic for cross-publishing content.

Each publisher function takes a CrossPublishResult and the associated
PlatformConnection, performs the publish, and returns (external_id, external_url)
or raises an exception on failure.
"""

import json
import logging
import os
import tempfile

import requests

logger = logging.getLogger(__name__)


# ─── YouTube ───


def publish_to_youtube(cross_publish, connection):
    """Upload a video post to YouTube via the Data API v3.

    Returns (video_id, video_url).
    """
    from . import youtube_oauth

    post = cross_publish.post
    if not post or not post.video_file:
        raise ValueError("Cross-publish must reference a post with a video file.")

    # Refresh token if needed
    access_token = connection.access_token
    from django.utils import timezone

    if connection.token_expires_at and connection.token_expires_at < timezone.now():
        tokens = youtube_oauth.refresh_access_token(connection.refresh_token)
        if tokens:
            access_token = tokens["access_token"]
            connection.access_token = access_token
            expires_in = tokens.get("expires_in", 3600)
            from datetime import timedelta

            connection.token_expires_at = timezone.now() + timedelta(seconds=expires_in)
            connection.save()
        else:
            raise RuntimeError("Failed to refresh YouTube access token.")

    # Prepare video metadata
    title = post.title or f"Post #{post.pk}"
    description = post.body[:5000] if post.body else ""
    project_title = post.project.title if post.project else None
    if project_title:
        description = f"From {project_title} on Bluebell\n\n{description}"

    metadata = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "categoryId": "20",  # Gaming
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False,
        },
    }

    # Download video file to a temp file for upload
    video_path = None
    try:
        if hasattr(post.video_file, "url"):
            # Download from storage
            resp = requests.get(post.video_file.url, timeout=300, stream=True)
            resp.raise_for_status()
            suffix = os.path.splitext(post.video_file.name)[1] or ".mp4"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
                video_path = f.name
        elif hasattr(post.video_file, "path"):
            video_path = post.video_file.path
        else:
            raise ValueError("Cannot access video file for upload.")

        # Resumable upload to YouTube
        # Step 1: Initiate upload
        init_resp = requests.post(
            "https://www.googleapis.com/upload/youtube/v3/videos"
            "?uploadType=resumable&part=snippet,status",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json=metadata,
            timeout=30,
        )
        if init_resp.status_code not in (200, 201):
            raise RuntimeError(
                f"YouTube upload init failed: {init_resp.status_code} {init_resp.text[:300]}"
            )

        upload_url = init_resp.headers.get("Location")
        if not upload_url:
            raise RuntimeError("No upload URL returned from YouTube.")

        # Step 2: Upload video data
        file_size = os.path.getsize(video_path)
        with open(video_path, "rb") as f:
            upload_resp = requests.put(
                upload_url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "video/*",
                    "Content-Length": str(file_size),
                },
                data=f,
                timeout=600,
            )

        if upload_resp.status_code not in (200, 201):
            raise RuntimeError(
                f"YouTube upload failed: {upload_resp.status_code} {upload_resp.text[:300]}"
            )

        video_data = upload_resp.json()
        video_id = video_data["id"]
        video_url = f"https://www.youtube.com/watch?v={video_id}"

        logger.info("Published to YouTube: %s", video_url)
        return video_id, video_url

    finally:
        if video_path and hasattr(post.video_file, "url"):
            try:
                os.unlink(video_path)
            except OSError:
                pass


# ─── itch.io ───


def publish_to_itchio(cross_publish, connection):
    """Push a project build to itch.io.

    Uses the itch.io API to create/update a game page.
    Returns (game_id, game_url).
    """
    project = cross_publish.project
    if not project:
        raise ValueError("Cross-publish must reference a project for itch.io.")

    api_key = connection.api_key
    if not api_key:
        raise ValueError("itch.io API key not configured.")

    # Use itch.io API to check if game exists or create it
    headers = {"Authorization": f"Bearer {api_key}"}

    # Get user's games
    resp = requests.get(
        "https://itch.io/api/1/key/my-games",
        headers=headers,
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"itch.io API failed: {resp.status_code}")

    data = resp.json()
    games = data.get("games", [])

    # Check if a game with same title already exists
    existing = next(
        (g for g in games if g.get("title", "").lower() == project.title.lower()),
        None,
    )

    if existing:
        game_id = str(existing["id"])
        game_url = existing.get("url", f"https://itch.io/game/{game_id}")
        logger.info("Found existing itch.io game: %s", game_url)
        return game_id, game_url

    # itch.io doesn't have a public create game API, so we log and return
    # a placeholder. Build pushing would use butler CLI in production.
    logger.warning(
        "itch.io game creation requires butler CLI or manual setup. "
        "Project '%s' needs to be created on itch.io first.",
        project.title,
    )
    raise RuntimeError(
        "itch.io game must be created manually first. "
        "Use butler CLI to push builds after creating the game page."
    )


# ─── Substack ───


def publish_to_substack(cross_publish, connection):
    """Publish a text post to Substack.

    Substack doesn't have an official public API, so this uses their
    internal API which may be fragile. Best-effort only.
    Returns (post_id, post_url).
    """
    post = cross_publish.post
    if not post:
        raise ValueError("Cross-publish must reference a post for Substack.")

    api_key = connection.api_key
    if not api_key:
        raise ValueError("Substack API key not configured.")

    title = post.title or f"Post #{post.pk}"
    body_html = post.body_html or f"<p>{post.body}</p>"

    # Substack doesn't have an official API. This is a placeholder
    # for when/if they provide one, or for a Substack-compatible service.
    logger.warning(
        "Substack publishing is not fully supported due to lack of official API. "
        "Post '%s' was not published to Substack.",
        title,
    )
    raise RuntimeError(
        "Substack does not provide an official API for post creation. "
        "This integration is best-effort and currently unavailable."
    )
