import logging
from datetime import timedelta

from django.conf import settings as django_settings
from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncDate
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from content.models import Post, Project
from subscriptions.models import AttentionEvent

from . import youtube_oauth
from .models import CrossPublishResult, ExternalMetricSnapshot, PlatformConnection
from .serializers import (
    CrossPublishResultSerializer,
    PlatformConnectionCreateSerializer,
    PlatformConnectionSerializer,
)

logger = logging.getLogger(__name__)


def _parse_period(request, default=30, maximum=365):
    """Parse period query parameter into number of days."""
    try:
        days = int(request.query_params.get("period", default))
    except (ValueError, TypeError):
        days = default
    return min(max(days, 1), maximum)


# ─── Native Analytics (aggregated from AttentionEvent) ───


class AnalyticsOverviewView(APIView):
    """Aggregated analytics overview for the authenticated creator."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        days = _parse_period(request)
        since = timezone.now() - timedelta(days=days)

        events = AttentionEvent.objects.filter(
            creator=request.user,
            created_at__gte=since,
        )

        metrics = events.aggregate(
            total_events=Count("id"),
            total_views=Count(
                "id", filter=Q(event_type=AttentionEvent.EventType.PAGE_VIEW)
            ),
            total_plays=Count(
                "id", filter=Q(event_type=AttentionEvent.EventType.PLAY)
            ),
            total_watches=Count(
                "id", filter=Q(event_type=AttentionEvent.EventType.WATCH)
            ),
            total_reads=Count(
                "id", filter=Q(event_type=AttentionEvent.EventType.READ)
            ),
            total_listens=Count(
                "id", filter=Q(event_type=AttentionEvent.EventType.LISTEN)
            ),
            total_duration_seconds=Sum("duration_seconds"),
            unique_viewers=Count("user", distinct=True),
        )

        project_count = Project.objects.filter(
            creator=request.user, is_published=True
        ).count()
        post_count = Post.objects.filter(
            creator=request.user, is_published=True
        ).count()

        # Cross-publish summary
        cross_publishes = CrossPublishResult.objects.filter(
            user=request.user,
            status=CrossPublishResult.Status.PUBLISHED,
        ).count()

        # Platform connections
        connected_platforms = list(
            PlatformConnection.objects.filter(
                user=request.user, is_active=True
            ).values_list("platform", flat=True)
        )

        return Response(
            {
                "period_days": days,
                "metrics": {
                    "total_events": metrics["total_events"] or 0,
                    "total_views": metrics["total_views"] or 0,
                    "total_plays": metrics["total_plays"] or 0,
                    "total_watches": metrics["total_watches"] or 0,
                    "total_reads": metrics["total_reads"] or 0,
                    "total_listens": metrics["total_listens"] or 0,
                    "total_duration_seconds": metrics["total_duration_seconds"] or 0,
                    "total_duration_hours": round(
                        (metrics["total_duration_seconds"] or 0) / 3600, 1
                    ),
                    "unique_viewers": metrics["unique_viewers"] or 0,
                },
                "content": {
                    "published_projects": project_count,
                    "published_posts": post_count,
                },
                "cross_publishing": {
                    "total_published": cross_publishes,
                    "connected_platforms": connected_platforms,
                },
            }
        )


class ContentAnalyticsView(APIView):
    """Per-content analytics for the authenticated creator."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        days = _parse_period(request)
        content_type = request.query_params.get("type", "all")
        since = timezone.now() - timedelta(days=days)

        events = AttentionEvent.objects.filter(
            creator=request.user,
            created_at__gte=since,
        )

        results = []

        if content_type in ("all", "projects"):
            project_metrics = (
                events.filter(project__isnull=False)
                .values(
                    "project__id",
                    "project__title",
                    "project__slug",
                    "project__media_type",
                )
                .annotate(
                    views=Count("id"),
                    duration_seconds=Sum("duration_seconds"),
                    unique_viewers=Count("user", distinct=True),
                )
                .order_by("-views")
            )
            for pm in project_metrics:
                results.append(
                    {
                        "type": "project",
                        "id": pm["project__id"],
                        "title": pm["project__title"],
                        "slug": pm["project__slug"],
                        "media_type": pm["project__media_type"],
                        "views": pm["views"],
                        "duration_seconds": pm["duration_seconds"] or 0,
                        "duration_hours": round(
                            (pm["duration_seconds"] or 0) / 3600, 1
                        ),
                        "unique_viewers": pm["unique_viewers"],
                    }
                )

        if content_type in ("all", "posts"):
            post_metrics = (
                events.filter(post__isnull=False)
                .values(
                    "post__id",
                    "post__title",
                    "post__content_type",
                )
                .annotate(
                    views=Count("id"),
                    duration_seconds=Sum("duration_seconds"),
                    unique_viewers=Count("user", distinct=True),
                )
                .order_by("-views")
            )
            for pm in post_metrics:
                results.append(
                    {
                        "type": "post",
                        "id": pm["post__id"],
                        "title": pm["post__title"] or "Untitled",
                        "content_type": pm["post__content_type"],
                        "views": pm["views"],
                        "duration_seconds": pm["duration_seconds"] or 0,
                        "duration_hours": round(
                            (pm["duration_seconds"] or 0) / 3600, 1
                        ),
                        "unique_viewers": pm["unique_viewers"],
                    }
                )

        results.sort(key=lambda x: x["views"], reverse=True)

        return Response(
            {
                "period_days": days,
                "content": results,
            }
        )


