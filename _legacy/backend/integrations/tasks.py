"""
Celery tasks for cross-publishing content to external platforms.
"""

import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=2, default_retry_delay=120)
def cross_publish_to_platform(self, cross_publish_id):
    """Publish content to an external platform.

    Updates the CrossPublishResult with status, external ID, and URL.
    """
    from .models import CrossPublishResult, PlatformConnection
    from .publishers import publish_to_itchio, publish_to_substack, publish_to_youtube

    try:
        cross_publish = CrossPublishResult.objects.select_related(
            "user", "project", "post"
        ).get(id=cross_publish_id)
    except CrossPublishResult.DoesNotExist:
        logger.error("CrossPublishResult %s not found", cross_publish_id)
        return

    # Get platform connection
    try:
        connection = PlatformConnection.objects.get(
            user=cross_publish.user,
            platform=cross_publish.platform,
            is_active=True,
        )
    except PlatformConnection.DoesNotExist:
        cross_publish.status = CrossPublishResult.Status.FAILED
        cross_publish.error_message = (
            f"No active {cross_publish.platform} connection found."
        )
        cross_publish.save()
        return

    # Dispatch to platform-specific publisher
    publishers = {
        PlatformConnection.Platform.YOUTUBE: publish_to_youtube,
        PlatformConnection.Platform.ITCHIO: publish_to_itchio,
        PlatformConnection.Platform.SUBSTACK: publish_to_substack,
    }

    publisher = publishers.get(cross_publish.platform)
    if not publisher:
        cross_publish.status = CrossPublishResult.Status.FAILED
        cross_publish.error_message = (
            f"No publisher available for {cross_publish.platform}."
        )
        cross_publish.save()
        return

    try:
        external_id, external_url = publisher(cross_publish, connection)
        cross_publish.status = CrossPublishResult.Status.PUBLISHED
        cross_publish.external_id = external_id
        cross_publish.external_url = external_url
        cross_publish.published_at = timezone.now()
        cross_publish.error_message = ""
        cross_publish.save()

        logger.info(
            "Cross-published %s to %s: %s",
            cross_publish.project or cross_publish.post,
            cross_publish.platform,
            external_url,
        )
    except Exception as exc:
        logger.exception(
            "Cross-publish failed for %s to %s",
            cross_publish_id,
            cross_publish.platform,
        )
        cross_publish.status = CrossPublishResult.Status.FAILED
        cross_publish.error_message = str(exc)[:1000]
        cross_publish.save()

        # Retry on transient errors
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc)


@shared_task
def fetch_external_metrics():
    """Periodic task to fetch metrics from external platforms for cross-published content.

    Should be run on a schedule (e.g., every 6 hours) via Celery Beat.
    """
    from .models import CrossPublishResult, ExternalMetricSnapshot, PlatformConnection

    published = CrossPublishResult.objects.filter(
        status=CrossPublishResult.Status.PUBLISHED,
    ).select_related("user")

    today = timezone.now().date()

    for cross_pub in published:
        try:
            connection = PlatformConnection.objects.get(
                user=cross_pub.user,
                platform=cross_pub.platform,
                is_active=True,
            )
        except PlatformConnection.DoesNotExist:
            continue

        metrics = _fetch_metrics_for_platform(cross_pub, connection)
        if metrics:
            ExternalMetricSnapshot.objects.update_or_create(
                cross_publish=cross_pub,
                snapshot_date=today,
                defaults=metrics,
            )


def _fetch_metrics_for_platform(cross_publish, connection):
    """Fetch metrics from the appropriate platform API.

    Returns dict of metric fields or None on failure.
    """
    from .models import PlatformConnection

    if cross_publish.platform == PlatformConnection.Platform.YOUTUBE:
        return _fetch_youtube_metrics(cross_publish, connection)
    elif cross_publish.platform == PlatformConnection.Platform.ITCHIO:
        return _fetch_itchio_metrics(cross_publish, connection)

    return None


def _fetch_youtube_metrics(cross_publish, connection):
    """Fetch YouTube video metrics via the YouTube Data API."""
    import requests
    from . import youtube_oauth
    from datetime import timedelta

    if not cross_publish.external_id:
        return None

    access_token = connection.access_token

    # Refresh if expired
    if connection.token_expires_at and connection.token_expires_at < timezone.now():
        tokens = youtube_oauth.refresh_access_token(connection.refresh_token)
        if tokens:
            access_token = tokens["access_token"]
            connection.access_token = access_token
            expires_in = tokens.get("expires_in", 3600)
            connection.token_expires_at = timezone.now() + timedelta(seconds=expires_in)
            connection.save()
        else:
            logger.warning("Failed to refresh YouTube token for metrics fetch")
            return None

    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/videos",
            params={
                "part": "statistics",
                "id": cross_publish.external_id,
            },
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        items = resp.json().get("items", [])
        if not items:
            return None

        stats = items[0].get("statistics", {})
        return {
            "views": int(stats.get("viewCount", 0)),
            "likes": int(stats.get("likeCount", 0)),
            "comments": int(stats.get("commentCount", 0)),
        }
    except Exception:
        logger.exception("YouTube metrics fetch failed")
        return None


def _fetch_itchio_metrics(cross_publish, connection):
    """Fetch itch.io game metrics via the API."""
    import requests

    if not cross_publish.external_id:
        return None

    try:
        resp = requests.get(
            f"https://itch.io/api/1/key/game/{cross_publish.external_id}",
            headers={"Authorization": f"Bearer {connection.api_key}"},
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        game = resp.json().get("game", {})
        return {
            "views": game.get("views_count", 0),
            "likes": 0,
            "comments": 0,
        }
    except Exception:
        logger.exception("itch.io metrics fetch failed")
        return None
