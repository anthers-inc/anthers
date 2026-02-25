from datetime import timedelta

from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from content.models import Post, Project
from subscriptions.models import AttentionEvent

from .models import CrossPublishResult, ExternalMetricSnapshot, PlatformConnection
from .serializers import (
    CrossPublishResultSerializer,
    PlatformConnectionCreateSerializer,
    PlatformConnectionSerializer,
)


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


class PlatformConnectionListCreateView(generics.ListCreateAPIView):
    """List or create platform connections."""

    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return PlatformConnection.objects.filter(user=self.request.user)

    def get_serializer_class(self):
        if self.request.method == "POST":
            return PlatformConnectionCreateSerializer
        return PlatformConnectionSerializer

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


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