class AnalyticsTimeseriesView(APIView):
    """Daily time-series analytics for the authenticated creator."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        days = _parse_period(request)
        since = timezone.now() - timedelta(days=days)

        events = AttentionEvent.objects.filter(
            creator=request.user,
            created_at__gte=since,
        )

        daily = (
            events.annotate(date=TruncDate("created_at"))
            .values("date")
            .annotate(
                views=Count(
                    "id", filter=Q(event_type=AttentionEvent.EventType.PAGE_VIEW)
                ),
                plays=Count(
                    "id", filter=Q(event_type=AttentionEvent.EventType.PLAY)
                ),
                watches=Count(
                    "id", filter=Q(event_type=AttentionEvent.EventType.WATCH)
                ),
                reads=Count(
                    "id", filter=Q(event_type=AttentionEvent.EventType.READ)
                ),
                listens=Count(
                    "id", filter=Q(event_type=AttentionEvent.EventType.LISTEN)
                ),
                total_events=Count("id"),
                duration_seconds=Sum("duration_seconds"),
                unique_viewers=Count("user", distinct=True),
            )
            .order_by("date")
        )

        return Response(
            {
                "period_days": days,
                "timeseries": [
                    {
                        "date": entry["date"].isoformat(),
                        "views": entry["views"],
                        "plays": entry["plays"],
                        "watches": entry["watches"],
                        "reads": entry["reads"],
                        "listens": entry["listens"],
                        "total_events": entry["total_events"],
                        "duration_seconds": entry["duration_seconds"] or 0,
                        "unique_viewers": entry["unique_viewers"],
                    }
                    for entry in daily
                ],
            }
        )


# ─── Cross-Platform Comparison ───


class CrossPlatformComparisonView(APIView):
    """Compare content performance across Bluebell and external platforms."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        days = _parse_period(request)
        since = timezone.now() - timedelta(days=days)

        # Native Bluebell metrics
        native_events = AttentionEvent.objects.filter(
            creator=request.user,
            created_at__gte=since,
        )
        native_metrics = native_events.aggregate(
            total_views=Count("id"),
            total_duration=Sum("duration_seconds"),
            unique_viewers=Count("user", distinct=True),
        )

        # External platform metrics (aggregated from snapshots)
        external_results = (
            CrossPublishResult.objects.filter(
                user=request.user,
                status=CrossPublishResult.Status.PUBLISHED,
            )
            .values("platform")
            .annotate(
                total_views=Sum(
                    "metric_snapshots__views",
                    filter=Q(metric_snapshots__snapshot_date__gte=since.date()),
                ),
                total_likes=Sum(
                    "metric_snapshots__likes",
                    filter=Q(metric_snapshots__snapshot_date__gte=since.date()),
                ),
                total_watch_time=Sum(
                    "metric_snapshots__watch_time_seconds",
                    filter=Q(metric_snapshots__snapshot_date__gte=since.date()),
                ),
                total_revenue_cents=Sum(
                    "metric_snapshots__revenue_cents",
                    filter=Q(metric_snapshots__snapshot_date__gte=since.date()),
                ),
                content_count=Count("id"),
            )
        )

        platforms = {}
        for result in external_results:
            total_views = result["total_views"] or 0
            total_revenue_cents = result["total_revenue_cents"] or 0
            platforms[result["platform"]] = {
                "views": total_views,
                "likes": result["total_likes"] or 0,
                "watch_time_seconds": result["total_watch_time"] or 0,
                "revenue_cents": total_revenue_cents,
                "content_count": result["content_count"],
                "revenue_per_view": (
                    round(total_revenue_cents / total_views / 100, 4)
                    if total_views > 0
                    else 0
                ),
            }

        bluebell_views = native_metrics["total_views"] or 0
        bluebell_duration = native_metrics["total_duration"] or 0

        return Response(
            {
                "period_days": days,
                "bluebell": {
                    "views": bluebell_views,
                    "duration_seconds": bluebell_duration,
                    "unique_viewers": native_metrics["unique_viewers"] or 0,
                },
                "platforms": platforms,
            }
        )


# ─── Platform Connections ───


class PlatformConnectionListView(generics.ListAPIView):
    """List the authenticated user's platform connections."""

    serializer_class = PlatformConnectionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return PlatformConnection.objects.filter(user=self.request.user)


class PlatformConnectionDetailView(generics.RetrieveDestroyAPIView):
    """Retrieve or disconnect a platform connection."""

    serializer_class = PlatformConnectionSerializer
    permission_classes = [permissions.IsAuthenticated]
    lookup_field = "platform"

    def get_queryset(self):
        return PlatformConnection.objects.filter(user=self.request.user)


# ─── Cross-Publish Results ───


class CrossPublishResultListView(generics.ListAPIView):
    """List cross-publish results for the authenticated user."""

    serializer_class = CrossPublishResultSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        qs = CrossPublishResult.objects.filter(
            user=self.request.user
        ).select_related("project", "post")

        platform = self.request.query_params.get("platform")
        if platform:
            qs = qs.filter(platform=platform)

        return qs.order_by("-created_at")


# ─── YouTube OAuth ───


class YouTubeAuthInitView(APIView):
    """Initiate YouTube/Google OAuth flow."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not youtube_oauth.is_configured():
            return Response(
                {"detail": "YouTube integration is not configured on this server."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        if PlatformConnection.objects.filter(
            user=request.user, platform=PlatformConnection.Platform.YOUTUBE
        ).exists():
            return Response(
                {"detail": "YouTube is already connected. Disconnect first."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        url, state = youtube_oauth.build_authorization_url(request)
        request.session["youtube_oauth_state"] = state
        return Response({"authorization_url": url})


class YouTubeCallbackView(APIView):
    """Handle YouTube/Google OAuth callback."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        error = request.query_params.get("error")
        if error:
            frontend_url = getattr(django_settings, "FRONTEND_URL", "http://localhost:3000")
            return HttpResponseRedirect(
                f"{frontend_url}/settings?youtube=error&detail={error}"
            )

        code = request.query_params.get("code")
        state = request.query_params.get("state")
        saved_state = request.session.pop("youtube_oauth_state", None)

        if not code or not state or state != saved_state:
            frontend_url = getattr(django_settings, "FRONTEND_URL", "http://localhost:3000")
            return HttpResponseRedirect(
                f"{frontend_url}/settings?youtube=error&detail=invalid_state"
            )

        tokens = youtube_oauth.exchange_code(request, code)
        if not tokens:
            frontend_url = getattr(django_settings, "FRONTEND_URL", "http://localhost:3000")
            return HttpResponseRedirect(
                f"{frontend_url}/settings?youtube=error&detail=token_exchange_failed"
            )

        access_token = tokens.get("access_token", "")
        refresh_token = tokens.get("refresh_token", "")
        expires_in = tokens.get("expires_in", 3600)

        channel_info = youtube_oauth.get_channel_info(access_token)
        channel_id = channel_info["channel_id"] if channel_info else ""
        channel_title = channel_info["title"] if channel_info else ""

        PlatformConnection.objects.update_or_create(
            user=request.user,
            platform=PlatformConnection.Platform.YOUTUBE,
            defaults={
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_expires_at": timezone.now() + timedelta(seconds=expires_in),
                "platform_user_id": channel_id,
                "platform_username": channel_title,
                "is_active": True,
            },
        )

        frontend_url = getattr(django_settings, "FRONTEND_URL", "http://localhost:3000")
        return HttpResponseRedirect(f"{frontend_url}/settings?youtube=connected")


# ─── API Key Connection (Steam, itch.io, Substack) ───


class APIKeyConnectView(APIView):
    """Connect a platform using an API key."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        platform = request.data.get("platform")
        api_key = request.data.get("api_key", "").strip()

        valid_platforms = [
            PlatformConnection.Platform.STEAM,
            PlatformConnection.Platform.ITCHIO,
            PlatformConnection.Platform.SUBSTACK,
        ]
        if platform not in valid_platforms:
            return Response(
                {"detail": f"Invalid platform. Use one of: {', '.join(valid_platforms)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not api_key:
            return Response(
                {"detail": "API key is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        conn, created = PlatformConnection.objects.update_or_create(
            user=request.user,
            platform=platform,
            defaults={
                "api_key": api_key,
                "is_active": True,
            },
        )

        return Response(
            PlatformConnectionSerializer(conn).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


# ─── Cross-Publish Initiation ───


class CrossPublishInitView(APIView):
    """Initiate cross-publishing of content to a connected platform."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        platform = request.data.get("platform")
        project_id = request.data.get("project_id")
        post_id = request.data.get("post_id")

        if not platform:
            return Response(
                {"detail": "platform is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not project_id and not post_id:
            return Response(
                {"detail": "project_id or post_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Verify platform connection exists
        if not PlatformConnection.objects.filter(
            user=request.user, platform=platform, is_active=True
        ).exists():
            return Response(
                {"detail": f"No active {platform} connection found."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Verify content ownership
        project = None
        post = None
        if project_id:
            try:
                project = Project.objects.get(id=project_id, creator=request.user)
            except Project.DoesNotExist:
                return Response(
                    {"detail": "Project not found or you don't own it."},
                    status=status.HTTP_404_NOT_FOUND,
                )
        if post_id:
            try:
                post = Post.objects.get(id=post_id, creator=request.user)
            except Post.DoesNotExist:
                return Response(
                    {"detail": "Post not found or you don't own it."},
                    status=status.HTTP_404_NOT_FOUND,
                )

        # Check for existing pending/published result
        existing = CrossPublishResult.objects.filter(
            user=request.user,
            platform=platform,
            project=project,
            post=post,
        ).exclude(status=CrossPublishResult.Status.FAILED).first()

        if existing:
            return Response(
                CrossPublishResultSerializer(existing).data,
                status=status.HTTP_200_OK,
            )

        # Create cross-publish result and dispatch task
        cross_publish = CrossPublishResult.objects.create(
            user=request.user,
            platform=platform,
            project=project,
            post=post,
            status=CrossPublishResult.Status.PENDING,
        )

        from .tasks import cross_publish_to_platform

        cross_publish_to_platform.delay(cross_publish.id)

        return Response(
            CrossPublishResultSerializer(cross_publish).data,
            status=status.HTTP_201_CREATED,
        )


class PlatformDisconnectView(APIView):
    """Disconnect a platform connection."""

    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request, platform):
        try:
            conn = PlatformConnection.objects.get(
                user=request.user, platform=platform
            )
        except PlatformConnection.DoesNotExist:
            return Response(
                {"detail": "Platform not connected."},
                status=status.HTTP_404_NOT_FOUND,
            )

        conn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
